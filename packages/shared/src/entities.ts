/**
 * Unvibe data model (PRD §7.1).
 *
 * Pure TypeScript: no Node or DOM APIs. Service persists these (SQLite +
 * per-review folders); web renders them. Nested shapes are stored as JSON
 * columns where noted in the service's migration 001.
 */
import type { SecondOpinionMode } from "./prompts.js";
import type { HunkScoreLevel } from "./scores.js";

/** A local checkout / GitHub repo the user can open reviews from. */
export interface Repo {
  id: string;
  owner: string;
  name: string;
  /** Absolute local path of the checkout. */
  localPath: string;
  /** Epoch ms of last open. */
  lastOpened: number;
  /**
   * True when this entry was auto-detected under a repo root rather than
   * explicitly added (M1 service addition; absent/false = remembered).
   */
  detected?: boolean;
  /**
   * #27: true when Unvibe cloned this checkout itself into
   * `<dataDir>/repos/<owner>/<name>`. Managed clones are refreshed
   * automatically (`git fetch` before listings/ingest) and their directory
   * is deleted when the repo is removed. Absent/false = the user's own
   * checkout, never fetched implicitly, never deleted.
   */
  managed?: boolean;
}

/**
 * Issue #222: what a review reviews. Never stored: the kind is derived
 * from the snapshot's shape (`isDocumentReview` in `api.ts`) — a review
 * whose snapshot carries the pasted document is a document review, and
 * every other review is a change review. There is no stored `kind`
 * field and no fallback read.
 */
export type ReviewKind = "change" | "document";

/** Issue #222: where a document review's context repo is read from. */
export type ContextRepoSource = "worktree" | "origin-main" | "local";

/**
 * Issue #222: one context repo of a document review, resolved at creation.
 * `repoPath` is the registered checkout (where git runs); `path` is the
 * effective reading location (the chosen worktree, or `repoPath` for
 * `origin-main`/`local`); `sha` is the commit read for `origin-main`
 * (absent for worktree/local, whose HEAD is read live).
 */
export interface ContextRepoRef {
  repoId: string;
  owner: string;
  name: string;
  source: ContextRepoSource;
  repoPath: string;
  path: string;
  /** Chosen worktree path (`source: "worktree"` only). */
  worktreePath?: string;
  /** Resolved commit at creation (`origin-main`, else the reading HEAD). */
  sha?: string;
  /** Human label shown in the UI and the agent context. */
  label: string;
}

/** One block of a pasted document (issue #222). Headings carry a level;
 * content blocks wrap the shared `Block` whose id is this block's id. */
export interface DocumentBlock {
  /** Paragraph block ID: `p1`, `p2`, … in document order (cited as `doc:pN`). */
  id: string;
  kind: "heading" | "content";
  /** Heading level 1–6 (`kind: "heading"` only). */
  level?: number;
  block: Block;
}

/** Issue #222: a pasted Markdown document (single version, no refresh). */
export interface DocumentContent {
  title: string;
  /** Pasted Markdown, verbatim. */
  markdown: string;
  blocks: DocumentBlock[];
}

/** One review of a branch or PR. */
export interface Review {
  id: string;
  repoId: string;
  branch: string;
  /** PR number, absent for branch-only reviews. */
  prNumber?: number;
  versions: Version[];
  currentVersion: number;
  createdAt: number;
}

/** One fetched state of the branch. */
export interface Version {
  n: number;
  headSha: string;
  mergeBaseSha: string;
  baseRef: string;
  fetchedAt: number;
  /**
   * Mapping of old IDs → new IDs carried from the previous version
   * (anchors remapped by content match, PRD §8).
   */
  idMapping: Record<string, string>;
}

export type FileCategory = "source" | "tests" | "docs" | "config" | "generated";

/** A changed file in a version's diff. */
export interface ReviewFile {
  /** Stable key within the review (derived deterministically from the path). */
  fileKey: string;
  path: string;
  category: FileCategory;
  hunks: Hunk[];
  /** Pre-rename path for renames (M1 service addition). */
  oldPath?: string;
  /** `git diff` status flags (M1 service additions). */
  isNew?: boolean;
  isDeleted?: boolean;
  isRename?: boolean;
  isBinary?: boolean;
}

/** One diff row: an added, deleted, or context line (M1 service addition). */
export interface HunkLine {
  kind: "add" | "del" | "ctx";
  /** Old-side line number (del/ctx rows). */
  oldLine?: number;
  /** New-side line number (add/ctx rows). */
  newLine?: number;
  /** Line content without the leading `+`/`-`/` ` marker. */
  text: string;
}

/** One hunk: git's own run of changed lines + ≤3 context lines (PRD §4.13). */
export interface Hunk {
  /** Stable content hash: ignores line numbers and whitespace (PRD §8). */
  contentHash: string;
  /** Raw `@@ … @@` header line. */
  header: string;
  /** Trailing context, e.g. function name. */
  context?: string;
  newStart: number;
  newEnd: number;
  oldStart: number;
  oldEnd: number;
  added: number;
  removed: number;
  /** Line rows in diff order (M1 service addition; always populated). */
  lines: HunkLine[];
  /** True when the hunk ends with "No newline at end of file". */
  noNewline?: boolean;
  /** Why "Hide uninteresting" hid this hunk, if it did. */
  hiddenReason?: string;
}

