# Deadlock Mod Merger

Deadlock stops mounting addons at 99 VPK files, and every mod deployed by
[Deadlock Mod Manager](https://deadlockmods.app) is at least one file, so big profiles hit a
wall long before you run out of mods you want.

This tool breaks that wall without taking anything away from DMM. It merges a profile's mods
into a handful of packed VPKs and registers the result as a separate profile. You keep
curating the original profile in DMM exactly as before: which mods are active, which of
their files are enabled, what needs updating. When it changes, re-merge. The merged profile
is just the compiled, game-loadable form of it.

A small native app (Rust + Tauri), themed to match DMM. Nothing is uploaded anywhere.

## Use it

Download from the [latest release](https://github.com/phlgmy/Deadlock-Mod-Merger/releases/latest)
and run it:

- **Windows**: `deadlock-mod-merger-windows-x64.exe`. A portable exe, nothing to install.
  SmartScreen may warn because it is unsigned; choose *More info, Run anyway*.
- **Linux**: `deadlock-mod-merger-linux-x64.AppImage`. `chmod +x` it first.

Pick a profile, pick a size cap, hit **Merge**, then open DMM and switch to the new
`<name> +` profile.

**Close DMM before merging.** Its store drops writes until it has read `state.json`, so if it
is open while the new profile is written, it overwrites it on exit and the merge is lost with
no error.

### Updating a merged profile

Adjust your mod set in the source profile, then select either profile and merge again: the
merged profile is rebuilt in place, stale packs are deleted, and you never pile up
`Name +`, `Name + +`. The plan view warns you before anything is overwritten. Treat the
merged profile as a build artifact, not something you edit.

## What gets merged

Every mod enabled in the selected profile *and* in that profile's `.dmm.json`, taking only the
manifest's `currentVpks`, DMM's record of the files it actually deployed. A mod with several
variants therefore contributes only the one you selected, with no variant-guessing here.

## How load order survives

**It never decides a conflict.**

Two mods conflict when they ship the same internal file with different bytes. The engine
resolves those at mount time, by pak order. The merger's one rule: two conflicting mods never
share a pack, and the earlier one always lands in an earlier pack. The game then reaches
exactly the result it reaches today, whatever its resolution rule is. Nothing is dropped.

The tempting optimisation, deduplicate across mods and keep one winner per file, **does not
work in either direction.** `Unstoppable` sits at pak01 precisely to *beat* later mods and
stop them overwriting vanilla files. QOL Lock's announcer pack sits at pak10 precisely to
*beat* QOL Lock at pak02-09. Keep the lowest and you delete the announcer pack; keep the
highest and you delete Unstoppable's protection. There is no single rule that satisfies both,
because the engine's behaviour is richer than "always keep one copy". Don't model it,
preserve it.

Packing is first-fit under that rule. Mods are walked in ascending pak order, so every
conflict an incoming mod has must resolve with it mounting later; it may therefore join any
pack strictly after the last pack that conflicts with it, and takes the earliest one with
room under the size cap. A conflict starts a new pack but never seals the old ones. The pack
count is floored by the longest chain of pairwise-conflicting mods, which no packing can
beat, and the merge refuses to write anything if any conflicting pair would land out of
order.

## What it writes

- `citadel/addons/profile_<id>_<name>/pak01_dir.vpk ...`, the packs
- `.dmm.json` in that folder, so DMM knows which VPK belongs to which pack, and in what order
- `.dmm-merger.json` in that folder, this tool's record of which profile the merge came from
- One new profile in DMM's `state.json`, with each pack registered as its own mod whose
  description lists the mods inside, so packs are inspectable from DMM

`state.json` is backed up beside itself before it is touched. The source profile's entry,
folder and VPKs are never modified.

## Building from source

Needs [Rust](https://rustup.rs) and, on Linux, the
[Tauri system packages](https://tauri.app/start/prerequisites/) (webkit2gtk 4.1, gtk3).

```sh
cd src-tauri
cargo run                 # dev
cargo build --release     # portable binary in target/release/
npx @tauri-apps/cli build # AppImage / full bundles
```

Releases are built by CI when a `v*` tag is pushed.

### Verification

`scripts/verify.mjs` runs a real merge in a sandbox (reads your real mods, writes nowhere
near your game) and checks the properties that matter: every pack parses, no file path is
dropped or invented, and for every path the first- and last-mounted bytes match the original
layout, so the engine resolves everything to the same result. The conflict-order invariant is
additionally re-checked inside the app on every merge, and `cargo test` covers the packing
edge cases.

```sh
node scripts/verify.mjs <profile-id> <cap-mb>
```

History: this app is a Rust port of an earlier Node implementation (tag `js-final`). The port
was gated on byte-identical output against it (commit `adf90d3`); the packing algorithm has
since been improved, so byte parity no longer holds by design and the property checks above
replace it.

## Caveats

- A merged pack is one on/off switch. To change your mod set, edit the source profile and
  re-merge.
- Only self-contained VPKs are supported, which is everything DMM deploys. Multi-chunk
  archives (`pak01_000.vpk`) are reported rather than mangled.
- A single VPK cannot exceed 4 GiB; the format's directory offsets are 32-bit.
