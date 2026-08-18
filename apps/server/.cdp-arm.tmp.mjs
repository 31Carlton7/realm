import { WebSocket } from "ws"; import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const ws = new WebSocket(readFileSync("/tmp/cdp-target","utf8").trim());
let n=0; const pend={};
const cmd=(m,p={})=>new Promise(r=>{const id=++n;pend[id]=r;ws.send(JSON.stringify({id,method:m,params:p}))});
writeFileSync("/tmp/swipe-console.log","");
ws.on("message",d=>{const m=JSON.parse(d); if(m.id&&pend[m.id]){pend[m.id](m);delete pend[m.id];}
  else if(m.method==="Runtime.consoleAPICalled"){ const line=m.params.args.map(a=>a.value??a.description??"").join(" "); if(line.startsWith("[swipe")) appendFileSync("/tmp/swipe-console.log", line+"\n"); }});
ws.on("open",async()=>{ await cmd("Runtime.enable"); await cmd("Runtime.evaluate",{expression:`localStorage.setItem("realm.debugSwipe","1"); "armed"`}); console.log("armed; capturing for 60s"); setTimeout(()=>process.exit(0),60000); });
