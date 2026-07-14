# Deadlock Mod Merger

Merges the mods in a [Deadlock Mod Manager](https://deadlockmods.app) profile into
a handful of VPKs, and registers the result as a new profile — **without changing what your
game loads.**

Source 2 mounts every `pakNN_dir.vpk` in the addons folder separately, so a hundred mods
means a hundred archives. This collapses them into a dozen or so. The original profile is
left completely untouched, so you can switch back whenever you like.

A small native app (Rust + Tauri), themed to match DMM. Nothing is uploaded anywhere.

## Use it

Download from the [latest release](https://github.com/phlgmy/Deadlock-Mod-Merger/releases/latest)
and run it:

- **Windows**: `deadlock-mod-merger-windows-x64.exe` — a portable exe, nothing to install.
  SmartScreen may warn because it is unsigned; choose *More info → Run anyway*.
- **Linux**: `deadlock-mod-merger-linux-x64.AppImage` — `chmod +x` it first.

Pick a profile, pick a size cap, hit **Merge**, then open DMM and switch to the new
`<name> +` profile.

**Close DMM before merging.** Its store drops writes until it has read `state.json`, so if it
is open while the new profile is written, it overwrites it on exit and the merge is lost with
no error.

### Updating a merged profile

Mods update, profiles change. Select a previously merged profile in the dropdown and the
button becomes **Update**: the tool re-merges from the original source profile and replaces
the merged profile's packs in place. Adjust your mod set in the *source* profile, then
update — the merged profile is a build artifact, not something you edit.

Merging a source profile that already has a merged counterpart overwrites that counterpart
(the plan view warns you first) — you never end up with "Name +", "Name + +", and so on.

## What gets merged

Every mod enabled in the selected profile *and* in that profile's `.dmm.json`, taking only the
manifest's `currentVpks` — DMM's record of the files it actually deployed. A mod with several
variants therefore contributes only the one you selected, with no variant-guessing here.

## How load order survives

**It never decides a conflict.**

Two mods conflict when they ship the same internal file with different bytes. The engine
resolves those at mount time, by pak order. So the merger walks your mods in pak order and
starts a **new pack** whenever the next mod would conflict with one already in the current
pack. Packs are written `pak01`, `pak02`, … in that same order, so every conflicting pair
keeps its original relative position and the game reaches exactly the result it reaches
today. Nothing is dropped.

The tempting optimisation — deduplicate across mods and keep one winner per file — **does not
work, in either direction.** `Unstoppable` sits at pak01 precisely to *beat* later mods and
stop them overwriting vanilla files. QOL Lock's announcer pack sits at pak10 precisely to
*beat* QOL Lock at pak02–09. Keep the lowest and you delete the announcer pack; keep the
highest and you delete Unstoppable's protection. There is no single rule that satisfies both,
because the engine's behaviour is richer than "always keep one copy". Don't model it —
preserve it.

## What it writes

- `citadel/addons/profile_<id>_<name>/pak01_dir.vpk …` — the packs
- `.dmm.json` in that folder, so DMM knows which VPK belongs to which pack, and in what order
- `.dmm-merger.json` in that folder — this tool's own record of which profile the merge came
  from, which is what makes **Update** possible
- One new profile in DMM's `state.json`, with each pack registered as its own mod — its
  description lists the mods inside, so you can see and reorder packs from DMM

`state.json` is backed up beside itself before it is touched. The source profile's entry,
folder and VPKs are never modified.

## Building from source

Needs [Rust](https://rustup.rs) and, on Linux, the
[Tauri system packages](https://tauri.app/start/prerequisites/) (webkit2gtk 4.1, gtk3).

```sh
cd src-tauri
cargo run                # dev
cargo build --release    # portable binary in target/release/
npx @tauri-apps/cli build # AppImage / full bundles
```

Releases are built by CI when a `v*` tag is pushed.

### Parity with the original implementation

This app is a Rust port of an earlier Node implementation (tag `js-final`). The port was
gated on a golden-diff harness that runs both against the same profile in a sandbox and
requires byte-identical packs and equivalent state changes:

```sh
node scripts/parity.mjs <profile-id> <cap-mb>
```

## Caveats

- A merged pack is one on/off switch. To change your mod set, edit the original profile and
  hit **Update**.
- Only self-contained VPKs are supported — which is everything DMM deploys. Multi-chunk
  archives (`pak01_000.vpk`) are reported rather than mangled.
- A single VPK cannot exceed 4 GiB; the format's directory offsets are 32-bit.
