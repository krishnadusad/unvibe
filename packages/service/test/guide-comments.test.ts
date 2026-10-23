/**
 * Custom guides read the PR's GitHub discussion fresh (read-only `gh api`
 * GETs, stubbed here): inline threads, conversation comments and review
 * verdicts, rendered as threads with bots marked.
 */
import { describe, expect, it } from "vitest";
import type { CommandRunner, RunOptions, RunResult } from "../src/exec/index.js";
import { fetchGuideComments } from "../src/pipeline/guideComments.js";
import { renderGuideGithubComments } from "../src/pipeline/customGuide.js";

function stubGh(pages: Record<string, object[]>): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: (cmd: string, opts: RunOptions): Promise<RunResult> => {
      calls.push([cmd, ...opts.args]);
      const path = opts.args.find((a) => a.startsWith("repos/")) ?? "";
      const rows = Object.entries(pages).find(([suffix]) => path.endsWith(suffix))?.[1] ?? [];
      return Promise.resolve({ code: 0, stdout: rows.map((r) => JSON.stringify(r)).join("\n"), stderr: "" });
    },
  };
  return { runner, calls };
}

describe("fetchGuideComments", () => {
  it("reads inline, conversation and review comments with paginated GETs", async () => {
    const { runner, calls } = stubGh({
      "/pulls/7/comments": [
        { id: 1, body: "Why a regex here?", path: "src/a.py", line: 12, author: "ada", createdAt: "2026-01-01T10:00:00Z" },
        { id: 2, body: "Faster than a loop.", path: "src/a.py", line: 12, author: "bob", createdAt: "2026-01-01T11:00:00Z", replyTo: 1 },
      ],
      "/issues/7/comments": [{ id: 3, body: "Coverage: 91%", author: "codecov[bot]", createdAt: "2026-01-01T09:00:00Z" }],
      "/pulls/7/reviews": [
        { id: 4, body: "", state: "COMMENTED", author: "ada", createdAt: "2026-01-01T10:00:00Z" },
        { id: 5, body: "Looks good once the regex is explained.", state: "CHANGES_REQUESTED", author: "ada", createdAt: "2026-01-01T12:00:00Z" },
      ],
    });
    const out = await fetchGuideComments(runner, "/repo", "acme", "app", 7);
    expect(out.map((c) => [c.id, c.kind])).toEqual([
      [1, "inline"],
      [2, "inline"],
      [3, "conversation"],
      [5, "review"],
    ]);
    // Every call is a read-only paginated GET.
    for (const call of calls) {
      expect(call.slice(0, 3)).toEqual(["gh", "api", "--paginate"]);
      expect(call).not.toContain("-X");
      expect(call).not.toContain("--method");
    }

    const text = renderGuideGithubComments(out);
    // Oldest first: the bot's conversation comment, then the inline thread.
    expect(text.indexOf("codecov[bot] (bot)")).toBeLessThan(text.indexOf("### src/a.py:12"));
    expect(text).toContain("- bob · 2026-01-01T11:00:00Z · reply:\n  > Faster than a loop.");
    expect(text).toContain("ada · 2026-01-01T12:00:00Z · review: requested changes:");
  });

  it("says plainly when there is nothing or nothing could be read", () => {
    expect(renderGuideGithubComments([])).toMatch(/nobody has commented/);
    expect(renderGuideGithubComments(undefined)).toMatch(/not available/);
  });
});
