/**
 * Custom guides: a reader-prompted view over a subset of the change
 * ("what changed in today's commits", "since commit X", "security
 * review"), with its own sections, plotlines and suggested comments.
 *
 * A custom guide never touches the main guide: its pages carry
 * `guideId` and are left out of the main guide's context, citation
 * bookkeeping and update pass; its plotlines and hunk assignment live on
 * the guide, not on `hunkStates`; its suggested comments carry `guideId`
 * and stay inside the guide until the reader marks them for the PR
 * (`post`). Comments, asks, depth and the rest work on its cards through
 * the usual block anchors.
 *
 * The agent interprets the request itself (it gets every commit with
 * author and dates, plus the reader's local time). When the request is
 * ambiguous it asks one question instead of guessing; the reader's answer
 * is appended to `turns` and the guide is generated again.
 */
import type { Annotation, Page } from "./entities.js";
import { parseId } from "./ids.js";
import type { Plotline, ReviewCommit } from "./scores.js";

/** Longest request or answer the reader may send (characters). */
export const CUSTOM_GUIDE_PROMPT_MAX = 2000;

export type CustomGuideStatus =
  /** The agent asked a question (`question`); waiting for the reader's answer. */
  | "needs-input"
  /** A job is generating the guide (`jobId`). */
  | "working"
  | "ready"
  /** The last attempt failed (`error`); regenerate retries. */
  | "failed";

/** One message of the request conversation: the ask, questions, answers. */
export interface CustomGuideTurn {
  who: "you" | "agent";
  text: string;
  at: number;
}

export interface CustomGuide {
  /** `gd-<hex>`; unique within the review. */
  id: string;
  /** Agent-chosen title; the request excerpt until the first reply lands. */
  title: string;
  /** The reader's original request (also `turns[0]`). */
  prompt: string;
  /** Request, agent questions and reader answers, oldest first. */
  turns: CustomGuideTurn[];
  status: CustomGuideStatus;
  /** The agent's open question while `status` is "needs-input". */
  question?: string;
  /** Failure text while `status` is "failed". */
  error?: string;
  /** Job generating the guide while `status` is "working". */
  jobId?: string;
  /** The guide's root page (`customGuidePageId(id)`). */
  pageId: string;
  /** Commits the agent scoped the guide to (full SHAs, landing order). */
  commits: string[];
  /** Canonical `h:` ids the guide covers, in diff order. */
  hunks: string[];
  /** One line from the agent: what the guide includes and why. */
  scopeNote?: string;
  plotlines: Plotline[];
  /** `h:` id → plotline id (first plotline wins; others read as "other"). */
  assignment: Record<string, string>;
  /** Review version the guide was generated against. */
  version: number;
  /** True once the review moved past `version`: shown with Regenerate. */
  stale?: boolean;
  createdAt: number;
}

/** Root page id of a custom guide. */
export function customGuidePageId(guideId: string): string {
  return `gp-${guideId}`;
}

/** Card id for a custom guide's n-th section (unique across the review). */
export function customGuideCardId(guideId: string, n: number): string {
  return `gc-${guideId}-${n}`;
}

/** True for pages that belong to a custom guide (never the main guide). */
export function isCustomGuidePage(page: Pick<Page, "guideId">): boolean {
  return typeof page.guideId === "string" && page.guideId !== "";
}

/**
 * Whether an annotation shows outside its guide. A custom guide's
 * suggested comments stay on the guide until marked for the PR (`post`);
 * everything else (and anything already marked) shows everywhere. Inside
 * a guide (`activeGuideId`) that guide's own comments show too.
 */
export function annotationVisibleIn(
  annotation: Pick<Annotation, "guideId" | "post">,
  activeGuideId: string | null | undefined,
): boolean {
  if (!annotation.guideId) return true;
  if (annotation.post) return true;
  return annotation.guideId === activeGuideId;
}

/**
 * Resolve the hunks a guide covers from the agent's reply. Commit
 * references match a commit SHA by prefix (at least 7 characters) and
 * contribute that commit's hunks; explicit `h:` ids and every hunk named
 * by a plotline are added too. Unknown hunks and commits are dropped and
 * reported. Output hunks are in `knownInOrder` (diff) order.
 */
