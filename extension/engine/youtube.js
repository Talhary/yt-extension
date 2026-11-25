// YouTube / YouTube Music: video info, playlist + Mix listing, and downloading one video.
import { createYtp, CLIENTS, ORIGIN, sapisidAuth, sizeOf, videoID } from "./ytp.js";

export { videoID };
import { createSolverClient } from "./solver-client.js";
import { kv, tempFile, removeTemp } from "./store.js";
import { AUDIO, coverImage, fileInput, mux, toAudio } from "./media.js";

// Requests the browser won't let us dress up (User-Agent, Origin, Cookie are forbidden headers) carry a
// `ytpc=<client>` marker; background.js has declarativeNetRequest rules that set those headers for it.
const UA_CLIENT = Object.fromEntries(Object.entries(CLIENTS).map(([name, c]) => [c.ua, name]));
const FORBIDDEN = ["user-agent", "origin", "cookie"];

export function ytFetch(url, init = {}, client) {
  const headers = {};
  let cl = client;
  for (const [k, v] of Object.entries(init.headers || {})) {
    if (k.toLowerCase() === "user-agent") cl ??= UA_CLIENT[v];
    if (!FORBIDDEN.includes(k.toLowerCase())) headers[k] = v;
  }
  if (cl) url += (url.includes("?") ? "&" : "?") + "ytpc=" + cl;
  return fetch(url, { ...init, headers, credentials: "omit" });
}

const ytp = createYtp({ fetch: ytFetch, cache: kv, solver: createSolverClient(), log: (m) => console.log("[ytp]", m) });
let cookie = "";
export function useCookies(c) { cookie = c || ""; ytp.setCookies(cookie); }
export const warmup = () => ytp.warmup().catch((e) => console.warn("[ytp] warmup", e));

const why = (info) => {
  // The most telling reason: the logged-in clients' when there are cookies, else the first.
  const reasons = info.tried.map((t) => t.replace(/^[a-z_]+: /, ""));
  const r = reasons.find((x) => /sign in|login|private|age|inappropriate|unavailable|removed|copyright/i.test(x)) || reasons[0] || info.error;
  return r.replace(/^[A-Z_]+ \((.*)\)(.*)$/, "$1$2").trim() || "No playable streams";
};

// ---------------------------------------------------------------- format choice

const shortSide = (f) => (f.width && f.height ? Math.min(f.width, f.height) : f.height);
const CODEC_RANK = (f) => (/^avc1/.test(f.codecs) ? 0 : /^vp0?9/.test(f.codecs) ? 1 : /^av01/.test(f.codecs) ? 2 : 3);

// Best video-only stream at or below `quality` (short side), preferring H.264 at each size like the old
// helper did (`-S res:Q,vcodec:h264`). quality 0 = best available.
export function pickVideo(fmts, quality) {
  const vids = fmts.filter((f) => f.kind === "video" && !f.drm);
  if (!vids.length) return null;
  const sizes = [...new Set(vids.map(shortSide))].sort((a, b) => b - a);
  const target = quality ? sizes.find((s) => s <= quality) ?? sizes.at(-1) : sizes[0];
  return vids.filter((f) => shortSide(f) === target)
    .sort((a, b) => CODEC_RANK(a) - CODEC_RANK(b) || (b.fps || 0) - (a.fps || 0) || b.bitrate - a.bitrate)[0];
}

// Best audio, original language over dubs; `codec` "aac" | "opus" preferred when present.
export function pickAudio(fmts, codec) {
  let a = fmts.filter((f) => f.kind === "audio" && !f.drc && !f.drm);
  if (!a.length) a = fmts.filter((f) => f.kind === "audio");
  if (a.some((f) => f.audio_default)) a = a.filter((f) => f.audio_default);
  const want = codec === "aac" ? /^mp4a/ : codec === "opus" ? /^opus/ : null;
  if (want && a.some((f) => want.test(f.codecs))) a = a.filter((f) => want.test(f.codecs));
  return a.sort((x, y) => y.bitrate - x.bitrate)[0] || null;
}

