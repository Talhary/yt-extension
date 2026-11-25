"""Native messaging host for the YT Downloader extension. Wraps yt-dlp.

Chrome starts this automatically; it is registered by install.bat.
Requires yt-dlp and ffmpeg on PATH.
"""
import itertools, json, os, re, shutil, struct, subprocess, sys, tempfile, threading, time
import urllib.request
from urllib.parse import urlparse

OUT_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "YT-Downloader")
AUDIO_FORMATS = {"mp3", "m4a", "opus", "flac"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
COOKIE_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                          "YT-Downloader", "cookies")
JOBS = []
PROCS = {}  # job id -> [Popen, ...] (one per parallel worker)
COOKIE_TEXT = {}  # job id -> cookies.txt contents (kept out of JOBS, which is sent to the popup)
IDS = itertools.count(1)
OUT_LOCK = threading.Lock()


def private_dir():
    os.makedirs(COOKIE_DIR, exist_ok=True)
    return COOKIE_DIR


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with OUT_LOCK:
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()


def read():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


_last_push = 0.0


def push_jobs(force=False):
    # Throttle progress updates so we don't flood the extension.
    global _last_push
    now = time.time()
    if force or now - _last_push > 0.5:
        _last_push = now
        send({"type": "jobs", "dir": OUT_DIR, "jobs": JOBS[-20:]})


def check_url(url):
    # Any web page yt-dlp can handle. Only our extension can talk to this host
    # (allowed_origins in the host manifest), so we just reject non-web schemes.
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("not a web URL")


def js_runtime_args():
    # yt-dlp needs a JS runtime to get YouTube's full-speed streams; without one it falls
    # back to clients that get HTTP 403 after a few downloads. It only enables deno by
    # default, so point it at node when that's what is installed.
    if shutil.which("deno"):
        return []
    node = shutil.which("node")
    return ["--js-runtimes", f"node:{node}"] if node else []


LOG_FILE = os.path.join(os.path.dirname(COOKIE_DIR), "host.log")
# Cookies that mean "signed in" on common sites. Only their names are logged, never values.
LOGIN_COOKIES = {"sessionid", "SID", "__Secure-3PSID", "LOGIN_INFO", "c_user", "auth_token", "vuid"}


def log(text):
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
            os.replace(LOG_FILE, LOG_FILE + ".old")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except OSError:
        pass


def cookie_summary(text):
    rows = [l.split("\t") for l in (text or "").splitlines() if l and not l.startswith("#")]
    rows = [r for r in rows if len(r) >= 7]
    if not rows:
        return "no cookies"
    domains = sorted({r[0].lstrip(".") for r in rows})
    logins = sorted({r[5] for r in rows} & LOGIN_COOKIES)
    return f"{len(rows)} cookies for {', '.join(domains)}; login cookies: {', '.join(logins) or 'NONE'}"


