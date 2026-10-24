#!/usr/bin/env python3
"""Deterministic stub agent CLI (NOT an LLM). Tests orchestrator mechanics only.
usage: benchagent.py "<task prompt>"   env: STUB_SLEEP (s, default 8), STUB_CRASH=<task id> kills itself mid-run"""
import sys, os, time, shutil, signal
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.readline()
if prompt.startswith("Bug fix"): t = "t1"
elif prompt.startswith("Feature: add a new module"): t = "t2"
elif prompt.startswith("Refactor"): t = "t3"
elif prompt.startswith("Write tests"): t = "t4"
elif prompt.startswith("Change:"): t = "t5a"
elif prompt.startswith("Feature: in shelf/config"): t = "t5b"
else: print("unknown task"); sys.exit(2)
print("[benchagent] task", t, "cwd", os.getcwd(), flush=True)
half = float(os.environ.get("STUB_SLEEP", "8")) / 2
time.sleep(half)
if os.environ.get("STUB_CRASH") == t:
    open("PARTIAL_WORK.txt", "w").write("half done\n"); print("[benchagent] crashing", flush=True); os.kill(os.getpid(), signal.SIGKILL)
time.sleep(half)
shutil.copytree(f"{ROOT}/fixture/ref/{t}", ".", dirs_exist_ok=True)
print("[benchagent] done", flush=True)
