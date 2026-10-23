/**
 * Pure diff-pane logic (PRD §4.13), unit-tested in `diffLogic.test.ts`:
 * folder-tree compaction, hidden-run grouping, split-row pairing, file
 * filters, stats, `diff:` ref parsing, and guide-citation overlap.
 *
 * Rendering lives in `DiffView.tsx` / `FileSection.tsx`; behaviour matches
 * `prototype.html` (its code is a sketch — this is a port of behaviour and
 * class names, not code).
 */
import type { Annotation, Block, DiffFilter, Hunk, HunkLine, HunkScoreLevel, Page, ReviewFile } from "@unvibe/shared";
import { hunkMatchesFilter, hunkScoreRank, parseId } from "@unvibe/shared";

// --- folder tree ---------------------------------------------------------

export type TreeRow =
  | { type: "dir"; path: string; label: string; depth: number }
  | { type: "file"; file: ReviewFile; depth: number };

interface TreeNode {
  kids: Map<string, TreeNode>;
  files: ReviewFile[];
}

/**
 * Folder tree with single-child folder compaction (prototype `fileTree`):
 * a chain of single-child directories with no files renders as one
 * `a/b/c` row. Order follows the diff (insertion order): directories first,
 * then files, each in first-seen order — like the prototype.
 */
export function buildFileTree(files: ReviewFile[]): TreeRow[] {
  const root: TreeNode = { kids: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/").slice(0, -1);
    let node = root;
    for (const p of parts) {
      let kid = node.kids.get(p);
      if (!kid) {
        kid = { kids: new Map(), files: [] };
        node.kids.set(p, kid);
      }
      node = kid;
    }
    node.files.push(f);
  }
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, label: string, depth: number, path: string): void => {
    // Compact single-child chains.
    while (label && node.kids.size === 1 && node.files.length === 0) {
      const [[name, kid]] = [...node.kids.entries()];
      label += `/${name}`;
      path += `/${name}`;
      node = kid;
    }
    let d = depth;
    if (label) {
      rows.push({ type: "dir", path, label, depth });
      d++;
    }
    for (const [name, kid] of node.kids) {
      walk(kid, name, d, path ? `${path}/${name}` : name);
    }
    for (const f of node.files) rows.push({ type: "file", file: f, depth: d });
  };
  walk(root, "", 0, "");
  return rows;
}

/**
 * Split a `/`-joined label into a truncatable head and a kept tail
 * (issue #227): the head ellipsises, the last `tailSegments` segments
 * always stay readable, so a long directory chain shortens from the
 * middle instead of losing its end. A trailing slash is kept on the tail.
 */
export function tailPathParts(text: string, tailSegments = 2): { pre: string; end: string } {
  const trailing = text.endsWith("/") ? "/" : "";
  const segs = text.replace(/\/+$/, "").split("/").filter((s) => s.length > 0);
  if (segs.length <= tailSegments) return { pre: "", end: text };
  return {
    pre: `${segs.slice(0, segs.length - tailSegments).join("/")}/`,
    end: `${segs.slice(segs.length - tailSegments).join("/")}${trailing}`,
  };
}

// --- hidden-run grouping ---------------------------------------------------

export type HunkGroup = { type: "show"; index: number } | { type: "hidden"; indices: number[] };

/**
 * Group consecutive hidden hunks into runs (prototype `hunksHtml`): each run
 * renders as one thin "Hunks i–j hidden" row; everything else renders alone.
 */
export function groupHunks(
  hunks: Hunk[],
  isHidden: (hunk: Hunk, index: number) => boolean,
): HunkGroup[] {
  const out: HunkGroup[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      out.push({ type: "hidden", indices: run });
      run = [];
    }
  };
  hunks.forEach((h, i) => {
    if (isHidden(h, i)) run.push(i);
    else {
      flush();
      out.push({ type: "show", index: i });
    }
  });
  flush();
  return out;
}

// --- split-row pairing -----------------------------------------------------

export type SplitRow = { kind: "ctx"; line: HunkLine } | { kind: "pair"; left?: HunkLine; right?: HunkLine };

/**
 * Pair deletion/addition runs for split view (prototype `lineRows`): context
 * lines span both halves; a del-run followed by an add-run zips pairwise,
 * padding the shorter side with empty cells.
 */
