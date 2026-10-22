// DISABLED(#188): pins version-section mock state (J5 covers the real list)
/**
 * VersionSection switch-anyway flow (#36 follow-up): a running-jobs
 * refusal renders inline on the row (which jobs, what switching does to
 * them) with "Switch anyway" (re-posts with `force: true`) and Cancel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Settings, UpdateBuildInfo, UpdateChannel, UpdateStatusResponse } from "@unvibe/shared";
import { api } from "../api/client.js";
import { UpdateJobsBlockedError } from "../api/updateBlocked.js";
import { VersionSection } from "./VersionSection.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SETTINGS: Settings = {
  main: { provider: "claude", model: "mock-main", effort: "" },
  small: { provider: "claude", model: "mock-small", effort: "" },
  secondOpinion: { provider: "codex", model: "mock-second", effort: "" },
  sessionsPerProvider: 4,
  inlineBudgetTokens: 40000,
  rebuildSupersededRatio: 0.2,
  rebuildAppendedTokens: 10000,
  logBatchTokens: 2000,
  cacheLifetimeMs: 300000,
  idleExitMinutes: 10,
  uiTheme: "default",
  colorMode: "system",
  versionPickerEnabled: true,
  fullAccess: false,
  autoGoDeeper: true,
  fullAccessAcknowledgedAt: null,
};

const BUILD = { version: "0.0.1", channel: "release", sourceBranch: null, sourceCommit: null, baseBranch: null, baseCommit: null, commit: null, builtAt: null };

const CHANNELS: UpdateChannel[] = [
  { ref: "release", kind: "release", version: "0.0.1", commit: null, sourceBranch: null, sourceCommit: null, baseBranch: null, baseCommit: null, builtAt: null, current: true },
  {
    ref: "preview/feat-x",
    kind: "preview",
    version: "0.0.1-preview.feat-x.abc1234",
    commit: "abc1234def5678",
    sourceBranch: "feat/x",
    sourceCommit: null,
    baseBranch: null,
    baseCommit: null,
    builtAt: new Date(Date.now() - 3600_000).toISOString(),
    current: false,
  },
];

function statusWith(outcome: UpdateStatusResponse["outcome"]): UpdateStatusResponse {
  return { enabled: true, build: BUILD, pending: null, outcome };
}

describe("VersionSection installed and channel states", () => {
  function renderWith(build: UpdateBuildInfo, channels: UpdateChannel[]): void {
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: build.version, build });
    vi.spyOn(api, "updateChannels").mockResolvedValue({ channels });
    vi.spyOn(api, "updateStatus").mockResolvedValue({ enabled: true, build, pending: null, outcome: null });
    vi.spyOn(api, "updateSwitch").mockResolvedValue({ from: "release", to: "release" });
    render(<VersionSection settings={SETTINGS} onSaved={() => {}} />);
  }

  const running = {
    version: "0.0.1-preview.feat-x.6818b23",
    channel: "preview/feat-x",
    sourceBranch: "feat/x",
    sourceCommit: "6818b23aaaaaaa",
    baseBranch: "main",
    baseCommit: "c562ed1bbbbbbb",
    commit: "6818b23aaaaaaa",
    builtAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
  };
  const currentRow = (commit: string): UpdateChannel => ({
    ref: "preview/feat-x",
    kind: "preview",
    version: "0.0.1-preview.feat-x.b535a30",
    commit,
    sourceBranch: "feat/x",
    sourceCommit: commit,
    baseBranch: "main",
    baseCommit: "dddd4444eeee5555",
    builtAt: new Date(Date.now() - 3600_000).toISOString(),
    current: true,
  });
  const otherRow: UpdateChannel = {
    ref: "release",
    kind: "release",
    version: "0.0.1",
    commit: "eeee5555ffff6666",
    sourceBranch: null,
    sourceCommit: null,
    baseBranch: null,
    baseCommit: null,
    builtAt: new Date(Date.now() - 7200_000).toISOString(),
    current: false,
  };

  // #246: no separate Installed line — the installed channel is marked
  // by its Installed badge in the list.
  it("up to date: INSTALLED pill and no Update button", async () => {
    renderWith(running, [currentRow("6818b23aaaaaaa"), otherRow]);
    await screen.findByText("preview/feat-x");
    expect(screen.queryByTestId("update-current-version")).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')).not.toBeNull());
    const row = document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')!;
    expect(row.querySelector('[data-testid="update-current"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="update-available"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Update preview/feat-x" })).toBeNull();
  });

  it("newer available: Update available state, latest commit and age, Update button, no INSTALLED pill", async () => {
    renderWith(running, [currentRow("b535a30ccccccc"), otherRow]);
    await screen.findByText("preview/feat-x");
    expect(screen.queryByTestId("update-current-version")).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')).not.toBeNull());
    const row = document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')!;
    expect(row.querySelector('[data-testid="update-current"]')).toBeNull();
    expect(row.querySelector('[data-testid="update-available"]')).not.toBeNull();
    expect(row).toHaveTextContent("b535a30");
    expect(row).toHaveTextContent("built 1h ago");
    expect(screen.getByRole("button", { name: "Update preview/feat-x" })).toHaveTextContent("Update");
  });

  it("other channel: no pill, Switch button", async () => {
    renderWith(running, [currentRow("6818b23aaaaaaa"), otherRow]);
    await screen.findByText("preview/feat-x");
    expect(screen.queryByTestId("update-current-version")).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-testid="update-channel"][data-ref="release"]')).not.toBeNull());
    const row = document.querySelector('[data-testid="update-channel"][data-ref="release"]')!;
    expect(row.querySelector('[data-testid="update-current"]')).toBeNull();
    expect(row.querySelector('[data-testid="update-available"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to release" })).toHaveTextContent("Switch");
  });
});

describe("VersionSection switch anyway", () => {
  it("refused switch shows the jobs inline; Switch anyway re-posts with force", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { reload }, writable: true });
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "0.0.1", build: BUILD });
    vi.spyOn(api, "updateChannels").mockResolvedValue({ channels: CHANNELS });
    let switched = false;
    vi.spyOn(api, "updateStatus").mockImplementation(async () =>
      switched
        ? statusWith({ status: "ok", from: "release", to: "preview/feat-x", finishedAt: new Date().toISOString() })
        : statusWith(null),
    );
    const updateSwitch = vi
      .spyOn(api, "updateSwitch")
      .mockRejectedValueOnce(
        new UpdateJobsBlockedError(
          2,
          [
            { id: "j1", kind: "explain", reviewId: "demo", state: "running", label: "Streaming answer…" },
            { id: "j2", kind: "hunk-pass", reviewId: "demo", state: "queued" },
          ],
          "cannot switch while 2 jobs are running",
        ),
      )
      .mockImplementation(async () => {
        switched = true;
        return { from: "release", to: "preview/feat-x" };
      });

    render(<VersionSection settings={SETTINGS} onSaved={() => {}} />);
    await screen.findByText("preview/feat-x");
    const feat = document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')!;
    fireEvent.click(feat.querySelector("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm switch to preview/feat-x" }));

    // Inline on the row: which jobs, what switching does, both actions.
    const panel = await screen.findByTestId("update-blocked");
    expect(panel).toHaveTextContent("2 running jobs — switching stops them");
    expect(panel).toHaveTextContent("show as interrupted");
    expect(panel).toHaveTextContent("stay with this channel");
    expect(panel).toHaveTextContent("switch back to resume or retry them");
    expect(screen.getByTestId("update-blocked-jobs")).toHaveTextContent("explain · demo · running");
    expect(updateSwitch).toHaveBeenCalledWith("preview/feat-x", undefined);

    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));
    await waitFor(() => expect(updateSwitch).toHaveBeenCalledWith("preview/feat-x", true));
    // Forced switch committed: the page waits out the restart, then reloads.
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("Cancel drops the refusal and restores the row", async () => {
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "0.0.1", build: BUILD });
    vi.spyOn(api, "updateChannels").mockResolvedValue({ channels: CHANNELS });
    vi.spyOn(api, "updateStatus").mockResolvedValue(statusWith(null));
    vi.spyOn(api, "updateSwitch").mockRejectedValue(
      new UpdateJobsBlockedError(1, [{ id: "j1", kind: "reader", state: "running" }]),
    );

    render(<VersionSection settings={SETTINGS} onSaved={() => {}} />);
    await screen.findByText("preview/feat-x");
    const feat = document.querySelector('[data-testid="update-channel"][data-ref="preview/feat-x"]')!;
    fireEvent.click(feat.querySelector("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm switch to preview/feat-x" }));
    await screen.findByTestId("update-blocked");

    fireEvent.click(screen.getByRole("button", { name: "Cancel switch to preview/feat-x" }));
    await waitFor(() => expect(screen.queryByTestId("update-blocked")).not.toBeInTheDocument());
    expect(feat.querySelector("button")).toHaveTextContent("Switch");
  });
});