/** Per-hunk UI + agent state, keyed by content hash so it survives versions. */
export interface HunkState {
  contentHash: string;
  folded: boolean;
  reviewed: boolean;
  summary?: string;
  /**
   * Issue #169: the hunk pass's interestingness level (resolved against
   * the deterministic rules by `resolveHunkScore`). Absent until the
   * pass lands for this hunk.
   */
  score?: HunkScoreLevel;
  /**
   * Issue #169: the plotline id the reader assigned this hunk to.
   * Absent means "other" (no plotline claimed it).
   */
  plotline?: string;
  /**
   * M5 (PRD §8): true when the hunk's content changed in a newer version.
   * `reviewed` is cleared and `summary` needs regeneration
   * (`needsSummary`).
   */
  stale?: boolean;
  /** M5: summary should be regenerated by the update pass. */
  needsSummary?: boolean;
  /** M5: new-side content hash that superseded this hunk, when known. */
  supersededBy?: string;
}

/**
 * Per-file diff state (issue #162), keyed by file key so it survives
 * tab switches and reloads. A file's reviewed state is never stored:
 * it is derived from its hunks (reviewed exactly when all hunks are).
 */
export interface FileState {
  fileKey: string;
  folded: boolean;
}

/** `"guide"`: the root page of a custom guide (see customGuides.ts). */
export type PageKind = "root" | "concept" | "finding" | "opened-expansion" | "guide";

/** A guide page: root, concept, finding, or opened expansion. */
export interface Page {
  id: string;
  kind: PageKind;
  title: string;
  /** Parent page id for the breadcrumb trail; absent on root. */
  parent?: string;
  /**
   * Custom guide this page belongs to. Absent on main-guide pages; such
   * pages are left out of the main guide's context and update pass.
   */
  guideId?: string;
  /** Finding-only: confidence label shown as "Agent finding · <confidence>". */
  confidence?: string;
  /** Finding-only: one-line summary shown on the finding-ref card. */
  summary?: string;
  cards: Card[];
  /**
   * M5 (PRD §8): finding pages whose cited hunks changed are flagged for
   * recheck. `recheckStatus` is set by the update pass
   * (`still-applies` | `resolved` | `changed`); `pending` means refresh
   * flagged it but the update pass has not run yet.
   */
  needsRecheck?: boolean;
  recheckStatus?: "pending" | "still-applies" | "resolved" | "changed";
  recheckNote?: string;
}

export type DepthLevel = "simple" | "standard" | "deep";

/**
 * Issue #136: what depth, examples, diagram, undo and second opinion act
 * on — a page card's body or one answer (turn) of a conversation card.
 * Every unit carries its own `ans_…`/card id so none of those contracts
 * change shape when the unit is an answer.
 */
export interface ContentBody {
  /** Page-card id, or `ans_<12 hex>` for a conversation answer. */
  id: string;
  blocks: Block[];
  level: DepthLevel;
  /** Bumped on every accepted rewrite; references always mean latest. */
  revision: number;
  /** Undo stack of block snapshots (depth/examples/diagram changes). */
  undoStack: CardSnapshot[];
  /**
   * Second-opinion results attached to this unit, not part of its
   * revisable content. Depth changes and undo operate on `blocks` /
   * `level` / `undoStack` only, so these survive both. Keep one per
   * mode+model; re-running replaces the matching entry.
   */
  secondOpinions?: SecondOpinionResult[];
}

/** One card on a page. IDs stay stable across revisions (PRD §7.2). */
export interface Card extends ContentBody {
  pageId: string;
  /** Null when the reply carried no title; the UI shows the shared fallback (`content/titles.ts`, issue #49). */
  title: string | null;
  collapsed: boolean;
  /** Placeholder ("Go deeper") cards that still need generation. */
  pending?: PendingCard;
  /**
   * Go-deeper only (#217): the direction's why-line, kept when the card
   * is written automatically so the collapsed card still shows the
   * title and why-line, the way the placeholder looked.
   */
  why?: string;
  /**
   * M5 (PRD §8): true when one or more cited hunks changed. `staleHunks`
   * lists the affected new-side `h:` IDs; `staleChangedHunks` is the count
   * the UI shows ("2 cited hunks changed") beside the Update button.
   */
  stale?: boolean;
  staleChangedHunks?: number;
  staleHunks?: string[];
}

/**
 * M6 second opinion (PRD §4.10, §12).
 *
 * Additive-only: new entity carried on `ContentBody.secondOpinions`
 * (a page card or one conversation answer). The
 * reasoning body is stored as validated `Block[]` so citation markers
 * behave like all others (hover preview, click reveals). `missed` is the
 * trailing-JSON "anything the card missed" string. `SecondOpinionMode`
 * lives in `prompts.ts` (re-exported through the barrel); this module
 * imports it for the result shape without re-defining it.
 */
