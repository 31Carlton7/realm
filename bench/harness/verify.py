#!/usr/bin/env python3
"""verify.py <dir> <task>  -> exit 0 if the task's hidden verifier passes in <dir> (copy; dir untouched)."""
import sys, os, shutil, subprocess, tempfile
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixture", "verify")
d, t = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp()
shutil.copytree(d, tmp + "/r", ignore=shutil.ignore_patterns(".git"))
def unit(f):
    shutil.copy(os.path.join(FIX, f), tmp + "/r/_verify_hidden.py")
    p = subprocess.run([sys.executable, "-m", "unittest", "_verify_hidden", "-q"], cwd=tmp + "/r", capture_output=True, text=True)
    return p
def existing():
    return subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-q"], cwd=tmp + "/r", capture_output=True, text=True).returncode == 0
m = {"t1": "t1_bugfix.py", "t2": "t2_feature.py", "t3": "t3_refactor.py", "t5a": "t5a.py", "t5b": "t5b.py"}
if t == "t4":
    p = subprocess.run([sys.executable, os.path.join(FIX, "t4_tests_quality.py"), tmp + "/r"], capture_output=True, text=True)
    print(p.stdout.strip(), p.stderr.strip()[-300:]); ok = p.returncode == 0 and existing()
else:
    p = unit(m[t]); ok = p.returncode == 0 and existing()
    if not ok: print((p.stdout + p.stderr)[-400:])
print("%s %s" % (t, "PASS" if ok else "FAIL")); sys.exit(0 if ok else 1)
