// Copies third-party code into extension/ (run after updating any of it):
//
//   node tools/vendor.mjs
//
// 1. mediabunny + its MP3/FLAC encoders (MPL-2.0) from npm -> extension/vendor/
//    Patched for Manifest V3, whose CSP forbids blob: workers: the encoders' inline worker is written out as a
//    file and loaded from there, and mediabunny's blob-worker timers are switched to native timers.
// 2. The YouTube resolver (ytp.js), n/sig solver (solver.js) and yt-dlp EJS from yt-parser-src
//    (YTP_SRC, default D:\yt-client\third_party\yt-parser-src) -> extension/engine/ and extension/solver/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEDIABUNNY = "1.66.2";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const ytpSrc = process.env.YTP_SRC || "D:/yt-client/third_party/yt-parser-src";

function patch(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`patch "${label}" no longer applies - check the new version`);
  return text.replace(from, to);
}

// ---- mediabunny
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediabunny-"));
const pkgs = ["mediabunny", "@mediabunny/mp3-encoder", "@mediabunny/flac-encoder"].map((p) => `${p}@${MEDIABUNNY}`);
execFileSync("npm", ["pack", ...pkgs, "--silent"], { cwd: tmp, shell: process.platform === "win32" });
const unpack = (tgz) => {
  const dir = path.join(tmp, tgz.replace(/\.tgz$/, ""));
  fs.mkdirSync(dir);
  // relative paths: GNU tar (Git for Windows) reads "C:..." as a remote host
  execFileSync("tar", ["-xzf", path.join("..", tgz)], { cwd: dir });
  return path.join(dir, "package");
};
const tgz = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
const dirOf = (name) => unpack(tgz.find((f) => f.startsWith(name)));

const vendor = path.join(ext, "vendor");
fs.mkdirSync(vendor, { recursive: true });
const mb = dirOf("mediabunny-" + MEDIABUNNY);
let core = fs.readFileSync(path.join(mb, "dist/bundles/mediabunny.mjs"), "utf8");
core = patch(core, 'var shouldUseNativeTimers = () => {\n  return typeof window === "undefined";\n};',
  "var shouldUseNativeTimers = () => true; // patched: MV3 CSP blocks the blob: timer worker", "native timers");
fs.writeFileSync(path.join(vendor, "mediabunny.mjs"), core);
fs.copyFileSync(path.join(mb, "LICENSE"), path.join(vendor, "LICENSE-mediabunny.txt"));

for (const name of ["mp3", "flac"]) {
  const dir = dirOf(`mediabunny-${name}-encoder-`);
  let src = fs.readFileSync(path.join(dir, `dist/bundles/mediabunny-${name}-encoder.mjs`), "utf8");
  const line = src.split("\n").find((l) => l.trimStart().startsWith("return inlineWorker('"));
  if (!line) throw new Error(`${name}: inline worker not found`);
  const literal = line.trim().replace(/^return inlineWorker\(/, "").replace(/, cache\);$/, "");
  const workerCode = new Function(`return ${literal};`)();
  fs.writeFileSync(path.join(vendor, `${name}-encoder.worker.js`), workerCode);
  src = patch(src, line, `  return new Worker(new URL("./${name}-encoder.worker.js", import.meta.url)); // patched: no blob: workers in MV3`, `${name} worker`);
  src = src.replaceAll('from "mediabunny"', 'from "./mediabunny.mjs"');
  fs.writeFileSync(path.join(vendor, `${name}-encoder.mjs`), src);
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---- resolver, solver, EJS
fs.copyFileSync(path.join(ytpSrc, "js/ytp.js"), path.join(ext, "engine/ytp.js"));
fs.mkdirSync(path.join(ext, "solver/ejs"), { recursive: true });
fs.copyFileSync(path.join(ytpSrc, "js/solver.js"), path.join(ext, "solver/solver.js"));
for (const f of ["lib.min.js", "core.min.js", "LICENSE"]) fs.copyFileSync(path.join(ytpSrc, "ejs", f), path.join(ext, "solver/ejs", f));

console.log("vendored mediabunny", MEDIABUNNY, "+ ytp.js / solver.js / EJS from", ytpSrc);
