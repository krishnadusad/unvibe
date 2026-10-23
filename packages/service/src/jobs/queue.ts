/**
 * Priority job queue (PRD §12).
 *
 * - Per-provider concurrency cap (default 16, injectable so it can follow
 *   the `sessionsPerProvider` setting).
 * - Priority order: user-requested > visible > background
 *   (`JOB_PRIORITY` in `@unvibe/shared`); raisable while queued.
 * - Rate-limit back-off: a job's `run` throws {@link RetryableError} for
 *   exponential back-off with injected jitter (deterministic in tests);
 *   the job visibly sits in `backing-off`.
 * - Cancellation through `AbortSignal`, while queued, backing off, or
 *   running. An abort always wins over a late success.
 * - Dedupe: identical requests (anchor, kind, depth, base version) share
 *   one job/result while the first is still active.
 * - Every state change, usage report and streamed-text delta is emitted
 *   as a shared `ReviewEvent` via `onEvent`, for the review's event bus.
 * - Jobs persist through `JobPersistence` so the Jobs view survives a
 *   restart; `recover()` marks every open job interrupted (terminal).
 */
import { randomUUID } from "node:crypto";
import {
  jobDedupeKeyString,
  type AccessMode,
  type Job,
  type JobDedupeKey,
  type JobKind,
  type JobTurnRecord,
  type ReviewEvent,
  type TokenUsage,
} from "@unvibe/shared";
import { computeBackoffDelay } from "./backoff.js";
import { MathRandom, RealClock, type Clock, type RandomSource } from "./clock.js";
import { isAbortError, partialUsageOf, RetryableError, type PartialUsageCarrier } from "./errors.js";
import type { JobPersistence } from "./store.js";
import { reportError } from "../telemetry/sentry.js";

export const DEFAULT_CONCURRENCY_CAP = 16;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;
/**
 * #123/#182: small-model jobs (hunk summaries) run in their own concurrency
 * bucket per provider, so the hunk pass never queues behind main-model
 * critics. Both buckets use the same per-provider cap
 * (`getConcurrencyCap`, the `sessionsPerProvider` setting, read live on
 * every pump), so the setting bounds each bucket separately. Provider
 * rate limits still surface as retryable errors and back off through
 * the usual schedule.
 */
const SMALL_JOB_KINDS: ReadonlySet<JobKind> = new Set(["hunk-pass", "summarize", "consolidate", "guide-suggestions"]);
export const INTERRUPTED_MESSAGE = "stopped because the service restarted — retry to run it again";

/** Context handed to a job's `run` function. */
export interface JobContext {
  /** Aborts when the job is cancelled (e.g. its card closed). */
  signal: AbortSignal;
  /** Accumulate token usage; republishes the job event. */
  reportUsage(usage: Partial<TokenUsage>): void;
  /** Stream a text delta; published as a `text` ReviewEvent. */
  reportText(delta: string): void;
  /** Record the exact prompt sent (Settings links to it). */
  setPromptSnapshot(text: string): void;
  /** Record the agent session backing this job. */
  setSessionId(id: string): void;
  /**
   * Issue #160: record one agent tool call on the job (shown on the
   * Debug page). `detail` is best-effort argument text from the adapter.
   * Issue #207: an `end` call (extra.status) attaches its truncated
   * `result` to the matching call, on the flat list and on the turn.
   */
  reportTool(
    name: string,
    detail?: string,
    extra?: { id?: string; result?: string; status?: "start" | "end" },
  ): void;
  /** Record the agent's `degraded` reason for a kept answer (Debug page). */
  setDegradedReason(reason: string): void;
  /** Issue #194: start a timed agent turn (e.g. "first", "repair"). */
  beginTurn(label: string, prompt?: string): void;
  /** Issue #194: finish the current timed turn started by `beginTurn`. */
  endTurn(): void;
  /**
   * Issue #207: record the exact prompt of the agent turn now starting
   * (called by the streaming collectors, which know the prompt). Lands
   * on the open turn record, or opens an implicit one.
   */
  setTurnPrompt(text: string): void;
  /**
   * Issue #207: record one turn's derived usage and, when the runner
   * sent it, its raw usage payload (stored verbatim) on the open turn.
   */
  reportTurnUsage(usage: TokenUsage, raw?: unknown): void;
}

export type JobFn = (ctx: JobContext) => Promise<void>;

