/**
 * API contract (PRD §14.1). Service and web both import these types;
 * change the contract here first (AGENTS.md).
 *
 * Auth: every HTTP and WS request carries the per-install token as
 * `Authorization: Bearer <token>` or `?token=`. Only `/api/health` is
 * unauthenticated.
 */
import type {
  Annotation,
  Card,
  ContextRepoRef,
  ContextRepoSource,
  Contribution,
  DepthLevel,
  DocumentContent,
  ExistingReviewComment,
  FileState,
  HunkState,
  PrReviewDecision,
  PrState,
  ReviewKind,
  ReviewViewPrefs,
  Job,
  LogEntry,
  Page,
  Review,
  ReviewDescription,
  ReviewFile,
  Repo,
  SelectionOffsets,
  Version,
} from "./entities.js";
import type { DiffFilter, HunkScoreLevel, Plotline, ReviewCommit } from "./scores.js";
import type { CustomGuide } from "./customGuides.js";

/** Health is the only unauthenticated route. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  /**
   * Running build's identity for the version picker (issue #36, step 2).
   * Null/absent when the build carries no preview metadata (plain release
   * / dev / unwired installs).
   */
  build?: UpdateBuildInfo | null;
}

/**
 * M6: `GET /api/viewer` — the GitHub login behind `gh` (`gh api user`),
 * cached server-side. The Submit panel says "Submit as <user>" and the
 * description tab applies the "author + open PR" rule with it.
 */
export interface ViewerResponse {
  /** GitHub login, or null when `gh` is not logged in. */
  login: string | null;
}

// --- repos ---------------------------------------------------------------

export interface ReposResponse {
  repos: Repo[];
}

/**
 * Add a repo (#27): exactly one of `path` / `url`.
 * - `path`: absolute local path of an existing checkout (unchanged M1 shape).
 * - `url`: GitHub repo URL, bare `owner/name`, or PR URL — Unvibe clones
 *   into its own storage (`<dataDir>/repos/<owner>/<name>`) and remembers
 *   it marked `managed`. See `repos.ts` for the accepted forms.
 */
export interface AddRepoRequest {
  /** Absolute local path of the checkout. */
  path?: string;
  /** GitHub repo URL, `owner/name`, or PR URL (managed clone). */
  url?: string;
}

/**
 * `POST /api/repos` response: the full list (like `GET /api/repos`) plus
 * the PR number when the request added via a PR URL, for the later web
 * step (paste-PR-offers-to-add then opens the PR).
 */
export interface AddRepoResponse extends ReposResponse {
  prNumber?: number;
}

/**
 * `DELETE /api/repos/:id` response (#27): the repo is forgotten; the local
 * clone is removed only for repos Unvibe cloned (`managed`). Refused (409)
 * while the repo still has reviews — delete those first, never orphaned.
 */
export interface RemoveRepoResponse {
  ok: true;
  /** True when a managed clone directory was removed from the data dir. */
  removedClone: boolean;
}

/**
 * `POST /api/reset` (#79): every review and everything generated for it is
 * removed from this machine. Settings and repos stay. Refused (409) while a
 * review is being submitted.
 */
export interface ResetDataResponse {
  ok: true;
  reviewsRemoved: number;
}

/**
 * `POST /api/repos/pick-folder` (#26): ask the service to open a native
 * "choose folder" dialog on the user's own machine and report what
 * happened. No request body. A browser folder picker cannot supply an
 * absolute path, so the dialog runs service-side (macOS `osascript`,
 * Linux `zenity`/`kdialog`); the caller still adds the chosen path through
 * `POST /api/repos`, which validates it as a git checkout.
 */
export type PickFolderResponse =
  /** The user chose a folder: absolute path, trailing newline/slash trimmed. */
  | { status: "picked"; path: string }
  /** The user dismissed the dialog: the caller does nothing. */
  | { status: "cancelled" }
  /**
   * No dialog could be opened (no tool, no display, other platform):
   * `reason` is short human-readable copy the UI shows inline so the user
   * falls back to typing the path.
   */
  | { status: "unavailable"; reason: string };

export type ChangesFilter = "authoring" | "review-requested" | "branches" | "recent" | "all";

export interface RepoChange {
  kind: "pr" | "branch" | "review" | "demo";
  title: string;
  prNumber?: number;
  branch?: string;
  author?: string;
  updatedAt?: number;
  /**
   * #94: PR page URL as returned by `gh` (the row's preferred link
   * target; the start page falls back to building it from the repo and
   * number). Absent when unknown (rows stored before this change).
   */
  url?: string;
  /**
   * #100: diff size from `gh pr list --json
   * additions,deletions,changedFiles`. Each absent when unknown; the row
   * omits the size then.
   */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /**
   * #95: which review request a "review-requested" row answers — a request
   * made of you by name ("direct") or only of a team you belong to
   * ("team"). Absent on other rows and on rows stored before this change
   * (the start page shows those under "Requested of you").
   */
  /** #224: normalised PR state from gh (`state` + `isDraft`). Absent on branch rows. */
  prState?: PrState;
  /** #224: normalised review decision from gh. Absent when none/unknown. */
  reviewDecision?: PrReviewDecision;
  reviewScope?: "direct" | "team";
  /**
   * #95: team slugs (or names) from `gh`'s `reviewRequests` that asked for
   * the review. Shown on team-requested rows when cheap; absent when there
   * are none or the source did not say.
   */
  requestedTeams?: string[];
  /**
   * Set for kind "review": the opened review's id (M1 service addition).
   * #149: also set for kind "pr"/"branch" when that row already has a
   * review (same repo + PR number, or same repo + branch-only review) —
   * the row opens that review instead of starting a new one.
   */
  reviewId?: string;
  /**
   * Set for kind "review": head moved since the review was fetched.
   * #149: also set for kind "pr"/"branch" alongside `reviewId` when the
   * linked review has new commits waiting.
   */
  stale?: boolean;
  /** Set for kind "demo": fixture name, e.g. "urllib3-5020" (M3 pipeline). */
  demo?: string;
}

export interface RepoChangesResponse {
  changes: RepoChange[];
  /**
   * #27: set when a managed clone's refresh fetch failed (offline,
   * logged-out `gh`). The listing still succeeds on stale data; the UI
   * shows this note instead of failing.
   */
  fetchError?: string;
}

// --- reviews -------------------------------------------------------------

/**
 * Issue #222: `POST /api/reviews` with `kind: "document"` — a pasted
 * Markdown document plus any number of context repos. Each context repo names its
 * registered repo and where to read it: a particular worktree
 * (`source: "worktree"` with `worktreePath`), `origin/main`, or the
 * local copy. Answered synchronously with the ready snapshot (201);
 * nothing is generated up front.
 */
