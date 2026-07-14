// Reading Deadlock Mod Manager's state, packing its mods, and writing the result
// back as a new profile.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDir, writeVpk, TREE_OVERHEAD } from "./vpk.js";

const APP_ID = "dev.stormix.deadlock-mod-manager";
const PAKNUM = /^pak(\d+)_dir\.vpk$/i;

// ---------------------------------------------------------------------------
// DMM's state.json
//
// It is a tauri-plugin-store file. The key "local-config" holds a JSON *string*
// (not an object) containing {version, state} — so it gets parsed twice, and must
// be written back the same way or DMM will not read it.
// ---------------------------------------------------------------------------

function candidatePaths() {
  const home = os.homedir();
  const paths = [
    // Linux: flatpak first (the usual case), then a native install
    path.join(home, ".var", "app", APP_ID, "data", APP_ID, "state.json"),
    path.join(home, ".local", "share", APP_ID, "state.json"),
    path.join(home, ".config", APP_ID, "state.json"),
    // macOS
    path.join(home, "Library", "Application Support", APP_ID, "state.json"),
  ];
  // Windows: Tauri has used both of these depending on version
  for (const key of ["APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key]) paths.push(path.join(process.env[key], APP_ID, "state.json"));
  }
  return paths;
}

export function loadState() {
  const found = candidatePaths().find((p) => fs.existsSync(p));
  if (!found)
    throw new Error(
      "Could not find Deadlock Mod Manager's state.json. Looked in:\n  " +
        candidatePaths().join("\n  "),
    );
  const raw = JSON.parse(fs.readFileSync(found, "utf8"));
  const wasString = typeof raw["local-config"] === "string";
  const wrapper = wasString ? JSON.parse(raw["local-config"]) : raw["local-config"];
  return { path: found, raw, wrapper, wasString, state: wrapper.state };
}

function saveState(s) {
  s.raw["local-config"] = s.wasString ? JSON.stringify(s.wrapper) : s.wrapper;
  const tmp = s.path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s.raw));
  fs.renameSync(tmp, s.path);
}

// ---------------------------------------------------------------------------
// What to merge
// ---------------------------------------------------------------------------

