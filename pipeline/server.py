# The on-demand backend: type any RA/Dec into Celestial Navigator and get real SPHEREx
# blink frames for it. Standard library only, so it runs with the pipeline's own Python:
#
#   pipeline/.venv/bin/python pipeline/server.py        then, in another terminal: npm run dev
#
# The Vite dev server forwards /api and /media here (port 8000). Endpoints:
#
#   GET /api/health               {"ok": true}: lets the app tell "backend not running" apart
#   GET /api/status?ra=&dec=      instant: {"status": "none" | "processing" | "ready" | "failed"}
#   GET /api/scout?ra=&dec=       what SPHEREx has at the spot (scout.py), plus any job's status
#   GET /api/passes?ra=&dec=      200 + PassesResponse when processed; otherwise starts a job and
#                                 answers 202 {"status": "processing", "stage", "progress"}; poll
#                                 it. 500 {"status": "failed", "message"} if the job failed
#                                 (add &retry=1 to try again).
#   GET /media/<spot id>/<file>   the PNGs a job produced
#
# Each spot is processed once by run.py in its own process (at most two at a time, never the
# same spot twice at once) and cached forever in pipeline/data/media/<id>/. Its log, which
# doubles as the failure log, is pipeline/data/spots/<id>/log.txt.
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from config import MEDIA, PIPELINE, REPO, SPOT_MAX_PER_BAND, SPOTS, spot_id

PORT = int(os.environ.get("PORT", "8000"))
MAX_JOBS = 2
JOB_TIMEOUT_S = 30 * 60
RETRY_FAILED_AFTER_S = 10 * 60  # a failed spot is tried again automatically after this
# IRSA's query service (TAP) lists newer images than its image search (SIA) but takes about a
# minute per detector even when it works, and has been down for hours (5 minutes to time out).
# Spots use SIA unless SPOT_TRY_TAP=1; then a TAP failure is remembered for TAP_DOWN_S.
TRY_TAP = os.environ.get("SPOT_TRY_TAP") == "1"
TAP_DOWN_S = 10 * 60

STAGES = {  # what each step is called on screen
    "queued": "Waiting for another spot to finish",
    "starting": "Starting up",
    "query": "Asking NASA’s archive which photos cover this spot",
    "download": "Downloading photos",
    "process": "Lining up and combining the photos",
    "publish": "Saving the finished plates",
}
PROGRESS = {"queued": 0.0, "starting": 0.02, "query": 0.05, "download": 0.1, "process": 0.85,
            "publish": 0.95}

slots = threading.Semaphore(MAX_JOBS)
lock = threading.Lock()
jobs = {}  # spot id -> {"stage": ..., "log_from": byte offset where this run's log starts}
scouts = {}  # spot id -> scout summary (also saved as scout.json in the spot's folder)
tap_down_until = 0.0

_scout_module = None


def scout_module():
    """scout.py pulls in astropy (a few seconds), so load it on first use, not at start-up."""
    global _scout_module
    if _scout_module is None:
        import scout

        _scout_module = scout
    return _scout_module


def paths(tid):
    work = os.path.join(SPOTS, tid)
    return {
        "work": work,
        "log": os.path.join(work, "log.txt"),
        "failed": os.path.join(work, "failed.json"),
        "scout": os.path.join(work, "scout.json"),
        "passes": os.path.join(MEDIA, tid, "passes.json"),
    }


def write_json(path, data):
    """Write in one go (temporary file, then rename), so nothing ever reads half a file."""
    with open(path + ".part", "w") as f:
        json.dump(data, f, indent=1)
    os.replace(path + ".part", path)


def read_log(tid, start=0):
    try:
        with open(paths(tid)["log"], encoding="utf-8", errors="replace") as f:
            f.seek(start)
            return f.read()
    except FileNotFoundError:
        return ""


