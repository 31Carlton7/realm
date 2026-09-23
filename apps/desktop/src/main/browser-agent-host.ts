/**
 * The browser agent op executor (Plan 11 W3), Electron-free: everything Electron lives behind the
 * injected `CdpBinding` factory (browser-pane.ts) and the pane-host callbacks. One instance per
 * window process; state is per browser id — a live CDP attachment, the console/network ring buffers
 * (filled from CDP events from the moment of first attach), the download-block notes, and the
 * previous snapshot's fingerprint index that `*[new]` markers diff against.
 */
import { DOWNLOAD_GRANT_TTL_MS, UPLOAD_ARM_WINDOW_MS, normalizeOrigin, type BrowserAction, type BrowserActResult, type BrowserCredential, type BrowserDescribeResult, type BrowserDismissDialogResult, type BrowserDownloadResult, type BrowserUploadFile, type BrowserUploadResult, PICK_DEVICE_ID_MAX, PICK_NAME_MAX, PICK_TEXT_MAX, PICK_TITLE_MAX, PICK_URL_MAX, type BrowserPickedElement, type BrowserReadKind } from "@realm/contracts";
import { DEFAULT_AGENT_ACCENT, PICK_BINDING, armElementPick, buildSnapshot, cancelFileChooser, describeElement, describePick, disarmElementPick, markAct, performAct, performFillCredential, performUpload, readPageText, resolvePickedNode, setFileChooserInterception, type CdpSend, type InterceptedChooser, type SnapshotIndex } from "./browser-agent";
import type { CredentialAuditEntry } from "./secret-store";
import { axElementAt, readAxSnapshot } from "./device-ax";

/**
 * The picker's payload: where in the picked element the click landed, normalized to that element's
 * box. Anything unparseable is null rather than a throw — the binding is reachable only from Realm's
 * own injected script, but a pane armed before an update sends the older `"1"`, and that pick should
 * still resolve to its DOM element rather than failing.
 *
 * Out-of-range values are dropped too: a point outside 0..1 did not come from inside the element,
 * and clamping it would resolve a device pick to whatever sits at the edge of the screen.
 */
export type PickPoint = { x: number; y: number; surface: { x: number; y: number; w: number; h: number } | null };

export function parsePickPoint(payload: string): PickPoint | null {
  try {
    const v = JSON.parse(payload) as { x?: unknown; y?: unknown; surface?: unknown };
    const x = v?.x, y = v?.y;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y, surface: parseSurface(v?.surface) };
  } catch {
    return null;
  }
}

/** The stream surface's box, or null when the click was not over one. A surface with no area is null
 *  too: it is what a device frame is divided by, and dividing by it would produce Infinity. */
function parseSurface(v: unknown): PickPoint["surface"] {
  const s = v as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  if (!s || typeof s !== "object") return null;
  const nums = [s.x, s.y, s.w, s.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const box = { x: s.x as number, y: s.y as number, w: s.w as number, h: s.h as number };
  return box.w > 0 && box.h > 0 ? box : null;
}

/** Device strings are the device's own and travel into a prompt like every other picked field. */
const clipField = (v: string, max = PICK_NAME_MAX): string => (v.length > max ? v.slice(0, max) : v);

/** The thin CDP surface browser-pane.ts implements over `webContents.debugger`. `onEvent`'s
 *  unsubscribe is never needed here — a binding dies with its view, taking the listener with it. */
export type CdpBinding = {
  send: CdpSend;
  onEvent(cb: (method: string, params: unknown) => void): void;
};

export type BrowserAgentHostDeps = {
  /** Attach (or fail with null) to the live view for this browser id. Called once per attachment;
   *  the host caches the binding until an op fails against a dead view. */
  attach(browserId: string): CdpBinding | null;
  /** Is the pane's view currently alive? Gates the cache — a destroyed view's binding is dropped.
   *  True for a RETAINED view too: a browser whose space is off screen is still drivable. */
  hasView(browserId: string): boolean;
  /** This view is in use right now. `BrowserPaneHost.touch` — it keeps the off-screen budget from
   *  evicting a browser an agent is working in while the user reads something in another space. */
  touch(browserId: string): void;
  /** BrowserPaneHost.navigate — the SAME normalization + allowlist every other navigation obeys. */
  navigate(browserId: string, url: string): string | null;
  /** Trustworthy page identity (webContents.getURL/getTitle — never page-authored text). */
  pageState(browserId: string): { url: string; title: string } | null;
  /**
   * The encrypted secret store (`secret-store.ts`), for the `fillCredential` op alone.
   *
   * OPTIONAL, and its absence is a real state rather than a test convenience: when macOS will not
   * hand Realm an encryption key, `index.ts` builds no store, and every credential op then behaves
   * exactly as it does for a user who has enrolled nothing — an empty list and `no_credential`. What
   * it never does is fall back to some unencrypted path.
   *
   * Note the shape: `withCredentialValue` takes a callback and returns no value. This dependency
   * cannot hand the host a password even if the host asked.
   */
  secrets?: {
    listCredentials(): BrowserCredential[];
    getCredential(id: string): BrowserCredential | null;
    withCredentialValue(
      id: string,
      use: (value: string) => Promise<void>,
    ): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }>;
    audit(entry: CredentialAuditEntry): void;
  };
  /**
   * The download governor (`downloads.ts`), for the `download` op alone. Optional for the same reason
   * `secrets` is: absent means every download stays blocked, which is the resting state anyway.
   */
  downloads?: {
    run(
      browserId: string,
      grant: { origin: string; dir: string; expiresAt: number },
      click: () => Promise<{ ok: boolean; error?: string }>,
    ): Promise<BrowserDownloadResult>;
  };
  /**
   * Read a file off disk, for the `upload` op alone — and only for its DROP route, where the bytes
   * have to be materialized inside the page. The other two routes hand Chromium a path and the
   * browser process opens it, which is why this is not on the hot path.
   *
   * Optional for the same reason `secrets` and `downloads` are: a harness without it simply cannot
   * take the drop route, and says so, rather than falling back to something less careful. Every
   * path reaching this has already been resolved, symlink-checked, confined and approved
   * server-side — this dependency is a reader, not a gate, and must never become one, because a
   * second place that decides which files are legal is a second place that can disagree.
   */
  readFile?(path: string): Promise<Uint8Array>;
};

