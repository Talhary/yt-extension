// Ad-free player for youtube.com/watch pages (option "Play YouTube videos without ads").
//
// YouTube's own player is left alone until it starts an ad (#movie_player gets the "ad-showing" class).
// Then we put our own <video> over it, from where the video was, and stream the video and audio straight
// from googlevideo with MediaSource, using the stream URLs the engine resolves (the same ones it
// downloads). YouTube's player stays on the page, paused and hidden, for the rest of that video. If
// anything fails (live stream, no MP4 streams, network), YouTube's player comes back for that video.
//
// The streams are fragmented MP4: an init segment (ftyp+moov), then a segment index (sidx) that maps
// time -> byte ranges. We buffer ~30 s ahead in &range requests, and seeking just starts from another
// segment. Requests carry ytpc=<client> so background.js sets the User-Agent the URLs were issued for.
(() => {
  if (location.hostname !== "www.youtube.com" || window.top !== window) return;

  const AHEAD = 30;          // seconds buffered ahead of the playhead
  const BEHIND = 30;         // seconds kept behind it (the rest is freed)
  const MAX_REQ = 4 << 20;   // bytes per range request
  const LOW = 6;             // seconds ahead below which we fetch one segment at a time (fast start / seek)
  const PREFETCH_TTL = 4 * 3600 * 1000; // stream links last ~6 h
  const QUALITY = 1080;      // max short side (H.264 tops out here on YouTube)

  let enabled = null;        // null until the setting is read
  let cur = null;            // the session for the current video
  const skip = new Set();    // videos left to YouTube's player (failed, or the user switched back)
  let pos = { vid: null, t: 0, since: 0 }; // where YouTube's player is in the video (not in an ad)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = (type, payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => resolve(
        chrome.runtime.lastError ? { ok: false, error: "Extension was updated – refresh this page" }
          : res || { ok: false, error: "No response from the extension" }));
    } catch {
      resolve({ ok: false, error: "Extension was updated – refresh this page" });
    }
  });

  // ---------------------------------------------------------------- streams

  // Segments listed in the sidx box at `at` in `buf` (whose first byte is file offset 0).
  function parseSidx(buf, at) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const size = dv.getUint32(at);
    if (String.fromCharCode(...buf.subarray(at + 4, at + 8)) !== "sidx") throw new Error("No segment index");
    const v = buf[at + 8];
    // size, "sidx", version+flags, reference_ID, then timescale at +16
    const scale = dv.getUint32(at + 16) || 1;
    let q = at + 20;
    let t, first;
    if (v === 0) { t = dv.getUint32(q); first = dv.getUint32(q + 4); q += 8; }
    else { t = Number(dv.getBigUint64(q)); first = Number(dv.getBigUint64(q + 8)); q += 16; }
    const count = dv.getUint16(q + 2);
    q += 4;
    let pos = at + size + first;
    const segs = [];
    for (let i = 0; i < count; i++, q += 12) {
      const bytes = dv.getUint32(q) & 0x7fffffff, dur = dv.getUint32(q + 4);
      segs.push({ a: pos, b: pos + bytes - 1, t0: t / scale, t1: (t + dur) / scale });
      pos += bytes;
      t += dur;
    }
    if (!segs.length) throw new Error("Empty segment index");
    return segs;
  }

  async function getRange(f, a, b, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${f.url}&ytpc=${f.client}&range=${a}-${b}`, { credentials: "omit", signal });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const data = new Uint8Array(await r.arrayBuffer());
        if (data.length !== b - a + 1) throw new Error("Short read");
        return data;
      } catch (e) {
        if (signal.aborted || e.status === 403 || attempt === 2) throw e;
        await sleep(700 * (attempt + 1));
      }
    }
  }

  // Runs one SourceBuffer operation and waits for it to finish.
  function sbDo(sb, fn) {
    return new Promise((resolve, reject) => {
      const off = () => { sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad); };
      const ok = () => { off(); resolve(); };
      const bad = () => { off(); reject(new Error("The browser couldn't decode the stream")); };
      sb.addEventListener("updateend", ok);
      sb.addEventListener("error", bad);
      try { fn(); } catch (e) { off(); reject(e); }
    });
  }

  // End of the buffered range that contains t (t itself if none does).
  function bufEnd(sb, t) {
    const b = sb.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) > t) return b.end(i);
    return t;
  }

  // ---------------------------------------------------------------- prefetch

  // Stream links and headers (init segment + segment index) for a video, fetched as soon as its page
  // opens, so that taking over from an ad only has to download the first segments.
  const pre = new Map(); // vid -> { time, promise }

  function prefetch(vid) {
    const hit = pre.get(vid);
    if (hit && Date.now() - hit.time < PREFETCH_TTL) return hit.promise;
    const promise = (async () => {
      const res = await call("play", { url: `https://www.youtube.com/watch?v=${vid}` });
      if (!res.ok) throw new Error(res.error);
      const signal = AbortSignal.timeout(20000);
      if (!res.progressive) res.heads = await Promise.all([res.video, res.audio].map((f) => getRange(f, 0, f.index[1], signal)));
      return res;
    })();
    promise.catch(() => {});
    pre.set(vid, { time: Date.now(), promise });
    for (const k of [...pre.keys()].slice(0, -5)) pre.delete(k); // keep the last few
    return promise;
  }

  // ---------------------------------------------------------------- session

  async function start(vid, at) {
    const s = { vid, at, ac: new AbortController(), tracks: [], errors: 0, suppress: true };
    cur = s;
    pauseYouTube();
    try {
      const info = prefetch(vid);
      await mountOverlay(s);
      let res;
      try { res = await info; } catch (e) {
        pre.delete(vid); // a failed prefetch (e.g. network blip) gets one fresh try
        res = await prefetch(vid);
      }
      if (cur !== s) return;
      s.info = res;
      await mountStreams(s);
    } catch (e) {
      if (cur === s && !s.ac.signal.aborted) fail(s, e.message || String(e));
    }
  }

  function stop(s, { resumeYouTube = false } = {}) {
    if (cur === s) cur = null;
    s.ac.abort();
    clearInterval(s.timer);
    if (s.video) { s.video.pause(); s.video.removeAttribute("src"); s.video.load(); }
    if (s.objUrl) URL.revokeObjectURL(s.objUrl);
    s.wrap?.remove();
    if (resumeYouTube) {
      const yv = ytVideo();
      if (yv) {
        if (s.video?.currentTime > 1 && !inAd()) yv.currentTime = s.video.currentTime;
        yv.play().catch(() => {});
      }
    }
  }

  // Back to YouTube's player for this video.
  function fail(s, why) {
    console.warn("[ytdl] ad-free player:", why);
    skip.add(s.vid);
    stop(s, { resumeYouTube: true });
    if (!/^Live stream$/.test(why)) notice(`Ad-free player unavailable: ${why}`);
  }

  async function mountOverlay(s) {
    let host = null;
    for (let i = 0; i < 100 && !(host = document.querySelector("#movie_player")); i++) await sleep(100);
    if (!host || cur !== s) throw new Error("YouTube's player wasn't found");
    s.host = host;
    const wrap = s.wrap = document.createElement("div");
    wrap.className = "ytdl-cp loading";
    wrap.innerHTML = `<video playsinline></video><div class="ytdl-cp-spin" role="progressbar" aria-label="Loading"></div>
      <button class="ytdl-cp-yt" title="Use YouTube's own player for this video">YouTube player</button>`;
    // Keep YouTube's player (underneath) from reacting to clicks, drags and wheel on ours.
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "mousemove",
      "mouseover", "mouseout", "wheel", "contextmenu", "touchstart", "touchend"]) {
      wrap.addEventListener(ev, (e) => e.stopPropagation());
    }
    wrap.querySelector(".ytdl-cp-yt").addEventListener("click", () => { skip.add(s.vid); stop(s, { resumeYouTube: true }); });
    s.video = wrap.querySelector("video");
    host.append(wrap);
  }

  async function mountStreams(s) {
    const { video: vf, audio: af, duration, progressive } = s.info;
    const v = s.video;
    if (progressive) {
      // Only a muxed 360p file was available: the browser plays it as it is (with Range requests).
      v.src = `${progressive.url}&ytpc=${progressive.client}`;
      v.addEventListener("error", () => { if (cur === s) fail(s, "The stream couldn't be loaded"); }, { once: true });
      notice("Ad-free player: only 360p is available for this video");
      return setupVideo(s);
    }
    for (const f of [vf, af]) if (!MediaSource.isTypeSupported(f.mime)) throw new Error(`Unsupported format ${f.mime}`);
    const heads = s.info.heads;
    const ms = s.ms = new MediaSource();
    s.objUrl = URL.createObjectURL(ms);
    v.src = s.objUrl;
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    if (cur !== s) return;
    s.tracks = [vf, af].map((f, i) => ({ f, sb: ms.addSourceBuffer(f.mime), segs: parseSidx(heads[i], f.index[0]) }));
    await Promise.all(s.tracks.map((tr, i) => sbDo(tr.sb, () => tr.sb.appendBuffer(heads[i].subarray(0, tr.f.init[1] + 1)))));
    ms.duration = Math.max(duration || 0, ...s.tracks.map((tr) => tr.segs.at(-1).t1));
    return setupVideo(s);
  }

  // Controls, start position, volume, spinner and buffering for a mounted session.
  async function setupVideo(s) {
    const v = s.video;
    s.ready = true;
    const { cpVolume } = await chrome.storage.local.get({ cpVolume: null });
    if (cpVolume) { v.volume = cpVolume.volume; v.muted = cpVolume.muted; }
    v.controls = true;
    v.currentTime = s.at;
    v.addEventListener("volumechange", () => chrome.storage.local.set({ cpVolume: { volume: v.volume, muted: v.muted } }));
    v.addEventListener("seeking", () => {
      for (const tr of s.tracks) if (bufEnd(tr.sb, v.currentTime) === v.currentTime) tr.ac?.abort();
      tick(s);
    });
    const loading = (on) => s.wrap.classList.toggle("loading", on);
    v.addEventListener("waiting", () => { loading(true); tick(s); });
    v.addEventListener("seeking", () => loading(true));
    v.addEventListener("playing", () => loading(false));
    v.addEventListener("seeked", () => { if (v.paused) loading(false); });
    v.addEventListener("canplay", () => { if (v.paused) loading(false); });
    v.addEventListener("ended", () => playNext());
    s.timer = setInterval(() => tick(s), 500);
    tick(s);
    v.play().catch(() => loading(false)); // autoplay may be blocked: the controls are there
  }

  function tick(s) {
    if (cur !== s) return;
    for (const tr of s.tracks) pump(s, tr);
  }

  async function pump(s, tr) {
    if (tr.busy || cur !== s) return;
    const t = s.video.currentTime, end = bufEnd(tr.sb, t);
    if (end - t >= AHEAD) return;
    const i = tr.segs.findIndex((g) => g.t1 > end + 0.15);
    if (i < 0) { tr.done = true; return maybeEnd(s); }
    tr.done = false;
    let j = i;
    // Starving (start, seek, slow line): one segment, so playback starts as soon as possible.
    if (end - t >= LOW) while (j + 1 < tr.segs.length && j - i < 5 && tr.segs[j + 1].b - tr.segs[i].a < MAX_REQ) j++;
    tr.busy = true;
    tr.ac = new AbortController();
    try {
      const data = await getRange(tr.f, tr.segs[i].a, tr.segs[j].b, AbortSignal.any([tr.ac.signal, s.ac.signal]));
      if (cur !== s) return;
      await evict(s, tr);
      try {
        await sbDo(tr.sb, () => tr.sb.appendBuffer(data));
      } catch (e) {
        if (e.name !== "QuotaExceededError") throw e;
        await sbDo(tr.sb, () => tr.sb.remove(0, Math.max(0, s.video.currentTime - 3)));
        await sbDo(tr.sb, () => tr.sb.appendBuffer(data));
      }
      s.errors = 0;
    } catch (e) {
      if (cur !== s || e.name === "AbortError") return;
      if (e.status === 403 && !s.refreshed) {
        s.refreshed = true; // links expired (they last ~6 h): fetch fresh ones once
        if (await refresh(s)) return;
      }
      if (++s.errors >= 6) return fail(s, e.message || String(e));
      await sleep(1500);
    } finally {
      tr.busy = false;
    }
    setTimeout(() => tick(s), 0);
  }

  async function refresh(s) {
    pre.delete(s.vid);
    const res = await call("play", { url: `https://www.youtube.com/watch?v=${s.vid}`, fresh: true });
    if (!res.ok || cur !== s) return false;
    const next = [res.video, res.audio];
    if (s.tracks.some((tr, i) => tr.f.mime !== next[i].mime || tr.f.size !== next[i].size)) return false;
    s.tracks.forEach((tr, i) => { tr.f = next[i]; });
    s.refreshed = false;
    return true;
  }

  async function evict(s, tr) {
    const b = tr.sb.buffered, cut = s.video.currentTime - BEHIND;
    if (b.length && b.start(0) < cut - 10) await sbDo(tr.sb, () => tr.sb.remove(0, cut));
  }

  function maybeEnd(s) {
    if (s.ms.readyState === "open" && s.tracks.every((tr) => tr.done && !tr.sb.updating)) {
      try { s.ms.endOfStream(); } catch {}
    }
  }

  // ---------------------------------------------------------------- YouTube's page

  const ytVideo = () => document.querySelector("#movie_player video.html5-main-video");

  function pauseYouTube() {
    document.querySelectorAll("#movie_player video").forEach((v) => { if (!v.closest(".ytdl-cp")) v.pause(); });
  }

  // YouTube's player (and its ads) keep trying to play: pause it whenever it does.
  const onPlay = (e) => {
    const v = e.target;
    if (cur?.suppress && v instanceof HTMLMediaElement && v !== cur.video && v.closest("#movie_player")) v.pause();
  };
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);

  // Autoplay / playlists: when ours ends, do what YouTube's player would.
  function playNext() {
    const inList = new URL(location.href).searchParams.has("list");
    const autoplay = document.querySelector('#movie_player .ytp-autonav-toggle-button[aria-checked="true"]');
    if (inList || autoplay) document.querySelector("#movie_player .ytp-next-button")?.click();
  }

  function startTime() {
    const t = new URL(location.href).searchParams.get("t") || "";
    if (/^\d+s?$/.test(t)) return parseInt(t, 10);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }

  // YouTube's keyboard shortcuts, applied to our player instead.
  document.addEventListener("keydown", (e) => {
    const s = cur, v = s?.video;
    if (!v || !s.ready || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const inPlayer = s.host?.contains(document.activeElement);
    if (s.wrap.contains(el) && [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.stopImmediatePropagation(); // the focused <video> handles these itself
      return;
    }
    switch (e.key) {
      case " ": case "k": case "K": v.paused ? v.play() : v.pause(); break;
      case "j": case "J": v.currentTime = Math.max(0, v.currentTime - 10); break;
      case "l": case "L": v.currentTime += 10; break;
      case "ArrowLeft": v.currentTime = Math.max(0, v.currentTime - 5); break;
      case "ArrowRight": v.currentTime += 5; break;
      case "ArrowUp": if (!inPlayer) return; v.volume = Math.min(1, v.volume + 0.05); break;
      case "ArrowDown": if (!inPlayer) return; v.volume = Math.max(0, v.volume - 0.05); break;
      case "m": case "M": v.muted = !v.muted; break;
      case "f": case "F": document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen(); break;
      default:
        if (/^[0-9]$/.test(e.key) && v.duration) { v.currentTime = (v.duration * +e.key) / 10; break; }
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  let noticeEl = null;
  function notice(text) {
    noticeEl ??= Object.assign(document.createElement("div"), { className: "ytdl-cp-notice" });
    noticeEl.textContent = text;
    document.body.append(noticeEl);
    clearTimeout(noticeEl.timer);
    noticeEl.timer = setTimeout(() => noticeEl.remove(), 5000);
  }

  const style = document.createElement("style");
  style.textContent = `
    .ytdl-cp { position: absolute; inset: 0; z-index: 2147483000; background: #000; }
    .ytdl-cp video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
    .ytdl-cp-spin { position: absolute; left: 50%; top: 50%; width: 48px; height: 48px; margin: -24px 0 0 -24px;
      border-radius: 50%; border: 4px solid rgba(255,255,255,.25); border-top-color: #fff;
      animation: ytdl-cp-spin .9s linear infinite; pointer-events: none; display: none; }
    .ytdl-cp.loading .ytdl-cp-spin { display: block; }
    @keyframes ytdl-cp-spin { to { transform: rotate(360deg); } }
    .ytdl-cp-yt { position: absolute; top: 10px; right: 10px; opacity: 0; transition: opacity .2s;
      background: rgba(0,0,0,.65); color: #fff; border: 0; border-radius: 14px; padding: 6px 12px;
      font: 500 12px Roboto, Arial, sans-serif; cursor: pointer; }
    .ytdl-cp:hover .ytdl-cp-yt { opacity: 1; }
    .ytdl-cp-notice { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
      background: #323232; color: #fff; padding: 10px 16px; border-radius: 8px; font: 13px Roboto, Arial, sans-serif; }`;
  document.documentElement.append(style);

  // ---------------------------------------------------------------- which video

  // YouTube's player is showing an ad (pre-roll, mid-roll, or the overlay of one).
  function inAd() {
    const p = document.querySelector("#movie_player");
    return !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")
      || !!p.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container"));
  }

  // React to an ad starting right away (YouTube flags it with a class on #movie_player), not on the next poll.
  let watched = null;
  const adObserver = new MutationObserver(() => { if (!cur && inAd()) sync(); });
  function watchPlayer() {
    const p = document.querySelector("#movie_player");
    if (!p || p === watched) return;
    adObserver.disconnect();
    adObserver.observe(p, { attributes: true, attributeFilter: ["class"] });
    watched = p;
  }

  function sync() {
    if (enabled === null) return;
    const u = new URL(location.href);
    const vid = enabled && u.pathname === "/watch" ? u.searchParams.get("v") : null;
    if (cur && cur.vid !== vid) stop(cur); // navigated away
    if (cur) {
      if (cur.wrap && !cur.wrap.isConnected && cur.host?.isConnected) cur.host.append(cur.wrap); // re-rendered
      return;
    }
    if (!vid) return;
    watchPlayer();
    if (!skip.has(vid)) prefetch(vid);
    if (pos.vid !== vid) pos = { vid, t: startTime(), since: Date.now() };
    if (inAd()) {
      if (!skip.has(vid)) start(vid, pos.t);
      return;
    }
    // Remember where the video is, to continue from there if a mid-roll ad starts. Not in the first
    // moments after navigating: the <video> may still hold the previous video.
    const yv = ytVideo();
    if (yv && Date.now() - pos.since > 1500 && yv.currentTime > 0) pos.t = yv.currentTime;
  }

  chrome.storage.sync.get({ cleanPlayer: true }, (o) => { enabled = o.cleanPlayer; sync(); });
  chrome.storage.onChanged.addListener((c) => {
    if (!c.cleanPlayer) return;
    enabled = c.cleanPlayer.newValue;
    if (!enabled && cur) stop(cur, { resumeYouTube: true });
    sync();
  });
  document.addEventListener("yt-navigate-finish", sync);
  setInterval(sync, 500);

})();
