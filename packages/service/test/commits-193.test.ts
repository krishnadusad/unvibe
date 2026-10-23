/**
 * Issues #193/#197: commit evidence for plotlines — per-commit files/hunks
 * at ingest, and the Commits section in the reader's L1 context. #197:
 * every commit, full multi-line message, every file and hunk, on every
 * budget rung. Pure logic only; the live reader behaviour is covered by
 * the `test:live:plotlines` script, not here.
 */
import { describe, expect, it } from "vitest";
import type { ReviewFile } from "@unvibe/shared";
import { buildReviewCommits } from "../src/ingest/commits.js";
import { parseUnifiedDiff } from "../src/ingest/diff.js";
import { buildL1Source } from "../src/context/index.js";
import { fixtureSnapshot } from "./fixtures.js";

function reviewFiles(): ReviewFile[] {
  return [
    {
      fileKey: "a",
      path: "src/a.py",
      category: "source",
      hunks: [
        {
          contentHash: "h1",
          header: "@@ -1,2 +1,3 @@",
          newStart: 10,
          newEnd: 12,
          oldStart: 10,
          oldEnd: 11,
          added: 1,
          removed: 0,
          lines: [
            { kind: "ctx", text: "x = 1" },
            { kind: "add", text: "return compute_value(x)" },
          ],
        },
        {
          contentHash: "h2",
          header: "@@ -20,2 +30,2 @@",
          newStart: 30,
          newEnd: 31,
          oldStart: 20,
          oldEnd: 21,
          added: 1,
          removed: 1,
          lines: [
            { kind: "del", text: "old_flag = False" },
            { kind: "add", text: "new_flag = True" },
          ],
        },
      ],
    },
  ];
}

const DIFF_SHIFTED = [
  "diff --git a/src/a.py b/src/a.py",
  "--- a/src/a.py",
  "+++ b/src/a.py",
  "@@ -1,2 +1,3 @@",
  " x = 1",
  "+return compute_value(x)",
  "",
].join("\n");

const DIFF_OTHER = [
  "diff --git a/src/a.py b/src/a.py",
  "--- a/src/a.py",
  "+++ b/src/a.py",
  "@@ -20,2 +20,2 @@",
  "-old_flag = False",
  "+new_flag = True",
  "",
].join("\n");