/** Executor refusals → audit outcomes. `password` is absent because a fill cannot produce it (that
 *  refusal belongs to `act`), and an unmapped code degrades to `error` rather than inventing a row. */
const FILL_OUTCOMES: Partial<Record<string, CredentialAuditEntry["outcome"]>> = {
  origin_mismatch: "origin_mismatch", no_credential: "no_credential", no_presence: "no_presence",
};

const CONSOLE_MAX = 200;
const NETWORK_MAX = 150;

/** How long an act waits, after a successful click, to see whether it opened a file chooser. Short
 *  enough to be invisible to a person and to a twenty-step batch; long enough for the renderer to
 *  dispatch the click handler and for the CDP event to cross the debugger. */
const CHOOSER_SETTLE_MS = 150;

type Attached = {
  binding: CdpBinding;
  consoleLines: string[];
  network: Map<string, { method: string; url: string; status?: number; mimeType?: string; failed?: string }>;
  networkOrder: string[];
  lastSnapshot: SnapshotIndex | null;
  /** Resolver for the pick currently armed on this view, if any — see `pickElement`. */
  pick: ((ref: number | null) => void) | null;
  /** Where in the picked element the click landed, normalized to that element's own box. Null when
   *  the page reported no point (a pane armed by an older injected script, or a zero-sized element).
   *  Only a streamed device surface needs it — see `device-ax.ts`. */
  pickPoint: PickPoint | null;
  /** Bumped by every `pickElement`, so a superseded call can tell it no longer owns inspect mode. */
  pickGen: number;
  /** File-chooser interception state for this view — see `FileChooserState`. */
  chooser: FileChooserState;
};

/**
 * What this pane knows about file choosers.
 *
 * The invariant the whole upload feature rests on: **a file chooser opened by an agent's click is
 * INTERCEPTED, never shown.** macOS's open panel is modal and unreachable from CDP, so a pane that
 * shows one is a pane the agent has taken away from its user until they come back and dismiss it by
 * hand. Interception is armed before any click that could open one and disarmed afterwards, so the
 * USER's own clicks still get a real panel — interception is a property of the page, and a pane left
 * permanently armed is one where the human's own "Choose files" button silently does nothing.
 *
 *   - `armed` — interception is on right now.
 *   - `disarmAt` / `timer` — the deadline the post-click window expires at. Extended rather than
 *     stacked, so twenty clicks in a batch hold one timer, not twenty.
 *   - `pending` — a chooser that WAS intercepted and has not been answered. The page is waiting on
 *     that node; `browser_upload` fills it and `browser_dismiss_dialog` cancels it. Interception
 *     stays armed while one is pending, because disarming would not un-intercept it and the next
 *     click would open a native panel on top of a page already waiting for files.
 *   - `waiter` — a `browser_upload` blocked on the next `Page.fileChooserOpened`.
 */
type FileChooserState = {
  armed: boolean;
  disarmAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: InterceptedChooser | null;
  waiter: ((c: InterceptedChooser | null) => void) | null;
};

const newChooserState = (): FileChooserState => ({ armed: false, disarmAt: 0, timer: null, pending: null, waiter: null });

export class BrowserAgentHost {
  private readonly attached = new Map<string, Attached>();

