// Reading Deadlock Mod Manager's state, packing its mods, and writing the result
// back as a new (or updated) profile.

use crate::state::{load_state, StateDoc};
use crate::vpk::{read_dir, write_vpk, FileRef};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, String>;

// The merger's own metadata, beside DMM's .dmm.json but in a separate file so
// DMM never has to parse an unknown key. This is what links a merged profile
// back to the profile it was merged from.
const MERGER_MANIFEST: &str = ".dmm-merger.json";

pub struct Source {
    pub name: String,
    pub vpk: String,
    pub path: PathBuf,
    pub pak: u64,
    pub size: u64,
}

pub struct Analysis {
    pub addons: PathBuf,
    pub source_dir: PathBuf,
    pub source_id: String,
    pub source_name: String,
    pub dest_name: String,
    pub sources: Vec<Source>,
    pub mod_count: usize,
    pub total_bytes: u64,
}

/// `pakNN_dir.vpk` (case-insensitive) -> NN
fn pak_number(name: &str) -> Option<u64> {
    let lower = name.to_lowercase();
    let digits = lower.strip_prefix("pak")?.strip_suffix("_dir.vpk")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn obj<'a>(v: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    v.get(key).and_then(|x| x.as_object())
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

// ---------------------------------------------------------------------------
// What to merge
// ---------------------------------------------------------------------------

// A mod counts if it is enabled in the profile AND in that profile's .dmm.json,
// and we take only the manifest's currentVpks — DMM's record of the files it
// actually deployed. That means a mod with several variants contributes only the
// one you selected, with no variant logic here at all.
pub fn analyze(s: &StateDoc, profile_id: Option<&str>) -> Result<Analysis> {
    let state = s.state();
    let game = str_of(state, "gamePath");
    if game.is_empty() || !Path::new(&game).exists() {
        return Err(format!("DMM has no valid game path set ({game}). Set it in DMM first."));
    }

    let pid = match profile_id {
        Some(p) => p.to_string(),
        None => str_of(state, "activeProfileId"),
    };
    let profile = obj(state, "profiles")
        .and_then(|p| p.get(&pid))
        .ok_or("DMM has no such profile.")?;

    let addons = Path::new(&game).join("game").join("citadel").join("addons");
    let is_default = profile.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false);
    let folder_name = str_of(profile, "folderName");
    let source_dir =
        if is_default || folder_name.is_empty() { addons.clone() } else { addons.join(&folder_name) };

    let manifest_path = source_dir.join(".dmm.json");
    if !manifest_path.exists() {
        return Err(format!(
            "No .dmm.json in {}. Open this profile in DMM once.",
            source_dir.display()
        ));
    }
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("{}: {e}", manifest_path.display()))?,
    )
    .map_err(|e| format!("{}: {e}", manifest_path.display()))?;

    let names: HashMap<String, String> = profile
        .get("mods")
        .and_then(|v| v.as_array())
        .map(|mods| {
            mods.iter().map(|m| (str_of(m, "remoteId"), str_of(m, "name"))).collect()
        })
        .unwrap_or_default();

    let mut enabled: Vec<String> = profile
        .get("enabledMods")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    enabled.sort();

    let manifest_mods = obj(&manifest, "mods");
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for rid in &enabled {
        let Some(entry) = manifest_mods.and_then(|m| m.get(rid)) else { continue };
        if !entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let vpks = entry.get("currentVpks").and_then(|v| v.as_array());
        for vpk in vpks.into_iter().flatten() {
            let Some(vpk) = vpk.as_str() else { continue };
            let Some(pak) = pak_number(vpk) else { continue };
            let full = source_dir.join(vpk);
            if seen.contains(vpk) || !full.exists() {
                continue;
            }
            seen.insert(vpk.to_string());
            let size = std::fs::metadata(&full).map_err(|e| format!("{}: {e}", full.display()))?.len();
            sources.push(Source {
                name: names.get(rid).cloned().unwrap_or_else(|| rid.clone()),
                vpk: vpk.to_string(),
                path: full,
                pak,
                size,
            });
        }
    }
    let profile_name = str_of(profile, "name");
    if sources.is_empty() {
        return Err(format!("No enabled, deployed mods in \"{profile_name}\"."));
    }

    sources.sort_by_key(|s| s.pak);
    let mod_count = sources.iter().map(|s| s.name.as_str()).collect::<HashSet<_>>().len();
    let total_bytes = sources.iter().map(|s| s.size).sum();
    Ok(Analysis {
        addons,
        source_dir,
        source_id: pid,
        source_name: profile_name.clone(),
        dest_name: format!("{profile_name} +"),
        sources,
        mod_count,
        total_bytes,
    })
}

