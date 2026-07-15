// VPK v1/v2 reading, v2 writing. Only the directory is parsed up front; file
// data is read lazily by offset. Every VPK that DMM deploys is self-contained:
// all data inline, archive index 0x7FFF.

use md5::{Digest, Md5};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const SIGNATURE: u32 = 0x55aa_1234;
const INLINE: u16 = 0x7fff;
const TERMINATOR: u16 = 0xffff;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct Entry {
    pub path: String,
    pub crc: u32,
    pub preload: Vec<u8>,
    pub archive_index: u16,
    pub offset: u32,
    pub length: u32,
    pub data_base: u64,
    pub size: u64, // preload + length
}

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

pub fn read_dir(path: &Path) -> Result<Vec<Entry>> {
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut file = File::open(path).map_err(err)?;
    let mut head = [0u8; 12];
    file.read_exact(&mut head).map_err(err)?;
    if u32le(&head, 0) != SIGNATURE {
        return Err(format!("{}: not a VPK", path.display()));
    }
    let version = u32le(&head, 4);
    let tree_length = u32le(&head, 8) as usize;
    if version != 1 && version != 2 {
        return Err(format!("{}: unsupported VPK version {version}", path.display()));
    }

    let header_size: u64 = if version == 1 { 12 } else { 28 };
    file.seek(SeekFrom::Start(header_size)).map_err(err)?;
    let mut tree = vec![0u8; tree_length];
    file.read_exact(&mut tree).map_err(err)?;

    let data_base = header_size + tree_length as u64;
    let mut entries = Vec::new();
    let mut pos = 0usize;

    let read_string = |pos: &mut usize| -> Result<String> {
        let end = tree[*pos..]
            .iter()
            .position(|&b| b == 0)
            .map(|i| *pos + i)
            .ok_or_else(|| format!("{}: unterminated string in directory", path.display()))?;
        let s = String::from_utf8_lossy(&tree[*pos..end]).into_owned();
        *pos = end + 1;
        Ok(s)
    };

    // extension -> folder -> filename, each level ending with an empty string;
    // " " is the sentinel for "no extension" / "root folder".
    loop {
        let ext = read_string(&mut pos)?;
        if ext.is_empty() {
            break;
        }
        loop {
            let folder = read_string(&mut pos)?;
            if folder.is_empty() {
                break;
            }
            loop {
                let name = read_string(&mut pos)?;
                if name.is_empty() {
                    break;
                }
                let crc = u32le(&tree, pos);
                let preload_len = u16le(&tree, pos + 4) as usize;
                let archive_index = u16le(&tree, pos + 6);
                let offset = u32le(&tree, pos + 8);
                let length = u32le(&tree, pos + 12);
                let terminator = u16le(&tree, pos + 16);
                pos += 18;
                let preload = tree[pos..pos + preload_len].to_vec();
                pos += preload_len;
                if terminator != TERMINATOR {
                    return Err(format!("{}: corrupt directory near {name}", path.display()));
                }

                let mut full = if folder == " " {
                    name.clone()
                } else {
                    format!("{folder}/{name}")
                };
                if ext != " " {
                    full = format!("{full}.{ext}");
                }
                entries.push(Entry {
                    path: full,
                    crc,
                    size: (preload_len as u64) + (length as u64),
                    preload,
                    archive_index,
                    offset,
                    length,
                    data_base,
                });
            }
        }
    }
    Ok(entries)
}

fn read_entry(file: &mut File, entry: &Entry, buf: &mut Vec<u8>) -> Result<()> {
    buf.clear();
    buf.extend_from_slice(&entry.preload);
    if entry.length == 0 {
        return Ok(());
    }
    if entry.archive_index != INLINE {
        return Err(format!("{}: lives in an external archive; not supported", entry.path));
    }
    let start = buf.len();
    buf.resize(start + entry.length as usize, 0);
    file.seek(SeekFrom::Start(entry.data_base + entry.offset as u64))
        .map_err(|e| format!("{}: {e}", entry.path))?;
    file.read_exact(&mut buf[start..]).map_err(|e| format!("{}: {e}", entry.path))?;
    Ok(())
}

pub struct FileRef {
    pub path: String,
    pub entry: Entry,
    pub source: PathBuf,
}

struct Slot {
    crc: u32,
    offset: u64,
    length: u64,
}

