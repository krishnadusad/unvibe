// DISABLED(#188): covered by J11 (full-access marker)
/**
 * FullAccessMarker (issue #160): renders nothing when the setting is off
 * or unreadable; a quiet pill linking to Settings → Access when it is on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "../api/client.js";
import { FullAccessMarker } from "./FullAccessMarker.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function settings(fullAccess: boolean): Awaited<ReturnType<typeof api.settings>> {
  return {
    main: { provider: "claude", model: "m", effort: "" },
    small: { provider: "claude", model: "m", effort: "" },
    secondOpinion: { provider: "codex", model: "", effort: "" },
    sessionsPerProvider: 4,
    inlineBudgetTokens: 40000,
    rebuildSupersededRatio: 0.2,
    rebuildAppendedTokens: 10000,
    logBatchTokens: 2000,
    cacheLifetimeMs: 300000,
    idleExitMinutes: 10,
    uiTheme: "default",
    colorMode: "system",
  versionPickerEnabled: false,
    fullAccess,
    autoGoDeeper: true,
  fullAccessAcknowledgedAt: fullAccess ? 1 : null,
  };
}

describe("FullAccessMarker", () => {
  it("renders nothing when full access is off", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settings(false));
    render(
      <MemoryRouter>
        <FullAccessMarker compact />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    expect(screen.queryByTestId("full-access-marker")).toBeNull();
  });

  it("renders the pill linking to Settings → Access when on", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settings(true));
    render(
      <MemoryRouter>
        <FullAccessMarker compact />
      </MemoryRouter>,
    );
    const marker = await screen.findByTestId("full-access-marker");
    expect(marker).toHaveTextContent("full access");
    expect(marker).toHaveAttribute("href", "/settings?tab=access");
  });

  it("renders nothing when settings fail", async () => {
    vi.spyOn(api, "settings").mockRejectedValue(new Error("offline"));
    render(
      <MemoryRouter>
        <FullAccessMarker compact />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    expect(screen.queryByTestId("full-access-marker")).toBeNull();
  });
});
