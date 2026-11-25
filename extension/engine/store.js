// Storage for the engine (offscreen document):
//   kv      - IndexedDB key/value: YouTube player JS + solver script caches (several MB per player version)
//   temp*   - Origin Private File System: streams being downloaded and files being muxed, on disk not in RAM

const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open("ytdl", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

function tx(mode, fn) {
  return dbp.then((db) => new Promise((resolve, reject) => {
    const t = db.transaction("kv", mode);
    const result = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(result.result ?? null);
    t.onerror = () => reject(t.error);
  }));
}

// Keys that belong to one YouTube player version start with its 8-hex id (optionally prefixed).
const PLAYER_KEY = /^(?:[a-z]+:)?([0-9a-f]{8})\./;

export const kv = {
  get: (key) => tx("readonly", (s) => s.get(key)),
  async set(key, value) {
    await tx("readwrite", (s) => s.put(value, key));
    // Old player versions' files (~6 MB each) are dropped, keeping the 3 most recently written:
    // YouTube hands out more than one version at a time, and a resolve may still be using another.
    const pid = PLAYER_KEY.exec(key)?.[1];
    if (!pid) return;
    const recent = [pid, ...((await kv.get("players")) || []).filter((p) => p !== pid)].slice(0, 3);
    await tx("readwrite", (s) => {
      s.put(recent, "players");
      const c = s.openKeyCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        const other = PLAYER_KEY.exec(String(cur.key))?.[1];
        if (other && !recent.includes(other)) s.delete(cur.key);
        cur.continue();
      };
      return c;
    });
  },
};

let tmpDir = null;
async function dir() {
  tmpDir ??= (await navigator.storage.getDirectory()).getDirectoryHandle("tmp", { create: true });
  return tmpDir;
}

let seq = 0;
// A new empty temp file: { name, handle }.
export async function tempFile(ext = "bin") {
  const name = `${Date.now().toString(36)}-${(seq++).toString(36)}.${ext}`;
  return { name, handle: await (await dir()).getFileHandle(name, { create: true }) };
}

export async function removeTemp(name) {
  try { await (await dir()).removeEntry(name); } catch {}
}

// Leftovers from a previous session (crash, browser closed mid-download).
export async function clearTemp() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("tmp", { recursive: true });
  } catch {}
  tmpDir = null;
}
