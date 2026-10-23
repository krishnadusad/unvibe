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
  type ExistingReviewComment,
  type ReplyData,
  type ReviewCommit,
  type ReviewSnapshot,
} from "@unvibe/shared";
import { createSuggestedCommentInDraft } from "../comments/threads.js";
import type { GuideComment } from "./guideComments.js";

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

// --- suggestions -------------------------------------------------------------

/** Most hunk summaries sent to the suggestions prompt. */
const SUGGESTION_HUNK_LIMIT = 60;

/** Title plus the start of the description. */
export function renderSuggestionChange(snap: ReviewSnapshot): string {
  const title = snap.pages.find((p) => p.id === "root")?.title ?? snap.review.branch;
  const body = (snap.description?.baseMarkdown ?? "").trim();
  const excerpt = body.length > 1500 ? `${body.slice(0, 1500).trimEnd()}…` : body;
  return excerpt ? `${title}\n\n${excerpt}` : title;
}

/** One line per file: path, category, size of the change. */
export function renderSuggestionFiles(snap: ReviewSnapshot): string {
  if (snap.files.length === 0) return "(none)";
  return snap.files
    .map((f) => {
      const added = f.hunks.reduce((n, h) => n + h.added, 0);
      const removed = f.hunks.reduce((n, h) => n + h.removed, 0);
      return `- ${f.path} (${f.category}) +${added} −${removed}, ${f.hunks.length} hunk${f.hunks.length === 1 ? "" : "s"}`;
    })
    .join("\n");
}

/** The main guide's plotlines, one line each. */
export function renderSuggestionPlotlines(snap: ReviewSnapshot): string {
  const plotlines = snap.plotlines ?? [];
  if (plotlines.length === 0) return "(none yet)";
  return plotlines.map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ""}`).join("\n");
}

const SCORE_ORDER: Record<string, number> = { "needs-attention": 0, substantive: 1, routine: 2, mechanical: 3 };

/** Summarised hunks, most significant first, capped. */
export function renderSuggestionHunks(snap: ReviewSnapshot): string {
  const states = new Map(snap.hunkStates.map((s) => [s.contentHash, s]));
  const rows = snap.files.flatMap((f) =>
    f.hunks.flatMap((h) => {
      const st = states.get(h.contentHash);
      if (!st?.summary) return [];
      return [{ path: f.path, score: st.score ?? "routine", summary: st.summary }];
    }),
  );
  if (rows.length === 0) return "(no hunk summaries yet)";
  rows.sort((a, b) => (SCORE_ORDER[a.score] ?? 2) - (SCORE_ORDER[b.score] ?? 2));
  return rows
    .slice(0, SUGGESTION_HUNK_LIMIT)
    .map((r) => `- [${r.score}] ${r.path}: ${r.summary}`)
    .join("\n");
}

// --- existing GitHub comments ------------------------------------------------

/** Most comment threads, and characters per comment, sent to a guide. */
const GUIDE_COMMENT_THREADS_MAX = 60;
const GUIDE_COMMENT_CHARS_MAX = 2000;

/** Logins GitHub gives apps and bots. */
export function isBotLogin(login: string | undefined): boolean {
  return login !== undefined && /\[bot\]$|^(dependabot|renovate|github-actions|codecov)\b/i.test(login);
}

/** Stored inline comments (the menu's ingest-time fetch) as guide comments. */
export function guideCommentsFromStored(stored: readonly ExistingReviewComment[] | undefined): GuideComment[] | undefined {
  if (stored === undefined) return undefined;
  return stored.map((c) => ({
    id: c.id,
    kind: "inline" as const,
    body: c.body,
    ...(c.path !== undefined ? { path: c.path } : {}),
    ...(c.line !== undefined ? { line: c.line } : {}),
    ...(c.author !== undefined ? { author: c.author } : {}),
    ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
    ...(c.replyTo !== undefined ? { replyTo: c.replyTo } : {}),
  }));
}

const REVIEW_STATE: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "review dismissed",
};

/**
 * The PR's GitHub discussion as threads, oldest first: inline threads by
 * file and line (root, then replies), conversation comments and review
 * verdicts under "General". Each comment has author, date and full text;
 * bots are marked so a "human comments" request can leave them out.
 */
export function renderGuideGithubComments(comments: readonly GuideComment[] | undefined): string {
  if (comments === undefined) return "(not available: GitHub was unreachable, or this review is not a PR)";
  if (comments.length === 0) return "(nobody has commented on the PR yet)";
  const inline = comments.filter((c) => c.kind === "inline");
  const byId = new Map(inline.map((c) => [c.id, c]));
  const rootOf = (c: GuideComment): number => {
    let cur = c;
    for (let guard = 0; cur.replyTo !== undefined && byId.has(cur.replyTo) && guard < 50; guard++) cur = byId.get(cur.replyTo)!;
    return cur.id;
  };
  const threads = new Map<string, GuideComment[]>();
  for (const c of comments) {
    const key = c.kind === "inline" ? `i${rootOf(c)}` : `g${c.id}`;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  const time = (c: GuideComment): string => c.createdAt ?? "";
  const ordered = [...threads.values()]
    .map((t) => [...t].sort((a, b) => time(a).localeCompare(time(b))))
    .sort((a, b) => time(a[0]).localeCompare(time(b[0])));
  const out: string[] = [];
  for (const thread of ordered.slice(0, GUIDE_COMMENT_THREADS_MAX)) {
    const root = thread[0];
    const where =
      root.kind !== "inline"
        ? "General"
        : root.path !== undefined
          ? root.line !== undefined
            ? `${root.path}:${root.line}`
            : root.path
          : "General";
    out.push(`### ${where}`);
    for (const c of thread) {
      const who = c.author ?? "unknown";
      const what =
        c.kind === "review"
          ? ` · review: ${REVIEW_STATE[c.state ?? ""] ?? (c.state ?? "review").toLowerCase()}`
          : c !== root
            ? " · reply"
            : "";
      const body = c.body.trim();
      const text = body.length > GUIDE_COMMENT_CHARS_MAX ? `${body.slice(0, GUIDE_COMMENT_CHARS_MAX)}…` : body;
      out.push(`- ${who}${isBotLogin(c.author) ? " (bot)" : ""}${c.createdAt ? ` · ${c.createdAt}` : ""}${what}:`);
      out.push(...(text === "" ? ["  (no text)"] : text.split("\n").map((l) => `  > ${l}`)));
    }
    out.push("");
  }
  const rest = ordered.length - Math.min(ordered.length, GUIDE_COMMENT_THREADS_MAX);
  if (rest > 0) out.push(`(${rest} older threads not shown)`);
  return out.join("\n").trimEnd();
}
