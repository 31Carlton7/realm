#!/usr/bin/env python3
"""Baseline harness: plain `git worktree` + headless agent CLI in parallel (no orchestrator).
usage: baseline_run.py <label> <agent_cmd_template with {prompt}> [--tasks t1,t2,...] [--stagger S]
Logs go to runs/<label>/ ."""
import sys, os, json, subprocess, time, shutil, threading, argparse
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ap = argparse.ArgumentParser(); ap.add_argument("label"); ap.add_argument("cmd"); ap.add_argument("--tasks", default="t1,t2,t3,t4,t5a,t5b"); ap.add_argument("--timeout", type=int, default=600); ap.add_argument("--serial", action="store_true")
a = ap.parse_args()
run = f"{ROOT}/runs/{a.label}"; shutil.rmtree(run, ignore_errors=True); os.makedirs(run)
base = f"/tmp/bench-{a.label}"; shutil.rmtree(base, ignore_errors=True); os.makedirs(base)
repo = base + "/repo"; subprocess.run(["cp", "-r", f"{ROOT}/fixture/repo", repo], check=True)
tasks = json.load(open(f"{ROOT}/fixture/tasks.json")); names = a.tasks.split(",")
G = ["git", "-c", "user.name=bench", "-c", "user.email=b@b"]
sam = subprocess.Popen([sys.executable, f"{ROOT}/harness/sampler.py", f"{run}/resources.csv", "1"], env={**os.environ, "PAT": os.environ.get("PAT", "opencode|claude|codex")})
res = {}
t_setup = time.time()
for n in names:
    subprocess.run(G + ["worktree", "add", "-q", "-b", n, f"{base}/wt-{n}"], cwd=repo, check=True)
res["_worktree_setup_s"] = round(time.time() - t_setup, 3)
def work(n):
    wt = f"{base}/wt-{n}"; t0 = time.time()
    cmd = a.cmd.replace("{prompt}", subprocess.list2cmdline([tasks[n]]) if False else "'" + tasks[n].replace("'", "'\\''") + "'")
    with open(f"{run}/{n}.log", "w") as lf:
        try:
            p = subprocess.run(cmd, shell=True, cwd=wt, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=a.timeout); rc = p.returncode
        except subprocess.TimeoutExpired: rc = "timeout"
    dur = time.time() - t0
    v = subprocess.run([sys.executable, f"{ROOT}/harness/verify.py", wt, "t4" if n == "t4" else n], capture_output=True, text=True)
    open(f"{run}/{n}.verify.txt", "w").write(v.stdout + v.stderr)
    subprocess.run(G + ["add", "-A"], cwd=wt); subprocess.run(G + ["commit", "-qm", n], cwd=wt, capture_output=True)
    res[n] = {"agent_exit": rc, "wall_s": round(dur, 1), "verified": v.returncode == 0}
T0 = time.time()
if a.serial:
    for n in names: work(n)
else:
    th = [threading.Thread(target=work, args=(n,)) for n in names]; [t.start() for t in th]; [t.join() for t in th]
res["_total_wall_s"] = round(time.time() - T0, 1)
sam.terminate()
# merge phase
merges = []
for n in names:
    p = subprocess.run(G + ["merge", "--no-edit", n], cwd=repo, capture_output=True, text=True)
    st = "clean" if p.returncode == 0 else "CONFLICT"
    if p.returncode != 0:
        files = subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"], cwd=repo, capture_output=True, text=True).stdout.split()
        merges.append({"branch": n, "result": st, "files": files}); subprocess.run(["git", "merge", "--abort"], cwd=repo)
    else: merges.append({"branch": n, "result": st})
res["_merge"] = merges
open(f"{run}/result.json", "w").write(json.dumps(res, indent=1)); print(json.dumps(res, indent=1))
