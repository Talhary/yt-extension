// The download engine. Runs in the offscreen document (offscreen.html) so downloads, muxing and encoding
// can take as long as they need. Speaks the same messages and job fields the old native helper (host.py)
// did, so content.js and popup.js are unchanged: ping, info, list, probe, download, cancel, reveal, clear.
import * as yt from "./youtube.js";
import * as web from "./web.js";
import { clearTemp, removeTemp } from "./store.js";

const DIR = "YT-Downloader"; // inside the browser's download folder
const DIR_LABEL = "Downloads\\" + DIR;

const bg = (type, data = {}) => chrome.runtime.sendMessage({ target: "bg", type, ...data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- jobs

const JOBS = [];
const RUNNING = new Map(); // job id -> AbortController
let nextId = 1;

let lastPush = 0, pushTimer = null;
function push(force = false) {
  const wait = 500 - (Date.now() - lastPush);
  if (!force && wait > 0) {
    pushTimer ??= setTimeout(() => { pushTimer = null; push(true); }, wait);
    return;
  }
  lastPush = Date.now();
  bg("jobs", { jobs: JOBS.slice(-20), dir: DIR_LABEL }).catch(() => {});
}

// Usable as a Windows file/folder name.
const safeName = (name, limit = 150) =>
  String(name || "").replace(/[<>:"/\\|?*\x00-\x1f~]/g, "_").replace(/\s+/g, " ").trim().slice(0, limit).replace(/[ .]+$/, "") || "download";
const pad = (n) => String(n).padStart(3, "0");

// Saves `url` (a blob: of a temp file, or a direct media link) as `filename` under the download folder and
// waits for the browser to finish. Progress for direct links comes from the browser's download.
async function save(job, url, filename, onProgress, signal) {
  const { id, error } = await bg("saveUrl", { url, filename });
  if (error) throw new Error(error);
  job.downloadIds.push(id);
  for (;;) {
    if (signal?.aborted) { await bg("cancelDownload", { id }); throw signal.reason; }
    const s = await bg("downloadState", { id });
    if (s.state === "complete") return s;
    if (s.state === "interrupted" || s.state === "missing") throw new Error(`Saving failed: ${s.error || s.state}`);
    if (s.total > 0) onProgress?.(s.bytes / s.total);
    await sleep(400);
  }
}

// The browser picks a file's extension from its MIME type (untyped blobs are saved as .txt).
const MIME = { mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg", flac: "audio/flac" };

async function saveResult(job, res, filename, onProgress, signal) {
  if (res.url) return save(job, res.url, filename, onProgress, signal);
  const file = await res.tmp.handle.getFile();
  const blobUrl = URL.createObjectURL(new Blob([file], { type: MIME[res.ext] || "application/octet-stream" }));
  try {
    return await save(job, blobUrl, filename, null, signal);
  } finally {
    URL.revokeObjectURL(blobUrl);
    await removeTemp(res.tmp.name);
  }
}

// Runs fn(item, i) for every item with at most `n` at once.
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

async function run(job, p) {
  const ac = new AbortController();
  RUNNING.set(job.id, ac);
  job.state = "downloading";
  push(true);
  const opts = { mode: job.mode, quality: job.quality, audioFormat: job.audio_format, audioBitrate: job.audio_bitrate, signal: ac.signal };
  yt.useCookies(p.cookies);

  // What to fetch: one item per file.
  let items;
  const folder = safeName(p.title || (p.direct ? "Download" : "Playlist"), 100);
  if (p.direct?.length) {
    items = p.direct.map((d, i) => ({ kind: "direct", url: d.url, file: `${DIR}/${folder}/${safeName(d.name)}`, n: i + 1 }));
  } else if (job.playlist) {
    const mix = /[?&]list=RD/.test(p.url);
    items = (p.entries || []).map((e, i) => ({ kind: "yt", id: e.id, title: e.title, n: mix ? i + 1 : e.index }));
  } else if (p.web) {
    items = [{ kind: "web" }];
  } else {
    items = [{ kind: "yt", id: yt.videoID(p.url) }];
  }
  const total = items.length;
  const frac = new Array(total).fill(0);
  let started = 0;
  const progress = () => {
    job.progress = Math.min(100, frac.reduce((a, b) => a + b, 0) / total * 100);
    if (job.playlist) job.item = `${Math.min(started, total)}/${total}`;
    push();
  };

  await pool(items, job.playlist ? job.parallel : 1, async (it, i) => {
    if (ac.signal.aborted) return;
    started++;
    const onProgress = (f) => { frac[i] = f; progress(); };
    try {
      if (it.kind === "direct") {
        await save(job, it.url, it.file, onProgress, ac.signal);
      } else if (it.kind === "web") {
        const res = await web.download(p.req, { ...opts, title: p.title, onProgress });
        await saveResult(job, res, `${DIR}/${safeName(p.title || "video", 150)}.${res.ext}`, onProgress, ac.signal);
      } else {
        const tags = job.playlist ? { album: p.title || undefined, trackNumber: it.n } : undefined;
        const res = await yt.downloadVideo(it.id, { ...opts, tags, onProgress });
        if (!job.playlist) { job.title = res.title; push(); }
        const name = job.playlist
          ? `${DIR}/${folder}/${pad(it.n)} - ${safeName(res.title, 120)}.${res.ext}`
          : `${DIR}/${safeName(res.title, 120)} [${it.id}].${res.ext}`;
        await saveResult(job, res, name, null, ac.signal);
      }
      frac[i] = 1;
    } catch (e) {
      if (ac.signal.aborted) return;
      job.failed++;
      job.error = `${it.title ? it.title + ": " : ""}${e.message || e}`.slice(0, 300);
      console.warn(`job ${job.id} item ${i + 1}`, e);
      frac[i] = 1;
    }
    progress();
  });

  RUNNING.delete(job.id);
  if (job.state !== "cancelled") {
    job.state = job.failed >= total ? "error" : "done";
    if (job.state === "done") {
      job.progress = 100;
      if (job.failed) job.error = `${job.failed} item(s) failed · last: ${job.error}`;
    }
  }
  push(true);
}

function startDownload(p) {
  const job = {
    id: nextId++, url: p.url, mode: p.mode === "audio" ? "audio" : "video", playlist: !!p.playlist,
    quality: Number(p.quality ?? 1080), audio_format: ["mp3", "m4a", "opus", "flac"].includes(p.audioFormat) ? p.audioFormat : "mp3",
    audio_bitrate: Number(p.audioBitrate || 320), state: "queued", progress: 0, title: p.title || "", item: "", error: "",
    failed: 0, parallel: Math.max(1, Math.min(Number(p.parallel) || 3, 6)), downloadIds: [],
  };
  JOBS.push(job);
  run(job, p).catch((e) => {
    RUNNING.delete(job.id);
    job.state = "error";
    job.error = String(e?.message || e);
    push(true);
  });
}

// ---------------------------------------------------------------- messages

const isYouTube = (url) => { try { return /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(url).hostname); } catch { return false; } };

async function handle(type, p = {}) {
  switch (type) {
    case "ping":
      return { ok: true, dir: DIR_LABEL };
    case "info":
      yt.useCookies(p.cookies);
      return { ok: true, ...await yt.info(p.url) };
    case "play":
      yt.useCookies(p.cookies);
      return { ok: true, ...await yt.playable(p.url, 1080, !!p.fresh) };
    case "list":
      yt.useCookies(p.cookies);
      return { ok: true, ...await yt.list(p.url) };
    case "probe": // any other site
      if (isYouTube(p.url)) {
        yt.useCookies(p.cookies);
        return { ok: true, ...(new URL(p.url).searchParams.get("list") ? await yt.list(p.url) : await yt.info(p.url)) };
      }
      return { ok: true, ...await web.probe(p) };
    case "download":
      if (!p.direct && !p.playlist && !isYouTube(p.url)) { p.web = true; p.req = { url: p.url, src: p.src, media: p.media, title: p.title }; }
      startDownload(p);
      return { ok: true, dir: DIR_LABEL };
    case "cancel": {
      const job = JOBS.find((j) => j.id === Number(p.jobId));
      if (job && ["queued", "downloading"].includes(job.state)) {
        job.state = "cancelled";
        RUNNING.get(job.id)?.abort(new DOMException("Cancelled", "AbortError"));
        push(true);
      }
      return { ok: true };
    }
    case "reveal": {
      const job = JOBS.find((j) => j.id === Number(p.jobId));
      await bg("reveal", { id: job?.downloadIds.at(-1) });
      return { ok: true };
    }
    case "clear":
      JOBS.splice(0, JOBS.length, ...JOBS.filter((j) => ["queued", "downloading"].includes(j.state)));
      push(true);
      return { ok: true };
  }
  return { ok: false, error: `unknown request ${type}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "engine") return;
  handle(msg.type, msg.payload).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

await clearTemp();
bg("engine-ready").catch(() => {});
yt.warmup();
