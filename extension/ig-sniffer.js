// Runs in Instagram's own page context (world: MAIN). Instagram refuses story requests
// made from outside its web app, so instead of asking for stories ourselves we keep a copy
// of the story data the page loads to display them, and hand it to content.js.
(() => {
  const WANTED = /\/graphql|\/api\/v1\//;
  const share = (text) => {
    if (text && text.includes("image_versions2")) {
      window.postMessage({ source: "ytdl-ig", text }, location.origin);
    }
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (WANTED.test(url)) res.clone().text().then(share, () => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (WANTED.test(String(url))) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") share(this.responseText);
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