export function resolveCustomGuideScope(input: {
  commits: readonly ReviewCommit[];
  knownInOrder: readonly string[];
  commitRefs: unknown;
  hunkRefs: unknown;
  plotlineHunks: readonly string[];
}): { commits: string[]; hunks: string[]; unknownCommits: string[]; unknownHunks: string[] } {
  const known = new Set(input.knownInOrder);
  const picked = new Set<string>();
  const commits: string[] = [];
  const unknownCommits: string[] = [];
  const unknownHunks: string[] = [];
  for (const ref of Array.isArray(input.commitRefs) ? input.commitRefs : []) {
    if (typeof ref !== "string") continue;
    const want = ref.trim().toLowerCase();
    const hit =
      want.length >= 7 ? input.commits.find((c) => c.sha.toLowerCase().startsWith(want)) : undefined;
    if (!hit) {
      unknownCommits.push(ref);
      continue;
    }
    if (commits.includes(hit.sha)) continue;
    commits.push(hit.sha);
    for (const h of hit.hunks) if (known.has(h)) picked.add(h);
  }
  const addHunk = (ref: unknown): void => {
    if (typeof ref !== "string") return;
    const parsed = parseId(ref.trim());
    const canonical = parsed?.kind === "h" ? `h:${parsed.fileKey}:${parsed.contentHash}` : null;
    if (canonical && known.has(canonical)) picked.add(canonical);
    else unknownHunks.push(ref);
  };
  for (const ref of Array.isArray(input.hunkRefs) ? input.hunkRefs : []) addHunk(ref);
  for (const ref of input.plotlineHunks) addHunk(ref);
  // Landing order for commits, diff order for hunks.
  const order = new Map(input.commits.map((c, i) => [c.sha, i]));
  commits.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return {
    commits,
    hunks: input.knownInOrder.filter((h) => picked.has(h)),
    unknownCommits,
    unknownHunks,
  };
}

/** Readable fallback title from the request (first line, trimmed). */
export function customGuideFallbackTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || "Custom guide";
}

/**
 * Guide ideas for this change, offered as buttons in the New guide box.
 * Written by a small-model job the first time the box opens for a
 * version (`POST /api/reviews/:id/guides/suggestions`), then reused.
 */
export interface CustomGuideSuggestion {
  /** Button text, a few words ("Today's commits", "Auth checks"). */
  label: string;
  /** The request the button fills in. */
  prompt: string;
}

export interface CustomGuideSuggestions {
  /** Review version the ideas were written for. */
  version: number;
  status: "working" | "ready" | "failed";
  items: CustomGuideSuggestion[];
  jobId?: string;
}

/** Most suggestions kept from one reply. */
export const CUSTOM_GUIDE_MAX_SUGGESTIONS = 5;

/** Valid suggestions from a reply's `suggestions` field, trimmed and capped. */
export function normalizeGuideSuggestions(raw: unknown): CustomGuideSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomGuideSuggestion[] = [];
  for (const item of raw) {
    const r = item as { label?: unknown; prompt?: unknown } | null;
    if (typeof r?.label !== "string" || typeof r.prompt !== "string") continue;
    const label = r.label.replace(/\s+/g, " ").trim().slice(0, 40);
    const prompt = r.prompt.replace(/\s+/g, " ").trim().slice(0, CUSTOM_GUIDE_PROMPT_MAX);
    if (label === "" || prompt === "" || out.some((s) => s.label === label)) continue;
    out.push({ label, prompt });
    if (out.length >= CUSTOM_GUIDE_MAX_SUGGESTIONS) break;
  }
  return out;
}

// --- API ---------------------------------------------------------------------

/** POST /api/reviews/:id/guides */
export interface CreateCustomGuideRequest {
  prompt: string;
}

/** POST /api/reviews/:id/guides/:guideId/answer */
export interface AnswerCustomGuideRequest {
  answer: string;
}

/** Response of create, answer and regenerate. */
export interface CustomGuideResponse {
  guide: CustomGuide;
  jobId?: string;
}