def write_cookies(text):
    # The browser's YouTube cookies, so yt-dlp is signed in. One private temp file per
    # call because yt-dlp rewrites the file as it runs.
    if not text:
        return None
    fd, path = tempfile.mkstemp(suffix=".txt", dir=private_dir())
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def remove_file(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def cookie_args(path):
    return ["--cookies", path] if path else []


def build_cmd(job, part):
    # part: one worker's share of the job (its items or ids, and its own temp files).
    cmd = ["yt-dlp", "--newline", "--no-colors", "--ignore-errors", "-P", OUT_DIR,
           *js_runtime_args(), *cookie_args(part["cookies"]),
           "--retries", "10", "--fragment-retries", "10", "--retry-sleep", "http:exp=1:20",
           "--concurrent-fragments", "4"]
    if job["playlist"]:
        # Short pauses between items keep YouTube from throttling long playlists. Signed-in
        # requests are trusted more, so these can be brief; parallel workers do the rest.
        cmd += ["--sleep-requests", "0.25", "--sleep-interval", "1", "--max-sleep-interval", "3"]
    if part.get("ids"):
        # Explicit videos (from a Mix): download each one into a folder named after the list,
        # numbered by its position in the whole selection.
        folder = safe_name(job["title"] or "Mix", 100)
        cmd += ["--no-playlist", "--autonumber-start", str(part["start"]),
                "-o", f"{folder}/%(autonumber)03d - %(title).120B.%(ext)s"]
    elif job["playlist"]:
        cmd += ["--yes-playlist", "-o",
                "%(playlist_title,playlist_id|Playlist).100B/%(playlist_index)03d - %(title).120B.%(ext)s"]
        if part.get("items"):
            cmd += ["--playlist-items", ",".join(map(str, part["items"]))]
    else:
        cmd += ["--no-playlist", "-o", "%(title).120B [%(id).30B].%(ext)s"]
    # Windows rejects any single file name over 255 characters ("[Errno 22] Invalid
    # argument"). Titles can be a whole post's text, and for raw CDN links both the title
    # and the id are the 100+ character file name, so cap the parts and trim as a backstop.
    cmd += ["--trim-filenames", "180"]
    if job["mode"] == "audio":
        fmt = job["audio_format"]
        if fmt == "mp3":
            cmd += ["-f", "ba/b", "-x", "--audio-format", "mp3",
                    "--audio-quality", f"{job['audio_bitrate']}K", "--embed-thumbnail"]
        elif fmt == "m4a":
            cmd += ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"]
        elif fmt == "opus":
            cmd += ["-f", "ba[acodec=opus]/ba/b", "-x", "--audio-format", "opus"]
        else:
            cmd += ["-f", "ba/b", "-x", "--audio-format", "flac"]
        cmd += ["--embed-metadata"]
    else:
        # res uses the shorter side, so vertical videos match the same labels.
        # Prefer H.264/AAC at each resolution for the widest player support.
        # Quality 0 = "best available" (plain files and sites that don't list resolutions).
        sort = f"res:{job['quality']},vcodec:h264,acodec:aac" if job["quality"] > 0 else "vcodec:h264,acodec:aac"
        cmd += ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"]
    # Final path of every finished file (after merging/converting), for "show in folder".
    cmd += ["--print-to-file", "after_move:filepath", part["files"]]
    if part.get("ids"):
        cmd += [f"https://www.youtube.com/watch?v={i}" for i in part["ids"]]
    else:
        cmd.append(job["url"])
    return cmd


def safe_name(name, limit=150):
    # Usable as a Windows file/folder name.
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:limit] or "download"


CHROME_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")


def fetch_file(job, url, path, done_before, total):
    # Stream one direct media link to disk, updating overall progress; stops on cancel.
    req = urllib.request.Request(url, headers={"User-Agent": CHROME_UA})
    with urllib.request.urlopen(req, timeout=30) as r, open(path + ".part", "wb") as f:
        size = int(r.headers.get("Content-Length") or 0)
        got = 0
        while chunk := r.read(256 * 1024):
            if job["state"] == "cancelled":
                raise InterruptedError
            f.write(chunk)
            got += len(chunk)
            if size:
                job["progress"] = (done_before + got / size) / total * 100
                push_jobs()
    os.replace(path + ".part", path)


def run_direct(job):
    # Files whose direct links the extension already found (e.g. Instagram stories):
    # no yt-dlp needed, just download them.
    job["state"] = "downloading"
    folder = os.path.join(OUT_DIR, safe_name(job["title"] or "Download", 100))
    os.makedirs(folder, exist_ok=True)
    job["folder"] = folder
    total = len(job["direct"])
    for i, item in enumerate(job["direct"], 1):
        if job["state"] == "cancelled":
            break
        job["item"] = f"{i}/{total}"
        path = os.path.join(folder, safe_name(item["name"]))
        try:
            if not os.path.exists(path):
                fetch_file(job, item["url"], path, i - 1, total)
            job["path"] = path
        except InterruptedError:
            remove_file(path + ".part")
            break
        except Exception as e:
            remove_file(path + ".part")
            job["failed"] += 1
            job["error"] = f"{item['name']}: {e}"[:200]
            log(f"download #{job['id']} item {i} failed: {e}")
        push_jobs(True)
    if job["state"] != "cancelled":
        job["state"] = "error" if job["failed"] == total else "done"
        if job["failed"] and job["state"] == "done":
            job["error"] = f"{job['failed']} item(s) failed · last: {job['error']}"
        if job["state"] == "done":
            job["progress"] = 100
    log(f"download #{job['id']} {job['state']}" + (f": {job['error']}" if job["error"] else ""))
    push_jobs(True)


