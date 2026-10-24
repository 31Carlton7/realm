#!/usr/bin/env python3
"""Drive a headless `orca serve` runtime via its CLI: 6 worktrees created concurrently + stub agent in a terminal each."""
import subprocess, json, os, sys, time, threading, glob, shutil
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = f"{ROOT}/runs/F-orca"; CRASH = os.environ.get("STUB_CRASH", "")
ORCA = f"{ROOT}/tools/orca-x/squashfs-root/resources/bin/orca-ide"; env = {**os.environ, "HOME": "/tmp/home-orca-cli", "DISPLAY": ":90"}
tasks = json.load(open(f"{ROOT}/fixture/tasks.json")); names = ["t1","t2","t3","t4","t5a","t5b"]
def orca(*a):
    p = subprocess.run([ORCA, *a, "--json"], env=env, capture_output=True, text=True)
    try: return json.loads(p.stdout)
    except Exception: return {"ok": False, "raw": p.stdout[-500:] + p.stderr[-500:]}
repo = "/tmp/orca-repo"; shutil.rmtree(repo, ignore_errors=True); subprocess.run(["cp", "-r", f"{ROOT}/fixture/repo", repo], check=True)
r = orca("repo", "add", "--path", repo); rid = r["result"]["repo"]["id"]
sam = subprocess.Popen([sys.executable, f"{ROOT}/harness/sampler.py", f"{OUT}/resources{'-crash' if CRASH else ''}.csv", "1"], env={**os.environ, "PAT": "orca|benchagent"})
res = {"sessions": {}}; T0 = time.time()
def go(n):
    t = time.time(); w = orca("worktree", "create", "--repo", f"id:{rid}", "--name", n)
    t_wt = time.time() - t
    if not w.get("ok"): res["sessions"][n] = {"worktree_ok": False, "raw": w}; return
    wt = w["result"]["worktree"]; path = wt["path"]; wid = wt["id"]
    cmd = f"env STUB_SLEEP=10 STUB_CRASH={CRASH} python3 {ROOT}/harness/benchagent.py '" + tasks[n].replace("'", "'\\''") + "'"
    t2 = time.time(); tc = orca("terminal", "create", "--worktree", f"id:{wid}", "--command", cmd)
    res["sessions"][n] = {"worktree_create_s": round(t_wt, 2), "terminal_create_s": round(time.time() - t2, 2), "path": path, "terminal_ok": tc.get("ok"), "since_start_s": round(time.time() - T0, 2)}
th = [threading.Thread(target=go, args=(n,)) for n in names]; [x.start() for x in th]; [x.join() for x in th]
res["all_launched_s"] = round(time.time() - T0, 2)
time.sleep(14)
for n, s in res["sessions"].items():
    if "path" not in s: continue
    v = subprocess.run([sys.executable, f"{ROOT}/harness/verify.py", s["path"], n], capture_output=True, text=True)
    s["verified"] = v.returncode == 0; s["partial_file"] = os.path.exists(s["path"] + "/PARTIAL_WORK.txt")
    s["branch"] = subprocess.run(["git", "branch", "--show-current"], cwd=s["path"], capture_output=True, text=True).stdout.strip()
res["total_wall_s"] = round(time.time() - T0, 2)
res["terminals"] = orca("terminal", "list")
res["worktree_list"] = [ (x.get("branch"), x.get("path")) for x in orca("worktree", "list", "--repo", f"id:{rid}").get("result", {}).get("worktrees", [])]
sam.terminate(); json.dump(res, open(f"{OUT}/result{'-crash' if CRASH else ''}.json", "w"), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != "terminals"}, indent=1))
