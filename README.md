# Deadlock Mod Merger

Merges the mods in your active [Deadlock Mod Manager](https://deadlockmods.app) profile into
a handful of VPKs, and registers the result as a new profile — **without changing what your
game loads.**

Source 2 mounts every `pakNN_dir.vpk` in the addons folder separately, so a hundred mods
means a hundred archives. This collapses them into a dozen or so. The original profile is
left completely untouched, so you can switch back whenever you like.

Runs locally in your browser. No dependencies, nothing uploaded anywhere.

## Use it

```sh
git clone https://github.com/phlgmy/Deadlock-Mod-Merger
cd Deadlock-Mod-Merger
node src/server.js
```

Your browser opens at `http://127.0.0.1:4173`. Pick a size cap, hit **Merge**, then open DMM
and switch to the new `<name> +` profile.

Needs [Node](https://nodejs.org) 20 or newer. Works on Linux, macOS and Windows.

**Close DMM before merging.** Its store drops writes until it has read `state.json`, so if it
is open while the new profile is written, it overwrites it on exit and the merge is lost with
no error.

## What gets merged

Every mod enabled in the active profile *and* in that profile's `.dmm.json`, taking only the
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
highest and you delete Unstoppable's protection, QOL Lock, and Catlock's icons. There is no
single rule that satisfies both, because the engine's behaviour is richer than "always keep
one copy". Don't model it — preserve it.

## What it writes

- `citadel/addons/profile_<id>_<name>/pak01_dir.vpk …` — the packs
- `.dmm.json` in that folder, so DMM knows which VPK belongs to which pack, and in what order
- One new profile in DMM's `state.json`, with each pack registered as its own mod so you can
  see and reorder them

`state.json` is backed up beside itself before it is touched. The source profile's entry,
folder and VPKs are never modified.

## Caveats

- A merged pack is one on/off switch. To change your mod set, go back to the original
  profile, adjust it there, and re-merge.
- Only self-contained VPKs are supported — which is everything DMM deploys. Multi-chunk
  archives (`pak01_000.vpk`) are reported rather than mangled.
- A single VPK cannot exceed 4 GiB; the format's directory offsets are 32-bit.