fn build_tree(layout: &[(u64, &FileRef)]) -> Vec<u8> {
    // ext -> folder -> name; BTreeMap gives the sorted order the format expects.
    let mut tree: BTreeMap<String, BTreeMap<String, BTreeMap<String, Slot>>> = BTreeMap::new();
    for (offset, f) in layout {
        let (folder, filename) = match f.path.rfind('/') {
            Some(i) => (&f.path[..i], &f.path[i + 1..]),
            None => (" ", f.path.as_str()),
        };
        let (name, ext) = match filename.rfind('.') {
            Some(i) => (&filename[..i], &filename[i + 1..]),
            None => (filename, " "),
        };
        tree.entry(ext.to_string())
            .or_default()
            .entry(folder.to_string())
            .or_default()
            .insert(
                name.to_string(),
                Slot { crc: f.entry.crc, offset: *offset, length: f.entry.size },
            );
    }

    let mut out = Vec::new();
    let push = |s: &str, out: &mut Vec<u8>| {
        out.extend_from_slice(s.as_bytes());
        out.push(0);
    };
    for (ext, folders) in &tree {
        push(ext, &mut out);
        for (folder, names) in folders {
            push(folder, &mut out);
            for (name, slot) in names {
                push(name, &mut out);
                out.extend_from_slice(&slot.crc.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes()); // everything goes inline
                out.extend_from_slice(&INLINE.to_le_bytes());
                out.extend_from_slice(&(slot.offset as u32).to_le_bytes());
                out.extend_from_slice(&(slot.length as u32).to_le_bytes());
                out.extend_from_slice(&TERMINATOR.to_le_bytes());
            }
            out.push(0);
        }
        out.push(0);
    }
    out.push(0);
    out
}

pub struct WriteResult {
    pub size: u64,
    pub bad_crc: Vec<String>,
}

// Every file's CRC is verified against the source directory as it is copied.
// Writes to a .part file and renames, so an interrupted run never leaves a
// half-written VPK behind.
pub fn write_vpk(
    out_path: &Path,
    files: &[FileRef],
    mut on_bytes: impl FnMut(u64),
) -> Result<WriteResult> {
    let mut layout = Vec::with_capacity(files.len());
    let mut offset = 0u64;
    for f in files {
        layout.push((offset, f));
        offset += f.entry.size;
    }
    let data_size = offset;

    // Directory offsets are 32-bit; past this the archive is silently corrupt.
    if data_size >= 1 << 32 {
        return Err(format!(
            "{}: would exceed the 4 GiB VPK limit. Lower the cap.",
            out_path.display()
        ));
    }

    let tree = build_tree(&layout);
    let mut header = Vec::with_capacity(28);
    header.extend_from_slice(&SIGNATURE.to_le_bytes());
    header.extend_from_slice(&2u32.to_le_bytes());
    header.extend_from_slice(&(tree.len() as u32).to_le_bytes());
    header.extend_from_slice(&(data_size as u32).to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes()); // archive MD5 section: empty
    header.extend_from_slice(&48u32.to_le_bytes()); // other MD5 section: tree + archive + whole
    header.extend_from_slice(&0u32.to_le_bytes()); // signature section: none

    let mut whole = Md5::new();
    let mut bad_crc = Vec::new();
    let mut handles: HashMap<&Path, File> = HashMap::new();
    let mut buf = Vec::new();
    let partial = out_path.with_extension("vpk.part");
    let werr = |e: std::io::Error| format!("{}: {e}", partial.display());

    let result = (|| -> Result<()> {
        let mut out = BufWriter::new(File::create(&partial).map_err(werr)?);
        let write_all = |out: &mut BufWriter<File>, whole: &mut Md5, bytes: &[u8]| {
            whole.update(bytes);
            out.write_all(bytes).map_err(werr)
        };

        write_all(&mut out, &mut whole, &header)?;
        write_all(&mut out, &mut whole, &tree)?;

        for (_, f) in &layout {
            let source: &Path = &f.source;
            if !handles.contains_key(source) {
                let h = File::open(source).map_err(|e| format!("{}: {e}", source.display()))?;
                handles.insert(source, h);
            }
            read_entry(handles.get_mut(source).unwrap(), &f.entry, &mut buf)?;
            if crc32fast::hash(&buf) != f.entry.crc {
                bad_crc.push(f.path.clone());
            }
            write_all(&mut out, &mut whole, &buf)?;
            on_bytes(buf.len() as u64);
        }

        let tree_md5 = Md5::digest(&tree);
        let archive_md5 = Md5::digest([]);
        whole.update(tree_md5);
        whole.update(archive_md5);
        out.write_all(&tree_md5).map_err(werr)?;
        out.write_all(&archive_md5).map_err(werr)?;
        out.write_all(&whole.finalize()).map_err(werr)?;
        out.flush().map_err(werr)
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }

    std::fs::rename(&partial, out_path).map_err(|e| format!("{}: {e}", out_path.display()))?;
    let size = std::fs::metadata(out_path)
        .map_err(|e| format!("{}: {e}", out_path.display()))?
        .len();
    Ok(WriteResult { size, bad_crc })
}