export interface EnqueueOptions {
  reviewId: string;
  kind: JobKind;
  provider: string;
  model: string;
  /** Thinking level the job runs with (issue #172), "" for the adapter default. */
  effort: string;
  priority: number;
  dedupe?: JobDedupeKey;
  promptSnapshot?: string;
  sessionId?: string;
  /**
   * Issue #160: posture stamp override. Background jobs (which always
   * run locked down — see `postureFor`) pass it explicitly; otherwise
   * the queue's `getAccessMode` decides.
   */
  accessMode?: AccessMode;
  /**
   * Card the job works on, when card-scoped (depth/examples/diagram/
   * generate/concept/second-opinion). Carried on the job itself (so
   * snapshots, WS events and the debug views can match it) as well as on
   * the entry (for `text` events).
   */
  cardId?: string;
  /** Issue #136: annotation the streamed text belongs to (conversation fills). */
  annotationId?: string;
  run: JobFn;
}

export interface QueueOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  clock?: Clock;
  random?: RandomSource;
  /** Per-provider running-job cap. Defaults to a constant 4. */
  getConcurrencyCap?: (provider: string) => number;
  /** Sink for ReviewEvents (wired to the review's EventBus by the service). */
  onEvent?: (reviewId: string, event: ReviewEvent) => void;
  persist?: JobPersistence | null;
  /**
   * Issue #160: the agent-access posture to stamp on each enqueued job
   * (`job.accessMode`). Absent → no stamp (queues built directly in
   * tests). The service wires this from settings.
   */
  getAccessMode?: () => AccessMode | undefined;
  /**
   * Issue #160: post-job hook, run after `run` resolves (success or
   * non-abort failure) and before the job settles. Receives the live job
   * object and may mutate it (e.g. set `checkoutReset`). Never fails the
   * job: throws are caught and reported. Skipped for cancelled jobs.
   */
  afterRun?: (job: Job) => Promise<void> | void;
}

interface Entry {
  job: Job;
  run?: JobFn;
  reviewId: string;
  cardId?: string;
  annotationId?: string;
  seq: number;
  abort?: AbortController;
  /** Streamed reply text, accumulated for `replySnapshot` on failure (#180). */
  replyText?: string;
  /** Issue #207: the open turn record (also the last of `job.turnRecords`). */
  currentTurn?: JobTurnRecord;
  /** Issue #207: prompt snapshot already consumed by earlier turns. */
  snapshotBaseline?: string;
}

/** Cap on a stored failed reply: enough to read, bounded for the DB. */
const REPLY_SNAPSHOT_CAP = 100_000;

/** Issue #207: size caps for stored turn records. */
export const TURN_PROMPT_CAP = 20_000;
export const TURN_OUTPUT_CAP = 20_000;
export const TOOL_RESULT_CAP = 2_000;
export const TOOL_DETAIL_CAP = 2_000;