def status(tid):
    """Where a spot stands: ready, processing (with stage and progress), failed, or none."""
    p = paths(tid)
    if os.path.exists(p["passes"]):
        return {"status": "ready"}
    with lock:
        job = jobs.get(tid)
    if job:
        stage, progress = job["stage"], PROGRESS.get(job["stage"], 0)
        if stage not in ("queued", "starting"):
            log = read_log(tid, job["log_from"])
            stages = re.findall(r"^@@stage (\w+)", log, re.M)
            stage = stages[-1] if stages else "starting"
            progress = PROGRESS.get(stage, 0)
            done = re.findall(r"^@@progress (\d+) (\d+)", log, re.M)
            if stage == "download" and done:
                n, total = map(int, done[-1])
                progress = 0.1 + 0.75 * n / max(total, 1)
        out = {"status": "processing", "stage": stage, "stageLabel": STAGES.get(stage, stage),
               "progress": round(progress, 3)}
        if stage == "query":
            retries = re.findall(r"^SIA attempt (\d+) failed", log, re.M)
            if retries:
                out["stageLabel"] = ("NASA’s archive isn’t answering; trying again "
                                     f"(attempt {int(retries[-1]) + 1} of 5)")
        if stage == "download" and progress > 0.1:
            out["downloaded"], out["toDownload"] = n, total
        return out
    if os.path.exists(p["failed"]):
        failed = json.load(open(p["failed"]))
        return {"status": "failed", **failed}
    return {"status": "none"}


def tap_is_down():
    """True when spots should skip TAP: always, unless SPOT_TRY_TAP=1 and it hasn't failed lately."""
    global tap_down_until
    if not TRY_TAP or time.time() < tap_down_until:
        return True
    try:  # a quick health check, instead of the query's 5-minute timeout
        with urllib.request.urlopen("https://irsa.ipac.caltech.edu/TAP/availability", timeout=15):
            return False
    except Exception:
        tap_down_until = time.time() + TAP_DOWN_S
        return True


