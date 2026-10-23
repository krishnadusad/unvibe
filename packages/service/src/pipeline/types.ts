/**
 * Pipeline public types (M3): the reusable seam the next agents build on.
 *
 * `runInFork` handles base lookup/rebuild, fork-or-continue, L4 rendering,
 * job bookkeeping, streaming, validation + repair, and returns parsed
 * content + trailing JSON. `runSmall` is the small-model equivalent (no
 * fork, no base). See `docs/pipeline.md` for the worked example.
 */
import type { Job, JobKind, ParsedCard, ReplyData, TokenUsage } from "@unvibe/shared";
import type { ValidationReport } from "../validate/index.js";

export interface RunInForkOptions {
  reviewId: string;
  /** Job kind for bookkeeping (e.g. "go-deeper", "explain"). */
  kind: JobKind;
  /** Prompt template name (e.g. "go_deeper", "critic"). */
  template: string;
  /** Template variables (rendered deterministically; may nest for `{{a.b}}`). */
  variables: Record<string, unknown>;
  priority: number;
  dedupeKey?: { anchor: string; requestKind: string; depth?: string; baseVersion: string };
  cardId?: string;
  /**
   * M5 shared context (PRD §9.3): persistent conversation the turn belongs
   * to (e.g. a thread id). The next turn's L4 gets the filtered change list
   * since this conversation's cursor, and the cursor advances only when the
   * turn succeeds. Absent = one-shot fork (change list = unappended tail).
   */
  conversationKey?: string;
  /** Hunk content hash the conversation is anchored on (change-list filter). */
  hunkHash?: string;
  /** Annotation the turn belongs to (contribution labelling; WS correlation). */
  annotationId?: string;
  /**
   * Issue #136: continue on an existing conversation session instead of
   * forking the base. The session is ensured (reopened/rebuilt) inside
   * the job; a rebuild loses history past the base, so the caller sends
   * the full prompt (stored turns as "conversation so far") when it
   * expects one. Every later turn of a conversation card runs this way.
   */
  continueSessionId?: string;
  /**
   * Connection retry on a fresh fork (continued turns): when a turn
   * observably hits a dead review-MCP URL it retries once on a fresh
   * fork instead of the dead session. The short follow-up prompt assumes
   * the live session's history, so the retry re-renders `retryTemplate`
   * over `retryVariables` (the full first-turn variable set, including
   * the stored turns as the `thread` transcript).
   */
  retryTemplate?: string;
  retryVariables?: Record<string, unknown>;
  /** Called with newly finished cards as they stream in. */
  onPartial?: (cards: ParsedCard[]) => void | Promise<void>;
  /**
   * A reply with no cards is normally a failed turn. Return true for
   * replies whose trailing JSON alone is a valid answer (a custom guide's
   * clarifying question).
   */
  acceptEmpty?: (data: ReplyData | null) => boolean;
  /**
   * Skip feeding the turn's contributions into the review's shared
   * context. Custom guides set this: their notes and questions belong to
   * the guide, not to the main guide's later turns.
   */
  skipIngest?: boolean;
  /**
   * Issue #50: strings an echo of which must not open the reply body
   * (the selection, the question, the stored card title). Each parsed
   * card additionally matches its own title. Absent = no stripping;
   * streaming partials stay raw and the final apply corrects them.
   */
  echoCandidates?: string[];
  signal?: AbortSignal;
  /** Extra replay marker for the ReplayAgentRunner (demo/tests). */
  replay?: { kind: string; key?: string };
  /**
   * M4: called with the enqueued job once it exists (after the base
   * lookup). Lets action handlers return the `jobId` without awaiting
   * the agent result.
   */
  onJob?: (job: Job) => void;
}

export interface RunInForkResult {
  job: Job;
  /** Full reply text (Markdown + trailing JSON). */
  text: string;
  /** Parsed cards (finished). */
  cards: ParsedCard[];
  /** Trailing JSON (null when missing). */
  data: ReplyData | null;
  /** Citation validation report for the final reply. */
  validation: ValidationReport;
  usage: TokenUsage;
  /** True when the fork path was used (false = fresh-session fallback). */
  viaFork: boolean;
  /** True when a repair turn was sent (needsRepairTurn fired). */
  repaired: boolean;
}

export interface RunSmallOptions {
  reviewId: string;
  kind: JobKind;
  template: string;
  variables: Record<string, unknown>;
  priority: number;
  dedupeKey?: { anchor: string; requestKind: string; depth?: string; baseVersion: string };
  cardId?: string;
  /** Issue #136: annotation the streamed text belongs to (conversation fills). */
  annotationId?: string;
  signal?: AbortSignal;
  replay?: { kind: string; key?: string };
  /** M4: called with the enqueued job once it exists (see above). */
  onJob?: (job: Job) => void;
}

export type RunSmallResult = RunInForkResult;
