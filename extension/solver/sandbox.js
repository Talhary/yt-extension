// Runs solver.js (the n/sig solver, an ES module) inside this sandboxed page. The engine sends the code
// itself on "init": a sandboxed page has an opaque origin, so it can't import extension modules.
// Requests from the solver for its cache and the player JS go back to the engine.
(() => {
  let solver = null;
  let nextReq = 1;
  const waiting = new Map();

  const ask = (op, args) => new Promise((resolve, reject) => {
    const req = nextReq++;
    waiting.set(req, { resolve, reject });
    parent.postMessage({ req, op, ...args }, "*");
  });

  async function handle(msg) {
    if (msg.op === "init") {
      if (!solver) {
        const createSolver = new Function(msg.solverSrc.replace(/^export\s+function\s+createSolver/m, "function createSolver")
          + "\nreturn createSolver;")();
        solver = createSolver({
          lib: msg.lib, core: msg.core,
          cache: { get: (key) => ask("cacheGet", { key }), set: (key, value) => ask("cacheSet", { key, value }) },
          log: (text) => parent.postMessage({ log: text }, "*"),
        });
      }
      return true;
    }
    if (msg.op === "solve") return solver.solve(msg.pid, () => ask("player", { pid: msg.pid }), msg.ns, msg.sigs);
    throw new Error("unknown op " + msg.op);
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== parent) return;
    const msg = e.data || {};
    if (msg.reply) { // answer to one of our requests
      const w = waiting.get(msg.reply);
      waiting.delete(msg.reply);
      if (w) msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
      return;
    }
    try {
      parent.postMessage({ rpc: msg.rpc, result: await handle(msg) }, "*");
    } catch (err) {
      parent.postMessage({ rpc: msg.rpc, error: String(err?.message || err) }, "*");
    }
  });
  parent.postMessage({ ready: true }, "*");
})();
