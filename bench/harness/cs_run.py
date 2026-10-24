#!/usr/bin/env python3
"""Drive Claude Squad TUI in tmux through the 6-task suite using the deterministic stub agent. Logs to runs/C-claude-squad/."""
import subprocess, time, json, os, sys, shutil, glob
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = f"{ROOT}/runs/C-claude-squad"; os.makedirs(OUT, exist_ok=True)
CRASH = os.environ.get("STUB_CRASH", "")
tasks = json.load(open(f"{ROOT}/fixture/tasks.json")); names = ["t1","t2","t3","t4","t5a","t5b"]
repo = "/tmp/cs-repo"; shutil.rmtree(repo, ignore_errors=True); subprocess.run(["cp","-r",f"{ROOT}/fixture/repo",repo],check=True)
subprocess.run("tmux kill-server",shell=True,stderr=subprocess.DEVNULL)
shutil.rmtree(os.path.expanduser("~/.claude-squad/worktrees"),ignore_errors=True)
subprocess.run([f"{ROOT}/tools/cs/claude-squad","reset"],capture_output=True)
cfg={"default_program":"stub","auto_yes":False,"daemon_poll_interval":1000,"branch_prefix":"bench/","profiles":[{"name":"stub","program":f"env STUB_SLEEP=10 STUB_CRASH={CRASH} python3 {ROOT}/harness/benchagent.py"}]}
json.dump(cfg,open(os.path.expanduser("~/.claude-squad/config.json"),"w"))
sam=subprocess.Popen([sys.executable,f"{ROOT}/harness/sampler.py",f"{OUT}/resources{'-crash' if CRASH else ''}.csv","1"],env={**os.environ,"PAT":"claude-squad|benchagent|tmux"})
tm=lambda *a: subprocess.run(["tmux",*a],check=True)
T0=time.time()
tm("new-session","-d","-s","cs","-x","200","-y","50","-c",repo,f"{ROOT}/tools/cs/claude-squad")
while "No agents running" not in subprocess.run(["tmux","capture-pane","-t","cs","-p"],capture_output=True,text=True).stdout and time.time()-T0<30: time.sleep(.1)
ui_ready=time.time()-T0
res={"ui_ready_s":round(ui_ready,2),"sessions":{}}
tm("send-keys","-t","cs","q") if False else None
create_t={}
for n in names:
    t=time.time(); tm("send-keys","-t","cs","N"); time.sleep(.4); tm("send-keys","-t","cs",n,"Enter"); time.sleep(.4)
    tm("send-keys","-t","cs","-l",tasks[n]); tm("send-keys","-t","cs","Tab"); time.sleep(.15); tm("send-keys","-t","cs","Tab"); time.sleep(.15); tm("send-keys","-t","cs","Enter")
    # wait for worktree dir and stub banner
    while time.time()-t<30:
        w=glob.glob(os.path.expanduser(f"~/.claude-squad/worktrees/bench/{n}_*"))
        if w and "[benchagent] task" in subprocess.run(["tmux","capture-pane","-t","cs","-p"],capture_output=True,text=True).stdout: break
        time.sleep(.1)
    create_t[n]=time.time()-t; time.sleep(.3)
    if "Instance Created" in subprocess.run(["tmux","capture-pane","-t","cs","-p"],capture_output=True,text=True).stdout: tm("send-keys","-t","cs","Escape"); time.sleep(.3)  # dismiss help overlay if shown
    # the first Enter after creation dismisses overlay; harmless otherwise
    open(f"{OUT}/screen-after-{n}.txt","w").write(subprocess.run(["tmux","capture-pane","-t","cs","-p"],capture_output=True,text=True).stdout)
res["first_agent_running_s"]=round(create_t[names[0]]+ui_ready,2)
res["create_each_s"]={k:round(v,2) for k,v in create_t.items()}
res["all_sessions_created_s"]=round(time.time()-T0,2)
# wait for completion: stub finishes ~10s after each start
time.sleep(12 if not CRASH else 12)
wts={n:glob.glob(os.path.expanduser(f"~/.claude-squad/worktrees/bench/{n}_*")) for n in names}
res["worktrees_found"]={n:(w[0] if w else None) for n,w in wts.items()}
for n,w in wts.items():
    if not w: res["sessions"][n]={"worktree":False}; continue
    v=subprocess.run([sys.executable,f"{ROOT}/harness/verify.py",w[0],n],capture_output=True,text=True)
    res["sessions"][n]={"verified":v.returncode==0,"partial_file":os.path.exists(w[0]+"/PARTIAL_WORK.txt")}
res["total_wall_s"]=round(time.time()-T0,2)
open(f"{OUT}/final-screen{'-crash' if CRASH else ''}.txt","w").write(subprocess.run(["tmux","capture-pane","-t","cs","-p"],capture_output=True,text=True).stdout)
# branches visible in the main repo
res["branches"]=subprocess.run(["git","branch","--list","bench/*"],cwd=repo,capture_output=True,text=True).stdout.split()
sam.terminate()
open(f"{OUT}/result{'-crash' if CRASH else ''}.json","w").write(json.dumps(res,indent=1)); print(json.dumps(res,indent=1))
