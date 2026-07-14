// Local web server. Serves the page and a tiny JSON API, then opens a browser.
//
// A browser cannot read DMM's state.json or write multi-hundred-megabyte VPKs, so
// the work happens here and the page is just the UI. Bound to 127.0.0.1 — nothing
// is exposed to the network.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, buildPacks, commit, indexSources } from "./merge.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// The merge runs in the background; the page polls this.
let job = null; // { state: "running"|"done"|"error", ... }

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function plan(maxMb) {
  const ctx = analyze();
  const index = indexSources(ctx.sources);
  const packs = buildPacks(ctx.sources, index, maxMb * 1024 * 1024);
  return { ctx, packs };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const routes = {
  "GET /api/plan": (req, res, url) => {
    const maxMb = Number(url.searchParams.get("maxMb")) || 500;
    const { ctx, packs } = plan(maxMb);
    json(res, 200, {
      sourceName: ctx.sourceName,
      destName: ctx.destName,
      sourceDir: ctx.sourceDir,
      modCount: ctx.modCount,
      vpkCount: ctx.sources.length,
      totalBytes: ctx.totalBytes,
      packs: packs.map((p) => ({
        mods: p.length,
        bytes: p.reduce((n, x) => n + x.size, 0),
        from: p[0].pak,
        to: p[p.length - 1].pak,
      })),
    });
  },

  "POST /api/merge": async (req, res) => {
    if (job?.state === "running") return json(res, 409, { error: "already running" });
    const { maxMb = 500 } = await readBody(req);

    job = { state: "running", phase: "indexing", written: 0, total: 0 };
    json(res, 202, { started: true });

    // Deliberately not awaited: the response is already sent and the page polls.
    setImmediate(() => {
      try {
        const { ctx, packs } = plan(maxMb);
        job.total = ctx.totalBytes;
        job.packs = packs.length;
        const result = commit(ctx, packs, (p) => Object.assign(job, p));
        job = {
          state: "done",
          destName: ctx.destName,
          sourceName: ctx.sourceName,
          dest: result.dest,
          packs: result.names.length,
          bytes: result.sizes.reduce((a, b) => a + b, 0),
          badCrc: result.badCrc,
          backup: result.backup,
        };
      } catch (err) {
        job = { state: "error", message: String(err.message || err) };
      }
    });
  },

  "GET /api/job": (req, res) => json(res, 200, job || { state: "idle" }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try {
      await route(req, res, url);
    } catch (err) {
      json(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  // Static files. Only ever from web/, and only the extensions we know.
  const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
  const file = path.join(WEB, name);
  if (!fs.existsSync(file) || !MIME[path.extname(file)]) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] });
  fs.createReadStream(file).pipe(res);
});

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const port = Number(process.env.PORT) || 4173;
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Deadlock Mod Merger  ->  ${url}`);
  console.log("Close DMM before merging, then press Ctrl+C here when you are done.");
  openBrowser(url);
});