export type SecondOpinionVerdict = "agrees" | "partly" | "disagrees";

export interface SecondOpinionResult {
  /** Stable id: `so-<cardId>-<mode>-<provider>-<model>` (slugified). */
  id: string;
  cardId: string;
  mode: SecondOpinionMode;
  /** Second-opinion model that produced this result (label in the UI). */
  provider: string;
  model: string;
  /**
   * Thinking level the run used (issue #172), "" for the adapter default.
   * Part of the reuse identity: a changed effort re-runs.
   */
  effort: string;
  verdict: SecondOpinionVerdict;
  /** Reasoning text from the trailing JSON (plain text fallback). */
  reasoning: string;
  /** Validated reasoning blocks (citation markers render like all others). */
  blocks: Block[];
  /** Anything the card missed (trailing-JSON `missed`). */
  missed?: string;
  /** Review version the run executed against (dedupe + staleness). */
  version: number;
  createdAt: number;
  /** Job that produced this result (for usage / prompt-snapshot links). */
  jobId?: string;
}

/** Dedupe identity for a second-opinion request (PRD §12). */
export interface SecondOpinionDedupe {
  cardId: string;
  mode: SecondOpinionMode;
  provider: string;
  model: string;
  version: number;
}

/** A single undo entry: block list + depth level. No redo (PRD §4.4). */
export interface CardSnapshot {
  blocks: Block[];
  level: DepthLevel;
}

export interface PendingCard {
  label: string;
  why: string;
}

export type BlockType =
  | "paragraph"
  | "list"
  | "table"
  | "code"
  | "diagram"
  | "finding-link"
  | "comment-link"
  | "follow-up"
  | "aside";

/** Text variants per depth level (PRD §4.4). Standard is the stored default. */
export interface DepthText {
  simple?: string;
  standard: string;
  deep?: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  id: string;
  text: DepthText;
  citations: Citation[];
}

export interface ListItem {
  /** HTML/Markdown inline content of the item. */
  html: string;
  /** Per-item citations (prototype renders markers per list item). */
  citations: Citation[];
}

export interface ListBlock {
  type: "list";
  id: string;
  ordered: boolean;
  items: ListItem[];
  /** Block-level citations in addition to per-item ones. */
  citations: Citation[];
}

export interface TableBlock {
  type: "table";
  id: string;
  /** Raw HTML table (prototype renders `<table>` markup). */
  html: string;
  citations: Citation[];
}

export interface CodeBlock {
  type: "code";
  id: string;
  language?: string;
  code: string;
  citations: Citation[];
}

export type DiagramRenderStatus = "ok" | "unavailable" | "error";

export interface DiagramRenderState {
  /** Content hash of (canonicalised source + d2 version + render options). */
  hash: string;
  status: DiagramRenderStatus;
  error?: string;
}

export interface DiagramBlock {
  type: "diagram";
  id: string;
  /** D2 source text. */
  source: string;
  caption?: string;
  citations: Citation[];
  /** D2 render state (always set on stored blocks; absent pre-validation). */
  render?: DiagramRenderState;
}

/** Orange "Agent finding" reference card inside the guide. */
export interface FindingLinkBlock {
  type: "finding-link";
  id: string;
  pageId: string;
  citations: Citation[];
}

/**
 * Link from a finding page to the agent's suggested comment on a diff line
 * (PRD §4.9). Hover previews the thread, click jumps to it via revealSource.
 */
export interface CommentLinkBlock {
  type: "comment-link";
  id: string;
  /** Diff target, e.g. `diff:conn:82`. */
  diffRef: string;
  /** Thread id in `ReviewSnapshot.annotations` holding the suggested comment. */
  threadId: string;
  citations: Citation[];
}

export interface FollowUpItem {
  label: string;
  /** Pre-baked agent question this follow-up asks. */
  ask?: string;
}

export interface FollowUpBlock {
  type: "follow-up";
  id: string;
  items: FollowUpItem[];
  citations: Citation[];
}

/** Example / Diagram / Underlying-principle insert (prototype `gen-aside`). */
export interface AsideBlock {
  type: "aside";
  id: string;
  kind: "Example" | "Diagram" | "Underlying principle";
  /** Inner blocks rendered inside the aside. */
  inner: Block[];
  citations: Citation[];
}

export type Block =
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | CodeBlock
  | DiagramBlock
  | FindingLinkBlock
  | CommentLinkBlock
  | FollowUpBlock
  | AsideBlock;

/**
 * Issue #136: a conversation card (`"conversation"`) holds turns; a
 * comment (`"comment"`, reviewer-written, the only thing submitted)
 * holds messages; `"link"` is an opened-as-page card.
 */
export type AnnotationType = "conversation" | "comment" | "link";

/**
 * Issue #136 slice 2: one comment message. Comments never carry agent
 * replies (those live on conversation turns as blocks); `ai` appears
 * only for agent-drafted suggested comments not yet in the Outbox.
 */