export interface CreateDocumentRequest {
  kind: "document";
  /** Pasted Markdown (required, non-empty). */
  markdown: string;
  /** Display title; defaults to the document's first heading. */
  title?: string;
  contextRepos: { repoId: string; source: ContextRepoSource; worktreePath?: string }[];
}

/** Issue #222: one worktree of a repo, for the context-repo picker. */
export interface RepoWorktree {
  path: string;
  /** Branch checked out there, when any. */
  branch?: string;
  /** HEAD commit there. */
  head?: string;
}

/** `GET /api/repos/:id/worktrees` (issue #222). */
export interface RepoWorktreesResponse {
  worktrees: RepoWorktree[];
  /** `origin/main` commit, when the ref exists. */
  originMainSha?: string;
  /** The local copy's HEAD commit. */
  localSha?: string;
}

export interface CreateReviewRequest {
  repoId: string;
  pr?: number;
  branch?: string;
  /**
   * M3 demo mode: when true (or a fixture name), ingest the bundled
   * `fixtures/urllib3-5020/` diff + description instead of git/gh, and run
   * the same pipeline code path against the replay recordings. `repoId`
   * may be `"demo"`; the demo repo is synthetic and needs no checkout.
   */
  demo?: boolean | string;
  /**
   * #92: PR title/number/author already known from the start-page list row.
   * Passed so the loading review shows them from the first moment; the
   * first ingest step then confirms them from `gh pr view`.
   */
  title?: string;
  author?: string;
}

/**
 * #92: ingest state for async open. A loading review's snapshot has no
 * `version`, `files` or `description` yet — callers must check `ingest`
 * first. Only a step name, no progress protocol.
 */
export interface IngestStatus {
  status: "ready" | "loading" | "failed" | "empty";
  /** What is being done while loading: "fetching" | "reading diff". */
  step?: string;
  /** Failure text when status is "failed"; the friendly message when "empty" (#179). */
  error?: string;
}

/** #92: ingest status of a snapshot. */
export function ingestStatusOf(snap: Pick<ReviewSnapshot, "ingest"> | null | undefined): IngestStatus["status"] {
  return snap?.ingest?.status ?? "ready";
}

/** #92: true when the ingest has landed. */
export function isReadySnapshot(snap: ReviewSnapshot): boolean {
  if (ingestStatusOf(snap) !== "ready") return false;
  // Placeholder versions (n: 0, from loading rows) are not ready.
  return snap.version.n >= 1;
}

/**
 * #92: throw a plain error when the snapshot is not ready (routes map it
 * to 409; internal callers only run after the ingest, so it never fires).
 */
export function assertReadySnapshot(snap: ReviewSnapshot): void {
  if (isReadySnapshot(snap)) return;
  const st = ingestStatusOf(snap);
  if (st === "loading") throw new Error("the review is still opening");
  if (st === "failed") throw new Error(snap.ingest?.error ?? "the review couldn't be opened");
  if (st === "empty") throw new Error(snap.ingest?.error ?? "No changes to review: the diff is empty.");
  throw new Error("the review is still opening");
}

interface ReviewSnapshotBase {
  review: Review;
  /**
   * #92: loading/failed reviews carry a placeholder (n: 0, empty SHAs) —
   * no real version yet. Present once the ingest lands. Callers must check
   * `ingest` first.
   */
  version: Version;
  /** #92: empty while loading/failed; present once ready. */
  files: ReviewFile[];
  /** PR description / commit messages; absent while loading and on pre-M1 snapshots. */
  description?: ReviewDescription;
  /** #92: ingest state. */
  ingest: IngestStatus;
  pages: Page[];
  annotations: Annotation[];
  hunkStates: HunkState[];
  /**
   * Issue #162: per-file fold state, keyed by file key. Reviewed is
   * derived from the file's hunks, never stored here.
   */
  fileStates: FileState[];
  /** Issue #168: per-review diff view preferences. */
  viewPrefs: ReviewViewPrefs;
  jobs: Job[];
  contributions: Contribution[];
  logTail: LogEntry[];
  /** Monotonic revision of this snapshot; WS patches carry baseRev/headRev. */
  rev: number;
  /** Issue #193: PR/branch commits in landing order, as plotline evidence. Absent on pre-#193 snapshots. */
  commits?: ReviewCommit[];
  /**
   * Issue #169: the reader's plotlines (empty/absent = none named yet;
   * every hunk reads as "other"). Per-hunk assignment lives on
   * `HunkState.plotline`, keyed by content hash.
   */
  plotlines?: Plotline[];
  /** Custom guides the reader prompted, oldest first (customGuides.ts). */
  guides?: CustomGuide[];
  /**
   * Issue #169: the diff's score/plotline filter, remembered with the
   * review. Absent = all hunks (no filtering).
   */
  diffFilter?: DiffFilter;
  /**
   * M3 pipeline (PRD §16): per-review token totals + cache-hit rate.
   * Updated by the pipeline after every job; absent on pre-M3 snapshots.
   */
  usageTotals?: ReviewUsageTotals;
  /**
   * M3 pipeline (PRD §11): which stages have completed. Absent on pre-M3
   * snapshots (treated as all pending). Used by resume-after-restart.
   */
  pipeline?: {
    stages: Record<PipelineStage, "pending" | "running" | "done" | "error">;
    /** Last error per stage (when state is "error"). */
    errors?: Partial<Record<PipelineStage, string>>;
  };
  /**
   * M5 (PRD §8): review-level staleness for the "New commits · Update"
   * banner. Present once a refresh has created version n+1; cleared by a
   * successful update pass. Absent on fresh reviews.
   */
  versionStatus?: import("./versions.js").VersionStatus;
  /**
   * M5: reader-pinned excerpts stored in the snapshot so refresh can remap
   * them by content (`needsRepining` when not found again).
   */
  pinnedCode?: import("./versions.js").PinnedCode[];
  /**
   * M6: read-only cache of existing PR comments
   * (`gh api …/pulls/{n}/comments`). Populated on demand by
   * `GET /api/reviews/:id/pr-comments`; absent until first fetch.
   */
  existingComments?: ExistingReviewComment[];
  /**
   * Issue #194: timed non-agent steps of the most recent refresh that
   * created a version (fetch, range diff, building, remapping). Shown on
   * the Debug page; absent until a refresh moves the head.
   */
  refreshTimings?: { at: number; steps: import("./entities.js").TimedStep[] };
}

/** Issue #222: a change (PR/branch) review — no document content. */
export interface ChangeReviewSnapshot extends ReviewSnapshotBase {
  document?: undefined;
  contextRepos?: undefined;
}

/** Issue #222: a document review — the pasted document and its context repos. */
export interface DocumentReviewSnapshot extends ReviewSnapshotBase {
  document: DocumentContent;
  contextRepos: ContextRepoRef[];
}

/**
 * Issue #222: a review snapshot, discriminated by shape. The kind is
 * derived, never stored: a snapshot carrying the pasted document is a
 * document review; every other snapshot is a change review.
 */