// ---------------------------------------------------------------------------
// Packing
//
// THE ONE RULE: never decide a conflict ourselves.
//
// Two mods conflict when they ship the same internal path with different bytes.
// The engine resolves those at mount time by pak order — and we do not need to
// know its exact rule, so long as two conflicting mods never land in the same
// output VPK. So: walk the sources in ascending pak order and start a new pack
// whenever the next one conflicts with anything already in the current pack (or
// would bust the size cap). Packs are written pak01, pak02, ... in that same
// order, so every conflicting pair keeps its original relative position and the
// game reaches exactly the result it reaches today.
//
// Do not "optimise" this by deduplicating across mods and keeping one winner per
// path. There is no rule that works: Unstoppable (pak01) is built to beat later
// mods, while QOL Lock's announcer pack (pak10) is built to beat QOL Lock
// (pak02-09). Either direction silently deletes somebody's mod.
// ---------------------------------------------------------------------------

pub type SourceIndex = HashMap<u64, HashMap<String, u32>>;

pub fn index_sources(sources: &[Source]) -> Result<SourceIndex> {
    let mut index = HashMap::new();
    for src in sources {
        let map: HashMap<String, u32> =
            read_dir(&src.path)?.into_iter().map(|e| (e.path, e.crc)).collect();
        index.insert(src.pak, map);
    }
    Ok(index)
}

fn conflicts(a: &Source, b: &Source, index: &SourceIndex) -> bool {
    let (x, y) = (&index[&a.pak], &index[&b.pak]);
    let (small, big) = if x.len() < y.len() { (x, y) } else { (y, x) };
    small.iter().any(|(p, crc)| big.get(p).is_some_and(|other| other != crc))
}

// Placement is first-fit with an order constraint. Sources are walked in
// ascending pak order, so every already-placed mod has a lower pak than the
// incoming one — meaning every conflict the incoming mod has must resolve
// with it mounting LATER. It may therefore only join a pack strictly after
// the last pack that conflicts with it; within that legal range, the first
// pack with room wins. Unlike sealing packs at the first clash, a conflict
// no longer ends a pack forever — later mods flow back into earlier packs.
pub fn build_packs<'a>(
    sources: &'a [Source],
    index: &SourceIndex,
    max_bytes: u64,
) -> Vec<Vec<&'a Source>> {
    let mut packs: Vec<Vec<&Source>> = Vec::new();
    let mut sizes: Vec<u64> = Vec::new();
    for src in sources {
        let earliest = packs
            .iter()
            .rposition(|pack| pack.iter().any(|other| conflicts(src, other, index)))
            .map_or(0, |i| i + 1);
        match (earliest..packs.len()).find(|&i| sizes[i] + src.size <= max_bytes) {
            Some(i) => {
                packs[i].push(src);
                sizes[i] += src.size;
            }
            None => {
                // No pack has room (or none is legal): open a new one. An
                // oversized loner exceeds the cap alone; nothing else will
                // ever fit with it, so it stays a pack of one.
                packs.push(vec![src]);
                sizes.push(src.size);
            }
        }
    }
    packs
}

