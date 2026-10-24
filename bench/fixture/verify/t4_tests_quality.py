# Runs agent-written tests/test_stats.py against correct impl and 3 mutants.
import subprocess, sys, shutil, os, tempfile
repo=sys.argv[1]
orig=open(os.path.join(repo,"shelf/stats.py")).read()
muts={
 "median_even":orig.replace("(s[mid - 1] + s[mid]) / 2","s[mid]"),
 "clamp_hi":orig.replace("max(lo, min(x, hi))","max(lo, x)"),
 "mean_empty":orig.replace('    if not xs:\n        raise ValueError("empty")\n    return sum','    if not xs:\n        return 0\n    return sum'),
}
def run(src):
    d=tempfile.mkdtemp(); shutil.copytree(repo,d+"/r",ignore=shutil.ignore_patterns(".git"))
    open(d+"/r/shelf/stats.py","w").write(src)
    p=subprocess.run([sys.executable,"-m","unittest","discover","-s","tests","-t",".","-p","test_stats.py"],cwd=d+"/r",capture_output=True,text=True)
    return p.returncode
assert os.path.exists(os.path.join(repo,"tests/test_stats.py")),"no tests/test_stats.py"
ok=run(orig)==0
killed=sum(1 for k,v in muts.items() if v!=orig and run(v)!=0)
print("passes_on_correct=%s mutants_killed=%d/3"%(ok,killed))
sys.exit(0 if ok and killed==3 else 1)