def run(job):
    if job["direct"]:
        return run_direct(job)
    job["state"] = "downloading"
    push_jobs(True)
    cookie_text = COOKIE_TEXT.pop(job["id"], None)

    # Playlists are split into contiguous chunks, each downloaded by its own yt-dlp
    # process at the same time. Single videos (or lists of unknown length) use one.
    if job["ids"]:
        parts = [{"ids": chunk, "start": start + 1} for start, chunk in split(job["ids"], job["parallel"])]
        total = len(job["ids"])
    elif job["playlist"] and job["count"]:
        indices = job["items"] or list(range(1, job["count"] + 1))
        parts = [{"items": chunk} for _, chunk in split(indices, job["parallel"])]
        total = len(indices)
    else:
        parts = [{"items": job["items"]}]
        total = 0  # learned from yt-dlp's "item i of n" output

    for part in parts:
        # Own cookie and file-list copies per process: yt-dlp rewrites the cookie file.
        part.update(cookies=write_cookies(cookie_text), started=0, pct=0.0,
                    n=len(part.get("ids") or part.get("items") or []))
        fd, part["files"] = tempfile.mkstemp(suffix=".txt", dir=private_dir())
        os.close(fd)
        try:
            part["proc"] = subprocess.Popen(build_cmd(job, part), stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                            encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
        except FileNotFoundError:
            job["state"], job["error"] = "error", "yt-dlp not found on PATH"
            break
    workers = [p for p in parts if "proc" in p]
    PROCS[job["id"]] = [w["proc"] for w in workers]
    thumbs = set()
    readers = [threading.Thread(target=read_worker, args=(job, w, workers, total, thumbs), daemon=True)
               for w in workers]
    for t in readers:
        t.start()
    for t in readers:
        t.join()
    for w in workers:
        w["proc"].wait()
    PROCS.pop(job["id"], None)

    paths = []
    for part in parts:
        remove_file(part["cookies"])
        try:
            with open(part["files"], encoding="utf-8") as f:
                paths += [l.strip() for l in f if l.strip()]
        except OSError:
            pass
        remove_file(part["files"])
    if paths:
        job["path"] = paths[-1]
        job["folder"] = os.path.dirname(paths[-1])
    # yt-dlp saves the cover image before the audio; if the audio then fails the
    # image is left behind on its own. Successful embeds already removed theirs.
    for t in thumbs:
        remove_file(t)

    if job["state"] not in ("cancelled", "error"):
        ok = workers and all(w["proc"].returncode == 0 for w in workers)
        job["state"] = "done" if ok else "error"
        if job["playlist"] and job["failed"]:
            # --ignore-errors keeps going, so a playlist with a few bad items is still "done".
            count = total or sum(w["n"] for w in workers)
            job["state"] = "error" if count and job["failed"] >= count else "done"
            job["error"] = f"{job['failed']} item(s) failed · last: {job['error']}"
        if job["state"] == "done":
            job["progress"] = 100
    log(f"download #{job['id']} {job['state']} ({len(workers)} worker(s))"
        + (f": {job['error']}" if job["error"] else ""))
    push_jobs(True)


def split(seq, n):
    # seq into up to n contiguous chunks of near-equal size, with each chunk's start offset.
    n = max(1, min(n, len(seq)))
    size, extra = divmod(len(seq), n)
    out, start = [], 0
    for i in range(n):
        end = start + size + (1 if i < extra else 0)
        out.append((start, seq[start:end]))
        start = end
    return out


WORKER_LOCK = threading.Lock()


def read_worker(job, w, workers, total, thumbs):
    for line in w["proc"].stdout:
        line = line.strip()
        with WORKER_LOCK:
            m = re.search(r"Downloading item (\d+) of (\d+)", line)
            if w.get("ids") and line.startswith("[youtube] Extracting URL:"):
                # A list of URLs prints no "item i of n", so count each one starting instead.
                w["started"] += 1
                w["pct"] = 0.0
            elif m and not w.get("ids"):
                w["started"], w["pct"] = int(m.group(1)), 0.0
                if not total:
                    w["n"] = int(m.group(2))
            m = re.search(r"\[download\]\s+([\d.]+)%", line)
            if m:
                w["pct"] = float(m.group(1))
            m = re.search(r"\[download\] Destination: (.+)", line)
            if m:
                job["folder"] = os.path.dirname(m.group(1))
                if not job["playlist"]:
                    job["title"] = os.path.splitext(os.path.basename(m.group(1)))[0]
            m = re.search(r"Writing video thumbnail .* to: (.+)$", line)
            if m:
                thumbs.add(m.group(1))
            if line.startswith("ERROR"):
                job["failed"] += 1
                job["error"] = line[7:300]
            if job["playlist"]:
                # Progress across the whole list: finished items plus the ones in flight.
                count = total or sum(x["n"] for x in workers) or 1
                done = sum(max(x["started"] - 1, 0) + x["pct"] / 100 for x in workers)
                job["progress"] = min(done / count * 100, 100)
                job["item"] = f"{min(sum(x['started'] for x in workers), count)}/{count}"
            else:
                job["progress"] = w["pct"]
        push_jobs()


def start_download(msg):
    url = msg.get("url", "")
    check_url(url)
    items = [int(i) for i in msg.get("items") or []]
    ids = [i for i in msg.get("ids") or [] if re.fullmatch(r"[\w-]{11}", str(i))]
    direct = []
    for d in msg.get("direct") or []:
        check_url(d.get("url", ""))
        direct.append({"url": d["url"], "name": str(d.get("name") or "file")})
    audio_format = msg.get("audioFormat") if msg.get("audioFormat") in AUDIO_FORMATS else "mp3"
    job = {"id": next(IDS), "url": url, "mode": "audio" if msg.get("mode") == "audio" else "video",
           "playlist": bool(msg.get("playlist")), "items": items, "ids": ids, "direct": direct,
           "quality": int(msg.get("quality", 1080)),
           "audio_format": audio_format, "audio_bitrate": int(msg.get("audioBitrate", 320)),
           "state": "queued", "progress": 0, "title": msg.get("title") or "", "item": "", "error": "",
           "failed": 0, "path": "", "folder": "",
           # Playlist length (from the dialog's list) and how many items to fetch at once.
           "count": int(msg.get("count") or 0), "parallel": max(1, min(int(msg.get("parallel") or 3), 6))}
    log(f"download #{job['id']} {job['mode']} {url[:150]} ({cookie_summary(msg.get('cookies'))})")
    if not direct:  # direct links are pre-signed; they need neither cookies nor yt-dlp
        COOKIE_TEXT[job["id"]] = msg.get("cookies")
    JOBS.append(job)
    threading.Thread(target=run, args=(job,), daemon=True).start()


def cancel(job_id):
    job = next((j for j in JOBS if j["id"] == job_id), None)
    if not job or job["state"] not in ("queued", "downloading"):
        return
    job["state"] = "cancelled"
    for p in PROCS.get(job_id, []):
        # /T also kills the ffmpeg children yt-dlp started.
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       capture_output=True, creationflags=NO_WINDOW)


