#!/usr/bin/env python3
"""Drive a headless `realm serve` via its CLI: 6 worktrees + stub agent launched concurrently, one `realm run` each.
env: REALM_BIN, the `realm` command a Realm release ships (an extracted AppImage's squashfs-root/resources/bin/realm,
which runs on the app's own binary, no Node needed); or REALM_JS (a source build's apps/server/dist/realm.js) run on
REALM_NODE (default node). STUB_CRASH=<task>, REALM_PORT (default 8796).
Boots its own server on a fresh scratch REALM_HOME, so every run starts clean and nothing touches ~/Realm; stops it at the end."""
import subprocess, json, os, sys, time, threading, shutil, tempfile, platform, re, socket
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = f"{ROOT}/runs/F-realm"; os.makedirs(OUT, exist_ok=True); CRASH = os.environ.get("STUB_CRASH", "")
if os.environ.get("REALM_BIN"):
    b = os.path.abspath(os.environ["REALM_BIN"]); CLI = [b]
    while os.path.islink(b): b = os.path.join(os.path.dirname(b), os.readlink(b))
    # Where the command finds the bundle, as it does: <resources>/bin/realm runs <resources>/server/dist/realm.js,
    # a checkout's apps/server/bin/realm runs apps/server/dist/realm.js.
    pkg = os.path.abspath(os.path.join(os.path.dirname(b), ".."))
    DIST = f"{pkg}/dist" if os.path.exists(f"{pkg}/dist/realm.js") else f"{pkg}/server/dist"
else:
    REALM_JS = os.path.abspath(os.environ["REALM_JS"]); CLI = [os.environ.get("REALM_NODE", "node"), REALM_JS]; DIST = os.path.dirname(REALM_JS)
HOME_ = tempfile.mkdtemp(prefix="realm-bench-home-")
env = {**os.environ, "REALM_HOME": HOME_, "REALM_PORT": os.environ.get("REALM_PORT", "8796"), "REALM_ENABLE_FAKE_AGENT": "1"}
tasks = json.load(open(f"{ROOT}/fixture/tasks.json")); names = ["t1","t2","t3","t4","t5a","t5b"]
G = ["git", "-c", "user.name=bench", "-c", "user.email=b@b", "-c", "commit.gpgsign=false"]
def realm(*a):
    p = subprocess.run([*CLI, "--json", *a], env=env, capture_output=True, text=True)
    try: return {"ok": p.returncode == 0, "code": p.returncode, "result": json.loads(p.stdout)}
    except Exception: return {"ok": False, "code": p.returncode, "raw": p.stdout[-500:] + p.stderr[-500:]}
# The published fixture/repo carries no .git of its own; give the copy the same one-commit history the bench describes.
repo = "/tmp/realm-repo"; shutil.rmtree(repo, ignore_errors=True); subprocess.run(["cp", "-r", f"{ROOT}/fixture/repo", repo], check=True)
if not os.path.isdir(repo + "/.git"):
    subprocess.run(G + ["init", "-q", "-b", "main"], cwd=repo, check=True); subprocess.run(G + ["add", "-A"], cwd=repo, check=True)
    subprocess.run(G + ["commit", "-qm", "fixture base"], cwd=repo, check=True, env={**os.environ, "GIT_AUTHOR_DATE": "2026-10-19T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-19T00:00:00Z"})
# Boot: time to the server's ready line, then idle RSS before any work arrives.
tb = time.time()
srv = subprocess.Popen([*CLI, "serve"], env=env, stdout=subprocess.PIPE, stderr=open(f"{OUT}/serve{'-crash' if CRASH else ''}.log", "w"), text=True)
for line in srv.stdout:
    if '"ready"' in line: break