export interface ChatMessage {
  who: "you" | "ai";
  /** Plain text. */
  text?: string;
  /** Agent-drafted suggested comment not yet in the Outbox. */
  suggested?: boolean;
  /**
   * Issue #181: this suggested message is an agent's open question,
   * offered as a suggested comment. Distinguishes question suggestions
   * from finding suggestions in the UI.
   */
  question?: boolean;
}

/**
 * Issue #136: one question and its answer inside a conversation card. The
 * answer is stored as blocks — the same unit as a guide card's body — so
 * depth, examples, diagram, undo and second opinion act on it through the
 * same lookup, keyed by the answer's own `ans_…` id.
 */
export interface Turn extends ContentBody {
  /**
   * The reader's question, or null for the default question (Explain).
   * Shown as the answer's heading for later turns; the card header shows
   * the selected text for the first.
   */
  question: string | null;
  /** Progress line while this turn's job runs (immediately visible working state). */
  working?: string | null;
  /** Retryable failure text (visible error state + retry path, PRD §4.8). */
  error?: string | null;
  /** Active job filling or rewriting this turn, when one is running. */
  jobId?: string;
}

/** A conversation card, comment, or opened-as-page link on an anchor. */
export interface Annotation {
  id: string;
  type: AnnotationType;
  anchor: Anchor;
  /** Open in place vs closed back to its marker/link. */
  open: boolean;
  /**
   * Issue #204 (revising #167): conversation cards open pinned inline
   * in the flow of the content; floating is only the hover peek on a
   * closed card's mark. Stored on the annotation so the pin survives a
   * reload; set at creation and when a mark reopens the card, through
   * the comment PATCH. There is no unpin. Required: no backward
   * compatibility.
   */
  pinned: boolean;
  /** Comments only: messages so far. */
  messages: ChatMessage[];
  /** Comments only: include in the Outbox (Submit review payload on PR reviews). */
  post: boolean;
  /**
   * Custom guide that suggested this comment. It shows only inside that
   * guide until the reader marks it for the PR (`post`).
   */
  guideId?: string;
  /** Comments only: editable draft of the text to post (Outbox view). */
  draft?: string;
  /** Unsent reply-box content (survives re-renders; comments and conversations). */
  reply?: string;
  /**
   * Issue #136: turns of a conversation card (type `"conversation"` only).
   * The first turn's question is null for Explain (the default question).
   */
  turns?: Turn[];
  /**
   * Issue #136: the card's one agent session, created on the first turn
   * and reused for every later turn. After a restart the session is
   * rebuilt from the stored turns.
   */
  sessionId?: string;
  /** Conversations only: collapsed to the title row. */
  collapsed?: boolean;
  /**
   * M4: progress line while an agent job works on this annotation
   * (explain fill, ask reply). Cleared when the job settles.
   */
  working?: string | null;
  /**
   * M4: retryable failure text (visible error state with a retry path,
   * never a spinner forever, PRD §4.8). Set on the thread/conversation
   * when its job errors; cleared on the next attempt.
   */
  error?: string | null;
  /** M4: active agent job for this annotation, when one is running. */
  jobId?: string;
  /**
   * M4: true when the anchor text can no longer be found in its host
   * (for example after a depth rewrite of the host card). The annotation
   * stays attached to the block; the UI shows the collapsed-card fallback
   * (PRD §4.7).
   */
  anchorStale?: boolean;
  /**
   * M4: page this annotation was promoted to ("Open as page", PRD §4.7).
   * The anchor becomes a link to that page; the annotation itself is
   * closed (type `"link"` on promotion, or kept with this pointer).
   */
  promotedToPage?: string;
  /**
   * Issue #152: when a conversation is opened as a page while a turn is
   * still filling (or has failed), the turns stay on the link annotation
   * as the fill's state owner and each moved turn maps to its page card.
   * The fill keeps running and mirrors finished blocks onto the mapped
   * card; the page resolves the working/error state through this mapping.
   * Turns are dropped once every mapped turn has settled successfully.
   */
  promotedTurns?: { turnId: string; cardId: string }[];
  /**
   * M5 (PRD §8): true when the anchored code changed and the quote could
   * not be re-found with confidence. The original snippet is kept in
   * `originalSnippet` and `successor` links to the best new-code guess.
   */
  outdated?: boolean;
  outdatedReason?: string;
  originalSnippet?: string;
  successor?: Anchor;
  /**
   * M6: posted marker set by Submit after the comment reaches GitHub.
   * Comments with `postedAt` set are never posted twice (double-submit
   * protection; retry after a partial failure skips them).
   */
  postedAt?: number;
  /** M6: GitHub review URL the thread was posted in. */
  postedUrl?: string;
  /**
   * Issue #181: this suggested comment is an agent's open question.
   * Links the suggestion to its contribution item, so dismissing the
   * suggestion marks that item dismissed (resolved) in the shared
   * context and the question is not raised again.
   */
  openQuestion?: {
    contributionId: string;
    itemIndex: number;
  };
}

