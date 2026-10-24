#!/usr/bin/env python3
"""sampler.py <out.csv> <interval_s> : logs system CPU% / used MB and top-N process groups matching pattern regex in $PAT"""
import time, sys, os, re, subprocess
out, iv = sys.argv[1], float(sys.argv[2]); pat = re.compile(os.environ.get("PAT", "."))
def cpu():
    a = list(map(int, open("/proc/stat").readline().split()[1:])); return sum(a), a[3] + a[4]
t0 = time.time(); pt, pi = cpu()
f = open(out, "w"); f.write("t_s,sys_cpu_pct,sys_used_mb,match_rss_mb,match_nproc\n")
while True:
    time.sleep(iv); t, i = cpu(); c = 100 * (1 - (i - pi) / max(1, t - pt)); pt, pi = t, i
    mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
    used = (mem["MemTotal"] - mem["MemAvailable"]) / 1024
    rss = n = 0
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                cmd = open(f"/proc/{p}/cmdline").read().replace("\0", " ")
                if pat.search(cmd) and "sampler.py" not in cmd:
                    for l in open(f"/proc/{p}/status"):
                        if l.startswith("VmRSS"): rss += int(l.split()[1]) / 1024; n += 1
            except Exception: pass
    f.write("%.1f,%.1f,%.0f,%.0f,%d\n" % (time.time() - t0, c, used, rss, n)); f.flush()
