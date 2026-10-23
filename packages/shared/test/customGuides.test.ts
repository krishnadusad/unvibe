import { describe, expect, it } from "vitest";
import type { ReviewCommit } from "../src/scores.js";
import { annotationVisibleIn, customGuideFallbackTitle, resolveCustomGuideScope } from "../src/customGuides.js";

const commit = (sha: string, hunks: string[]): ReviewCommit => ({
  sha,
  subject: "s",
  body: "",
  author: "Ada",
  authorDate: "2026-01-02T10:00:00+00:00",
  committerDate: "2026-01-02T10:00:00+00:00",
  files: [],
  hunks,
});

const KNOWN = ["h:a:1", "h:a:2", "h:b:3", "h:b:4"];

describe("resolveCustomGuideScope", () => {
  const commits = [commit("aaaaaaa111", ["h:a:1", "h:b:3"]), commit("bbbbbbb222", ["h:a:2", "h:gone:9"])];

  it("adds a referenced commit's hunks, in diff order", () => {
    const out = resolveCustomGuideScope({ commits, knownInOrder: KNOWN, commitRefs: ["bbbbbbb", "aaaaaaa111"], hunkRefs: [], plotlineHunks: [] });
    expect(out.commits).toEqual(["aaaaaaa111", "bbbbbbb222"]);
    expect(out.hunks).toEqual(["h:a:1", "h:a:2", "h:b:3"]);
  });

  it("needs at least 7 characters to match a commit", () => {
    const out = resolveCustomGuideScope({ commits, knownInOrder: KNOWN, commitRefs: ["aaa", "zzzzzzz"], hunkRefs: [], plotlineHunks: [] });
    expect(out.commits).toEqual([]);
    expect(out.unknownCommits).toEqual(["aaa", "zzzzzzz"]);
  });

  it("unions explicit and plotline hunks and drops unknown ones", () => {
    const out = resolveCustomGuideScope({
      commits,
      knownInOrder: KNOWN,
      commitRefs: undefined,
      hunkRefs: ["h:b:4", "h:nope:0", 7],
      plotlineHunks: ["h:a:1"],
    });
    expect(out.hunks).toEqual(["h:a:1", "h:b:4"]);
    expect(out.unknownHunks).toEqual(["h:nope:0"]);
  });
});

describe("annotationVisibleIn", () => {
  it("shows main-guide annotations everywhere", () => {
    expect(annotationVisibleIn({ post: false }, null)).toBe(true);
    expect(annotationVisibleIn({ post: false }, "gd-1")).toBe(true);
  });

  it("keeps a guide's unmarked suggestions inside that guide", () => {
    expect(annotationVisibleIn({ guideId: "gd-1", post: false }, null)).toBe(false);
    expect(annotationVisibleIn({ guideId: "gd-1", post: false }, "gd-2")).toBe(false);
    expect(annotationVisibleIn({ guideId: "gd-1", post: false }, "gd-1")).toBe(true);
  });

  it("shows a suggestion everywhere once marked for the PR", () => {
    expect(annotationVisibleIn({ guideId: "gd-1", post: true }, null)).toBe(true);
  });
});

describe("customGuideFallbackTitle", () => {
  it("uses the first line, shortened", () => {
    expect(customGuideFallbackTitle("  Security\n review ")).toBe("Security review");
    expect(customGuideFallbackTitle("x".repeat(80))).toHaveLength(60);
    expect(customGuideFallbackTitle("   ")).toBe("Custom guide");
  });
});
