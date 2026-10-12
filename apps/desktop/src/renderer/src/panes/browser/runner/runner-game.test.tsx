import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserLoadError } from "@realm/contracts";
import { realmiteFromSeed } from "@realm/ui";
import { BrowserErrorPage } from "../BrowserErrorPage";
import { heroSpec } from "./runner-view";

afterEach(() => { cleanup(); localStorage.clear(); });

const error = (name: string, code: number, url = "http://localhost:3000/"): BrowserLoadError => ({ code, name, url });

function page(e: BrowserLoadError) {
  return render(<BrowserErrorPage error={e} busy={false} onReload={vi.fn()} />);
}

describe("the runner on the error page", () => {
  it("is there when the server refused, and when the Mac is offline", () => {
    page(error("ERR_CONNECTION_REFUSED", -102));
    expect(screen.getByRole("region", { name: "Runner game" })).toBeInTheDocument();
    cleanup();
    page(error("ERR_INTERNET_DISCONNECTED", -106, "https://example.com/"));
    expect(screen.getByRole("region", { name: "Runner game" })).toBeInTheDocument();
  });

  it("is not there on a certificate or secure-connection page, or another failure", () => {
    for (const e of [error("ERR_CERT_AUTHORITY_INVALID", -202, "https://localhost/"), error("ERR_SSL_PROTOCOL_ERROR", -107, "https://localhost/"), error("ERR_NAME_NOT_RESOLVED", -105)]) {
      page(e);
      expect(screen.queryByRole("region", { name: "Runner game" })).toBeNull();
      cleanup();
    }
  });

  it("comes after Reload, which stays the one filled button", () => {
    const { container } = page(error("ERR_CONNECTION_REFUSED", -102));
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons[0]).toBe("Reload");
    expect(buttons).toContain("Play");
    expect(container.querySelectorAll(".btn.primary")).toHaveLength(1);
  });

  it("leaves focus where it was, and takes no keys until it has focus", () => {
    const bar = document.createElement("input");
    document.body.append(bar);
    bar.focus();
    page(error("ERR_CONNECTION_REFUSED", -102));
    expect(document.activeElement).toBe(bar);
    fireEvent.keyDown(bar, { key: " " });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    bar.remove();
  });

  it("starts on Space in the game, and keeps sound off until asked", () => {
    page(error("ERR_CONNECTION_REFUSED", -102));
    expect(screen.getByRole("button", { name: "Sound off" })).toHaveAttribute("aria-pressed", "false");
    const canvas = screen.getByLabelText(/^Runner game\. Score/);
    canvas.focus();
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("shows the best score kept from before", () => {
    localStorage.setItem("realm.runner.best", "1234");
    page(error("ERR_CONNECTION_REFUSED", -102));
    expect(screen.getByText("Best 01234")).toBeInTheDocument();
  });
});

describe("the hero", () => {
  it("is the seed's Realmite, never in a blue hue", () => {
    let recoloured = 0;
    for (let i = 0; i < 300; i++) {
      const seed = `localhost:${3000 + i}`;
      const own = realmiteFromSeed(seed), hero = heroSpec(seed);
      expect(["sky", "realm", "iris", "teal"]).not.toContain(hero.palette);
      expect({ ...hero, palette: own.palette }).toEqual(own);
      if (hero.palette !== own.palette) recoloured++;
    }
    expect(recoloured).toBeGreaterThan(0);
  });
});