/** Where an annotation is attached (PRD §7.1). */export type AnchorHost =
  /**
   * A guide block, stored `<card>#<block>` (block ids repeat across cards,
   * #78). The card part is a page-card id, or — for an annotation on text
   * inside a conversation answer (#116, #136) — the hosting answer's
   * `ans_…` id. Hosts nest by the same mechanism to any depth (an
   * annotation per level; every level stays in the flat annotation list).
   */
  | { kind: "block"; blockId: string }
  | { kind: "description"; paragraphId: string }
  | { kind: "diff-line"; fileKey: string; line: number; endLine?: number; side?: "LEFT" | "RIGHT" }
  /**
   * Issue #214: text inside a comment card (a suggested question, an
   * AI-suggested review comment, or a person's comment). The host is that
   * comment; its text is the host block for Ask/Explain.
   */
  | { kind: "comment"; commentId: string }
  /**
   * Issue #138: a hunk, addressed `h:<fileKey>:<contentHash>` (stable
   * across versions while the hunk's content is). Hosts the conversation
   * card an idle hunk summary activates into.
   */
  | { kind: "hunk"; fileKey: string; contentHash: string }
  /**
   * Issue #81: a file at a commit, addressed `code:<path>:<lines>@<sha>`
   * (the file tab). `line` is the first cited line; `endLine` the last
   * when the selection spans lines. Remapped by content on a new version
   * like every other code anchor (PRD §8).
   */
  | { kind: "code"; path: string; commit: string; line: number; endLine?: number };

/**
 * Issue #166: a live text selection as character offsets within its host's
 * plain text (`[start, end)`). Recorded by the client at the moment of
 * selection and stored on the anchor; placement prefers these over text
 * search.
 */
export interface SelectionOffsets {
  start: number;
  end: number;
}

export interface Anchor {
  host: AnchorHost;
  quotedText: string;
  prefix: string;
  suffix: string;
  /** Line/offset position at creation (best effort; rematch by content). */
  position: number;
  /** Version number the anchor was created against. */
  version: number;
  /**
   * Issue #166: character offsets of the selection within the host's
   * plain text at the moment of selection (`[startOffset, endOffset)`).
   * Present only on anchors created from a live text selection; the UI
   * places the mark at these offsets and falls back to the nearest text
   * match only when the host's text changed. Absent on older stored
   * anchors and on anchors that never came from a selection (ask-about,
   * follow-ups, hunk cards, suggestions) — those place by text match.
   */
  startOffset?: number;
  /** Issue #166: end of the recorded selection (see `startOffset`). */
  endOffset?: number;
  /**
   * M5 (PRD §8): the hunk content hash at creation, when the anchor sits
   * on diff code. Exact-hash hits remap by line shift without text search.
   */
  hunkHash?: string;
}

export type ContributionItemKind = "fact" | "correction" | "open_question" | "reader_note";

export interface ContributionItem {
  kind: ContributionItemKind;
  text: string;
  /** Corrections target `card:<id>#<block>`. */
  target?: string;
  citations: Citation[];
  /**
   * Issue #181: per-item resolution. Absent means active. A dismissed
   * open question stays stored (so re-raises dedupe against it) but is
   * filtered out of agent context.
   */
  status?: ContributionStatus;
}

export type ContributionStatus = "pending" | "accepted" | "dismissed" | "merged";

/** One automatic agent contribution appended to the shared log (PRD §9.5). */
export interface Contribution {
  id: string;
  sourceSession: string;
  /**
   * M5 shared context (PRD §9.5, §4.14 "Shared context"): the thread the
   * contribution came from, shown in the Settings view. Absent on pre-M5
   * snapshots and on contributions without a thread.
   */
  sourceThread?: string;
  items: ContributionItem[];
  /** ID of an earlier contribution this supersedes. */
  replaces?: string;
  status: ContributionStatus;
}

/** #224: normalised PR state for badges. Draft is a state of its own. */
export type PrState = "open" | "draft" | "merged" | "closed";

/** #224: normalised GitHub review decision for badges. #230: only approved
 * and changes_requested are ever shown — "review required" is dropped
 * entirely (never stored as a decision, never rendered). */
export type PrReviewDecision = "approved" | "changes_requested";

