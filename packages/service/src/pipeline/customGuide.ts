/**
 * Custom guides (see packages/shared/src/customGuides.ts): prompt
 * variables for `prompts/custom_guide.md` and the pure apply step that
 * writes a finished reply into the guide, its root page and its
 * suggested comments. The job itself runs through `Pipeline.runInFork`
 * (`Pipeline.runCustomGuide`), forked from the review's base session.
 */
import type { WritableDraft } from "immer";
import {
  customGuideCardId,
  customGuideFallbackTitle,
  customGuidePageId,
  normalizePlotlines,
  parseId,
  resolveCustomGuideScope,
  type Block,
  type CustomGuide,
  type ReplyData,
  type ReviewCommit,
  type ReviewSnapshot,
} from "@unvibe/shared";
import { createSuggestedCommentInDraft } from "../comments/threads.js";

/** Most suggested comments one guide reply may add. */
export const CUSTOM_GUIDE_MAX_COMMENTS = 5;

/** The request conversation as the prompt shows it. */
export function renderGuideRequest(guide: Pick<CustomGuide, "turns">): string {
  return guide.turns
    .map((t, i) => (i === 0 ? t.text : `${t.who === "you" ? "Reader" : "You asked"}: ${t.text}`))
    .join("\n\n");
}

/** The reader's local clock and timezone (the service runs on their machine). */
export function renderGuideClock(now: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const local = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${local} (${tz}; ISO ${now.toISOString()})`;
}

/** One line per commit, oldest first, with author and both dates. */
export function renderGuideCommits(commits: readonly ReviewCommit[]): string {
  if (commits.length === 0) return "(no commit list for this review: judge from the diff alone)";
  return commits
    .map(
      (c) =>
        `- ${c.sha.slice(0, 10)} · ${c.author || "unknown author"} · authored ${c.authorDate || "?"} · ` +
        `committed ${c.committerDate || "?"} · ${c.subject || "(no subject)"} · ${c.hunks.length} hunk${c.hunks.length === 1 ? "" : "s"}`,
    )
    .join("\n");
}

/** The clarifying question in a reply, when the reply is only a question. */
export function guideClarifyQuestion(data: ReplyData | null, cardCount: number): string | null {
  const q = data?.["clarify"];
  if (cardCount > 0 || typeof q !== "string") return null;
  const trimmed = q.trim();
  return trimmed === "" ? null : trimmed.slice(0, 1000);
}

/**
 * Write a finished reply into the guide: scope, plotlines, root page
 * cards and suggested comments. Earlier suggestions from this guide that
 * the reader has not marked for the PR are replaced; marked or posted ones
 * stay.
 */
export function applyCustomGuideReply(
  draft: WritableDraft<ReviewSnapshot>,
  before: ReviewSnapshot,
  guideId: string,
  reply: {
    cards: { title: string | null; blocks: Block[] }[];
    data: ReplyData | null;
    lineText: (fileKey: string, line: number) => string;
    canonicalFileKey: (fileKey: string) => string;
  },
): void {
  const guide = draft.guides?.find((g) => g.id === guideId);
  if (!guide) return;
  const data = reply.data ?? {};
  const knownInOrder = draft.files.flatMap((f) => f.hunks.map((h) => `h:${f.fileKey}:${h.contentHash}`));
  const rawPlotlines = Array.isArray(data["plotlines"]) ? (data["plotlines"] as unknown[]) : [];
  const plotlineHunks = rawPlotlines.flatMap((p) => {
    const hunks = (p as { hunks?: unknown } | null)?.hunks;
    return Array.isArray(hunks) ? hunks.filter((h): h is string => typeof h === "string") : [];
  });
  const scopeIn = (data["scope"] ?? {}) as { commits?: unknown; hunks?: unknown };
  const scope = resolveCustomGuideScope({
    commits: draft.commits ?? [],
    knownInOrder,
    commitRefs: scopeIn.commits,
    hunkRefs: scopeIn.hunks,
    plotlineHunks,
  });
  const plotted = normalizePlotlines(rawPlotlines, new Set(scope.hunks));
  const title =
    typeof data["title"] === "string" && data["title"].trim() !== ""
      ? data["title"].replace(/\s+/g, " ").trim().slice(0, 120)
      : customGuideFallbackTitle(guide.prompt);
  const scopeNote =
    typeof data["scopeNote"] === "string" && data["scopeNote"].trim() !== ""
      ? data["scopeNote"].replace(/\s+/g, " ").trim().slice(0, 400)
      : undefined;

  guide.title = title;
  guide.commits = scope.commits;
  guide.hunks = scope.hunks;
  guide.plotlines = plotted.plotlines;
  guide.assignment = plotted.assignment;
  if (scopeNote) guide.scopeNote = scopeNote;
  else delete guide.scopeNote;
  guide.version = draft.version.n;
  guide.status = "ready";
  delete guide.stale;
  delete guide.question;
  delete guide.error;
  delete guide.jobId;

  writeGuidePage(draft, guide, reply.cards);

  // Suggested comments: replace this guide's unmarked ones.
  draft.annotations = draft.annotations.filter(
    (a) => a.guideId !== guideId || a.post || a.postedAt !== undefined,
  );
  const rawComments = Array.isArray(data["comments"]) ? (data["comments"] as unknown[]) : [];
  for (const raw of rawComments.slice(0, CUSTOM_GUIDE_MAX_COMMENTS)) {
    const c = raw as { diff?: unknown; text?: unknown } | null;
    if (typeof c?.diff !== "string" || typeof c.text !== "string" || c.text.trim() === "") continue;
    const parsed = parseId(c.diff.trim());
    if (parsed?.kind !== "diff") continue;
    const fileKey = reply.canonicalFileKey(parsed.fileKey);
    try {
      const thread = createSuggestedCommentInDraft(draft, before, {
        anchor: { where: "diff-line", fileKey, line: parsed.start },
        quote: reply.lineText(fileKey, parsed.start),
        suggestionText: c.text.trim(),
      });
      const stored = draft.annotations.find((a) => a.id === thread.id);
      if (stored) stored.guideId = guideId;
    } catch {
      // Unknown file or line: keep the guide, skip this suggestion.
    }
  }
}

/**
 * Upsert the guide's root page with these cards (stable ids by position).
 * Used for streamed partials and the final reply alike.
 */
export function writeGuidePage(
  draft: WritableDraft<ReviewSnapshot>,
  guide: Pick<CustomGuide, "id" | "title">,
  cards: { title: string | null; blocks: Block[] }[],
): void {
  const pageId = customGuidePageId(guide.id);
  let page = draft.pages.find((p) => p.id === pageId);
  if (!page) {
    page = { id: pageId, kind: "guide", title: guide.title, guideId: guide.id, cards: [] };
    draft.pages.push(page);
  }
  page.title = guide.title;
  const previous = new Map(page.cards.map((c) => [c.id, c]));
  page.cards = cards.map((c, i) => {
    const id = customGuideCardId(guide.id, i + 1);
    return {
      id,
      pageId,
      title: c.title,
      level: "standard",
      collapsed: false,
      revision: (previous.get(id)?.revision ?? 0) + 1,
      blocks: c.blocks,
      undoStack: [],
    };
  });
}

/** Drop the guide's root and child pages. */
export function removeGuidePages(draft: WritableDraft<ReviewSnapshot>, guideId: string): void {
  draft.pages = draft.pages.filter((p) => p.guideId !== guideId);
}
