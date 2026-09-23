import { useEffect, useRef, useState } from "react";
import { Icon } from "@realm/ui";
import {
  applyTheme, checkSprite, checkTheme, checkWorld, expandRoom, FALLBACK_THEME, furnitureVocabulary, registerDrawnFurniture,
  roomToText, SPRITE_MAX_TILES, SPRITE_TILE, THEMES, type OfficeTheme,
} from "@realm/pixel-office";
import { Spinner } from "../../components/Spinner";
import { useApp, type OfficeWorld } from "../../state/store";

/** The room a model may draw. Near the engine's own 60×60 ceiling: the office fits itself to the
 *  pane, so a bigger room is a bigger office rather than a scrollbar, and a request for "a map room"
 *  needs the floor to put one on. Stopping short of 60 because a 60×60 plan is 3,600 characters the
 *  model has to keep rectangular, and the failure rate climbs with the row length. */
const MAX = { cols: 44, rows: 30 };
/** How many props one request may have drawn for it. Each is its own model call, so this is a
 *  wall-clock budget as much as a taste one — six props is already the slowest thing here. */
const MAX_DRAWN = 6;

/**
 * Change the world by describing it.
 *
 * Two controls, and the difference between them is how much they cost. The theme row repaints what
 * is already there and is instant and local — no model, no waiting. The prompter rebuilds the room,
 * which is a model call, so it is the one with the text field.
 *
 * Nothing is applied until it has been through `checkWorld`/`checkTheme`. A world comes out of a
 * language model, and the engine indexes tiles and looks furniture up without checking either, so
 * the validator is the only thing between a hallucinated `ESPRESSO_MACHINE` and a blank pane. When
 * a world is refused the reasons are shown rather than swallowed: they are short, specific, and the
 * honest answer to "why did nothing happen".
 */
