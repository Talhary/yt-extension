(() => {
  // Runs on every site. YouTube and YouTube Music get their own buttons; everywhere else
  // gets a Download button on videos plus the right-click menu.
  const IS_MUSIC = location.hostname === "music.youtube.com";
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname) && !IS_MUSIC;
  const ON_YOUTUBE = IS_YT || IS_MUSIC;
  const BASE = IS_MUSIC ? "https://music.youtube.com" : "https://www.youtube.com";

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    download: svg("M12 15.6 7.4 11l1.4-1.4 2.2 2.2V4h2v7.8l2.2-2.2 1.4 1.4L12 15.6ZM5 20v-2h14v2H5Z"),
    video: svg("M4 5h12a2 2 0 0 1 2 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"),
    audio: svg("M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"),
    list: svg("M3 6h12v2H3V6Zm0 4h12v2H3v-2Zm0 4h8v2H3v-2Zm13 0v-4h2v4h3l-4 4-4-4h3Z"),
    close: svg("M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z"),
    check: svg("M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"),
    error: svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmtSize = (b) => !b ? "" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1e6)) + " MB";
  const fmtDur = (s) => {
    if (s == null) return "";
    s = Math.round(s);
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
  };

  const RELOADED = "Extension was updated – refresh this page";

  function call(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => resolve(
          chrome.runtime.lastError ? { ok: false, error: RELOADED }
            : res || { ok: false, error: "No response from the extension" }));
      } catch {
        // After the extension is reloaded, scripts left in open tabs lose their connection
        // and sendMessage throws instead of calling back.
        resolve({ ok: false, error: RELOADED });
      }
    });
  }

  // ---------- toast ----------
  let toastEl = null, toastTimer = null;
  function toast(text, err) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ytdl-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.classList.toggle("err", !!err);
    toastEl.innerHTML = (err ? ICON.error : ICON.check) + `<span>${esc(text)}</span>`;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
  }

  // ---------- download dialog ----------
  const STD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360].map((h) => ({ h }));
  const AUDIO_FORMATS = [
    { id: "mp3", label: "MP3", sub: "Plays everywhere" },
    { id: "m4a", label: "M4A", sub: "AAC · no re-encode" },
    { id: "opus", label: "Opus", sub: "Original · smallest" },
    { id: "flac", label: "FLAC", sub: "Lossless container" },
  ];
  const BITRATES = [320, 256, 192, 128];
  const tagFor = (h) => h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 720 ? "HD" : "";

  const PREF_KEY = IS_MUSIC ? "dlgMusic" : IS_YT ? "dlgYt" : "dlgWeb";
  const PREF_DEFAULTS = { tab: IS_MUSIC ? "audio" : "video", quality: 1080, audioFormat: "mp3", audioBitrate: 320 };
  const loadPrefs = () => new Promise((r) => {
    try {
      chrome.storage.sync.get({ [PREF_KEY]: {} }, (s) => r({ ...PREF_DEFAULTS, ...s?.[PREF_KEY] }));
    } catch {
      toast(RELOADED, true);
    }
  });
  const savePrefs = (st) => chrome.storage.sync.set({ [PREF_KEY]: {
    tab: st.tab, quality: st.quality, audioFormat: st.audioFormat, audioBitrate: st.audioBitrate } });

  let dlg = null;

  function closeDialog() {
    if (dlg) dlg.overlay.remove();
    dlg = null;
  }

  // target: { v, list } for YouTube, or { url, src } for any other page (src = the
  // <video>'s direct file URL, tried if the page itself isn't recognised).
  async function openDialog({ v, list, url, src }) {
    closeDialog();
    const prefs = await loadPrefs();
    const st = {
      v, list, url, src, web: !!url, ...prefs,
      // For other sites we don't know yet whether it's one video or a list.
      scope: url ? null : v ? "single" : "playlist",
      info: null, infoErr: null, entries: null, listErr: null, listTitle: "", selected: new Set(),
    };
    const overlay = document.createElement("div");
    overlay.className = "ytdl-overlay";
    const box = document.createElement("div");
    box.className = "ytdl-dialog";
    box.tabIndex = -1;
    overlay.append(box);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDialog(); });
    // Keep YouTube's keyboard shortcuts (space, k, f...) from firing behind the dialog.
    for (const t of ["keydown", "keyup", "keypress"]) {
      overlay.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === "keydown" && e.key === "Escape") closeDialog();
      });
    }
    box.addEventListener("click", onClick);
    box.addEventListener("change", onChange);
    // In fullscreen only the fullscreen element is visible, so open the dialog inside it.
    (document.fullscreenElement || document.body).append(overlay);
    dlg = { overlay, box, st };
    render();
    box.focus();
    if (st.web) probe(st);
    else if (v) fetchInfo(st);
    else fetchList(st);
  }

  // ---------- in-page resolvers ----------
  // Some content only answers the site's own logged-in web app, so it can't be fetched
  // from outside the page even with cookies. For those, ask the site's API from inside
  // the page (same origin, the user's own session) and hand the direct media links to the
  // engine. Instagram stories and highlights are the case that needs this.
  const IG_APP_ID = "936619743392459"; // instagram.com web app's public id, sent by the site itself

  // The same headers instagram.com's own scripts send with API calls.
  function igHeaders() {
    const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1];
    let claim = "0";
    try { claim = sessionStorage.getItem("www-claim-v2") || "0"; } catch {}
    return {
      "X-IG-App-ID": IG_APP_ID, "X-ASBD-ID": "359341", "X-IG-WWW-Claim": claim,
      "X-Requested-With": "XMLHttpRequest", Accept: "*/*", ...(csrf && { "X-CSRFToken": csrf }),
    };
  }

  async function igJson(path) {
    const r = await fetch("https://www.instagram.com/api/v1/" + path, { credentials: "include", headers: igHeaders() });
    if (!r.ok) throw new Error(`Instagram refused the request (HTTP ${r.status})`);
    return r.json();
  }

  // Every reel (an object with media "items") found anywhere inside some JSON.
  function collectReels(root, out = []) {
    const seen = new Set();
    const walk = (o) => {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach(walk);
      if (Array.isArray(o.items) && o.items.some((it) => it?.image_versions2 || it?.video_versions)) out.push(o);
      for (const k in o) walk(o[k]);
    };
    walk(root);
    return out;
  }

  // Instagram responses can be prefixed with "for (;;);" or hold several JSON documents.
  function parseLoose(text) {
    const docs = [];
    for (const part of text.replace(/^for \(;;\);/, "").split(/\r?\n(?=\{)/)) {
      try { docs.push(JSON.parse(part)); } catch {}
    }
    return docs;
  }

  // Story data the page itself loaded (captured by ig-sniffer.js), newest last.
  const seenReels = [];
  function remember(text) {
    for (const doc of parseLoose(text)) collectReels(doc, seenReels);
    if (seenReels.length > 200) seenReels.splice(0, seenReels.length - 200);
  }
  if (/(^|\.)instagram\.com$/.test(location.hostname)) {
    window.addEventListener("message", (e) => {
      if (e.source === window && e.data?.source === "ytdl-ig" && typeof e.data.text === "string") remember(e.data.text);
    });
  }

  // Story data embedded in a page's HTML for it to render.
  function reelsInDocument(doc) {
    const reels = [];
    for (const s of doc.querySelectorAll('script[type="application/json"]')) {
      if (s.textContent.includes("image_versions2")) for (const d of parseLoose(s.textContent)) collectReels(d, reels);
    }
    return reels;
  }

  async function reelsFromPage(url) {
    const html = await (await fetch(url, { credentials: "include" })).text();
    return reelsInDocument(new DOMParser().parseFromString(html, "text/html"));
  }

  // Last resort: whatever photo/video is on screen right now.
  function reelFromScreen() {
    const big = (el) => { const r = el.getBoundingClientRect(); return r.width > 200 && r.height > 200 && r.bottom > 0 && r.top < innerHeight; };
    const video = [...document.querySelectorAll("video")].find((v) => big(v) && /^https?:/.test(v.currentSrc));
    const img = !video && [...document.querySelectorAll("img")].find((i) => big(i) && /^https?:/.test(i.currentSrc));
    const el = video || img;
    if (!el) return null;
    return { items: [{ pk: Date.now(), [video ? "video_versions" : "image_versions2"]:
      video ? [{ url: el.currentSrc, width: 1, height: 1 }] : { candidates: [{ url: el.currentSrc, width: 1, height: 1 }] } }] };
  }

  const biggest = (list) => (list || []).reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), list[0]);

  async function resolveInstagramStory(url) {
    const u = new URL(url);
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/stories\/([^/]+)(?:\/(\d+))?/);
    if (!m) return null;
    const [, user, id] = m;
    let reelId = user === "highlights" ? `highlight:${id}` : null, reel = null, apiError = "";
    const pick = (reels) => reels.find((r) => reelId && String(r.id) === reelId)
      || reels.find((r) => id && r.items.some((it) => String(it.pk) === id));
    // 1. What the page already loaded to show this story (most reliable).
    reel = pick([...seenReels].reverse()) || pick(reelsInDocument(document));
    if (!reel) try {
      if (!reelId) {
        const profile = await igJson(`users/web_profile_info/?username=${encodeURIComponent(user)}`);
        reelId = profile?.data?.user?.id;
      }
      if (reelId) {
        const data = await igJson(`feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
        reel = data.reels?.[reelId] || data.reels_media?.[0];
      }
    } catch (e) {
      apiError = e.message;
    }
    if (!reel?.items?.length) {
      // 3. API refused or returned nothing: use the data embedded in a fresh copy of the page.
      reel = pick(await reelsFromPage(url).catch(() => []));
    }
    // 4. Only the photo/video currently on screen.
    if (!reel?.items?.length) reel = reelFromScreen();
    if (!reel?.items?.length) {
      throw new Error(apiError
        ? `${apiError}, and the story wasn't in the page data either`
        : "This story has expired or isn't visible to your account");
    }
    const owner = reel.user?.username || user;
    const entries = reel.items.map((it, i) => {
      const video = it.video_versions?.length && biggest(it.video_versions);
      const media = video || biggest(it.image_versions2?.candidates);
      if (!media) return null;
      const date = it.taken_at ? new Date(it.taken_at * 1000).toISOString().slice(0, 10) : "";
      const ext = video ? "mp4" : (new URL(media.url).pathname.match(/\.(jpe?g|webp|png|heic)$/i)?.[1] || "jpg");
      return {
        index: i + 1, id: String(it.pk), title: `${video ? "Video" : "Photo"} ${i + 1}${date ? " · " + date : ""}`,
        duration: video ? it.video_duration : null, url: media.url,
        name: `${owner} ${date} ${String(i + 1).padStart(2, "0")} [${it.pk}].${ext}`,
      };
    }).filter(Boolean);
    return {
      title: reel.title ? `${owner} - ${reel.title}` : `${owner} story`,
      entries,
      // Opened on one specific story (not a highlight): tick just that one.
      focus: user !== "highlights" && id ? entries.filter((e) => e.id === id).map((e) => e.index) : null,
    };
  }

  async function probe(st) {
    try {
      const direct = await resolveInstagramStory(st.url);
      if (direct) {
        if (!dlg || dlg.st !== st) return;
        Object.assign(st, { scope: "playlist", direct: true, entries: direct.entries, listTitle: direct.title });
        st.selected = new Set(direct.focus?.length ? direct.focus : direct.entries.map((e) => e.index));
        return render();
      }
    } catch (e) {
      if (!dlg || dlg.st !== st) return;
      Object.assign(st, { scope: "single", unsupported: true, infoErr: e.message });
      return render();
    }
    const page = { title: document.title, thumbnail: document.querySelector('meta[property="og:image"]')?.content || null };
    let r = await call("probe", { url: st.url, src: st.src, ...page });
    if (!r.ok && st.src && st.src !== st.url) {
      const direct = await call("probe", { url: st.src, ...page });
      if (direct.ok) { r = direct; st.url = st.src; }
    }
    if (!dlg || dlg.st !== st) return;
    if (!r.ok) {
      st.scope = "single";
      st.infoErr = r.error;
      st.unsupported = true;
    } else if (r.kind === "playlist") {
      st.scope = "playlist";
      st.entries = r.entries;
      st.listTitle = r.title;
      st.selected = new Set(r.entries.map((e) => e.index));
    } else {
      st.scope = "single";
      st.info = r;
    }
    render();
  }

  const watchUrl = (st) => st.web ? st.url : `${BASE}/watch?v=${st.v}`;
  // "RD..." lists are auto-generated Mixes. They have no /playlist page ("This playlist
  // type is unviewable"), but they can be read from the queue of a watch URL of their seed song.
  const isMix = (st) => !st.web && !!st.list && st.list.startsWith("RD");
  const mixSeed = (st) => st.v || (st.list.match(/^RD(?:AMVM|MM|EM)?([\w-]{11})$/) || [])[1];
  const listUrl = (st) => st.web ? st.url : isMix(st) && mixSeed(st)
    ? `${BASE}/watch?v=${mixSeed(st)}&list=${st.list}`
    : `${BASE}/playlist?list=${st.list}`;
  const MIX_PRESELECT = 25;

  async function fetchInfo(st) {
    const r = await call("info", { url: watchUrl(st) });
    if (!dlg || dlg.st !== st) return;
    if (r.ok) st.info = r; else st.infoErr = r.error;
    render();
  }

  async function fetchList(st) {
    const r = await call("list", { url: listUrl(st) });
    if (!dlg || dlg.st !== st) return;
    if (r.ok) {
      st.entries = r.entries;
      st.listTitle = r.title;
      // Mixes run to hundreds of songs; start with just the first few ticked.
      const pre = isMix(st) ? r.entries.slice(0, MIX_PRESELECT) : r.entries;
      st.selected = new Set(pre.map((e) => e.index));
    } else {
      st.listErr = r.error;
    }
    render();
  }

  function heightsFor(st) {
    if (st.scope !== "single" || !st.info) return STD_HEIGHTS;
    // A plain file (or a site that doesn't list resolutions): just one "best" choice (h = 0).
    return st.info.heights.length ? st.info.heights : [{ h: 0 }];
  }

  function render() {
    const { box, st } = dlg;
    if (!st.scope) return renderProbing(box, st);
    const single = st.scope === "single";
    // Audio-only sources (SoundCloud, podcasts...) have nothing for the Video tab.
    const audioOnly = single && st.info && st.info.hasVideo === false;
    if (audioOnly) st.tab = "audio";
    const heights = heightsFor(st);
    if (!heights.some((o) => o.h === st.quality)) {
      // Snap to the best available quality not above the preferred one.
      st.quality = (heights.find((o) => o.h <= st.quality) || heights[heights.length - 1]).h;
    }
    const scroll = box.querySelector(".ytdl-list")?.scrollTop || 0;

    const seg = (key, val, label) =>
      `<button data-k="${key}" data-v="${val}" class="${st[key] === val ? "on" : ""}">${label}</button>`;

    // Header
    const info = st.info;
    const title = single
      ? (info?.title || (st.unsupported ? "No downloadable video found" : st.infoErr ? "Video" : "Loading…"))
      : (st.listTitle || "Playlist");
    const sub = single
      ? [info?.uploader, fmtDur(info?.duration)].filter(Boolean).join(" · ") || (st.web ? location.hostname : "")
      : st.entries ? `${st.entries.length} items` : st.listErr ? "" : "Loading playlist…";
    const thumb = single && (info?.thumbnail || (st.v && `https://i.ytimg.com/vi/${st.v}/mqdefault.jpg`));
    const hero = thumb
      ? `<img class="ytdl-hero" src="${esc(thumb)}" alt="">`
      : `<div class="ytdl-hero ytdl-hero-icon">${single ? ICON.video : ICON.list}</div>`;

    // Options
    let options;
    if (st.direct) {
      // Direct media files: saved as-is, so there are no formats or qualities to pick.
      options = "";
    } else if (st.tab === "video") {
      const waiting = single && !info && !st.infoErr;
      options = `<div class="ytdl-label">${single ? "Quality" : "Max quality"}</div>
        <div class="ytdl-grid">${heights.map((o) => `
          <button class="ytdl-chip ${o.h === st.quality ? "on" : ""}" data-k="quality" data-v="${o.h}">
            <b>${o.h ? `${o.h}p` : "Best"}${tagFor(o.h) ? `<i>${tagFor(o.h)}</i>` : ""}</b>
            <small>${o.size ? "~" + fmtSize(o.size) : waiting ? '<span class="ytdl-shimmer"></span>' : o.h ? "MP4" : "Original file"}</small>
          </button>`).join("")}</div>`;
    } else {
      options = `<div class="ytdl-label">Format</div>
        <div class="ytdl-grid">${AUDIO_FORMATS.map((f) => `
          <button class="ytdl-chip ${f.id === st.audioFormat ? "on" : ""}" data-k="audioFormat" data-v="${f.id}">
            <b>${f.label}</b><small>${f.sub}</small></button>`).join("")}</div>
        ${st.audioFormat === "mp3" ? `<div class="ytdl-label">Bitrate</div>
          <div class="ytdl-seg ytdl-seg-full">${BITRATES.map((b) => seg("audioBitrate", b, b + " kbps")).join("")}</div>` : ""}`;
    }

    // Playlist checklist
    let listPanel = "";
    if (!single) {
      const n = st.entries?.length || 0, sel = st.selected.size;
      listPanel = `<div class="ytdl-list-head">
          <label class="ytdl-check"><input type="checkbox" data-all ${n && sel === n ? "checked" : ""} ${n ? "" : "disabled"}>
          <span>Select all</span></label><span class="ytdl-count">${n ? `${sel} of ${n} selected` : ""}</span></div>
        <div class="ytdl-list">${st.entries ? st.entries.map((e) => `
          <label class="ytdl-row"><input type="checkbox" data-i="${e.index}" ${st.selected.has(e.index) ? "checked" : ""}>
            <span class="ytdl-idx">${e.index}</span><span class="ytdl-row-title">${esc(e.title)}</span>
            <span class="ytdl-dur">${fmtDur(e.duration)}</span></label>`).join("")
          : st.listErr ? `<div class="ytdl-msg ytdl-msg-err">${esc(st.listErr)}</div>`
          : `<div class="ytdl-msg"><span class="ytdl-spin"></span>Loading playlist…</div>`}</div>`;
    }

    // Footer
    let note = "", label = "Download", disabled = false;
    if (st.unsupported) {
      // Nothing downloadable here (unsupported site, DRM, or needs login).
      const needsLogin = /log ?in|logged|cookies|authenticat|private/i.test(st.infoErr || "");
      const site = new URL(st.url).hostname.replace(/^www\./, "");
      options = needsLogin
        ? `<div class="ytdl-msg ytdl-msg-col"><b>${esc(site)} needs you to be logged in</b>
            <span>Log in to ${esc(site)} in this browser and keep <i>Use my login</i> on in the
            extension popup, then try again.</span><small>${esc(st.infoErr)}</small></div>`
        : `<div class="ytdl-msg ytdl-msg-err">${esc(st.infoErr)}</div>`;
      disabled = true;
      note = needsLogin ? "" : "Unsupported site, DRM-protected, or needs you to be logged in";
    } else if (single) {
      if (st.infoErr) note = "Couldn't read formats – best match will be used";
      else if (st.tab === "video") note = info ? fmtSize(heights.find((o) => o.h === st.quality)?.size) : "";
      else if (info?.duration && st.audioFormat === "mp3") note = fmtSize(info.duration * st.audioBitrate * 125);
      else note = fmtSize(info?.audioSize);
      if (note && !note.startsWith("Couldn't")) note = "Estimated size ~" + note;
    } else {
      const n = st.entries?.length || 0, sel = st.selected.size;
      disabled = !n || !sel;
      label = n && sel === n ? `Download all ${n}` : `Download ${sel || ""}`.trim();
      note = st.direct ? "Original quality · photos and videos"
        : isMix(st) && n > MIX_PRESELECT ? `Auto-generated Mix · first ${MIX_PRESELECT} selected`
        : "Saved in a folder named after the playlist";
    }

    box.innerHTML = `
      <div class="ytdl-head">${hero}
        <div class="ytdl-head-text"><div class="ytdl-title">${esc(title)}</div><div class="ytdl-sub">${esc(sub)}</div></div>
        <button class="ytdl-x" data-close title="Close">${ICON.close}</button></div>
      ${st.v && st.list ? `<div class="ytdl-seg ytdl-seg-full ytdl-scope">${
        seg("scope", "single", IS_MUSIC ? "This song" : "This video")}${seg("scope", "playlist", "Entire playlist")}</div>` : ""}
      <div class="ytdl-body">
        ${st.unsupported || st.direct ? "" : `<div class="ytdl-tabs">${audioOnly ? "" : seg("tab", "video", ICON.video + "Video")}${
          seg("tab", "audio", ICON.audio + "Audio")}</div>`}
        ${options}${listPanel}
      </div>
      <div class="ytdl-foot"><span class="ytdl-note">${esc(note)}</span>
        <button class="ytdl-ghost" data-close>Cancel</button>
        <button class="ytdl-primary" data-go ${disabled ? "disabled" : ""}>${ICON.download}<span>${esc(label)}</span></button></div>`;

    const all = box.querySelector("[data-all]");
    if (all) all.indeterminate = st.selected.size > 0 && st.selected.size < (st.entries?.length || 0);
    const listEl = box.querySelector(".ytdl-list");
    if (listEl) listEl.scrollTop = scroll;
  }

  function renderProbing(box, st) {
    box.innerHTML = `
      <div class="ytdl-head"><div class="ytdl-hero ytdl-hero-icon">${ICON.video}</div>
        <div class="ytdl-head-text"><div class="ytdl-title">Looking for videos…</div>
        <div class="ytdl-sub">${esc(new URL(st.url).hostname)}</div></div>
        <button class="ytdl-x" data-close title="Close">${ICON.close}</button></div>
      <div class="ytdl-body"><div class="ytdl-msg"><span class="ytdl-spin"></span>Checking this page</div></div>
      <div class="ytdl-foot"><span class="ytdl-note"></span>
        <button class="ytdl-ghost" data-close>Cancel</button>
        <button class="ytdl-primary" disabled>${ICON.download}<span>Download</span></button></div>`;
  }

  function onClick(e) {
    const { st } = dlg;
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-close")) return closeDialog();
    if (t.hasAttribute("data-go")) return startDownload(st);
    if (t.dataset.k) {
      const raw = t.dataset.v;
      st[t.dataset.k] = /^\d+$/.test(raw) ? Number(raw) : raw;
      if (t.dataset.k === "scope" && raw === "playlist" && !st.entries && !st.listErr) fetchList(st);
      // "Best" (0) only exists for this one file; don't make it the remembered quality.
      if (t.dataset.k !== "scope" && !(t.dataset.k === "quality" && raw === "0")) savePrefs(st);
      render();
    }
  }

  function onChange(e) {
    const { st } = dlg;
    const t = e.target;
    if (t.hasAttribute("data-all")) {
      st.selected = t.checked ? new Set(st.entries.map((x) => x.index)) : new Set();
    } else if (t.dataset.i) {
      const i = Number(t.dataset.i);
      t.checked ? st.selected.add(i) : st.selected.delete(i);
    }
    render();
  }

  async function startDownload(st) {
    const single = st.scope === "single";
    const payload = {
      mode: st.tab, quality: st.quality, audioFormat: st.audioFormat, audioBitrate: st.audioBitrate,
      playlist: !single,
    };
    if (single) {
      Object.assign(payload, { url: watchUrl(st), src: st.web ? st.src : undefined, title: st.info?.title || "" });
    } else {
      const all = st.selected.size === st.entries.length;
      Object.assign(payload, {
        url: listUrl(st), title: st.listTitle, count: st.entries.length,
        items: all ? [] : [...st.selected].sort((a, b) => a - b),
      });
      // The exact videos that were listed and ticked (a Mix is regenerated on every load, so
      // positions alone could point at different songs by the time it downloads).
      payload.entries = st.entries.filter((e) => st.selected.has(e.index))
        .map(({ index, id, title }) => ({ index, id, title }));
      if (st.direct) {
        payload.direct = st.entries.filter((e) => st.selected.has(e.index)).map((e) => ({ url: e.url, name: e.name }));
        payload.items = [];
      }
    }
    closeDialog();
    const r = await call("download", payload);
    if (!r.ok) return toast(r.error || "Download failed", true);
    const what = st.direct ? "original files" : st.tab === "audio" ? st.audioFormat.toUpperCase()
      : st.quality ? `${st.quality}p video` : "video";
    toast(single ? `Downloading ${what}` : `Downloading ${payload.items.length || st.entries.length} items as ${what}`);
  }

  // ---------- what's on the current page ----------
  function pageInfo() {
    const u = new URL(location.href);
    const v = u.pathname === "/watch" ? u.searchParams.get("v") : null;
    let list = u.searchParams.get("list");
    if (IS_MUSIC && !list && u.pathname.startsWith("/browse")) {
      // Album / playlist pages on YT Music: take the list id from the header's play link.
      const a = document.querySelector(
        'ytmusic-responsive-header-renderer a[href*="list="], ytmusic-detail-header-renderer a[href*="list="]');
      if (a) list = new URL(a.href).searchParams.get("list");
    }
    return { v, list };
  }

  // ---------- inline buttons ----------
  function makeButton(variant) {
    const b = document.createElement("button");
    b.className = `ytdl-btn ytdl-${variant}` + (variant === "ytp" ? " ytp-button" : "");
    b.title = "Download";
    b.setAttribute("aria-label", "Download");
    b.innerHTML = ICON.download + (variant === "pill" ? "<span>Download</span>" : "");
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const p = pageInfo();
      if (!p.v && !p.list) return toast("Open a video, song or playlist to download it", true);
      openDialog(p);
    });
    return b;
  }

  // Where to place the button, per page. First matching selector wins.
  const SLOTS = IS_MUSIC ? [
    { key: "bar", when: () => true, variant: "icon", prepend: true,
      sel: ["ytmusic-player-bar .right-controls-buttons"] },
    { key: "header", when: (p) => p.list && !p.v, variant: "pill",
      sel: ["ytmusic-responsive-header-renderer .action-buttons",
            "ytmusic-detail-header-renderer .action-buttons"] },
  ] : [
    // In the player's own control bar (bottom-right of the video, next to CC/settings).
    // Not in the Like/Share row: that row is flexible and wraps onto a new line when it grows.
    { key: "player", when: (p) => p.v, variant: "ytp", prepend: true,
      sel: ["#movie_player .ytp-right-controls-left", "#movie_player .ytp-right-controls"] },
    { key: "playlist", when: (p) => p.list && !p.v, variant: "pill",
      sel: ["ytd-browse[page-subtype=playlist] yt-flexible-actions-view-model",
            "ytd-playlist-header-renderer .metadata-action-bar",
            "ytd-playlist-header-renderer #top-level-buttons-computed"] },
  ];

  const visible = (el) => el && el.offsetParent !== null;
  let fab = null, misses = 0;

  function placeInline() {
    const p = pageInfo();
    let placed = false;
    for (const slot of SLOTS) {
      if (!slot.when(p)) continue;
      const host = slot.sel.map((s) => [...document.querySelectorAll(s)].find(visible)).find(Boolean);
      if (!host) continue;
      if (!host.querySelector(`:scope > .ytdl-btn[data-slot="${slot.key}"]`)) {
        const b = makeButton(slot.variant);
        b.dataset.slot = slot.key;
        slot.prepend ? host.prepend(b) : host.append(b);
      }
      placed = true;
    }
    // Fallback if YouTube changed its layout and no slot matched for a few seconds
    // (not immediately, so it doesn't flash while the page is still loading).
    misses = placed || !(p.v || p.list) ? 0 : misses + 1;
    const needFab = misses > 5;
    if (needFab && !fab) { fab = makeButton("fab"); document.body.appendChild(fab); }
    if (fab) fab.style.display = needFab ? "" : "none";
  }

  // ---------- thumbnail / list-item buttons ----------
  const THUMB_HOSTS = [
    "ytd-thumbnail", "yt-thumbnail-view-model",
    "ytmusic-responsive-list-item-renderer", "ytmusic-two-row-item-renderer",
  ].join(",");

  function linkInfo(host) {
    const a = host.querySelector('a[href*="watch?v="], a[href*="list="]') || host.closest("a[href]");
    if (!a) return null;
    const u = new URL(a.getAttribute("href"), location.origin);
    const v = u.searchParams.get("v"), list = u.searchParams.get("list");
    return v || list ? { v, list } : null;
  }

  function decorate(host) {
    if (host.dataset.ytdl || !linkInfo(host)) return;
    host.dataset.ytdl = "1";
    host.classList.add("ytdl-host");
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = document.createElement("button");
    btn.className = "ytdl-thumb";
    btn.title = "Download";
    btn.innerHTML = ICON.download;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      // Re-read the link: YouTube recycles renderers for different videos.
      const info = linkInfo(host);
      if (!info) return toast("Couldn't find a link for this item", true);
      openDialog(info);
    }, true);
    host.appendChild(btn);
  }

  let showThumbs = true;
  chrome.storage.sync.get({ thumbIcons: true }, (s) => {
    showThumbs = s.thumbIcons;
    document.documentElement.classList.toggle("ytdl-no-thumbs", !showThumbs);
    if (ON_YOUTUBE) tick();
  });
  chrome.storage.onChanged.addListener((c) => {
    if (!c.thumbIcons || !ON_YOUTUBE) return;
    showThumbs = c.thumbIcons.newValue;
    document.documentElement.classList.toggle("ytdl-no-thumbs", !showThumbs);
    tick();
  });

  function tick() {
    if (showThumbs) document.querySelectorAll(THUMB_HOSTS).forEach(decorate);
    placeInline();
  }

  // ---------- floating progress bubble ----------
  // Draggable ring showing download progress. Closing it hides the current downloads
  // (in every tab); after that their progress is only shown in the extension popup.
  const RING = 2 * Math.PI * 24;
  let bubble = null, visibleIds = [], hideTimer = null, lastDone = null;

  function buildBubble() {
    const b = document.createElement("div");
    b.className = "ytdl-bubble";
    b.innerHTML = `
      <svg class="ytdl-ring" viewBox="0 0 56 56"><circle class="track" cx="28" cy="28" r="24"/>
        <circle class="bar" cx="28" cy="28" r="24" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
      <span class="ytdl-bubble-label"></span><span class="ytdl-bubble-count"></span>
      <button class="ytdl-bubble-x" title="Hide">${ICON.close}</button>
      <div class="ytdl-bubble-tip"></div>`;
    document.body.appendChild(b);

    chrome.storage.local.get({ bubblePos: null }, ({ bubblePos }) => {
      if (bubblePos) place(b, bubblePos.x, bubblePos.y);
    });

    b.querySelector(".ytdl-bubble-x").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.storage.session.get({ bubbleDismissed: [] }, ({ bubbleDismissed }) =>
        chrome.storage.session.set({ bubbleDismissed: [...new Set([...bubbleDismissed, ...visibleIds])] }));
      b.classList.remove("show");
    });

    // Drag with the pointer; a press without movement counts as a click.
    let start = null, moved = false;
    b.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ytdl-bubble-x")) return;
      const r = b.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      moved = false;
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      b.classList.add("dragging");
      place(b, start.left + dx, start.top + dy);
    });
    b.addEventListener("pointerup", () => {
      if (!start) return;
      start = null;
      b.classList.remove("dragging");
      if (moved) {
        const r = b.getBoundingClientRect();
        chrome.storage.local.set({ bubblePos: { x: r.left, y: r.top } });
      } else {
        const id = lastDone ?? visibleIds[0];
        if (id != null) call("reveal", { jobId: id });
      }
    });
    window.addEventListener("resize", () => {
      const r = b.getBoundingClientRect();
      if (b.style.left) place(b, r.left, r.top);
    });
    return b;
  }

  function place(b, x, y) {
    const size = 56, pad = 8;
    b.style.left = Math.max(pad, Math.min(x, innerWidth - size - pad)) + "px";
    b.style.top = Math.max(pad, Math.min(y, innerHeight - size - pad)) + "px";
    b.style.right = b.style.bottom = "auto";
    b.classList.toggle("tip-right", x < 320); // keep the hover label on screen
  }

  function updateBubble(jobs, dismissed) {
    jobs = jobs || [];
    const active = jobs.filter((j) => ["queued", "downloading"].includes(j.state) && !dismissed.includes(j.id));
    if (!bubble) {
      if (!active.length) return;
      bubble = buildBubble();
    }
    const label = bubble.querySelector(".ytdl-bubble-label");
    const bar = bubble.querySelector(".bar");
    const tip = bubble.querySelector(".ytdl-bubble-tip");
    const count = bubble.querySelector(".ytdl-bubble-count");

    if (active.length) {
      clearTimeout(hideTimer);
      lastDone = null;
      visibleIds = active.map((j) => j.id);
      const pct = active.reduce((s, j) => s + (j.progress || 0), 0) / active.length;
      bubble.className = "ytdl-bubble show";
      bar.style.strokeDashoffset = RING * (1 - pct / 100);
      label.textContent = Math.floor(pct) + "%";
      count.textContent = active.length > 1 ? active.length : "";
      tip.textContent = active.map((j) =>
        `${j.title || "Starting…"}${j.item ? ` (${j.item})` : ""} – ${Math.floor(j.progress || 0)}%`).join("\n");
      return;
    }
    // Everything we were showing has finished: show the result briefly, then hide.
    const finished = jobs.filter((j) => visibleIds.includes(j.id) && ["done", "error"].includes(j.state));
    visibleIds = [];
    if (!finished.length || !bubble.classList.contains("show")) {
      bubble.classList.remove("show"); // dismissed, cancelled or cleared
      return;
    }
    const failed = finished.some((j) => j.state === "error");
    lastDone = finished[finished.length - 1].id;
    bubble.className = "ytdl-bubble show " + (failed ? "failed" : "done");
    bar.style.strokeDashoffset = 0;
    label.innerHTML = failed ? ICON.error : ICON.check;
    count.textContent = "";
    tip.textContent = failed ? "Some downloads failed – see the extension popup" : "Done – click to show in folder";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove("show"), 6000);
  }

  function refreshBubble() {
    chrome.storage.session.get({ jobs: [], bubbleDismissed: [] }, (s) => {
      if (!chrome.runtime.lastError) updateBubble(s.jobs, s.bubbleDismissed);
    });
  }
  chrome.storage.session.onChanged.addListener((c) => {
    if (c.jobs || c.bubbleDismissed) refreshBubble();
  });
  refreshBubble();

  // ---------- other sites: Download button on videos ----------
  // One shared button, moved to the top-right corner of whichever video is under the
  // pointer. Sites cover their <video> with control layers, so hit-test by rectangle.
  function initVideoButton() {
    const btn = document.createElement("button");
    btn.className = "ytdl-vbtn";
    btn.innerHTML = ICON.download + "<span>Download</span>";
    let current = null, raf = 0;

    const hide = () => { btn.classList.remove("show"); current = null; };
    function check(x, y) {
      if (dlg) return hide();
      if (btn.matches(":hover")) return;
      const v = [...document.querySelectorAll("video")].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 200 && r.height >= 112 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!v) return hide();
      current = v;
      const host = document.fullscreenElement || document.body;
      if (btn.parentNode !== host) host.appendChild(btn);
      const r = v.getBoundingClientRect();
      btn.classList.add("show");
      btn.style.top = Math.max(8, r.top + 10) + "px";
      btn.style.left = Math.max(8, Math.min(r.right, innerWidth) - btn.offsetWidth - 10) + "px";
    }
    document.addEventListener("mousemove", (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; check(e.clientX, e.clientY); });
    }, { passive: true });
    window.addEventListener("scroll", hide, { passive: true });

    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      // blob:/MediaSource players have no usable file URL; then only the page URL helps.
      const src = current && /^https?:/.test(current.currentSrc) ? current.currentSrc : "";
      hide();
      openDialog({ url: location.href, src });
    });
  }

  // Right-click menu and the popup's "Download from this tab" send us a URL.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "open-dialog") return;
    let u;
    try { u = new URL(msg.url); } catch { return; }
    const yt = /(^|\.)youtube\.com$/.test(u.hostname);
    const v = yt && u.pathname === "/watch" ? u.searchParams.get("v") : null;
    const list = yt ? u.searchParams.get("list") : null;
    if (v || list) openDialog({ v, list });
    else openDialog({ url: u.href, src: msg.src });
  });

  if (ON_YOUTUBE) {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(tick, 250);
    }).observe(document.body, { childList: true, subtree: true });

    // YouTube re-renders its action bars on navigation; re-check periodically too.
    setInterval(placeInline, 1000);
    tick();
  } else {
    initVideoButton();
  }
})();
