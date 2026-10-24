#!/usr/bin/env python3
"""probe.py <label> <port|0> <cmd...> : start daemon/app, time until TCP port accepts (or 20s idle if port 0), sample RSS of process tree after 5s idle, then stop. Output runs/<label>/probe.json"""
import sys, os, time, subprocess, socket, json, signal
label, port = sys.argv[1], int(sys.argv[2]); cmd = sys.argv[3:]
out = os.path.join(os.path.dirname(__file__), "..", "runs", label); os.makedirs(out, exist_ok=True)
lf = open(out + "/probe.log", "w"); t0 = time.time()
p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, preexec_fn=os.setsid, stdin=subprocess.DEVNULL)
ready = None
while time.time() - t0 < float(os.environ.get("PROBE_TIMEOUT", "60")):
    if p.poll() is not None: break
    if port:
        try: socket.create_connection(("127.0.0.1", port), 0.2).close(); ready = time.time() - t0; break
        except OSError: time.sleep(0.1)
    else: time.sleep(0.5)
def tree_rss(pgid):
    r = n = 0
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if os.getpgid(int(d)) == pgid:
                    for l in open(f"/proc/{d}/status"):
                        if l.startswith("VmRSS"): r += int(l.split()[1]) / 1024; n += 1
            except Exception: pass
    return round(r), n
time.sleep(5)
alive = p.poll() is None
rss = tree_rss(os.getpgid(p.pid)) if alive else (0, 0)
res = {"cmd": " ".join(cmd), "ready_s": round(ready, 2) if ready else None, "alive_after_5s_idle": alive, "exit_code": p.poll(), "idle_rss_mb": rss[0], "procs": rss[1]}
try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
except Exception: pass
time.sleep(1)
try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
except Exception: pass
json.dump(res, open(out + "/probe.json", "w"), indent=1); print(json.dumps(res))
