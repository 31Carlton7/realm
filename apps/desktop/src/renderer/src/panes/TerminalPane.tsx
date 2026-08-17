import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { rpc } from "../rpc/client";
import { TerminalBuffer } from "./terminal-buffer";
import type { PaneProps } from "./registry";

const buffers = new Map<string, TerminalBuffer>();
let subscribed = false;
function ensureSubscription() {
  if (subscribed) return; subscribed = true;
  rpc().on("terminal.data", ({ terminalId, data }) => { (buffers.get(terminalId) ?? buffers.set(terminalId, new TerminalBuffer()).get(terminalId)!).push(data); });
  rpc().on("terminal.exit", ({ terminalId, exitCode }) => { buffers.get(terminalId)?.push(`\r\n[process exited with code ${exitCode}]\r\n`); });
}

export function TerminalPane({ item, visible }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalId = item.refId;

  useEffect(() => {
    ensureSubscription();
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace", theme: { background: "#17181b" }, allowProposedApi: true });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(ref.current!); fit.fit();
    termRef.current = term; fitRef.current = fit;
    const buf = buffers.get(terminalId) ?? buffers.set(terminalId, new TerminalBuffer()).get(terminalId)!;
    buf.attach((d) => term.write(d));
    const onData = term.onData((d) => void rpc().call("terminals.write", { terminalId, data: d }));
    const onResize = term.onResize(({ cols, rows }) => void rpc().call("terminals.resize", { terminalId, cols, rows }));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* not visible */ } });
    ro.observe(ref.current!);
    void rpc().call("terminals.resize", { terminalId, cols: term.cols, rows: term.rows });
    return () => { ro.disconnect(); onData.dispose(); onResize.dispose(); buf.detach(); term.dispose(); termRef.current = null; };
  }, [terminalId]);

  useEffect(() => { if (visible) { requestAnimationFrame(() => { try { fitRef.current?.fit(); termRef.current?.focus(); } catch { /* ignore */ } }); } }, [visible]);

  return <div className="terminal-pane" ref={ref} />;
}
