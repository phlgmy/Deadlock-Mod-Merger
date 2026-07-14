// Golden-diff parity harness: proves the Rust port produces the same output as
// the original JS implementation (git tag `js-final`), which acts as the oracle.
//
//   node scripts/parity.mjs [profile-id] [cap-mb]
//
// Both implementations run against a sandbox: a fake $HOME containing a copy of
// the real DMM state.json whose gamePath points at a fake game tree whose addons
// are symlinks to the real ones. Reads hit real mod VPKs; writes stay in the
// sandbox. Nothing outside ~/.cache/dmm-parity is touched.
//
// Gate:
//   - plan JSON identical (pack boundaries, sizes, counts)
//   - every written pakNN_dir.vpk byte-identical (sha256)
//   - .dmm.json identical after normalizing random ids
//   - state.json identical after normalizing random ids and timestamps
//     (including everything *outside* the added profile)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(os.homedir(), ".cache", "dmm-parity");
const ORACLE_TAG = "js-final";

const profileId = process.argv[2] || "default";
const capMb = Number(process.argv[3]) || 500;

const APP_ID = "dev.stormix.deadlock-mod-manager";

function findRealState() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".var", "app", APP_ID, "data", APP_ID, "state.json"),
    path.join(home, ".local", "share", APP_ID, "state.json"),
    path.join(home, ".config", APP_ID, "state.json"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no real DMM state.json found");
  return found;
}

// One sandbox per implementation: fake home + fake game dir.
function makeSandbox(name, realStatePath) {
  const base = path.join(WORK, name);
  fs.rmSync(base, { recursive: true, force: true });
  const home = path.join(base, "home");
  const addons = path.join(base, "game", "game", "citadel", "addons");
  fs.mkdirSync(addons, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(realStatePath, "utf8"));
  const wasString = typeof raw["local-config"] === "string";
  const wrapper = wasString ? JSON.parse(raw["local-config"]) : raw["local-config"];
  const realAddons = path.join(wrapper.state.gamePath, "game", "citadel", "addons");
  wrapper.state.gamePath = path.join(base, "game");
  wrapper.state.activeProfileId = profileId;
  raw["local-config"] = wasString ? JSON.stringify(wrapper) : wrapper;

  const stateDir = path.join(home, ".local", "share", APP_ID);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(raw));

  for (const entry of fs.readdirSync(realAddons)) {
    fs.symlinkSync(path.join(realAddons, entry), path.join(addons, entry));
  }
  return { home, addons };
}

function ensureOracle() {
  const dir = path.join(WORK, "oracle-src");
  if (!fs.existsSync(path.join(dir, "src", "merge.js"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: ROOT });
    execFileSync("git", ["worktree", "add", "--detach", dir, ORACLE_TAG], { cwd: ROOT });
  }
  const driver = path.join(WORK, "oracle-driver.mjs");
  fs.writeFileSync(
    driver,
    `
import { analyze, indexSources, buildPacks, commit } from ${JSON.stringify(
      path.join(dir, "src", "merge.js"),
    )};
const capMb = Number(process.argv[2]);
const ctx = analyze();
const index = indexSources(ctx.sources);
const packs = buildPacks(ctx.sources, index, capMb * 1024 * 1024);
const plan = {
  sourceName: ctx.sourceName, destName: ctx.destName,
  modCount: ctx.modCount, vpkCount: ctx.sources.length, totalBytes: ctx.totalBytes,
  packs: packs.map((p) => ({
    mods: p.length, bytes: p.reduce((n, x) => n + x.size, 0),
    from: p[0].pak, to: p[p.length - 1].pak,
  })),
};
const res = commit(ctx, packs);
console.log(JSON.stringify({ plan, dest: res.dest, names: res.names, sizes: res.sizes, badCrc: res.badCrc }));
`,
  );
  return driver;
}

const sha256 = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// Strip run-specific randomness so structural equality is what's compared:
// UUIDs, mod_/profile_ ids, ISO timestamps, and sandbox-absolute paths.
// Descriptions are masked too: the Rust version intentionally lists each
// pack's contents there (a post-parity feature), where js-final wrote a
// fixed string.
function normalize(text, sandboxBase) {
  return text
    .replaceAll(sandboxBase, "<SANDBOX>")
    .replace(/"description":"(?:[^"\\]|\\.)*"/g, '"description":"<DESC>"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/local-[0-9a-f-]{9,36}/gi, "<LOCAL-ID>")
    .replace(/mod_[0-9a-f]{26}/g, "<MOD-ID>")
    .replace(/profile_\d+_[0-9a-z-]{9}/gi, "<PROFILE-ID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>");
}

// Canonical JSON: parse and re-serialize with sorted keys, so map ordering
// differences don't count as drift (DMM parses JSON; order is irrelevant to it).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