export function pairSplitRows(lines: HunkLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "ctx") {
      out.push({ kind: "ctx", line: lines[i++] });
      continue;
    }
    const dels: HunkLine[] = [];
    const adds: HunkLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) out.push({ kind: "pair", left: dels[j], right: adds[j] });
  }
  return out;
}

// --- filters ---------------------------------------------------------------

export interface FileFilter {
  query: string;
  cats: ReadonlySet<string>;
  hideReviewed: boolean;
  reviewedCount: (file: ReviewFile) => number;
  /**
   * Issue #169: the score/plotline filter (one dropdown in the filter
   * menu, remembered with the review). A file stays only when at least
   * one of its hunks passes it; `hunkStateOf` reads the hunk's score and
   * plotline from the snapshot's hunk states.
   */
  plot?: DiffFilter;
  hunkStateOf?: (contentHash: string) => { score?: HunkScoreLevel; plotline?: string } | undefined;
  /**
   * Custom guides: canonical `h:` ids of the open guide's hunks. When
   * set, only those hunks show and files with none of them drop out.
   */
  scope?: ReadonlySet<string>;
}

/** Prototype `visibleFiles`: category chips + name filter + hide-reviewed. */
export function filterFiles(files: ReviewFile[], filter: FileFilter): ReviewFile[] {
  const q = filter.query.toLowerCase();
  return files.filter(
    (f) =>
      filter.cats.has(f.category) &&
      f.path.toLowerCase().includes(q) &&
      !(filter.hideReviewed && filter.reviewedCount(f) === f.hunks.length) &&
      (!filter.scope || f.hunks.some((h) => hunkInScope(f.fileKey, h, filter.scope))) &&
      (!filter.plot ||
        f.hunks.some((h) => hunkInScope(f.fileKey, h, filter.scope) && hunkPlotVisible(h, filter))),
  );
}

/** True when a hunk is in the open custom guide's scope (no scope = all). */
export function hunkInScope(fileKey: string, hunk: Pick<Hunk, "contentHash">, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(`h:${fileKey}:${hunk.contentHash}`);
}

/**
 * Hunk states as a custom guide reads them: the guide's own plotline
 * assignment replaces the main guide's (`plotline` absent = "other");
 * everything else (fold, reviewed, score) is shared. Hunks with no state
 * yet get a blank one when the guide assigns them a plotline.
 */
export function guideHunkStates<S extends { plotline?: string }>(
  files: readonly ReviewFile[],
  states: ReadonlyMap<string, S>,
  assignment: Readonly<Record<string, string>>,
  blank: (contentHash: string) => S,
): Map<string, S> {
  const out = new Map<string, S>();
  for (const [hash, st] of states) {
    const rest = { ...st };
    delete rest.plotline;
    out.set(hash, rest);
  }
  for (const f of files) {
    for (const h of f.hunks) {
      const plotline = assignment[`h:${f.fileKey}:${h.contentHash}`];
      if (plotline === undefined) continue;
      out.set(h.contentHash, { ...(out.get(h.contentHash) ?? blank(h.contentHash)), plotline });
    }
  }
  return out;
}

/** True when a hunk passes the score/plotline filter (absent = all pass). */
export function hunkPlotVisible(hunk: Hunk, filter: Pick<FileFilter, "plot" | "hunkStateOf">): boolean {
  if (!filter.plot || (filter.plot.plotline === undefined && filter.plot.score === undefined)) return true;
  const st = filter.hunkStateOf?.(hunk.contentHash);
  return hunkMatchesFilter(st?.score, st?.plotline, filter.plot);
}

/**
 * The file's highest hunk score (Files list dot). Hunks without a score
 * yet (their pass has not landed) carry no signal and are skipped;
 * undefined when no hunk in the file has one.
 */
export function fileTopScore(
  file: ReviewFile,
  hunkStateOf: (contentHash: string) => { score?: HunkScoreLevel } | undefined,
): HunkScoreLevel | undefined {
  let top: HunkScoreLevel | undefined;
  for (const h of file.hunks) {
    const score = hunkStateOf(h.contentHash)?.score;
    if (score === undefined) continue;
    if (top === undefined || hunkScoreRank(score) > hunkScoreRank(top)) top = score;
  }
  return top;
}

// --- stats -------------------------------------------------------------------

export function fileStats(file: ReviewFile): { added: number; removed: number } {
  return {
    added: file.hunks.reduce((s, h) => s + h.added, 0),
    removed: file.hunks.reduce((s, h) => s + h.removed, 0),
  };
}

