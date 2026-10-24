#!/usr/bin/env python3
"""gui_probe.py <tool> <appimage> [extra args]: launch Electron AppImage on Xvfb :90 w/ clean HOME; time to first visible X window; RSS after 12s; screenshot."""
import sys, os, time, subprocess, json, signal, shutil
tool, img = sys.argv[1], sys.argv[2]; extra = sys.argv[3:]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
out = f"{ROOT}/runs/E-gui-{tool}"; shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
home = f"/tmp/home-{tool}"; shutil.rmtree(home, ignore_errors=True); os.makedirs(home)
env = {**os.environ, "DISPLAY": ":90", "HOME": home, "XDG_CONFIG_HOME": home + "/.config"}
t0 = time.time()
p = subprocess.Popen([img, "--appimage-extract-and-run", "--no-sandbox", *extra], env=env, stdout=open(out + "/app.log", "w"), stderr=subprocess.STDOUT, preexec_fn=os.setsid, stdin=subprocess.DEVNULL)
first = None
while time.time() - t0 < 45:
    if p.poll() is not None: break
    r = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "."], env=env, capture_output=True, text=True).stdout.split()
    if r: first = time.time() - t0; break
    time.sleep(0.25)
time.sleep(12)
alive = p.poll() is None
def tree():
    pg = os.getpgid(p.pid); r = n = 0
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if os.getpgid(int(d)) == pg:
                    for l in open(f"/proc/{d}/status"):
                        if l.startswith("VmRSS"): r += int(l.split()[1]) / 1024; n += 1
            except Exception: pass
    return round(r), n
rss = tree() if alive else (0, 0)
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1440x900", "-i", ":90", "-frames:v", "1", out + "/screen.png"], env=env)
wins = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "."], env=env, capture_output=True, text=True).stdout.split()
res = {"tool": tool, "first_window_s": round(first, 2) if first else None, "alive_after_12s": alive, "exit_code": p.poll(), "rss_mb_tree": rss[0], "procs": rss[1], "visible_windows": len(wins)}
try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
except Exception: pass
subprocess.run("pkill -9 -f 'tmp/.mount_' ; true", shell=True); time.sleep(1)
json.dump(res, open(out + "/probe.json", "w"), indent=1); print(json.dumps(res))
