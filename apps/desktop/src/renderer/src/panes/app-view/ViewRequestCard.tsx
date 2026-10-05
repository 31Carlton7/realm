import { useEffect, useRef } from "react";
import type { HeldRequest } from "./bridge";

/** How long a card ignores clicks after it appears. A view chooses when to ask, so it could ask
 *  under a pointer it knows is about to press; nothing a person decides happens in under this. */
export const ARM_MS = 500;

/**
 * What a view asked to do, held until the user answers (MCP Apps). Nothing it asks for happens on its
 * say: a tool call, words for the agent and a page to open each wait on this card, and a card nobody
 * answers is a request nothing comes of.
 *
 * Drawn by Realm, outside the view's frame — a frame cannot paint over its own box, so nothing the
 * view draws can cover or imitate the card — and it says who is asking and what each answer does
 * before either is pressed. `data-no-agent`: an answer here is the user's, and an agent driving the
 * window must not be able to give it.
 */
export function ViewRequestCard({ request, serverName, onAllow, onDeny }: {
  request: HeldRequest; serverName: string; onAllow: () => void; onDeny: () => void;
}) {
  const armedAt = useRef(Date.now() + ARM_MS);
  useEffect(() => { armedAt.current = Date.now() + ARM_MS; }, [request]);
  const armed = (fn: () => void) => () => { if (Date.now() >= armedAt.current) fn(); };
  const copy = wording(request, serverName);
  return (
    <div className="app-view-request" role="group" aria-label={`Request from ${serverName}'s view`} data-no-agent="view request">
      <p className="app-view-request-title">{copy.title}</p>
      {request.kind === "tool" && <pre className="app-view-request-well">{JSON.stringify(request.arguments, null, 2)}</pre>}
      {request.kind === "message" && <pre className="app-view-request-well app-view-request-text">{request.text}</pre>}
      {request.kind === "link" && <LinkLine url={request.url} />}
      <p className="app-view-request-note">{copy.note}</p>
      <div className="app-view-request-actions">
        <button type="button" className="btn" onClick={armed(onDeny)}>{copy.deny}</button>
        <button type="button" className="btn primary" onClick={armed(onAllow)}>{copy.allow}</button>
      </div>
    </div>
  );
}

/** The address in full, with its host set apart, as text: a link the user could click here would be
 *  the request answering itself. */
function LinkLine({ url }: { url: string }) {
  const u = new URL(url);
  const at = url.indexOf(u.host);
  return (
    <p className="app-view-request-link">
      {url.slice(0, at)}<span className="app-view-request-host">{u.host}</span>{url.slice(at + u.host.length)}
    </p>
  );
}

function wording(r: HeldRequest, server: string): { title: string; note: string; allow: string; deny: string } {
  switch (r.kind) {
    case "tool": return {
      title: `The view from ${server} asks to run ${r.name}.`,
      note: `${server} runs it with these arguments. The result goes back to the view, not to the agent.`,
      allow: `Run ${r.name}`, deny: "Don't run",
    };
    case "message": return {
      title: `The view from ${server} wrote a message for the agent.`,
      note: "It goes into the prompter, for you to read, change and send yourself.",
      allow: "Put in the prompter", deny: "Discard",
    };
    case "link": return {
      title: `The view from ${server} asks to open a page.`,
      note: "It opens in your browser.",
      allow: `Open ${new URL(r.url).host}`, deny: "Don't open",
    };
  }
}
