const $ = (id) => document.getElementById(id);
const PATHS = {
  video: "M4 5h12a2 2 0 0 1 2 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  audio: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z",
  close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z",
  empty: "M12 15.6 7.4 11l1.4-1.4 2.2 2.2V4h2v7.8l2.2-2.2 1.4 1.4L12 15.6ZM5 20v-2h14v2H5Z",
};
const icon = (name) => `<svg viewBox="0 0 24 24"><path d="${PATHS[name]}"/></svg>`;
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));

function renderState(res) {
  const ok = res && res.ok;
  $("status").className = "status " + (ok ? "ok" : "bad");
  $("statusText").textContent = ok ? "Ready" : "Offline";
  $("notice").classList.toggle("show", !ok);
  $("notice").textContent = ok ? "" : (res && res.error) || "The download engine didn't start";
  if (ok) $("footer").textContent = "Saving to " + res.dir;
}

function describe(j) {
  if (j.mode === "audio") return (j.audio_format || "mp3").toUpperCase() +
    (j.audio_format === "mp3" ? ` ${j.audio_bitrate}k` : "");
  return j.quality ? `${j.quality}p` : "best";
}

function renderJobs(jobs) {
  const box = $("jobs");
  box.textContent = "";
  const list = (jobs || []).slice().reverse();
  $("clear").style.visibility = list.some((j) => !["queued", "downloading"].includes(j.state)) ? "" : "hidden";
  if (!list.length) {
    box.innerHTML = `<div class="empty">${icon("empty")}No downloads yet</div>`;
    return;
  }
  for (const j of list) {
    const active = j.state === "queued" || j.state === "downloading";
    const d = document.createElement("div");
    d.className = "job " + j.state;
    d.innerHTML = `<div class="kind">${icon(j.mode === "audio" ? "audio" : "video")}</div>
      <div class="info"><div class="title"></div><div class="meta"></div><div class="progress"><i></i></div></div>
      ${active ? `<button class="cancel" title="Cancel">${icon("close")}</button>` : ""}`;
    d.querySelector(".title").textContent = j.title || j.url;
    const state = document.createElement("span");
    state.className = j.state;
    state.textContent = j.state === "downloading" ? `${Math.round(j.progress || 0)}%` : j.state;
    const extra = [describe(j), j.playlist && (j.item ? `item ${j.item}` : "playlist"), j.error]
      .filter(Boolean).join(" · ");
    d.querySelector(".meta").append(state, " · " + extra);
    d.querySelector(".meta").title = j.error || "";
    d.querySelector(".progress i").style.width = (j.progress || 0) + "%";
    if (active) d.querySelector(".cancel").addEventListener("click", (e) => {
      e.stopPropagation();
      send("cancel", { jobId: j.id });
    });
    d.title = j.playlist ? "Open folder" : "Show in folder";
    d.addEventListener("click", () => send("reveal", { jobId: j.id }));
    box.appendChild(d);
  }
}

$("clear").addEventListener("click", () => send("clear"));

// Ask the page's content script to open the download dialog for the current tab.
$("grab").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("notice").textContent = "Open a web page with a video first.";
    return $("notice").classList.add("show");
  }
  chrome.tabs.sendMessage(tab.id, { type: "open-dialog", url: tab.url }, { frameId: 0 }, () => {
    if (chrome.runtime.lastError) {
      $("notice").textContent = "Refresh the page once (it was open before the extension loaded), then try again.";
      $("notice").classList.add("show");
    } else {
      window.close();
    }
  });
});
chrome.storage.sync.get({ parallel: 3 }, ({ parallel }) => {
  const mark = (v) => $("parallel").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === v));
  mark(parallel);
  $("parallel").addEventListener("click", (e) => {
    const v = +e.target.closest("button")?.dataset.v;
    if (v) { chrome.storage.sync.set({ parallel: v }); mark(v); }
  });
});

for (const key of ["thumbIcons", "useCookies", "cleanPlayer"]) {
  chrome.storage.sync.get({ [key]: true }, (s) => { $(key).checked = s[key]; });
  $(key).addEventListener("change", (e) => chrome.storage.sync.set({ [key]: e.target.checked }));
}
send("ping").then(renderState);
chrome.storage.session.get({ jobs: [] }, (s) => renderJobs(s.jobs));
chrome.storage.session.onChanged.addListener((c) => {
  if (c.jobs) renderJobs(c.jobs.newValue);
});
