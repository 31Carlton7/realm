import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Machine, MachineImageProgress, MachineState } from "@realm/contracts";
import type { PaneProps } from "../registry";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { getMachineHub, loadRfb } from "./machine-hub";
import { fitFramebuffer, scaleLabel, type FitMode } from "./fit";
import { E2B_STREAM_PORT, SANDBOX_NOTES, describeEndpoint, parseMachineAddress, type SandboxProvider } from "@realm/contracts";

/**
 * A screen somewhere else (Plan 25 W3).
 *
 * The one structural thing to know about this pane, because everything else follows from it: the
 * screen is a DOM `<canvas>`, not a `WebContentsView`. A native view composites above all DOM
 * unconditionally, which is why the browser pane has no dropdowns, why `state/no-overlay.ts` exists,
 * and why every sheet in the app dodges browser panes. A canvas has none of that tax — menus, the
 * command palette and every sheet open OVER a machine screen, and a `Page.captureScreenshot` is
 * valid evidence about it, which is the inverse of design.md's warning about native views.
 *
 * So this pane registers NO `browserRect`, deliberately and with a test: adding one would make the
 * palette and every sheet start dodging a pane that composites nothing.
 */

/** The pane's body is chosen by what is actually true, in this order. `unconfigured` is not a
 *  machine state — it is a row with no address yet, which is what the session bar's button makes. */
type Body = "unconfigured" | "downloading" | "off" | "booting" | "running" | "failed";

function bodyFor(machine: Machine | null, state: MachineState, downloading: boolean): Body {
  if (!machine) return "unconfigured";
  // Ahead of everything: a machine fetching its own image has a body of its own, and it is the one
  // state here with a real fraction to draw.
  if (downloading) return "downloading";
  // A `qemu` guest has no address of its own until it boots, so the endpoint test is only about the
  // sources that are reached BY one.
  if (machine.source === "vnc" && !machine.endpoint) return "unconfigured";
  if (state.status === "failed") return "failed";
  if (state.status === "running") return "running";
  if (state.status === "booting") return "booting";
  return "off";
}

/** What the pane says about each failure. The server sends a WORD; this is the only place that
 *  turns one into a sentence, so a code can be grepped and a sentence can be rewritten. */
const REASONS: Record<string, string> = {
  unreachable: "Realm could not reach that address.",
  not_rfb: "Something answered on that port, but it is not a screen-sharing server.",
  auth_failed: "The password was refused.",
  auth_unsupported: "That server wants a kind of sign-in Realm does not speak.",
  disconnected: "The machine closed the connection.",
  no_secret_store: "macOS would not give Realm an encryption key, so the password could not be saved.",
  source_unavailable: "Realm cannot start that kind of machine yet.",
};

export function MachinePane({ item }: PaneProps) {
  const refId = item.refId;
  const state = useApp((s) => s.machineState[refId]) ?? { machineId: refId, status: "off" as const, wsUrl: null, width: null, height: null, error: null, detail: null };
  const [machine, setMachine] = useState<Machine | null>(null);
  const reload = useCallback(async () => {
    const r = await rpc().call("machines.get", { machineId: refId }).catch(() => null);
    if (r) setMachine(r.machine);
  }, [refId]);
  useEffect(() => { void reload(); }, [reload]);

  const progress = useApp((s) => s.machineImageProgress[refId]);
  const body = bodyFor(machine, state, !!progress && !progress.done);
  return (
    <div className="machine-pane">
      {body === "unconfigured" && <ConnectFlow machineId={refId} machine={machine} onSaved={reload} />}
      {body === "downloading" && progress && <DownloadBody machineId={refId} progress={progress} />}
      {body === "off" && machine && <OffBody machine={machine} />}
      {body === "failed" && <FailedBody state={state} machineId={refId} onEdit={() => setMachine((m) => (m ? { ...m, endpoint: null } : m))} />}
      {(body === "booting" || body === "running") && (machine?.source === "mac"
        ? <PolledScreen machineId={refId} bundleId={machine.endpoint?.host ?? ""} />
        : <Screen machineId={refId} state={state} />)}
    </div>
  );
}

/* --------------------------------- the connect flow --------------------------------- */

