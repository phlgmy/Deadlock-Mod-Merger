const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
  $("error-text").textContent = String(message);
  show("error");
  show("plan", false);
  show("busy", false);
  show("done", false);
}

let currentPlan = null;

async function loadProfiles() {
  const data = await invoke("profiles");
  const sel = $("profile");
  sel.innerHTML = "";
  for (const p of data.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    const tag = p.mergedFrom ? " (merged)" : "";
    opt.textContent = `${p.name}${tag} — ${p.enabledMods} mods`;
    if (p.id === data.activeProfileId) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadPlan() {
  const cap = Number($("cap").value) || 500;
  $("cap-label").textContent = `${cap} MiB`;
  const profileId = $("profile").value;
  if (!profileId) return;

  try {
    const data = await invoke("plan", { profileId, maxMb: cap });
    currentPlan = data;

    $("mods").textContent = data.modCount;
    $("vpks").textContent = data.vpkCount;
    $("total").textContent = human(data.totalBytes);
    $("packcount").textContent = data.packs.length;
    $("packs").innerHTML = data.packs
      .map(
        (p, i) =>
          `<div class="pack"><span>Pack ${String(i + 1).padStart(2, "0")} · ${p.mods} mod${
            p.mods === 1 ? "" : "s"
          }</span><span>${human(p.bytes)}</span></div>`,
      )
      .join("");

    if (data.isUpdate) {
      $("go").textContent = `Update “${data.destName}” from “${data.sourceName}”`;
      $("plan-note").textContent =
        "This is a merged profile. Updating re-merges it from its source profile, replacing its packs in place.";
    } else {
      $("go").textContent = `Merge into new profile “${data.destName}”`;
      $("plan-note").textContent = `“${data.sourceName}” stays untouched; the merge goes into a new profile.`;
    }

    $("profile-hint").textContent = "";
    show("error", false);
    show("done", false);
    show("plan");
  } catch (e) {
    fail(e);
  }
}

listen("merge-progress", ({ payload: p }) => {
  const pct = p.total ? Math.round((p.written / p.total) * 100) : 0;
  $("bar").value = pct;
  $("busy-text").textContent =
    p.phase === "writing" ? `Writing pack ${p.pack} of ${p.packs} — ${pct}%` : "Indexing…";
});

$("go").onclick = async () => {
  $("go").disabled = true;
  show("plan", false);
  $("bar").value = 0;
  $("busy-text").textContent = "Indexing…";
  show("busy");

  try {
    const job = await invoke("merge_profile", {
      profileId: $("profile").value,
      maxMb: Number($("cap").value) || 500,
    });
    show("busy", false);
    $("done-title").textContent = job.updated
      ? `Updated “${job.destName}”`
      : `Created “${job.destName}”`;
    const crc = job.badCrc.length
      ? `\n\n${job.badCrc.length} file(s) failed CRC — a source VPK is already corrupt. ` +
        `The merged copy matches what was on disk, byte for byte.`
      : "";
    const codeEl = document.createElement("code");
    codeEl.textContent = job.dest;
    $("done-body").textContent = "";
    $("done-body").append(
      `${job.packs} packs · ${human(job.bytes)}\n`,
      codeEl,
      `\n\nOpen DMM and switch to “${job.destName}”. “${job.sourceName}” is unchanged.${crc}`,
    );
    show("done");
    await loadProfiles();
  } catch (e) {
    fail(e);
  } finally {
    $("go").disabled = false;
  }
};

$("again").onclick = () => {
  show("done", false);
  loadPlan();
};

$("retry").onclick = () => {
  show("error", false);
  init();
};

let capTimer;
$("cap").oninput = () => {
  const cap = Number($("cap").value) || 500;
  $("cap-label").textContent = `${cap} MiB`;
  clearTimeout(capTimer);
  capTimer = setTimeout(loadPlan, 250);
};

$("profile").onchange = loadPlan;

async function init() {
  try {
    await loadProfiles();
    await loadPlan();
  } catch (e) {
    fail(e);
  }
}

init();
