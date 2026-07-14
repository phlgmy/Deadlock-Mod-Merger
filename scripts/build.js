// Build standalone binaries for every supported platform via `deno compile`.
// Requires Deno 2 on PATH. Outputs to dist/.
//
// Optional argument filters by name: `node scripts/build.js windows`

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  "x86_64-pc-windows-msvc": "deadlock-mod-merger-windows-x64.exe",
  "x86_64-apple-darwin": "deadlock-mod-merger-macos-x64",
  "aarch64-apple-darwin": "deadlock-mod-merger-macos-arm64",
  "x86_64-unknown-linux-gnu": "deadlock-mod-merger-linux-x64",
  "aarch64-unknown-linux-gnu": "deadlock-mod-merger-linux-arm64",
};

fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });

const only = process.argv[2];
for (const [target, name] of Object.entries(TARGETS)) {
  if (only && !name.includes(only)) continue;
  console.log(`\n== ${name}`);
  const r = spawnSync(
    "deno",
    [
      "compile",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-sys=homedir",
      "--allow-run",
      "--allow-net=127.0.0.1",
      "--include",
      "web",
      "--target",
      target,
      "--output",
      path.join(ROOT, "dist", name),
      "src/server.js",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