/**
 * The pane's body, not a sheet.
 *
 * design.md: "Empty panes should offer the shortest honest path to useful work" — and there is
 * nothing behind a sheet worth preserving here. One form, one home: the command palette and the
 * space menu create the pane too rather than opening a second copy of this in a modal.
 *
 * Two routes, in the order they are likely to work for the person reading them. "Another Mac" gets
 * its own row rather than being buried under "VNC", because that is how someone thinks about the
 * laptop on the other desk — while the transport underneath is the ordinary `vnc` source.
 */
function ConnectFlow({ machineId, machine, onSaved }: { machineId: string; machine: Machine | null; onSaved: () => void }) {
  const [route, setRoute] = useState<Route>("mac");
  /**
   * What this Mac can offer.
   *
   * The local-VM route is ABSENT when QEMU is not installed, not disabled — design.md: "Where the
   * owner has said nothing, show nothing, not a disabled control, which invites a user to work out
   * how to enable something nobody has claimed." Asked once per pane; the answer does not change
   * while Realm is running.
   */
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { void rpc().call("machines.capabilities", {}).then(setCaps).catch(() => setCaps(null)); }, []);
  const [image, setImage] = useState<string>("");
  /**
   * Apps on this Mac, for the "This Mac's screen" route — and the hall-of-mirrors gate.
   *
   * Mirroring the ONLY display into a pane on that display is a hall of mirrors: the pane shows the
   * pane showing the pane. So this route offers a single WINDOW of a named app, never the desktop,
   * which is honest at any number of displays — and the list is `computerListApps`'s own, which
   * already excludes Realm itself, System Settings, password prompts and terminals.
   *
   * Empty means computer use has not been granted, and the route is left out rather than shown
   * empty: an empty picker is a control whose only outcome is a refusal.
   */
  const [apps, setApps] = useState<{ bundleId: string; name: string }[] | null>(null);
  useEffect(() => {
    void rpc().call("machines.apps", {}).then((r) => setApps(r.apps)).catch(() => setApps([]));
  }, []);
  const [name, setName] = useState(machine?.name && machine.name !== "New machine" ? machine.name : "");
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [header, setHeader] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  // The pane opens with the flow already focused, which is exactly what "clicking it opens the pane
  // with the connection flow ready to go" asks for.
  useEffect(() => { addressRef.current?.focus(); }, [route]);

  /**
   * What Realm will actually dial, worked out on every keystroke and SHOWN.
   *
   * This is the whole of the sandbox support that a person sees. Four providers hand out four
   * different shapes — an HTML page URL, a TLS host and port, an HTTPS origin, a plain address — and
   * each needs a different transport underneath. Resolving that silently would be the app knowing
   * something the user cannot check; resolving it out loud, with the transport named and editable,
   * is the same work done honestly.
   */
  const parsed = useMemo(() => {
    const raw = route === "e2b" ? (address.trim() ? `https://${E2B_STREAM_PORT}-${address.trim()}.e2b.app/vnc.html` : "") : address;
    return raw.trim() ? parseMachineAddress(raw) : null;
  }, [address, route]);
  const endpoint = parsed && !("error" in parsed) ? parsed.endpoint : null;
  const provider = parsed && !("error" in parsed) ? parsed.provider : ROUTE_PROVIDER[route];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (route === "vm") return submitGuest(e);
    if (!parsed) { setNote("Enter the machine's address."); return; }
    if ("error" in parsed) { setNote(parsed.error); return; }
    setBusy(true);
    setNote(null);
    try {
      const r = await rpc().call("machines.update", {
        machineId,
        name: name.trim() || parsed.endpoint.host,
        endpoint: parsed.endpoint,
        password: password || null,
        headers: header.trim() ? { [HEADER_NAME[route] ?? "authorization"]: header.trim() } : null,
      });
      // The one case that can silently do less than asked: with no encryption key the server refuses
      // to store the password rather than writing a login into realm.db in the clear. Said out loud,
      // because a form that claimed to save it would be lying about where the password is.
      if ((password || header.trim()) && !r.passwordStored) {
        setNote("Connected without saving the password — macOS would not give Realm an encryption key, so it was not stored.");
      }
      onSaved();
      await rpc().call("machines.start", { machineId });
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * A guest on this Mac: pick an image, and the row keeps its shape while the bytes arrive.
   *
   * Pressing this with the image not yet on disk creates nothing new — the machine and the pane
   * already exist — and the pane's body becomes the download's own. The user can close it, switch
   * spaces and come back, because the download is the server's.
   */
  const submitApp = async () => {
    const app = apps?.find((a) => a.bundleId === address);
    if (!app) { setNote("Choose an app."); return; }
    setBusy(true);
    setNote(null);
    try {
      // The bundle id goes in the endpoint's `host`, which is the same grant key
      // `computer.allowedApps` uses — so machine control and computer use cannot disagree about
      // what TextEdit is.
      await rpc().call("machines.update", { machineId, name: name.trim() || app.name, endpoint: { transport: "tcp", host: app.bundleId, port: 1, path: "/" } });
      onSaved();
      await rpc().call("machines.start", { machineId });
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const submitGuest = async (e: React.FormEvent) => {
    e.preventDefault();
    const entry = caps?.catalog.find((c) => c.id === image);
    if (!entry) { setNote("Choose what to install."); return; }
    setBusy(true);
    setNote(null);
    try {
      await rpc().call("machines.update", { machineId, name: name.trim() || entry.name });
      onSaved();
      await rpc().call("machines.images.download", { machineId, catalogId: entry.id });
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (route === "thisMac") {
    return (
      <div className="machine-body">
        <form className="machine-connect" onSubmit={(e) => { e.preventDefault(); void submitApp(); }}>
          <h2 className="machine-title">An app on this Mac</h2>
          <div className="machine-routes" role="radiogroup" aria-label="What are you connecting to?">
            {ROUTES.filter((r) => visible(r.id, caps, apps)).map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={route === r.id}
                data-on={route === r.id || undefined} onClick={() => { setRoute(r.id); setNote(null); }}>{r.label}</button>
            ))}
          </div>
          {/* A window, never the desktop: mirroring the only display into a pane on that display is
              a hall of mirrors, and a single window is honest at any number of displays. */}
          <p className="machine-hint">Shows one app's windows, updated a few times a second. Realm, System Settings, password prompts and terminals are never listed and can never be driven.</p>
          <div className="machine-guests">
            {(apps ?? []).map((a) => (
              <button key={a.bundleId} type="button" className="machine-guest" data-on={address === a.bundleId || undefined}
                aria-pressed={address === a.bundleId} onClick={() => setAddress(a.bundleId)}>
                <span className="machine-guest-name">{a.name}</span>
                <span className="machine-guest-size">{a.bundleId}</span>
              </button>
            ))}
          </div>
          {note && <p className="machine-note" role="status">{note}</p>}
          <button type="submit" className="machine-primary" disabled={busy || !address}>{busy ? "Opening…" : "Show it"}</button>
        </form>
      </div>
    );
  }

  if (route === "vm") {
    return (
      <div className="machine-body">
        <form className="machine-connect" onSubmit={submitGuest}>
          <h2 className="machine-title">A Linux VM on this Mac</h2>
          <div className="machine-routes" role="radiogroup" aria-label="What are you connecting to?">
            {ROUTES.filter((r) => visible(r.id, caps, apps)).map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={route === r.id}
                data-on={route === r.id || undefined} onClick={() => { setRoute(r.id); setNote(null); }}>{r.label}</button>
            ))}
          </div>
          {/* One line of exact fact, in the app's own words rather than QEMU's. */}
          <p className="machine-hint">
            {caps?.qemu.hvf
              ? "Runs with hardware acceleration."
              : "Runs without hardware acceleration on this Mac, so expect it to be slow."}
            {caps?.qemu.version ? ` QEMU ${caps.qemu.version}.` : ""}
          </p>
          <div className="machine-guests">
            {(caps?.catalog ?? []).map((c) => (
              <button key={c.id} type="button" className="machine-guest" data-on={image === c.id || undefined}
                aria-pressed={image === c.id} onClick={() => setImage(c.id)}>
                <span className="machine-guest-name">{c.name}</span>
                <span className="machine-guest-facts">{c.summary}</span>
                {/* What it will cost, before it starts. And whether Realm can check what arrives:
                    an entry with no published checksum says so rather than implying one. */}
                <span className="machine-guest-size">{human(c.bytes)} · {c.memoryMb / 1024} GB · {c.diskGb} GB disk{c.verified ? "" : " · unverified download"}</span>
              </button>
            ))}
          </div>
          <label className="machine-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={caps?.catalog.find((c) => c.id === image)?.name ?? "Debian"} />
          </label>
          {caps?.absent && <p className="machine-hint">{caps.absent}</p>}
          {note && <p className="machine-note" role="status">{note}</p>}
          <button type="submit" className="machine-primary" disabled={busy || !image}>{busy ? "Starting…" : "Download and install"}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="machine-body">
      <form className="machine-connect" onSubmit={submit}>
        <h2 className="machine-title">Connect a machine</h2>
        {/* In the order each is likely to work for the person reading it. "Another Mac" gets its own
            row rather than being buried under VNC, because that is how someone thinks about the
            laptop on the other desk — while the transport underneath is the ordinary `vnc` source. */}
        <div className="machine-routes" role="radiogroup" aria-label="What are you connecting to?">
          {ROUTES.filter((r) => visible(r.id, caps, apps)).map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={route === r.id}
              data-on={route === r.id || undefined} onClick={() => { setRoute(r.id); setNote(null); }}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="machine-hint">{SANDBOX_NOTES[provider]}</p>
        <label className="machine-field">
          <span>{ROUTE_FIELD[route]}</span>
          <input ref={addressRef} value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder={ROUTE_PLACEHOLDER[route]} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        </label>
        {/* What was inferred, in the units it will be dialled in. A person who pasted a page URL and
            sees `wss://…/websockify` learns what happened; one who sees nothing learns it from a
            failure ten seconds later. */}
        {endpoint && (
          <p className="machine-resolved">
            <span className="machine-resolved-target">{describeEndpoint(endpoint)}</span>
            {parsed && !("error" in parsed) && parsed.inferred && <span className="machine-resolved-why">{parsed.inferred}</span>}
          </p>
        )}
        {parsed && "error" in parsed && address.trim().length > 3 && <p className="machine-note" role="status">{parsed.error}</p>}
        <label className="machine-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={endpoint?.host ?? "Studio Mac"} />
        </label>
        <label className="machine-field">
          <span>Password <span className="machine-optional">optional</span></span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </label>
        {/* Only where a provider's own ingress asks for one. A field that is dead on three routes out
            of four is an inventory, and design.md is explicit that a first screen is a decision. */}
        {HEADER_NAME[route] && (
          <label className="machine-field">
            <span>Ingress token <span className="machine-optional">optional</span></span>
            <input type="password" value={header} onChange={(e) => setHeader(e.target.value)} autoComplete="off"
              placeholder={`sent as ${HEADER_NAME[route]}`} />
          </label>
        )}
        {/* design.md: "Prefer 'the agent never receives the token' to 'secure by design'." */}
        <p className="machine-hint">Realm connects from this Mac and signs in here. The password never reaches the agent or the page.</p>
        {note && <p className="machine-note" role="status">{note}</p>}
        <button type="submit" className="machine-primary" disabled={busy || !endpoint}>{busy ? "Connecting…" : "Connect"}</button>
      </form>
    </div>
  );
}

/**
 * The routes, and why they are these four.
 *
 * Not one row per vendor: that is a list that goes stale the week somebody launches a fifth, and
 * design.md is explicit that a capability offered on a guess is one whose only outcome is a refusal.
 * These are the four SHAPES a person actually arrives with — a Mac on the desk, a sandbox id, a URL
 * their tooling printed, a host and port — and every provider reduces to one of them. E2B gets its
 * own row only because a sandbox id is not an address and cannot be recognised as one.
 */
type Route = "mac" | "e2b" | "sandbox" | "address" | "vm" | "thisMac";

const ROUTES: readonly { id: Route; label: string }[] = [
  { id: "mac", label: "Another Mac" },
  { id: "e2b", label: "E2B Desktop" },
  { id: "sandbox", label: "A sandbox URL" },
  { id: "address", label: "Host and port" },
  // Last, and each only where it is honest — see `visible`.
  { id: "vm", label: "A Linux VM here" },
  { id: "thisMac", label: "An app on this Mac" },
];

/**
 * Which routes are offered at all.
 *
 * design.md: "Where the owner has said nothing, show nothing — not a disabled control, which invites
 * a user to work out how to enable something nobody has claimed." So a route whose precondition is
 * unmet is ABSENT rather than greyed:
 *
 *   - the local VM needs QEMU installed;
 *   - this Mac's own screen needs computer use granted, which is what an empty app list means.
 */
function visible(id: Route, caps: Capabilities | null, apps: { bundleId: string }[] | null): boolean {
  if (id === "vm") return caps?.qemu.available === true;
  if (id === "thisMac") return (apps?.length ?? 0) > 0;
  return true;
}

/** `machines.capabilities`, as the pane reads it. */
type Capabilities = {
  qemu: { available: boolean; unavailable: string | null; version: string | null; hvf: boolean; arches: string[] };
  catalog: { id: string; name: string; summary: string; arch: string; bytes: number; kind: string; memoryMb: number; cpus: number; diskGb: number; verified: boolean }[];
  absent: string;
};

const ROUTE_PROVIDER: Record<Route, SandboxProvider> = {
  mac: "screen-sharing", e2b: "e2b", sandbox: "generic", address: "generic", vm: "generic", thisMac: "generic",
};

const ROUTE_FIELD: Record<Route, string> = {
  mac: "Address", e2b: "Sandbox ID", sandbox: "URL", address: "Host and port", vm: "Image", thisMac: "App",
};

const ROUTE_PLACEHOLDER: Record<Route, string> = {
  mac: "studio.local",
  e2b: "i7bx2k9qp",
  // Modal's own is a host and port rather than a URL, and it belongs on this row because it is what
  // `sandbox.tunnels()` prints — the shape follows from the provider, not from the label.
  sandbox: "https://…vercel.run  ·  wss://…  ·  xyz.modal.host:44421",
  address: "10.0.1.14:5900",
  vm: "",
  thisMac: "",
};

/**
 * The header a route's own ingress asks for, or nothing.
 *
 * Namespace's is the documented case — `x-nsc-ingress-auth` with a bearer — and it is also the
 * reason this field can exist at all: a browser cannot set a header on a WebSocket, so a sandbox
 * behind an authenticating proxy is reachable only because the relay dials from the server.
 */
const HEADER_NAME: Partial<Record<Route, string>> = { sandbox: "x-nsc-ingress-auth" };

/**
 * A machine fetching its own image.
 *
 * A DETERMINATE bar, because here the fraction is real — unlike `booting`, where there is no
 * measurable one and design.md is explicit that "where a figure genuinely cannot be stated, draw
 * nothing at all rather than an empty meter, which is itself a claim".
 *
 * The download is the SERVER's and this is a view of it: closing the pane, switching spaces and
 * coming back all leave it running. That is the same "a pane is a window onto a process that
 * outlives it" property the terminal hub has, and it is what makes the pane bar's × a layout close.
 */
function DownloadBody({ machineId, progress }: { machineId: string; progress: MachineImageProgress }) {
  const pct = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null;
  const cancel = () => { void rpc().call("machines.images.cancel", { machineId }).catch(() => {}); };
  return (
    <div className="machine-body">
      <div className="machine-rest">
        <h2 className="machine-title">Downloading</h2>
        {/* Tabular mono, because the left-hand number changes every frame and a proportional face
            makes the whole line jitter. */}
        <p className="machine-facts">{human(progress.received)}{progress.total ? ` of ${human(progress.total)}` : ""}</p>
        <div className="machine-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <div className="machine-meter-fill" style={{ width: `${pct ?? 0}%` }} />
        </div>
        <div className="machine-actions"><button onClick={cancel}>Cancel</button></div>
      </div>
    </div>
  );
}

/** Bytes as a person reads them. Mirrors the server's own `human`, which the renderer cannot import
 *  — one is in `apps/server`, and a shared helper for six lines would be a package edge. */
function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/* --------------------------------- the resting states --------------------------------- */

function OffBody({ machine }: { machine: Machine }) {
  const start = () => { void rpc().call("machines.start", { machineId: machine.id }); };
  return (
    <div className="machine-body">
      <div className="machine-rest">
        <h2 className="machine-title">{machine.name}</h2>
        {/* One line of exact fact in mono — a first-run screen is a decision, not an inventory. */}
        <p className="machine-facts">{machine.endpoint?.host}:{machine.endpoint?.port}{machine.hasPassword ? " · password saved" : ""}</p>
        <button className="machine-primary" onClick={start}>Connect</button>
      </div>
    </div>
  );
}

function FailedBody({ state, machineId, onEdit }: { state: MachineState; machineId: string; onEdit: () => void }) {
  const retry = () => { void rpc().call("machines.start", { machineId }); };
  return (
    <div className="machine-body">
      <div className="machine-rest">
        <h2 className="machine-title">Could not connect</h2>
        <p className="machine-reason">{REASONS[state.error ?? ""] ?? "Realm could not connect to that machine."}</p>
        {/* The server's own words, verbatim. `machineError` exists precisely because the state alone
            is a dead end — "unreachable" tells a reader nothing they can act on, and "nothing is
            listening on port 5900 at that address" tells them what to change. */}
        {state.detail && <p className="machine-detail">{state.detail}</p>}
        <div className="machine-actions">
          <button className="machine-primary" onClick={retry}>Try again</button>
          <button onClick={onEdit}>Edit the address</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- the screen --------------------------------- */

/**
 * The canvas, and the geometry around it.
 *
 * The framebuffer's size comes from `machine.status` rather than from noVNC, deliberately: the
 * server learned it from the ServerInit during the handshake it performed itself, which is strictly
 * earlier than anything the renderer's client can report — so the pane can size the letterbox before
 * the first frame decodes rather than snapping when it arrives.
 */
function Screen({ machineId, state }: { machineId: string; state: MachineState }) {
  const holder = useRef<HTMLDivElement>(null);
  const grabbed = useApp((s) => s.machineGrab[machineId] === true);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  // From the store rather than local state: the ⋯ menu sets it, and a mode the pane owned would
  // be one the menu could not reach.
  const mode = useApp((s) => s.machineScale[machineId]) ?? ("fit" as FitMode);
  const [ready, setReady] = useState(() => (state.wsUrl ? getMachineHub().isConnected(machineId) : false));

  // The hub owns the connection; this only moves its host element in and out of the DOM. Detach does
  // NOT disconnect, which is what makes coming back to a machine show the current screen.
  useEffect(() => {
    const url = state.wsUrl;
    const el = holder.current;
    if (!url || !el) return;
    let live = true;
    void loadRfb().then(() => {
      if (!live || !holder.current) return;
      const entry = getMachineHub().acquire(machineId, url);
      entry.attach(holder.current);
      setReady(getMachineHub().isConnected(machineId));
      const off = getMachineHub().onConnect(machineId, () => setReady(true));
      cleanup = () => { off(); entry.detach(); };
    });
    let cleanup: (() => void) | null = null;
    return () => { live = false; cleanup?.(); };
  }, [machineId, state.wsUrl]);

  // Re-derive on resize, and on a DPR change — for which there is no event, only a media query that
  // stops matching when the window moves to a display with a different scale factor.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setBox({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const mq = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    if (!mq) return;
    const fn = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [dpr]);

  /**
   * Grab keyboard: stop Realm's own bindings before they see the key.
   *
   * On `window` and in the CAPTURE phase. `hotkeys.ts` listens on `window` too, but in the BUBBLE
   * phase — and capture on the same target always runs first, so `stopPropagation` here means the
   * global handler never runs at all. A bubble-phase listener, on the pane or on `window`, would be
   * a coin toss decided by registration order: the toggle would light up and ⌘T would still open a
   * Realm terminal.
   *
   * Nothing is `preventDefault`ed: the key still has to reach the canvas, and noVNC's own handler is
   * what sends it to the guest.
   *
   * What this CANNOT take is what the platform ate first. ⌘Q, ⌘Tab and ⌘Space are menu accelerators
   * and window-server chords, and a menu accelerator fires in the main process before the renderer
   * sees a keydown at all — `hotkeys.ts` writes that down for ⌘W. So the grab is honest about being
   * a grab of REALM's shortcuts, not of the Mac's, and the chords the platform keeps belong to a
   * Send key ▸ menu instead.
   */
  useEffect(() => {
    if (!grabbed) return;
    const swallow = (e: KeyboardEvent) => { if (holder.current?.contains(e.target as Node)) e.stopPropagation(); };
    window.addEventListener("keydown", swallow, true);
    window.addEventListener("keyup", swallow, true);
    return () => {
      window.removeEventListener("keydown", swallow, true);
      window.removeEventListener("keyup", swallow, true);
    };
  }, [grabbed]);

  const fb = { width: state.width ?? 0, height: state.height ?? 0 };
  const fit = useMemo(() => fitFramebuffer(fb, box, dpr, mode), [fb.width, fb.height, box.width, box.height, dpr, mode]);

  return (
    <div className="machine-screen" data-scale={mode} data-grabbed={grabbed || undefined} ref={holder}
      style={{ ["--machine-w" as string]: `${fit.cssWidth}px`, ["--machine-h" as string]: `${fit.cssHeight}px` }}>
      {!ready && (
        <div className="machine-starting" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Connecting…</span>
        </div>
      )}
    </div>
  );
}

/**
 * This Mac's own screen, polled (Plan 25 W7).
 *
 * Deliberately NOT a stream. 30fps of base64 JPEG through the JSON-RPC socket would put megabytes a
 * second alongside session events, and the real cost of a stream is not the capture code — it is an
 * `SCStream` with an output delegate on its own queue, a `didStopWithError` path for display
 * reconfiguration and mid-stream permission revocation, filter re-creation whenever the app's window
 * set changes, and a long-lived helper process with a lifecycle in main. A poll at this rate is
 * honest for "watch an agent drive TextEdit", and needs none of it.
 *
 * Paused while the pane is not visible: a hidden pane polling a screenshot every 700ms is battery
 * spent on an image nobody is looking at.
 */
function PolledScreen({ machineId, bundleId }: { machineId: string; bundleId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!live) return;
      try {
        const shot = await rpc().call("machines.capture", { machineId });
        if (!live) return;
        if (shot.data) { setSrc(`data:${shot.mimeType};base64,${shot.data}`); setError(null); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "macOS would not hand over an image.");
      }
      // Scheduled AFTER the previous frame settles rather than on an interval: a capture slower than
      // the period would otherwise queue up behind itself forever.
      if (live) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [machineId, bundleId]);

  return (
    <div className="machine-screen" data-scale="fit">
      {src
        ? <img className="machine-poll" src={src} alt={`The screen of ${bundleId}`} />
        : (
          <div className="machine-starting" role="status">
            {!error && <span className="spinner" aria-hidden="true" />}
            <span>{error ?? "Capturing…"}</span>
          </div>
        )}
    </div>
  );
}

/** 1.4 frames a second. Fast enough to watch a click land, slow enough that the JSON-RPC socket
 *  carrying it is also carrying a session's events without either noticing. */
const POLL_MS = 700;

/** The pane bar's subtitle: the guest's live resolution in mono, and the scale as a percentage only
 *  when there is resampling to declare — a "100%" on every pane is a number nobody reads. */
export function machineMeta(state: MachineState | undefined, dpr = window.devicePixelRatio || 1): string | null {
  if (!state || state.width === null || state.height === null) return null;
  const fit = fitFramebuffer({ width: state.width, height: state.height }, { width: state.width, height: state.height }, dpr);
  const pct = scaleLabel(fit, dpr);
  return `${state.width}×${state.height}${pct ? ` · ${pct}` : ""}`;
}

/** The word a state wears, in plain sentence case — not QEMU's "powered on"/"halted". */
export const MACHINE_WORDS: Record<MachineState["status"], string> = {
  off: "not connected",
  booting: "starting up",
  running: "connected",
  suspended: "suspended",
  failed: "failed to connect",
};
