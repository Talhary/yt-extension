// solver.js - n / sig challenge solver: yt-dlp EJS (../ejs, Unlicense) on the host's own JS engine.
//
// The Go port needed a hand-written preprocessor + script slimming because goja is slow. Here V8 runs EJS
// directly: the player is preprocessed once per player version (~0.5 s), the result is cached, and the
// compiled n/sig functions stay alive in memory, so later solves cost microseconds.
//
// Needs dynamic code (new Function): fine in Node and normal pages. In a Manifest V3 extension run it in a
// sandboxed page (manifest "sandbox") - see README.
//
//   const solver = createSolver({ lib: <ejs/lib.min.js text>, core: <ejs/core.min.js text>, cache });
//   await solver.solve(pid, async () => playerJsText, ["n1", ...], ["sig1", ...]);  // -> {n1: "...", sig1: "..."}

// Must match what the cached script was built with; bump to invalidate old caches.
const FORMAT = "ejs1";

export function createSolver({ lib, core, cache, log = () => {} }) {
  let jsc = null;
  const live = new Map(); // pid -> Promise<{n, sig}>

  // Every piece of player code runs in its own fake global environment: EJS's prelude assigns
  // globalThis.location / window / document..., which in a real page would navigate it away (killing the
  // solver) or clobber globals. A Proxy rather than Object.create(globalThis): in a browser, window's getters
  // and methods (setTimeout, ...) throw "Illegal invocation" unless called on the real window, so reads go to
  // it and native functions are bound. Same environment EJS gets under Node/Deno: no DOM, a fake location.
  const NAMES = ["globalThis", "window", "self", "document", "navigator", "location", "XMLHttpRequest"];
  function makeEnv() {
    const own = Object.create(null);
    const bound = new Map();
    const fake = new Proxy(own, {
      get(t, k) {
        if (k in t) return t[k];
        const v = Reflect.get(globalThis, k, globalThis);
        if (typeof v !== "function" || "prototype" in v) return v; // plain values, constructors/classes
        if (!bound.has(k)) bound.set(k, v.bind(globalThis));
        return bound.get(k);
      },
      set(t, k, v) { t[k] = v; return true; },
      has(t, k) { return k in t || k in globalThis; },
    });
    Object.assign(own, {
      window: fake, self: fake, globalThis: fake, document: Object.create(null),
      navigator: globalThis.navigator ?? Object.create(null),
      location: new URL("https://www.youtube.com/watch?v=yt-dlp-wins"),
      XMLHttpRequest: globalThis.XMLHttpRequest ?? { prototype: {} },
    });
    return fake;
  }

  // new Function(...params, body) whose code sees `fake` as its global object (also as `this`, which the
  // player's top-level code reads as the global).
  function fakeFunction(fake) {
    return function (...params) {
      const body = params.pop();
      const f = new Function(...NAMES, ...params, body);
      return function (...args) { return f.call(fake, fake, ...NAMES.slice(1).map((k) => fake[k]), ...args); };
    };
  }

  function ejs() {
    // lib.min.js defines `var lib` (meriyah + astring); core.min.js defines `var jsc` from them. jsc runs the
    // preprocessed player itself (with Function), so it gets the fake environment's Function.
    jsc ??= new Function("Function", `${lib}
;var meriyah=lib.meriyah,astring=lib.astring;
${core}
;return jsc;`)(fakeFunction(makeEnv()));
    return jsc;
  }

  // Runs the preprocessed player in a fresh fake environment and returns its n/sig functions.
  function instantiate(script) {
    const result = { n: null, sig: null };
    fakeFunction(makeEnv())("_result", script)(result);
    if (typeof result.n !== "function" || typeof result.sig !== "function") throw new Error("n/sig function missing");
    return result;
  }

  async function build(pid, loadPlayer) {
    const cacheKey = `${pid}.solver.${FORMAT}.js`;
    const cached = cache && (await cache.get(cacheKey));
    if (cached) {
      try { return instantiate(cached); } catch (e) { log(`solver: cached script failed (${e.message}), rebuilding`); }
    }
    const player = await loadPlayer();
    const t0 = Date.now();
    const out = ejs()({ type: "player", player, output_preprocessed: true, requests: [] });
    const script = out.preprocessed_player;
    if (!script) throw new Error("EJS returned no preprocessed player");
    const fns = instantiate(script);
    log(`solver: preprocessed player ${pid} in ${Date.now() - t0} ms (${script.length >> 10} KiB)`);
    if (cache) await cache.set(cacheKey, script);
    return fns;
  }

  return {
    async solve(pid, loadPlayer, ns = [], sigs = []) {
      if (!live.has(pid)) {
        const p = build(pid, loadPlayer);
        live.set(pid, p);
        p.catch(() => live.delete(pid));
      }
      const fns = await live.get(pid);
      const out = {};
      for (const [f, list] of [[fns.n, ns], [fns.sig, sigs]]) {
        for (const c of list) {
          const v = f(c);
          if (v == null) throw new Error(`solve ${c.slice(0, 12)}: no answer`);
          out[c] = String(v);
        }
      }
      return out;
    },
  };
}
