/**
 * Hunk interestingness scores + change plotlines (issue #169).
 *
 * Small interface so a later source (the Decisions API) can replace the
 * agents without touching the UI or the stored shape: the agents produce
 * raw values in their trailing JSON blocks, and everything downstream
 * reads through the two normalize functions below.
 *
 * - Scoring: the hunk pass returns one ordered level per hunk. The
 *   deterministic rules still apply on top (see `resolveHunkScore`): a
 *   one-line change is never "mechanical", and hiding still follows
 *   `hiddenReason` alone — the score never hides or unhides by itself.
 * - Plotlines: the reader names a few threads of change (the unit of a
 *   separate commit or stacked PR, never a file type) in landing order,
 *   each with an optional `buildsOn`,
 *   and lists hunk IDs per thread. Unknown IDs are dropped (reported in
 *   `dropped`), a hunk in two plotlines keeps the first, and hunks the
 *   reader leaves out read as "other" without storing anything.
 */
import { parseId } from "./ids.js";
import { truncateAtWordBoundary } from "./content/hunk.js";

/** Ordered interestingness levels, least to most interesting. */
export const HUNK_SCORE_LEVELS = ["mechanical", "routine", "substantive", "needs-attention"] as const;

/** One hunk's interestingness level. */
export type HunkScoreLevel = (typeof HUNK_SCORE_LEVELS)[number];

/** Display labels for the levels (sentence case per the copy rules). */
export const HUNK_SCORE_LABELS: Record<HunkScoreLevel, string> = {
  mechanical: "Mechanical",
  routine: "Routine",
  substantive: "Substantive",
  "needs-attention": "Needs attention",
};

/** Rank for ordering (Files list shows the file's highest level). */
export function hunkScoreRank(level: HunkScoreLevel): number {
  return HUNK_SCORE_LEVELS.indexOf(level);
}

/** Fallback when the agent sends no usable score: the safe middle. */
export const DEFAULT_HUNK_SCORE: HunkScoreLevel = "routine";

/**
 * Read one raw agent value as a score level. Accepts the four levels
 * (case-insensitive, "-" or " " before "attention"); anything else —
 * missing, wrong type, invented level — comes back null so the caller
 * can fall back instead of storing garbage.
 */
export function normalizeHunkScore(value: unknown): HunkScoreLevel | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
  return (HUNK_SCORE_LEVELS as readonly string[]).includes(slug) ? (slug as HunkScoreLevel) : null;
}

/**
 * How the score and the deterministic rules combine (single place, so
 * the hunk pass, on-demand summarize and tests agree):
 *
 * 1. An unusable agent value becomes "routine" (like "when unsure, it
 *    is interesting": a missing judgement reads as middle, never blank).
 * 2. A one-line change is never "mechanical" — a single changed line
 *    that does something is at least routine — so it reads as "routine".
 * 3. Everything else is stored as returned. Guide-cited hunks keep
 *    their score (the cite rule clears `hiddenReason`, never the score).
 */
export function resolveHunkScore(raw: HunkScoreLevel | null, opts: { isOneLine: boolean }): HunkScoreLevel {
  const level = raw ?? DEFAULT_HUNK_SCORE;
  if (opts.isOneLine && level === "mechanical") return "routine";
  return level;
}

/**
 * Issue #193: one PR/branch commit as plotline evidence. Ingest (#92)
 * already reads subjects and bodies; this adds the files each commit
 * touched and the PR hunks it overlaps, so the reader sees the author's
 * own threading before naming plotlines. Stored on the snapshot in
 * landing order (oldest first).
 */
export interface ReviewCommit {
  sha: string;
  subject: string;
  body: string;
  /** Changed paths (new-side), in diff order. */
  files: string[];
  /** Canonical `h:<fileKey>:<hash>` PR hunk IDs this commit touches. */
  hunks: string[];
}

// --- plotlines -------------------------------------------------------------

/** Most plotlines the reader may name (the rest are dropped, reported). */
export const MAX_PLOTLINES = 8;

/** Assignment id for hunks no plotline claims (never stored). */
export const PLOTLINE_OTHER_ID = "other";

/**
 * One thread of the change: a unit with its own purpose that could
 * land as a separate commit or stacked PR. Never a file type — tests,
 * docs and config belong to the thread they serve. Plotlines are
 * stored in landing order (foundations first).
 */
export interface Plotline {
  /** Short kebab-case id, unique within the review. */
  id: string;
  /** Short display name. */
  name: string;
  /** One line: what this step adds to the progression (issue #197). */
  description: string;
  /** Id of an earlier plotline this one builds on, when it depends on one. */
  buildsOn?: string;
}

/** Raw trailing-JSON shape the reader (or the assign step) sends. */
export interface RawPlotline {
  id?: string;
  name?: string;
  description?: string;
  buildsOn?: string;
  hunks?: string[];
}