// A mod counts if it is enabled in the profile AND in that profile's .dmm.json,
// and we take only the manifest's currentVpks — DMM's record of the files it
// actually deployed. That means a mod with several variants contributes only the
// one you selected, with no variant logic here at all.
export function analyze() {
  const s = loadState();
  const game = s.state.gamePath;
  if (!game || !fs.existsSync(game))
    throw new Error(`DMM has no valid game path set (${game}). Set it in DMM first.`);

  const pid = s.state.activeProfileId;
  const profile = (s.state.profiles || {})[pid];
  if (!profile) throw new Error("DMM has no active profile.");

  const addons = path.join(game, "game", "citadel", "addons");
  const sourceDir =
    profile.isDefault || !profile.folderName
      ? addons
      : path.join(addons, profile.folderName);

  const manifestPath = path.join(sourceDir, ".dmm.json");
  if (!fs.existsSync(manifestPath))
    throw new Error(`No .dmm.json in ${sourceDir}. Open this profile in DMM once.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const names = new Map((profile.mods || []).map((m) => [m.remoteId, m.name]));
  const enabled = Object.entries(profile.enabledMods || {})
    .filter(([, v]) => v.enabled)
    .map(([id]) => id);

  const sources = [];
  const seen = new Set();
  for (const rid of enabled.sort()) {
    const entry = (manifest.mods || {})[rid];
    if (!entry?.enabled) continue;
    for (const vpk of entry.currentVpks || []) {
      const m = PAKNUM.exec(vpk);
      const full = path.join(sourceDir, vpk);
      if (!m || seen.has(vpk) || !fs.existsSync(full)) continue;
      seen.add(vpk);
      sources.push({
        name: names.get(rid) || rid,
        vpk,
        path: full,
        pak: parseInt(m[1], 10),
        size: fs.statSync(full).size,
      });
    }
  }
  if (!sources.length)
    throw new Error(`No enabled, deployed mods in "${profile.name}".`);

  sources.sort((a, b) => a.pak - b.pak);
  return {
    stateHandle: s,
    addons,
    sourceDir,
    sourceName: profile.name,
    destName: profile.name + " +",
    sources,
    modCount: new Set(sources.map((x) => x.name)).size,
    totalBytes: sources.reduce((n, x) => n + x.size, 0),
  };
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

export function indexSources(sources) {
  const index = new Map();
  for (const src of sources) {
    const map = new Map();
    for (const e of readDir(src.path)) map.set(e.path, e.crc);
    index.set(src.pak, map);
  }
  return index;
}

function conflicts(a, b, index) {
  const A = index.get(a.pak);
  const B = index.get(b.pak);
  const [small, big] = A.size < B.size ? [A, B] : [B, A];
  for (const [p, crc] of small) {
    const other = big.get(p);
    if (other !== undefined && other !== crc) return true;
  }
  return false;
}

export function buildPacks(sources, index, maxBytes) {
  const packs = [];
  let current = [];
  let size = 0;
  for (const src of sources) {
    if (current.length === 0 && src.size > maxBytes) {
      packs.push([src]); // oversized loner gets a pack to itself
      continue;
    }
    const clash = current.some((other) => conflicts(src, other, index));
    if (current.length && (clash || size + src.size > maxBytes)) {
      packs.push(current);
      current = [];
      size = 0;
    }
    current.push(src);
    size += src.size;
  }
  if (current.length) packs.push(current);
  return packs;
}

// Members of a pack never conflict, so a repeated path is byte-identical and
// keeping the first copy is lossless.
function packEntries(members) {
  const seen = new Set();
  const out = [];
  for (const src of [...members].sort((a, b) => a.pak - b.pak)) {
    for (const entry of readDir(src.path)) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      out.push({ path: entry.path, entry, source: src.path });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Writing the new profile
// ---------------------------------------------------------------------------

function localMod(name, vpk, size, order, ts) {
  return {
    id: "mod_" + createHash("sha1").update(randomUUID()).digest("hex").slice(0, 26),
    remoteId: `local-${randomUUID()}`,
    name,
    description: "Merged by Deadlock Mod Merger.",
    remoteUrl: "",
    category: "Other/Misc",
    author: "Deadlock Mod Merger",
    likes: 0,
    downloadCount: 0,
    downloadable: false,
    tags: [],
    images: [],
    hero: null,
    audioUrl: null,
    isAudio: false,
    isMap: false,
    isNSFW: false,
    remoteAddedAt: ts,
    remoteUpdatedAt: ts,
    filesUpdatedAt: null,
    metadata: null,
    createdAt: ts,
    updatedAt: ts,
    status: "installed",
    downloadedAt: ts,
    installedVpks: [vpk],
    installOrder: order,
    downloads: [],
    selectedDownloads: [],
    detectedHero: null,
    usesCriticalPaths: false,
    installedFileTree: {
      files: [{ name: vpk, path: vpk, size, is_selected: true, archive_name: null }],
      total_files: 1,
      has_multiple_files: false,
    },
  };
}

// Each pack becomes its own DMM mod, so DMM can show and reorder them — and so
// pack N always mounts before pack N+1, which is what preserves every conflict
// the engine has to resolve.
export function commit(ctx, packs, onProgress) {
  const s = ctx.stateHandle;
  const newPid = `profile_${Date.now()}_${randomUUID().slice(0, 9)}`;
  const slug = ctx.destName.toLowerCase().replace(/[^a-z0-9]+/g, "") || "merged";
  const folder = `${newPid}_${slug}`;
  const dest = path.join(ctx.addons, folder);
  const names = packs.map((_, i) => `pak${String(i + 1).padStart(2, "0")}_dir.vpk`);

  fs.mkdirSync(dest, { recursive: true });

  const sizes = [];
  const badCrc = [];
  let written = 0;
  for (let i = 0; i < packs.length; i++) {
    const entries = packEntries(packs[i]);
    onProgress?.({
      phase: "writing",
      pack: i + 1,
      packs: packs.length,
      mods: packs[i].length,
      files: entries.length,
      written,
      total: ctx.totalBytes,
    });
    const res = writeVpk(path.join(dest, names[i]), entries, (n) => {
      written += n;
      onProgress?.({
        phase: "writing",
        pack: i + 1,
        packs: packs.length,
        written,
        total: ctx.totalBytes,
      });
    });
    sizes.push(res.size);
    badCrc.push(...res.badCrc);
  }

  const ts = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
  const mods = names.map((vpk, i) =>
    localMod(`${ctx.destName} — Pack ${String(i + 1).padStart(2, "0")}`, vpk, sizes[i], i, ts),
  );

  // DMM reads this to know which VPKs belong to which mod, and in what order.
  fs.writeFileSync(
    path.join(dest, ".dmm.json"),
    JSON.stringify(
      {
        version: 1,
        mods: Object.fromEntries(
          mods.map((m, i) => [
            m.remoteId,
            {
              enabled: true,
              order: i,
              currentVpks: [names[i]],
              disabledVpks: [],
              originalVpkNames: [names[i]],
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );

  // Add ONE profile and nothing else. state.localMods is deliberately untouched:
  // DMM copies it into whichever profile is *active* when you switch, so writing
  // there would leak the merged packs into the source profile. They live in the
  // new profile's own `mods` array, which is what DMM loads on switch.
  const backup = `${s.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(s.path, backup);

  s.state.profiles[newPid] = {
    id: newPid,
    name: ctx.destName,
    isDefault: false,
    folderName: folder,
    description: `Merged from ${ctx.sourceName}`,
    createdAt: ts,
    lastUsed: ts,
    enabledMods: Object.fromEntries(
      mods.map((m) => [m.remoteId, { remoteId: m.remoteId, enabled: true, lastModified: ts }]),
    ),
    mods,
  };
  saveState(s);

  return { dest, names, sizes, badCrc, backup };
}

export { TREE_OVERHEAD };
