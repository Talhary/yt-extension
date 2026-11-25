// Any other site: no per-site code. The video is whatever media the page itself loaded, as seen by
// background.js (webRequest): a plain file (MP4/WebM/MP3...) or an HLS playlist. DASH isn't supported.
import { tempFile, removeTemp } from "./store.js";
import { AUDIO, toAudio, toMp4, urlInput } from "./media.js";

const FILE_EXT = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i;
const HLS_EXT = /\.m3u8(?:$|[?#])/i;

// Facebook-style progressive links ask for one byte range in the URL; drop it to get the whole file.
const wholeFile = (url) => {
  try {
    const u = new URL(url);
    for (const k of ["bytestart", "byteend", "range"]) u.searchParams.delete(k);
    return u.href;
  } catch { return url; }
};

async function getText(url) {
  const r = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// HLS: variants from a master playlist (or one variant for a media playlist) + duration.
async function readHls(url) {
  const text = await getText(url);
  if (!text.startsWith("#EXTM3U")) throw new Error("not an HLS playlist");
  const variants = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.startsWith("#EXT-X-STREAM-INF:")) return;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    const bw = Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1] || 0);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (uri) variants.push({ h: res ? Math.min(+res[1], +res[2]) : 0, bandwidth: bw, url: new URL(uri, url).href });
  });
  let duration = null;
  const media = variants.length ? variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url : url;
  try {
    const m = media === url ? text : await getText(media);
    duration = [...m.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, x) => s + Number(x[1]), 0) || null;
    if (!/#EXT-X-ENDLIST/.test(m)) duration = null; // live: no fixed length
  } catch {}
  return { variants, duration, audioOnly: variants.length > 0 && variants.every((v) => !v.h) && /CODECS="mp4a[^",]*"/.test(text) };
}

// Picks what to download: the page's own URL if it is a media file, the <video>'s src, or the media the
// page loaded (newest HLS playlist first, then the biggest file).
async function findSource({ url, src, media = [] }) {
  if (HLS_EXT.test(url)) return { type: "hls", url };
  if (FILE_EXT.test(url)) return { type: "file", url, audio: AUDIO_EXT.test(url) };
  if (src && /^https?:/.test(src)) return { type: "file", url: wholeFile(src), audio: AUDIO_EXT.test(src) };
  const newest = [...media].sort((a, b) => b.time - a.time);
  const hls = newest.filter((m) => m.kind === "hls");
  let fallback = null;
  for (const m of hls.slice(0, 6)) {
    try {
      const h = await readHls(m.url);
      if (h.variants.length) return { type: "hls", url: m.url, hls: h };
      fallback ??= { type: "hls", url: m.url, hls: h };
    } catch {}
  }
  if (fallback) return fallback;
  const files = newest.filter((m) => m.kind === "file" && !(m.size > 0 && m.size < 64_000)); // skip blips, not short clips
  if (files.length) {
    const best = files.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    return { type: "file", url: wholeFile(best.url), audio: best.audio, size: best.size };
  }
  if (newest.some((m) => m.kind === "dash")) throw new Error("This site streams in DASH format, which isn't supported yet");
  throw new Error("No video found on this page. Start playing the video, then try again.");
}

const sources = new Map(); // page url -> source found by the last probe

export async function probe(req) {
  const source = await findSource(req);
  if (source.type === "hls" && !source.hls) source.hls = await readHls(source.url);
  sources.set(req.url, source);
  const host = (() => { try { return new URL(req.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const out = { kind: "video", title: req.title || host, uploader: host, duration: null, thumbnail: req.thumbnail || null,
    audioSize: 0, hasVideo: true, heights: [] };
  if (source.type === "hls") {
    const h = source.hls;
    out.duration = h.duration;
    out.hasVideo = !h.audioOnly;
    const best = new Map();
    for (const v of h.variants) if (v.h && (!best.has(v.h) || best.get(v.h) < v.bandwidth)) best.set(v.h, v.bandwidth);
    out.heights = [...best].sort((a, b) => b[0] - a[0])
      .map(([hh, bw]) => ({ h: hh, size: h.duration && bw ? Math.round(bw / 8 * h.duration) : 0 }));
  } else {
    out.hasVideo = !source.audio;
  }
  return out;
}

const safeExt = (url, fallback) => (FILE_EXT.exec(url)?.[1] || fallback).toLowerCase();

// -> { tmp, ext } in temp storage, or { url, ext } for a plain file the browser can save directly.
export async function download(req, { mode, quality, audioFormat, audioBitrate, signal, onProgress, title }) {
  const source = sources.get(req.url) || await findSource(req);
  if (mode !== "audio" && source.type === "file") return { url: source.url, ext: safeExt(source.url, "mp4") };
  if (mode === "audio" && source.type === "file" && AUDIO_EXT.test(source.url) && safeExt(source.url) === audioFormat) {
    return { url: source.url, ext: audioFormat };
  }
  const input = urlInput(source.url);
  const out = await tempFile("out");
  try {
    const tags = { title: title || undefined, comment: req.url };
    if (mode === "audio") {
      const kind = AUDIO[audioFormat] ? audioFormat : "mp3";
      await toAudio(input, out.handle, kind, { bitrate: audioBitrate, tags, signal, onProgress });
      return { tmp: out, ext: AUDIO[kind].ext };
    }
    // Video track nearest the chosen quality (short side), from not above it.
    const tracks = await input.getVideoTracks();
    const side = (t) => Math.min(t.displayWidth, t.displayHeight);
    const sorted = tracks.sort((a, b) => side(b) - side(a));
    const pickT = quality ? sorted.find((t) => side(t) <= quality) || sorted.at(-1) : sorted[0];
    await toMp4(input, out.handle, { videoTrack: pickT, tags, signal, onProgress });
    return { tmp: out, ext: "mp4" };
  } catch (e) {
    await removeTemp(out.name);
    throw e;
  } finally {
    input.dispose();
  }
}