def reveal(job_id):
    # Open Explorer at the download: the file selected for a single video, the folder for
    # a playlist (or for a single video that hasn't finished yet).
    job = next((j for j in JOBS if j["id"] == job_id), None)
    path = job and job.get("path")
    if path and os.path.exists(path) and not job["playlist"]:
        subprocess.Popen(f'explorer /select,"{path}"')
        return
    folder = (job and job.get("folder")) or OUT_DIR
    os.startfile(folder if os.path.isdir(folder) else OUT_DIR)


def clear_finished():
    JOBS[:] = [j for j in JOBS if j["state"] in ("queued", "downloading")]


def ytdlp_json(msg, *args):
    cookies = write_cookies(msg.get("cookies"))
    try:
        out = subprocess.run(["yt-dlp", "-J", *js_runtime_args(), *cookie_args(cookies), *args],
                             stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    finally:
        remove_file(cookies)
    if out.returncode != 0:
        errors = [l for l in out.stderr.strip().splitlines() if l.startswith("ERROR")]
        log("  yt-dlp failed: " + " | ".join(errors or out.stderr.strip().splitlines()[-3:])[:600])
        raise RuntimeError((out.stderr.strip().splitlines() or ["yt-dlp failed"])[-1][:160])
    return json.loads(out.stdout)


def describe_video(data):
    # Available resolutions with rough sizes, for the quality picker.
    formats = data.get("formats") or [data]
    size = lambda f: f.get("filesize") or f.get("filesize_approx") or 0
    audio = max((size(f) for f in formats
                 if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")), default=0)
    heights = {}
    for f in formats:
        w, h = f.get("width"), f.get("height")
        if f.get("vcodec") == "none" or not h:
            continue
        res = min(w, h) if w else h
        if res >= 144:
            heights[res] = max(heights.get(res, 0), size(f))
    # Unknown codecs (plain .mp4 links etc.) count as video; only "none" means audio-only.
    has_video = bool(heights) or any(f.get("vcodec") != "none" for f in formats)
    return {
        "kind": "video", "title": data.get("title"),
        "uploader": data.get("uploader") or data.get("channel") or data.get("extractor_key"),
        "duration": data.get("duration"), "thumbnail": data.get("thumbnail"), "audioSize": audio,
        "hasVideo": has_video,
        "heights": [{"h": h, "size": (s + audio) if s else 0} for h, s in sorted(heights.items(), reverse=True)],
    }


def describe_list(data):
    return {
        "kind": "playlist", "title": data.get("title") or "Playlist",
        "entries": [{"index": i, "id": e.get("id"), "title": e.get("title") or e.get("id") or f"Item {i}",
                     "duration": e.get("duration")}
                    for i, e in enumerate(data.get("entries") or [], 1)],
    }


def answer(msg, fn):
    log(f"{msg.get('type')} {msg.get('url', '')[:150]} ({cookie_summary(msg.get('cookies'))})")
    reply = {"type": "reply", "id": msg.get("id"), "ok": True}
    try:
        check_url(msg.get("url", ""))
        reply.update(fn(msg["url"]))
    except Exception as e:
        reply.update(ok=False, error=str(e))
    send(reply)


def video_info(msg):
    answer(msg, lambda url: describe_video(ytdlp_json(msg, "--no-playlist", url)))


def list_playlist(msg):
    answer(msg, lambda url: describe_list(ytdlp_json(msg, "--flat-playlist", "--yes-playlist", url)))


def probe(msg):
    # Any site: find out whether the page is a single video or a list of them.
    def run_probe(url):
        data = ytdlp_json(msg, "--flat-playlist", url)
        if data.get("_type") in ("playlist", "multi_video") and data.get("entries"):
            entries = list(data["entries"])
            if len(entries) > 1:
                return describe_list(data)
            # A "list" of one is just a video; look that one up properly.
            one = entries[0]
            return describe_video(ytdlp_json(msg, "--no-playlist", one.get("url") or url)
                                  if one.get("_type") == "url" else one)
        return describe_video(data)
    answer(msg, run_probe)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    while True:
        msg = read()
        if msg is None:
            break  # Chrome closed the connection
        kind = msg.get("type")
        # These call yt-dlp and take a few seconds, so answer from a thread.
        handler = {"list": list_playlist, "info": video_info, "probe": probe}.get(kind)
        if handler:
            threading.Thread(target=handler, args=(msg,), daemon=True).start()
            continue
        reply = {"type": "reply", "id": msg.get("id"), "ok": True, "dir": OUT_DIR}
        try:
            if kind == "download":
                start_download(msg)
            elif kind == "cancel":
                cancel(int(msg.get("jobId")))
            elif kind == "reveal":
                reveal(int(msg.get("jobId")))
            elif kind == "clear":
                clear_finished()
        except Exception as e:
            reply.update(ok=False, error=str(e))
        send(reply)
        push_jobs(True)


if __name__ == "__main__":
    main()