export type ReviewSnapshot = ChangeReviewSnapshot | DocumentReviewSnapshot;

/** Issue #222: true when the snapshot is a document review's. */
export function isDocumentReview(
  snap: Pick<ReviewSnapshot, "document">,
): snap is DocumentReviewSnapshot {
  return snap.document !== undefined;
}

/** Issue #222: the derived review kind of a snapshot. */
export function reviewKindOf(snap: Pick<ReviewSnapshot, "document">): ReviewKind {
  return isDocumentReview(snap) ? "document" : "change";
}

export type ReviewResponse = ReviewSnapshot;

/**
 * #149: `POST /api/reviews` answers with the review snapshot plus whether
 * it reused an existing review for the same source (repo + PR number, or
 * repo + branch). New reviews answer 202 without the flag; a reused
 * review answers 200 with `reused: true`, so the web navigates without a
 * "created" toast.
 */
export type CreateReviewResponse = ReviewSnapshot & { reused?: boolean };

/**
 * Front screen (PRD §4.2): every review opened before, across ALL repos,
 * most recent first. Served by `GET /api/reviews`.
 */
export interface ReviewSummary {
  id: string;
  /** Issue #222: `"document"` for a document review. */
  kind?: ReviewKind;
  repoId: string;
  repoOwner: string;
  repoName: string;
  /** PR title or branch name. */
  title: string;
  branch: string;
  prNumber?: number;
  createdAt: number;
  /** Epoch ms the review was last opened (snapshot updated_at). */
  lastOpened: number;
  versionCount: number;
  currentVersion: number;
  /** Head moved since fetch ("new commits · Update"). */
  stale: boolean;
  totalHunks: number;
  reviewedHunks: number;
  /** Threads in the Outbox and not yet posted. */
  pendingComments: number;
  /** #224: PR state from the snapshot's stored gh data. Absent for branch reviews. */
  prState?: PrState;
  /** #224: review decision from the snapshot's stored gh data. Absent when none. */
  reviewDecision?: PrReviewDecision;
  /** Guide generation state (reader/base/critic pipeline). */
  guideStatus: "ready" | "running" | "error" | "idle" | "disabled";
  guideDetail?: string;
  /**
   * #92: ingest state for the front-screen row. Loading/failed rows show
   * their marker, reopen to the loading/failed page, and can be removed
   * (failed: retry).
   */
  ingestStatus: "ready" | "loading" | "failed" | "empty";
  /** #92: loading step ("fetching" | "reading diff") while ingestStatus is loading. */
  ingestStep?: string;
  /** #92: failure text while ingestStatus is failed. */
  ingestError?: string;
}

export interface ReviewsListResponse {
  reviews: ReviewSummary[];
}

// --- errors --------------------------------------------------------------

/**
 * Machine-readable error codes (issue #86, finding 10): behaviour that
 * used to depend on matching error message text (HTTP status picking in
 * `pipeline/actions/dispatcher.ts`, web no-agent checks, the Submit
 * panel's head-moved check) keys off this instead, so wording can change
 * freely. The human `error` message is unchanged; `code` is optional so
 * old stored errors without one keep working (every reader falls back to
 * the previous text match when it is absent).
 */
export type ApiErrorCode =
  | "not-found"
  | "invalid-request"
  | "no-agent"
  | "head-moved"
  | "not-implemented"
  /**
   * Issue #133: the review has no readable file content (e.g. the demo,
   * whose worktree carries no git history). The diff expander hides its
   * controls on this code instead of showing load errors.
   */
  | "no-content";

/** The app's usual error body: a human message plus its machine code. */
export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}

// --- readiness -----------------------------------------------------------

/**
 * Front-screen readiness (callouts + Settings → Environment).
 * Served by `GET /api/readiness` (`?force=1` bypasses the brief cache).
 */
export type ReadinessStatus = "ok" | "warning" | "error";

export interface ReadinessCheck {
  /** e.g. "git" | "gh" | "agent:main" | "agent:small" | "agent:second-opinion" | "agents-distinct". */
  id: string;
  label: string;
  status: ReadinessStatus;
  /** One-line human explanation. */
  summary: string;
  /** How to fix it. */
  fix: string;
  /** Settings section anchor the front screen links to (e.g. "#environment", "#models"). */
  settingsAnchor?: string;
}

export interface ReadinessResponse {
  checks: ReadinessCheck[];
  generatedAt: number;
  /** True when served from the brief cache (not a fresh probe). */
  cached: boolean;
}

export interface RefreshResponse {
  review: Review;
  /**
   * True when a new version was created by the fetch.
   * M1: true when the head SHA moved (version creation + mapping is M5;
   * see the `M5 seam` marker in the service refresh route).
   */
  newVersion: boolean;
  /**
   * M5: hunk-level summary of what the fetch found (present when
   * `newVersion` is true). `versionStatus` on the snapshot carries the
   * same counts for the banner; `rangeDiff` is display-only.
   */
  comparison?: import("./versions.js").VersionComparisonSummary;
  /** M5: new version number (equals `review.currentVersion` when created). */
  version?: import("./entities.js").Version;
}

/**
 * M5: `POST /api/reviews/:id/update` response — the enqueued update-pass
 * job. The pass runs only when the user clicks Update; it sees only the
 * changed and new hunks (PRD §8).
 */
export interface UpdateReviewResponse {
  jobId: string;
  /** New version the pass updates to (current version at enqueue time). */
  toVersion: number;
}

// --- actions -------------------------------------------------------------
/**
 * POST /api/reviews/:id/actions. One discriminated union so the service can
 * route by `kind` and later agents can add variants without new endpoints.
 */