export function OfficePrompter({ current, seats }: { current: OfficeWorld | null; seats: number }) {
  const generate = useApp((s) => s.generatePixelWorld);
  const drawSprite = useApp((s) => s.drawPixelSprite);
  const setWorld = useApp((s) => s.setOfficeWorld);
  const run = useApp((s) => s.run);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  /* What it is doing right now. A world with props takes three calls and the better part of a
     minute; a spinner alone for that long reads as a hang. */
  const [stage, setStage] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const ask = () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setProblems([]);
    run(async () => {
      try {
        /* One attempt, then one retry with the refusal handed back. A model told exactly which row
           was short fixes it; a model told nothing repeats itself, which is what a user sees as a
           dead end. Two attempts rather than more because a second failure is usually the ask
           needing changing, not the model needing another go. */
        let problems: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          setStage(attempt === 0 ? "Designing the room…" : "Fixing it up…");
          const { json } = await generate({
            prompt: text,
            vocabulary: furnitureVocabulary(),
            current: current ? { name: current.name, room: roomToText(current.layout as never) } : null,
            maxCols: MAX.cols, maxRows: MAX.rows,
            seats: Math.max(4, seats), maxDrawn: MAX_DRAWN, problems,
          });
          /* The props it asked for are drawn and registered BEFORE the world is checked, because
             `checkWorld` validates furniture against the catalog — a prop placed before it exists
             is the one refusal that would be this feature's own fault. */
          const wanted = propsToDraw(json);
          if (wanted.length > 0) {
            setStage(`Drawing ${wanted.length} ${wanted.length === 1 ? "prop" : "props"}…`);
            await Promise.all(wanted.map(async (w) => {
              try {
                const { json: spriteJson } = await drawSprite({
                  prompt: w.prompt, maxWidth: SPRITE_TILE * SPRITE_MAX_TILES, maxHeight: SPRITE_TILE * SPRITE_MAX_TILES,
                });
                const check = checkSprite(JSON.parse(spriteJson));
                /* A prop that fails to draw is dropped rather than fatal: the room is still the
                   room, and `checkWorld` will name the id it could not place. */
                if (check.ok) registerDrawnFurniture({ id: w.id, label: w.label, sprite: check.sprite, footprintW: check.footprintW, footprintH: check.footprintH });
              } catch { /* one prop, not the request */ }
            }));
          }
          const built = buildWorld(json, text);
          if (built.ok) { setWorld(built.world); setPrompt(""); return; }
          problems = built.problems;
        }
        setProblems(problems);
      } finally { setBusy(false); setStage(null); }
    });
  };

  const repaint = (theme: OfficeTheme | null) => {
    if (!current) return;
    setWorld({ ...current, layout: applyTheme(current.layout as never, theme) });
  };

  return (
    <div className="office-prompter">
      <SpriteDrawer />
      <form className="office-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Icon name="sparkles" size={14} className="office-ask-mark" />
        <input
          className="office-ask-input" value={prompt} aria-label="Describe the office"
          placeholder="A neon server room at night, desks along the back wall"
          onChange={(e) => { setPrompt(e.target.value); setProblems([]); }}
          disabled={busy} />
        <button type="submit" className="btn" disabled={!prompt.trim() || busy}>
          {busy ? <><Spinner size={14} /> {stage ?? "Building…"}</> : "Build it"}
        </button>
        {current && (
          <button type="button" className="btn" onClick={() => setWorld(null)} title="Back to the office Realm ships with">
            Reset
          </button>
        )}
      </form>
      {/* Repainting is instant and free, so it is buttons rather than a sentence you have to write. */}
      <div className="office-themes" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.name} type="button" className="office-theme" disabled={!current}
            title={current ? `Repaint in ${t.name}` : "Build an office first, then repaint it"}
            onClick={() => repaint(t)}>{t.name}</button>
        ))}
      </div>
      {problems.length > 0 && (
        /* Shown, not swallowed. "Nothing happened" is the one outcome a person cannot act on. */
        <ul className="office-problems" aria-label="Why that office was refused">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * The props the model asked to have drawn for it.
 *
 * Read off the raw answer rather than out of `buildWorld`, because they have to be DRAWN and
 * REGISTERED before the world can be checked — `checkWorld` validates furniture against the catalog,
 * and a prop placed before it exists would be refused for a reason that is this feature's own doing.
 *
 * Silently tolerant of a malformed `draw`: a missing or wrong-shaped entry costs the room one prop,
 * and the room is the thing that was asked for.
 */
export function propsToDraw(json: string): { id: string; label: string; prompt: string }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const draw = (parsed as Record<string, unknown> | null)?.draw;
  if (!Array.isArray(draw)) return [];
  return draw.flatMap((d) => {
    const e = d as Record<string, unknown>;
    if (typeof e?.id !== "string" || typeof e?.prompt !== "string") return [];
    return [{ id: e.id, label: typeof e.label === "string" && e.label.trim() ? e.label : e.id, prompt: e.prompt }];
  }).slice(0, MAX_DRAWN);
}

/**
 * The model's answer, turned into a world — or the reasons it could not be.
 *
 * Exported for its own test: this is where a hallucination becomes either a room or a refusal, and
 * every interesting case (bad JSON, a ragged room, invented furniture, a theme out of range) is a
 * string away from a crash in the engine.
 */
export function buildWorld(json: string, prompt: string):
  | { ok: true; world: OfficeWorld }
  | { ok: false; problems: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return { ok: false, problems: ["The answer was not valid JSON."] }; }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, problems: ["The answer was not an object."] };
  const a = parsed as Record<string, unknown>;

  const room = expandRoom(Array.isArray(a.room) ? (a.room as string[]) : []);
  if (!room.ok) return { ok: false, problems: room.problems };

  const world = checkWorld({
    version: 1, cols: room.cols, rows: room.rows, tiles: room.tiles,
    furniture: Array.isArray(a.furniture) ? a.furniture : [],
  });
  if (!world.ok) return { ok: false, problems: world.problems };

  /* A theme is optional to SUPPLY but not to have. The floor sprites are greyscale masters, so a
     world with no paint renders as a white room full of grey furniture — which is what "a map room
     of the DC area" came back as. A missing theme therefore falls back rather than rendering grey;
     a malformed one is still refused, because that is the model getting something wrong rather than
     leaving it out. */
  const theme = a.theme === undefined ? null : checkTheme(a.theme);
  if (theme && !theme.ok) return { ok: false, problems: theme.problems };

  const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 60) : prompt.slice(0, 60);
  return {
    ok: true,
    world: {
      id: `w${Date.now().toString(36)}`,
      name,
      prompt,
      layout: applyTheme(world.layout, theme?.ok ? theme.theme : FALLBACK_THEME),
      createdAt: Date.now(),
    },
  };
}