  /**
   * The theme accent every mark this host draws inside a page is painted in — the action ring, the
   * agent cursor, the controlled-screen frame and the picker's overlay.
   *
   * Held here, once, rather than per browser id: the accent is a property of the WINDOW (it is
   * whatever `--rl-accent` computes to on that document's `:root`) and this host is already one per
   * window, so a per-view cache would be N copies of one value with N chances to drift. Pushed from
   * the renderer on every theme apply (`ThemeBridge`), because a page carries none of Realm's CSS
   * and cannot be asked. The default stands in until the first push, and for a window that never
   * sends one.
   */
  private accent = DEFAULT_AGENT_ACCENT;

  constructor(private readonly d: BrowserAgentHostDeps) {}

  /** The renderer's theme changed. Fire-and-forget from the renderer's side: nothing waits on the
   *  colour, and an act that lands a frame ahead of it is drawn in the previous accent, not wrongly. */
  setAccent(accent: string): void {
    if (accent) this.accent = accent;
  }

  /** A download was blocked on this browser's view (main cancels ALL downloads on the browser
   *  partition — the W3 hard block). Lands in the console buffer so `browser_read console` shows it. */
  noteBlockedDownload(browserId: string, url: string): void {
    const entry = this.attached.get(browserId);
    if (entry) pushRing(entry.consoleLines, `[realm] download blocked (downloads are disabled for agent-driven browsing): ${url}`, CONSOLE_MAX);
  }

  /** The pane's view is gone — drop its attachment and buffers. Snapshot indexes die with the view:
   *  a fresh view is a fresh page, and stale [new] markers would lie about it. */
  release(browserId: string): void {
    // A pick armed on a view that just died resolves EMPTY rather than hanging: the renderer awaits
    // this promise to un-arm its button, and a pane closed mid-pick would otherwise leave the button
    // lit for a view that no longer exists.
    const entry = this.attached.get(browserId);
    entry?.pick?.(null);
    // A chooser waiter on a dead view resolves empty rather than hanging out its timeout, and the
    // disarm timer is cleared — it would otherwise fire against a binding whose view is gone.
    if (entry) {
      this.clearChooserTimer(entry);
      const waiter = entry.chooser.waiter;
      entry.chooser.waiter = null;
      entry.chooser.pending = null;
      waiter?.(null);
    }
    this.attached.delete(browserId);
  }

  /**
   * Arm the element picker on this view and resolve with what the USER clicked — or null if they
   * cancelled, the page navigated out from under them, or the pane closed first.
   *
   * Deliberately NOT a `handleOp` case, and so deliberately not on `BROWSER_HOST_OPS`: every op on
   * that bridge is something an agent asked realm-server for, and this is the opposite direction —
   * a human pointing at something on their own screen. Routing it through the agent bridge would
   * have put "take over the user's cursor and consume their next click" one allowlist entry away
   * from a tool call. It reaches main over the pane's plain IPC instead, the same channel (and for
   * the same reason) as `saveDownload`: a call arriving there is consent the page cannot forge.
   *
   * One pick at a time per view — re-arming settles the previous one empty, so a double-press of the
   * toolbar button leaves exactly one live promise rather than two racing for the same click.
   */
  async pickElement(browserId: string, accent?: string): Promise<BrowserPickedElement | null> {
    if (!this.d.hasView(browserId)) return null;
    const entry = this.ensure(browserId);
    const gen = ++entry.pickGen;
    entry.pick?.(null);
    const ref = await new Promise<number | null>((resolve) => {
      entry.pick = resolve;
      void armElementPick(entry.binding.send, accent ?? this.accent).catch(() => this.settlePick(entry, null));
    });
    // A later `pickElement` has taken the view over — it owns inspect mode now, and disarming from
    // here would switch off the picker the user has just re-armed.
    if (entry.pickGen !== gen) return null;
    await disarmElementPick(entry.binding.send);
    if (ref === null) return null;
    const state = this.d.pageState(browserId);
    const picked = await describePick(entry.binding.send, ref).catch(() => null);
    if (!picked) return null;
    // url/title come from the webContents rather than from the page's own words. That makes the URL's
    // ORIGIN trustworthy and nothing else about either: `pushState` writes the path, `document.title`
    // writes the title. What they are not is unbounded, which is what the clip below is for.
    // Clipped here rather than at the schema, which rejects: this is the last point that knows the
    // difference between "a page made its title enormous" and "this did not come from the picker".
    const url = (state?.url ?? "").slice(0, PICK_URL_MAX);
    const base: BrowserPickedElement = { ...picked, url, title: (state?.title ?? "").slice(0, PICK_TITLE_MAX) };
    return (await this.asDeviceElement(base, url, entry.pickPoint)) ?? base;
  }

