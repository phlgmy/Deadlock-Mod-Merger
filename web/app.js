const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

const human = (n) => {
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
};

function fail(message) {
  $("error-text").textContent = message;
  show("error");
  show("plan", false);
  show("busy", false);
}

async function loadPlan() {
  const cap = Number($("cap").value) || 500;
  const res = await fetch(`/api/plan?maxMb=${cap}`);
  const data = await res.json();
  if (!res.ok) return fail(data.error);

  $("src").textContent = data.sourceName;
  $("dst").textContent = data.destName;
  $("mods").textContent = data.modCount;
  $("vpks").textContent = `${data.vpkCount}  (${human(data.totalBytes)})`;
  $("packcount").textContent = data.packs.length;
  $("packs").innerHTML = data.packs
    .map(
      (p, i) =>
        `<div class="pack"><span>Pack ${String(i + 1).padStart(2, "0")} · ${p.mods} mod${
          p.mods === 1 ? "" : "s"
        }</span><span>${human(p.bytes)}</span></div>`,
    )
    .join("");

  show("error", false);
  show("plan");
}

async function poll() {
  const job = await fetch("/api/job").then((r) => r.json());

  if (job.state === "running") {
    const pct = job.total ? Math.round((job.written / job.total) * 100) : 0;
    $("bar").value = pct;
    $("busy-text").textContent =
      job.phase === "writing"
        ? `Writing pack ${job.pack} of ${job.packs} — ${pct}%`
        : "Indexing…";
    setTimeout(poll, 250);
    return;
  }

  if (job.state === "error") {
    show("busy", false);
    return fail(job.message);
  }

  if (job.state === "done") {
    show("busy", false);
    $("done-title").textContent = `Created “${job.destName}”`;
    const crc = job.badCrc.length
      ? `<br /><br /><span class="warn">${job.badCrc.length} file(s) failed CRC — a source
         VPK is already corrupt. The merged copy matches what was on disk, byte for
         byte.</span>`
      : "";
    $("done-body").innerHTML = `
      ${job.packs} packs · ${human(job.bytes)}<br />
      <code>${job.dest}</code><br /><br />
      Open DMM and switch to “${job.destName}”. “${job.sourceName}” is unchanged.${crc}`;
    show("done");
  }
}

$("go").onclick = async () => {
  $("go").disabled = true;
  show("plan", false);
  show("busy");
  const res = await fetch("/api/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxMb: Number($("cap").value) || 500 }),
  });
  if (!res.ok) return fail((await res.json()).error);
  poll();
};

let capTimer;
$("cap").oninput = () => {
  clearTimeout(capTimer);
  capTimer = setTimeout(loadPlan, 300);
};

loadPlan().catch((e) => fail(String(e)));