describe("buildReviewCommits (#193)", () => {
  it("maps a commit to PR hunks by shared changed lines despite line drift", () => {
    const out = buildReviewCommits(
      [{ sha: "aaa", subject: "Add compute", body: "why", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00" }],
      new Map([["aaa", parseUnifiedDiff(DIFF_SHIFTED)]]),
      reviewFiles(),
    );
    expect(out).toEqual([
      { sha: "aaa", subject: "Add compute", body: "why", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00", files: ["src/a.py"], hunks: ["h:a:h1"] },
    ]);
  });

  it("keeps an overwritten commit's files with no surviving hunks", () => {
    const out = buildReviewCommits(
      [
        { sha: "aaa", subject: "wip", body: "", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00" },
        { sha: "bbb", subject: "Replace flag", body: "", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00" },
      ],
      new Map([
        ["aaa", parseUnifiedDiff(DIFF_OTHER.replace("old_flag = False", "gone_flag = 1").replace("new_flag = True", "gone_flag = 2"))],
        ["bbb", parseUnifiedDiff(DIFF_OTHER)],
      ]),
      reviewFiles(),
    );
    expect(out[0].files).toEqual(["src/a.py"]);
    expect(out[0].hunks).toEqual([]);
    expect(out[1].hunks).toEqual(["h:a:h2"]);
  });

  it("keeps the message when no diff was fetched", () => {
    const out = buildReviewCommits([{ sha: "ccc", subject: "Merge main", body: "", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00" }], new Map(), reviewFiles());
    expect(out).toEqual([{ sha: "ccc", subject: "Merge main", body: "", author: "Ada", authorDate: "2026-01-02T10:00:00+00:00", committerDate: "2026-01-02T11:00:00+00:00", files: [], hunks: [] }]);
  });
});

describe("commits section (#193)", () => {
  it("renders subjects, bodies, files and hunk IDs in L1", () => {
    const text = buildL1Source(fixtureSnapshot()).text;
    expect(text).toContain("## Commits");
    expect(text).toContain("Unfold obsolete folded header values");
    expect(text).toContain("   Normalize both views of the parsed headers.");
    expect(text).toContain("files: src/urllib3/connection.py");
    expect(text).toContain("hunks: h:conn:h111, h:conn:h222");
    expect(text).toContain("evidence for the plotlines, not the answer");
  });

  it("is absent when the snapshot carries no commits", () => {
    const snap = fixtureSnapshot();
    delete snap.commits;
    expect(buildL1Source(snap).text).not.toContain("## Commits");
  });
});

describe("commits section, uncapped (#197)", () => {
  function manyCommits() {
    const snap = fixtureSnapshot();
    const longBody = [
      "First body line explains the reasoning at length.",
      "Second line keeps the detail the plotlines need.",
      "x".repeat(400),
    ].join("\n");
    snap.commits = Array.from({ length: 35 }, (_, i) => ({
      sha: `c${String(i).padStart(6, "0")}def5678abc1234def5678abc1234def5`,
      subject: `Step ${i + 1} of the stack`,
      body: i === 0 ? longBody : "",
      files:
        i === 0
          ? Array.from({ length: 12 }, (_, f) => `src/f${f}.py`)
          : ["src/urllib3/connection.py"],
      hunks:
        i === 0
          ? Array.from({ length: 25 }, (_, h) => `h:conn:x${h}`)
          : ["h:conn:h111", "h:conn:h222"],
    }));
    // One commit whose changes did not survive into the PR diff.
    snap.commits.push({
      sha: "deadbeef5678abc1234def5678abc1234def5",
      subject: "Overwritten experiment",
      body: "",
      files: ["src/gone.py"],
      hunks: [],
    });
    return snap;
  }

  it("lists every commit with its full multi-line body, files and hunks", () => {
    const text = buildL1Source(manyCommits()).text;
    expect(text).toContain("Step 35 of the stack");
    expect(text).not.toContain("more commits not shown");
    expect(text).toContain("First body line explains the reasoning at length.");
    expect(text).toContain("Second line keeps the detail the plotlines need.");
    expect(text).toContain("x".repeat(400));
    expect(text).toContain("src/f11.py");
    expect(text).not.toContain("more)");
    expect(text).toContain("h:conn:x24");
    // A hunk touched by several commits is listed under each of them.
    expect(text.split("h:conn:h111").length - 1).toBeGreaterThan(30);
  });

  it("shows a commit with no surviving hunks explicitly", () => {
    const text = buildL1Source(manyCommits()).text;
    expect(text).toContain("Overwritten experiment");
    expect(text).toContain("files: src/gone.py");
    expect(text).toContain("hunks: (none in this PR's diff");
  });

  it("keeps the full commit→hunk mapping on the counts-only rung", () => {
    const snap = manyCommits();
    // A cited hunk past the cap plus a long file list force the cheapest
    // rung; the commits section must still be whole (other context
    // shrinks first: file list, diff bodies, hidden rows).
    snap.files = [
      {
        fileKey: "big",
        path: "src/big.py",
        category: "source",
        hunks: [
          {
            contentHash: "big1",
            fileKey: "big",
            header: "@@ -1,2 +1,2 @@",
            newStart: 1,
            oldStart: 1,
            citedByGuide: true,
            lines: [{ kind: "add", text: "y".repeat(400_000) }],
          },
        ],
      },
      ...Array.from({ length: 300 }, (_, i) => ({
        fileKey: `f${i}`,
        path: `src/some/deeply/nested/module/path/number-${i}/file_with_a_long_descriptive_name_${i}.py`,
        category: "source" as const,
        hunks: [
          {
            contentHash: `s${i}`,
            fileKey: `f${i}`,
            header: "@@ -1,1 +1,1 @@",
            newStart: 1,
            oldStart: 1,
            lines: [{ kind: "add" as const, text: "z = 1" }],
          },
        ],
      })),
    ];
    const l1 = buildL1Source(snap, { baseCapTokens: 8_000 });
    expect(l1.rung).toBe("counts-only");
    expect(l1.text).toContain("Step 35 of the stack");
    expect(l1.text).toContain("h:conn:x24");
    expect(l1.text).toContain("First body line explains the reasoning at length.");
    expect(l1.text).toContain("Files (counts only)");
  });
});