  /**
   * Upgrade a pick on a streamed device surface into the device element actually under the pointer.
   *
   * Gated on the picked node being a `canvas` or `img`, which is what a stream is drawn into — so an
   * ordinary page costs nothing and never probes anything. Only then is `/ax` asked, and only when it
   * answers with a tree containing that point does the pick change shape; every other path returns
   * null and the caller keeps the DOM element the user genuinely clicked.
   *
   * `role`, `name` and `rect` are overwritten because those three are what a chip is read from, and
   * "the canvas" is not what the user pointed at. `selector` and `html` are cleared rather than left
   * describing the surface: they would be true of the wrong thing.
   */
  private async asDeviceElement(el: BrowserPickedElement, url: string, point: PickPoint | null): Promise<BrowserPickedElement | null> {
    // Gated on the click having landed over a stream SURFACE, which is a fact only the page can
    // report: the picked element itself is routinely a transparent div the page lays over its canvas
    // (serve-sim does exactly that), so its tag says nothing about what was under the pointer. No
    // surface, no probe — an ordinary page never asks anything of the network.
    if (!point?.surface) return null;
    const origin = normalizeOrigin(url);
    if (!origin) return null;
    const snap = await readAxSnapshot(origin);
    if (!snap) return null;
    const hit = axElementAt(snap, point.x, point.y);
    if (!hit) return null;
    // The device's frame, put back into the pane's coordinates: `rect` means "where this is on
    // screen" everywhere else, and a chip whose rect was in device points would be the one field
    // measured in a different unit from all its neighbours.
    const scaleX = point.surface.w / snap.screen.width, scaleY = point.surface.h / snap.screen.height;
    return {
      ...el,
      role: clipField(hit.role || hit.type),
      name: clipField(hit.label),
      text: clipField(hit.value, PICK_TEXT_MAX),
      selector: "",
      html: "",
      rect: {
        x: point.surface.x + hit.frame.x * scaleX,
        y: point.surface.y + hit.frame.y * scaleY,
        w: hit.frame.width * scaleX,
        h: hit.frame.height * scaleY,
      },
      device: {
        id: clipField(hit.id, PICK_DEVICE_ID_MAX),
        path: clipField(hit.path, PICK_DEVICE_ID_MAX),
        enabled: hit.enabled !== false,
        frame: hit.frame,
        screen: snap.screen,
      },
    };
  }

  /** Take the picker down without a pick. The armed promise resolves null and the caller un-arms. */
  cancelPick(browserId: string): void {
    const entry = this.attached.get(browserId);
    if (!entry) return;
    const resolve = entry.pick;
    entry.pick = null;
    resolve?.(null);
    void disarmElementPick(entry.binding.send);
  }