/**
 * Draw a new piece of furniture, look at it, then keep it.
 *
 * The preview is the whole point of the control. A generated room either validates or does not, and
 * either way you can read the answer; a generated SPRITE can be perfectly valid and still be an
 * unrecognisable smudge, which is a judgment only a person looking at it can make. So it is drawn at
 * 4× on a canvas and nothing reaches the catalog until someone says keep.
 *
 * A kept piece is registered under a `DRAWN_` id and lives for the session. It is not persisted, and
 * that is not an omission: a world that used one carries the piece's id, and `checkWorld` refusing
 * an id the catalog no longer has is what turns a stale world into a message rather than a crash.
 */
function SpriteDrawer() {
  const draw = useApp((s) => s.drawPixelSprite);
  const run = useApp((s) => s.run);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [drawn, setDrawn] = useState<{ name: string; sprite: string[][]; footprintW: number; footprintH: number } | null>(null);
  const [kept, setKept] = useState<string[]>([]);
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = preview.current;
    if (!el || !drawn) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    /* Drawn at DEVICE resolution: the backing store is sized by dpr and the CSS box is not, so one
       sprite pixel is an exact whole number of device pixels and nothing is ever resampled. That is
       why the stylesheet makes no `image-rendering` claim — there is nothing to disown. */
    const cols = drawn.sprite[0]?.length ?? 0;
    const rows = drawn.sprite.length;
    const dpr = window.devicePixelRatio || 1;
    const scale = 4;
    el.style.width = `${cols * scale}px`;
    el.style.height = `${rows * scale}px`;
    el.width = Math.round(cols * scale * dpr);
    el.height = Math.round(rows * scale * dpr);
    const px = scale * dpr;
    ctx.clearRect(0, 0, el.width, el.height);
    for (let r = 0; r < rows; r++) {
      const row = drawn.sprite[r]!;
      for (let c = 0; c < row.length; c++) {
        const hex = row[c];
        if (!hex) continue;
        ctx.fillStyle = hex;
        ctx.fillRect(Math.round(c * px), Math.round(r * px), Math.ceil(px), Math.ceil(px));
      }
    }
  }, [drawn]);

  const ask = () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true); setProblems([]); setDrawn(null);
    run(async () => {
      try {
        const { json } = await draw({
          prompt: text,
          maxWidth: SPRITE_TILE * SPRITE_MAX_TILES,
          maxHeight: SPRITE_TILE * SPRITE_MAX_TILES,
        });
        let parsed: unknown;
        try { parsed = JSON.parse(json); }
        catch { setProblems(["The answer was not valid JSON."]); return; }
        const check = checkSprite(parsed);
        if (!check.ok) { setProblems(check.problems); return; }
        setDrawn({ name: check.name, sprite: check.sprite, footprintW: check.footprintW, footprintH: check.footprintH });
      } finally { setBusy(false); }
    });
  };

  const keep = () => {
    if (!drawn) return;
    const id = registerDrawnFurniture({
      id: drawn.name, label: drawn.name, sprite: drawn.sprite,
      footprintW: drawn.footprintW, footprintH: drawn.footprintH,
    });
    setKept((k) => [...k, id]);
    setDrawn(null);
    setPrompt("");
  };

  return (
    <div className="office-draw">
      <form className="office-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Icon name="paintBrush" size={14} className="office-ask-mark" />
        <input className="office-ask-input" value={prompt} aria-label="Draw a piece of furniture"
          placeholder="An arcade cabinet" disabled={busy}
          onChange={(e) => { setPrompt(e.target.value); setProblems([]); }} />
        <button type="submit" className="btn" disabled={!prompt.trim() || busy}>
          {busy ? <><Spinner size={14} /> Drawing…</> : "Draw it"}
        </button>
      </form>
      {drawn && (
        <div className="office-drawn">
          <canvas ref={preview} className="office-drawn-preview" aria-label={`Preview of ${drawn.name}`} />
          <span className="office-drawn-name">{drawn.name}</span>
          <span className="office-drawn-size">{drawn.footprintW}×{drawn.footprintH} tiles</span>
          <button type="button" className="btn primary" onClick={keep}>Keep it</button>
          <button type="button" className="btn" onClick={() => setDrawn(null)}>Discard</button>
        </div>
      )}
      {kept.length > 0 && (
        /* Named so a next prompt can ask for them by name — the vocabulary the world prompter is
           handed is read from the live catalog, so anything kept is immediately placeable. */
        <p className="office-kept">Drawn this session: {kept.join(", ")}</p>
      )}
      {problems.length > 0 && (
        <ul className="office-problems" aria-label="Why that drawing was refused">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}
