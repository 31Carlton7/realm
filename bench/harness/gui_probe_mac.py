#!/usr/bin/env python3
"""gui_probe_mac.py <tool> <path/to/App.app> [winlist binary]: gui_probe.py for macOS. Launches an APFS clone of the
bundle with a clean userData and home; time to first on-screen window (CGWindowList via winlist); RSS of every
process running from the clone after 12 s; a screenshot over CDP. Agent CLIs are pointed at /usr/bin/false so a
first-run screen cannot start a real, billed agent. Never touches the installed app or its data."""
import sys, os, time, subprocess, json, shutil, tempfile, signal
tool, src = sys.argv[1], sys.argv[2].rstrip("/")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WINLIST = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "winlist")
out = f"{ROOT}/runs/M-gui-{tool}"; shutil.rmtree(out, ignore_errors=True); os.makedirs(out)  # not E-gui-*: those are the Linux/Xvfb probes the report counts
scratch = tempfile.mkdtemp(prefix=f"gui-{tool}-"); app = f"{scratch}/{os.path.basename(src)}"
subprocess.run(["cp", "-cR", src, app], check=True)  # clonefile: no extra disk, and the user's bundle is never run
exe = f"{app}/Contents/MacOS/" + os.listdir(f"{app}/Contents/MacOS")[0]
false = "/usr/bin/false"
env = {**os.environ, "REALM_HOME": f"{scratch}/home", "REALM_PORT": os.environ.get("REALM_PORT", "8796"), "REALM_DEVTOOLS_PORT": os.environ.get("REALM_DEVTOOLS_PORT", "9236"),
       "REALM_ENABLE_FAKE_AGENT": "1", **{f"REALM_{k}_BIN": false for k in ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "OPENCODE", "COPILOT", "GOOSE", "QWEN", "GROK", "FX", "DEEPSEEK", "OPENHANDS", "HERMES"]}}
def ours():
    rows = subprocess.run(["ps", "-axo", "pid=,rss=,command="], capture_output=True, text=True).stdout.splitlines()
    return [(int(r.split(None, 2)[0]), int(r.split(None, 2)[1])) for r in rows if app in r]
t0 = time.time()
p = subprocess.Popen([exe, f"--user-data-dir={scratch}/userData"], env=env, stdout=open(out + "/app.log", "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
first = None
while time.time() - t0 < 45:
    if p.poll() is not None: break
    pids = [str(x) for x, _ in ours()]
    if pids and subprocess.run([WINLIST, *pids], capture_output=True, text=True).stdout.strip(): first = time.time() - t0; break
    time.sleep(0.1)
time.sleep(12)
alive = p.poll() is None
procs = ours(); rss = round(sum(r for _, r in procs) / 1024)
wins = subprocess.run([WINLIST, *[str(x) for x, _ in procs]], capture_output=True, text=True).stdout.strip().splitlines()
shot = subprocess.run(["node", os.path.join(os.path.dirname(__file__), "cdp_shot.mjs"), env["REALM_DEVTOOLS_PORT"], out + "/screen.png"], capture_output=True, text=True)
res = {"tool": tool, "bundle": src, "first_window_s": round(first, 2) if first else None, "alive_after_12s": alive, "exit_code": p.poll(),
       "rss_mb_tree": rss, "procs": len(procs), "visible_windows": len(wins), "screenshot": shot.stdout.strip() or shot.stderr.strip()[-200:],
       "load_avg_at_end": [round(x, 1) for x in os.getloadavg()]}
for pid, _ in ours():
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass
time.sleep(1)
res["port_free_after"] = subprocess.run(["lsof", "-nP", f"-iTCP:{env['REALM_PORT']}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True).stdout.strip() == ""
shutil.rmtree(scratch, ignore_errors=True)
json.dump(res, open(out + "/probe.json", "w"), indent=1); print(json.dumps(res))