function canonicalState(statePath, sandboxBase) {
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const wrapper = typeof raw["local-config"] === "string" ? JSON.parse(raw["local-config"]) : raw["local-config"];
  return JSON.stringify(canonical(JSON.parse(normalize(JSON.stringify(wrapper), sandboxBase))), null, 1);
}

function main() {
  const realState = findRealState();
  fs.mkdirSync(WORK, { recursive: true });
  const driver = ensureOracle();

  console.log(`parity: profile=${profileId} cap=${capMb}MiB`);
  console.log("== oracle (js-final) ==");
  // The oracle is deterministic per (profile, cap); cache its run so iterating
  // on the Rust side doesn't rewrite 4+ GB every time.
  const cachePath = path.join(WORK, `oracle-out-${profileId}-${capMb}.json`);
  const sbO = {
    home: path.join(WORK, "oracle", "home"),
    addons: path.join(WORK, "oracle", "game", "game", "citadel", "addons"),
  };
  let outO;
  if (fs.existsSync(cachePath)) {
    outO = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    console.log(`   cached (${outO.names.length} packs) — delete ${cachePath} to re-run`);
  } else {
    makeSandbox("oracle", realState);
    outO = JSON.parse(
      execFileSync("node", [driver, String(capMb)], {
        env: { ...process.env, HOME: sbO.home },
        maxBuffer: 64 * 1024 * 1024,
      }).toString(),
    );
    fs.writeFileSync(cachePath, JSON.stringify(outO));
    console.log(`   ${outO.names.length} packs written`);
  }

  console.log("== rust ==");
  execFileSync("cargo", ["build", "--release", "--bin", "parity"], {
    cwd: path.join(ROOT, "src-tauri"),
    stdio: ["ignore", "ignore", "inherit"],
  });
  const rustBin = path.join(ROOT, "src-tauri", "target", "release", "parity");
  const sbR = makeSandbox("rust", realState);
  const planR = JSON.parse(
    execFileSync(rustBin, ["plan", profileId, String(capMb)], {
      env: { ...process.env, HOME: sbR.home },
    }).toString(),
  );
  const outR = JSON.parse(
    execFileSync(rustBin, ["merge", profileId, String(capMb)], {
      env: { ...process.env, HOME: sbR.home },
      maxBuffer: 64 * 1024 * 1024,
    }).toString(),
  );
  console.log(`   ${outR.names.length} packs written`);
  // Both merges report where they actually wrote; never guess via readdir —
  // the sandbox addons also contains symlinks to pre-existing profile folders.
  const destR = outR.dest;

  let failures = 0;
  const check = (label, ok, detail = "") => {
    console.log(`${ok ? "  ok " : "FAIL "} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failures++;
  };

  // 1. Plans identical.
  const pO = JSON.stringify(outO.plan);
  const pR = JSON.stringify(planR);
  check("plan JSON identical", pO === pR, `\n  oracle: ${pO}\n  rust:   ${pR}`);

  // 2. Pack bytes identical.
  check("pack count", outO.names.length === outR.names.length);
  const destO = outO.dest;
  for (let i = 0; i < Math.min(outO.names.length, outR.names.length); i++) {
    const a = path.join(destO, outO.names[i]);
    const b = path.join(destR, outR.names[i]);
    const ha = sha256(a);
    const hb = sha256(b);
    check(`${outO.names[i]} byte-identical (${(fs.statSync(a).size / 1e6).toFixed(1)} MB)`, ha === hb, `${ha} != ${hb}`);
  }

  // 3. .dmm.json identical after normalization.
  const mO = normalize(fs.readFileSync(path.join(destO, ".dmm.json"), "utf8"), path.join(WORK, "oracle"));
  const mR = normalize(fs.readFileSync(path.join(destR, ".dmm.json"), "utf8"), path.join(WORK, "rust"));
  check(".dmm.json identical (normalized)", mO === mR);

  // 4. Whole state.json identical after normalization — catches both a wrong
  //    profile entry AND accidental mutation anywhere else in the document.
  const stateO = path.join(sbO.home, ".local", "share", APP_ID, "state.json");
  const stateR = path.join(sbR.home, ".local", "share", APP_ID, "state.json");
  const cO = canonicalState(stateO, path.join(WORK, "oracle"));
  const cR = canonicalState(stateR, path.join(WORK, "rust"));
  if (cO !== cR) {
    const linesO = cO.split("\n");
    const linesR = cR.split("\n");
    const diffAt = linesO.findIndex((l, i) => l !== linesR[i]);
    check("state.json identical (normalized)", false, `first diff at line ${diffAt}:\n  oracle: ${linesO[diffAt]}\n  rust:   ${linesR[diffAt]}`);
  } else {
    check("state.json identical (normalized)", true);
  }

  check("badCrc identical", JSON.stringify(outO.badCrc) === JSON.stringify(outR.badCrc));

  console.log(failures === 0 ? "\nPARITY: PASS" : `\nPARITY: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