export function hunkLabel(file: ReviewFile, index: number): string {
  const total = file.hunks.length;
  return index === -1 ? "" : `Hunk ${index + 1} of ${total}`;
}

export function hiddenRunLabel(file: ReviewFile, indices: number[]): string {
  const total = file.hunks.length;
  return indices.length === 1
    ? `Hunk ${indices[0] + 1} of ${total}`
    : `Hunks ${indices[0] + 1}–${indices[indices.length - 1] + 1} of ${total}`;
}

// --- reveal refs ---------------------------------------------------------------

export interface RevealTarget {
  fileKey: string;
  start?: number;
  end?: number;
}

/**
 * Parse a `diff:<fileKey>[:<line>[-<line>]]` ID (file-only, short and full
 * `@sha` forms). The shared `parseId` grammar requires a line range, so
 * file-only refs are parsed here instead of touching the shared contract.
 */
const DIFF_REF_RE = /^diff:([^:@]+)(?::(\d+)(?:-(\d+))?)?(?:@[0-9a-fA-F]{4,64})?$/;

export function parseDiffRef(ref: string): RevealTarget | null {
  if (!ref || ref.length > 1024) return null;
  const m = ref.match(DIFF_REF_RE);
  if (!m || !m[1]) return null;
  const start = m[2] !== undefined ? Number(m[2]) : undefined;
  const end = m[3] !== undefined ? Number(m[3]) : start;
  if (start !== undefined && (!Number.isSafeInteger(start) || start < 1)) return null;
  if (end !== undefined && (!Number.isSafeInteger(end) || end < (start as number))) return null;
  return { fileKey: m[1], start, end };
}

/** Does hunk `h` overlap new-side lines [start, end]? */
export function hunkOverlaps(h: Hunk, start: number, end: number): boolean {
  return start <= h.newEnd && end >= h.newStart;
}

// --- guide citations -----------------------------------------------------------

function blockCitations(blocks: Block[], out: string[]): void {
  for (const b of blocks) {
    for (const c of b.citations ?? []) out.push(c.target);
    if (b.type === "aside") blockCitations(b.inner, out);
  }
}

/**
 * Content hashes of hunks the guide cites (PRD §4.13: never hidden).
 * Reads `diff:` targets from every block citation; `h:` targets map
 * directly. Ranges resolve against new-side line ranges.
 */
export function citedHunkHashes(
  files: ReviewFile[],
  pages: Page[],
  annotations: Annotation[],
): Set<string> {
  const targets: string[] = [];
  for (const p of pages) for (const c of p.cards ?? []) blockCitations(c.blocks ?? [], targets);
  void annotations;
  const byKey = new Map(files.map((f) => [f.fileKey, f]));
  const out = new Set<string>();
  for (const t of targets) {
    const id = parseId(t);
    if (!id) continue;
    if (id.kind === "h") {
      out.add(id.contentHash);
    } else if (id.kind === "diff") {
      const f = byKey.get(id.fileKey);
      if (!f) continue;
      for (const h of f.hunks) {
        if (hunkOverlaps(h, id.start, id.end)) out.add(h.contentHash);
      }
    }
  }
  return out;
}

// --- hide decision ---------------------------------------------------------------

export interface HideDecision {
  hideUninteresting: boolean;
  /** User clicked "show" on this hunk's hidden row (transient, per session). */
  unhidden: boolean;
  /** The guide cites this hunk. */
  cited: boolean;
}

/**
 * A hunk hides only when Hide-uninteresting is on, it carries a
 * `hiddenReason` from the snapshot, the user hasn't revealed it, the guide
 * doesn't cite it — and it isn't a one-line change (PRD §4.13: one-line
 * changes are never hidden).
 */
export function shouldHideHunk(hunk: Hunk, d: HideDecision): boolean {
  if (!d.hideUninteresting || d.unhidden || d.cited) return false;
  if (!hunk.hiddenReason) return false;
  if (hunk.added + hunk.removed <= 1) return false;
  return true;
}

/** Fallback one-line "why it's skippable" copy per hidden reason. */
export function hiddenDetail(reason: string | undefined): string {
  switch (reason) {
    case "generated":
      return "Generated file; safe to skip.";
    case "docs / config":
      return "Docs or config changes; no code.";
    case "imports":
      return "Import-only changes.";
    default:
      return reason ?? "Uninteresting changes.";
  }
}
