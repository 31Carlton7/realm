#!/usr/bin/env python3
"""merge_eval.py <label> <repo> <branch:worktree_path>... : commit each worktree's pending changes, merge sequentially into main, report conflicts + final verify of merged tree."""
import sys, subprocess, json, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
label, repo, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
G = ["git", "-c", "user.name=bench", "-c", "user.email=b@b"]
res = []
for p in pairs:
    b, wt = p.split(":", 1)
    subprocess.run(G + ["add", "-A"], cwd=wt); subprocess.run(G + ["commit", "-qm", b], cwd=wt, capture_output=True)
for p in pairs:
    b = p.split(":", 1)[0]
    r = subprocess.run(G + ["merge", "--no-edit", b], cwd=repo, capture_output=True, text=True)
    if r.returncode: 
        f = subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"], cwd=repo, capture_output=True, text=True).stdout.split()
        res.append({"branch": b, "result": "CONFLICT", "files": f}); subprocess.run(["git", "merge", "--abort"], cwd=repo)
    else: res.append({"branch": b, "result": "clean"})
v = {t: subprocess.run([sys.executable, f"{ROOT}/harness/verify.py", repo, t], capture_output=True, text=True).returncode == 0 for t in ["t1","t2","t3","t4","t5a"]}
out = {"merges": res, "post_merge_verify": v}
os.makedirs(f"{ROOT}/runs/{label}", exist_ok=True); json.dump(out, open(f"{ROOT}/runs/{label}/merge.json", "w"), indent=1); print(json.dumps(out))
