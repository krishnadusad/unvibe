/** Custom guides: route parsing, page paths, plotline rows, diff scope, comment visibility. */
import { describe, expect, it } from "vitest";
import type { Annotation, ReviewFile } from "@unvibe/shared";
import { filterFiles, guideHunkStates } from "../source/diff/diffLogic.js";
import { visibleAnnotations } from "../state/store.js";
import { guidePagePath, guideScopeLine, parseGuideSplat, plotlineRows } from "./customGuideRoutes.js";

const files = [
  {
    fileKey: "a",
    path: "a.ts",
    category: "src",
    hunks: [
      { contentHash: "1", newStart: 3 },
      { contentHash: "2", newStart: 9 },
    ],
  },
  { fileKey: "b", path: "b.ts", category: "src", hunks: [{ contentHash: "3", newStart: 1 }] },
] as unknown as ReviewFile[];

describe("parseGuideSplat", () => {
  it("reads main and custom guide routes", () => {
    expect(parseGuideSplat(undefined)).toEqual({ guideId: null, pageId: null });
    expect(parseGuideSplat("page/c-x")).toEqual({ guideId: null, pageId: "c-x" });
    expect(parseGuideSplat("guide/gd-1")).toEqual({ guideId: "gd-1", pageId: null });
    expect(parseGuideSplat("guide/gd-1/page/p%2F1")).toEqual({ guideId: "gd-1", pageId: "p/1" });
    expect(parseGuideSplat("other")).toEqual({ guideId: null, pageId: null });
  });
});

describe("guidePagePath", () => {
  it("routes guide pages to their guide and main pages to the main guide", () => {
    expect(guidePagePath("r", null, undefined, "gd-1")).toBe("/review/r");
    expect(guidePagePath("r", "root", undefined, "gd-1")).toBe("/review/r");
    expect(guidePagePath("r", "gp-gd-1", { id: "gp-gd-1", guideId: "gd-1" }, null)).toBe(
      "/review/r/guide/gd-1",
    );
    expect(guidePagePath("r", "x", { id: "x", guideId: "gd-1" }, null)).toBe("/review/r/guide/gd-1/page/x");
    expect(guidePagePath("r", "c-y", { id: "c-y" }, "gd-1")).toBe("/review/r/page/c-y");
    // Not in the snapshot yet: stays in the open guide.
    expect(guidePagePath("r", "new", undefined, "gd-1")).toBe("/review/r/guide/gd-1/page/new");
    expect(guidePagePath("r", "new", undefined, null)).toBe("/review/r/page/new");
  });
});

describe("plotlineRows", () => {
  it("counts in-scope hunks per plotline, with Other for the rest", () => {
    const rows = plotlineRows(
      [
        { id: "p", name: "P", description: "" },
        { id: "q", name: "Q", description: "", buildsOn: "p" },
      ],
      files,
      (fk, h) => (fk === "a" && h === "1" ? "p" : undefined),
      (fk) => fk === "a",
    );
    expect(rows.map((r) => [r.id, r.count, r.ref])).toEqual([
      ["p", 1, "diff:a:3"],
      ["q", 0, null],
      ["other", 1, "diff:a:9"],
    ]);
    expect(rows[1]).toMatchObject({ buildsOnId: "p", buildsOnName: "P", buildsOnRef: "diff:a:3" });
  });
});

describe("guide scope in the diff", () => {
  it("drops files and hunks outside the guide", () => {
    const base = { query: "", cats: new Set(["src"]), hideReviewed: false, reviewedCount: () => 0 };
    expect(filterFiles(files, { ...base, scope: new Set(["h:b:3"]) }).map((f) => f.fileKey)).toEqual(["b"]);
    expect(
      filterFiles(files, {
        ...base,
        scope: new Set(["h:a:1"]),
        plot: { plotline: "other" },
        hunkStateOf: (h) => (h === "1" ? { plotline: "p" } : undefined),
      }),
    ).toEqual([]);
  });

  it("replaces the main plotlines with the guide's assignment", () => {
    type St = { folded: boolean; reviewed: boolean; plotline?: string };
    const states = new Map<string, St>([
      ["1", { folded: true, reviewed: false, plotline: "main" }],
      ["3", { folded: false, reviewed: true, plotline: "main" }],
    ]);
    const out = guideHunkStates<St>(files, states, { "h:a:2": "g" }, () => ({
      folded: false,
      reviewed: false,
    }));
    expect(out.get("1")).toEqual({ folded: true, reviewed: false });
    expect(out.get("2")).toEqual({ folded: false, reviewed: false, plotline: "g" });
    expect(out.get("3")).toEqual({ folded: false, reviewed: true });
  });

  it("says how much the guide covers", () => {
    expect(guideScopeLine({ hunks: ["x"], commits: [] })).toBe("1 hunk");
    expect(guideScopeLine({ hunks: ["x", "y"], commits: ["c"] })).toBe("2 hunks · 1 commit");
  });
});

describe("visibleAnnotations", () => {
  const plain = { id: "a", post: false } as Annotation;
  const suggested = { id: "b", post: false, guideId: "gd-1" } as Annotation;
  const marked = { id: "c", post: true, guideId: "gd-1" } as Annotation;

  it("keeps a guide's unmarked suggestions inside that guide", () => {
    expect(visibleAnnotations([plain, suggested, marked], null).map((a) => a.id)).toEqual(["a", "c"]);
    expect(visibleAnnotations([plain, suggested, marked], "gd-2").map((a) => a.id)).toEqual(["a", "c"]);
    const all = [plain, suggested, marked];
    expect(visibleAnnotations(all, "gd-1")).toBe(all);
  });
});