ready_s = round(time.time() - tb, 2); threading.Thread(target=lambda: [None for _ in srv.stdout], daemon=True).start()
time.sleep(3)
def rss_mb(pid):
    if os.path.exists(f"/proc/{pid}/status"): return round(next(int(l.split()[1]) for l in open(f"/proc/{pid}/status") if l.startswith("VmRSS")) / 1024)
    return round(int(subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() or 0) / 1024)
idle_rss = rss_mb(srv.pid)
r = realm("repo", "add", repo)
# What to sample: the server's bundle directory (its own processes and the `realm` CLI calls) and the stub agents.
# The bundle path, not "realm", so a Realm app the owner has open on the same machine is never counted.
PAT = re.escape(DIST) + "|benchagent"
sampler = "sampler.py" if platform.system() == "Linux" else "sampler_ps.py"
sam = subprocess.Popen([sys.executable, f"{ROOT}/harness/{sampler}", f"{OUT}/resources{'-crash' if CRASH else ''}.csv", "1"], env={**os.environ, "PAT": PAT})
res = {"load_avg_at_start": [round(x, 1) for x in os.getloadavg()], "realm_serve_ready_s": ready_s, "idle_rss_mb": idle_rss, "repo_add": r, "sessions": {}}; T0 = time.time()
def go(n):
    cmd = f"env STUB_SLEEP=10 STUB_CRASH={CRASH} python3 {ROOT}/harness/benchagent.py '" + tasks[n].replace("'", "'\\''") + "'"
    t = time.time(); w = realm("run", repo, "--worktree", n, "--", cmd)
    if not w["ok"]: res["sessions"][n] = {"run_ok": False, "raw": w}; return
    o = w["result"]
    res["sessions"][n] = {"run_s": round(time.time() - t, 2), "path": o["path"], "terminal_id": o["terminalId"], "run_ok": True, "since_start_s": round(time.time() - T0, 2)}
th = [threading.Thread(target=go, args=(n,)) for n in names]; [x.start() for x in th]; [x.join() for x in th]
res["all_launched_s"] = round(time.time() - T0, 2)
# Realm reports completion itself; record when every command had exited by its own account...
wt = realm("wait", "--timeout", "30"); res["all_exited_s"] = round(time.time() - T0, 2); res["wait_exit_code"] = wt["code"]
# ...then keep the bench's fixed protocol (verify 14 s after launch, as orca_run.py does) so total_wall_s compares like for like.
time.sleep(max(0, T0 + res["all_launched_s"] + 14 - time.time()))
tv = time.time()
for n, s in res["sessions"].items():
    if "path" not in s: continue
    v = subprocess.run([sys.executable, f"{ROOT}/harness/verify.py", s["path"], n], capture_output=True, text=True)
    s["verified"] = v.returncode == 0; s["partial_file"] = os.path.exists(s["path"] + "/PARTIAL_WORK.txt")
    s["branch"] = subprocess.run(["git", "branch", "--show-current"], cwd=s["path"], capture_output=True, text=True).stdout.strip()
res["verify_s"] = round(time.time() - tv, 2)  # the six hidden verifiers, run serially: the machine's Python, not the orchestrator
res["total_wall_s"] = round(time.time() - T0, 2)
ps = realm("ps").get("result", [])
by_id = {t["terminalId"]: t for t in ps}
for n, s in res["sessions"].items():
    t = by_id.get(s.get("terminal_id"), {}); s["reported"] = {k: t.get(k) for k in ("running", "exitCode", "signal")}
res["terminals"] = ps
res["worktree_list"] = [(x.get("branch"), x.get("path")) for x in realm("worktree", "list", repo).get("result", [])]
sam.terminate()
srv.terminate(); srv.wait(10)
res["server_stopped"] = socket.socket().connect_ex(("127.0.0.1", int(env["REALM_PORT"]))) != 0
res["realm_home"] = HOME_; res["platform"] = f"{platform.system()} {platform.machine()} {platform.release()}"
json.dump(res, open(f"{OUT}/result{'-crash' if CRASH else ''}.json", "w"), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != "terminals"}, indent=1))
