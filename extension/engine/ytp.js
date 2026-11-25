// ytp.js - YouTube stream-URL resolver, JavaScript port of yt.go (see ../MAP.md).
//
// Environment-neutral ES module: runs in Node >= 20, a browser worker or an extension page.
// Everything that differs per environment is injected:
//   fetch   - fetch(url, init) -> Response. Browsers drop forbidden headers (User-Agent, Origin, Cookie):
//             an extension wraps fetch to apply them (declarativeNetRequest / credentials), see README.
//   cache   - async get(key) -> string|null, async set(key, string). Holds player JS + solver script.
//   solver  - from ./solver.js: async solve(pid, loadPlayer, ns, sigs) -> {challenge: answer}.
//
//   const ytp = createYtp({ fetch, cache, solver, cookies });
//   const info = await ytp.resolve("https://youtu.be/...", { order: ["ios", "tv"] });
//   const f = pick(info.formats, "bv");
//   for await (const chunk of ytp.chunks(f)) { ... }

export const ORIGIN = "https://www.youtube.com";
const PLAYER_API = ORIGIN + "/youtubei/v1/player?prettyPrint=false";
const PLAYER_TTL = 6 * 3600 * 1000;

export const CLIENTS = {
  ios: {
    id: 5, cookies: false, js: false,
    ctx: { clientName: "IOS", clientVersion: "20.45.1", deviceMake: "Apple", deviceModel: "iPhone16,2",
      osName: "iPhone", osVersion: "18.6.2.22G100" },
    ua: "com.google.ios.youtube/20.45.1 (iPhone16,2; U; CPU iOS 18_6_2 like Mac OS X;)",
  },
  tv: {
    id: 7, cookies: true, js: true,
    ctx: { clientName: "TVHTML5", clientVersion: "5.20260707", deviceMake: "Samsung", deviceModel: "UKS9800",
      osName: "Tizen", osVersion: "2.4.0" },
    ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
  },
  // Mobile website, signed in: still hands out every format in full where tv answers DRM-only.
  mweb: {
    id: 2, cookies: true, js: true,
    ctx: { clientName: "MWEB", clientVersion: "2.20251105.01.00" },
    ua: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
  },
  android_vr: {
    id: 28, cookies: false, js: false,
    ctx: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3",
      androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
    ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  },
};

