// Service worker. The downloading itself happens in the engine (offscreen.html + engine/), which lives as
// long as it is working; this worker routes messages to it and does what only it can:
//   - cookies: reads the user's login for YouTube and hands it to the engine (option "Use my login")
//   - header rules: requests the engine marks with ytpc=<client> get the User-Agent / Origin / Cookie the
//     YouTube clients need (fetch() can't set those headers itself)
//   - files: saves finished files with chrome.downloads, and "show in folder"
//   - media sniffing: remembers the video/audio/HLS URLs each tab loads, for sites other than YouTube
import { CLIENTS } from "./engine/ytp.js";

const ORIGIN = "https://www.youtube.com";

// ---------------------------------------------------------------- engine

let creating = null;
let markReady = null;
let engineReady = null;

async function ensureEngine() {
  if (await chrome.offscreen.hasDocument()) {
    if (!engineReady) engineReady = Promise.resolve(); // worker restarted while the engine kept running
    return engineReady;
  }
  engineReady = new Promise((r) => { markReady = r; });
  creating ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "WORKERS", "IFRAME_SCRIPTING"],
    justification: "Downloads, merges and converts videos the user asked to save.",
  }).finally(() => { creating = null; });
  await creating;
  await Promise.race([engineReady, new Promise((r) => setTimeout(r, 10000))]);
}

async function toEngine(type, payload) {
  await ensureEngine();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: "engine", type, payload });
      return res ?? { ok: false, error: "The download engine did not answer" };
    } catch (e) {
      if (attempt >= 3) return { ok: false, error: String(e.message || e) };
      await new Promise((r) => setTimeout(r, 300)); // engine still loading
    }
  }
}

// ---------------------------------------------------------------- header rules

const CLIENT_RULES = Object.entries({ ...CLIENTS, web: { ua: null } }).map(([name, c], i) => ({
  id: 1 + i, priority: 1,
  // Also tab requests: the ad-free player (player.js) streams from the YouTube page itself.
  condition: { regexFilter: `[?&]ytpc=${name}(&|$)`, resourceTypes: ["xmlhttprequest", "other", "media"] },
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      ...(c.ua ? [{ header: "user-agent", operation: "set", value: c.ua }] : []),
      { header: "origin", operation: "set", value: ORIGIN },
    ],
  },
}));
const COOKIE_RULE = 20;   // Cookie for the logged-in clients' API calls
const REFERER_RULE = 30;  // Referer/Origin for media fetched from other sites

async function setupRules() {
  const old = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old, addRules: CLIENT_RULES });
}
setupRules();

let lastCookie = null;
async function setCookieRule(cookie) {
  if (cookie === lastCookie) return;
  lastCookie = cookie;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [COOKIE_RULE],
    addRules: cookie ? [{
      id: COOKIE_RULE, priority: 2,
      condition: { regexFilter: "^https://www\\.youtube\\.com/youtubei/v1/[a-z]+\\?.*[?&]ytpc=(tv|mweb|web)(&|$)",
        tabIds: [-1], resourceTypes: ["xmlhttprequest", "other"] },
      action: { type: "modifyHeaders", requestHeaders: [{ header: "cookie", operation: "set", value: cookie }] },
    }] : [],
  });
}

// Media on other sites may only load with the page as referrer.
async function setRefererRule(pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return; }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE],
    addRules: [{
      id: REFERER_RULE, priority: 1,
      condition: { tabIds: [-1], excludedRequestDomains: ["youtube.com", "googlevideo.com", "ytimg.com"],
        resourceTypes: ["xmlhttprequest", "other", "media"] },
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "referer", operation: "set", value: pageUrl },
        { header: "origin", operation: "set", value: origin },
      ] },
    }],
  });
}

// The user's YouTube login as a Cookie header ("" if off or signed out).
async function youtubeCookie() {
  const { useCookies } = await chrome.storage.sync.get({ useCookies: true });
  if (!useCookies) return "";
  const cookies = await chrome.cookies.getAll({ domain: "youtube.com" });
  if (!cookies.some((c) => c.name === "SAPISID" || c.name === "__Secure-3PAPISID")) return "";
  return cookies.filter((c) => !c.partitionKey).map((c) => `${c.name}=${c.value}`).join("; ");
}

// ---------------------------------------------------------------- media sniffing (other sites)

