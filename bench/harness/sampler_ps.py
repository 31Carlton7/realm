#!/usr/bin/env python3
"""sampler_ps.py <out.csv> <interval_s> : sampler.py's columns without /proc, for macOS. Same PAT regex over full command lines.
sys_cpu_pct is the sum of every process's %CPU over the core count (ps's decaying average, so coarser than /proc/stat);
sys_used_mb is active + wired + compressed pages from vm_stat. match_rss_mb is exact (ps rss)."""
import time, sys, os, re, subprocess
out, iv = sys.argv[1], float(sys.argv[2]); pat = re.compile(os.environ.get("PAT", ".")); ncpu = os.cpu_count() or 1
def used_mb():
    v = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    page = int(re.search(r"page size of (\d+)", v).group(1))
    get = lambda k: int(re.search(rf"{k}:\s+(\d+)", v).group(1))
    return (get("Pages active") + get("Pages wired down") + get("Pages occupied by compressor")) * page / 2**20
t0 = time.time(); f = open(out, "w"); f.write("t_s,sys_cpu_pct,sys_used_mb,match_rss_mb,match_nproc\n")
while True:
    time.sleep(iv)
    rows = subprocess.run(["ps", "-axo", "rss=,%cpu=,command="], capture_output=True, text=True).stdout.splitlines()
    cpu = rss = n = 0
    for r in rows:
        parts = r.split(None, 2)
        if len(parts) < 3: continue
        cpu += float(parts[1])
        if pat.search(parts[2]) and "sampler" not in parts[2]: rss += int(parts[0]) / 1024; n += 1
    f.write("%.1f,%.1f,%.0f,%.0f,%d\n" % (time.time() - t0, min(100.0, cpu / ncpu), used_mb(), rss, n)); f.flush()