export class HttpError extends Error {
  constructor(status) { super(`HTTP Error ${status}`); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------------------------------------------------------------- pure helpers

const VID_RE = /(?:v=|\/shorts\/|\/live\/|\/embed\/|youtu\.be\/|\/v\/)([\w-]{11})/;

export function videoID(s) {
  const m = VID_RE.exec(s);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  throw new Error(`bad url/id: ${s}`);
}

// Raw `a=b; c=d` header or Netscape cookies.txt content -> Cookie header (youtube cookies only).
export function parseCookies(content) {
  const raw = (content || "").trim();
  if (!raw.includes("\t")) return raw;
  const parts = [];
  for (let l of raw.split("\n")) {
    l = l.replace(/\r$/, "");
    if (!l || (l.startsWith("#") && !l.startsWith("#HttpOnly_"))) continue;
    const r = l.split("\t");
    if (r.length >= 7 && r[0].includes("youtube")) parts.push(r[5] + "=" + r[6]);
  }
  return parts.join("; ");
}

function cookieMap(cookie) {
  const c = {};
  for (const p of cookie.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) c[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return c;
}

async function sha1hex(s) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sapisidAuth(cookie) {
  const c = cookieMap(cookie);
  const ts = Math.floor(Date.now() / 1000);
  const out = [];
  for (const [name, key] of [["SAPISIDHASH", "SAPISID"], ["SAPISID1PHASH", "__Secure-1PAPISID"], ["SAPISID3PHASH", "__Secure-3PAPISID"]]) {
    if (c[key] !== undefined) out.push(`${name} ${ts}_${await sha1hex(`${ts} ${c[key]} ${ORIGIN}`)}`);
  }
  return out.join(" ");
}

export function queryParam(u, k) {
  const i = u.indexOf("?");
  return i < 0 ? "" : new URLSearchParams(u.slice(i + 1)).get(k) || "";
}

const CODECS_RE = /codecs="([^"]+)"/;

function norm(f, cl, url) {
  const mime = f.mimeType || "";
  const codecs = CODECS_RE.exec(mime)?.[1] || "";
  const kind = codecs.includes(",") ? "av" : mime.startsWith("audio") ? "audio" : "video";
  const ext = mime.split(";")[0].split("/").pop();
  const int = (v) => (v === undefined ? 0 : parseInt(v, 10) || 0);
  const abr = int(f.averageBitrate ?? f.bitrate);
  const out = {
    itag: int(f.itag), kind, ext, codecs, res: f.qualityLabel || "", width: int(f.width), height: int(f.height),
    fps: f.fps !== undefined ? int(f.fps) : null, bitrate: int(f.bitrate), size: int(f.contentLength),
    abr_kbps: Math.floor((abr + 500) / 1000), lang: null, drc: f.isDrc === true, drm: f.drmFamilies != null,
    url, client: cl, ua: CLIENTS[cl].ua,
    // Byte ranges of the init segment (ftyp+moov) and the segment index (sidx): what MSE playback needs.
    init: f.initRange ? [int(f.initRange.start), int(f.initRange.end)] : null,
    index: f.indexRange ? [int(f.indexRange.start), int(f.indexRange.end)] : null,
  };
  if (f.audioTrack?.displayName) {
    out.lang = f.audioTrack.displayName;
    if (f.audioTrack.audioIsDefault === true) out.audio_default = true;
  }
  return out;
}

export function sizeOf(f) {
  return f.size > 0 ? f.size : parseInt(queryParam(f.url, "clen"), 10) || 0;
}

// sel: "b" best muxed (else best video-only) | "bv" best video-only | "ba" best audio | itag number
export function pick(fmts, sel = "b") {
  const fps = (f) => f.fps || 0;
  let r;
  if (/^\d+$/.test(String(sel))) {
    r = fmts.filter((f) => f.itag === Number(sel));
  } else if (sel === "ba") {
    r = fmts.filter((f) => f.kind === "audio" && !f.drc);
    if (r.some((f) => f.audio_default)) r = r.filter((f) => f.audio_default); // dubbed: keep the original
    r.sort((a, b) => a.bitrate - b.bitrate);
  } else if (sel === "bv") {
    r = fmts.filter((f) => f.kind === "video");
    r.sort((a, b) => a.height - b.height || fps(a) - fps(b) || a.bitrate - b.bitrate);
  } else {
    r = fmts.filter((f) => f.kind === "av");
    if (!r.length) r = fmts.filter((f) => f.kind === "video");
    r.sort((a, b) => a.height - b.height || a.bitrate - b.bitrate);
  }
  if (!r.length) throw new Error(`no format matches ${sel}`);
  return r[r.length - 1];
}

const HOST_RE = /^(https:\/\/rr\d+---)([\w-]+)(\.googlevideo\.com\/.*)$/;

// The same URL on each cache node listed in mn= (what the official player does on failure).
export function mirrors(u) {
  const m = HOST_RE.exec(u);
  const mn = queryParam(u, "mn").split(",");
  if (!m || !mn[0]) return [u];
  const out = [u];
  mn.forEach((node, i) => { if (node !== m[2]) out.push(`${m[1]}${node}${m[3]}&fallback_count=${i + 1}`); });
  return out;
}

export function memoryCache() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); } };
}

// ---------------------------------------------------------------- resolver

