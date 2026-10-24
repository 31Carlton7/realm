#!/usr/bin/env python3
"""Runs one real agent CLI on one task inside the current worktree and records what happened.
usage: agent_wrap.py [<task prompt>]   (prompt from argv, else first line of stdin, as orchestrators pass it)
env: AGENT_CMD   command template; {prompt} is replaced by the shell-quoted prompt, {model} by $AGENT_MODEL
     AGENT_MODEL model id passed to the CLI (one model for the whole round)
     AGENT_TIMEOUT seconds (default 900)
Writes .bench/agent.log and .bench/result.json in the worktree. Token counts are parsed from the CLI's
JSON output when it prints usage (claude -p --output-format json, codex exec --json, opencode --format json);
otherwise tokens are recorded as null. Nothing is estimated."""
import os, sys, json, re, shlex, subprocess, time
prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.readline().strip()
os.makedirs(".bench", exist_ok=True)
cmd = os.environ["AGENT_CMD"].replace("{prompt}", shlex.quote(prompt)).replace("{model}", os.environ.get("AGENT_MODEL", ""))
t0 = time.time(); rc = None
with open(".bench/agent.log", "w") as lf:
    try: rc = subprocess.run(cmd, shell=True, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=int(os.environ.get("AGENT_TIMEOUT", "900"))).returncode
    except subprocess.TimeoutExpired: rc = "timeout"
wall = round(time.time() - t0, 2)
log = open(".bench/agent.log", errors="ignore").read()
def tok(keys):
    tot = 0; found = False
    for k in keys:
        for m in re.finditer(r'"%s"\s*:\s*(\d+)' % k, log): tot += int(m.group(1)); found = True
    return tot if found else None
res = {"exit": rc, "wall_s": wall, "input_tokens": tok(["input_tokens", "prompt_tokens"]), "output_tokens": tok(["output_tokens", "completion_tokens"]),
       "cache_read_tokens": tok(["cache_read_input_tokens", "cached_input_tokens"]), "cmd_template": os.environ["AGENT_CMD"], "model": os.environ.get("AGENT_MODEL")}
json.dump(res, open(".bench/result.json", "w"), indent=1); print("[agent_wrap] done", json.dumps(res), flush=True)