export type ReviewAction =
  | { kind: "explain"; quote: string; anchor: ActionAnchor; offsets?: SelectionOffsets }
  /** Issue #136 slice 2: same request; creates a conversation card whose first question is the message. */
  | { kind: "ask"; quote: string; anchor: ActionAnchor; message: string; offsets?: SelectionOffsets }
  | { kind: "note"; quote: string; anchor: ActionAnchor; text?: string; offsets?: SelectionOffsets }
  /**
   * Issue #136: `cardId` is a page-card id or one conversation answer's
   * `ans_…` id. Depth, examples, diagram, undo and second opinion act on
   * that unit's own blocks/level/undo stack, so an answer rewrites alone.
   */
  | { kind: "depth"; cardId: string; direction: "simpler" | "deeper" }
  | { kind: "examples"; cardId: string }
  | { kind: "diagram"; cardId: string }
  | { kind: "undo"; cardId: string }
  /** Issue #136: `cardId` is a page-card id or a conversation card id. */
  | { kind: "collapse"; cardId: string; collapsed: boolean }
  | { kind: "generate"; cardId: string }
  | { kind: "second_opinion"; cardId: string; mode: "blind" | "check" }
  | { kind: "promote"; annotationId: string }
  | { kind: "close"; annotationId: string }
  | { kind: "delete"; targetId: string }
  /**
   * Issue #138: turn an idle hunk summary into its conversation card
   * (created from the stored summary text, no agent call), or reopen it.
   * The explicit hunk control sends this; selecting summary text and
   * choosing Explain/Ask goes through those actions with a hunk anchor.
   */
  | { kind: "hunk_card"; fileKey: string; contentHash: string }
  /**
   * M4: answer a follow-up suggestion under the block it came from.
   * `cardId` is a page-card id, a conversation card id, or one answer's
   * `ans_…` id. On a page card the answer arrives as a new conversation
   * card anchored on that block (prototype `follow`), quoting the
   * suggestion label; on a conversation card the suggestion is sent as
   * the next turn in the same conversation (#136).
   */
  | { kind: "followup"; cardId: string; blockId: string; index: number }
  /**
   * Follow-up user message on a conversation card, added as a turn on
   * the card's session (`Annotation.sessionId`) instead of forking
   * again.
   */
  | { kind: "reply"; annotationId: string; message: string }
  /** Retry the last turn of a conversation card. */
  | { kind: "retry"; annotationId: string }
  /**
   * M4: write a concept page on first open (`ensureConceptPage`). The
   * page shows a working state while its job fills it.
   */
  | { kind: "concept"; slug: string };

export type ActionAnchor =
  /**
   * A guide block, addressed `<card>#<block>` (block ids restart at `b1`
   * in every card, so the card qualifier is required). The card part is a
   * page-card id, or — for a selection inside a conversation answer (#116,
   * #136) — the hosting answer's `ans_…` id, so nested cards address
   * `<answer>#<block>` the same way.
   */
  | { where: "block"; blockId: string }
  | { where: "description"; paragraphId: string }
  /** Issue #214: a selection inside a comment card, hosted on that comment. */
  | { where: "comment"; commentId: string }
  | {
      where: "diff-line";
      fileKey: string;
      line: number;
      /** Issue #189: last line of a multi-line selection (range marker). */
      endLine?: number;
      side?: "LEFT" | "RIGHT";
    }
  /**
   * Issue #138: a hunk, addressed `h:<fileKey>:<contentHash>`. Explain
   * and Ask with a hunk anchor first turn the hunk's idle summary into a
   * real conversation card (no agent call), then run as a nested card on
   * the selected summary text.
   */
  | { where: "hunk"; fileKey: string; contentHash: string }
  /**
   * Issue #81: a file at a commit (the source-pane file tab), addressed
   * like a `code:` citation. Explain, Ask and Comment anchor here; the
   * card or thread renders under the cited lines in that tab.
   */
  | { where: "code"; path: string; commit: string; line: number; endLine?: number };

export interface ActionResponse {
  accepted: boolean;
  /** Job started for the action, when async. */
  jobId?: string;
  /** M4: annotation created or targeted by the action (explain/ask/note/followup). */
  annotationId?: string;
  /** Issue #136: turn created or targeted by the action (explain/ask/reply/retry/followup). */
  turnId?: string;
  /** M4: page created or targeted (promote/concept). */
  pageId?: string;
  /** M4: card created or targeted (depth/examples/diagram/undo/collapse/followup). */
  cardId?: string;
  /** M4: true when an identical active request was reused (dedupe, PRD §12). */
  deduplicated?: boolean;
  /**
   * Audit-10 (#10): true when a stored result for the identical request
   * (anchor, kind, depth, base version, PRD §12) was returned without an
   * agent call. No job is created and no tokens are spent.
   */
  reused?: boolean;
  /**
   * Depth stepper result (issue #65): the card/answer level after the
   * action. Lets the client tell a stored-level switch (level changed:
   * silent) from already-at-the-limit (level unchanged: toast).
   */
  level?: DepthLevel;
}

// --- diagrams (D2 decision addendum) ---------------------------------------
// `GET /api/reviews/:id/diagrams/:hash?theme=light|dark` serves the cached,
// sanitised SVG (`200 image/svg+xml`), `404` for an unknown hash, and `409`
// with a `DiagramStatusBody` when the hash is known but not rendered.

/** Render theme for the diagram endpoint. */
export type DiagramTheme = "light" | "dark";

/**
 * `409` body when a diagram hash is known but has no SVG to serve.
 *
 * The two statuses mean different things and are never inferred from each
 * other (issue #130):
 * - `"unavailable"`: the `d2` binary is missing or too old, so nothing was
 *   even attempted. The web answers with the install hint.
 * - `"error"`: `d2` ran and the source failed (pre-check rejection or
 *   compiler/render failure). `error` carries the raw compiler message
 *   for the Debug page; reader-facing text stays plain and never quotes it.
 */
export interface DiagramStatusBody {
  status: "unavailable" | "error";
  error?: string;
}

// --- file slices (issue #133: expand a diff beyond its hunks) -----------

/**
 * `GET /api/reviews/:id/file?path=&commit=&start=&end=` — raw lines
 * `start` to `end` (1-based, inclusive) of `path` at `commit`, served
 * from the review's worktree through the same `git show` source as
 * `get_code`. General on purpose: the diff expander reads hunk
 * surroundings through it today, later uses read any range the same way.
 *
 * Errors never throw: unknown review → 404, bad range → 400, missing or
 * binary file → 404/400 with a human message.
 */
export interface FileSliceResponse {
  /** Repo-relative path as requested. */
  path: string;
  /** Commit as requested. */
  commit: string;
  /** First line returned (1-based). */
  start: number;
  /** Last line returned (1-based, inclusive). */
  end: number;
  /** Total lines of the file at the commit (for "no more lines" states). */
  totalLines: number;
  /** Line texts without numbers, `end - start + 1` entries. */
  lines: string[];
}

/**
 * Past-the-end `GET …/file` answers 400 with the file end attached, so
 * the caller learns it without a second read:
 * `{ error, totalLines }`.
 */
export interface FileSliceRangeError {
  error: string;
  totalLines: number;
}

// --- outlines (issue #133: expand by enclosing unit) ---------------------

/**
 * One enclosing unit of a hunk's range: a function, method, class, or
 * (from the fallback) an indentation block. `kind` is the grammar's node
 * kind (`function_definition`, `method_declaration`, …) or one of the
 * synthetic kinds (`callback`, `bound-function`, `object`, `block`).
 * `start`/`end` are 1-based inclusive lines of the file at `commit`,
 * leading doc comments and decorators included.
 */
export interface EnclosingUnit {
  kind: string;
  /** Unit name (at most 60 chars), shown in the hunk header. */
  name: string;
  start: number;
  end: number;
}

/** How the chain was found: grammar parse, indentation fallback, or neither. */
export type OutlineHow = "parser" | "heuristic" | "none";

