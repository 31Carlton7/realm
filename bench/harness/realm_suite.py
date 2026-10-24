#!/usr/bin/env python3
"""realm_suite.py: the whole Realm lane A in one go — 3 clean runs (copied to runs/repeat/realm-run{i}.json + realm-res{i}.csv),
the STUB_CRASH=t3 test, then one more clean run whose worktrees merge_eval.py merges. Same env as realm_run.py."""
import subprocess, sys, os, json, shutil
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); H = f"{ROOT}/harness"; F = f"{ROOT}/runs/F-realm"
run = lambda **e: subprocess.run([sys.executable, f"{H}/realm_run.py"], env={**os.environ, **e}, check=True, stdout=subprocess.DEVNULL)
os.makedirs(f"{ROOT}/runs/repeat", exist_ok=True)
for i in (1, 2, 3):
    run(); shutil.copy(f"{F}/result.json", f"{ROOT}/runs/repeat/realm-run{i}.json"); shutil.copy(f"{F}/resources.csv", f"{ROOT}/runs/repeat/realm-res{i}.csv")
run(STUB_CRASH="t3")
run()
s = json.load(open(f"{F}/result.json"))["sessions"]
subprocess.run([sys.executable, f"{H}/merge_eval.py", "F-realm", "/tmp/realm-repo", *[f"{s[n]['branch']}:{s[n]['path']}" for n in ["t1","t2","t3","t4","t5a","t5b"]]], check=True)
