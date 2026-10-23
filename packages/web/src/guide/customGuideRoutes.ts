/**
 * Custom guides (web side): routes and the pure lookups the guide pane
 * and the diff pane share.
 *
 * Routes (under `/review/:id/*`): the main guide keeps `/review/:id` and
 * `/review/:id/page/:pageId`; a custom guide's root page is
 * `/review/:id/guide/:guideId`, its child pages
 * `/review/:id/guide/:guideId/page/:pageId`.
 */
import type { CustomGuide, Page, Plotline, ReviewFile } from "@unvibe/shared";
import { customGuidePageId, PLOTLINE_OTHER_ID } from "@unvibe/shared";

export interface GuideRoute {
  /** Custom guide in the URL; null on the main guide. */
  guideId: string | null;
  /** Page in the URL; null for the (main or custom) guide's root. */
  pageId: string | null;
}

/** Parse the review route's splat (`page/x`, `guide/g`, `guide/g/page/x`). */
export function parseGuideSplat(splat: string | undefined): GuideRoute {
  if (!splat) return { guideId: null, pageId: null };
  const page = splat.match(/^page\/([^/]+)$/);
  if (page) return { guideId: null, pageId: decodeURIComponent(page[1]) };
  const guide = splat.match(/^guide\/([^/]+)(?:\/page\/([^/]+))?$/);
  if (guide) {
    return {
      guideId: decodeURIComponent(guide[1]),
      pageId: guide[2] !== undefined ? decodeURIComponent(guide[2]) : null,
    };
  }
  return { guideId: null, pageId: null };
}

/**
 * URL for a page. Pages that belong to a custom guide open on that
 * guide's route (its root page on the guide route itself); a page not in
 * the snapshot yet (being written) stays in the guide open now.
 */
export function guidePagePath(
  reviewId: string,
  pageId: string | null,
  page: Pick<Page, "id" | "guideId"> | undefined,
  currentGuideId: string | null,
): string {
  const base = `/review/${reviewId}`;
  if (pageId === null || pageId === "root") return base;
  const guideId = page ? page.guideId : currentGuideId;
  if (guideId) {
    const g = `${base}/guide/${encodeURIComponent(guideId)}`;
    return pageId === customGuidePageId(guideId) ? g : `${g}/page/${encodeURIComponent(pageId)}`;
  }
  return `${base}/page/${encodeURIComponent(pageId)}`;
}

/** Canonical `h:` id of a hunk. */
export function hunkCanonicalId(fileKey: string, contentHash: string): string {
  return `h:${fileKey}:${contentHash}`;
}

/** Plotline of a hunk within a guide (absent = "other"). */
export function guidePlotlineOf(
  guide: Pick<CustomGuide, "assignment">,
  fileKey: string,
  contentHash: string,
): string | undefined {
  return guide.assignment[hunkCanonicalId(fileKey, contentHash)];
}

export interface PlotlineRow {
  id: string;
  name: string;
  desc?: string;
  buildsOnId?: string;
  buildsOnName?: string;
  /** `diff:` ref of the builds-on plotline's first hunk. */
  buildsOnRef: string | null;
  count: number;
  /** `diff:` ref of the plotline's first hunk (null when it has none). */
  ref: string | null;
}

/**
 * Rows of a Plotlines box: each plotline with its hunk count and first
 * hunk, plus "Other" for in-scope hunks no plotline claimed. `plotlineOf`
 * names a hunk's plotline; `inScope` limits the hunks counted (a custom
 * guide counts only its own).
 */
export function plotlineRows(
  plotlines: readonly Plotline[],
  files: readonly ReviewFile[],
  plotlineOf: (fileKey: string, contentHash: string) => string | undefined,
  inScope: (fileKey: string, contentHash: string) => boolean = () => true,
): PlotlineRow[] {
  const counts = new Map<string, number>();
  const firstRef = new Map<string, string>();
  for (const f of files) {
    for (const h of f.hunks) {
      if (!inScope(f.fileKey, h.contentHash)) continue;
      const id = plotlineOf(f.fileKey, h.contentHash) ?? PLOTLINE_OTHER_ID;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (!firstRef.has(id)) firstRef.set(id, `diff:${f.fileKey}:${h.newStart}`);
    }
  }
  const byId = new Map(plotlines.map((p) => [p.id, p]));
  const rows: PlotlineRow[] = plotlines.map((p) => {
    const buildsOn = p.buildsOn !== undefined ? byId.get(p.buildsOn) : undefined;
    return {
      id: p.id,
      name: p.name,
      ...(p.description ? { desc: p.description } : {}),
      ...(buildsOn ? { buildsOnId: buildsOn.id, buildsOnName: buildsOn.name } : {}),
      buildsOnRef: buildsOn ? (firstRef.get(buildsOn.id) ?? null) : null,
      count: counts.get(p.id) ?? 0,
      ref: firstRef.get(p.id) ?? null,
    };
  });
  const other = counts.get(PLOTLINE_OTHER_ID) ?? 0;
  if (other > 0) {
    rows.push({
      id: PLOTLINE_OTHER_ID,
      name: "Other",
      desc: "Hunks no plotline claimed.",
      buildsOnRef: null,
      count: other,
      ref: firstRef.get(PLOTLINE_OTHER_ID) ?? null,
    });
  }
  return rows;
}

/** "5 hunks · 2 commits" for a guide's scope line. */
export function guideScopeLine(guide: Pick<CustomGuide, "hunks" | "commits">): string {
  const h = guide.hunks.length;
  const c = guide.commits.length;
  const hunks = `${h} ${h === 1 ? "hunk" : "hunks"}`;
  return c > 0 ? `${hunks} · ${c} ${c === 1 ? "commit" : "commits"}` : hunks;
}
