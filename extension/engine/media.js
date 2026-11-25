// Muxing and conversion with mediabunny (vendor/, MPL-2.0). Nothing is re-encoded unless the target format
// needs it: video is always copied; audio is copied for M4A/Opus when the source already has that codec,
// and encoded for MP3 (LAME, WASM) and FLAC (libFLAC, WASM).
import {
  ALL_FORMATS, BlobSource, Conversion, FlacOutputFormat, Input, Mp3OutputFormat, Mp4OutputFormat, OggOutputFormat,
  Output, StreamTarget, UrlSource,
} from "../vendor/mediabunny.mjs";
import { registerMp3Encoder } from "../vendor/mp3-encoder.mjs";
import { registerFlacEncoder } from "../vendor/flac-encoder.mjs";

registerMp3Encoder();
registerFlacEncoder();

export const AUDIO = {
  mp3: { ext: "mp3", codec: "mp3", format: () => new Mp3OutputFormat() },
  m4a: { ext: "m4a", codec: "aac", format: () => new Mp4OutputFormat({ fastStart: false }) },
  opus: { ext: "opus", codec: "opus", format: () => new OggOutputFormat() },
  flac: { ext: "flac", codec: "flac", format: () => new FlacOutputFormat() },
};

export const fileInput = (file) => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
export const urlInput = (url, fetchFn) => new Input({
  source: new UrlSource(url, { fetchFn, parallelism: 4, requestInit: { credentials: "include" } }),
  formats: ALL_FORMATS,
});

async function outputTo(handle, format) {
  // chunked: batch the muxer's many small writes into 8 MiB ones (each OPFS write is a round trip)
  return new Output({ format, target: new StreamTarget(await handle.createWritable(), { chunked: true, chunkSize: 8 << 20 }) });
}

// Runs conversions on `output`, cancelling them when `signal` aborts.
async function run(output, conversions, signal, onProgress) {
  const cancel = () => { for (const c of conversions) c.cancel(); output.cancel(); };
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (conversions.length === 1) {
      conversions[0].onProgress = (p) => onProgress?.(p);
      await conversions[0].execute();
    } else {
      const prog = conversions.map(() => 0);
      conversions.forEach((c, i) => { c.onProgress = (p) => { prog[i] = p; onProgress?.(Math.min(...prog)); }; });
      await output.start();
      await Promise.all(conversions.map((c) => c.execute()));
      await output.finalize();
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw e;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function checkValid(conv, what) {
  if (conv.isValid) return;
  const why = conv.discardedTracks.filter((d) => d.reason !== "discarded_by_user")
    .map((d) => `${d.track.type} ${d.track.codec || "?"}: ${d.reason}`).join(", ");
  throw new Error(`Can't ${what}${why ? ` (${why})` : ""}`);
}

// Separate video and audio streams (YouTube adaptive formats) -> one MP4. Copies both, no re-encoding.
export async function mux(videoFile, audioFile, outHandle, { tags, signal, onProgress } = {}) {
  const vIn = fileInput(videoFile), aIn = fileInput(audioFile);
  try {
    const output = await outputTo(outHandle, new Mp4OutputFormat({ fastStart: false }));
    output.setMetadataTags(tags || {});
    const opts = { output, composable: true, showWarnings: false };
    const cv = await Conversion.init({ ...opts, input: vIn, audio: { discard: true } });
    const ca = await Conversion.init({ ...opts, input: aIn, video: { discard: true } });
    await run(output, [cv, ca], signal, onProgress);
  } finally {
    vIn.dispose(); aIn.dispose();
  }
}

// One input (file or HLS) -> MP4 with the chosen video track and an audio track that plays with it.
export async function toMp4(input, outHandle, { videoTrack, tags, signal, onProgress } = {}) {
  const vt = videoTrack || await input.getPrimaryVideoTrack();
  const at = vt ? (await vt.getPairableAudioTracks())[0] || await input.getPrimaryAudioTrack() : await input.getPrimaryAudioTrack();
  const output = await outputTo(outHandle, new Mp4OutputFormat({ fastStart: false }));
  const conv = await Conversion.init({
    input, output, tracks: "all", showWarnings: false, tags: tags || {},
    video: (t) => (vt && t.id === vt.id ? {} : { discard: true }),
    audio: (t) => (at && t.id === at.id ? {} : { discard: true }),
  });
  checkValid(conv, "save this video as MP4");
  await run(output, [conv], signal, onProgress);
}

// Audio only, in `kind` (mp3 | m4a | opus | flac). bitrate in kbps (MP3).
export async function toAudio(input, outHandle, kind, { bitrate, tags, signal, onProgress } = {}) {
  const spec = AUDIO[kind];
  const at = await input.getPrimaryAudioTrack();
  if (!at) throw new Error("No audio in this video");
  const output = await outputTo(outHandle, spec.format());
  const audio = { codec: spec.codec };
  if (kind === "mp3") audio.bitrate = (bitrate || 320) * 1000;
  const conv = await Conversion.init({
    input, output, tracks: "all", showWarnings: false, tags: tags || {},
    video: { discard: true },
    audio: (t) => (t.id === at.id ? audio : { discard: true }),
  });
  checkValid(conv, `convert the audio to ${kind.toUpperCase()}`);
  await run(output, [conv], signal, onProgress);
}

// Cover image for tags: { data, mimeType, kind }.
export async function coverImage(urls, fetchFn = fetch) {
  for (const url of urls.filter(Boolean)) {
    try {
      const r = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.length < 2000) continue; // YouTube's 120x90 "no thumbnail" placeholder
      return { data, mimeType: r.headers.get("content-type")?.split(";")[0] || "image/jpeg", kind: "coverFront" };
    } catch {}
  }
  return null;
}
