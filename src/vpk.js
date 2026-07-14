// VPK v1/v2 reading, v2 writing.
//
// Only the directory is parsed up front; file data is read lazily by offset, so
// opening a 500 MiB archive is nearly free. Every VPK that Deadlock Mod Manager
// deploys is self-contained — all data inline, archive index 0x7FFF.

import { createHash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

const SIGNATURE = 0x55aa1234;
const INLINE = 0x7fff; // "data lives in this same file"
const TERMINATOR = 0xffff;

// Per-entry cost in the directory: 16-byte struct + 2-byte terminator + names.
// Rounded up. Only used to keep packs under the size cap.
export const TREE_OVERHEAD = 24;

export function readDir(path) {
  const buf = fs.readFileSync(path, { flag: "r" }).subarray(0, 12);
  const signature = buf.readUInt32LE(0);
  if (signature !== SIGNATURE) throw new Error(`${path}: not a VPK`);
  const version = buf.readUInt32LE(4);
  const treeLength = buf.readUInt32LE(8);
  if (version !== 1 && version !== 2)
    throw new Error(`${path}: unsupported VPK version ${version}`);

  const headerSize = version === 1 ? 12 : 28;
  const fd = fs.openSync(path, "r");
  const tree = Buffer.alloc(treeLength);
  fs.readSync(fd, tree, 0, treeLength, headerSize);
  fs.closeSync(fd);

  const dataBase = headerSize + treeLength;
  const entries = [];
  let pos = 0;

  const readString = () => {
    const end = tree.indexOf(0, pos);
    const s = tree.toString("utf8", pos, end);
    pos = end + 1;
    return s;
  };

  // extension -> folder -> filename, each level ending with an empty string.
  // " " is the sentinel for "no extension" / "root folder".
  for (let ext = readString(); ext !== ""; ext = readString()) {
    for (let folder = readString(); folder !== ""; folder = readString()) {
      for (let name = readString(); name !== ""; name = readString()) {
        const crc = tree.readUInt32LE(pos);
        const preloadLen = tree.readUInt16LE(pos + 4);
        const archiveIndex = tree.readUInt16LE(pos + 6);
        const offset = tree.readUInt32LE(pos + 8);
        const length = tree.readUInt32LE(pos + 12);
        const terminator = tree.readUInt16LE(pos + 16);
        pos += 18;
        const preload = tree.subarray(pos, pos + preloadLen);
        pos += preloadLen;
        if (terminator !== TERMINATOR)
          throw new Error(`${path}: corrupt directory near ${name}`);

        let full = folder === " " ? name : `${folder}/${name}`;
        if (ext !== " ") full += `.${ext}`;
        entries.push({
          path: full,
          crc,
          preload,
          archiveIndex,
          offset,
          length,
          dataBase,
          size: preloadLen + length,
        });
      }
    }
  }
  return entries;
}

function readEntry(fd, entry) {
  if (!entry.length) return Buffer.from(entry.preload);
  if (entry.archiveIndex !== INLINE)
    throw new Error(`${entry.path}: lives in an external archive; not supported`);
  const data = Buffer.alloc(entry.length);
  fs.readSync(fd, data, 0, entry.length, entry.dataBase + entry.offset);
  return entry.preload.length ? Buffer.concat([entry.preload, data]) : data;
}

function buildTree(layout) {
  const tree = new Map();
  for (const { path, entry, offset } of layout) {
    const slash = path.lastIndexOf("/");
    const folder = slash === -1 ? " " : path.slice(0, slash);
    const filename = slash === -1 ? path : path.slice(slash + 1);
    const dot = filename.lastIndexOf(".");
    const name = dot === -1 ? filename : filename.slice(0, dot);
    const ext = dot === -1 ? " " : filename.slice(dot + 1);

    if (!tree.has(ext)) tree.set(ext, new Map());
    const folders = tree.get(ext);
    if (!folders.has(folder)) folders.set(folder, new Map());
    folders.get(folder).set(name, { crc: entry.crc, offset, length: entry.size });
  }

  const parts = [];
  const push = (s) => parts.push(Buffer.from(s + "\0", "utf8"));
  for (const ext of [...tree.keys()].sort()) {
    push(ext);
    const folders = tree.get(ext);
    for (const folder of [...folders.keys()].sort()) {
      push(folder);
      const names = folders.get(folder);
      for (const name of [...names.keys()].sort()) {
        const { crc, offset, length } = names.get(name);
        push(name);
        const rec = Buffer.alloc(18);
        rec.writeUInt32LE(crc >>> 0, 0);
        rec.writeUInt16LE(0, 4); // preload length: everything goes inline
        rec.writeUInt16LE(INLINE, 6);
        rec.writeUInt32LE(offset, 8);
        rec.writeUInt32LE(length, 12);
        rec.writeUInt16LE(TERMINATOR, 16);
        parts.push(rec);
      }
      parts.push(Buffer.from([0])); // end of names
    }
    parts.push(Buffer.from([0])); // end of folders
  }
  parts.push(Buffer.from([0])); // end of extensions
  return Buffer.concat(parts);
}

// files: [{ path, entry, source }] — `source` is the VPK the entry came from.
// Each source is opened once. Every file's CRC is verified against the source
// directory as it is copied. Writes to a .part file and renames, so an
// interrupted run never leaves a half-written VPK behind.
export function writeVpk(outPath, files, onBytes) {
  const layout = [];
  let offset = 0;
  for (const f of files) {
    layout.push({ path: f.path, entry: f.entry, source: f.source, offset });
    offset += f.entry.size;
  }
  const dataSize = offset;

  // Directory offsets are 32-bit. Past this the archive is silently corrupt.
  if (dataSize >= 2 ** 32)
    throw new Error(`${outPath}: would exceed the 4 GiB VPK limit. Lower the cap.`);

  const tree = buildTree(layout);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(SIGNATURE, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(tree.length, 8);
  header.writeUInt32LE(dataSize, 12);
  header.writeUInt32LE(0, 16); // archive MD5 section: empty
  header.writeUInt32LE(48, 20); // other MD5 section: tree + archive + whole
  header.writeUInt32LE(0, 24); // signature section: none

  const whole = createHash("md5");
  const badCrc = [];
  const handles = new Map();
  const partial = outPath + ".part";
  const out = fs.openSync(partial, "w");

  try {
    fs.writeSync(out, header);
    whole.update(header);
    fs.writeSync(out, tree);
    whole.update(tree);

    for (const { path, entry, source } of layout) {
      let fd = handles.get(source);
      if (fd === undefined) {
        fd = fs.openSync(source, "r");
        handles.set(source, fd);
      }
      const chunk = readEntry(fd, entry);
      if ((zlib.crc32(chunk) >>> 0) !== (entry.crc >>> 0)) badCrc.push(path);
      fs.writeSync(out, chunk);
      whole.update(chunk);
      onBytes?.(chunk.length);
    }

    const treeMd5 = createHash("md5").update(tree).digest();
    const archiveMd5 = createHash("md5").update(Buffer.alloc(0)).digest();
    whole.update(treeMd5);
    whole.update(archiveMd5);
    fs.writeSync(out, Buffer.concat([treeMd5, archiveMd5, whole.digest()]));
  } finally {
    fs.closeSync(out);
    for (const fd of handles.values()) fs.closeSync(fd);
  }

  fs.renameSync(partial, outPath);
  return { size: fs.statSync(outPath).size, badCrc };
}
