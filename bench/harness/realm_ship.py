#!/usr/bin/env python3
"""realm_ship.py: criterion C, measured. Lane A's six stub tasks through `realm run --worktree`, then each finished run
committed and pushed by Realm itself (`realm ship <checkout> --message .. --push`, the Changes pane's commit + push),
then merged into main with git as merge_eval.py does. One `--pr` with no GitHub remote shows the exit code a pull
request Realm could not open gets. Needs a Realm with `realm ship` (2.7.0 or later).
env: BENCH (a clone of agent-orchestrator-bench), REALM_BIN (as realm_run.py), REALM_PORT (default 8796), OUT (result dir).
Boots its own server on a fresh scratch REALM_HOME with the fake agent only; the remote is a bare repo on this disk, so
nothing is pushed anywhere else; stops the server at the end."""
import subprocess, json, os, sys, time, shutil, tempfile, threading
BENCH = os.path.abspath(os.environ["BENCH"]); CLI = [os.path.abspath(os.environ["REALM_BIN"])]
OUT = os.path.abspath(os.environ.get("OUT", f"{BENCH}/runs/F-realm-ship")); os.makedirs(OUT, exist_ok=True)
HOME_ = tempfile.mkdtemp(prefix="realm-ship-home-")
# A `gh` that always fails, first on the server's PATH: the --pr row must not reach GitHub, and with gh signed out
# Realm only prints the link. (Dropping the directories gh lives in would drop /usr/bin with it on Ubuntu.)
shim = tempfile.mkdtemp(prefix="realm-ship-gh-"); open(f"{shim}/gh", "w").write("#!/bin/sh\nexit 1\n"); os.chmod(f"{shim}/gh", 0o755)
path = shim + os.pathsep + os.environ["PATH"]
env = {**os.environ, "PATH": path, "REALM_HOME": HOME_, "REALM_PORT": os.environ.get("REALM_PORT", "8796"), "REALM_ENABLE_FAKE_AGENT": "1"}
tasks = json.load(open(f"{BENCH}/fixture/tasks.json")); names = ["t1","t2","t3","t4","t5a","t5b"]
G = ["git", "-c", "commit.gpgsign=false"]
def realm(*a):
    t = time.time(); p = subprocess.run([*CLI, "--json", *a], env=env, capture_output=True, text=True)
    try: out = json.loads(p.stdout)
    except Exception: out = {"raw": p.stdout[-500:] + p.stderr[-500:]}
    return {"code": p.returncode, "s": round(time.time() - t, 2), "result": out}
repo = tempfile.mkdtemp(prefix="realm-ship-repo-") + "/repo"; remote = tempfile.mkdtemp(prefix="realm-ship-remote-") + "/remote.git"
subprocess.run(["cp", "-r", f"{BENCH}/fixture/repo", repo], check=True)
if not os.path.isdir(repo + "/.git"):
    subprocess.run(G + ["init", "-q", "-b", "main"], cwd=repo, check=True)
# Realm commits as the repository's own identity, as it would for its owner.
for k, v in [("user.name", "bench"), ("user.email", "b@b"), ("commit.gpgsign", "false")]: subprocess.run(["git", "config", k, v], cwd=repo, check=True)
if subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True).returncode:
    subprocess.run(G + ["add", "-A"], cwd=repo, check=True)
    subprocess.run(G + ["commit", "-qm", "fixture base"], cwd=repo, check=True, env={**os.environ, "GIT_AUTHOR_DATE": "2026-10-19T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-19T00:00:00Z"})
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", remote], check=True); subprocess.run(["git", "remote", "add", "origin", remote], cwd=repo, check=True)
srv = subprocess.Popen([*CLI, "serve"], env=env, stdout=subprocess.PIPE, stderr=open(f"{OUT}/serve.log", "w"), text=True)
for line in srv.stdout:
    if '"ready"' in line: break
threading.Thread(target=lambda: [None for _ in srv.stdout], daemon=True).start()
res = {"repo_add": realm("repo", "add", repo), "runs": {}, "ships": {}}
def go(n):
    cmd = f"env STUB_SLEEP=3 python3 {BENCH}/harness/benchagent.py '" + tasks[n].replace("'", "'\\''") + "'"
    res["runs"][n] = realm("run", repo, "--worktree", n, "--", cmd)
th = [threading.Thread(target=go, args=(n,)) for n in names]; [x.start() for x in th]; [x.join() for x in th]
res["wait"] = realm("wait", *[res["runs"][n]["result"]["terminalId"] for n in names], "--timeout", "60")
for n in names:
    path_ = res["runs"][n]["result"]["path"]
    v = subprocess.run([sys.executable, f"{BENCH}/harness/verify.py", path_, n], capture_output=True, text=True).returncode == 0
    s = realm("ship", res["runs"][n]["result"]["environmentId"], "--message", f"{n}: " + tasks[n].split(":")[0], "--push")
    r = s["result"]
    res["ships"][n] = {"verified_before_ship": v, "exit": s["code"], "ship_s": s["s"], "commit": r.get("commit", {}).get("state"), "sha": r.get("commit", {}).get("sha"),
        "push": r.get("push", {}).get("state"), "on_remote": subprocess.run(["git", "--git-dir", remote, "rev-parse", f"realm/{n}"], capture_output=True, text=True).stdout.strip() == r.get("commit", {}).get("sha"),
        "clean_after": subprocess.run(["git", "status", "--porcelain"], cwd=path_, capture_output=True, text=True).stdout == "", "raw": r if s["code"] else None}
# A pull request with no GitHub remote and no gh: Realm says why and exits 1, rather than claiming one.
pr = realm("ship", res["runs"]["t1"]["result"]["environmentId"], "--message", "t1", "--pr")
res["pr_without_github"] = {"exit": pr["code"], "commit": pr["result"].get("commit", {}).get("state"), "push": pr["result"].get("push", {}).get("state"), "pr": pr["result"].get("pr")}
# merge_eval.py's merge, onto Realm's commits instead of its own `git add -A && git commit`.
merges = []
for n in names:
    m = subprocess.run(G + ["merge", "--no-edit", f"realm/{n}"], cwd=repo, capture_output=True, text=True)
    if m.returncode:
        merges.append({"branch": f"realm/{n}", "result": "CONFLICT", "files": subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"], cwd=repo, capture_output=True, text=True).stdout.split()})
        subprocess.run(["git", "merge", "--abort"], cwd=repo)
    else: merges.append({"branch": f"realm/{n}", "result": "clean"})
res["merges"] = merges
res["post_merge_verify"] = {t: subprocess.run([sys.executable, f"{BENCH}/harness/verify.py", repo, t], capture_output=True, text=True).returncode == 0 for t in ["t1","t2","t3","t4","t5a"]}
srv.terminate(); srv.wait(10)
res["realm_home"] = HOME_
json.dump(res, open(f"{OUT}/result.json", "w"), indent=1)
summary = {n: {k: s[k] for k in ("verified_before_ship", "exit", "ship_s", "commit", "push", "on_remote", "clean_after")} for n, s in res["ships"].items()}
print(json.dumps({"ships": summary, "pr_without_github": res["pr_without_github"], "merges": [(m["branch"], m["result"]) for m in merges], "post_merge_verify": res["post_merge_verify"]}, indent=1))
