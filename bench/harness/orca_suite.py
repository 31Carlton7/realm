#!/usr/bin/env python3
"""orca_suite.py: Orca's lane A the way realm_suite.py runs Realm's, for a side-by-side on one machine. Each run boots its own
`orca-ide serve` on a fresh HOME (DISPLAY=:90, as REPRODUCE step 4), times it to its ready line, takes its idle RSS, runs
orca_run.py, then stops it and anything it left running: 3 clean runs (runs/repeat/orca-run{i}.json + orca-res{i}.csv), the
STUB_CRASH=t3 test, then one more clean run whose worktrees merge_eval.py merges. First it tries one boot with no DISPLAY.
env: ORCA (default tools/orca-x/squashfs-root/resources/bin/orca-ide, the extracted AppImage)."""
import subprocess, sys, os, json, shutil, time, signal, threading, re
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); H = f"{ROOT}/harness"; F = f"{ROOT}/runs/F-orca"
ORCA = os.path.abspath(os.environ.get("ORCA", f"{ROOT}/tools/orca-x/squashfs-root/resources/bin/orca-ide")); HOME_ = "/tmp/home-orca-cli"
APP = os.path.dirname(os.path.dirname(os.path.dirname(ORCA)))  # squashfs-root: every process Orca runs starts from here
os.makedirs(F, exist_ok=True); os.makedirs(f"{ROOT}/runs/repeat", exist_ok=True)
def rss_mb():
    r = 0
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                if re.search(re.escape(APP) + "|" + re.escape(HOME_), open(f"/proc/{p}/cmdline").read().replace("\0", " ")):
                    r += next(int(l.split()[1]) for l in open(f"/proc/{p}/status") if l.startswith("VmRSS"))
            except Exception: pass
    return round(r / 1024)
def boot(display, log, wait=60):
    shutil.rmtree(HOME_, ignore_errors=True); os.makedirs(HOME_)
    env = {k: v for k, v in os.environ.items() if k != "DISPLAY"}; env["HOME"] = HOME_
    if display: env["DISPLAY"] = display
    t0 = time.time(); p = subprocess.Popen([ORCA, "serve"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    ready = threading.Event(); at = {}; out = open(log, "w")
    def read():
        for line in p.stdout:
            out.write(line); out.flush()
            if "Orca server ready" in line and not ready.is_set(): at["s"] = round(time.time() - t0, 2); ready.set()
    threading.Thread(target=read, daemon=True).start()
    while not ready.wait(0.1) and p.poll() is None and time.time() - t0 < wait: pass
    return p, at.get("s")
def stop(p):
    try: os.killpg(p.pid, signal.SIGTERM); p.wait(15)
    except Exception: pass
    subprocess.run(["pkill", "-9", "-f", APP]); time.sleep(1)  # Orca keeps terminals alive across a restart; none may carry over
p, s = boot(None, f"{F}/serve-nodisplay.log", 30)
headless = {"ready_s": s, "exit_code": p.poll()}; stop(p)
ready, idle = [], []
def run(**e):
    p, s = boot(":90", f"{F}/serve{'-crash' if e.get('STUB_CRASH') else ''}.log")
    if s is None: stop(p); sys.exit(f"orca serve never reported ready; see {F}")
    time.sleep(3); ready.append(s); idle.append(rss_mb())
    try: subprocess.run([sys.executable, f"{H}/orca_run.py"], env={**os.environ, **e}, check=True, stdout=subprocess.DEVNULL)
    finally: stop(p)
for i in (1, 2, 3):
    run(); shutil.copy(f"{F}/result.json", f"{ROOT}/runs/repeat/orca-run{i}.json"); shutil.copy(f"{F}/resources.csv", f"{ROOT}/runs/repeat/orca-res{i}.csv")
run(STUB_CRASH="t3")
run()
json.dump({"orca_serve_ready_s": ready, "idle_rss_mb": idle, "serve_without_display": headless}, open(f"{F}/serve-ready.json", "w"), indent=1)
s = json.load(open(f"{F}/result.json"))["sessions"]
subprocess.run([sys.executable, f"{H}/merge_eval.py", "F-orca", "/tmp/orca-repo", *[f"{s[n]['branch']}:{s[n]['path']}" for n in ["t1","t2","t3","t4","t5a","t5b"]]], check=True)
