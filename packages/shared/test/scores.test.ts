/**
 * Hunk scores + plotlines contract (issue #169): the small interface a
 * later source (the Decisions API) can replace without touching the UI
 * or the stored shape.
 */
import { describe, expect, it } from "vitest";
import {
  hunkMatchesFilter,
  MAX_PLOTLINES,
  normalizeHunkScore,
  normalizePlotlines,
  PLOTLINE_DESCRIPTION_MAX,
  PLOTLINE_NAME_MAX,
  PLOTLINE_OTHER_ID,
  resolveHunkScore,
} from "../src/scores.js";

describe("normalizeHunkScore", () => {
  it("accepts the four levels", () => {
    expect(normalizeHunkScore("mechanical")).toBe("mechanical");
    expect(normalizeHunkScore("routine")).toBe("routine");
    expect(normalizeHunkScore("substantive")).toBe("substantive");
    expect(normalizeHunkScore("needs-attention")).toBe("needs-attention");
  });

  it("is tolerant of case and spacing", () => {
    expect(normalizeHunkScore("Needs Attention")).toBe("needs-attention");
    expect(normalizeHunkScore("  ROUTINE ")).toBe("routine");
  });

  it("rejects invented and missing values", () => {
    expect(normalizeHunkScore("hot")).toBeNull();
    expect(normalizeHunkScore("needs_attention")).toBeNull();
    expect(normalizeHunkScore("")).toBeNull();
    expect(normalizeHunkScore(null)).toBeNull();
    expect(normalizeHunkScore(undefined)).toBeNull();
    expect(normalizeHunkScore(3)).toBeNull();
  });
});

describe("resolveHunkScore", () => {
  it("stores the agent value as returned", () => {
    expect(resolveHunkScore("substantive", { isOneLine: false })).toBe("substantive");
    expect(resolveHunkScore("mechanical", { isOneLine: false })).toBe("mechanical");
  });

  it("reads a missing value as routine", () => {
    expect(resolveHunkScore(null, { isOneLine: false })).toBe("routine");
  });

  it("never stores mechanical for a one-line change", () => {
    expect(resolveHunkScore("mechanical", { isOneLine: true })).toBe("routine");
    expect(resolveHunkScore(null, { isOneLine: true })).toBe("routine");
    expect(resolveHunkScore("substantive", { isOneLine: true })).toBe("substantive");
  });
});

const KNOWN = new Set(["h:conn:aaa", "h:conn:bob", "h:tst:ccc"]);