/**
 * `GET /api/reviews/:id/outline?path=&commit=&start=&end=` — the chain
 * of units enclosing lines `start` to `end` of `path` at `commit`
 * (innermost first), for stepping one level out per click. Served from
 * the review's worktree through the same `git show` source as the
 * file-slice route, parsed with tree-sitter grammars (indentation
 * fallback for unknown languages and unreadable files). Parsed trees
 * cache by file content hash. Never throws: unparseable and oversize
 * files answer an empty chain with `how` heuristic/none, and the caller
 * degrades to expand-by-lines.
 */
export interface FileOutlineResponse {
  /** Repo-relative path as requested. */
  path: string;
  /** Commit as requested. */
  commit: string;
  /** First line of the asked range (1-based). */
  start: number;
  /** Last line of the asked range (1-based, inclusive). */
  end: number;
  /** Total lines of the file at the commit. */
  totalLines: number;
  /** Outline language id (`python`, `typescript`, …), null when unknown. */
  language: string | null;
  how: OutlineHow;
  /** Enclosing units, innermost first; empty when there is none. */
  chain: EnclosingUnit[];
}

// --- hunks ---------------------------------------------------------------

export interface UpdateHunkRequest {
  folded?: boolean;
  reviewed?: boolean;
  /**
   * Set/replace the agent summary, or delete it with `null`.
   * Added for M1-web (hunk cards carry Delete for the summary).
   */
  summary?: string | null;
}

/** PATCH /api/reviews/:id/files/:fileKey — per-file diff state (issue #162). */
export interface UpdateFileRequest {
  folded?: boolean;
}

/** PATCH /api/reviews/:id/view — per-review diff view preferences (issue #168). */
export interface UpdateViewRequest {
  showExistingComments?: boolean;
  existingCommentsCollapsed?: boolean;
}

export interface SummarizeHunkResponse {
  /** Job started for the summarize, absent when a stored summary was reused. */
  jobId?: string;
  /**
   * Audit-10 (#10): true when the hunk already carried a stored summary for
   * the same content hash, so no agent call was made (PRD §12 reuse).
   */
  reused?: boolean;
  /** Present when `reused` is true: the stored summary. */
  summary?: string;
}

/**
 * Issue #169: `PATCH /api/reviews/:id/diff-filter` — the diff's
 * score/plotline filter, remembered with the review. Each field is a
 * plotline id (or "other") / score level; explicit null clears it.
 * Unknown plotline ids and levels are refused (400).
 */
export interface UpdateDiffFilterRequest {
  plotline?: string | null;
  score?: HunkScoreLevel | null;
  /**
   * Custom guide to scope the diff to; null returns to the main guide.
   * Changing it clears a plotline pick unless `plotline` is sent too.
   */
  guideId?: string | null;
}

/**
 * M3 pipeline (PRD §11, §16): resume an interrupted pipeline.
 * `POST /api/reviews/:id/resume` re-enqueues every pipeline stage that has
 * not completed yet (idempotent; already-done stages are skipped).
 */
export interface ResumeReviewResponse {
  resumed: boolean;
  /** Job ids enqueued by this resume call (empty when nothing was missing). */
  jobIds: string[];
  /** Pipeline stages still incomplete after the resume. */
  pendingStages: PipelineStage[];
}

/** Pipeline stages (PRD §11): reader → base → critic → hunk pass. */
export type PipelineStage = "reader" | "base" | "critic" | "hunk-pass" | "go-deeper";

/**
 * M3 pipeline (PRD §16): per-review token totals + cache-hit rate.
 * Computed from the review's jobs; served via `GET /api/reviews/:id` as
 * `usageTotals` and via `GET /api/jobs?review=:id` per job.
 */
export interface ReviewUsageTotals {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  /** Cache read share: cachedRead/(input+cachedRead+cachedWrite). input counts uncached input only (M0, #125). */
  cacheHitRate?: number;
  /** Epoch ms of the first card streamed (time-to-first-card, PRD §16). */
  firstCardAt?: number;
  /** Epoch ms the review was created (for time-to-first-card deltas). */
  createdAt: number;
}

// --- comments ------------------------------------------------------------

/** PATCH /api/reviews/:id/comments/:commentId (M6 extends M3 contract; comments only). */
export interface UpdateCommentRequest {
  post?: boolean;
  /** Editable draft of the text to post; explicit null clears it. */
  draft?: string | null;
  /** M6: open/closed in place. */
  open?: boolean;
  /** M6: unsent reply-box content (survives re-renders); null clears it. */
  reply?: string | null;
  /** Issue #167: pin a conversation card into the page (conversations only). */
  pinned?: boolean;
}

/** POST /api/reviews/:id/comments — create a thread (M6). */
export interface CreateCommentRequest {
  anchor: ActionAnchor;
  /** Quoted anchor text (highlighted in the UI). */
  quote: string;
  /** A few lines before the quote (anchor matching, PRD §8). */
  prefix?: string;
  /** A few lines after the quote. */
  suffix?: string;
  /** Best-effort position at creation (line/offset). */
  position?: number;
  /** Issue #166: selection offsets within the host's text, when selected. */
  offsets?: SelectionOffsets;
  /** Initial user text (first message when present). */
  text?: string;
  /**
   * Create an agent-suggested comment: first message is the agent's
   * suggestion (`suggested: true`), never in the Outbox initially.
   * Only valid on diff-line anchors.
   */
  suggested?: boolean;
  /** Agent suggestion text (required when `suggested` is true). */
  suggestionText?: string;
}

export interface CreateCommentResponse {
  id: string;
}

/** POST /api/reviews/:id/comments/:commentId/replies — user reply (M6). */
export interface ReplyCommentRequest {
  text: string;
}

export interface ThreadMessage {
  who: "you" | "ai";
  text?: string;
  /** M6: agent-drafted suggested comment (first message, not in the Outbox). */
  suggested?: boolean;
}

/** GET /api/reviews/:id/outbox — Outbox export Markdown (#223). No download/filename: Copy only. */
export interface OutboxResponse {
  markdown: string;
  count: number;
}

/** GET /api/reviews/:id/pr-comments — read-only existing PR comments (M6). */
export interface ExistingCommentsResponse {
  comments: ExistingReviewComment[];
}

// --- description ---------------------------------------------------------

export interface UpdateDescriptionRequest {
  /** Edited HTML with paragraph ids preserved (PRD §4.11). */
  html: string;
}

export interface SubmitReviewRequest {
  /** Optional client-side confirmation of what will be posted. */
  expectedCount?: number;
  /** M6: return the preview without posting (Submit panel). */
  dryRun?: boolean;
}

/** M6: where one Outbox thread lands on GitHub (PRD §4.8, §4.12). */
export type SubmitCommentLocation =
  | {
      kind: "inline";
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
      startLine?: number;
      startSide?: "LEFT" | "RIGHT";
      /** Set when the anchor line wasn't commentable and we fell back. */
      fallbackNote?: string;
    }
  | { kind: "general"; reason?: string };