// ---------------------------------------------------------------- info (quality picker)

export async function info(url) {
  const r = await ytp.resolve(videoID(url), { probe: false }); // fast; downloads resolve again with checks
  if (r.error) throw new Error(why(r));
  const audio = pickAudio(r.formats, "aac");
  const audioSize = audio ? sizeOf(audio) : 0;
  const sizes = [...new Set(r.formats.filter((f) => f.kind === "video").map(shortSide))].filter((h) => h >= 144);
  const heights = sizes.sort((a, b) => b - a).map((h) => {
    const v = pickVideo(r.formats, h);
    return { h, size: v && sizeOf(v) ? sizeOf(v) + audioSize : 0 };
  });
  return {
    kind: "video", title: r.title, uploader: r.author, duration: r.duration, thumbnail: r.thumbnail,
    audioSize, hasVideo: heights.length > 0 || r.formats.some((f) => f.kind === "av"), heights,
  };
}

// ---------------------------------------------------------------- ad-free playback (player.js)

// Streams the page can play itself with MediaSource: fragmented MP4 (H.264 or AV1, + AAC) with a segment
// index. quality = max short side (0 = best); at each size H.264 wins (cheapest to decode). Clients answer
// differently (signed-in mweb/tv can lack such streams), so when the first answer has none the others are
// asked. Last resort: the muxed 360p MP4, played as a plain file. Live streams return an error, and the
// page then keeps YouTube's own player. No probe by default (fast start); the page asks again with probe
// when a link is refused.
const canPlay = (mime) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
const mseMime = (f) => `${f.kind}/mp4; codecs="${f.codecs}"`;

function choosePlayable(r, quality) {
  const fmts = r.formats.filter((f) => f.ext === "mp4" && f.init && f.index && !f.drm && canPlay(mseMime(f)));
  const v = pickVideo(fmts, quality), a = pickAudio(fmts, "aac");
  const out = (f) => ({ url: f.url, client: f.client, mime: mseMime(f), init: f.init, index: f.index,
    size: sizeOf(f), height: f.height });
  if (v && a) return { video: out(v), audio: out(a) };
  const m = r.formats.filter((f) => f.kind === "av" && f.ext === "mp4" && !f.drm).sort((x, y) => y.height - x.height)[0];
  return m ? { progressive: { url: m.url, client: m.client, height: m.height } } : null;
}

const describe = (r) => {
  const n = (k) => r.formats.filter((f) => f.kind === k).length;
  return `${r.client}: ${n("video")} video, ${n("audio")} audio, ${n("av")} muxed`;
};

export async function playable(url, quality = 1080, probe = false) {
  const vid = videoID(url);
  let r = await ytp.resolve(vid, { probe });
  if (r.error) throw new Error(why(r));
  if (r.live) throw new Error("Live stream");
  let pick = choosePlayable(r, quality);
  const tried = new Set([r.client]), notes = [describe(r)];
  // Only a muxed file (or nothing): another client may have the real streams.
  for (const cl of ["ios", "tv", "mweb"]) {
    if (pick && !pick.progressive) break;
    if (tried.has(cl)) continue;
    tried.add(cl);
    const r2 = await ytp.resolve(vid, { order: [cl], probe }).catch((e) => ({ error: e.message, tried: [] }));
    if (r2.error) { notes.push(`${cl}: ${r2.tried.length ? why(r2) : r2.error}`); continue; }
    notes.push(describe(r2));
    const p2 = choosePlayable(r2, quality);
    if (p2 && (!pick || !p2.progressive)) { r = r2; pick = p2; }
  }
  if (pick?.progressive) console.warn("[play] only a muxed stream:", notes.join("; "));
  if (!pick) throw new Error(`No playable streams (${notes.join("; ")})`);
  return { title: r.title, duration: r.duration, ...pick };
}

