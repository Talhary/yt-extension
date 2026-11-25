# YT Downloader

Chrome extension that adds download buttons on YouTube and YouTube Music
(a hover icon on thumbnails/song rows, and a button in the player and on playlist pages) with
video (MP4), audio (MP3 / M4A / Opus / FLAC) and whole-playlist downloads, plus a Download button
on videos on other sites.

**Standalone:** everything runs inside the extension. No Python, yt-dlp, ffmpeg or helper app.

## Install
Chrome -> `chrome://extensions` -> enable Developer mode -> Load unpacked -> pick the `extension` folder.

Files are saved to `Downloads\YT-Downloader` (playlists get their own folder).

## Use
- Hover a thumbnail or song row -> click the download icon
- On a video/song/playlist page -> the Download button -> Video, Audio, or the whole playlist
- Other sites: start playing the video, then use the Download button on it (or right-click -> Download video)
- Toolbar popup -> progress, cancel, show in folder, options

## How it works
| part | what |
|---|---|
| `content.js`, `popup.*` | the buttons, download dialog, progress bubble and popup |
| `background.js` | service worker: routes requests to the engine, reads your YouTube login (option "Use my login"), header rules, saves files via `chrome.downloads`, notes the media each tab loads (other sites) |
| `offscreen.html`, `engine/` | the engine, in a hidden extension page: jobs, YouTube, other sites, muxing/converting |
| `engine/ytp.js` | YouTube stream resolver (JS port of yt-parser, see `yt-parser-src/js`) |
| `solver/` | YouTube's n/sig challenge solver (yt-dlp EJS), in a sandboxed page because it needs `eval` |
| `vendor/` | [mediabunny](https://mediabunny.dev) (MPL-2.0): MP4/Ogg/MP3/FLAC muxing, HLS input, LAME + libFLAC encoders (WASM) |

- YouTube: video and audio streams are downloaded separately in 10 MiB ranges, then merged into an MP4 without
  re-encoding (H.264 preferred up to 1080p, VP9/AV1 above). M4A/Opus are copied as-is, MP3/FLAC are encoded.
  Age-restricted videos and your own private lists (Liked videos...) work when "Use my login" is on and
  you're signed in to YouTube in this browser.
- Other sites: the extension downloads the media the page itself loaded: a plain video/audio file, or an
  HLS stream (any quality it offers, converted to MP4). DASH-only and DRM-protected sites are not supported.
- Instagram stories/highlights: read from the page itself, saved as the original files.

## Updating the bundled code
`node tools/vendor.mjs` refreshes `vendor/` (mediabunny from npm, patched to load its workers from files,
which Manifest V3 requires) and copies `engine/ytp.js`, `solver/solver.js` and `solver/ejs/` from
`yt-parser-src` (`YTP_SRC`, default `D:\yt-client\third_party\yt-parser-src`). YouTube client versions drift:
when downloads start failing, update `ytp.js` there and re-run this.

## Leftovers from version 1
The `host` folder (native helper wrapping yt-dlp) is no longer used. Run `host\uninstall.bat` once to
unregister it, then the folder can be deleted.