/** Truncate with a marker naming the original length (#207). */
export function truncateForRecord(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [truncated: showing ${cap} of ${text.length} chars]`;
}

function cloneRaw(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(raw)) as unknown;
  } catch {
    return raw;
  }
}

function copy(job: Job): Job {
  return {
    ...job,
    usage: job.usage ? { ...job.usage } : undefined,
    tools: job.tools ? job.tools.map((t) => ({ ...t })) : undefined,
    attemptTimings: job.attemptTimings ? job.attemptTimings.map((t) => ({ ...t })) : undefined,
    turns: job.turns ? job.turns.map((t) => ({ ...t })) : undefined,
    turnRecords: job.turnRecords
      ? job.turnRecords.map((t) => ({
          ...t,
          tools: t.tools.map((x) => ({ ...x })),
          usage: t.usage ? { ...t.usage } : undefined,
          rawUsage: cloneRaw(t.rawUsage),
        }))
      : undefined,
  };
}

/** Cap on tool calls recorded per job (issue #160). */
export const MAX_JOB_TOOLS = 100;

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly dedupe = new Map<string, string>();
  private seq = 0;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly getConcurrencyCap: (provider: string) => number;
  private readonly onEvent: (reviewId: string, event: ReviewEvent) => void;
  private readonly persist: JobPersistence | null;
  private readonly getAccessMode: () => AccessMode | undefined;
  private readonly afterRun: (job: Job) => Promise<void> | void;
  private drainWaiters: Array<() => void> = [];

  constructor(opts: QueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.clock = opts.clock ?? new RealClock();
    this.random = opts.random ?? new MathRandom();
    this.getConcurrencyCap = opts.getConcurrencyCap ?? (() => DEFAULT_CONCURRENCY_CAP);
    this.onEvent = opts.onEvent ?? (() => {});
    this.persist = opts.persist ?? null;
    this.getAccessMode = opts.getAccessMode ?? (() => undefined);
    this.afterRun = opts.afterRun ?? (() => {});
  }

  // -- enqueue --------------------------------------------------------

  enqueue(opts: EnqueueOptions): Job {
    const dedupeKey = opts.dedupe ? jobDedupeKeyString(opts.dedupe) : undefined;
    if (dedupeKey) {
      const existing = this.dedupe.get(dedupeKey);
      if (existing) {
        const entry = this.entries.get(existing);
        if (entry && !isTerminal(entry.job.state)) return copy(entry.job);
        this.dedupe.delete(dedupeKey);
      }
    }
    const job: Job = {
      id: randomUUID(),
      kind: opts.kind,
      model: opts.model,
      provider: opts.provider,
      effort: opts.effort,
      reviewId: opts.reviewId,
      priority: opts.priority,
      state: "queued",
      attempts: 0,
      queuedAt: this.clock.now(),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.promptSnapshot !== undefined ? { promptSnapshot: opts.promptSnapshot } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(opts.annotationId ? { annotationId: opts.annotationId } : {}),
      ...(opts.cardId ? { cardId: opts.cardId } : {}),
    };
    // Issue #160: stamp the posture this job was enqueued under. The
    // session itself keeps the posture it started with (base key); a
    // settings flip between enqueue and session start lands the job on
    // the new base while this stamp still names the old one — a
    // seconds-wide window, stated in the docs.
    const accessMode = opts.accessMode ?? this.getAccessMode();
    if (accessMode !== undefined) job.accessMode = accessMode;
    const entry: Entry = {
      job,
      run: opts.run,
      reviewId: opts.reviewId,
      cardId: opts.cardId,
      ...(opts.annotationId ? { annotationId: opts.annotationId } : {}),
      seq: this.seq++,
    };
    // #221: persist before registering in memory. If the store throws,
    // the error surfaces to the caller and no orphan entry (queued,
    // 0 attempts, never runnable) is left in entries/dedupe.
    this.save(entry);
    this.entries.set(job.id, entry);
    if (dedupeKey) this.dedupe.set(dedupeKey, job.id);
    this.emit(entry);
    this.pump();
    return copy(job);
  }

  // -- reads ----------------------------------------------------------

  get(id: string): Job | undefined {
    const entry = this.entries.get(id);
    return entry ? copy(entry.job) : undefined;
  }

  listByReview(reviewId: string): Job[] {
    return [...this.entries.values()]
      .filter((e) => e.reviewId === reviewId)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => {
        const job = copy(e.job);
        // Prompt and reply snapshots ride separately
        // (`GET /api/jobs/:id/output`, `GET /api/jobs/:id/reply`): lists
        // stay small after hundreds of jobs (PRD §16 snapshot size).
        // `get()` keeps the full job.
        delete job.promptSnapshot;
        delete job.replySnapshot;
        delete job.turnRecords;
        return job;
      });
  }

  /**
   * Jobs that are not yet terminal (queued, running, backing-off).
   * Orphaned entries without a `run` function (found at startup, awaiting
   * `rebind`) are skipped, matching {@link drain}'s definition of done —
   * they can never execute, so they must not block idle exit.
   */
  activeCount(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.run === undefined) continue;
      if (!isTerminal(e.job.state)) n += 1;
    }
    return n;
  }

  /**
   * The same non-terminal set `activeCount` counts, oldest first, capped
   * at `limit`. The version-picker switch route reports these so the UI
   * can name what's running instead of refusing with a bare count
   * (issue #36 follow-up: switch with running jobs).
   */
  listActive(limit = 5): Job[] {
    const ordered = [...this.entries.values()].sort((a, b) => a.seq - b.seq);
    const out: Job[] = [];
    for (const e of ordered) {
      if (e.run === undefined) continue;
      if (isTerminal(e.job.state)) continue;
      out.push(copy(e.job));
      if (out.length >= limit) break;
    }
    return out;
  }

  // -- priority -------------------------------------------------------

  /** Raise (or lower) a job's priority; takes effect while queued. */
  setPriority(id: string, priority: number): Job {
    const entry = this.required(id);
    entry.job.priority = priority;
    this.save(entry);
    this.emit(entry);
    this.pump();
    return copy(entry.job);
  }

  /**
   * Re-target a job at a new card (issue #152: promote moves a
   * conversation's fill to a page card while it runs, so the page shows
   * the working state through the usual `cardId` match). The job keeps
   * running; only its address changes.
   */
  retarget(id: string, cardId: string): Job {
    const entry = this.required(id);
    entry.job.cardId = cardId;
    entry.cardId = cardId;
    this.save(entry);
    this.emit(entry);
    return copy(entry.job);
  }

  // -- cancellation ---------------------------------------------------

  /** Cancel a job: immediate while queued/backing-off, abort while running. */
  cancel(id: string): Job {
    const entry = this.required(id);
    if (isTerminal(entry.job.state)) return copy(entry.job);
    entry.abort?.abort();
    this.closeAttempt(entry);
    entry.job.finishedAt = this.clock.now();
    entry.job.state = "cancelled";
    entry.job.error = undefined;
    entry.job.nextRetryAt = undefined;
    if (entry.replyText) entry.job.replySnapshot = entry.replyText;
    this.forgetDedupe(entry);
    this.save(entry);
    this.emit(entry);
    this.checkDrain();
    return copy(entry.job);
  }

  /**
   * Drop every entry for a review (review delete, #115 redo). Without
   * this, finished jobs linger in memory after their rows are deleted, so
   * the jobs endpoint keeps listing a deleted review's jobs. Dedupe keys
   * go too, so a re-opened review starts clean. Callers cancel live jobs
   * first; a detached run settling afterwards still saves once
   * (pre-existing cancel-then-settle race, unchanged).
   */
  dropReview(reviewId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.reviewId !== reviewId) continue;
      this.forgetDedupe(entry);
      this.entries.delete(id);
    }
    this.checkDrain();
  }

  // -- retry / rebind -------------------------------------------------

  /**
   * Retry a terminal job under the same id (used after errors and after
   * a restart marked jobs interrupted). Reuses the stored `run` when no
   * new one is given; throws when neither exists.
   */
  retry(id: string, run?: JobFn): Job {
    const entry = this.required(id);
    if (!isTerminal(entry.job.state)) return copy(entry.job);
    if (run) entry.run = run;
    if (!entry.run) throw new Error(`JobQueue.retry: no run function for job ${id}`);
    entry.job.state = "queued";
    entry.job.attempts = 0;
    entry.job.queuedAt = this.clock.now();
    entry.job.startedAt = undefined;
    entry.job.finishedAt = undefined;
    entry.job.attemptTimings = undefined;
    entry.job.turns = undefined;
    entry.job.error = undefined;
    entry.job.nextRetryAt = undefined;
    entry.job.replySnapshot = undefined;
    entry.replyText = undefined;
    entry.job.turnRecords = undefined;
    entry.currentTurn = undefined;
    entry.snapshotBaseline = undefined;
    if (entry.job.dedupeKey) this.dedupe.set(entry.job.dedupeKey, entry.job.id);
    this.save(entry);
    this.emit(entry);
    this.pump();
    return copy(entry.job);
  }

  /**
   * Attach a `run` function to a job entry that lost it. `recover()` no
   * longer produces such entries (open jobs come back interrupted), so
   * this is only for hand-built queues in tests.
   */
  rebind(id: string, run: JobFn): Job {
    const entry = this.required(id);
    entry.run = run;
    this.pump();
    return copy(entry.job);
  }

  // -- restart recovery -------------------------------------------------

  /**
   * Reconcile jobs persisted by a previous process (issue #117: pass every
   * stored job, so finished jobs stay listed after a restart). Every open
   * job — running, backing off, or still queued — is marked interrupted
   * (terminal `error`, retryable by re-enqueueing). Queued jobs come back
   * as interrupted rather than orphans: nothing in the service rebinds a
   * persisted job to a fresh `run` (pipeline stages re-enqueue via
   * `resumeReview`, on-demand turns rebuild via the action retry paths),
   * so an orphan could never execute — and worse, its dedupe key would
   * make a fresh re-enqueue silently attach to the dead job. Finished
   * jobs (done, error, cancelled) load back unchanged as history: the
   * Jobs view lists them with their prompts and results. Hydrated entries
   * carry no `run`, so they never execute, never count as active, and
   * never block idle exit.
   */
  recover(savedJobs: Job[]): { interrupted: Job[]; orphaned: Job[] } {
    const interrupted: Job[] = [];
    const orphaned: Job[] = [];
    for (const saved of savedJobs) {
      if (this.entries.has(saved.id)) continue;
      const open = !isTerminal(saved.state);
      const job: Job = open
        ? {
            ...saved,
            state: "error",
            error: INTERRUPTED_MESSAGE,
            nextRetryAt: undefined,
          }
        : { ...saved };
      this.entries.set(job.id, {
        job,
        run: undefined,
        reviewId: job.reviewId ?? "",
        ...(job.cardId ? { cardId: job.cardId } : {}),
        seq: this.seq++,
      });
      const entry = this.entries.get(job.id)!;
      // The dead job must not block a fresh re-enqueue under the same key.
      this.forgetDedupe(entry);
      this.save(entry);
      this.emit(entry);
      if (open) interrupted.push(copy(job));
    }
    return { interrupted, orphaned };
  }

  /** Abort everything; used on service shutdown. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      if (!isTerminal(entry.job.state)) {
        entry.abort?.abort();
        this.closeAttempt(entry);
        entry.job.finishedAt = this.clock.now();
        entry.job.state = "cancelled";
        entry.job.nextRetryAt = undefined;
        if (entry.replyText) entry.job.replySnapshot = entry.replyText;
        this.save(entry);
        this.emit(entry);
      }
    }
    this.dedupe.clear();
    this.checkDrain();
  }

  /** Test helper: resolve once no runnable job is active or pending. */
  async drain(timeoutMs = 5000): Promise<void> {
    if (this.isDrained()) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drainWaiters = this.drainWaiters.filter((w) => w !== done);
        reject(new Error("JobQueue.drain: timed out"));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.drainWaiters.push(done);
    });
  }

  // -- internals --------------------------------------------------------

  private required(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`JobQueue: unknown job ${id}`);
    return entry;
  }

  /** Start queued jobs while per-provider caps allow, highest priority first. */
  private pump(): void {
    const queued = [...this.entries.values()]
      .filter((e) => e.job.state === "queued" && e.run !== undefined)
      .sort((a, b) => b.job.priority - a.job.priority || a.seq - b.seq);
    // Caps and running counts are read once per pump, not once per queued
    // job: the cap lookup reads the live setting (a store read in the
    // service), and a large fan-out (hundreds of hunk jobs) pumps on every
    // settle, so per-entry lookups made big runs quadratic in store reads.
    const caps = new Map<string, number>();
    const running = new Map<string, number>();
    for (const e of this.entries.values()) {
      if (e.job.state !== "running") continue;
      const key = `${e.job.provider ?? ""}|${SMALL_JOB_KINDS.has(e.job.kind)}`;
      running.set(key, (running.get(key) ?? 0) + 1);
    }
    for (const entry of queued) {
      const provider = entry.job.provider ?? "";
      const small = SMALL_JOB_KINDS.has(entry.job.kind);
      let cap = caps.get(provider);
      if (cap === undefined) {
        cap = this.getConcurrencyCap(provider);
        caps.set(provider, cap);
      }
      const key = `${provider}|${small}`;
      const n = running.get(key) ?? 0;
      if (n >= cap) continue;
      running.set(key, n + 1);
      void this.execute(entry);
    }
  }

  /** Issue #194: close the open attempt timing and any open turn. */
  private closeAttempt(entry: Entry): void {
    const now = this.clock.now();
    const timings = entry.job.attemptTimings;
    const open = timings?.[timings.length - 1];
    if (open && open.finishedAt === undefined) open.finishedAt = now;
    for (const turn of entry.job.turns ?? []) {
      if (turn.finishedAt === undefined) turn.finishedAt = now;
    }
    this.closeTurnRecord(entry);
  }

  /** Issue #207: finish the open turn record, stamping its truncation marker. */
  private closeTurnRecord(entry: Entry): void {
    const turn = entry.currentTurn;
    if (!turn) return;
    if (turn.finishedAt === undefined) turn.finishedAt = this.clock.now();
    if (turn.outputOriginalLength > TURN_OUTPUT_CAP && !turn.output.includes("[truncated:")) {
      turn.output = `${turn.output.slice(0, TURN_OUTPUT_CAP)}\n… [truncated: showing ${TURN_OUTPUT_CAP} of ${turn.outputOriginalLength} chars]`;
    }
    entry.currentTurn = undefined;
  }

  /** Issue #207: store a turn prompt (capped, with its original length). */
  private setRecordPrompt(turn: JobTurnRecord, text: string): void {
    turn.prompt = truncateForRecord(text, TURN_PROMPT_CAP);
    turn.promptOriginalLength = text.length;
  }

  /**
   * Issue #207: the open turn record, opening an implicit one when a
   * turn's events arrive without a `beginTurn` (diagram repairs and
   * other untimed turns inside a job).
   */
  private openTurn(entry: Entry): JobTurnRecord {
    if (entry.currentTurn) return entry.currentTurn;
    const label = (entry.job.turnRecords?.length ?? 0) === 0 ? "first" : "follow-up";
    const turn: JobTurnRecord = { label, output: "", outputOriginalLength: 0, tools: [], startedAt: this.clock.now() };
    entry.job.turnRecords = [...(entry.job.turnRecords ?? []), turn];
    entry.currentTurn = turn;
    return turn;
  }

  /** Issue #207: per-turn prompt segment from the cumulative snapshot. */
  private deriveTurnPrompt(entry: Entry): string | undefined {
    const snapshot = entry.job.promptSnapshot;
    if (!snapshot) return undefined;
    const base = entry.snapshotBaseline ?? "";
    const segment = snapshot.startsWith(base) ? snapshot.slice(base.length) : snapshot;
    entry.snapshotBaseline = snapshot;
    const stripped = segment.replace(/^\n\n--- [^\n]+ ---\n/, "");
    return stripped === "" ? undefined : stripped;
  }

  private async execute(entry: Entry): Promise<void> {
    const job = entry.job;
    job.state = "running";
    job.attempts = (job.attempts ?? 0) + 1;
    job.nextRetryAt = undefined;
    // Issue #194: timing stamps (first start kept across back-off retries).
    const now = this.clock.now();
    if (job.startedAt === undefined) job.startedAt = now;
    job.attemptTimings = [...(job.attemptTimings ?? []), { attempt: job.attempts, startedAt: now }];
    const controller = new AbortController();
    entry.abort = controller;
    this.save(entry);
    this.emit(entry);

    const ctx = this.makeContext(entry, controller);
    try {
      await entry.run!(ctx);
      if (!controller.signal.aborted) await this.runAfterHook(entry);
      this.settle(entry, controller, controller.signal.aborted ? "cancelled" : "done");
    } catch (err) {
      // Issue #151 backstop: a turn that ended early carries its counted
      // usage on the error; record it on the job unless the run already
      // did (marked on the error, so never twice).
      const partial = partialUsageOf(err);
      if (partial && !(err as PartialUsageCarrier).partialUsageReported) {
        (err as PartialUsageCarrier).partialUsageReported = true;
        ctx.reportUsage(partial);
      }
      if (controller.signal.aborted || isAbortError(err)) {
        this.settle(entry, controller, "cancelled");
        return;
      }
      if (err instanceof RetryableError && (job.attempts ?? 1) < this.maxAttempts) {
        await this.backOff(entry, controller, err);
        return;
      }
      job.error = err instanceof Error ? err.message : String(err);
      reportError(err, { jobId: job.id, kind: job.kind, provider: job.provider, attempts: job.attempts });
      // The agent may have touched the checkout before failing: verify it
      // too, before the job settles as error.
      await this.runAfterHook(entry);
      this.settle(entry, controller, "error");
    }
  }

  /** Run the post-job hook; never fails the job. */
  private async runAfterHook(entry: Entry): Promise<void> {
    try {
      await this.afterRun(entry.job);
    } catch (err) {
      reportError(err, { jobId: entry.job.id, kind: entry.job.kind, hook: "afterRun" });
    }
  }

  private async backOff(entry: Entry, controller: AbortController, err: RetryableError): Promise<void> {
    const job = entry.job;
    this.closeAttempt(entry);
    const attemptIndex = (job.attempts ?? 1) - 1;
    const delay = computeBackoffDelay(attemptIndex, this.backoffBaseMs, this.backoffMaxMs, this.random.next());
    job.state = "backing-off";
    job.error = err.message;
    job.nextRetryAt = this.clock.now() + delay;
    this.save(entry);
    this.emit(entry);
    try {
      await this.clock.sleep(delay, controller.signal);
    } catch (sleepErr) {
      if (controller.signal.aborted || isAbortError(sleepErr)) {
        this.settle(entry, controller, "cancelled");
        return;
      }
      job.error = sleepErr instanceof Error ? sleepErr.message : String(sleepErr);
      this.settle(entry, controller, "error");
      return;
    }
    if (controller.signal.aborted) {
      this.settle(entry, controller, "cancelled");
      return;
    }
    job.state = "queued";
    job.nextRetryAt = undefined;
    this.save(entry);
    this.emit(entry);
    entry.abort = undefined;
    this.pump();
    this.checkDrain();
  }

  private settle(entry: Entry, controller: AbortController, state: Job["state"]): void {
    if (entry.abort === controller) entry.abort = undefined;
    this.closeAttempt(entry);
    if (isTerminal(state)) entry.job.finishedAt = this.clock.now();
    entry.job.state = state;
    if (state !== "backing-off") entry.job.nextRetryAt = undefined;
    if (state === "cancelled") entry.job.error = undefined;
    // A failed job keeps its reply for the Debug page (#180).
    if ((state === "error" || state === "cancelled") && entry.replyText) {
      entry.job.replySnapshot = entry.replyText;
    }
    if (isTerminal(state)) this.forgetDedupe(entry);
    this.save(entry);
    this.emit(entry);
    this.pump();
    this.checkDrain();
  }

  private makeContext(entry: Entry, controller: AbortController): JobContext {
    const job = entry.job;
    return {
      signal: controller.signal,
      reportUsage: (usage) => {
        job.usage = {
          inputTokens: (job.usage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
          cachedReadTokens: (job.usage?.cachedReadTokens ?? 0) + (usage.cachedReadTokens ?? 0),
          cachedWriteTokens: (job.usage?.cachedWriteTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
          outputTokens: (job.usage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        };
        // Read share (#125, M0 spike pitfall #2): inputTokens counts
        // UNCACHED input only, so the rate is read/(input+read+write),
        // never cached/input (which can exceed 1); writes never count.
        const total = job.usage.inputTokens + job.usage.cachedReadTokens + job.usage.cachedWriteTokens;
        job.cacheHitRate = total > 0 ? job.usage.cachedReadTokens / total : undefined;
        this.save(entry);
        this.emit(entry);
      },
      reportText: (delta) => {
        // Keep the streamed reply so a failed job can show it on the
        // Debug page (#180); stamped onto the job only on failure.
        if ((entry.replyText?.length ?? 0) < REPLY_SNAPSHOT_CAP) {
          entry.replyText = ((entry.replyText ?? "") + delta).slice(0, REPLY_SNAPSHOT_CAP);
        }
        // Issue #207: the same stream lands on the open turn record, for
        // every job (not only failures), capped per turn.
        const turn = this.openTurn(entry);
        turn.outputOriginalLength += delta.length;
        if (turn.output.length < TURN_OUTPUT_CAP) {
          turn.output = (turn.output + delta).slice(0, TURN_OUTPUT_CAP);
        }
        this.onEvent(entry.reviewId, {
          type: "text",
          jobId: job.id,
          ...(entry.cardId ? { cardId: entry.cardId } : {}),
          ...(entry.annotationId ? { annotationId: entry.annotationId } : {}),
          delta,
        });
      },
      setPromptSnapshot: (text) => {
        job.promptSnapshot = text;
        this.save(entry);
        this.emit(entry);
      },
      setSessionId: (id) => {
        job.sessionId = id;
        this.save(entry);
        this.emit(entry);
      },
      reportTool: (name, detail, extra) => {
        const status = extra?.status ?? "start";
        const turn = this.openTurn(entry);
        if (status === "end") {
          // Attach the truncated result to the matching call: by adapter
          // id when present, else the last unfinished call of this name.
          const match = (list: Job["tools"]) =>
            list
              ? [...list].reverse().find((t) => (extra?.id ? t.id === extra.id : t.name === name && t.finishedAt === undefined))
              : undefined;
          const flat = match(job.tools);
          if (flat) {
            flat.finishedAt = this.clock.now();
            if (extra?.result !== undefined) {
              flat.result = truncateForRecord(extra.result, TOOL_RESULT_CAP);
              flat.resultOriginalLength = extra.result.length;
            }
            // The start event may carry no arguments yet (adapters stream
            // them in on later updates); backfill from the end event.
            if (detail !== undefined && (flat.detail === undefined || flat.detail === "{}")) {
              flat.detail = truncateForRecord(detail, TOOL_DETAIL_CAP);
            }
          }
          let rec = match(turn.tools);
          if (!rec) {
            rec = { name, ...(extra?.id ? { id: extra.id } : {}), startedAt: this.clock.now() };
            turn.tools = [...turn.tools, rec];
          }
          rec.finishedAt = this.clock.now();
          if (extra?.result !== undefined) {
            rec.result = truncateForRecord(extra.result, TOOL_RESULT_CAP);
            rec.resultOriginalLength = extra.result.length;
          }
          if (detail !== undefined && (rec.detail === undefined || rec.detail === "{}")) rec.detail = truncateForRecord(detail, TOOL_DETAIL_CAP);
          this.save(entry);
          this.emit(entry);
          return;
        }
        if ((job.tools?.length ?? 0) < MAX_JOB_TOOLS) {
          const tools = [...(job.tools ?? [])];
          tools.push({
            name,
            ...(extra?.id ? { id: extra.id } : {}),
            ...(detail !== undefined ? { detail: truncateForRecord(detail, TOOL_DETAIL_CAP) } : {}),
            startedAt: this.clock.now(),
          });
          job.tools = tools;
        }
        if (turn.tools.length < MAX_JOB_TOOLS) {
          turn.tools = [
            ...turn.tools,
            {
              name,
              ...(extra?.id ? { id: extra.id } : {}),
              ...(detail !== undefined ? { detail: truncateForRecord(detail, TOOL_DETAIL_CAP) } : {}),
              startedAt: this.clock.now(),
            },
          ];
        }
        this.save(entry);
        this.emit(entry);
      },
      beginTurn: (label, prompt) => {
        job.turns = [...(job.turns ?? []), { label, startedAt: this.clock.now() }];
        this.closeTurnRecord(entry);
        const turn: JobTurnRecord = { label, output: "", outputOriginalLength: 0, tools: [], startedAt: this.clock.now() };
        const text = prompt ?? this.deriveTurnPrompt(entry);
        if (text !== undefined) this.setRecordPrompt(turn, text);
        job.turnRecords = [...(job.turnRecords ?? []), turn];
        entry.currentTurn = turn;
        this.save(entry);
        this.emit(entry);
      },
      endTurn: () => {
        const turns = job.turns;
        const open = turns?.[turns.length - 1];
        if (open && open.finishedAt === undefined) {
          open.finishedAt = this.clock.now();
        }
        this.closeTurnRecord(entry);
        this.save(entry);
        this.emit(entry);
      },
      setTurnPrompt: (text) => {
        const turn = entry.currentTurn;
        if (turn && turn.prompt !== undefined && (turn.outputOriginalLength > 0 || turn.tools.length > 0 || turn.usage !== undefined)) {
          // A new prompt on a turn that already answered: a new turn.
          this.closeTurnRecord(entry);
          const next = this.openTurn(entry);
          this.setRecordPrompt(next, text);
          return;
        }
        this.setRecordPrompt(this.openTurn(entry), text);
      },
      reportTurnUsage: (usage, raw) => {
        const turn = this.openTurn(entry);
        turn.usage = {
          inputTokens: (turn.usage?.inputTokens ?? 0) + usage.inputTokens,
          cachedReadTokens: (turn.usage?.cachedReadTokens ?? 0) + usage.cachedReadTokens,
          cachedWriteTokens: (turn.usage?.cachedWriteTokens ?? 0) + usage.cachedWriteTokens,
          outputTokens: (turn.usage?.outputTokens ?? 0) + usage.outputTokens,
        };
        if (raw !== undefined) turn.rawUsage = cloneRaw(raw);
        this.save(entry);
        this.emit(entry);
      },
      setDegradedReason: (reason) => {
        job.degradedReason = reason;
        this.save(entry);
        this.emit(entry);
      },
    };
  }

  private forgetDedupe(entry: Entry): void {
    const key = entry.job.dedupeKey;
    if (key && this.dedupe.get(key) === entry.job.id) this.dedupe.delete(key);
  }

  private save(entry: Entry): void {
    this.persist?.save(copy(entry.job));
  }

  private emit(entry: Entry): void {
    // Turn records ride the per-job output endpoint (#207), never the
    // event stream: they are far too large for every state change.
    const job = copy(entry.job);
    delete job.turnRecords;
    this.onEvent(entry.reviewId, { type: "job", job });
  }

  private isDrained(): boolean {
    for (const e of this.entries.values()) {
      if (e.run === undefined) continue; // orphaned (needs rebind) or interrupted
      if (!isTerminal(e.job.state)) return false;
    }
    return true;
  }

  private checkDrain(): void {
    if (!this.isDrained()) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}

function isTerminal(state: Job["state"]): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

export { RetryableError };