/** M6: one comment as it will be posted. */
export interface SubmitPreviewComment {
  threadId: string;
  location: SubmitCommentLocation;
  /** Exact text that will be posted (draft + fallback note). */
  text: string;
  /**
   * #81: quoted lines when the posted text carries them (a file-tab
   * comment's review-body entry: permalink, quote, comment). Present
   * so the preview can show the whole entry, not a truncated slice.
   */
  quote?: string;
}

/** M6: exactly what Submit will post (preview + dryRun response). */
export interface SubmitPreview {
  /** Threads in the Outbox that are not yet posted. */
  comments: SubmitPreviewComment[];
  /** Threads already posted (skipped on retry). */
  alreadyPosted: string[];
  /** Review body (general comments joined), "" when none. */
  reviewBody: string;
  /** Pinned head SHA the review will carry as `commit_id`. */
  commitId: string;
  /** Description update, when a pending edit exists. */
  description?: { fromRev: string; markdown: string; html: string };
  disabledReason?: string;
  /** Hardening: a previous submit may still be in flight (lease present). */
  inflight?: boolean;
}

export interface SubmitReviewResponse {
  posted: boolean;
  commentCount: number;
  descriptionUpdated: boolean;
  /** M6: present on dryRun (preview without posting). */
  preview?: SubmitPreview;
  /** M6: GitHub review URL after a successful post. */
  reviewUrl?: string;
  /** M6: true when the review posted but the description update failed. */
  partial?: boolean;
  /** Hardening: true when a crashed submit was reconciled (no second post). */
  recovered?: boolean;
  /** Hardening: leased threads left pending (edited after the crash). */
  stillPending?: number;
  /** M6: why submit is disabled / refused (branch without PR, head moved…). */
  reason?: string;
}

// --- settings ------------------------------------------------------------

export interface ModelPick {
  provider: string;
  model: string;
  /**
   * Thinking level for the role (issue #172): an adapter-offered effort
   * value (Claude `effort`, Codex `reasoning_effort`). "" means Default —
   * leave the adapter's own setting alone.
   */
  effort: string;
}

/**
 * UI theme (issue #196): a named look selected on `<html data-ui-theme>`,
 * independent of light/dark (`data-theme` / `prefers-color-scheme`).
 * Each theme supplies both a light and a dark set. `"default"` is the
 * look the app shipped with; `"studio"` and `"console"` are the two
 * #164 style references, each with a light and a dark set.
 */
export const UI_THEME_IDS = ["default", "studio", "console"] as const;
export type UiThemeId = (typeof UI_THEME_IDS)[number];
export const DEFAULT_UI_THEME: UiThemeId = "default";

export const UI_THEMES: { id: UiThemeId; label: string; hint: string }[] = [
  { id: "default", label: "Default", hint: "The current Unvibe look." },
  { id: "studio", label: "Studio", hint: "Soft modern workspace: violet accent, large soft corners, tinted shadows." },
  { id: "console", label: "Console", hint: "Dark-first code-editor look: blue accent, square corners, mono labels." },
];

export function isUiThemeId(v: unknown): v is UiThemeId {
  return typeof v === "string" && (UI_THEME_IDS as readonly string[]).includes(v);
}

export interface Settings {
  /** UI theme (issue #196); persisted like every other setting. */
  uiTheme: UiThemeId;
  main: ModelPick;
  small: ModelPick;
  secondOpinion: ModelPick;
  /** Max concurrent sessions per provider (default 16, PRD §12). */
  sessionsPerProvider: number;
  /** Inline size budget in tokens (L1 budget guess ~40k, PRD §9.1). */
  inlineBudgetTokens: number;
  /** Base-rebuild thresholds (PRD §9.4). */
  rebuildSupersededRatio: number;
  rebuildAppendedTokens: number;
  /**
   * M5 shared context (PRD §9.3): log tokens accumulated before the batch
   * is appended to the base session as a new turn.
   */
  logBatchTokens: number;
  /** Provider cache lifetime in ms: idle sessions close after this (PRD §12). */
  cacheLifetimeMs: number;
  /** Service exits after this many idle minutes (PRD §14; 0 = never). */
  idleExitMinutes: number;
  /**
   * Version picker (issue #36, step 2; toggle meaning #231): Settings →
   * Version always lists releases (and the update check always runs —
   * both shell out through `gh` under the user's own login); this flag
   * only shows preview channels. Off by default.
   */
  versionPickerEnabled: boolean;
  /**
   * Issue #160: full access for agent sessions (shell, `git`, `gh`, web,
   * file tools unrestricted). Off by default; the lock-down stays until
   * this is turned on WITH `fullAccessAcknowledgedAt` in the same update
   * (the service refuses to enable without the acknowledgement).
   */
  fullAccess: boolean;
  /**
   * Issue #160: epoch ms the full-access warning was acknowledged, stored
   * with the setting. Null when never acknowledged. Turning full access
   * off clears it, so turning it on again asks again.
   */
  fullAccessAcknowledgedAt: number | null;
  /**
   * Issue #217: write go-deeper placeholder cards automatically in the
   * background once the guide lands. On by default; off means a card is
   * written only when its Generate button is clicked.
   */
  autoGoDeeper: boolean;
}

/** PUT /api/settings accepts a partial update; GET returns full Settings. */
export type UpdateSettingsRequest = Partial<Settings>;

/** One model an ACP adapter offers, with display metadata (#21). */
export interface ModelInfo {
  /** Adapter config value (e.g. "opus", "claude-opus-5", "gpt-5.4"). Persisted in settings. */
  id: string;
  /** Display name beside the id (e.g. "Opus 5.5"). */
  name?: string;
  /** Secondary text (e.g. what it resolves to, capabilities). */
  description?: string;
}

/** GET /api/models?provider=:id — models an ACP adapter offers (PRD §4.14). */
export interface ModelsResponse {
  provider: string;
  models: ModelInfo[];
}

/** One thinking-level value an adapter offers (issue #172). */
export interface ThinkingOption {
  /** Adapter config value (e.g. "low", "high"). Persisted in settings. */
  value: string;
  /** Display name beside the value (e.g. "High"). */
  name?: string;
  /** Secondary text. */
  description?: string;
}

/** GET /api/thinking?provider=:id — thinking levels the adapter offers. */
export interface ThinkingResponse {
  provider: string;
  /** Values the adapter offers for its effort selector; empty when none. */
  options: ThinkingOption[];
  /** Display name for the option values above (e.g. "Effort"). */
  label?: string;
  /** The adapter's own current value (what Default leaves alone). */
  current?: string;
}

// --- diagnostics (issue #20) ---------------------------------------------