describe("normalizePlotlines", () => {
  it("assigns hunk IDs to named plotlines", () => {
    const got = normalizePlotlines(
      [
        { id: "retry", name: "Retry logic", description: "Retries failed uploads.", hunks: ["h:conn:aaa"] },
        { name: "Prove retries work", description: "Coverage.", buildsOn: "retry", hunks: ["h:tst:ccc"] },
      ],
      KNOWN,
    );
    expect(got.plotlines).toHaveLength(2);
    expect(got.plotlines[0]).toMatchObject({ id: "retry", name: "Retry logic" });
    expect(got.plotlines[1].buildsOn).toBe("retry");
    expect(got.plotlines[1].id).toBe("prove-retries-work");
    expect(got.assignment).toEqual({ "h:conn:aaa": "retry", "h:tst:ccc": "prove-retries-work" });
    expect(got.dropped).toEqual({ unknown: [], duplicates: [], extraPlotlines: 0 });
  });

  it("drops unknown hunk IDs and keeps the rest", () => {
    const got = normalizePlotlines(
      [{ name: "Retry logic", hunks: ["h:conn:aaa", "h:nope:zzz", "diff:conn:1-2", "garbage"] }],
      KNOWN,
    );
    expect(got.assignment).toEqual({ "h:conn:aaa": "retry-logic" });
    expect(got.dropped.unknown).toEqual(["h:nope:zzz", "diff:conn:1-2", "garbage"]);
  });

  it("keeps the first plotline for a twice-claimed hunk", () => {
    const got = normalizePlotlines(
      [
        { name: "First", hunks: ["h:conn:aaa"] },
        { name: "Second", hunks: ["h:conn:aaa", "h:conn:bob"] },
      ],
      KNOWN,
    );
    expect(got.assignment).toEqual({ "h:conn:aaa": "first", "h:conn:bob": "second" });
    expect(got.dropped.duplicates).toEqual(["h:conn:aaa"]);
  });

  it("reads empty and missing input as no plotlines (all other)", () => {
    expect(normalizePlotlines([], KNOWN).plotlines).toEqual([]);
    expect(normalizePlotlines(undefined, KNOWN).plotlines).toEqual([]);
    expect(normalizePlotlines({ plotlines: [] }, KNOWN).plotlines).toEqual([]);
  });

  it("keeps ordinary long names and descriptions whole", () => {
    const name = "Route uploads through the resumable session endpoint";
    const description =
      "Swap the one-shot upload for a resumable session so a dropped connection picks up where it left off " +
      "instead of restarting, and surface progress to the caller.";
    const got = normalizePlotlines([{ name, description, hunks: [] }], KNOWN);
    expect(got.plotlines[0]).toMatchObject({ name, description });
  });

  it("still caps runaway names and descriptions", () => {
    const got = normalizePlotlines(
      [{ name: "word ".repeat(100), description: "word ".repeat(400), hunks: [] }],
      KNOWN,
    );
    expect(got.plotlines[0].name.length).toBeLessThanOrEqual(PLOTLINE_NAME_MAX + 1);
    expect(got.plotlines[0].name.endsWith("…")).toBe(true);
    expect(got.plotlines[0].description.length).toBeLessThanOrEqual(PLOTLINE_DESCRIPTION_MAX + 1);
  });

  it(`caps at ${MAX_PLOTLINES} plotlines`, () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ name: `Thread ${i}`, hunks: [] }));
    const got = normalizePlotlines(input, KNOWN);
    expect(got.plotlines).toHaveLength(MAX_PLOTLINES);
    expect(got.dropped.extraPlotlines).toBe(2);
  });

  it("drops nameless entries and dedupes ids", () => {
    const got = normalizePlotlines(
      [{ description: "no name", hunks: [] }, { name: "Same", hunks: [] }, { name: "Same", hunks: [] }],
      KNOWN,
    );
    expect(got.plotlines.map((p) => p.id)).toEqual(["same", "same-2"]);
  });

  it("drops unknown or self buildsOn references", () => {
    const got = normalizePlotlines(
      [
        { name: "Self", buildsOn: "self", hunks: ["h:conn:bob"] },
        { name: "Dangling", buildsOn: "nope", hunks: ["h:tst:ccc"] },
      ],
      KNOWN,
    );
    expect(got.plotlines.map((p) => p.id)).toEqual(["self", "dangling"]);
    expect(got.plotlines[0].buildsOn).toBeUndefined();
    expect(got.plotlines[1].buildsOn).toBeUndefined();
    expect(got.assignment).toEqual({ "h:conn:bob": "self", "h:tst:ccc": "dangling" });
  });

  it("cleans names and descriptions to short single lines", () => {
    const got = normalizePlotlines(
      [{ name: "  Retry\nlogic  ", description: "Line one.\nLine two.", hunks: [] }],
      KNOWN,
    );
    expect(got.plotlines[0].name).toBe("Retry logic");
    expect(got.plotlines[0].description).toBe("Line one. Line two.");
  });
});

describe("hunkMatchesFilter", () => {
  it("passes everything without a filter", () => {
    expect(hunkMatchesFilter(undefined, undefined, undefined)).toBe(true);
    expect(hunkMatchesFilter("mechanical", "x", {})).toBe(true);
  });

  it("matches by score level or higher", () => {
    expect(hunkMatchesFilter("routine", undefined, { score: "routine" })).toBe(true);
    expect(hunkMatchesFilter("substantive", undefined, { score: "routine" })).toBe(true);
    expect(hunkMatchesFilter("needs-attention", undefined, { score: "substantive" })).toBe(true);
    expect(hunkMatchesFilter("mechanical", undefined, { score: "routine" })).toBe(false);
  });

  it("never filters away a hunk whose score has not landed", () => {
    expect(hunkMatchesFilter(undefined, undefined, { score: "routine" })).toBe(true);
  });

  it("matches by plotline, reading unassigned as other", () => {
    expect(hunkMatchesFilter(undefined, "retry", { plotline: "retry" })).toBe(true);
    expect(hunkMatchesFilter(undefined, "tests", { plotline: "retry" })).toBe(false);
    expect(hunkMatchesFilter(undefined, undefined, { plotline: PLOTLINE_OTHER_ID })).toBe(true);
    expect(hunkMatchesFilter(undefined, "retry", { plotline: PLOTLINE_OTHER_ID })).toBe(false);
  });

  it("requires both when both are set", () => {
    const filter = { plotline: "retry", score: "substantive" as const };
    expect(hunkMatchesFilter("substantive", "retry", filter)).toBe(true);
    expect(hunkMatchesFilter("routine", "retry", filter)).toBe(false);
    expect(hunkMatchesFilter("substantive", "tests", filter)).toBe(false);
  });
});