def run_job(tid):
    global tap_down_until
    p = paths(tid)
    try:
        with slots:  # at most MAX_JOBS at once; the rest wait here as "queued"
            with lock:
                jobs[tid]["stage"] = "starting"
            env = dict(os.environ)
            skip_tap = tap_is_down()
            if skip_tap:
                env["SKIP_TAP"] = "1"
            with open(p["log"], "a", encoding="utf-8") as log:
                log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} processing {tid}"
                          f"{' (skipping TAP)' if skip_tap else ''}\n")
                log.flush()
                with lock:
                    jobs[tid]["log_from"] = log.tell()
                    jobs[tid]["stage"] = "query"
                try:
                    code = subprocess.run(
                        [sys.executable, "-u", os.path.join(PIPELINE, "run.py"), tid],
                        stdout=log, stderr=subprocess.STDOUT, env=env, cwd=REPO,
                        timeout=JOB_TIMEOUT_S,
                    ).returncode
                except subprocess.TimeoutExpired:
                    code = "timeout"
                log.write(f"=== exit {code} at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        output = read_log(tid, jobs[tid]["log_from"])
        if "TAP query failed" in output and not skip_tap:
            tap_down_until = time.time() + TAP_DOWN_S
        if os.path.exists(p["passes"]):
            if os.path.exists(p["failed"]):
                os.remove(p["failed"])
        else:
            reasons = re.findall(r"^!! (.+)$", output, re.M)
            if code == "timeout":
                message = "Processing took too long and was stopped. Try again later."
            elif reasons:
                message = reasons[-1]
            else:
                message = "Something went wrong while processing this spot."
            permanent = code != "timeout" and "@@permanent" in output
            write_json(p["failed"], {"message": message, "permanent": permanent,
                                     "at": time.time(), "log": os.path.relpath(p["log"], REPO)})
    except Exception as e:  # never leave a spot stuck as "processing"
        write_json(p["failed"], {"message": "Something went wrong while processing this spot.",
                                 "detail": repr(e), "at": time.time()})
    finally:
        with lock:
            jobs.pop(tid, None)


def start_job(tid, retry=False):
    """Start processing a spot unless it's done, already running, or failed recently."""
    p = paths(tid)
    os.makedirs(p["work"], exist_ok=True)
    with lock:
        if tid in jobs or os.path.exists(p["passes"]):
            return
        if os.path.exists(p["failed"]):
            failed = json.load(open(p["failed"]))
            age = time.time() - failed.get("at", 0)
            if not retry and (failed.get("permanent") or age < RETRY_FAILED_AFTER_S):
                return
            os.remove(p["failed"])
        jobs[tid] = {"stage": "queued", "log_from": 0}
    threading.Thread(target=run_job, args=(tid,), daemon=True).start()


def get_scout(tid, ra, dec):
    with lock:
        if tid in scouts:
            return scouts[tid]
    path = paths(tid)["scout"]
    if os.path.exists(path):
        summary = json.load(open(path))
    else:
        scout = scout_module()
        images = scout.sia_images(ra, dec)
        summary = scout.summarize(ra, dec, max_per_band=SPOT_MAX_PER_BAND, images=images)
        if not images:
            # SPHEREx covers the whole sky, so an empty answer is most likely one of IRSA's
            # wobbles: show it, but don't save it, so the next visit asks again.
            return summary
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Saved for query.py, so fetching this spot needn't ask IRSA (which flaps) again
        write_json(os.path.join(os.path.dirname(path), "sia.json"), images)
        write_json(path, summary)
    with lock:
        scouts[tid] = summary
    return summary


def parse_spot(query):
    """(spot id, ra, dec) from ?ra=&dec=, or None if missing or impossible."""
    try:
        ra, dec = float(query["ra"][0]), float(query["dec"][0])
    except (KeyError, ValueError, IndexError):
        return None
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        return None
    tid = spot_id(ra, dec)
    _, ra_s, dec_s = tid.split("_")
    return tid, float(ra_s), float(dec_s)


MEDIA_PATH = re.compile(r"^/media/(spot_\d{1,3}\.\d{4}_-?\d{1,2}\.\d{4})/([\w-]+\.png)$")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/api/health":
            return self.send_json(200, {"ok": True})
        if url.path in ("/api/status", "/api/scout", "/api/passes"):
            spot = parse_spot(query)
            if not spot:
                return self.send_json(400, {"status": "failed", "error": "bad-coordinates",
                                            "message": "Give ra (0–360) and dec (−90–90) in degrees."})
            tid, ra, dec = spot
            if url.path == "/api/status":
                return self.send_json(200, {"id": tid, **status(tid)})
            if url.path == "/api/scout":
                try:
                    summary = get_scout(tid, ra, dec)
                except Exception as e:
                    return self.send_json(503, {"error": "irsa", "detail": str(e)[:200],
                                                "message": "NASA’s SPHEREx archive (IRSA) isn’t "
                                                "answering right now. Try again in a few minutes."})
                return self.send_json(200, {"id": tid, **summary, "job": status(tid)})
            start_job(tid, retry=query.get("retry") == ["1"])
            s = status(tid)
            if s["status"] == "ready":
                return self.send_json(200, json.load(open(paths(tid)["passes"])))
            if s["status"] == "failed":
                return self.send_json(500, {"id": tid, **s})
            return self.send_json(202, {"id": tid, **s})
        m = MEDIA_PATH.match(url.path)
        if m:
            file = os.path.join(MEDIA, m.group(1), m.group(2))
            if os.path.isfile(file):
                data = open(file, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_json(404, {"error": "not-found"})

    def log_message(self, fmt, *args):  # keep the terminal quiet while the app polls
        if not self.path.startswith("/api/passes") or args[1] != "202":
            sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")


if __name__ == "__main__":
    os.makedirs(SPOTS, exist_ok=True)
    os.makedirs(MEDIA, exist_ok=True)
    threading.Thread(target=scout_module, daemon=True).start()  # warm up astropy meanwhile
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Celestial Navigator backend on http://localhost:{PORT}  (spots cached in "
          f"{os.path.relpath(MEDIA, REPO)}/, logs in {os.path.relpath(SPOTS, REPO)}/<id>/log.txt)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