// ---------------------------------------------------------------- playlists

const WEB = { clientName: "WEB", clientVersion: "2.20251118.01.00", hl: "en", gl: "US" };

async function innertube(endpoint, body) {
  const headers = { "Content-Type": "application/json", "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": WEB.clientVersion };
  if (cookie) Object.assign(headers, { Authorization: await sapisidAuth(cookie), "X-Origin": ORIGIN, "X-Goog-AuthUser": "0" });
  const r = await ytFetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`,
    { method: "POST", headers, body: JSON.stringify({ context: { client: WEB }, ...body }), signal: AbortSignal.timeout(20000) }, "web");
  if (!r.ok) throw new Error(`YouTube answered HTTP ${r.status}`);
  return r.json();
}

const text = (t) => t?.content ?? t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";
const seconds = (s) => (/^\d+(:\d+)+$/.test(s || "") ? s.split(":").reduce((a, x) => a * 60 + Number(x), 0) : null);

// Videos (in order) and the next continuation token anywhere under `root`.
function scan(root) {
  const items = [];
  let token = null;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const l = o.lockupViewModel;
      const badges = [];
      const find = (x) => { if (x && typeof x === "object") for (const k in x) k === "thumbnailBadgeViewModel" ? badges.push(x[k].text) : find(x[k]); };
      find(l.contentImage);
      items.push({ id: l.contentId, title: text(l.metadata?.lockupMetadataViewModel?.title), duration: seconds(badges.find((b) => seconds(b) != null)) });
      return;
    }
    const pv = o.playlistVideoRenderer || o.playlistPanelVideoRenderer;
    if (pv?.videoId) {
      items.push({ id: pv.videoId, title: text(pv.title), duration: pv.lengthSeconds ? Number(pv.lengthSeconds) : seconds(text(pv.lengthText)) });
      return;
    }
    if ((o.continuationItemViewModel || o.continuationItemRenderer) && !token) {
      const c = JSON.stringify(o);
      token = /"token":"([^"]+)"/.exec(c)?.[1] || null;
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(root);
  return { items, token };
}

// url: a /playlist?list=, /watch?v=..&list= or music.youtube.com link. Mixes ("RD...") have no playlist page:
// they're read from the watch page's queue, a page at a time.
export async function list(url) {
  const u = new URL(url);
  const id = u.searchParams.get("list");
  if (!id) throw new Error("No playlist in this link");
  const entries = [];
  const seen = new Set();
  const add = (items) => {
    let n = 0;
    for (const it of items) {
      if (!it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      entries.push({ index: entries.length + 1, id: it.id, title: it.title || it.id, duration: it.duration });
      n++;
    }
    return n;
  };
  let title = "";
  if (id.startsWith("RD")) {
    let v = u.searchParams.get("v") || /^RD(?:AMVM|MM|EM)?([\w-]{11})$/.exec(id)?.[1];
    for (let page = 0; page < 5 && v && entries.length < 100; page++) { // a Mix never ends; ~4 s for 100
      const r = await innertube("next", { videoId: v, playlistId: id });
      const pl = r.contents?.twoColumnWatchNextResults?.playlist?.playlist;
      if (!pl) break;
      title ||= text(pl.titleText) || pl.title || "Mix";
      if (!add(scan(pl.contents).items)) break;
      v = entries.at(-1).id;
    }
    if (!entries.length) throw new Error("This Mix couldn't be loaded");
    return { kind: "playlist", title: title || "Mix", entries };
  }
  let r = await innertube("browse", { browseId: "VL" + id });
  const alert = r.alerts?.map((a) => text(a.alertRenderer?.text || a.alertWithButtonRenderer?.text)).find(Boolean);
  title = r.header?.pageHeaderRenderer?.pageTitle || r.metadata?.playlistMetadataRenderer?.title
    || r.microformat?.microformatDataRenderer?.title || { LL: "Liked videos", WL: "Watch later" }[id] || "Playlist";
  let { items, token } = scan(r.contents);
  add(items);
  for (let page = 0; token && page < 100; page++) {
    r = await innertube("browse", { continuation: token });
    ({ items, token } = scan(r.onResponseReceivedActions));
    if (!add(items)) break;
  }
  if (!entries.length) throw new Error(alert || "This playlist is empty, private, or unavailable");
  return { kind: "playlist", title, entries };
}

// ---------------------------------------------------------------- download one video

// Downloads one stream to a temp file through ytp's chunked fetcher (mirror failover, no throttling).
async function fetchStream(f, signal, onBytes) {
  const tmp = await tempFile(f.ext);
  const w = await tmp.handle.createWritable();
  try {
    for await (const chunk of ytp.chunks(f, { signal })) {
      if (signal.aborted) throw signal.reason;
      await w.write(chunk);
      onBytes(chunk.length);
    }
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    await removeTemp(tmp.name);
    throw signal.aborted ? signal.reason : e;
  }
  return tmp;
}

// -> { tmp, ext, title } : the finished file in temp storage. opts: mode, quality, audioFormat, audioBitrate,
// signal, onProgress(0..1), album/track tags for playlists.
export async function downloadVideo(vid, opts) {
  const { signal, onProgress = () => {} } = opts;
  const r = await ytp.resolve(vid, { probe: true });
  if (r.error) throw new Error(why(r));
  if (r.live) throw new Error("Live streams can't be downloaded while they're live");
  const title = r.title || vid;
  const temps = [];
  try {
    let streams, finish;
    const tags = { title, artist: r.author || undefined, comment: `https://www.youtube.com/watch?v=${vid}`, ...opts.tags };
    if (opts.mode === "audio") {
      const kind = AUDIO[opts.audioFormat] ? opts.audioFormat : "mp3";
      const a = pickAudio(r.formats, kind === "m4a" ? "aac" : kind === "opus" ? "opus" : null);
      if (!a) throw new Error("No audio stream");
      streams = [a];
      finish = async ([src], out, onP) => {
        const cover = kind === "opus" ? null : await coverImage([`https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`, r.thumbnail]);
        const input = fileInput(await src.handle.getFile());
        try {
          await toAudio(input, out, kind, { bitrate: opts.audioBitrate, tags: { ...tags, images: cover ? [cover] : undefined }, signal, onProgress: onP });
        } finally { input.dispose(); }
        return AUDIO[kind].ext;
      };
    } else {
      const v = pickVideo(r.formats, opts.quality);
      const a = pickAudio(r.formats, "aac");
      if (v && a) {
        streams = [v, a];
        finish = async ([vs, as], out, onP) => {
          await mux(await vs.handle.getFile(), await as.handle.getFile(), out, { tags, signal, onProgress: onP });
          return "mp4";
        };
      } else { // only a muxed stream (rare): save it as it is
        const m = r.formats.filter((f) => f.kind === "av").sort((x, y) => y.height - x.height)[0];
        if (!m) throw new Error("No video stream");
        streams = [m];
        finish = null;
      }
    }
    // Download (90 % of the bar), then mux / convert (10 %).
    const total = streams.reduce((s, f) => s + (sizeOf(f) || 1), 0);
    let got = 0;
    const settled = await Promise.allSettled(streams.map((f) => fetchStream(f, signal, (n) => { got += n; onProgress(0.9 * Math.min(got / total, 1)); })));
    const files = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);
    const failed = settled.find((x) => x.status === "rejected");
    if (failed) { temps.push(...files); throw failed.reason; }
    if (!finish) return { tmp: files[0], ext: streams[0].ext, title };
    temps.push(...files);
    const out = await tempFile("out");
    temps.push(out);
    const ext = await finish(files, out.handle, (p) => onProgress(0.9 + 0.1 * p));
    temps.pop(); // keep the result
    return { tmp: out, ext, title };
  } finally {
    for (const t of temps) await removeTemp(t.name);
  }
}