export interface NormalizedPlotlines {
  plotlines: Plotline[];
  /** `h:<fileKey>:<hash>` → plotline id (first plotline wins). */
  assignment: Record<string, string>;
  dropped: {
    /** Hunk IDs that parse as nothing known (never stored). */
    unknown: string[];
    /** Hunk IDs claimed twice (kept under the first plotline). */
    duplicates: string[];
    /** Plotlines past the cap of 8. */
    extraPlotlines: number;
  };
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "plotline" : slug;
}

/**
 * Plotline text caps. They only guard against runaway reader output: real
 * names and one-line descriptions must arrive whole, because the guide
 * shows (and the reader copies) exactly what is stored. The old 40/140
 * caps cut ordinary names mid-phrase with "…".
 */
export const PLOTLINE_NAME_MAX = 120;
export const PLOTLINE_DESCRIPTION_MAX = 500;

function cleanLine(text: string, max: number): string {
  return truncateAtWordBoundary(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * Validate one reader plotline payload against the review's hunk IDs.
 * `known` holds the review's canonical `h:<fileKey>:<hash>` ids. Empty
 * input (the reader named none) is valid: every hunk reads as "other".
 */
export function normalizePlotlines(input: unknown, known: ReadonlySet<string>): NormalizedPlotlines {
  const empty: NormalizedPlotlines = {
    plotlines: [],
    assignment: {},
    dropped: { unknown: [], duplicates: [] as string[], extraPlotlines: 0 },
  };
  if (!Array.isArray(input)) return empty;
  const plotlines: Plotline[] = [];
  const assignment: Record<string, string> = {};
  const unknown: string[] = [];
  const duplicates: string[] = [];
  const seenIds = new Set<string>();
  let extraPlotlines = 0;
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? cleanLine(rec["name"], PLOTLINE_NAME_MAX) : "";
    if (name === "") continue;
    if (plotlines.length >= MAX_PLOTLINES) {
      extraPlotlines += 1;
      continue;
    }
    const wantId = typeof rec["id"] === "string" && rec["id"].trim() !== "" ? slugify(rec["id"]) : slugify(name);
    let id = wantId;
    for (let n = 2; seenIds.has(id); n++) id = `${wantId}-${n}`;
    seenIds.add(id);
    const description =
      typeof rec["description"] === "string" ? cleanLine(rec["description"], PLOTLINE_DESCRIPTION_MAX) : "";
    const buildsOnRaw = typeof rec["buildsOn"] === "string" && rec["buildsOn"].trim() !== "" ? slugify(rec["buildsOn"]) : undefined;
    const hunks = Array.isArray(rec["hunks"]) ? rec["hunks"] : [];
    for (const h of hunks) {
      if (typeof h !== "string") continue;
      const target = h.trim();
      const parsed = parseId(target);
      const canonical = parsed?.kind === "h" ? `h:${parsed.fileKey}:${parsed.contentHash}` : null;
      if (canonical === null || !known.has(canonical)) {
        unknown.push(target);
        continue;
      }
      if (assignment[canonical] !== undefined) {
        duplicates.push(target);
        continue;
      }
      assignment[canonical] = id;
    }
    plotlines.push({ id, name, description, ...(buildsOnRaw !== undefined ? { buildsOn: buildsOnRaw } : {}) });
  }
  // `buildsOn` must name another plotline in the same list (landing
  // order means it should be an earlier one, but any known id is kept);
  // unknown or self references are dropped, never stored dangling.
  for (const p of plotlines) {
    if (p.buildsOn !== undefined && (p.buildsOn === p.id || !seenIds.has(p.buildsOn))) delete p.buildsOn;
  }
  return { plotlines, assignment, dropped: { unknown, duplicates, extraPlotlines } };
}

// --- diff filter -------------------------------------------------------------

/**
 * The diff's score/plotline filter (one dropdown in the filter menu).
 * Absent fields mean "all". Applies at hunk level and composes with
 * every existing filter (Hide uninteresting, name, type, reviewed):
 * a hunk shows only when all of them pass, and files with no passing
 * hunk drop out. Unlike Hide uninteresting it is an explicit choice,
 * so it also applies to guide-cited hunks.
 */
export interface DiffFilter {
  /** Plotline id, or "other" for unassigned hunks. Absent = all. */
  plotline?: string;
  /** Score level. Absent = all. */
  score?: HunkScoreLevel;
}

/**
 * True when a hunk with this score/plotline passes the filter. The
 * score level is a floor, not an exact match: choosing a level shows
 * that level or higher. A hunk with no score yet (its pass has not
 * landed) matches any score, so pending work is never filtered away;
 * a hunk with no plotline reads as "other".
 */
export function hunkMatchesFilter(
  score: HunkScoreLevel | undefined,
  plotline: string | undefined,
  filter: DiffFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.score !== undefined && score !== undefined && hunkScoreRank(score) < hunkScoreRank(filter.score)) return false;
  if (filter.plotline !== undefined) {
    const have = plotline ?? PLOTLINE_OTHER_ID;
    if (have !== filter.plotline) return false;
  }
  return true;
}