const HLS = /mpegurl/i, DASH = /dash\+xml/i;
const SEGMENT = /\.(ts|m4s|aac|m4f|cmfv|cmfa)(?:$|[?#])|[?&](bytestart|range)=|\/(seg|segment|frag|chunk)[-_/]?\d/i;
const mediaKey = (tabId) => `media:${tabId}`;

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400 || /(^|\.)(youtube\.com|googlevideo\.com)$/.test(new URL(d.url).hostname)) return;
  const header = (n) => d.responseHeaders?.find((h) => h.name.toLowerCase() === n)?.value || "";
  const type = header("content-type");
  const path = new URL(d.url).pathname;
  let kind = null;
  if (HLS.test(type) || /\.m3u8$/i.test(path)) kind = "hls";
  else if (DASH.test(type) || /\.mpd$/i.test(path)) kind = "dash";
  else if (/^(video|audio)\//i.test(type) && !/mp2t|mpegts/i.test(type) && !SEGMENT.test(d.url)) kind = "file";
  if (!kind) return;
  const size = Number(header("content-range").split("/")[1] || header("content-length")) || 0;
  const entry = { url: d.url, kind, size, audio: /^audio\//i.test(type), time: Date.now() };
  const key = mediaKey(d.tabId);
  chrome.storage.session.get({ [key]: [] }, (s) => {
    const list = s[key].filter((m) => m.url !== d.url);
    list.push(entry);
    chrome.storage.session.set({ [key]: list.slice(-40) });
  });
}, { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] }, ["responseHeaders"]);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) chrome.storage.session.remove(mediaKey(tabId)); // new page
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(mediaKey(tabId)));

// ---------------------------------------------------------------- downloads (files)

async function downloadState(id) {
  const [d] = await chrome.downloads.search({ id });
  if (!d) return { state: "missing" };
  return { state: d.state, error: d.error, bytes: d.bytesReceived, total: d.totalBytes, filename: d.filename };
}

// ---------------------------------------------------------------- messages

// Let content scripts read download progress (for the floating progress bubble).
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

const FROM_PAGES = new Set(["download", "info", "list", "probe", "play", "cancel", "reveal", "clear", "ping"]);
const isYouTube = (url) => { try { return /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(url).hostname); } catch { return false; } };

async function fromPage(msg, sender) {
  const payload = { ...msg.payload };
  if (["download", "info", "list", "probe", "play"].includes(msg.type)) {
    if (isYouTube(payload.url)) {
      payload.cookies = await youtubeCookie();
      await setCookieRule(payload.cookies);
    } else if (!payload.direct && sender.tab?.id != null) {
      // Other sites: the media this tab loaded, and its title.
      const key = mediaKey(sender.tab.id);
      payload.media = (await chrome.storage.session.get({ [key]: [] }))[key];
      payload.title ||= sender.tab.title;
      if (msg.type === "download") await setRefererRule(sender.tab.url || payload.url);
    }
  }
  if (msg.type === "download") ({ parallel: payload.parallel } = await chrome.storage.sync.get({ parallel: 3 }));
  return toEngine(msg.type, payload);
}

async function fromEngine(msg) {
  switch (msg.type) {
    case "engine-ready":
      markReady?.();
      return { ok: true };
    case "jobs":
      await chrome.storage.session.set({ jobs: msg.jobs, dir: msg.dir });
      return { ok: true };
    case "saveUrl":
      try {
        const id = await chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: "uniquify", saveAs: false });
        return { id };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    case "downloadState":
      return downloadState(msg.id);
    case "cancelDownload":
      await chrome.downloads.cancel(msg.id).catch(() => {});
      return { ok: true };
    case "reveal":
      if (msg.id != null && (await downloadState(msg.id)).state === "complete") chrome.downloads.show(msg.id);
      else chrome.downloads.showDefaultFolder();
      return { ok: true };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let work;
  if (msg?.target === "bg") work = fromEngine(msg);
  else if (!msg?.target && FROM_PAGES.has(msg?.type)) work = fromPage(msg, sender);
  else return;
  work.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Right-click menu on any page, video or link.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ytdl-download",
    title: "Download video with YT Downloader",
    contexts: ["page", "video", "audio", "link"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "ytdl-download" || !tab?.id) return;
  const src = /^https?:/.test(info.srcUrl || "") ? info.srcUrl : "";
  chrome.tabs.sendMessage(tab.id, { type: "open-dialog", url: info.linkUrl || info.pageUrl || tab.url, src },
    { frameId: 0 }, () => void chrome.runtime.lastError);
});
