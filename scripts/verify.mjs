// Sandboxed end-to-end verification of the merger.
//
//   node scripts/verify.mjs [profile-id] [cap-mb]
//
// Runs a real merge against a sandbox: a fake $HOME containing a copy of the
// real DMM state.json whose gamePath points at a fake game tree whose addons
// are symlinks to the real ones. Reads hit real mod VPKs; writes stay in the
// sandbox. Nothing outside ~/.cache/dmm-verify is touched.
//
// Checks:
//   - conflict-order invariant (enforced inside commit(); a violation aborts
//     the merge before anything is written)
//   - every written pack parses as a valid VPK
//   - coverage: the set of file paths across all packs equals the set across
//     all source VPKs — nothing dropped, nothing invented
//   - per-path winner: for every path, the bytes that mount LAST across the
//     packs (highest pack) have the same CRC as the bytes that mount last
//     across the sources (highest pak) — and the same for FIRST, so the
//     engine reaches the same result whichever end its rule prefers
//   - the merged profile is registered in state.json with one mod per pack
//
// History: the original Rust port was gated on byte-identical output against
// the JS implementation (tag js-final, commit adf90d3). The packing algorithm
// has since been improved (constrained first-fit), so byte parity with
// js-final no longer holds by design; these property checks replace it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(os.homedir(), ".cache", "dmm-verify");
const APP_ID = "dev.stormix.deadlock-mod-manager";

const profileId = process.argv[2] || "default";
const capMb = Number(process.argv[3]) || 500;

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

function makeSandbox(realStatePath) {
  fs.rmSync(WORK, { recursive: true, force: true });
  const home = path.join(WORK, "home");
  const addons = path.join(WORK, "game", "game", "citadel", "addons");
  fs.mkdirSync(addons, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(realStatePath, "utf8"));
  const wasString = typeof raw["local-config"] === "string";
  const wrapper = wasString ? JSON.parse(raw["local-config"]) : raw["local-config"];
  const realAddons = path.join(wrapper.state.gamePath, "game", "citadel", "addons");
  wrapper.state.gamePath = path.join(WORK, "game");
  raw["local-config"] = wasString ? JSON.stringify(wrapper) : wrapper;

  const stateDir = path.join(home, ".local", "share", APP_ID);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(raw));

  for (const entry of fs.readdirSync(realAddons)) {
    fs.symlinkSync(path.join(realAddons, entry), path.join(addons, entry));
  }
  return { home, addons };
}

function main() {
  execFileSync("cargo", ["build", "--release", "--bin", "parity"], {
    cwd: path.join(ROOT, "src-tauri"),
    stdio: ["ignore", "ignore", "inherit"],
  });
  const bin = path.join(ROOT, "src-tauri", "target", "release", "parity");
  const sb = makeSandbox(findRealState());
  const env = { ...process.env, HOME: sb.home };
  const run = (args) =>
    JSON.parse(execFileSync(bin, args, { env, maxBuffer: 256 * 1024 * 1024 }).toString());

  console.log(`verify: profile=${profileId} cap=${capMb}MiB`);
  const plan = run(["plan", profileId, String(capMb)]);
  console.log(`plan: ${plan.modCount} mods, ${plan.vpkCount} VPKs -> ${plan.packs.length} packs`);

  const out = run(["merge", profileId, String(capMb)]);
  console.log(`merged: ${out.names.length} packs written (invariant checked in commit)`);

  let failures = 0;
  const check = (label, ok, detail = "") => {
    console.log(`${ok ? "  ok " : "FAIL "} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failures++;
  };

  // Parse every pack; build pack-side path map in mount order.
  // firstCrc = crc in the earliest pack containing the path; lastCrc = latest.
  const packFirst = new Map();
  const packLast = new Map();
  for (const name of out.names) {
    const entries = run(["list", path.join(out.dest, name), "0"]);
    check(`${name} parses (${entries.length} files)`, entries.length > 0);
    for (const e of entries) {
      if (!packFirst.has(e.path)) packFirst.set(e.path, e.crc);
      packLast.set(e.path, e.crc);
    }
  }

  // Source-side map in pak mount order (plan.sources is already pak-sorted).
  const srcFirst = new Map();
  const srcLast = new Map();
  for (const vpk of plan.sources) {
    for (const e of run(["list", vpk, "0"])) {
      if (!srcFirst.has(e.path)) srcFirst.set(e.path, e.crc);
      srcLast.set(e.path, e.crc);
    }
  }

  check(
    `coverage: ${srcLast.size} source paths == ${packLast.size} pack paths`,
    srcLast.size === packLast.size && [...srcLast.keys()].every((p) => packLast.has(p)),
  );

  let badFirst = 0;
  let badLast = 0;
  for (const [p, crc] of srcFirst) if (packFirst.get(p) !== crc) badFirst++;
  for (const [p, crc] of srcLast) if (packLast.get(p) !== crc) badLast++;
  check(`first-mounted bytes preserved for every path`, badFirst === 0, `${badFirst} mismatches`);
  check(`last-mounted bytes preserved for every path`, badLast === 0, `${badLast} mismatches`);

  // The merged profile is registered with one mod per pack.
  const state = JSON.parse(
    fs.readFileSync(path.join(sb.home, ".local", "share", APP_ID, "state.json"), "utf8"),
  );
  const wrapper =
    typeof state["local-config"] === "string"
      ? JSON.parse(state["local-config"])
      : state["local-config"];
  const folder = out.dest.split("/").at(-1);
  const prof = Object.values(wrapper.state.profiles).find((p) => p.folderName === folder);
  check(
    `profile registered with ${out.names.length} pack mods`,
    prof && prof.mods.length === out.names.length,
  );

  console.log(failures === 0 ? "\nVERIFY: PASS" : `\nVERIFY: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