/** One candidate binary found for a tool, in PATH order. */
export interface DiagnosticCandidate {
  /** Absolute path, or the override value when it points nowhere. */
  path: string;
  /** Where it came from: env override, login-shell PATH entry, etc. */
  source: string;
  /** What the file is: real file, symlink (+target), shim (+manager), missing override. */
  kind: string;
  /** Symlink target (when kind mentions symlink), resolved chain. */
  symlinkTarget?: string;
  /** Shim manager when detectable: mise/asdf/nvm/homebrew/npm-global. */
  shimManager?: string;
  /**
   * Real executable a shim resolves to (issue #105): the version manager's
   * answer for this tool from a neutral directory, verified to run from a
   * review copy. Sessions run this path, not the shim. Absent when the
   * candidate is not a shim, the manager is unknown, or resolution failed.
   */
  resolvedPath?: string;
  /** Whether `--version` ran successfully (exit 0 within the timeout). */
  runs: boolean;
  exitCode?: number;
  /** Full stdout/stderr from the version probe (untruncated, copyable). */
  stdout?: string;
  stderr?: string;
  /** Parsed version, only from a successful run (never from error text). */
  version?: string | null;
  /** Whether it meets the tool's minimum version. */
  meetsMin?: boolean;
}

/** Diagnosis for one tool: every candidate, which was chosen and why. */
export interface DiagnosticTool {
  tool: string;
  /** Env override name when set (e.g. UNVIBE_CODEX_BIN), else undefined. */
  overrideEnv?: string;
  overrideValue?: string;
  minVersion?: string;
  candidates: DiagnosticCandidate[];
  /** Chosen path, or null when nothing usable was found. */
  chosen: string | null;
  chosenReason: string;
  warnings: string[];
}

/** How the effective PATH was derived (same answer however started). */
export interface DiagnosticPath {
  shell: string;
  /** PATH printed by the scrubbed interactive probe. */
  probedPath: string;
  /** PATH inherited by this process. */
  inheritedPath: string;
  /** Effective PATH used for tool resolution (probed first, inherited extras appended). */
  effectivePath: string;
  onlyInProbed: string[];
  onlyInInherited: string[];
}

/** How the service was started (helper/CLI/foreground). */
export interface DiagnosticService {
  pid: number;
  startedAt: string;
  cwd: string;
  dataDir: string;
  port: number;
  startMode: string;
  nodeVersion: string;
  serviceVersion: string;
}

/** GET /api/diagnostics — full report shared by doctor and the Doctor page. */
export interface DiagnosticsResponse {
  generatedAt: number;
  path: DiagnosticPath;
  tools: DiagnosticTool[];
  service: DiagnosticService;
  warnings: string[];
  /** Model display names per provider (id → {name, description}), when known. */
  models?: Record<string, ModelInfo[]>;
}

/** POST /api/reload — re-probe everything without restarting the service. */
export interface ReloadResponse {
  ok: boolean;
  generatedAt: number;
  changed: string[];
  detail: string[];
  diagnostics: DiagnosticsResponse;
}

// --- prompts -------------------------------------------------------------

export interface PromptTemplate {
  name: string;
  role: string;
  tier: string;
  variables: string[];
  template: string;
}

export interface PromptExpanded {
  name: string;
  expanded: string;
  /** Token counts per layer for the expanded text. */
  layers: { layer: string; tokens: number }[];
  cachedTokens: number;
}

export interface PromptsResponse {
  templates: PromptTemplate[];
  /** Present when ?review= is given: per-review expansion. */
  expanded?: PromptExpanded[];
}

// --- jobs ----------------------------------------------------------------

export interface JobsResponse {
  jobs: Job[];
}

/** GET /api/jobs/:id — one job. */
export interface JobResponse {
  job: Job;
}

/** GET /api/jobs/:id/reply — the agent's reply for a failed job (#180). */
export interface JobReplyResponse {
  jobId: string;
  replySnapshot: string;
}

/** GET /api/jobs/:id/output — per-turn output records for any job (#207). */
export interface JobOutputResponse {
  jobId: string;
  turnRecords: import("./entities.js").JobTurnRecord[];
}

// --- contributions -------------------------------------------------------
/**
 * M8 settings (PRD §4.14 "Shared context", §9.5): every automatic agent
 * contribution, with the thread it came from, and delete for any item.
 *
 * - `GET /api/reviews/:id/contributions` — the review's contributions.
 * - `DELETE /api/reviews/:id/contributions/:contributionId` — remove one
 *   item (any status). Answers 404 when the id is unknown.
 */
export interface ContributionsResponse {
  contributions: Contribution[];
}

export interface DeleteContributionResponse {
  ok: true;
  deletedId: string;
}

/**
 * Issue #32: per-review shared-context debug page (`/review/:id/debug`,
 * PRD §9). `GET /api/reviews/:id/shared-context` returns the three parts
 * of the review's shared context as Markdown text the page renders as-is:
 * the base session(s) plus the current base pack, the append-only log, and
 * the contributions. The web side does no formatting of its own beyond
 * rendering Markdown (delete still uses the contributions endpoints below).
 * 404 when the review is unknown.
 */
export interface SharedContextResponse {
  reviewId: string;
  /** Base section: per-base keys + `SharedContextBaseStats`, then the current pack in fenced blocks. */
  base: string;
  /** Log section: every entry in order with in-base/waiting markers. */
  log: string;
  /** Contributions section: one block per contribution. */
  contributions: string;
}

/**
 * M5 shared context (PRD §9.5): corrections are suggestions on the target
 * card, never silent rewrites.
 *
 * - `POST /api/reviews/:id/contributions/:contributionId/accept` — accept a
 *   pending correction: creates a new card revision (undoable like any
 *   other card change). Answers 404 for an unknown review/contribution,
 *   409 when the contribution is not a pending correction.
 * - `POST /api/reviews/:id/contributions/:contributionId/dismiss` —
 *   discard a pending correction. Same 404/409 rules.
 */
export interface AcceptContributionResponse {
  ok: true;
  acceptedId: string;
  /** Card revision created by the accept. */
  cardId: string;
  revision: number;
}

export interface DismissContributionResponse {
  ok: true;
  dismissedId: string;
}

/**
 * M5 shared context (PRD §4.14 "Shared context", §9.4): per-base
 * observability rendered into the shared-context debug document
 * (`GET /api/reviews/:id/shared-context`).
 */
export interface SharedContextBaseStats {
  /** Session-manager base key (`version|guideRevision|provider|model`). */
  baseKey: string;
  /** Base size in tokens when built. */
  baseTokens: number;
  /** Log-batch tokens appended since the base was built. */
  appendedTokens: number;
  /** Superseded share of the base (0–1). */
  supersededRatio: number;
  /** Last rebuild reason, or null when this base was built fresh. */
  lastRebuildReason: string | null;
  /** Cache read share for jobs on this base, when measurable. */
  cacheHitRate?: number;
  /** Epoch ms the base was last used (cache-expiry tracking, PRD §9.4). */
  lastUsedAt: number;
}

// --- update channels (issue #36, step 2: version picker) -----------------