export function createYtp({ fetch: fetchFn = globalThis.fetch.bind(globalThis), cache = memoryCache(), solver,
  cookies = "", log = () => {} } = {}) {
  let cookie = parseCookies(cookies);
  let playerPromise = null; // single-flight playerInfo()

  // GET/POST returning the Response (2xx) or throwing HttpError / network error / AbortError.
  async function open(method, url, { body, headers = {}, timeout = 15000, signal } = {}) {
    const t = AbortSignal.timeout(timeout);
    const resp = await fetchFn(url, { method, body, headers, signal: signal ? AbortSignal.any([signal, t]) : t });
    if (resp.status >= 300) {
      resp.body?.cancel?.().catch(() => {});
      throw new HttpError(resp.status);
    }
    return resp;
  }

  // {id, sts}: id from the tiny iframe_api script, sts from the TV player JS. Cached 6 h.
  function playerInfo() {
    if (!playerPromise) playerPromise = loadPlayerInfo().finally(() => { playerPromise = null; });
    return playerPromise;
  }

  async function loadPlayerInfo() {
    try {
      const p = JSON.parse((await cache.get("player.json")) || "null");
      if (p?.id && p.sts && Date.now() - p.ts * 1000 < PLAYER_TTL) return p;
    } catch {}
    const api = await (await open("GET", ORIGIN + "/iframe_api")).text();
    const pid = /player\\?\/([0-9a-f]{8})\\?\//.exec(api)?.[1];
    if (!pid) throw new Error("player id not found in iframe_api");
    const js = await playerJS(pid);
    const sts = /(?:signatureTimestamp|sts)\s*:\s*(\d{5})/.exec(js)?.[1];
    if (!sts) throw new Error("sts not found in player");
    const p = { id: pid, sts: Number(sts), ts: Date.now() / 1000 };
    await cache.set("player.json", JSON.stringify(p));
    return p;
  }

  async function playerJS(pid) {
    let js = await cache.get(`${pid}.tv.js`);
    if (!js) {
      js = await (await open("GET", `${ORIGIN}/s/player/${pid}/tv-player-ias.vflset/tv-player-ias.js`, { timeout: 30000 })).text();
      await cache.set(`${pid}.tv.js`, js);
    }
    return js;
  }

  async function player(vid, cl, sts, pyv, signal) {
    const c = CLIENTS[cl];
    const body = { context: { client: { hl: "en", gl: "US", ...c.ctx } }, videoId: vid, contentCheckOk: true, racyCheckOk: true };
    if (sts) {
      const pc = { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS", signatureTimestamp: sts } };
      // Skips the pre-roll ad gate (~3 s of 403) but yields preview-only URLs on some videos -> see extract().
      if (pyv) pc.adPlaybackContext = { pyv: true };
      body.playbackContext = pc;
    }
    const h = { "Content-Type": "application/json", "User-Agent": c.ua, Origin: ORIGIN,
      "X-YouTube-Client-Name": String(c.id), "X-YouTube-Client-Version": c.ctx.clientVersion };
    if (cookie && c.cookies) {
      h.Cookie = cookie;
      h.Authorization = await sapisidAuth(cookie);
      h["X-Origin"] = ORIGIN;
      h["X-Goog-AuthUser"] = "0";
    }
    try {
      const resp = await open("POST", PLAYER_API, { body: JSON.stringify(body), headers: h, signal });
      try { return await resp.json(); } catch { return { playabilityStatus: { status: "BAD_JSON" } }; }
    } catch (e) {
      if (e instanceof HttpError) return { playabilityStatus: { status: `HTTP_${e.status}` } };
      return { playabilityStatus: { status: "ERROR", reason: String(e.message || e) } };
    }
  }

  // 1 = served, 0 = refused (403), -1 = no answer (timeout / network)
  async function probeRange(f, a, signal) {
    try {
      const r = await open("GET", `${f.url}&range=${a}-${a + 1023}`, { headers: { "User-Agent": f.ua }, timeout: 4000, signal });
      await r.arrayBuffer();
      return 1;
    } catch (e) {
      return e instanceof HttpError && e.status === 403 ? 0 : -1;
    }
  }

  // Checks the best video + best audio: first and last KiB of each. "full" | "preview" (start ok, end 403:
  // URLs stop after ~60 s) | "gated" (all 403 for `wait` ms: ad gate / refused).
  async function streamState(fmts, wait, signal) {
    const targets = [];
    for (const sel of ["bv", "ba"]) {
      try { const f = pick(fmts, sel); if (sizeOf(f) > 1024) targets.push(f); } catch {}
    }
    if (!targets.length) return "full";
    const deadline = Date.now() + wait;
    let gated = false, recheck = false;
    for (let attempt = 0; ; attempt++) {
      const res = await Promise.all(targets.flatMap((f) => [probeRange(f, 0, signal), probeRange(f, sizeOf(f) - 1024, signal)]));
      let full = true, preview = false, unknown = false;
      targets.forEach((_, i) => {
        const [start, end] = [res[2 * i], res[2 * i + 1]];
        full &&= end === 1;
        preview ||= start === 1 && end === 0;
        unknown ||= start === -1 || end === -1;
      });
      if (signal?.aborted) return "full";
      if (full) return "full";
      if (preview && gated && !recheck) { recheck = true; await sleep(300); continue; } // gate opening per request
      if (preview) return "preview";
      if (unknown && attempt < 2) continue;
      if (unknown) return "full"; // can't tell; keep URLs that may well work
      if (Date.now() > deadline) return "gated";
      gated = true;
      await sleep(300);
    }
  }

  async function extract(vid, cl, tm, pyv, probe, signal) {
    const c = CLIENTS[cl];
    let pm = { id: "", sts: 0 };
    if (c.js) {
      const t0 = now();
      try { pm = await playerInfo(); } catch (e) { return [null, "player info: " + e.message]; }
      tm.since("player_info", t0);
    }
    const key = "player_" + cl + (pyv ? "" : "_nopyv");
    let t0 = now();
    const p = await player(vid, cl, pm.sts, pyv, signal);
    tm.since(key, t0);
    const ps = p.playabilityStatus || {}, sd = p.streamingData || {}, d = p.videoDetails || {};
    if (d.title) tm.setMeta(d.title, d.author || ""); // tv sends none: share across clients
    let status = (ps.status || "") + (ps.reason ? ` (${ps.reason})` : "");
    if (c.cookies) {
      let li = false;
      for (const x of p.responseContext?.serviceTrackingParams || [])
        for (const y of x.params || []) if (y.key === "logged_in") li = y.value === "1";
      tm.m.logged_in = li;
      if (!li) status += " [cookies NOT logged in - re-export cookies]";
    }
    const raw = [];
    for (const f of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
      if (f.drmFamilies != null) continue;
      const r = { f, url: f.url || "", s: "", sp: "" };
      if (!r.url) {
        const q = new URLSearchParams(f.signatureCipher || "");
        r.url = q.get("url") || ""; r.s = q.get("s") || ""; r.sp = q.get("sp") || "signature";
      }
      if (r.url) { r.n = queryParam(r.url, "n"); raw.push(r); }
    }
    if (ps.status !== "OK" || !raw.length) return [null, status];

    let fmts;
    if (c.js) {
      const ns = [...new Set(raw.map((r) => r.n).filter(Boolean))].sort();
      const sigs = [...new Set(raw.map((r) => r.s).filter(Boolean))].sort();
      t0 = now();
      let ans;
      try { ans = await solver.solve(pm.id, () => playerJS(pm.id), ns, sigs); } catch (e) { return [null, "solver: " + (e.message || e)]; }
      tm.since("solve", t0);
      fmts = raw.map((r) => {
        let u = r.url;
        if (r.n) u = u.replace(/([?&])n=[^&]+/, (_, p1) => `${p1}n=${encodeURIComponent(ans[r.n])}`);
        if (r.s) u += `&${r.sp}=${encodeURIComponent(ans[r.s])}`;
        return norm(r.f, cl, u);
      });
    } else {
      fmts = raw.map((r) => norm(r.f, cl, r.url));
    }
    if (c.js && pyv && d.isLive === true) return extract(vid, cl, tm, false, probe, signal); // live + pyv: 403 for good
    if (probe) {
      const wait = !c.js ? 0 : pyv ? 1200 : 9000;
      t0 = now();
      const st = await streamState(fmts, wait, signal);
      tm.since(key + "_probe", t0);
      if (st === "preview" && c.js && pyv) return extract(vid, cl, tm, false, probe, signal);
      if (st === "preview") return [null, status + " [preview-only URLs: 403 after ~60 s]"];
      if (st === "gated" && (!c.js || !pyv)) return [null, status + " [stream URLs refused (403)]"];
    }
    const info = {
      id: vid, title: d.title || null, author: d.author || null, duration: parseInt(d.lengthSeconds, 10) || 0,
      live: d.isLive === true, client: cl, player: pm.id || null,
      thumbnail: d.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, hls: sd.hlsManifestUrl || null,
      expires_in: parseInt(sd.expiresInSeconds, 10) || 0, formats: fmts,
    };
    return [info, status];
  }

  async function oembed(vid) {
    try {
      const u = `${ORIGIN}/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + vid)}`;
      const o = await (await open("GET", u, { timeout: 3000 })).json();
      return [o.title || "", o.author_name || ""];
    } catch { return ["", ""]; }
  }

  // All clients run in parallel; the first OK one in `order` wins.
  //   order:  client preference, default ["ios", "tv"]
  //   probe:  false skips the preview check (answers sooner; re-resolve in the background, and if that answer's
  //           client differs or timing has "player_tv_nopyv", the first URLs were a ~60 s preview)
  //   mweb:   false keeps the signed-in mobile-web client out
  async function resolve(urlOrId, { order = ["ios", "tv"], probe = true, mweb = true } = {}) {
    const vid = videoID(urlOrId);
    if (mweb && cookie && order.length > 1 && !order.includes("mweb")) order = order.flatMap((c) => (c === "tv" ? ["mweb", c] : [c]));
    const use = order.filter((cl) => CLIENTS[cl] && (cookie || !CLIENTS[cl].cookies));
    const t0 = now();
    const tm = {
      m: {}, title: "", author: "",
      since(k, t) { this.m[k] = Math.round(now() - t) / 1000; },
      setMeta(t, a) { if (!this.title) { this.title = t; this.author = a; } },
    };
    const meta = use.some((cl) => CLIENTS[cl].js) ? oembed(vid) : null;
    // Losing clients are cancelled once the answer is known (no stray probes / requests).
    const ac = new AbortController();
    const runs = use.map((cl) => extract(vid, cl, tm, true, probe, ac.signal).catch((e) => [null, `error: ${e.message || e}`]));
    const tried = [];
    for (let i = 0; i < use.length; i++) {
      let timer;
      const [info, status] = await Promise.race([runs[i], new Promise((r) => { timer = setTimeout(() => r([null, "timeout"]), 60000); })]);
      clearTimeout(timer);
      tried.push(`${use[i]}: ${status}`);
      if (!info) continue;
      if (!info.title) {
        let [title, author] = [tm.title, tm.author];
        if (!title && meta) [title, author] = await Promise.race([meta, sleep(3000).then(() => ["", ""])]);
        info.title = title || null;
        info.author = author || null;
      }
      tm.m.total = Math.round(now() - t0) / 1000;
      ac.abort();
      return { ...info, tried, timing: { ...tm.m } };
    }
    tm.m.total = Math.round(now() - t0) / 1000;
    ac.abort();
    return { id: vid, error: "no playable streams", tried, timing: tm.m, formats: [] };
  }

  // Yields the format's bytes in &range chunks (<= 10 MiB, no throttling), from byte `start` (resume),
  // failing over to mirror nodes. onProgress(pos, size) after each chunk. `parallel` > 1 keeps that many
  // ranges in flight (helps only when one connection can't fill the line; no gain measured on a ~8 MB/s link).
  // `signal` cancels the download.
  async function* chunks(f, { start = 0, chunkSize = 10 << 20, parallel = 1, timeout = 60000, onProgress, signal } = {}) {
    let urls = mirrors(f.url);
    let size = sizeOf(f);
    if (!size) {
      const r = await open("HEAD", f.url, { headers: { "User-Agent": f.ua }, signal });
      size = parseInt(r.headers.get("content-length"), 10) || 0;
    }
    const ac = new AbortController(); // stops the other in-flight chunks on failure / early break / cancel
    const stop = () => ac.abort(signal.reason);
    signal?.addEventListener("abort", stop, { once: true });
    const fetchRange = async (a, b) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await open("GET", `${urls[0]}&range=${a}-${b}`, { headers: { "User-Agent": f.ua }, timeout, signal: ac.signal });
          const data = new Uint8Array(await r.arrayBuffer());
          if (data.length !== b - a + 1) throw new Error(`short read ${data.length}/${b - a + 1}`);
          return data;
        } catch (e) {
          if (ac.signal.aborted || (e instanceof HttpError && e.status === 403) || attempt === 2 * urls.length - 1) throw e;
          urls = [...urls.slice(1), urls[0]]; // node unreachable/timeout -> next mirror
        }
      }
    };
    // `parallel` ranges in flight, yielded in order: one connection rarely fills the line.
    const queue = [];
    let next = start, pos = start;
    const fill = () => {
      while (queue.length < parallel && next < size) {
        const end = Math.min(next + chunkSize, size) - 1;
        const p = fetchRange(next, end);
        p.catch(() => {}); // awaited below; avoid unhandled rejections for chunks never reached
        queue.push(p);
        next = end + 1;
      }
    };
    try {
      for (fill(); queue.length; fill()) {
        const data = await queue.shift();
        pos += data.length;
        yield data;
        onProgress?.(pos, size);
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      ac.abort();
    }
  }

  return {
    resolve, chunks, playerInfo,
    setCookies(c) { cookie = parseCookies(c); },
    // Fetch the player and build the solver ahead of the first gated video.
    async warmup() {
      const p = await playerInfo();
      await solver?.solve(p.id, () => playerJS(p.id), [], []);
      return p;
    },
  };
}