/** Map gh's `state` + `isDraft` onto {@link PrState}; undefined when unknown. */
export function prStateFromGh(state: unknown, isDraft: unknown): PrState | undefined {
  if (isDraft === true) return "draft";
  switch (typeof state === "string" ? state.toUpperCase() : "") {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

/**
 * Map gh's `reviewDecision` onto {@link PrReviewDecision}; undefined when
 * none. #230: `REVIEW_REQUIRED` maps to undefined — it is never shown.
 */
export function prReviewDecisionFromGh(value: unknown): PrReviewDecision | undefined {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    default:
      return undefined;
  }
}

/**
 * #230: the decision the UI shows for a PR.
 *
 * - `REVIEW_REQUIRED` (and empty/unknown) never shows — undefined.
 * - `APPROVED` always shows.
 * - `CHANGES_REQUESTED` shows unless the reviewer who requested changes
 *   has since been re-requested: when any `CHANGES_REQUESTED` author in
 *   `latestReviews` is currently in `reviewRequests` (user logins,
 *   case-insensitive), the decision is hidden (undefined) — GitHub keeps
 *   `reviewDecision: CHANGES_REQUESTED` after a re-request, but it reads
 *   wrong, so we show no decision at all.
 *
 * All inputs are gh-shaped unknowns (robust to missing/extra fields):
 * `reviewDecision` is gh's raw string, `reviewRequests` is gh's
 * `reviewRequests` array (user entries carry `login`), and
 * `latestReviews` is gh's `latestReviews` array (entries carry
 * `author.login` + `state`). When `latestReviews` is absent or names no
 * changes-requester, `CHANGES_REQUESTED` still shows.
 */
export function displayedReviewDecision(args: {
  reviewDecision?: unknown;
  reviewRequests?: unknown;
  latestReviews?: unknown;
}): PrReviewDecision | undefined {
  const mapped = prReviewDecisionFromGh(args.reviewDecision);
  if (mapped === undefined) return undefined;
  if (mapped === "approved") return "approved";
  const requested = new Set(reviewRequestLogins(args.reviewRequests).map((l) => l.toLowerCase()));
  if (requested.size === 0) return "changes_requested";
  for (const entry of latestReviewEntries(args.latestReviews)) {
    if (entry.state.toUpperCase() === "CHANGES_REQUESTED" && requested.has(entry.login.toLowerCase())) {
      return undefined;
    }
  }
  return "changes_requested";
}

/**
 * #230: user logins currently requesting review, from gh's
 * `reviewRequests` array (team entries carry `slug`/`name`, not `login`,
 * and are ignored). Accepts plain login strings too. Deduped
 * case-insensitively, order-stable.
 */
export function reviewRequestLogins(requests: unknown): string[] {
  const logins: string[] = [];
  if (typeof requests === "string") {
    if (requests !== "") logins.push(requests);
  } else if (Array.isArray(requests)) {
    for (const r of requests) {
      if (typeof r === "string") {
        if (r !== "") logins.push(r);
        continue;
      }
      if (typeof r === "object" && r !== null) {
        const login = (r as { login?: unknown }).login;
        if (typeof login === "string" && login !== "") logins.push(login);
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const login of logins) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/** #230: one parsed `latestReviews` entry (who + what they said). */
export interface LatestReviewEntry {
  login: string;
  state: string;
}

/**
 * #230: parse gh's `latestReviews` array into `{ login, state }` entries.
 * Accepts `author.login` (gh shape) plus `login`/`authorLogin` fallbacks;
 * entries missing either side are skipped.
 */
export function latestReviewEntries(reviews: unknown): LatestReviewEntry[] {
  if (!Array.isArray(reviews)) return [];
  const out: LatestReviewEntry[] = [];
  for (const r of reviews) {
    if (typeof r !== "object" || r === null) continue;
    const obj = r as Record<string, unknown>;
    let login = "";
    const author = obj["author"];
    if (typeof author === "string") login = author;
    else if (typeof author === "object" && author !== null) {
      const authorLogin = (author as { login?: unknown }).login;
      if (typeof authorLogin === "string") login = authorLogin;
    }
    if (!login && typeof obj["login"] === "string") login = obj["login"] as string;
    if (!login && typeof obj["authorLogin"] === "string") login = obj["authorLogin"] as string;
    const state = typeof obj["state"] === "string" ? (obj["state"] as string) : "";
    if (!login || !state) continue;
    out.push({ login, state });
  }
  return out;
}

/** PR description (or branch commit messages) as rendered HTML (M1 addition). */
export interface ReviewDescription {
  /** HTML with stable paragraph ids; `desc:<id>@<rev>` tokens resolve here. */
  html: string;
  /** Description revision the paragraph ids are stable against. */
  rev: string;
  /** PR body vs branch commit messages. */
  source: "pr" | "commits";
  /** Editable only when the user authors an open PR (PRD §4.11). */
  editable: boolean;
  /** PR author login for the author line. Absent on branches. */
  author?: string;
  /** gh PR state (OPEN/CLOSED/MERGED) for the author line. Absent on branches. */
  state?: string;
  /** #224: gh `isDraft` at ingest/refresh time. Absent on branches. */
  isDraft?: boolean;
  /** #224: normalised gh review decision at ingest/refresh time. Absent on branches. */
  reviewDecision?: PrReviewDecision;
  /**
   * "Restated →" mapping (PRD §4.11): description paragraph id → ids of
   * the guide blocks whose citations restate it. Derived from guide
   * citations of `desc:` ids; recomputed as the guide grows.
   */
  restated?: Record<string, string[]>;
  /**
   * M6: original PR body verbatim (for byte-for-byte round-trip of
   * unedited paragraphs, PRD §15). Absent on pre-M6 snapshots.
   */
  baseMarkdown?: string;
  /** M6: paragraph id → original Markdown source slice (verbatim). */
  paragraphSources?: Record<string, string>;
  /** M6: edited HTML awaiting submit (local only until Submit). */
  pendingHtml?: string;
  /** M6: edited Markdown converted from `pendingHtml`, awaiting submit. */
  pendingMarkdown?: string;
}

/**
 * M6: one existing PR review comment fetched read-only from GitHub
 * (`gh api repos/{o}/{r}/pulls/{n}/comments`, PRD §15). Never posted to;
 * the UI shows these alongside local threads.
 *
 * Issue #168: `bodyHtml` renders `body` with the shared untrusted-Markdown
 * renderer (raw HTML from GitHub never reaches the DOM); `replyTo` groups
 * replies under their root (`in_reply_to_id`).
 */
export interface ExistingReviewComment {
  id: number;
  path?: string;
  line?: number;
  side?: string;
  body: string;
  /** `body` rendered to safe HTML at fetch time (issue #168). */
  bodyHtml: string;
  /** Parent comment id for replies; absent on thread roots. */
  replyTo?: number;
  author?: string;
  createdAt?: string;
  htmlUrl?: string;
}

/**
 * Per-review diff view preferences (issue #168). Stored with the review.
 * The comments menu's "Already on GitHub" section follows
 * `showExistingComments` too: hidden collapses it to its heading with a
 * count; `existingCommentsCollapsed` folds the section while it is shown.
 */
export interface ReviewViewPrefs {
  /** Show existing GitHub comments in the diff. */
  showExistingComments: boolean;
  /** The comments menu's "Already on GitHub" section is collapsed. */
  existingCommentsCollapsed: boolean;
}

export type JobKind =
  | "reader"
  | "custom-guide"
  | "critic"
  | "hunk-pass"
  | "concept"
  | "ask"
  | "depth"
  | "examples"
  | "diagram"
  | "go-deeper"
  | "second-opinion"
  | "update-pass"
  | "summarize"
  | "plotline-assign"
  | "consolidate";

export type JobState = "queued" | "running" | "backing-off" | "done" | "error" | "cancelled";

/** Issue #160: one agent tool call recorded on its job. */
export interface JobToolCall {
  /** Tool name as reported by the adapter (e.g. "Bash", "Read", "WebFetch"). */
  name: string;
  /** Adapter tool-call id, when it sent one (correlates start and end, #207). */
  id?: string;
  /**
   * Best-effort argument detail (e.g. the shell command or URL), when the
   * adapter sent it with the call. Truncated by the service (with a
   * truncation marker naming the original length, #207).
   */
  detail?: string;
  /**
   * Issue #207: the tool's result text, truncated by the service with a
   * marker naming the original length. Absent when the adapter sent no
   * result (or the call has not ended yet).
   */
  result?: string;
  /** Issue #207: full length of the tool result before truncation. */
  resultOriginalLength?: number;
  /** Issue #194: epoch ms when the call started (Debug page timings). */
  startedAt?: number;
  /** Issue #207: epoch ms when the call ended, when an end was seen. */
  finishedAt?: number;
}

/**
 * Issue #207: one agent turn of a job, as sent and as answered — the
 * Debug page's Output view. Turns are in order (first, repair, retry,
 * follow-up, …) and match the segments of the job's `promptSnapshot`.
 * Text fields are capped by the service: a truncated value ends with a
 * marker naming the original length, also kept in the matching
 * `*OriginalLength` field. `rawUsage` is the adapter's usage payload
 * stored verbatim, next to the derived `usage` counts.
 */
export interface JobTurnRecord {
  /** Turn label from the pipeline ("first", "repair", …). */
  label: string;
  /** The exact prompt sent for this turn (capped; see above). */
  prompt?: string;
  /** Full length of this turn's prompt before truncation. */
  promptOriginalLength?: number;
  /** The reply text as streamed, before parsing (trailing JSON included). */
  output: string;
  /** Full length of the reply before truncation. */
  outputOriginalLength: number;
  /** Tool calls that ran during this turn, in the order they started. */
  tools: JobToolCall[];
  /** Derived per-turn token counts, when the runner reported usage. */
  usage?: TokenUsage;
  /** Raw usage payload exactly as the runner reported it (verbatim). */
  rawUsage?: unknown;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Issue #194: one timed step — an agent turn inside a job, or a non-agent
 * step of a refresh. `finishedAt` absent while the step is still running.
 */
export interface TimedStep {
  label: string;
  startedAt: number;
  finishedAt?: number;
}

/** Issue #194: one queue attempt of a job (initial run = attempt 1). */
export interface JobAttemptTiming {
  attempt: number;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Token usage for one turn or job (#125). Cache reads and writes are split:
 * `usage.inputTokens` counts UNCACHED input only, and the hit rate the app
 * shows is the read share `cachedRead/(input+cachedRead+cachedWrite)`.
 */
export interface TokenUsage {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
}

/** A unit of agent work in the priority queue (PRD §12). */
export interface Job {
  id: string;
  kind: JobKind;
  model: string;
  /** Provider the job runs on (per-provider concurrency cap, PRD §12). */
  provider?: string;
  /**
   * Thinking level the job ran with (issue #172): the role's effort
   * setting, "" when the adapter default was used.
   */
  effort: string;
  /** Review this job belongs to (for `GET /api/jobs?review=:id` + WS fan-out). */
  reviewId?: string;
  priority: number;
  state: JobState;
  sessionId?: string;
  /** Snapshot of the exact prompt sent (Settings links to it). */
  promptSnapshot?: string;
  /**
   * Issue #160: the agent-access posture this job was enqueued under
   * (`full` = full access on, `lockdown` = read-only lock-down). The
   * session itself keeps the posture it started with (see the base key);
   * this stamp says which variant the job expected.
   */
  accessMode?: import("./access.js").AccessMode;
  /**
   * Issue #160: tools the job's agent calls started, in order (capped by
   * the service). Shown on the Debug page. Names only unless the adapter
   * sent argument detail with the call.
   */
  tools?: JobToolCall[];
  /**
   * Issue #160: true when the post-job checkout check found the review's
   * worktree changed and reset it to the reviewed commit. Only set when
   * full access is on (the lock-down cannot change the checkout).
   */
  checkoutReset?: boolean;
  usage?: TokenUsage;
  /** Cache read share: cachedRead/(input+cachedRead+cachedWrite). input counts uncached input only (M0, #125). */
  cacheHitRate?: number;
  error?: string;
  /**
   * The agent's `degraded` reason for a turn whose usable answer was kept
   * anyway (the answer carries a plain-words note; the raw reason lives
   * here for the Debug page, never on the card).
   */
  degradedReason?: string;
  /**
   * The agent's reply text for a job that ended in `error` or
   * `cancelled` (issue #180): everything the turn streamed, kept so the
   * Debug page can show it next to the prompt and "why did this fail"
   * can be answered by reading it. Absent for successful jobs.
   */
  replySnapshot?: string;
  /**
   * Issue #207: per-turn records (prompt, streamed output, tool calls
   * with truncated results, derived + raw usage) for every job, in every
   * state — not only failures. Omitted from job lists; fetched per job
   * at `GET /api/jobs/:id/output`. Absent on jobs from before #207.
   */
  turnRecords?: JobTurnRecord[];
  /** Card this job works on, when card-scoped (depth/examples/diagram/generate). */
  cardId?: string;
  /**
   * Issue #136: annotation this job works on (conversation fill,
   * follow-up answer), when annotation-scoped. Lets the UI match
   * streamed `text` events to the card while it fills.
   */
  annotationId?: string;
  /** Latest human-readable progress line, shown on the card while running. */
  progress?: string;
  /**
   * Dedupe key (canonical `anchor|requestKind|depth|baseVersion`, see
   * `jobDedupeKeyString`): identical requests share one job/result (PRD §12).
   */
  dedupeKey?: string;
  /** Attempts so far (initial run = 1 once started). */
  attempts?: number;
  /** Epoch ms of the next retry while `backing-off`. */
  nextRetryAt?: number;
  /** Issue #194: epoch ms when the job was queued. */
  queuedAt?: number;
  /** Issue #194: epoch ms when the first attempt started running. */
  startedAt?: number;
  /** Issue #194: epoch ms when the job reached a terminal state. */
  finishedAt?: number;
  /** Issue #194: per-attempt timings (one entry per queue attempt). */
  attemptTimings?: JobAttemptTiming[];
  /** Issue #194: per-turn timings (first turn, repair turn, …). */
  turns?: TimedStep[];
}

/**
 * Priority bands for the job queue (PRD §12): what the user asked for first,
 * then what's visible on screen, then background work.
 */
export const JOB_PRIORITY = {
  userRequested: 100,
  visible: 50,
  background: 10,
} as const;

/**
 * Dedupe identity for a job (PRD §12): (anchor, kind of request, depth,
 * base version). Jobs with the same key share one job/result.
 */
export interface JobDedupeKey {
  anchor: string;
  requestKind: string;
  depth?: string;
  baseVersion: string;
}

/** Canonical string form of a {@link JobDedupeKey} (stored as `Job.dedupeKey`). */
export function jobDedupeKeyString(key: JobDedupeKey): string {
  return [key.anchor, key.requestKind, key.depth ?? "", key.baseVersion].join("|");
}

export type LogScope = { scope: "global" } | { scope: "card"; cardId: string };

/** One append-only log entry feeding the base + change lists (PRD §9.3). */
export interface LogEntry {
  seq: number;
  kind: string;
  payload: unknown;
  scope: LogScope;
}

/** A validated citation from a `[[…]]` token to review content. */
export interface Citation {
  /** Raw token target, e.g. `diff:conn:147-152@abc123`. */
  target: string;
  /** Whether validation failed (shown dimmed as unverified, PRD §4.5). */
  unverified?: boolean;
}

/** Citation display info for hover previews / jump-to-source. */
export interface CitationPreview {
  target: string;
  label: string;
  snippet: string;
}