/**
 * One installable build: `release` or a `preview/<slug>` published from
 * an in-flight branch (candidates go out as `preview/main-rc`). Served
 * by `GET /api/update/channels`; `current` marks the installed one.
 */
export interface UpdateChannel {
  /** "release" | "preview/<slug>". */
  ref: string;
  kind: "release" | "preview";
  /** e.g. "0.0.1-preview.feat-x.abc1234"; null when unknown. */
  version: string | null;
  /** Built tree's commit sha (for a merged preview, the merge result); null when unknown. */
  commit: string | null;
  /** e.g. "feat/x"; null for release builds. */
  sourceBranch: string | null;
  /**
   * Branch-side commit the build was made from (issue #41: previews are
   * built as base + branch, so this differs from `commit`, the merge
   * result). Equals `commit` for branch-as-is builds; null for release
   * builds and for previews published before the field existed.
   */
  sourceCommit: string | null;
  /**
   * Base the branch was merged onto for the build (usually "main");
   * null for release builds, branch-as-is previews, and previews
   * published before the field existed.
   */
  baseBranch: string | null;
  /** Base-side commit sha; null when unknown. */
  baseCommit: string | null;
  /** ISO build time; null when unknown. */
  builtAt: string | null;
  current: boolean;
}

/**
 * The running build's identity, exposed where the web app already gets
 * the service version (`GET /api/health` → `build`, `GET
 * /api/update/status` → `build`). Null when the build carries no preview
 * metadata (plain release / dev / unwired installs).
 */
export interface UpdateBuildInfo {
  version: string;
  /** Installed channel ("release" | "preview/<slug>") of the running build; null when unknown. */
  channel: string | null;
  sourceBranch: string | null;
  /** Branch-side commit (for a merged preview, the branch head — see `UpdateChannel.sourceCommit`); null when unknown. */
  sourceCommit: string | null;
  /** Base the branch was merged onto (usually "main"); null when unknown. */
  baseBranch: string | null;
  /** Base-side commit sha; null when unknown. */
  baseCommit: string | null;
  commit: string | null;
  builtAt: string | null;
}

/** `GET /api/update/channels[?refresh=1]` — cached briefly server-side. */
export interface UpdateChannelsResponse {
  channels: UpdateChannel[];
}

/** `POST /api/update/switch` — restart onto another channel's build. */
export interface UpdateSwitchRequest {
  ref: string;
  /**
   * Switch even while jobs are running (#36 follow-up). Only the
   * running-jobs refusal is skipped: the jobs are stopped by the normal
   * shutdown path and their count is recorded on the pending switch and
   * the outcome as `interruptedJobs`. A submit in flight, a pending
   * switch, the gate, and the installed-build check still refuse.
   */
  force?: boolean;
}

/**
 * One job blocking a switch: enough for the picker to name it
 * (kind + label, review, state). The list is capped server-side
 * (`UPDATE_BLOCKED_JOBS_CAP` in the service); `activeJobs` on the body
 * carries the full count so the UI can add "+N more".
 */
export interface UpdateBlockedJob {
  id: string;
  kind: string;
  reviewId?: string;
  state: string;
  /** Human line when the job has one (progress, else card/thread id). */
  label?: string;
}

/**
 * 409 body when a switch is refused for running jobs (#36 follow-up).
 * `error` keeps the human sentence (backwards compatible); `code` plus
 * the count and the short job list let the UI render without parsing
 * it. Used only here — the smallest coded-error shape that fits.
 */
export interface UpdateJobsBlockedBody {
  error: string;
  code: "jobs-running";
  activeJobs: number;
  jobs: UpdateBlockedJob[];
}

/**
 * 202 when the helper is spawned (the service then shuts down), 200 with
 * `unchanged` when the installed build already matches the published one.
 */
export interface UpdateSwitchResponse {
  from: string;
  to: string;
  /** True when nothing was done (same channel, same commit). */
  unchanged?: boolean;
}

/** A switch the service committed to and is shutting down for. */
export interface UpdatePendingSwitch {
  from: string;
  to: string;
  /** ISO time the switch was committed. */
  startedAt: string;
  /**
   * Jobs running at commit time on a forced switch (#36 follow-up):
   * stopped by the normal shutdown path, visible as interrupted
   * afterwards (resume or retry them from the review; on a different
   * channel they stay with this channel's data). Absent otherwise.
   */
  interruptedJobs?: number;
}

/**
 * The helper's verdict, written to the data dir and surfaced on next
 * start: `ok`, `rolled-back` (back on the old build + reason), or
 * `failed` (even the rollback did not come up).
 */
export interface SwitchOutcome {
  status: "ok" | "rolled-back" | "failed";
  from: string;
  to: string;
  /** Why a rollback/failure happened; absent on clean `ok`. */
  reason?: string;
  /** Helper log file (in the data dir) with the full step trace. */
  logPath?: string;
  /** ISO time the outcome was recorded. */
  finishedAt: string;
  /**
   * Jobs stopped by a forced switch (copied from the pending record,
   * #36 follow-up). The UI names the count after the reload.
   */
  interruptedJobs?: number;
}

/**
 * `GET /api/update/status` — always available (even with the picker
 * gated off): gate state, running build, pending switch, last outcome.
 */
export interface UpdateStatusResponse {
  enabled: boolean;
  build: UpdateBuildInfo | null;
  pending: UpdatePendingSwitch | null;
  outcome: SwitchOutcome | null;
}

// --- WebSocket events ----------------------------------------------------
/**
 * WS `/api/events?review=:id` event union: job progress, streamed text,
 * and state patches.
 *
 * ### State-patch shape (contract decision)
 *
 * Patches are RFC 6902-style JSON Patch ops scoped to the review snapshot:
 *
 * ```ts
 * { type: "patch", baseRev: 41, headRev: 42,
 *   ops: [{ op: "replace", path: "/cards/c-central/blocks", value: [...] }] }
 * ```
 *
 * - `path` is a JSON Pointer (RFC 6901) relative to the snapshot root
 *   (`/pages`, `/annotations`, `/hunkStates`, …).
 * - `op` is one of `add` | `remove` | `replace`.
 * - `baseRev` is the snapshot revision the ops apply to; clients that have
 *   drifted re-fetch the snapshot instead of applying.
 * - Full-snapshot resync is `{ type: "snapshot", snapshot }`.
 *
 * The web store applies ops in order and bumps its local `rev` to `headRev`.
 */
export type StatePatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };

export type ReviewEvent =
  | { type: "job"; job: Job }
  | { type: "text"; jobId: string; cardId?: string; annotationId?: string; delta: string }
  | { type: "patch"; baseRev: number; headRev: number; ops: StatePatchOp[] }
  | { type: "snapshot"; snapshot: ReviewSnapshot }
  | { type: "error"; message: string; jobId?: string };

/** Re-exported entity slices used by route stubs. */
export type { Annotation, Card, Page };
