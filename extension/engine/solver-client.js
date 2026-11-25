// Talks to the solver running in the sandboxed iframe (solver/sandbox.html). Same interface as
// solver.js's createSolver(): solve(pid, loadPlayer, ns, sigs).
import { kv } from "./store.js";

export function createSolverClient() {
  const frame = document.createElement("iframe");
  frame.src = "/solver/sandbox.html";
  frame.hidden = true;
  document.body.append(frame);

  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  const calls = new Map();
  const loaders = new Map(); // pid -> () => Promise<player js text>
  let nextCall = 1;

  window.addEventListener("message", async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.ready) return markReady();
    if (m.log) return console.log("[solver]", m.log);
    if (m.rpc) {
      const c = calls.get(m.rpc);
      calls.delete(m.rpc);
      if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.result);
      return;
    }
    if (m.req) { // the solver asks for its cache or the player source
      let result = null, error;
      try {
        if (m.op === "cacheGet") result = await kv.get("solver:" + m.key);
        else if (m.op === "cacheSet") await kv.set("solver:" + m.key, m.value);
        else if (m.op === "player") result = await loaders.get(m.pid)();
      } catch (err) {
        error = String(err?.message || err);
      }
      frame.contentWindow.postMessage({ reply: m.req, result, error }, "*");
    }
  });

  const call = async (msg) => {
    await ready;
    return new Promise((resolve, reject) => {
      const rpc = nextCall++;
      calls.set(rpc, { resolve, reject });
      frame.contentWindow.postMessage({ ...msg, rpc }, "*");
    });
  };

  let init = null;
  const ensureInit = () => (init ??= (async () => {
    const [lib, core, solverSrc] = await Promise.all(["ejs/lib.min.js", "ejs/core.min.js", "solver.js"]
      .map((f) => fetch("/solver/" + f).then((r) => r.text())));
    await call({ op: "init", lib, core, solverSrc });
  })().catch((e) => { init = null; throw e; }));

  return {
    async solve(pid, loadPlayer, ns, sigs) {
      await ensureInit();
      loaders.set(pid, loadPlayer);
      return call({ op: "solve", pid, ns, sigs });
    },
  };
}