/// The invariant the packing must preserve, checked directly: every pair of
/// conflicting mods lands with the lower pak in a strictly earlier pack, so
/// the engine still resolves every conflict in its original orientation.
/// Runs before anything is written; cheap insurance against packing bugs.
pub fn verify_pack_order(packs: &[Vec<&Source>], index: &SourceIndex) -> Result<()> {
    let placed: Vec<(usize, &Source)> = packs
        .iter()
        .enumerate()
        .flat_map(|(i, p)| p.iter().map(move |s| (i, *s)))
        .collect();
    for (x, &(pack_a, a)) in placed.iter().enumerate() {
        for &(pack_b, b) in &placed[x + 1..] {
            if !conflicts(a, b, index) {
                continue;
            }
            let ((lo_pack, lo), (hi_pack, hi)) =
                if a.pak < b.pak { ((pack_a, a), (pack_b, b)) } else { ((pack_b, b), (pack_a, a)) };
            if lo_pack >= hi_pack {
                return Err(format!(
                    "packing bug: conflicting mods out of order — \"{}\" (pak{:02}, pack {}) must mount before \"{}\" (pak{:02}, pack {}). Nothing was written.",
                    lo.name, lo.pak, lo_pack + 1, hi.name, hi.pak, hi_pack + 1,
                ));
            }
        }
    }
    Ok(())
}

