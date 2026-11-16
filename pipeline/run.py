# Runs every step for one target or spot:
#   python pipeline/run.py m45                       a target from targets.json
#   python pipeline/run.py --ra 161.25 --dec 58      any spot (or its id, spot_161.2500_58.0000)
# Re-running is safe: downloads skip files already on disk and retry ones IRSA refused (HTTP 503).
# A step that fails prints a line starting with "!! " saying why, for people (server.py shows it).
import json
import os
import subprocess
import sys
import time

from config import DATA, PIPELINE, SPOTS, parse_spot_id, spot_id

args = sys.argv[1:]
if len(args) == 4 and args[0] == "--ra" and args[2] == "--dec":
    tid = spot_id(args[1], args[3])
elif len(args) == 1:
    tid = args[0]
else:
    sys.exit("usage: python pipeline/run.py <target id> | --ra RA --dec DEC")
work = os.path.join(SPOTS if parse_spot_id(tid) else DATA, tid)
print(f"@@id {tid}", flush=True)


def step(script):
    print(f"--- {script} {tid}", flush=True)
    done = subprocess.run([sys.executable, os.path.join(PIPELINE, script), tid])
    if done.returncode:
        sys.exit(done.returncode)


t = time.time()
step("query.py")
for attempt in range(4):
    step("download.py")
    results = json.load(open(os.path.join(work, "cutouts.json")))
    failed = sum("error" in r for r in results)
    if not failed:
        break
    print(f"{failed} downloads failed, retrying in 20s", flush=True)
    time.sleep(20)
else:
    print(f"warning: {failed} cutouts still missing; continuing without them", flush=True)
step("process.py")
step("to_app.py")
print(f"done in {time.time() - t:.0f}s", flush=True)