  /** One bridge op. Throws with an agent-readable message on failure; the bridge relays it. */
  async handleOp(op: string, params: Record<string, unknown>): Promise<unknown> {
    const browserId = String(params.browserId ?? "");
    switch (op) {
      case "describe": {
        const state = this.d.pageState(browserId);
        if (!state || !this.d.hasView(browserId)) return { open: false, url: "", title: "", element: null } satisfies BrowserDescribeResult;
        let element: BrowserDescribeResult["element"] = null;
        if (typeof params.ref === "number") element = await this.describeElement(browserId, params.ref).catch(() => null);
        return { open: true, url: state.url, title: state.title, element } satisfies BrowserDescribeResult;
      }
      case "navigate": {
        // Straight to the pane host: normalization and the per-space origin allowlist live there,
        // shared with the address bar and page-initiated navigations. Null = refused/no view.
        return { url: this.d.navigate(browserId, String(params.url ?? "")) };
      }
      case "snapshot": {
        const entry = this.ensure(browserId);
        const result = await buildSnapshot(entry.binding.send, entry.lastSnapshot);
        entry.lastSnapshot = result.index;
        const { index: _index, ...wire } = result;
        // A pending chooser is page state the tree cannot show — the input it belongs to is usually
        // the hidden one behind a styled button, so it has no box and is in no layout. The note is
        // how "a click of yours is still waiting for files" survives to the next snapshot, which is
        // where an agent that acted and moved on will actually look.
        if (entry.chooser.pending) {
          wire.text = `${wire.text}\n(a file chooser is open on this page and waiting — Realm intercepted it, so no macOS panel is on screen. browser_upload attaches files to it; browser_dismiss_dialog cancels it.)`;
        }
        return wire;
      }
      case "read": {
        const kind = String(params.kind ?? "text") as BrowserReadKind;
        const entry = this.ensure(browserId);
        if (kind === "console") return { text: entry.consoleLines.join("\n") };
        if (kind === "network") return { text: this.formatNetwork(entry) };
        return { text: await readPageText(entry.binding.send) };
      }
      case "act": {
        const entry = this.ensure(browserId);
        // The action was schema-validated server-side; this cast is the two processes' contract.
        const action = params.action as BrowserAction;
        // Mark the act inside the page before performing it — the ring, the cursor and the
        // controlled-screen frame, in one evaluate. Only acts already PERMITTED reach this op (the
        // gate is server-side), so a mark never points at something that was refused; and `markAct`
        // swallows every failure — a page where it cannot draw acts anyway.
        await markAct(entry.binding.send, action, this.accent);
        /*
         * Arm file-chooser interception BEFORE a click or a key, and hold it for a short window
         * afterwards.
         *
         * Not an upload feature — a safety one, and the reason there is no `browser_act` that can
         * wedge a pane any more. Any click can be the one that opens a picker: a "Choose files"
         * button, a menu item, an `<input type=file>` reached with Enter. If that picker becomes a
         * native NSOpenPanel it is modal, CDP cannot see or close it, and the pane belongs to nobody
         * until a human dismisses it by hand. Armed, the same click yields `Page.fileChooserOpened`
         * — nothing appears on screen, the agent is told, and `browser_upload` or
         * `browser_dismiss_dialog` can answer it.
         *
         * The window is short (`UPLOAD_ARM_WINDOW_MS`) because interception belongs to the PAGE and
         * not to the caller: while it is on, the user's own click on a file input gets no panel
         * either. That race is real and it is the trade — a couple of seconds after an agent act, in
         * a pane the agent is visibly driving, against a class of unrecoverable wedge. `arm` is
         * awaited and the act is not: the ordering is what the property depends on.
         */
        if (action.kind === "click" || action.kind === "key") await this.armChooser(entry);
        const result = await performAct(entry.binding.send, action);
        return this.withChooserNote(entry, result);
      }
      /**
       * Attach files to a page (Plan 26). The gate, the path resolution, the symlink check, the
       * secret-path refusal and the user's approval all happened SERVER-side; what arrives here is a
       * list of absolute paths already vetted, and this op's whole job is to get them onto the right
       * node without the OS panel. `performUpload` picks the route; the seams below are the pieces
       * only this class can supply — the chooser's event plumbing and the disk.
       */
      case "upload": {
        const entry = this.ensure(browserId);
        const ref = Number(params.ref);
        const files = (params.files ?? []) as BrowserUploadFile[];
        if (!Array.isArray(files) || files.length === 0) {
          return { ok: false, error: "no files were given to attach" } satisfies BrowserUploadResult;
        }
        const read = this.d.readFile;
        try {
          return await performUpload(entry.binding.send, ref, files, {
            pending: () => this.takePendingChooser(entry),
            arm: () => this.armChooser(entry, { hold: true }),
            disarm: () => this.disarmChooser(entry),
            awaitChooser: (timeoutMs) => this.awaitChooser(entry, timeoutMs),
            retain: (chooser) => { entry.chooser.pending = chooser; },
            readFile: read
              ? (path) => read(path)
              : () => Promise.reject(new Error("this build cannot read files for a synthesized drop")),
          });
        } finally {
          // `arm` above holds interception open for as long as the upload needs, with no timer behind
          // it, so the disarm has to happen HERE — a pane left armed is one where the USER's own
          // "Choose files" button silently does nothing. `disarmChooser` declines when a chooser is
          // still pending (a refused `accept=`, handed back by `retain`), which is the one case where
          // staying armed is right.
          await this.disarmChooser(entry);
        }
      }
      /**
       * Cancel an intercepted file chooser — the recovery valve for a click that turned out to open
       * a picker the agent did not want.
       *
       * Says plainly what it is and is not: it answers a chooser Realm INTERCEPTED, by telling the
       * page nothing was picked. There is no native panel to close, because interception is what
       * kept one from ever appearing; a panel that somehow reached the screen (a click in a window
       * with no interception armed, from before this pane was attached) is outside CDP's reach and
       * outside this op's, and the honest answer there is that the user has to dismiss it.
       */
      case "dismissDialog": {
        const entry = this.ensure(browserId);
        const pending = this.takePendingChooser(entry);
        await this.disarmChooser(entry);
        if (!pending) return { dismissed: false, detail: "no file chooser was open on this pane" } satisfies BrowserDismissDialogResult;
        await cancelFileChooser(entry.binding.send, pending.backendNodeId);
        return { dismissed: true, detail: "the file chooser was cancelled — the page was told nothing was picked" } satisfies BrowserDismissDialogResult;
      }
      /**
       * Enrolled sign-ins, METADATA ONLY — the `BrowserCredential` type has no value field, so this
       * op has nothing to redact. It exists because `fill_credential` takes a `credentialId` and the
       * agent needs some way to learn one; origin/username/label are the same three facts the
       * permission card shows the user, and the user typed all three themselves in Settings.
       */
      case "credentials": {
        return { credentials: this.d.secrets?.listCredentials() ?? [] };
      }
      /**
       * Fill one enrolled credential into `ref`. Every outcome writes an audit line — including the
       * refusals, which are the ones worth having a record of.
       *
       * The lookup happens HERE rather than in the executor so that an unknown id never reaches CDP
       * at all, and so the executor receives only `{ id, origin }`: the piece of the row it needs to
       * decide the origin gate, and nothing else.
       */
      case "fillCredential": {
        const credentialId = String(params.credentialId ?? "");
        const ref = Number(params.ref);
        const store = this.d.secrets;
        const credential = store?.getCredential(credentialId) ?? null;
        if (!store || !credential) {
          this.auditFill(credentialId, "", "no_credential");
          return { ok: false, refused: "no_credential", error: "no saved sign-in is enrolled under that id — the user adds them in Realm's Settings, under Sign-ins" } satisfies BrowserActResult;
        }
        const entry = this.ensure(browserId);
        // No `markAct` here, unlike `act`. Every mark is drawn by evaluating script in the page, and
        // this is the one op where the page is about to receive a real secret — the moment to do the
        // least in it, not the most. No ring, no cursor, no frame. The permission card already told
        // the user which pane.
        let result: BrowserActResult;
        try {
          result = await performFillCredential(entry.binding.send, ref, {
            credential: { id: credential.id, origin: credential.origin },
            reveal: (type) => store.withCredentialValue(credential.id, type),
          });
        } catch {
          // Bare, like the executor's own: a thrown CDP error can carry the characters it was
          // dispatching, and nothing about it may reach a tool result.
          this.auditFill(credential.id, credential.origin, "error");
          return { ok: false, error: "the saved sign-in could not be typed into that field" } satisfies BrowserActResult;
        }
        this.auditFill(credential.id, credential.origin, result.ok ? "filled" : FILL_OUTCOMES[result.refused ?? "password"] ?? "error");
        return result;
      }
      /**
       * Download the file behind `ref`, into the directory the SERVER resolved from the space's
       * project. The op is gated server-side like any other mutating act; what happens here is the
       * arm → click → await, with the grant's lifetime bounded by this op.
       *
       * `dir` arrives from realm-server rather than being computed here because only the server knows
       * the space's project. It is required to be absolute: this op writes to disk, and a relative
       * path would resolve against whatever cwd Electron happens to have.
       */
      case "download": {
        const governor = this.d.downloads;
        const dir = String(params.dir ?? "");
        if (!governor || !dir.startsWith("/")) {
          return { ok: false, error: "downloads are not available in this build" } satisfies BrowserDownloadResult;
        }
        const state = this.d.pageState(browserId);
        // The pane's live origin, from the same trustworthy source `describe` reports — never page
        // text. This is what the grant pins, so a redirect mid-download is caught as drift.
        const origin = state ? normalizeOrigin(state.url) : null;
        if (!origin) {
          return { ok: false, refused: "origin_mismatch", error: "the pane has no ordinary web page open, so there is nothing to download from" } satisfies BrowserDownloadResult;
        }
        const entry = this.ensure(browserId);
        const ref = Number(params.ref);
        return governor.run(
          browserId,
          { origin, dir, expiresAt: Date.now() + DOWNLOAD_GRANT_TTL_MS },
          // The click goes through the ordinary act path — same ref resolution, same act-time quads,
          // same highlight. A download is a click that happens to produce a file.
          async () => {
            const click: BrowserAction = { kind: "click", ref, button: "left", clickCount: 1, modifiers: [] };
            await markAct(entry.binding.send, click, this.accent);
            const result = await performAct(entry.binding.send, click);
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
        );
      }
      case "screenshot": {
        const entry = this.ensure(browserId);
        const shot = (await entry.binding.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })) as { data?: string };
        if (!shot.data) throw new Error("screenshot produced no data");
        return { data: shot.data, mimeType: "image/jpeg" };
      }
      default:
        throw new Error(`unknown browser host op "${op}"`);
    }
  }

  /* ------------------------------ file choosers ------------------------------ */

  /**
   * Turn interception on, and (unless the caller is holding it itself) schedule the disarm.
   *
   * Idempotent and cheap to call repeatedly: a second arm inside the window only pushes the deadline
   * out, so a batch of twenty clicks holds one timer rather than twenty. A CDP failure is swallowed —
   * this is a hardening on top of the act, and an act must not fail because a page's debugger
   * declined one extra command.
   */
  private async armChooser(entry: Attached, opts: { hold?: boolean } = {}): Promise<void> {
    try {
      if (!entry.chooser.armed) await setFileChooserInterception(entry.binding.send, true);
      entry.chooser.armed = true;
    } catch {
      entry.chooser.armed = false;
      return;
    }
    if (opts.hold) { this.clearChooserTimer(entry); return; }
    entry.chooser.disarmAt = Date.now() + UPLOAD_ARM_WINDOW_MS;
    if (entry.chooser.timer) return; // one timer; it re-checks the deadline when it fires
    const tick = () => {
      const remaining = entry.chooser.disarmAt - Date.now();
      if (remaining > 0) { entry.chooser.timer = setTimeout(tick, remaining); entry.chooser.timer.unref?.(); return; }
      entry.chooser.timer = null;
      void this.disarmChooser(entry);
    };
    entry.chooser.timer = setTimeout(tick, UPLOAD_ARM_WINDOW_MS);
    entry.chooser.timer.unref?.();
  }

  /** Turn interception off — unless a chooser is still pending. Disarming would not un-intercept
   *  that one, and the page is already waiting on it; the next click would then put a native panel
   *  on top of a page mid-upload, which is the exact state this whole mechanism exists to prevent.
   *  It is disarmed when the pending chooser is answered (`takePendingChooser`) instead. */
  private async disarmChooser(entry: Attached): Promise<void> {
    this.clearChooserTimer(entry);
    if (entry.chooser.pending) return;
    if (!entry.chooser.armed) return;
    entry.chooser.armed = false;
    await setFileChooserInterception(entry.binding.send, false).catch(() => {});
  }

  private clearChooserTimer(entry: Attached): void {
    if (entry.chooser.timer) clearTimeout(entry.chooser.timer);
    entry.chooser.timer = null;
  }

  /** The pending chooser, removed as it is taken — a chooser is answered once, and two callers must
   *  not both think they own it. */
  private takePendingChooser(entry: Attached): InterceptedChooser | null {
    const pending = entry.chooser.pending;
    entry.chooser.pending = null;
    return pending;
  }

  /** The next intercepted chooser, or null after `timeoutMs`. One already pending satisfies it
   *  immediately — the event can land between the click returning and this being called. */
  private awaitChooser(entry: Attached, timeoutMs: number): Promise<InterceptedChooser | null> {
    const already = this.takePendingChooser(entry);
    if (already) return Promise.resolve(already);
    return new Promise<InterceptedChooser | null>((resolve) => {
      const timer = setTimeout(() => {
        if (entry.chooser.waiter !== settle) return;
        entry.chooser.waiter = null;
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const settle = (c: InterceptedChooser | null) => { clearTimeout(timer); entry.chooser.waiter = null; resolve(c); };
      entry.chooser.waiter = settle;
    });
  }

  /**
   * Tell the agent, in the act's own result, that its click opened a file chooser.
   *
   * The wait is what makes this truthful rather than lucky: a chooser opens on the page's side of
   * the click, so at the instant `performAct` returns nothing is pending yet. `CHOOSER_SETTLE_MS` is
   * the cost — paid only on a successful click, only while interception is armed, and small enough
   * to sit under perception even across a full `browser_batch`. Without it the note would appear
   * only on the next snapshot, and an agent that acted twice in a row would have stranded a chooser
   * without ever being told.
   */
  private async withChooserNote(entry: Attached, result: BrowserActResult): Promise<BrowserActResult> {
    if (!result.ok || !entry.chooser.armed) return result;
    if (!entry.chooser.pending) await this.awaitChooser(entry, CHOOSER_SETTLE_MS).then((c) => { if (c) entry.chooser.pending = c; });
    if (!entry.chooser.pending) return result;
    return {
      ok: true,
      detail:
        `${result.detail} — that opened a file chooser, which Realm intercepted, so no macOS panel appeared. ` +
        "Call browser_upload with this same ref and the paths to attach, or browser_dismiss_dialog to cancel it.",
    };
  }

  /** One audit line per fill attempt: timestamp, origin, credentialId, outcome — and never the
   *  value, the page's text, or the length of anything. */
  private auditFill(credentialId: string, origin: string, outcome: CredentialAuditEntry["outcome"]): void {
    this.d.secrets?.audit({ ts: Date.now(), origin, credentialId, outcome });
  }

  /** Get-or-create the attachment. A cached binding whose view died is dropped and re-attached —
   *  and if no view exists, the op fails with the one message that tells the agent what to do. */
  private ensure(browserId: string): Attached {
    if (!this.d.hasView(browserId)) {
      this.attached.delete(browserId); // a cached binding whose view died
      throw new Error(`browser ${browserId}'s pane is not open in the app — the user must open (or reopen) the browser pane before tools can drive it`);
    }
    // Ahead of the cache hit, so EVERY op refreshes the view's recency and not just the one that
    // attached — a long agent task in a background browser is exactly what must not be evicted.
    this.d.touch(browserId);
    const cached = this.attached.get(browserId);
    if (cached) return cached;
    const binding = this.d.attach(browserId);
    if (!binding) throw new Error(`could not attach the debugger to browser ${browserId}`);
    const entry: Attached = { binding, consoleLines: [], network: new Map(), networkOrder: [], lastSnapshot: null, pick: null, pickPoint: null, pickGen: 0, chooser: newChooserState() };
    binding.onEvent((method, rawParams) => this.onCdpEvent(entry, method, rawParams));
    this.attached.set(browserId, entry);
    // Enable the event domains the buffers feed on. Fire-and-forget: an enable that fails costs a
    // buffer, not the attachment.
    for (const cmd of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable", "DOM.enable"]) {
      void binding.send(cmd).catch(() => {});
    }
    return entry;
  }

  private onCdpEvent(entry: Attached, method: string, rawParams: unknown): void {
    const p = rawParams as Record<string, unknown>;
    if (method === "Runtime.consoleAPICalled") {
      const type = String(p.type ?? "log");
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ");
      pushRing(entry.consoleLines, `[${type}] ${text}`, CONSOLE_MAX);
    } else if (method === "Log.entryAdded") {
      const e = p.entry as { level?: string; text?: string; url?: string } | undefined;
      if (e) pushRing(entry.consoleLines, `[${e.level ?? "log"}] ${e.text ?? ""}${e.url ? ` (${e.url})` : ""}`, CONSOLE_MAX);
    } else if (method === "Network.requestWillBeSent") {
      const id = String(p.requestId ?? "");
      const req = p.request as { method?: string; url?: string } | undefined;
      if (!id || !req?.url || req.url.startsWith("data:")) return;
      if (!entry.network.has(id)) {
        entry.network.set(id, { method: req.method ?? "GET", url: req.url });
        entry.networkOrder.push(id);
        while (entry.networkOrder.length > NETWORK_MAX) entry.network.delete(entry.networkOrder.shift()!);
      }
    } else if (method === "Network.responseReceived") {
      const row = entry.network.get(String(p.requestId ?? ""));
      const res = p.response as { status?: number; mimeType?: string } | undefined;
      if (row && res) { row.status = res.status; row.mimeType = res.mimeType; }
    } else if (method === "Network.loadingFailed") {
      const row = entry.network.get(String(p.requestId ?? ""));
      if (row) row.failed = String(p.errorText ?? "failed");
    } else if (method === "Runtime.bindingCalled" && p.name === PICK_BINDING) {
      /* The user clicked, or pressed Escape. Realm's own overlay does the picking now rather than
         Chrome's inspector, so what arrives is a stamped attribute rather than a backendNodeId —
         `resolvePickedNode` turns one into the other and clears the stamp. An empty payload is the
         Escape, and settles the pick with nothing. */
      // Guarded on a pick actually being armed. `settlePick` on a settled promise is silent, but
      // `resolvePickedNode` is not: it costs three CDP round trips and clears an attribute off a page
      // nobody is picking in. A cancelled pick whose click lands a frame later would do exactly that.
      if (entry.pick === null) { /* nobody is waiting */ }
      else if (String(p.payload ?? "") === "") this.settlePick(entry, null);
      else {
        // The payload carries WHERE in the element the click landed. Parsed leniently: a page that
        // is not the picker cannot call this binding, but a payload from an older injected script
        // (a pane armed before an update) is a string that is not JSON, and it should still pick.
        entry.pickPoint = parsePickPoint(String(p.payload ?? ""));
        void resolvePickedNode(entry.binding.send).then((ref) => this.settlePick(entry, ref));
      }
    } else if (method === "Page.fileChooserOpened") {
      /* The page tried to open a file picker and interception caught it — NOTHING is on screen. The
         node travels with the event only because interception is on; without it Chromium would have
         shown macOS's panel and said nothing useful here, which is the whole reason acts arm first.
         `mode` is the page's own statement of how many files that input takes. */
      const backendNodeId = Number(p.backendNodeId ?? 0);
      if (backendNodeId > 0) {
        const chooser: InterceptedChooser = { backendNodeId, multiple: p.mode === "selectMultiple" };
        const waiter = entry.chooser.waiter;
        if (waiter) waiter(chooser);
        else entry.chooser.pending = chooser;
        pushRing(entry.consoleLines, "[realm] a file chooser was intercepted (no macOS panel was shown) — browser_upload attaches files to it, browser_dismiss_dialog cancels it", CONSOLE_MAX);
      }
    } else if (method === "Page.frameNavigated" && (p.frame as { parentId?: string } | undefined)?.parentId === undefined) {
      // A main-frame navigation resets the overlay agent, so an armed picker silently stops picking.
      // Settling it empty is what keeps the toolbar button from staying lit over a page it can no
      // longer pick from; the user presses it again on the new page.
      this.settlePick(entry, null);
      // The same navigation took any pending file chooser's node with it. Forgotten rather than
      // cancelled: there is nothing left to tell, and holding a dead backendNodeId is what would
      // keep interception armed forever on a page that never asked for it.
      entry.chooser.pending = null;
      void this.disarmChooser(entry);
    }
  }

  private describeElement(browserId: string, ref: number): Promise<BrowserDescribeResult["element"]> {
    return describeElement(this.ensure(browserId).binding.send, ref);
  }

  private settlePick(entry: Attached, ref: number | null): void {
    const resolve = entry.pick;
    entry.pick = null;
    resolve?.(ref);
  }

  private formatNetwork(entry: Attached): string {
    return entry.networkOrder
      .map((id) => entry.network.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => (r.failed ? `FAIL ${r.method} ${r.url} — ${r.failed}` : `${r.status ?? "…"} ${r.method} ${r.url}${r.mimeType ? ` (${r.mimeType})` : ""}`))
      .join("\n");
  }
}

function pushRing(list: string[], line: string, max: number): void {
  list.push(line);
  while (list.length > max) list.shift();
}