// Members of a pack never conflict, so a repeated path is byte-identical and
// keeping the first copy is lossless.
fn pack_entries(members: &[&Source]) -> Result<Vec<FileRef>> {
    let mut sorted: Vec<&&Source> = members.iter().collect();
    sorted.sort_by_key(|s| s.pak);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<FileRef> = Vec::new();
    for src in sorted {
        for entry in read_dir(&src.path)? {
            if seen.contains(&entry.path) {
                continue;
            }
            seen.insert(entry.path.clone());
            out.push(FileRef { path: entry.path.clone(), entry, source: src.path.clone() });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Writing the new profile
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
}

fn local_mod(name: &str, description: &str, vpk: &str, size: u64, order: usize, ts: &str) -> Value {
    let id = {
        let uuid = uuid::Uuid::new_v4().to_string();
        let hex = Sha1::digest(uuid.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        format!("mod_{}", &hex[..26])
    };
    json!({
        "id": id,
        "remoteId": format!("local-{}", uuid::Uuid::new_v4()),
        "name": name,
        "description": description,
        "remoteUrl": "",
        "category": "Other/Misc",
        "author": "Deadlock Mod Merger",
        "likes": 0,
        "downloadCount": 0,
        "downloadable": false,
        "tags": [],
        "images": [],
        "hero": null,
        "audioUrl": null,
        "isAudio": false,
        "isMap": false,
        "isNSFW": false,
        "remoteAddedAt": ts,
        "remoteUpdatedAt": ts,
        "filesUpdatedAt": null,
        "metadata": null,
        "createdAt": ts,
        "updatedAt": ts,
        "status": "installed",
        "downloadedAt": ts,
        "installedVpks": [vpk],
        "installOrder": order,
        "downloads": [],
        "selectedDownloads": [],
        "detectedHero": null,
        "usesCriticalPaths": false,
        "installedFileTree": {
            "files": [{ "name": vpk, "path": vpk, "size": size, "is_selected": true, "archive_name": null }],
            "total_files": 1,
            "has_multiple_files": false
        }
    })
}

/// Where commit() writes: a brand-new profile, or an existing merged one.
pub enum Target {
    New,
    Existing { profile_id: String },
}

pub struct CommitResult {
    pub dest: PathBuf,
    pub dest_name: String,
    pub names: Vec<String>,
    pub sizes: Vec<u64>,
    pub bad_crc: Vec<String>,
    pub backup: PathBuf,
}

// Each pack becomes its own DMM mod, so DMM can show and reorder them — and so
// pack N always mounts before pack N+1, which is what preserves every conflict
// the engine has to resolve.
pub fn commit(
    s: &mut StateDoc,
    ctx: &Analysis,
    packs: &[Vec<&Source>],
    target: Target,
    mut on_progress: impl FnMut(Value),
) -> Result<CommitResult> {
    let index = index_sources(&ctx.sources)?;
    verify_pack_order(packs, &index)?;
    let ts = now_iso();

    // Resolve the destination profile id, folder and name.
    let (pid, folder, dest_name, created_at) = match &target {
        Target::New => {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis();
            let pid = format!("profile_{millis}_{}", &uuid::Uuid::new_v4().to_string()[..9]);
            let slug: String = ctx
                .dest_name
                .to_lowercase()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let slug = if slug.is_empty() { "merged".to_string() } else { slug };
            let folder = format!("{pid}_{slug}");
            (pid, folder, ctx.dest_name.clone(), ts.clone())
        }
        Target::Existing { profile_id } => {
            let profile = obj(s.state(), "profiles")
                .and_then(|p| p.get(profile_id))
                .ok_or("The merged profile no longer exists.")?;
            let folder = str_of(profile, "folderName");
            if folder.is_empty() {
                return Err("The merged profile has no folder to update.".into());
            }
            let created = str_of(profile, "createdAt");
            let created = if created.is_empty() { ts.clone() } else { created };
            (profile_id.clone(), folder, str_of(profile, "name"), created)
        }
    };

    let dest = ctx.addons.join(&folder);
    let names: Vec<String> =
        (1..=packs.len()).map(|i| format!("pak{i:02}_dir.vpk")).collect();

    std::fs::create_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;

    let mut sizes = Vec::new();
    let mut bad_crc = Vec::new();
    let mut written = 0u64;
    for (i, pack) in packs.iter().enumerate() {
        let entries = pack_entries(pack)?;
        on_progress(json!({
            "phase": "writing",
            "pack": i + 1,
            "packs": packs.len(),
            "mods": pack.len(),
            "files": entries.len(),
            "written": written,
            "total": ctx.total_bytes,
        }));
        let res = write_vpk(&dest.join(&names[i]), &entries, |n| {
            written += n;
            on_progress(json!({
                "phase": "writing",
                "pack": i + 1,
                "packs": packs.len(),
                "written": written,
                "total": ctx.total_bytes,
            }));
        })?;
        sizes.push(res.size);
        bad_crc.extend(res.bad_crc);
    }

    // On update, clear out packs from a previous run that we did not overwrite.
    if matches!(target, Target::Existing { .. }) {
        if let Ok(dir) = std::fs::read_dir(&dest) {
            for f in dir.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if let Some(n) = pak_number(&name) {
                    if n as usize > packs.len() {
                        let _ = std::fs::remove_file(f.path());
                    }
                }
            }
        }
    }

    // Each pack's description lists the mods inside it, in pak order.
    let mods: Vec<Value> = names
        .iter()
        .enumerate()
        .map(|(i, vpk)| {
            let mut seen = HashSet::new();
            let contents: Vec<&str> = packs[i]
                .iter()
                .filter(|s| seen.insert(s.name.as_str()))
                .map(|s| s.name.as_str())
                .collect();
            local_mod(
                &format!("{dest_name} — Pack {:02}", i + 1),
                &contents.join(", "),
                vpk,
                sizes[i],
                i,
                &ts,
            )
        })
        .collect();

    // DMM reads this to know which VPKs belong to which mod, and in what order.
    let manifest = json!({
        "version": 1,
        "mods": Map::from_iter(mods.iter().enumerate().map(|(i, m)| {
            (
                str_of(m, "remoteId"),
                json!({
                    "enabled": true,
                    "order": i,
                    "currentVpks": [names[i]],
                    "disabledVpks": [],
                    "originalVpkNames": [names[i]],
                }),
            )
        })),
    });
    std::fs::write(
        dest.join(".dmm.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("{}: {e}", dest.display()))?;

    // Our own link back to the source profile, so "update" knows what to re-merge.
    let merger_manifest = json!({
        "version": 1,
        "sourceProfileId": ctx.source_id,
        "sourceName": ctx.source_name,
        "mergedAt": ts,
    });
    std::fs::write(
        dest.join(MERGER_MANIFEST),
        serde_json::to_string_pretty(&merger_manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("{}: {e}", dest.display()))?;

    // Add/replace ONE profile and nothing else. state.localMods is deliberately
    // untouched: DMM copies it into whichever profile is *active* when you
    // switch, so writing there would leak the merged packs into the source
    // profile. They live in the new profile's own `mods` array, which is what
    // DMM loads on switch.
    let backup = s.backup()?;

    let enabled_mods = Map::from_iter(mods.iter().map(|m| {
        let rid = str_of(m, "remoteId");
        (rid.clone(), json!({ "remoteId": rid, "enabled": true, "lastModified": ts }))
    }));
    let profile_entry = json!({
        "id": pid,
        "name": dest_name,
        "isDefault": false,
        "folderName": folder,
        "description": format!("Merged from {}", ctx.source_name),
        "createdAt": created_at,
        "lastUsed": ts,
        "enabledMods": enabled_mods,
        "mods": mods,
    });
    s.state_mut()["profiles"][&pid] = profile_entry;
    s.save()?;

    Ok(CommitResult { dest, dest_name, names, sizes, bad_crc, backup })
}

// ---------------------------------------------------------------------------
// Profile listing (for the UI) and merged-profile source resolution
// ---------------------------------------------------------------------------

/// If `profile` is a merged profile, return the id of the profile it was merged
/// from. Prefers the merger manifest; falls back to matching "<source> +" by
/// name for profiles merged before the manifest existed.
pub fn merged_source(s: &StateDoc, profile_id: &str) -> Option<String> {
    let state = s.state();
    let profiles = obj(state, "profiles")?;
    let profile = profiles.get(profile_id)?;

    let game = str_of(state, "gamePath");
    let folder = str_of(profile, "folderName");
    if !game.is_empty() && !folder.is_empty() {
        let manifest = Path::new(&game)
            .join("game")
            .join("citadel")
            .join("addons")
            .join(&folder)
            .join(MERGER_MANIFEST);
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                let sid = str_of(&v, "sourceProfileId");
                if profiles.contains_key(&sid) {
                    return Some(sid);
                }
            }
        }
    }

    // Legacy fallback: "Default Profile +" was merged from "Default Profile".
    let name = str_of(profile, "name");
    let source_name = name.strip_suffix(" +")?;
    profiles
        .iter()
        .find(|(id, p)| *id != profile_id && str_of(p, "name") == source_name)
        .map(|(id, _)| id.clone())
}

/// The reverse of merged_source: the merged profile that was produced from
/// `source_id`, if one exists. Merging that source again overwrites it rather
/// than piling up "Name +", "Name + +", ...
pub fn merged_dest(s: &StateDoc, source_id: &str) -> Option<String> {
    let profiles = obj(s.state(), "profiles")?;
    profiles
        .keys()
        .filter(|id| id.as_str() != source_id)
        .find(|id| merged_source(s, id).as_deref() == Some(source_id))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(pak: u64, size: u64) -> Source {
        Source {
            name: format!("m{pak}"),
            vpk: format!("pak{pak:02}_dir.vpk"),
            path: PathBuf::from(format!("/x/pak{pak:02}")),
            pak,
            size,
        }
    }

    fn index_of(entries: &[(u64, &[(&str, u32)])]) -> SourceIndex {
        entries
            .iter()
            .map(|(pak, files)| {
                (*pak, files.iter().map(|(p, crc)| (p.to_string(), *crc)).collect())
            })
            .collect()
    }

    /// A conflict starts a new pack but does not seal the old one: mods after
    /// the conflict flow back into the earliest legal pack.
    #[test]
    fn backfills_after_conflict() {
        let sources = vec![src(1, 10), src(2, 10), src(3, 10)];
        // pak1 and pak2 conflict on "x"; pak3 conflicts with nothing.
        let index = index_of(&[
            (1, &[("x", 111)]),
            (2, &[("x", 222)]),
            (3, &[("y", 333)]),
        ]);
        let packs = build_packs(&sources, &index, 1000);
        assert_eq!(packs.len(), 2);
        let paks: Vec<Vec<u64>> =
            packs.iter().map(|p| p.iter().map(|s| s.pak).collect()).collect();
        assert_eq!(paks, vec![vec![1, 3], vec![2]]); // 3 rejoined pack 1
        verify_pack_order(&packs, &index).unwrap();
    }

    /// The transitive trap: pak3 conflicts with pak2 but not pak1, so it may
    /// NOT go back into pack 1 — that would mount it before pak2.
    #[test]
    fn no_backfill_past_a_conflict() {
        let sources = vec![src(1, 10), src(2, 10), src(3, 10)];
        let index = index_of(&[
            (1, &[("a", 1)]),
            (2, &[("a", 2), ("b", 1)]),
            (3, &[("b", 2)]),
        ]);
        let packs = build_packs(&sources, &index, 1000);
        let paks: Vec<Vec<u64>> =
            packs.iter().map(|p| p.iter().map(|s| s.pak).collect()).collect();
        assert_eq!(paks, vec![vec![1], vec![2], vec![3]]);
        verify_pack_order(&packs, &index).unwrap();
    }

    /// Identical bytes are not a conflict; the size cap still splits.
    #[test]
    fn size_cap_and_identical_files() {
        let sources = vec![src(1, 60), src(2, 60), src(3, 30)];
        let index = index_of(&[
            (1, &[("a", 7)]),
            (2, &[("a", 7)]), // same crc: not a conflict
            (3, &[("c", 3)]),
        ]);
        let packs = build_packs(&sources, &index, 100);
        let paks: Vec<Vec<u64>> =
            packs.iter().map(|p| p.iter().map(|s| s.pak).collect()).collect();
        assert_eq!(paks, vec![vec![1, 3], vec![2]]); // split by size, 3 backfills
        verify_pack_order(&packs, &index).unwrap();
    }

    /// The checker rejects a conflicting pair in the wrong pack order…
    #[test]
    fn verify_rejects_inverted_order() {
        let a = src(1, 10);
        let b = src(2, 10);
        let index = index_of(&[(1, &[("x", 1)]), (2, &[("x", 2)])]);
        let packs: Vec<Vec<&Source>> = vec![vec![&b], vec![&a]];
        assert!(verify_pack_order(&packs, &index).is_err());
    }

    /// …and a conflicting pair sharing one pack.
    #[test]
    fn verify_rejects_conflict_in_same_pack() {
        let a = src(1, 10);
        let b = src(2, 10);
        let index = index_of(&[(1, &[("x", 1)]), (2, &[("x", 2)])]);
        let packs: Vec<Vec<&Source>> = vec![vec![&a, &b]];
        assert!(verify_pack_order(&packs, &index).is_err());
    }
}

pub fn list_profiles() -> Result<Value> {
    let s = load_state()?;
    let state = s.state();
    let active = str_of(state, "activeProfileId");
    let profiles = obj(state, "profiles").ok_or("DMM has no profiles.")?;

    let list: Vec<Value> = profiles
        .iter()
        .map(|(id, p)| {
            let enabled = p
                .get("enabledMods")
                .and_then(|v| v.as_object())
                .map(|m| {
                    m.values()
                        .filter(|v| v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false))
                        .count()
                })
                .unwrap_or(0);
            json!({
                "id": id,
                "name": str_of(p, "name"),
                "isDefault": p.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false),
                "isActive": *id == active,
                "enabledMods": enabled,
                "mergedFrom": merged_source(&s, id),
            })
        })
        .collect();
    Ok(json!({ "activeProfileId": active, "profiles": list }))
}
