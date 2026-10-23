/**
 * M3 pipeline (PRD §11): reader → base → critic → hunk pass.
 *
 * Every agent call is a job on the queue (kind, model, priority, prompt
 * snapshot, usage with cached tokens, cardId/progress). Streaming reader
 * cards go through `parseCardsPartial` → `ReviewStore.mutate` so the UI
 * fills progressively (finished cards only: sections closed by a later
 * `## ` heading, or all sections once the trailing JSON block lands).
 * Every reply goes through `splitReply` → parser →
 * citation validator (valid/repaired stored resolved, unverified flagged +
 * recorded in job debug data; one repair turn when `needsRepairTurn`).
 *
 * Resilience (PRD §16): snapshots + revs are durable; interrupted stages
 * are resumable via `resumeReview`. Sessions reopen with `load` or rebuild.
 * Measurement (PRD §16): per-review token totals + cache-hit rate in
 * `snapshot.usageTotals`, time-to-first-card logged.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  AccessMode,
  AgentRunner,
  Block,
  Job,
  JobKind,
  ParsedCard,
  ReplyData,
  ReviewSnapshot,
  TokenUsage,
} from "@unvibe/shared";
import { canonicalizeTarget, collectTargets, DEFAULT_GUIDE_TITLE, isDocumentReview, JOB_PRIORITY, normalizePlotlines, parseCards, parseCardsPartial, parseHunkReply, parseId, PLOTLINE_ASSIGN_CAP, resolveHunkScore, splitReply } from "@unvibe/shared";
import { customGuideCardId, isCustomGuidePage, postureFor } from "@unvibe/shared";
import type { HunkReplyResult } from "@unvibe/shared";
import { attachPartialUsage, DegradedConnError, DegradedTurnError, partialUsageOf, RetryableError, type PartialUsageCarrier } from "../jobs/errors.js";
import type { JobQueue } from "../jobs/index.js";
import { McpRegistry } from "../mcp/index.js";
import { readCodeSlice } from "../mcp/index.js";
import { isNoneRunner, isReplayRunner } from "../agent/factory.js";
import { NoAgentError } from "../agent/none.js";
import { guideRevisionForSnapshot, toPromptSnapshot } from "../routes/prompts.js";import { buildBasePack, buildLadder, DEFAULT_HUNK_PASS_FANOUT_LIMIT } from "../context/index.js";
import { loadTemplatesDirSync, renderTemplate, resolvePromptsDir } from "../prompts/index.js";
import { renderSystemPrompt } from "../prompts/access.js";
import type { SessionManager } from "../sessions/manager.js";
import { baseKeyString } from "../sessions/manager.js";
import type { SettingsStore } from "../settings/index.js";
import { resolveEffectiveSettings } from "../settings/index.js";
import type { ModelCatalog } from "../settings/index.js";
import type { ReviewStore } from "../state/store.js";
import type { CommandRunner } from "../exec/index.js";
import { validateReply } from "../validate/index.js";
import { lookupForSnapshot, resolveCodeFileExistence } from "./lookup.js";
import { createSuggestedCommentInDraft } from "../comments/threads.js";
import { applyCustomGuideReply, guideClarifyQuestion, renderGuideClock, renderGuideCommits, renderGuideRequest, writeGuidePage } from "./customGuide.js";
import { buildDocumentBaseText } from "../document/map.js";
import { resolveDocumentCodeExistence } from "../document/resolve.js";
import { criticApplyAll, isDefaultReaderCardId, readerApply, readerCardId, splitFinalizedBlocks } from "./apply.js";
import { withReplayMark } from "./replayMark.js";
import { buildRepairVariables, finalizeFresh, mergeRepairedDiagrams } from "./actions/diagram-finalize.js";
import type { ActionContext } from "./actions/common.js";
import { changeListVariable, ingestAgentTurn } from "./sharedctx-wire.js";
import type { SharedContextService } from "../sharedctx/service.js";
import type { RunInForkOptions, RunInForkResult, RunSmallOptions } from "./types.js";

export interface PipelineOptions {
  reviews: ReviewStore;
  jobs: JobQueue;
  sessions: SessionManager;
  runner: AgentRunner;
  mcp: McpRegistry;
  settings: SettingsStore;
  /** Model catalog for live role defaults (issue #88): the pipeline runs the same effective settings as GET /api/settings. Absent → stored settings stand. */
  models?: ModelCatalog | null;
  commands: CommandRunner;
  dataDir: string;
  promptsDir?: string;
  mcpBaseUrl?: string;
  fixturesDir?: string;
  /** M5 shared context (PRD §9.3–§9.5): change lists, contributions, growth. */
  sharedctx?: SharedContextService;
}

type Session = { id: string; provider: string; model: string };

/**
 * Role identity for jobs and sessions (issue #172): provider + model +
 * the role's effort, always passed explicitly ("" = adapter default).
 * Spread into `jobs.enqueue` (effort shows on the Debug page next to the
 * model) and `runner.start` (the adapter applies it).
 */
export function roleFields(pick: { provider: string; model: string; effort: string }): {
  provider: string;
  model: string;
  effort: string;
} {
  return { provider: pick.provider, model: pick.model, effort: pick.effort };
}

/** Issue #207: extra data on a tool callback (start detail, end result). */
export type ToolCallExtra = { id?: string; result?: string; status?: "start" | "end" };
export type ToolCallback = (name: string, detail?: string, extra?: ToolCallExtra) => void;

/** Issue #207: per-turn record hooks, wired to the job context by callers. */
export interface TurnHooks {
  onPrompt?: (prompt: string) => void;
  onUsage?: (usage: TokenUsage, raw?: unknown) => void;
}

/** Build turn hooks from a job-like context (absent methods are skipped). */
export function turnHooks(ctx?: {
  setTurnPrompt?: (text: string) => void;
  reportTurnUsage?: (usage: TokenUsage, raw?: unknown) => void;
} | null): TurnHooks | undefined {
  if (!ctx) return undefined;
  return {
    onPrompt: (p) => ctx.setTurnPrompt?.(p),
    onUsage: (u, raw) => ctx.reportTurnUsage?.(u, raw),
  };
}

async function collectStreaming(
  runner: AgentRunner,
  session: Session,
  prompt: string,
  signal: AbortSignal | undefined,
  onDelta: (delta: string) => void,
  onTool?: ToolCallback,
  turn?: TurnHooks,
): Promise<{ text: string; usage: TokenUsage }> {
  let text = "";
  let afterTool = false;
  const usage: TokenUsage = { inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 };
  turn?.onPrompt?.(prompt);
  try {
    for await (const ev of runner.prompt(session, prompt, signal)) {
      if (ev.type === "text") {
        // Text on either side of a tool call arrives with nothing between it
        // ("…my restatement.Only two files…"): make it a paragraph break.
        const delta = afterTool && text && !text.endsWith("\n\n") ? `\n\n${ev.delta}` : ev.delta;
        afterTool = false;
        text += delta;
        onDelta(delta);
      } else if (ev.type === "tool") {
        if (ev.status === "start") {
          afterTool = true;
          onTool?.(ev.name, ev.detail, { status: "start", ...(ev.id ? { id: ev.id } : {}), ...(ev.result !== undefined ? { result: ev.result } : {}) });
        } else {
          onTool?.(ev.name, ev.detail, { status: "end", ...(ev.id ? { id: ev.id } : {}), ...(ev.result !== undefined ? { result: ev.result } : {}) });
        }
      } else if (ev.type === "usage") {
        usage.inputTokens += ev.inputTokens;
        usage.cachedReadTokens += ev.cachedReadTokens;
        usage.cachedWriteTokens += ev.cachedWriteTokens;
        usage.outputTokens += ev.outputTokens;
        turn?.onUsage?.(
          { inputTokens: ev.inputTokens, cachedReadTokens: ev.cachedReadTokens, cachedWriteTokens: ev.cachedWriteTokens, outputTokens: ev.outputTokens },
          ev.raw,
        );
      } else if (ev.type === "error") {
        if (ev.retryable) throw new RetryableError(ev.message);
        throw new Error(ev.message);
      }
      if (signal?.aborted) throw new Error("aborted");
    }
  } catch (err) {
    // Issue #151: a turn that ends early keeps the usage it already
    // counted on the thrown error, so the job can record it.
    throw attachPartialUsage(err, usage, text);
  }
  return { text, usage };
}

/**
 * `collectStreaming` on a managed session: the session is in use for
 * the whole turn, so the idle sweep never closes it mid-stream, and
 * its idle clock restarts when the turn ends (#143 supervisor fix).
 * Untracked sessions (reader, small, hunk) are a no-op in the manager.
 */
async function collectTracked(
  sessions: SessionManager,
  runner: AgentRunner,
  session: Session,
  prompt: string,
  signal: AbortSignal | undefined,
  onDelta: (delta: string) => void,
  onTool?: ToolCallback,
  turn?: TurnHooks,
): Promise<{ text: string; usage: TokenUsage }> {
  sessions.beginSessionUse(session.id);
  try {
    return await collectStreaming(runner, session, prompt, signal, onDelta, onTool, turn);
  } finally {
    sessions.endSessionUse(session.id);
  }
}

/** Append one more sent prompt to a job's snapshot (issue #151). */
function appendPromptSnapshot(
  ctx: { setPromptSnapshot(text: string): void },
  current: string,
  label: string,
  next: string,
): string {
  const out = `${current}\n\n--- ${label} ---\n${next}`;
  ctx.setPromptSnapshot(out);
  return out;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Issue #194: run one agent turn inside the job's turn timings. */
async function timedTurn<T>(
  ctx: { beginTurn(label: string): void; endTurn(): void },
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  ctx.beginTurn(label);
  try {
    return await fn();
  } finally {
    ctx.endTurn();
  }
}

/** Optional tool-call relay for contexts that may not report tools. */
function reportToolFrom(ctx?: {
  reportTool?: ToolCallback;
}): ToolCallback | undefined {
  const fn = ctx?.reportTool;
  return fn ? (name, detail, extra) => fn(name, detail, extra) : undefined;
}

/**
 * Plain-words note appended to a kept degraded answer (never the agent's
 * internal reason — that lives on the job for the Debug page).
 */
export const DEGRADED_ANSWER_NOTE = "Some references in this answer could not be linked to the code.";

/** Id for the appended degraded note (deduped, never anchored). */
export const DEGRADED_NOTE_BLOCK_ID = "b-degraded-note";

export type TurnDisposition =
  | { kind: "ok" }
  | { kind: "fail-conn"; message: string }
  | { kind: "fail-empty"; message: string }
  | { kind: "keep"; reason: string };

/**
 * Append the quiet degraded note to a kept answer's last card (once —
 * keyed by its stable block id). The note is plain words; the agent's
 * internal reason lives on the job for the Debug page.
 */
function attachDegradedNote(cards: { blocks: { id: string }[] }[]): void {
  const last = cards[cards.length - 1];
  if (!last) return;
  if (last.blocks.some((b) => b.id === DEGRADED_NOTE_BLOCK_ID || b.id.startsWith(`${DEGRADED_NOTE_BLOCK_ID}-`))) {
    return;
  }
  (last.blocks as unknown[]).push({
    type: "paragraph",
    id: DEGRADED_NOTE_BLOCK_ID,
    text: { standard: DEGRADED_ANSWER_NOTE },
    citations: [],
  });
}

/**
 * Fence-tag language for a pinned path. No shared helper exists (pin
 * producers are the only excerpt source that derives it), so the map
 * lives with the single producer below.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  sql: "sql",
};

function languageForPath(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_LANGUAGE[relPath.slice(dot + 1).toLowerCase()];
}

function aliasesForReview(snapshot: ReviewSnapshot, fixturesDir?: string): Record<string, string> {
  if (snapshot.review.repoId !== "demo") return {};
  if (!fixturesDir) return {};
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(fixturesDir, "meta.json"), "utf8")) as {
      keyAliases?: Record<string, string>;
    };
    return meta.keyAliases ?? {};
  } catch {
    return {};
  }
}

function citationsOf(block: Block): string[] {
  switch (block.type) {
    case "paragraph":
      return block.citations.map((c) => c.target);
    case "list":
      return [...block.citations.map((c) => c.target), ...block.items.flatMap((it) => it.citations.map((c) => c.target))];
    case "table":
    case "code":
    case "diagram":
    case "finding-link":
    case "follow-up":
      return (block as { citations: { target: string }[] }).citations.map((c) => c.target);
    case "comment-link":
      return [...block.citations.map((c) => c.target), block.diffRef];
    case "aside":
      return [...block.citations.map((c) => c.target), ...block.inner.flatMap(citationsOf)];
  }
}

export class Pipeline {
  private promptsDir: string;
  private mcpBaseUrl: string;
  /** #122: reviews with a base rebuild already warming (debounce). */
  private warmInFlight = new Set<string>();
  /**
   * Hunk-pass completions since the last fan-out, per review (issue
   * #107). Counting queue states (`maybeMarkStageDone`) races when jobs
   * finish together: every job sees its siblings still "running" — the
   * queue flips them to done only after each `run()` returns — so nobody
   * marks the stage done. Counting completions in the success path is
   * exact: each increment runs atomically between awaits.
   */
  private hunkPassCompleted = new Map<string, number>();

  constructor(private readonly opts: PipelineOptions) {
    this.promptsDir = opts.promptsDir ?? resolvePromptsDir() ?? "prompts";
    this.mcpBaseUrl = opts.mcpBaseUrl ?? "http://127.0.0.1:4517";
  }

  get runner(): AgentRunner {
    return this.opts.runner;
  }

  /** CommandRunner for D2 subprocesses (diagrams module). */
  get commands(): CommandRunner {
    return this.opts.commands;
  }

  get dataDir(): string {
    return this.opts.dataDir;
  }

  get fixturesDir(): string | undefined {
    return this.opts.fixturesDir;
  }

  /** M5 shared context: attach the service after construction (app.ts). */
  setSharedContext(sharedctx: SharedContextService): void {
    this.opts.sharedctx = sharedctx;
  }

  /**
   * Effective settings (issue #88): saved picks win, unsaved roles take
   * live defaults from the model catalog. Never throws (falls back to
   * stored); never writes.
   */
  private effectiveSettings() {
    return resolveEffectiveSettings({ settings: this.opts.settings, models: this.opts.models ?? null });
  }

  /** Deps for the shared-context wire module (PRD §9.3–§9.5). */
  private wireDeps(): {
    reviews: ReviewStore;
    sessions: SessionManager;
    settings: SettingsStore;
    promptsDir: string;
    sharedctx?: SharedContextService;
  } {
    return {
      reviews: this.opts.reviews,
      sessions: this.opts.sessions,
      settings: this.opts.settings,
      promptsDir: this.promptsDir,
      ...(this.opts.sharedctx ? { sharedctx: this.opts.sharedctx } : {}),
    };
  }

  /**
   * Post-success bookkeeping for one agent turn (contributions, seen marker,
   * base growth). Best-effort: never fails the job. Only call when the turn
   * succeeded — failed turns must not advance the marker.
   */
  private async ingestTurn(
    reviewId: string,
    turn: {
      sessionId: string;
      annotationId?: string;
      conversationKey?: string;
      cardId?: string;
      hunkHash?: string;
      data: ReplyData | null;
    },
  ): Promise<void> {
    if (!this.opts.sharedctx) return;
    try {
      const snapshot = this.opts.reviews.getSnapshot(reviewId);
      if (!snapshot) return;
      const lookup = this.lookupWithAliases(snapshot);
      await ingestAgentTurn(this.wireDeps(), reviewId, {
        sessionId: turn.sessionId,
        ...(turn.annotationId ? { annotationId: turn.annotationId } : {}),
        ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
        ...(turn.cardId ? { cardId: turn.cardId } : {}),
        ...(turn.hunkHash ? { hunkHash: turn.hunkHash } : {}),
        data: turn.data,
        snapshot,
        lookup,
        appendToBase: (baseKey, batch) => this.opts.sessions.appendLogBatch(baseKey, batch),
      });
    } catch {
      // best-effort
    }
  }

  // -- reusable seam --------------------------------------------------

  async runInFork(o: RunInForkOptions): Promise<RunInForkResult> {
    const snapshot = this.opts.reviews.getSnapshot(o.reviewId);
    if (!snapshot) throw new Error(`unknown review ${o.reviewId}`);
    // Fail fast when the pipeline is disabled: the base build below would
    // throw this anyway, but only after a job id went out (#122 keeps the
    // enqueue ahead of the base — a doomed job must never be handed out).
    if (isNoneRunner(this.opts.runner)) throw new NoAgentError();
    const settings = await this.effectiveSettings();
    const provider = settings.main.provider;
    const model = settings.main.model;
    const effort = settings.main.effort;
    // #122: enqueue before awaiting the base, so the click gets its job id
    // at once. The base seq for the change list is read synchronously from
    // the current base (absent → 0, a safe under-approximation: the fork may
    // repeat entries, never miss them); the job ensures the base inside.
    const baseLogSeq =
      this.opts.sessions.baseInfo(
        baseKeyString({
          reviewId: o.reviewId,
          reviewVersion: `v${snapshot.version.n}`,
          guideRevision: guideRevisionForSnapshot(snapshot),
          provider,
          model,
          access: postureFor(settings),
          effort,
        }),
      )?.logSeq ?? 0;
    const variables = changeListVariable(this.wireDeps(), o.reviewId, o.template, o.variables, {
      ...(o.conversationKey ? { conversationKey: o.conversationKey } : {}),
      ...(o.cardId ? { cardId: o.cardId } : {}),
      ...(o.hunkHash ? { hunkHash: o.hunkHash } : {}),
      baseLogSeq,
    });
    const template = this.render(o.template, variables);
    let prompt = withReplayMark(template, o.replay && isReplayRunner(this.opts.runner) ? o.replay : undefined);

    let resolveResult!: (r: RunInForkResult) => void;
    let rejectResult!: (e: Error) => void;
    const done = new Promise<RunInForkResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const enqueued = this.opts.jobs.enqueue({
      reviewId: o.reviewId,
      kind: o.kind,
      provider,
      model,
      effort,
      priority: o.priority,
      ...(o.dedupeKey ? { dedupe: o.dedupeKey } : {}),
      ...(o.cardId ? { cardId: o.cardId } : {}),
      ...(o.annotationId ? { annotationId: o.annotationId } : {}),
      promptSnapshot: prompt,
      run: async (ctx) => {
        // Retryable errors retry inside the job (so the deferred settles
        // once); non-retryable errors reject and mark the job error.
        // A continued session stays across attempts — except the
        // connection retry, which forks fresh (see below).
        let continuedId = o.continueSessionId;
        // Issue #151: the snapshot accumulates every prompt sent, in
        // order (first, repair, connection-retry), like the reader's.
        let snapshotText = prompt;
        for (let attempt = 0; ; attempt++) {
          try {
            ctx.setPromptSnapshot(snapshotText);
            // #122: the base builds here, inside the job — after the job id
            // went out. forkFor ensures the same base again (a live-cache hit).
            const base = await this.ensureBase(o.reviewId);
            void base;
            // Issue #136: later turns of a conversation card continue on
            // the card's session instead of forking again. All turns share
            // this path's streaming, citation check, repair turn, usage
            // and contribution handling.
            const forked = continuedId
              ? await this.continueOn(continuedId)
              : await this.forkAndTrack(o.reviewId, o.conversationKey !== undefined);
            ctx.setSessionId(forked.session.id);
            let buffer = "";
            // Per-attempt evidence: a retry must observe *its own* turn's
            // tool activity, not the previous attempt's.
            const mcpBefore = this.opts.mcp.activitySnapshot(o.reviewId);
            const { text, usage } = await timedTurn(ctx, "first", () =>
              collectTracked(this.opts.sessions, this.opts.runner,
              forked.session,
              prompt,
              o.signal ?? ctx.signal,
              (delta) => {
                ctx.reportText(delta);
                buffer += delta;
                if (o.onPartial) {
                  try {
                    const partials = parseCardsPartial(buffer);
                    if (partials.length > 0) void o.onPartial(partials);
                  } catch {
                    // ignore mid-stream parse errors
                  }
                }
              },
              (name, detail, extra) => ctx.reportTool(name, detail, extra),
              turnHooks(ctx)),
            );
            const first = await this.parseAndValidateWithCode(o.reviewId, text, o.echoCandidates);
            // Facts only (#180): the reply's wording is never judged. A
            // kept degraded answer (explicit field + usable body) skips
            // the repair turn — no repair can fix what the agent declared
            // missing, and the answer is shown as written.
            let degradedReason: string | undefined;
            const firstDisp = this.turnDisposition(
              o.reviewId,
              mcpBefore,
              first.data,
              first.cards.flatMap((c) => c.blocks).length,
            );
            if (firstDisp.kind === "fail-empty" && o.acceptEmpty?.(first.data)) {
              // An empty reply the caller accepts (a clarifying question).
            } else if (firstDisp.kind === "fail-conn" || firstDisp.kind === "fail-empty") {
              // The turn did stream (and spend) before failing on facts:
              // keep its usage like any other attempt (#151).
              ctx.reportUsage(usage);
              await this.recordUsage(o.reviewId, usage);
              if (firstDisp.kind === "fail-conn") throw new DegradedConnError(firstDisp.message);
              throw new DegradedTurnError(firstDisp.message);
            }
            if (firstDisp.kind === "keep") degradedReason = firstDisp.reason;
            let finalText = text;
            let finalCards = first.cards;
            let finalData = first.data;
            let finalValidation = first.validation;
            let repaired = false;
            const acceptedEmpty = firstDisp.kind === "fail-empty";
            if (first.validation.needsRepairTurn && degradedReason === undefined && !acceptedEmpty) {
              repaired = true;
              const anchorProblem =
                first.validation.anchor && !first.validation.anchor.ok
                  ? `\nAnchor problem: ${first.validation.anchor.reason}. Reply with the same content and a corrected anchor host (the host block's ID).\n`
                  : "";
              const repairPrompt =
                `Some citations in your previous reply could not be verified:\n` +
                first.validation.tokens
                  .filter((t) => t.status === "unverified")
                  .map((t) => `- ${t.target}: ${t.reason ?? "unknown"}`)
                  .join("\n") +
                anchorProblem +
                `\nReply with the same content and corrected citation tokens. End with the same trailing JSON block.`;
              snapshotText = appendPromptSnapshot(ctx, snapshotText, "repair turn", repairPrompt);
              const repair = await timedTurn(ctx, "repair", () =>
                collectTracked(this.opts.sessions, this.opts.runner, forked.session, repairPrompt, o.signal ?? ctx.signal, (d) =>
                  ctx.reportText(d),
                  (name, detail, extra) => ctx.reportTool(name, detail, extra),
                turnHooks(ctx)),
              );
              usage.inputTokens += repair.usage.inputTokens;
              usage.cachedReadTokens += repair.usage.cachedReadTokens;
              usage.cachedWriteTokens += repair.usage.cachedWriteTokens;
              usage.outputTokens += repair.usage.outputTokens;
              finalText = repair.text;
              const second = await this.parseAndValidateWithCode(o.reviewId, repair.text, o.echoCandidates);
              finalCards = second.cards;
              finalData = second.data;
              finalValidation = second.validation;
              const secondDisp = this.turnDisposition(
                o.reviewId,
                mcpBefore,
                second.data,
                second.cards.flatMap((c) => c.blocks).length,
              );
              if (secondDisp.kind === "fail-conn" || secondDisp.kind === "fail-empty") {
                ctx.reportUsage(usage);
                await this.recordUsage(o.reviewId, usage);
                if (secondDisp.kind === "fail-conn") throw new DegradedConnError(secondDisp.message);
                throw new DegradedTurnError(secondDisp.message);
              }
              if (secondDisp.kind === "keep" && degradedReason === undefined) degradedReason = secondDisp.reason;
            }
            if (degradedReason !== undefined) {
              attachDegradedNote(finalCards);
              ctx.setDegradedReason(degradedReason);
            }
            ctx.reportUsage(usage);
            await this.recordUsage(o.reviewId, usage);
            if (o.onPartial) {
              try {
                await o.onPartial(finalCards);
              } catch {
                // ignore
              }
            }
            // #122: the finished answer goes out before post-turn
            // bookkeeping. The job still awaits the bookkeeping below, so a
            // crash in between leaves it visibly interrupted (never silently
            // unbookkept), and the next job drains the chain in forkFor.
            resolveResult({
              job: this.opts.jobs.get(enqueued.id) ?? enqueued,
              text: finalText,
              cards: finalCards,
              data: finalData,
              validation: finalValidation,
              usage,
              viaFork: forked.viaFork,
              repaired,
            });
            if (o.skipIngest) return;
            await this.finishBookkeeping(o.reviewId, () =>
              this.ingestTurn(o.reviewId, {
                sessionId: forked.session.id,
                ...(o.annotationId ? { annotationId: o.annotationId } : {}),
                ...(o.conversationKey ? { conversationKey: o.conversationKey } : {}),
                ...(o.cardId ? { cardId: o.cardId } : {}),
                ...(o.hunkHash ? { hunkHash: o.hunkHash } : {}),
                data: finalData,
              }),
            );
            return;
          } catch (err) {
            // Issue #151: keep whatever the failed turn already spent.
            await this.reportPartialUsage(ctx, o.reviewId, err);
            // One retry on a fresh session when the turn observably hit a
            // dead review-MCP URL (#51: transient, e.g. slow-starting
            // server). A continued conversation falls back to a fresh fork
            // — retrying on the same dead session could never reconnect —
            // with the full first-turn prompt plus the stored transcript
            // (the short follow-up prompt assumes the live session's
            // history). A second connection failure, and any empty answer,
            // is terminal.
            if (err instanceof DegradedConnError && attempt < 1) {
              continuedId = undefined;
              if (o.retryTemplate && o.retryVariables) {
                const retryVars = changeListVariable(this.wireDeps(), o.reviewId, o.retryTemplate, o.retryVariables, {
                  ...(o.conversationKey ? { conversationKey: o.conversationKey } : {}),
                  ...(o.cardId ? { cardId: o.cardId } : {}),
                  ...(o.hunkHash ? { hunkHash: o.hunkHash } : {}),
                  baseLogSeq,
                });
                prompt = withReplayMark(
                  this.render(o.retryTemplate, retryVars),
                  o.replay && isReplayRunner(this.opts.runner) ? o.replay : undefined,
                );
                snapshotText = `${snapshotText}\n\n--- retry turn ---\n${prompt}`;
              }
              continue;
            }
            if (err instanceof RetryableError && attempt < 3) {
              await sleepMs(50 * (attempt + 1));
              continue;
            }
            rejectResult(err as Error);
            throw err;
          }
        }
      },
    });
    // M4: hand the enqueued job to the action handler (jobId + cancel).
    try {
      o.onJob?.(enqueued);
    } catch {
      // ignore
    }
    void enqueued;
    return done;
  }

  async runSmall(o: RunSmallOptions): Promise<RunInForkResult> {
    const settings = await this.effectiveSettings();
    const template = this.render(o.template, o.variables);
    const prompt = withReplayMark(template, o.replay && isReplayRunner(this.opts.runner) ? o.replay : undefined);
    const provider = settings.small.provider;
    const model = settings.small.model;
    // Background small-model jobs always run locked down (owner decision
    // #160): the session posture and the job stamp below both say so,
    // regardless of the setting.
    const access = postureFor(settings, o.kind);
    const effort = settings.small.effort;

    let resolveResult!: (r: RunInForkResult) => void;
    let rejectResult!: (e: Error) => void;
    const done = new Promise<RunInForkResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const enqueued = this.opts.jobs.enqueue({
      reviewId: o.reviewId,
      kind: o.kind,
      provider,
      model,
      effort,
      priority: o.priority,
      ...(o.dedupeKey ? { dedupe: o.dedupeKey } : {}),
      ...(o.cardId ? { cardId: o.cardId } : {}),
      ...(o.annotationId ? { annotationId: o.annotationId } : {}),
      promptSnapshot: prompt,
      accessMode: access,
      run: async (ctx) => {
        let snapshotText = prompt;
        for (let attempt = 0; ; attempt++) {
          try {
            ctx.setPromptSnapshot(snapshotText);
            const session = await this.startSessionForJob(ctx, o.reviewId, {
              provider,
              model,
              effort,
              cwd: this.worktreeOf(o.reviewId),
              systemPrompt: "",
              readOnly: access !== "full",
              mcpServers: [],
            });
            ctx.setSessionId(session.id);
            try {
              const { text, usage } = await timedTurn(ctx, "first", () =>
                collectTracked(this.opts.sessions, this.opts.runner, session, prompt, o.signal ?? ctx.signal, (d) =>
                  ctx.reportText(d),
                  (name, detail, extra) => ctx.reportTool(name, detail, extra),
                turnHooks(ctx)),
              );
              const first = await this.parseAndValidateWithCode(o.reviewId, text);
              let finalText = text;
              let finalCards = first.cards;
              let finalData = first.data;
              let finalValidation = first.validation;
              let repaired = false;
              if (first.validation.needsRepairTurn) {
                repaired = true;
                const repairPrompt =
                  `Some citations could not be verified:\n` +
                  first.validation.tokens
                    .filter((t) => t.status === "unverified")
                    .map((t) => `- ${t.target}: ${t.reason ?? "unknown"}`)
                    .join("\n") +
                  `\nReply with the same one-line summary and corrected citations. End with the same trailing JSON block.`;
                snapshotText = appendPromptSnapshot(ctx, snapshotText, "repair turn", repairPrompt);
                const repair = await timedTurn(ctx, "repair", () =>
                  collectTracked(this.opts.sessions, this.opts.runner, session, repairPrompt, o.signal ?? ctx.signal, (d) =>
                    ctx.reportText(d),
                    (name, detail, extra) => ctx.reportTool(name, detail, extra),
                  turnHooks(ctx)),
                );
                usage.inputTokens += repair.usage.inputTokens;
                usage.cachedReadTokens += repair.usage.cachedReadTokens;
                usage.cachedWriteTokens += repair.usage.cachedWriteTokens;
                usage.outputTokens += repair.usage.outputTokens;
                finalText = repair.text;
                const second = await this.parseAndValidateWithCode(o.reviewId, repair.text);
                finalCards = second.cards;
                finalData = second.data;
                finalValidation = second.validation;
              }
              ctx.reportUsage(usage);
              await this.recordUsage(o.reviewId, usage);
              resolveResult({
                job: this.opts.jobs.get(enqueued.id) ?? enqueued,
                text: finalText,
                cards: finalCards,
                data: finalData,
                validation: finalValidation,
                usage,
                viaFork: false,
                repaired,
              });
            } finally {
              try {
                await this.opts.runner.close(session);
              } catch {
                // ignore
              }
            }
            return;
          } catch (err) {
            await this.reportPartialUsage(ctx, o.reviewId, err);
            if (err instanceof RetryableError && attempt < 3) {
              await sleepMs(50 * (attempt + 1));
              continue;
            }
            rejectResult(err as Error);
            throw err;
          }
        }
      },
    });
    // M4: hand the enqueued job to the action handler (jobId + cancel).
    try {
      o.onJob?.(enqueued);
    } catch {
      // ignore
    }
    void enqueued;
    return done;
  }

  // -- pipeline stages ------------------------------------------------

  /**
   * M5 shared context (PRD §9.5): merge contributions on a base rebuild via
   * the small model (`consolidate` template). Returns the model's verdict;
   * the caller applies it with `applyConsolidation`. A small-model job, so
   * it carries only the contribution list — never the review, never the log.
   */
  async runConsolidateTask(
    reviewId: string,
    contributionsText: string,
  ): Promise<{ kept: { id: string }[]; dropped: { id: string; why: string }[] }> {
    const res = await this.runSmall({
      reviewId,
      kind: "consolidate",
      template: "consolidate",
      variables: { contributions: contributionsText },
      priority: JOB_PRIORITY.background,
    });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const kept = Array.isArray(data["kept"])
      ? (data["kept"] as { id?: unknown }[])
          .filter((k): k is { id: string } => typeof k?.id === "string")
          .map((k) => ({ id: k.id }))
      : [];
    const dropped = Array.isArray(data["dropped"])
      ? (data["dropped"] as { id?: unknown; why?: unknown }[])
          .filter((d): d is { id: string; why: string } => typeof d?.id === "string")
          .map((d) => ({ id: d.id, why: typeof d.why === "string" ? d.why : "dropped by consolidation" }))
      : [];
    return { kept, dropped };
  }

  async startReview(reviewId: string): Promise<void> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    // `UNVIBE_AGENT=none`: the pipeline is disabled. Enqueue nothing, so
    // the review stays at its ingested snapshot and no background job
    // mutates it (comments/diff/versions specs rely on this).
    if (isNoneRunner(this.opts.runner)) return;
    this.ensurePipelineField(reviewId);
    this.setStage(reviewId, "reader", "pending");
    this.setStage(reviewId, "base", "pending");
    this.setStage(reviewId, "critic", "pending");
    this.setStage(reviewId, "hunk-pass", "pending");
    await this.enqueueReader(reviewId);
    // #123: the hunk pass needs only the diff, so it starts at ingest
    // instead of waiting for the reader. Small-model jobs run in their own
    // queue bucket, never behind the critics. The CITED-BY-GUIDE hint is
    // absent this early (no guide yet); `unhideCitedHunks` repairs hides
    // that the guide later contradicts.
    await this.enqueueHunkPass(reviewId);
  }

  async resumeReview(reviewId: string): Promise<{ jobIds: string[]; pendingStages: string[] }> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    // `UNVIBE_AGENT=none`: nothing to resume; report the pending stages.
    if (isNoneRunner(this.opts.runner)) {
      const stages = this.stageStates(reviewId);
      const pendingStages = Object.entries(stages)
        .filter(([, v]) => v !== "done")
        .map(([k]) => k);
      return { jobIds: [], pendingStages };
    }
    this.ensurePipelineField(reviewId);
    const stages = this.stageStates(reviewId);
    const jobIds: string[] = [];
    if (stages.reader !== "done") {
      jobIds.push((await this.enqueueReader(reviewId)).id);
    } else {
      if (stages.base !== "done") jobIds.push(...(await this.enqueueAfterReader(reviewId)).map((j) => j.id));
      else {
        if (stages.critic !== "done") jobIds.push(...(await this.enqueueCritic(reviewId)).map((j) => j.id));
        if (stages["hunk-pass"] !== "done") jobIds.push(...(await this.enqueueHunkPass(reviewId)).map((j) => j.id));
        // Issue #169: the plotline assign step is not a stage; resume it
        // like the demo fill below (no-op unless the reader named
        // plotlines on a degraded rung with hunks still unassigned).
        // Auto go-deeper (#217) is part of enqueueAfterReader, not a stage:
        // a restart after the base finished would otherwise leave pending
        // placeholders unfilled when the setting is on. No-op otherwise.
        jobIds.push(...(await this.enqueueAutoGoDeeper(reviewId)).map((j) => j.id));
        jobIds.push(...(await this.maybeEnqueuePlotlineAssign(reviewId)).map((j) => j.id));
      }
    }
    const after = this.stageStates(reviewId);
    const pendingStages = Object.entries(after)
      .filter(([, v]) => v !== "done")
      .map(([k]) => k);
    return { jobIds, pendingStages };
  }

  /**
   * Generate (or regenerate) a custom guide from its request turns. Forks
   * the review's base, streams sections into the guide's root page, then
   * writes the scope, plotlines and suggested comments — or, when the
   * agent asks a clarifying question, parks the guide in "needs-input".
   * Contributions stay out of the shared context (`skipIngest`). Resolves
   * with the job once it is enqueued; the result lands on the snapshot.
   */
  async runCustomGuide(reviewId: string, guideId: string): Promise<Job> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    const guide = snapshot?.guides?.find((g) => g.id === guideId);
    if (!snapshot || !guide) throw new Error(`unknown custom guide ${guideId}`);
    const fail = async (err: unknown): Promise<void> => {
      const message = err instanceof Error ? err.message : String(err);
      await this.opts.reviews.mutate(reviewId, (draft) => {
        const g = draft.guides?.find((x) => x.id === guideId);
        if (!g) return;
        g.status = "failed";
        g.error = message.slice(0, 500);
        delete g.jobId;
      });
    };
    let resolveJob!: (job: Job) => void;
    let rejectJob!: (err: Error) => void;
    const jobReady = new Promise<Job>((res, rej) => {
      resolveJob = res;
      rejectJob = rej;
    });
    const run = this.runInFork({
      reviewId,
      kind: "custom-guide",
      template: "custom_guide",
      variables: {
        request: renderGuideRequest(guide),
        now: renderGuideClock(),
        commits: renderGuideCommits(snapshot.commits ?? []),
      },
      priority: JOB_PRIORITY.userRequested,
      cardId: customGuideCardId(guideId, 1),
      skipIngest: true,
      acceptEmpty: (data) => guideClarifyQuestion(data, 0) !== null,
      replay: { kind: "custom-guide", key: guideId },
      onJob: (job) => {
        resolveJob(job);
        void this.opts.reviews.mutate(reviewId, (draft) => {
          const g = draft.guides?.find((x) => x.id === guideId);
          if (!g) return;
          g.status = "working";
          g.jobId = job.id;
          delete g.error;
          delete g.question;
        });
      },
      onPartial: async (cards) => {
        await this.opts.reviews.mutate(reviewId, (draft) => {
          const g = draft.guides?.find((x) => x.id === guideId);
          if (!g || g.status !== "working") return;
          writeGuidePage(draft, g, cards);
        });
      },
    });
    run
      .then(async (result) => {
        const question = guideClarifyQuestion(result.data, result.cards.length);
        if (question) {
          await this.opts.reviews.mutate(reviewId, (draft) => {
            const g = draft.guides?.find((x) => x.id === guideId);
            if (!g) return;
            g.status = "needs-input";
            g.question = question;
            g.turns.push({ who: "agent", text: question, at: Date.now() });
            delete g.jobId;
            writeGuidePage(draft, g, []);
          });
          return;
        }
        const cards = result.cards.map((c) => ({
          title: c.title,
          blocks: this.withValidation(reviewId, c.blocks, result.validation),
        }));
        const before = this.opts.reviews.getSnapshot(reviewId);
        if (!before) return;
        const aliases = aliasesForReview(before, this.opts.fixturesDir);
        await this.opts.reviews.mutate(reviewId, (draft) => {
          applyCustomGuideReply(draft, before, guideId, {
            cards,
            data: result.data,
            canonicalFileKey: (fk) => aliases[fk] ?? fk,
            lineText: (fileKey, line) => {
              for (const f of draft.files) {
                if (f.fileKey !== fileKey) continue;
                for (const h of f.hunks) for (const row of h.lines) if (row.newLine === line) return row.text;
              }
              return "";
            },
          });
        });
      })
      .catch(async (err: unknown) => {
        rejectJob(err instanceof Error ? err : new Error(String(err)));
        await fail(err);
      });
    return jobReady;
  }

  async ensureConceptPage(reviewId: string, slug: string): Promise<Job> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const existing = snapshot.pages.find((p) => p.id === `c-${slug}`);
    const effective = await this.effectiveSettings();
    if (existing && existing.cards.length > 0 && existing.cards[0].blocks.length > 1) {
      return this.opts.jobs.enqueue({
        reviewId,
        kind: "concept",
        ...roleFields(effective.main),
        priority: JOB_PRIORITY.userRequested,
        run: async () => {},
      });
    }
    const settings = effective;
    const prompt = withReplayMark(
      this.render("concept_page", {
        concept: `${slug} — ${existing?.title ?? slug}`,
        mentions: this.mentionsOf(snapshot, slug),
      }),
      isReplayRunner(this.opts.runner) ? { kind: "concept-page", key: slug } : undefined,
    );
    const base = await this.ensureBase(reviewId);
    void base;
    const job = this.opts.jobs.enqueue({
      reviewId,
      kind: "concept",
      ...roleFields(settings.main),
      priority: JOB_PRIORITY.userRequested,
      dedupe: { anchor: `concept:${slug}`, requestKind: "concept-page", baseVersion: `v${snapshot.version.n}` },
      cardId: `cc-${slug}`,
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        const forked = await this.forkFor(reviewId);
        ctx.setSessionId(forked.session.id);
        const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner, forked.session, prompt, ctx.signal, (d) =>
          ctx.reportText(d),
          (name, detail, extra) => ctx.reportTool(name, detail, extra),
        turnHooks(ctx));
        ctx.reportUsage(usage);
        await this.recordUsage(reviewId, usage);
        // Issue #50: match the page title (an echo of the concept name).
        const { cards, data, validation } = this.parseAndValidate(reviewId, text, [
          ...(existing?.title ? [existing.title] : []),
          slug,
        ]);
        const title = (data?.["title"] as string | undefined) ?? existing?.title ?? slug;
        const blocks = this.withValidation(
          reviewId,
          cards.flatMap((c) => c.blocks),
          validation,
        );
        // Inline diagrams go through finalize + one repair turn on the
        // fill's own session (#130), so stored blocks carry a real status.
        const stored = await this.finalizeInlineBlocks(
          reviewId,
          forked.session,
          ctx.signal,
          `Concept page: ${slug}`,
          "standard",
          blocks,
          (u) => ctx.reportUsage(u),
          (name, detail, extra) => ctx.reportTool(name, detail, extra),
          turnHooks(ctx),
        );
        await this.opts.reviews.mutate(reviewId, (draft) => {
          let page = draft.pages.find((p) => p.id === `c-${slug}`);
          if (!page) {
            page = { id: `c-${slug}`, kind: "concept", title, parent: "root", cards: [] };
            draft.pages.push(page);
          }
          page.title = title;
          page.cards = [
            {
              id: `cc-${slug}`,
              pageId: `c-${slug}`,
              title: null,
              level: "standard",
              collapsed: false,
              revision: (page.cards[0]?.revision ?? 0) + 1,
              blocks: stored,
              undoStack: [],
            },
          ];
        });
        await this.appendLog(reviewId, "new-card", { summary: `concept page ${slug}` }, { scope: "global" });
        // #122: the page changed the guide — rebuild the base ahead.
        this.warmBase(reviewId);
      },
    });
    return job;
  }

  async summarizeHunk(reviewId: string, contentHash: string): Promise<Job | { reused: true; summary: string }> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const found = snapshot.files.flatMap((f) => f.hunks.map((h) => ({ file: f, hunk: h }))).find(
      (x) => x.hunk.contentHash === contentHash,
    );
    if (!found) throw new Error(`unknown hunk ${contentHash}`);
    // PRD §12 reuse (#10): a hunk that already carries a stored summary for
    // the same content hash returns it with no agent call. Hunk state is
    // keyed by content hash so it survives rebases (PRD §8); a deleted
    // summary (PATCH null) or changed content (new hash) is legitimately a
    // new request.
    const stored = snapshot.hunkStates.find((s) => s.contentHash === contentHash)?.summary;
    if (stored) return { reused: true, summary: stored };
    const settings = await this.effectiveSettings();
    const hunkText = this.formatHunkForPrompt(snapshot, found.file.fileKey, found.hunk.contentHash);
    const prompt = withReplayMark(
      this.render("hunk_pass", { hunk: hunkText, path: found.file.path, plotline: this.plotlineForHunk(snapshot, contentHash) }),
      isReplayRunner(this.opts.runner)
        ? { kind: "hunk", key: this.replayKeyForHunk(snapshot, found.file.fileKey, contentHash) ?? undefined }
        : undefined,
    );
    return this.opts.jobs.enqueue({
      reviewId,
      kind: "summarize",
      ...roleFields(settings.small),
      priority: JOB_PRIORITY.userRequested,
      dedupe: { anchor: `hunk:${contentHash}`, requestKind: "summarize", baseVersion: `v${snapshot.version.n}` },
      accessMode: postureFor(settings, "summarize"),
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        // Issue #210 (#194): time the fresh-session start separately from
        // the summary turn, so the Debug page can split setup from model
        // time. For Claude the start includes the shared-cache warm-up
        // turn, which runs inside `runner.start`; its usage lands on this
        // turn (see startSessionForJob), not on the summary turn.
        const session = await this.startSessionForJob(ctx, reviewId, {
          ...roleFields(settings.small),
          cwd: this.worktreeOf(reviewId),
          systemPrompt: "",
          readOnly: postureFor(settings, "summarize") !== "full",
          mcpServers: [],
        });
        ctx.setSessionId(session.id);
        try {
          const { text, usage } = await timedTurn(ctx, "first", () =>
            collectTracked(this.opts.sessions, this.opts.runner, session, prompt, ctx.signal, (d) =>
              ctx.reportText(d),
              (name, detail, extra) => ctx.reportTool(name, detail, extra),
            turnHooks(ctx)),
          );
          ctx.reportUsage(usage);
          await this.recordUsage(reviewId, usage);
          const { data } = this.parseAndValidate(reviewId, text);
          await this.applyHunkSummary(reviewId, contentHash, parseHunkReply(text, data));
        } finally {
          try {
            await this.opts.runner.close(session);
          } catch {
            // ignore
          }
        }
      },
    });
  }

  /**
   * Store one hunk-pass result (#99), shared by `summarizeHunk` and the
   * hunk-pass stage (the two copied parse blocks). A missing summary stores
   * nothing, so the hunk shows the Summarize action again instead of
   * garbage. Guide-cited and one-line hunks are never hidden.
   *
   * Issue #169: the score is stored alongside, resolved against the
   * deterministic rules (`resolveHunkScore`): an unusable value reads as
   * routine, and a one-line change is never mechanical. Hiding still
   * follows `hiddenReason` alone — the score never hides or unhides.
   */
  private async applyHunkSummary(reviewId: string, contentHash: string, result: HunkReplyResult): Promise<void> {
    let hiddenReason = result.hiddenReason;
    const live = this.opts.reviews.getSnapshot(reviewId);
    const isOneLine = live ? this.isOneLineChange(live, contentHash) : false;
    if (live && (this.isCitedByGuide(reviewId, contentHash) || isOneLine)) {
      hiddenReason = null;
    }
    const score = resolveHunkScore(result.score, { isOneLine });
    await this.opts.reviews.mutate(reviewId, (draft) => {
      let state = draft.hunkStates.find((s) => s.contentHash === contentHash);
      if (!state) {
        state = { contentHash, folded: false, reviewed: false };
        draft.hunkStates.push(state);
      }
      if (result.summary !== undefined) {
        state.summary = result.summary;
      }
      state.score = score;
      const fileHunk = draft.files.flatMap((f) => f.hunks).find((h) => h.contentHash === contentHash);
      if (fileHunk) {
        if (hiddenReason) fileHunk.hiddenReason = hiddenReason;
        else delete fileHunk.hiddenReason;
      }
    });
  }

  /**
   * #123: a hunk hidden as uninteresting before the guide existed must not
   * stay hidden once the guide cites it. Runs when the reader lands; hunks
   * applied later check the live guide in `applyHunkSummary`, so either
   * order is safe (both are single atomic mutates on live state).
   */
  private async unhideCitedHunks(reviewId: string): Promise<void> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return;
    const cited = snapshot.files
      .flatMap((f) => f.hunks)
      .filter((h) => h.hiddenReason && this.isCitedByGuide(reviewId, h.contentHash))
      .map((h) => h.contentHash);
    if (cited.length === 0) return;
    const wanted = new Set(cited);
    await this.opts.reviews.mutate(reviewId, (draft) => {
      for (const h of draft.files.flatMap((f) => f.hunks)) {
        if (wanted.has(h.contentHash)) delete h.hiddenReason;
      }
    });
  }

  // -- internals ------------------------------------------------------

  private render(template: string, variables: Record<string, unknown>): string {
    const lib = loadTemplatesDirSync(this.promptsDir);
    const tpl = lib.get(template);
    if (!tpl) throw new Error(`unknown prompt template ${template}`);
    return renderTemplate(tpl, variables);
  }

  private worktreeOf(reviewId: string): string {
    return path.join(this.opts.dataDir, "worktrees", reviewId);
  }

  /**
   * Issue #222: a document review's session cwd — the first context
   * repo's reading location (no managed worktree exists for it). Falls
   * back to the change-review worktree path when unknown.
   */
  private sessionCwd(reviewId: string): string {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (snapshot && isDocumentReview(snapshot)) {
      const first = snapshot.contextRepos[0];
      if (first && fs.existsSync(first.path)) return first.path;
    }
    return this.worktreeOf(reviewId);
  }

  /** Issue #222: the base pack text — the document pack for document reviews. */
  private async basePackTextFor(
    snapshot: ReviewSnapshot,
    instructions: string,
    settings: Awaited<ReturnType<Pipeline["effectiveSettings"]>>,
  ): Promise<string> {
    if (isDocumentReview(snapshot)) {
      const text = await buildDocumentBaseText(this.opts.commands, snapshot);
      return `Read the base context below and reply with exactly \`ready\` and nothing else.\n\n${text}`;
    }
    const promptSnap = toPromptSnapshot(snapshot, { model: settings.main.model });
    const pack = buildBasePack(promptSnap, instructions, { inlineBudgetTokens: settings.inlineBudgetTokens });
    return `Read the base context below and reply with exactly \`ready\` and nothing else.\n\n${pack.user}`;
  }

  private parseAndValidate(
    reviewId: string,
    text: string,
    echoCandidates?: string[],
    existingFiles?: ReadonlySet<string>,
    existingCodeTargets?: ReadonlySet<string>,
  ): { cards: ParsedCard[]; data: ReplyData | null; validation: ReturnType<typeof validateReply>; body: string } {
    const split = splitReply(text);
    // Malformed / non-object trailers are job-visible errors (reply-format
    // §10); a missing block is fine (many on-demand replies carry none).
    if (!split.ok && (split.error.kind === "malformed" || split.error.kind === "not-object")) {
      throw new Error(`the agent's reply was not in the expected format (${split.error.kind}: ${split.error.message})`);
    }
    const body = split.body;
    // Issue #50: the echo strip runs here, before validation, so a dropped
    // echo line's citations never enter the report (an echo line carries
    // none — lines with citations are kept).
    const cards =
      echoCandidates === undefined ? parseCards(body) : parseCards(body, { echoCandidates });
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const lookup = this.lookupWithAliases(snapshot, existingFiles, existingCodeTargets);
    const blocks = cards.flatMap((c) => c.blocks);
    const anchor =
      split.ok && typeof split.data === "object" && split.data !== null
        ? (split.data as ReplyData).anchor
        : undefined;
    const validation = validateReply(blocks, lookup, {
      ...(anchor?.quote && anchor?.host ? { anchor: { quote: anchor.quote, host: anchor.host } } : {}),
    });
    return { cards, data: split.ok ? (split.data as ReplyData) : null, validation, body };
  }

  /**
   * `parseAndValidate` with `code:` files checked for existence at the
   * cited commit (#81, PRD §10: no length check). The snapshot lookup
   * alone only knows diff files, so every `code:` citation to a file
   * outside the diff used to come back unverified and burn a repair turn.
   * Existence is resolved through `git show` (the `get_code` source)
   * first; missing and binary files stay unverified.
   */
  private async parseAndValidateWithCode(
    reviewId: string,
    text: string,
    echoCandidates?: string[],
  ): Promise<ReturnType<typeof this.parseAndValidate>> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    let existingFiles: ReadonlySet<string> | undefined;
    let existingCodeTargets: ReadonlySet<string> | undefined;
    try {
      const split = splitReply(text);
      const cards =
        echoCandidates === undefined ? parseCards(split.body) : parseCards(split.body, { echoCandidates });
      const collected = collectTargets(cards.flatMap((c) => c.blocks));
      const targets = [...collected.citations, ...collected.links];
      if (targets.some((t) => t.startsWith("code:"))) {
        // Issue #222: document answers cite context-repo files; the repo
        // is resolved from the cited sha (first repo containing it), and
        // existence is keyed by the exact `path@sha`.
        if (isDocumentReview(snapshot)) {
          existingCodeTargets = await resolveDocumentCodeExistence(this.opts.commands, snapshot.contextRepos, targets);
        } else {
          existingFiles = await resolveCodeFileExistence(
            this.opts.commands,
            this.worktreeOf(reviewId),
            snapshot.version.headSha,
            targets,
          );
        }
      }
    } catch {
      existingFiles = undefined;
      existingCodeTargets = undefined;
    }
    return this.parseAndValidate(reviewId, text, echoCandidates, existingFiles, existingCodeTargets);
  }

  /** Alias-aware lookup for diagram cite validation (demo fixture keys). */
  lookupForDiagrams(reviewId: string): ReturnType<typeof lookupForSnapshot> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    return this.lookupWithAliases(snapshot);
  }

  /**
   * Decide a finished turn's fate from facts the service observes, never
   * from the reply's wording (#180; the phrase matching from #51 is gone):
   * - the trailing `degraded` field is present with a usable body (it
   *   parses and has at least one block): keep the answer as written,
   *   record the raw reason on the job and add the quiet note. Never a
   *   failure when there is content;
   * - a review-tool call observably failed to connect this turn (a hit
   *   on an unknown/revoked MCP secret): fail as a connection error,
   *   which the caller retries once on a fresh session;
   * - the answer is empty (no usable block): fail. An explicit
   *   `degraded` reason on an empty answer names the failure.
   * Everything else is kept, whatever words it uses. The fail messages
   * land in the job error, shown on the Debug page.
   */
  private turnDisposition(
    reviewId: string,
    before: { connected: number; toolCalls: number; unknownHits: number },
    data: ReplyData | null,
    blockCount: number,
  ): TurnDisposition {
    const field = data?.degraded;
    const reason =
      typeof field === "string" && field.trim() !== "" ? field.trim().slice(0, 300) : undefined;
    if (reason !== undefined && blockCount > 0) return { kind: "keep", reason };
    const after = this.opts.mcp.activitySnapshot(reviewId);
    if (after.unknownHits > before.unknownHits) {
      return {
        kind: "fail-conn",
        message: `a review-MCP call failed to connect this turn`,
      };
    }
    if (blockCount === 0) {
      return {
        kind: "fail-empty",
        message: reason !== undefined ? `agent reported a degraded turn: ${reason}` : `agent reply was empty`,
      };
    }
    return { kind: "ok" };
  }

  /**
   * ActionContext for diagram finalize/repair from fills that run inside
   * the pipeline itself (go-deeper, concept pages). finalizeFresh takes
   * an ActionContext; the pipeline owns every field it needs.
   */
  private actionContextFor(reviewId: string): ActionContext {
    return {
      pipeline: this,
      jobs: this.opts.jobs,
      reviews: this.opts.reviews,
      reviewId,
      ...(this.opts.sharedctx ? { sharedctx: this.opts.sharedctx } : {}),
      ...(this.opts.fixturesDir ? { fixturesDir: this.opts.fixturesDir } : {}),
      ...(this.promptsDir ? { promptsDir: this.promptsDir } : {}),
    };
  }

  /**
   * Finalize inline diagrams for a fill that already holds its blocks
   * (#130, #145): pre-check + render, plus exactly one repair turn on the
   * fill's own session when needed. A failed repair keeps the
   * error-status blocks; the prose is unaffected. One place decides "this
   * block is a diagram that needs finalizing", used by every job kind:
   * pipeline fills call this directly; second opinions call it through
   * their deps' pipeline. Never touches the shared log (no ingestTurn),
   * so second-opinion isolation holds.
   */
  async finalizeInlineBlocks(
    reviewId: string,
    session: Session,
    signal: AbortSignal | undefined,
    card: string,
    level: string,
    blocks: Block[],
    onUsage?: (u: TokenUsage) => void,
    onTool?: ToolCallback,
    turn?: TurnHooks,
  ): Promise<Block[]> {
    const first = await finalizeFresh(this.actionContextFor(reviewId), blocks);
    if (!first.needsRepair) return first.blocks;
    return this.repairDiagramsInline(reviewId, session, signal, card, level, first, onUsage, onTool, turn);
  }

  /**
   * One inline diagram-repair turn on an already-forked session (#130).
   * Fills that run inside a job (go-deeper, concept pages) cannot enqueue
   * a nested repair job through runInFork: with every per-provider slot
   * held by fills awaiting repair, the repairs would never start. So the
   * turn runs on the fill's own session with the same prompt shape —
   * exactly one turn, no loop. Content failures keep the error-status
   * blocks; aborts and transient (retryable) errors propagate so the
   * fill's job can cancel or retry whole.
   */
  private async repairDiagramsInline(
    reviewId: string,
    session: Session,
    signal: AbortSignal | undefined,
    card: string,
    level: string,
    first: { blocks: Block[]; messages: string[] },
    onUsage?: (u: TokenUsage) => void,
    onTool?: ToolCallback,
    turn?: TurnHooks,
  ): Promise<Block[]> {
    const actx = this.actionContextFor(reviewId);
    try {
      const variables = buildRepairVariables(card, level, first.messages, first.blocks);
      const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner,
        session,
        this.render("diagram", variables),
        signal,
        () => {},
        onTool,
        turn,
      );
      onUsage?.(usage);
      await this.recordUsage(reviewId, usage);
      const second = this.parseAndValidate(reviewId, text);
      const merged = mergeRepairedDiagrams(first.blocks, second.cards.flatMap((c) => c.blocks));
      return (await finalizeFresh(actx, merged)).blocks;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof RetryableError) throw err;
      return first.blocks;
    }
  }

  private lookupWithAliases(
    snapshot: ReviewSnapshot,
    existingFiles?: ReadonlySet<string>,
    existingCodeTargets?: ReadonlySet<string>,
  ): ReturnType<typeof lookupForSnapshot> {
    const aliases = aliasesForReview(snapshot, this.opts.fixturesDir);
    if (Object.keys(aliases).length === 0) {
      return lookupForSnapshot(snapshot, { existingFiles, existingCodeTargets });
    }
    const base = lookupForSnapshot(snapshot, { existingFiles, existingCodeTargets });
    const inner = base.resolveFileKey.bind(base);
    return {
      ...base,
      resolveFileKey: (key: string) => inner(key) ?? (aliases[key] ? inner(aliases[key]) : null),
    };
  }

  private withValidation(
    reviewId: string,
    blocks: Block[],
    validation: ReturnType<typeof validateReply>,
  ): Block[] {
    // Stored targets are canonical (real file keys): repaired tokens resolve
    // to their fix, alias-form tokens (`diff:conn:…`) resolve through the
    // lookup, and only truly unknown targets keep their raw form flagged.
    // The web needs no alias table.
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    const resolve = snapshot
      ? this.lookupWithAliases(snapshot).resolveFileKey.bind(this.lookupWithAliases(snapshot))
      : () => null;
    const byTarget = new Map(validation.tokens.map((t) => [t.target, t]));
    const mark = (citations: { target: string; unverified?: boolean }[]): { target: string; unverified?: boolean }[] =>
      citations.map((c) => {
        const rep = byTarget.get(c.target);
        if (rep?.status === "repaired" && rep.repairedTo) {
          return { target: canonicalizeTarget(rep.repairedTo, resolve) };
        }
        if (rep?.status === "unverified") return { target: c.target, unverified: true };
        return { target: canonicalizeTarget(c.target, resolve) };
      });
    return blocks.map((b) => {
      switch (b.type) {
        case "paragraph":
          return { ...b, citations: mark(b.citations) };
        case "list":
          return {
            ...b,
            items: b.items.map((it) => ({ ...it, citations: mark(it.citations) })),
            citations: mark(b.citations),
          };
        case "table":
        case "code":
        case "diagram":
        case "finding-link":
        case "follow-up":
          return { ...b, citations: mark((b as { citations: { target: string }[] }).citations) };
        case "comment-link":
          return {
            ...b,
            diffRef: canonicalizeTarget(b.diffRef, resolve),
            citations: mark(b.citations),
          };
        case "aside":
          return { ...b, inner: this.withValidation(reviewId, b.inner, validation), citations: mark(b.citations) };
      }
    });
  }

  private async ensureBase(reviewId: string): Promise<{ sessionId: string; key: string }> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const settings = await this.effectiveSettings();
    const lib = loadTemplatesDirSync(this.promptsDir);
    const instructions = renderSystemPrompt(lib, postureFor(settings));
    // Document reviews build their pack from the document + repo maps
    // (#222); change reviews from L1+L1b+L2. The ready prefix is shared.
    const isDocument = isDocumentReview(snapshot);
    const pack = isDocument
      ? null
      : buildBasePack(toPromptSnapshot(snapshot, { model: settings.main.model }), instructions, {
          inlineBudgetTokens: settings.inlineBudgetTokens,
        });
    const packText = isDocument
      ? await this.basePackTextFor(snapshot, instructions, settings)
      : `Read the base context below and reply with exactly \`ready\` and nothing else.\n\n${pack!.user}`;
    const key = {
      reviewId,
      reviewVersion: `v${snapshot.version.n}`,
      guideRevision: guideRevisionForSnapshot(snapshot),
      provider: settings.main.provider,
      model: settings.main.model,
      access: postureFor(settings),
      effort: settings.main.effort,
    };
    const mcp = this.opts.mcp.issueSession(reviewId, `base-${reviewId}`, "session");
    const mcpServers = [{ name: "unvibe", url: `${this.mcpBaseUrl}${mcp.path}` }];
    const handle = await this.opts.sessions.getBase({
      key,
      cwd: this.sessionCwd(reviewId),
      systemPrompt: instructions,
      readOnly: postureFor(settings) !== "full",
      mcpServers,
      pack: packText,
    });
    if (!handle.fresh) {
      // Warm base: the build params (including this call's MCP URL) were
      // ignored, so the just-issued secret was never handed to any session.
      // Revoke it immediately instead of leaking one secret per call.
      this.opts.mcp.revokeSession(mcp.secret);
    }
    if (handle.fresh) {
      try {
        this.opts.sharedctx?.noteBaseBuilt(reviewId, handle.key, pack?.tokens ?? 0);
      } catch {
        // observability is best-effort
      }
    }
    this.setStage(reviewId, "base", "done");
    return { sessionId: handle.session.id, key: handle.key };
  }

  /**
   * #122: rebuild the base in the background when the guide changed, so it
   * is ready before the next click. Fire-and-forget (never fails the
   * caller); at most one warm per review at a time, and `getBase` shares
   * in-flight builds, so each guide state builds at most once. A warm for a
   * guide state nobody acts on costs one base turn — the same turn the next
   * click would have paid.
   */
  private warmBase(reviewId: string): void {
    if (this.warmInFlight.has(reviewId)) return;
    this.warmInFlight.add(reviewId);
    void this.ensureBase(reviewId)
      .catch(() => {})
      .finally(() => {
        this.warmInFlight.delete(reviewId);
      });
  }

  /** #122: tails of per-review post-turn bookkeeping chains (never reject). */
  private bookkeepingTails = new Map<string, Promise<void>>();

  /**
   * #122: wait for the review's pending post-turn bookkeeping, so the next
   * job never forks (or continues) from a stale log. Resolves at once when
   * nothing is pending.
   */
  async drainBookkeeping(reviewId: string): Promise<void> {
    await (this.bookkeepingTails.get(reviewId) ?? Promise.resolve());
  }

  /**
   * #122: run post-turn bookkeeping serialized after the review's pending
   * bookkeeping. Callers resolve their answer first and await this before
   * their job settles. Never rejects (`ingestTurn` is best-effort).
   */
  async finishBookkeeping(reviewId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.bookkeepingTails.get(reviewId) ?? Promise.resolve();
    const cur = prev.then(task).then(
      () => undefined,
      () => undefined,
    );
    this.bookkeepingTails.set(reviewId, cur);
    try {
      await cur;
    } finally {
      if (this.bookkeepingTails.get(reviewId) === cur) this.bookkeepingTails.delete(reviewId);
    }
  }

  /**
   * Issue #136: continue a later turn on an existing conversation
   * session. The session is ensured (reopened when idle-closed); a
   * rebuild between the caller's probe and this job proceeds on the fresh
   * session — the retry path then forks with the stored transcript.
   */
  private async continueOn(sessionId: string): Promise<{ session: Session; viaFork: boolean }> {
    const { session } = await this.opts.sessions.ensureConversation(sessionId);
    return { session, viaFork: true };
  }

  /**
   * Issue #136: fork for a turn and register the fork when it backs a
   * persistent conversation (`conversationKey`, e.g. a card id).
   * Registration is what makes the session tracked, persisted,
   * idle-closed and reopenable (#143); one-shot forks stay untracked.
   */
  private async forkAndTrack(reviewId: string, track: boolean): Promise<{ session: Session; viaFork: boolean }> {
    const forked = await this.forkFor(reviewId);
    if (track) {
      const snapshot = this.opts.reviews.getSnapshot(reviewId);
      const settings = await this.effectiveSettings();
      if (snapshot) {
        this.opts.sessions.registerConversation(
          forked.session,
          {
            reviewId,
            reviewVersion: `v${snapshot.version.n}`,
            guideRevision: guideRevisionForSnapshot(snapshot),
            provider: settings.main.provider,
            model: settings.main.model,
            access: postureFor(settings),
            effort: settings.main.effort,
          },
          forked.viaFork,
        );
      }
    }
    return forked;
  }

  private async forkFor(reviewId: string): Promise<{ session: Session; viaFork: boolean }> {
    // #122: never fork from a stale log — wait for the previous turn's
    // bookkeeping (base growth) to land first.
    await this.drainBookkeeping(reviewId);
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const settings = await this.effectiveSettings();
    const lib = loadTemplatesDirSync(this.promptsDir);
    const instructions = renderSystemPrompt(lib, postureFor(settings));
    const packText = await this.basePackTextFor(snapshot, instructions, settings);
    const base = await this.opts.sessions.getBase({
      key: {
        reviewId,
        reviewVersion: `v${snapshot.version.n}`,
        guideRevision: guideRevisionForSnapshot(snapshot),
        provider: settings.main.provider,
        model: settings.main.model,
        access: postureFor(settings),
        effort: settings.main.effort,
      },
      cwd: this.sessionCwd(reviewId),
      systemPrompt: instructions,
      readOnly: postureFor(settings) !== "full",
      mcpServers: [{ name: "unvibe", url: `${this.mcpBaseUrl}/api/mcp/fallback` }],
      pack: packText,
    });
    const baseKey = {
      reviewId,
      reviewVersion: `v${snapshot.version.n}`,
      guideRevision: guideRevisionForSnapshot(snapshot),
      provider: settings.main.provider,
      model: settings.main.model,
      access: postureFor(settings),
      effort: settings.main.effort,
    };
    const runner = this.opts.runner;
    if (typeof runner.fork === "function") {
      try {
        const session = await runner.fork(base.session);
        // Issue #143: every fork is registered, one-shot forks included,
        // so it is tracked, persisted and idle-swept instead of
        // accumulating in the adapter process until it restarts.
        this.opts.sessions.registerConversation(session, baseKey, true);
        return { session, viaFork: true };
      } catch {
        // fall through
      }
    }
    const mcp = this.opts.mcp.issueSession(reviewId, `fork-${Date.now()}`, "session");
    const session = await runner.start({
      ...roleFields(settings.main),
      cwd: this.sessionCwd(reviewId),
      systemPrompt: instructions,
      readOnly: postureFor(settings) !== "full",
      mcpServers: [{ name: "unvibe", url: `${this.mcpBaseUrl}${mcp.path}` }],
    });
    for await (const ev of runner.prompt(session, packText)) {
      if (ev.type === "error" && ev.retryable) throw new RetryableError(ev.message);
      if (ev.type === "error") throw new Error(ev.message);
    }
    this.opts.sessions.registerConversation(session, baseKey, false);
    return { session, viaFork: false };
  }

  // -- reader ---------------------------------------------------------

  private async enqueueReader(reviewId: string): Promise<Job> {
    const settings = await this.effectiveSettings();
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const promptSnap = toPromptSnapshot(snapshot, { model: settings.main.model });
    // One ladder call for both halves (issue #107): source + diff come
    // from the same rung, so the reader prompt stays under the hard cap.
    const ladder = buildLadder(promptSnap, { inlineBudgetTokens: settings.inlineBudgetTokens });
    const source = ladder.source;
    const diff = ladder.diff;
    const lib = loadTemplatesDirSync(this.promptsDir);
    const instructions = renderSystemPrompt(lib, postureFor(settings));
    let prompt = renderTemplate(lib.get("reader")!, {
      source,
      diff_inline: diff.text,
      repo_path: this.worktreeOf(reviewId),
    });
    if (isReplayRunner(this.opts.runner)) prompt = withReplayMark(prompt, { kind: "reader" });
    this.setStage(reviewId, "reader", "running");
    return this.opts.jobs.enqueue({
      reviewId,
      kind: "reader",
      ...roleFields(settings.main),
      priority: JOB_PRIORITY.visible,
      dedupe: { anchor: "guide", requestKind: "reader", baseVersion: `v${snapshot.version.n}` },
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        // Card ids present before this turn: a failed turn removes what
        // it streamed, never older cards (#51). Read once: a retry's own
        // streamed cards must clear on a terminal failure too (#146).
        const beforeIds = new Set(
          (this.opts.reviews.getSnapshot(reviewId)?.pages.find((p) => p.id === "root")?.cards ?? []).map((c) => c.id),
        );
        // #146: the reader retries once on a fresh session when a turn
        // observably hit a dead review-MCP connection, like fork jobs. The
        // retry gets a fresh per-run secret and session, never the dead
        // turn's. Anything else (including a second connection failure) is
        // terminal.
        for (let attempt = 0; ; attempt++) {
          const mcp = this.opts.mcp.issueSession(reviewId, `reader-${reviewId}`, "reader");
          const session = await this.opts.runner.start({
            ...roleFields(settings.main),
            cwd: this.worktreeOf(reviewId),
            systemPrompt: instructions,
            readOnly: postureFor(settings) !== "full",
            mcpServers: [{ name: "unvibe", url: `${this.mcpBaseUrl}${mcp.path}` }],
          });
          ctx.setSessionId(session.id);
          try {
            let buffer = "";
            const streamed = new Set<number>();
            const mcpBefore = this.opts.mcp.activitySnapshot(reviewId);
            const { usage } = await timedTurn(ctx, "first", () =>
              collectTracked(this.opts.sessions, this.opts.runner,
              session,
              prompt,
              ctx.signal,
              (delta) => {
                ctx.reportText(delta);
                buffer += delta;
                try {
                  const partials = parseCardsPartial(buffer);
                  // An untitled first section is held back: it is either
                  // preamble (dropped) or settled by the final apply.
                  const skip = partials[0]?.title === null ? 1 : 0;
                  for (let i = skip; i < partials.length; i++) {
                    const p = partials[i];
                    const index = i - skip;
                    if (streamed.has(index)) continue;
                    streamed.add(index);
                    void this.applyReaderCard(reviewId, index, p.title, p.blocks);
                  }
                } catch {
                  // ignore mid-stream
                }
              },
              (name, detail, extra) => {
                // Text written before a tool call and before any card heading
                // is the agent narrating its exploration, not card content.
                ctx.reportTool(name, detail, extra);
                if (extra?.status !== "end" && !/^## /m.test(buffer)) buffer = "";
              },
              turnHooks(ctx)),
            );
            ctx.reportUsage(usage);
            await this.recordUsage(reviewId, usage);
            // Issue #213: a malformed / non-object trailing data block never
            // discards the guide. Keep the cards parsed from the body and
            // run one data-block repair turn below (same session).
            let brokenDataError: string | undefined;
            let firstParsed: Awaited<ReturnType<typeof this.parseAndValidateWithCode>>;
            try {
              firstParsed = await this.parseAndValidateWithCode(reviewId, buffer, []);
            } catch (err) {
              const msg = (err as Error).message;
              if (!msg.includes("was not in the expected format (malformed") && !msg.includes("was not in the expected format (not-object")) throw err;
              brokenDataError = msg;
              firstParsed = await this.parseAndValidateWithCode(reviewId, splitReply(buffer).body, []);
            }
            const { cards, data, validation } = firstParsed;
            let finalCards = cards;
            let finalData = data;
            let finalValidation = validation;
            // Facts only (#180), same as fork turns: wording never fails
            // the guide. An explicit degraded field with usable cards is
            // kept (reason on the job, quiet note on the last card) and
            // skips the repair turn; a connection failure retries once
            // on a fresh session; an empty reply fails.
            let degradedReason: string | undefined;
            const firstDisp = this.turnDisposition(
              reviewId,
              mcpBefore,
              data,
              cards.flatMap((c) => c.blocks).length,
            );
            if (firstDisp.kind === "fail-conn") throw new DegradedConnError(firstDisp.message);
            if (firstDisp.kind === "fail-empty") throw new DegradedTurnError(firstDisp.message);
            if (firstDisp.kind === "keep") degradedReason = firstDisp.reason;
            if (brokenDataError !== undefined) {
              // #213: one repair turn, same session, just the data block.
              const repairPrompt =
                `The trailing JSON block in your previous reply did not parse (${brokenDataError}). ` +
                `Resend just the data block: reply with only one fenced json block carrying the same trailing data ` +
                `(cardIds, pendingCards, plotlines and any contribute block), with no cards and no prose.`;
              ctx.setPromptSnapshot(`${prompt}\n\n--- repair turn ---\n${repairPrompt}`);
              const repair = await timedTurn(ctx, "repair", () =>
                collectTracked(this.opts.sessions, this.opts.runner, session, repairPrompt, ctx.signal, (d) =>
                  ctx.reportText(d),
                  (name, detail, extra) => ctx.reportTool(name, detail, extra),
                turnHooks(ctx)),
              );
              usage.inputTokens += repair.usage.inputTokens;
              usage.cachedReadTokens += repair.usage.cachedReadTokens;
              usage.cachedWriteTokens += repair.usage.cachedWriteTokens;
              usage.outputTokens += repair.usage.outputTokens;
              ctx.reportUsage(repair.usage);
              await this.recordUsage(reviewId, repair.usage);
              const repaired = splitReply(repair.text);
              if (repaired.ok) {
                finalData = repaired.data as ReplyData;
              } else {
                degradedReason =
                  "The reader's trailing data block did not parse and the repair reply did not parse either, so the guide has no plotlines or go-deeper directions.";
              }
            } else if (validation.needsRepairTurn && degradedReason === undefined) {
              const anchorProblem =
                validation.anchor && !validation.anchor.ok
                  ? `\nAnchor problem: ${validation.anchor.reason}. Reply with the same cards and a corrected anchor host (the host block's ID).\n`
                  : "";
              const repairPrompt =
                `Some citations in your previous reply could not be verified:\n` +
                validation.tokens
                  .filter((t) => t.status === "unverified")
                  .map((t) => `- ${t.target}: ${t.reason ?? "unknown"}`)
                  .join("\n") +
                anchorProblem +
                `\nReply with the same cards and corrected citation tokens. End with the same trailing JSON block.`;
              // #124: the repair prompt names the failed citations, so keep
              // it on the job's stored prompt — the Debug page then shows
              // what failed (prompt wording, an ID shape, or the validator).
              ctx.setPromptSnapshot(`${prompt}\n\n--- repair turn ---\n${repairPrompt}`);
              const repair = await timedTurn(ctx, "repair", () =>
                collectTracked(this.opts.sessions, this.opts.runner, session, repairPrompt, ctx.signal, (d) =>
                  ctx.reportText(d),
                  (name, detail, extra) => ctx.reportTool(name, detail, extra),
                turnHooks(ctx)),
              );
              usage.inputTokens += repair.usage.inputTokens;
              usage.cachedReadTokens += repair.usage.cachedReadTokens;
              usage.cachedWriteTokens += repair.usage.cachedWriteTokens;
              usage.outputTokens += repair.usage.outputTokens;
              ctx.reportUsage(repair.usage);
              await this.recordUsage(reviewId, repair.usage);
              const second = await this.parseAndValidateWithCode(reviewId, repair.text, []);
              finalCards = second.cards;
              finalData = second.data;
              finalValidation = second.validation;
              const secondDisp = this.turnDisposition(
                reviewId,
                mcpBefore,
                second.data,
                second.cards.flatMap((c) => c.blocks).length,
              );
              if (secondDisp.kind === "fail-conn") throw new DegradedConnError(secondDisp.message);
              if (secondDisp.kind === "fail-empty") throw new DegradedTurnError(secondDisp.message);
              if (secondDisp.kind === "keep" && degradedReason === undefined) degradedReason = secondDisp.reason;
            }
            if (degradedReason !== undefined) {
              attachDegradedNote(finalCards);
              ctx.setDegradedReason(degradedReason);
            }
            // #145: diagrams the reader wrote inline in guide cards go
            // through the same finalize + one repair turn as every other
            // fill, on the reader's own session. Flattened so a bad
            // diagram costs one shared repair turn, then split back.
            const flat = finalCards.flatMap((c) => c.blocks);
            const finalized = await this.finalizeInlineBlocks(
              reviewId,
              session,
              ctx.signal,
              `Guide: ${finalCards.map((c) => c.title ?? "(untitled)").join(" / ")}`,
              "standard",
              flat,
              (u) => ctx.reportUsage(u),
              (name, detail, extra) => ctx.reportTool(name, detail, extra),
              turnHooks(ctx),
            );
            const withDiagrams = splitFinalizedBlocks(finalCards, finalized);
            await this.applyReaderResult(reviewId, withDiagrams, finalData, finalValidation);
            // #122: the guide cards are already applied above; bookkeeping
            // joins the per-review chain (still awaited before the job ends).
            await this.finishBookkeeping(reviewId, () => this.ingestTurn(reviewId, { sessionId: session.id, data: finalData }));
            this.setStage(reviewId, "reader", "done");
            // Awaited: the reader job ends with its follow-ups enqueued and
            // the cited-hunk repair applied (#123), never floating behind it.
            await this.enqueueAfterReader(reviewId);
            // #122: the guide just landed — build the base before the next click.
            this.warmBase(reviewId);
            return;
        } catch (err) {
          // One retry on a fresh session when the turn observably hit a
          // dead review-MCP connection (#146, like fork jobs): the loop
          // re-issues the secret and session above. Provisional ids are
          // deterministic (`readerCardId`), so the retry's streams overwrite
          // this attempt's partials instead of duplicating them; the final
          // apply drops whatever the winning attempt did not reproduce.
          // Usage already reported + recorded per attempt above lands in the
          // totals exactly once per attempt — never twice, never lost.
          // A turn that died mid-stream carries its counted usage on the
          // error (#151): record that too, once, before any retry.
          await this.reportPartialUsage(ctx, reviewId, err);
          if (err instanceof DegradedConnError && attempt < 1) continue;
          // Terminal. The stage error is reader-facing (plain words, #45:
          // no MCP, no tool names); the raw reason stays on the job error
          // for the Debug page. Retry is the guide's Retry control (#86).
          this.setStage(
            reviewId,
            "reader",
            "error",
            err instanceof DegradedConnError
              ? "The guide couldn't be started because the review details couldn't be reached. Please retry."
              : (err as Error).message,
          );
          if (err instanceof DegradedTurnError) {
            // A failed turn must leave no card behind: provisional cards
            // streamed mid-turn are not a finished guide (#51).
            await this.opts.reviews.mutate(reviewId, (draft) => {
              const root = draft.pages.find((p) => p.id === "root");
              if (!root) return;
              root.cards = root.cards.filter((c) => beforeIds.has(c.id));
            }).catch(() => {});
          }
          throw err;
        } finally {
          try {
            await this.opts.runner.close(session);
          } catch {
            // ignore
          }
          // The reader session is closed: its MCP secret dies with it.
          // Per attempt, so a retry never reuses the dead turn's secret.
          this.opts.mcp.revokeSession(mcp.secret);
          }
        }
      },
    });
  }

  private async applyReaderCard(
    reviewId: string,
    index: number,
    title: string | null,
    blocks: Block[],
  ): Promise<void> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return;
    const lookup = this.lookupWithAliases(snapshot);
    const validation = validateReply(blocks, lookup);
    const fixed = this.withValidation(reviewId, blocks, validation);
    const provisionalId = readerCardId(index, [], title);
    await this.opts.reviews.mutate(reviewId, (draft) => {
      let root = draft.pages.find((p) => p.id === "root");
      if (!root) {
        root = { id: "root", kind: "root", title: DEFAULT_GUIDE_TITLE, cards: [] };
        draft.pages.unshift(root);
      }
      const existing = root.cards.find((c) => c.id === provisionalId);
      if (existing) {
        existing.title = title;
        existing.blocks = fixed;
      } else {
        root.cards.push({
          id: provisionalId,
          pageId: "root",
          title,
          level: "standard",
          collapsed: false,
          revision: 1,
          blocks: fixed,
          undoStack: [],
        });
      }
      this.markFirstCard(draft);
    });
  }

  private async applyReaderResult(
    reviewId: string,
    cards: ParsedCard[],
    data: ReplyData | null,
    validation: ReturnType<typeof validateReply>,
  ): Promise<void> {
    const applied = readerApply(
      cards.map((c) => ({ title: c.title, blocks: c.blocks })),
      (data ?? null) as Record<string, unknown> | null,
    );
    // Issue #169: validate the reader's plotline hunk IDs like any other
    // ID before storing. Unknown IDs are dropped, a twice-claimed hunk
    // keeps its first plotline; hunks left out stay unassigned ("other").
    const knownPlotHunks = new Set<string>();
    for (const f of this.opts.reviews.getSnapshot(reviewId)?.files ?? []) {
      for (const h of f.hunks) knownPlotHunks.add(`h:${f.fileKey}:${h.contentHash}`);
    }
    const plotlines = normalizePlotlines(applied.plotlines, knownPlotHunks);
    const dropped = plotlines.dropped;
    if (dropped.unknown.length > 0 || dropped.duplicates.length > 0 || dropped.extraPlotlines > 0) {
      console.warn(
        `[reader] ${reviewId}: plotlines dropped ` +
          `${dropped.unknown.length} unknown hunk IDs` +
          (dropped.unknown.length > 0 ? ` (${dropped.unknown.slice(0, 5).join(", ")})` : "") +
          `, ${dropped.duplicates.length} duplicates, ${dropped.extraPlotlines} extra plotlines`,
      );
    }
    await this.opts.reviews.mutate(reviewId, (draft) => {
      let root = draft.pages.find((p) => p.id === "root");
      if (!root) {
        root = { id: "root", kind: "root", title: DEFAULT_GUIDE_TITLE, cards: [] };
        draft.pages.unshift(root);
      }
      for (const c of applied.cards) {
        const fixed = this.withValidation(reviewId, c.blocks, validation);
        const existing = root.cards.find((x) => x.id === c.id);
        if (existing) {
          existing.title = c.title;
          existing.blocks = fixed;
          existing.revision += 1;
        } else {
          root.cards.push({
            id: c.id,
            pageId: "root",
            title: c.title,
            level: "standard",
            collapsed: false,
            revision: 1,
            blocks: fixed,
            undoStack: [],
          });
        }
      }
      const order = applied.cards.map((c) => c.id);
      // The final reply is authoritative: a streamed card it does not
      // contain (preamble, or a card the repair turn dropped) goes.
      root.cards = root.cards.filter((c) => order.includes(c.id) || !isDefaultReaderCardId(c.id));
      root.cards.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return 0;
      });
      for (const p of applied.pendingCards) {
        if (root.cards.some((c) => c.id === p.id)) continue;
        root.cards.push({
          id: p.id,
          pageId: "root",
          title: p.label,
          level: "standard",
          collapsed: false,
          revision: 1,
          blocks: [],
          undoStack: [],
          pending: { label: p.label, why: p.why },
        });
      }
      // Issue #169: store the validated plotlines; per-hunk assignment
      // rides `HunkState.plotline` (content-hash keyed, like summaries).
      draft.plotlines = plotlines.plotlines;
      for (const [hid, pid] of Object.entries(plotlines.assignment)) {
        const hash = hid.slice(hid.lastIndexOf(":") + 1);
        let state = draft.hunkStates.find((s) => s.contentHash === hash);
        if (!state) {
          state = { contentHash: hash, folded: false, reviewed: false };
          draft.hunkStates.push(state);
        }
        state.plotline = pid;
      }
      this.markFirstCard(draft);
      const seq = draft.logTail.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      draft.logTail.push({
        seq,
        kind: "new-card",
        payload: { summary: "reader published problem + central", unverified: validation.unverified },
        scope: { scope: "global" },
      });
    });
    await this.persistPins(reviewId);
    await this.updateRestatedMapping(reviewId);
  }

  // -- after reader ---------------------------------------------------

  private async enqueueAfterReader(reviewId: string): Promise<Job[]> {
    const out: Job[] = [];
    this.setStage(reviewId, "base", "running");
    out.push(...(await this.enqueueCritic(reviewId)));
    // #123: the hunk pass starts in startReview now (at ingest), not here.
    // Hunks hidden before the guide existed are unhidden when cited.
    await this.unhideCitedHunks(reviewId);
    // Issue #107: past the fan-out limit the ingest-time pass enqueues
    // nothing (no guide exists yet to cite), so fan out the guide-cited
    // hunks now that the reader landed; the rest stay on demand. Under the
    // limit the ingest pass already covers every hunk.
    const snapshotNow = this.opts.reviews.getSnapshot(reviewId);
    const hunkCount = snapshotNow?.files.reduce((n, f) => n + f.hunks.length, 0) ?? 0;
    if (hunkCount > DEFAULT_HUNK_PASS_FANOUT_LIMIT) {
      out.push(...(await this.enqueueHunkPass(reviewId)));
    }
    // #217 owner order: auto go-deeper runs after the hunk summaries
    // (enqueued at start) and the critic, before any other background
    // job. The queue is FIFO within the background band, so enqueue
    // order is the run order: critic, go-deeper, then plotline assign.
    out.push(...(await this.enqueueAutoGoDeeper(reviewId)));
    // Issue #169: on degraded reader rungs the follow-up assign step
    // places the hunks the reader never saw; otherwise left-outs stay
    // "other".
    out.push(...(await this.maybeEnqueuePlotlineAssign(reviewId)));
    return out;
  }

  private async enqueueCritic(reviewId: string): Promise<Job[]> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return [];
    this.setStage(reviewId, "critic", "running");
    const settings = await this.effectiveSettings();
    const lib = loadTemplatesDirSync(this.promptsDir);
    const basePrompt = renderTemplate(lib.get("critic")!, {});
    // #215: one critic job per review; its reply carries its findings (usually 1-3, all kept).
    const replay = isReplayRunner(this.opts.runner);
    const prompt = replay ? withReplayMark(basePrompt, { kind: "critic" }) : basePrompt;
    const job = this.opts.jobs.enqueue({
      reviewId,
      kind: "critic",
      ...roleFields(settings.main),
      priority: JOB_PRIORITY.background,
      dedupe: { anchor: "finding:critic", requestKind: "critic", baseVersion: `v${snapshot.version.n}` },
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        const base = await this.ensureBase(reviewId);
        void base;
        const forked = await this.forkFor(reviewId);
        ctx.setSessionId(forked.session.id);
        try {
          const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner, forked.session, prompt, ctx.signal, (d) =>
            ctx.reportText(d),
            (name, detail, extra) => ctx.reportTool(name, detail, extra),
          turnHooks(ctx));
          ctx.reportUsage(usage);
          await this.recordUsage(reviewId, usage);
          const { cards, data, validation } = this.parseAndValidate(reviewId, text, []);
          const appliedList = criticApplyAll(
            cards.map((c) => ({ title: c.title, blocks: c.blocks })),
            (data ?? null) as Record<string, unknown> | null,
            "f-critic",
          );
          await this.opts.reviews.mutate(reviewId, (draft) => {
            for (const applied of appliedList) {
              if (draft.pages.some((p) => p.id === applied.pageId)) continue;
              const fixedCards = applied.cards.map((c) => ({ ...c, blocks: this.withValidation(reviewId, c.blocks, validation) }));
              draft.pages.push({
                id: applied.pageId,
                kind: "finding",
                title: applied.title,
                parent: "root",
                confidence: applied.confidence,
                summary: applied.summary,
                cards: fixedCards.map((c) => ({
                  id: c.id,
                  pageId: applied.pageId,
                  title: c.title,
                  level: "standard",
                  collapsed: false,
                  revision: 1,
                  blocks: c.blocks,
                  undoStack: [],
                })),
              });
              if (applied.suggestedComment) {
                const parsed = parseId(applied.suggestedComment.diff);
                if (parsed?.kind === "diff") {
                  const before = this.opts.reviews.getSnapshot(reviewId);
                  const aliases = aliasesForReview(
                    before ?? (draft as unknown as ReviewSnapshot),
                    this.opts.fixturesDir,
                  );
                  const fileKey = aliases[parsed.fileKey] ?? parsed.fileKey;
                  let quote = "";
                  for (const f of draft.files) {
                    if (f.fileKey !== fileKey) continue;
                    for (const h of f.hunks) {
                      for (const row of h.lines) {
                        if (row.newLine === parsed.start) quote = row.text;
                      }
                    }
                  }
                  try {
                    const thread = createSuggestedCommentInDraft(
                      draft,
                      before ?? (draft as unknown as ReviewSnapshot),
                      {
                        anchor: { where: "diff-line", fileKey, line: parsed.start },
                        quote,
                        suggestionText: applied.suggestedComment.text,
                      },
                    );
                    const page = draft.pages.find((p) => p.id === applied.pageId);
                    const last = page?.cards[page.cards.length - 1];
                    if (last) {
                      const range =
                        parsed.start === parsed.end ? `${parsed.start}` : `${parsed.start}-${parsed.end}`;
                      const diffRef = `diff:${fileKey}:${range}`;
                      last.blocks.push({
                        type: "comment-link",
                        id: "b-comment",
                        diffRef,
                        threadId: thread.id,
                        citations: [{ target: diffRef }],
                      });
                    }
                  } catch {
                    // Unknown file/line: keep the finding, skip the draft.
                  }
                }
              }
              const seq = draft.logTail.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
              draft.logTail.push({
                seq,
                kind: "new-finding",
                payload: { summary: `${applied.title}\n\n${applied.summary}`, unverified: validation.unverified },
                scope: { scope: "global" },
              });
            }
          });
          await this.updateRestatedMapping(reviewId);
          await this.finishBookkeeping(reviewId, () => this.ingestTurn(reviewId, { sessionId: forked.session.id, data }));
          this.warmBase(reviewId);
          this.maybeMarkStageDone(reviewId, "critic", 1);
        } catch (err) {
          await this.reportPartialUsage(ctx, reviewId, err);
          this.setStage(reviewId, "critic", "error", (err as Error).message);
          throw err;
        }
      },
    });
    return [job];
  }

  /**
   * Issue #209: start a session inside the job's "session start" turn and
   * attribute the runner's session-start (warm-up) usage to that turn —
   * separately from the first real turn. The figures are exact
   * adapter-reported counts, not computed. Job and review totals still sum
   * both turns, so per-job figures are unchanged; only which turn shows
   * them. Runners that report no session-start usage (fakes, Codex,
   * non-empty system prompts) leave the turn without token counts, as
   * before.
   */
  private async startSessionForJob(
    ctx: {
      beginTurn(label: string): void;
      endTurn(): void;
      reportUsage(usage: TokenUsage): void;
      reportTurnUsage(usage: TokenUsage): void;
    },
    reviewId: string,
    opts: Parameters<AgentRunner["start"]>[0],
  ): Promise<Session> {
    ctx.beginTurn("session start");
    try {
      const session = await this.opts.runner.start(opts);
      const warm = this.opts.runner.takeSessionStartUsage?.(session.id);
      if (warm !== undefined) {
        const usage: TokenUsage = {
          inputTokens: warm.inputTokens,
          cachedReadTokens: warm.cachedReadTokens,
          cachedWriteTokens: warm.cachedWriteTokens,
          outputTokens: warm.outputTokens,
        };
        ctx.reportTurnUsage(usage);
        ctx.reportUsage(usage);
        await this.recordUsage(reviewId, usage);
      }
      return session;
    } finally {
      ctx.endTurn();
    }
  }

  private async enqueueHunkPass(reviewId: string): Promise<Job[]> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return [];
    this.setStage(reviewId, "hunk-pass", "running");
    const settings = await this.effectiveSettings();
    const hunks = snapshot.files.flatMap((f) => f.hunks.map((h) => ({ file: f, hunk: h })));
    // Issue #107: past the fan-out limit there is no per-hunk fan-out —
    // only guide-cited hunks lacking a stored summary are enqueued, and
    // everything else summarises on demand (`POST …/hunks/:hash/summarize`,
    // Fold-all). At ingest (#123 starts the pass here) no guide exists yet,
    // so the cited set is empty and the stage reaches done with no jobs;
    // `enqueueAfterReader` fans out the cited hunks once the reader lands.
    // Resume re-runs this same branch — never the full fan-out.
    const overLimit = hunks.length > DEFAULT_HUNK_PASS_FANOUT_LIMIT;
    const targets = overLimit
      ? hunks.filter(({ hunk }) => {
          if (!this.isCitedByGuide(reviewId, hunk.contentHash)) return false;
          return snapshot.hunkStates.find((s) => s.contentHash === hunk.contentHash)?.summary === undefined;
        })
      : hunks;
    if (targets.length === 0) {
      this.setStage(reviewId, "hunk-pass", "done");
      return [];
    }
    this.hunkPassCompleted.set(reviewId, 0);
    const hunkPassAccess = postureFor(settings, "hunk-pass");
    return targets.map(({ file, hunk }) =>
      this.enqueueOneHunkPass(reviewId, snapshot, file, hunk, settings.small, targets.length, hunkPassAccess),
    );
  }

  private enqueueOneHunkPass(
    reviewId: string,
    snapshot: ReviewSnapshot,
    file: ReviewSnapshot["files"][number],
    hunk: ReviewSnapshot["files"][number]["hunks"][number],
    small: { provider: string; model: string; effort: string },
    expectedJobs: number,
    access: AccessMode,
  ): Job {
    const hunkText = this.formatHunkForPrompt(snapshot, file.fileKey, hunk.contentHash);
    const cited = this.isCitedByGuide(reviewId, hunk.contentHash);
    const body = cited ? `${hunkText}\n\nCITED-BY-GUIDE` : hunkText;
    const replayKey = this.replayKeyForHunk(snapshot, file.fileKey, hunk.contentHash);
    const prompt = withReplayMark(
      this.render("hunk_pass", { hunk: body, path: file.path, plotline: this.plotlineForHunk(snapshot, hunk.contentHash) }),
      isReplayRunner(this.opts.runner) && replayKey ? { kind: "hunk", key: replayKey } : undefined,
    );
    return this.opts.jobs.enqueue({
      reviewId,
      kind: "hunk-pass",
      ...roleFields(small),
      priority: JOB_PRIORITY.background,
      dedupe: { anchor: `hunk:${hunk.contentHash}`, requestKind: "hunk-pass", baseVersion: `v${snapshot.version.n}` },
      accessMode: access,
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        // Issue #210 (#194): time the fresh-session start separately from
        // the summary turn, so the Debug page can split setup from model
        // time. For Claude the start includes the shared-cache warm-up
        // turn, which runs inside `runner.start`; its usage lands on this
        // turn (see startSessionForJob), not on the summary turn.
        const session = await this.startSessionForJob(ctx, reviewId, {
          ...roleFields(small),
          cwd: this.worktreeOf(reviewId),
          systemPrompt: "",
          readOnly: access !== "full",
          mcpServers: [],
        });
        ctx.setSessionId(session.id);
        try {
          const { text, usage } = await timedTurn(ctx, "first", () =>
            collectTracked(this.opts.sessions, this.opts.runner, session, prompt, ctx.signal, (d) =>
              ctx.reportText(d),
              (name, detail, extra) => ctx.reportTool(name, detail, extra),
            turnHooks(ctx)),
          );
          ctx.reportUsage(usage);
          await this.recordUsage(reviewId, usage);
          const { data } = this.parseAndValidate(reviewId, text);
          await this.applyHunkSummary(reviewId, hunk.contentHash, parseHunkReply(text, data));
          this.markHunkPassComplete(reviewId, expectedJobs);
        } catch (err) {
          await this.reportPartialUsage(ctx, reviewId, err);
          this.setStage(reviewId, "hunk-pass", "error", (err as Error).message);
          throw err;
        } finally {
          try {
            await this.opts.runner.close(session);
          } catch {
            // ignore
          }
        }
      },
    });
  }

  /**
   * Record one hunk-pass job's success; mark the stage done once every job
   * of the last fan-out completed. Never overwrites an error set by a
   * failed sibling (resume retries it).
   */
  private markHunkPassComplete(reviewId: string, expectedJobs: number): void {
    try {
      const completed = (this.hunkPassCompleted.get(reviewId) ?? 0) + 1;
      this.hunkPassCompleted.set(reviewId, completed);
      if (completed < expectedJobs) return;
      const errored = this.opts.jobs
        .listByReview(reviewId)
        .some((j) => j.kind === "hunk-pass" && j.state === "error");
      if (!errored) this.setStage(reviewId, "hunk-pass", "done");
    } catch {
      // ignore
    }
  }

  /**
   * Issue #169 large-PR fallback (#107): the reader names plotlines and
   * assigns the hunks it saw, by hunk ID in one go. On degraded rungs it
   * never saw every ID (uninteresting files collapse to one line, then
   * files-only/counts-only drop hunk rows), so one small-model step
   * assigns the hunks whose IDs stayed invisible. Hunks the reader saw
   * and left out stay "other" by choice; past `PLOTLINE_ASSIGN_CAP`
   * invisible hunks the rest also stay "other" — classifying thousands
   * of hunks would cost a second hunk pass, exactly what the fan-out
   * limit refuses to pay. At most one attempt per review version (a
   * finished job is never re-enqueued; an errored one retries through
   * resume).
   */
  private async maybeEnqueuePlotlineAssign(reviewId: string): Promise<Job[]> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return [];
    const plotlines = snapshot.plotlines ?? [];
    if (plotlines.length === 0) return [];
    const attempted = this.opts.jobs
      .listByReview(reviewId)
      .some(
        (j) =>
          j.kind === "plotline-assign" &&
          (j.state === "queued" || j.state === "running" || j.state === "backing-off" || j.state === "done"),
      );
    if (attempted) return [];
    const assigned = new Set(
      snapshot.hunkStates.filter((s) => s.plotline !== undefined).map((s) => s.contentHash),
    );
    const settings = await this.effectiveSettings();
    // The ladder is deterministic: rebuild it to learn exactly which hunk
    // IDs the reader saw (inlined + summarized). Anything assigned or
    // visible stays out of the follow-up.
    const promptSnap = toPromptSnapshot(snapshot, { model: settings.main.model });
    const ladder = buildLadder(promptSnap, { inlineBudgetTokens: settings.inlineBudgetTokens });
    const seen = new Set([...ladder.inlinedHunkIds, ...ladder.summarizedHunkIds]);
    const unassigned = snapshot.files.flatMap((f) =>
      f.hunks
        .filter((h) => !assigned.has(h.contentHash) && !seen.has(`h:${f.fileKey}:${h.contentHash}`))
        .map((h) => ({ file: f, hunk: h })),
    );
    if (unassigned.length === 0) return [];
    if (unassigned.length > PLOTLINE_ASSIGN_CAP) {
      console.warn(
        `[reader] ${reviewId}: ${unassigned.length} hunks left out of plotlines past the assign cap (${PLOTLINE_ASSIGN_CAP}); leaving them in "other"`,
      );
      return [];
    }
    const plotlineList = plotlines
      .map(
        (p) =>
          `- ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ""}${p.buildsOn ? ` (builds on ${p.buildsOn})` : ""}`,
      )
      .join("\n");
    const hunkList = unassigned
      .map(({ file, hunk }) => {
        const summary = snapshot.hunkStates.find((s) => s.contentHash === hunk.contentHash)?.summary;
        return `- h:${file.fileKey}:${hunk.contentHash} ${file.path}: ${summary ?? hunk.header}`;
      })
      .join("\n");
    // Issue #193: commit evidence for closest-fit (subject + its hunks).
    const commitList =
      (snapshot.commits ?? []).length > 0
        ? (snapshot.commits ?? [])
            .map(
              (c) =>
                `- \`${c.sha.slice(0, 7)}\` ${c.subject.replace(/\s+/g, " ").trim()}${c.hunks.length > 0 ? ` — hunks: ${c.hunks.join(", ")}` : ""}`,
            )
            .join("\n")
        : "(no commit list)";
    const prompt = this.render("plotline_assign", { plotlines: plotlineList, hunks: hunkList, commits: commitList });
    const job = this.opts.jobs.enqueue({
      reviewId,
      kind: "plotline-assign",
      provider: settings.small.provider,
      model: settings.small.model,
      effort: settings.small.effort,
      accessMode: postureFor(settings, "plotline-assign"),
      priority: JOB_PRIORITY.background,
      dedupe: { anchor: "plotlines", requestKind: "plotline-assign", baseVersion: `v${snapshot.version.n}` },
      run: async (ctx) => {
        ctx.setPromptSnapshot(prompt);
        const session = await this.opts.runner.start({
          provider: settings.small.provider,
          model: settings.small.model,
          effort: settings.small.effort,
          cwd: this.worktreeOf(reviewId),
          systemPrompt: "",
          readOnly: postureFor(settings, "plotline-assign") !== "full",
          mcpServers: [],
        });
        ctx.setSessionId(session.id);
        try {
          const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner, session, prompt, ctx.signal, (d) =>
            ctx.reportText(d), undefined, turnHooks(ctx));
          ctx.reportUsage(usage);
          await this.recordUsage(reviewId, usage);
          // Malformed trailing JSON fails the job (visible on Debug);
          // a missing block or zero usable assignments keeps "other".
          const { data } = this.parseAndValidate(reviewId, text);
          const raw = (data as Record<string, unknown> | null)?.["assignments"];
          const live = this.opts.reviews.getSnapshot(reviewId);
          if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !live) return;
          const ids = new Set(plotlines.map((p) => p.id));
          const known = new Set<string>();
          for (const f of live.files) for (const h of f.hunks) known.add(`h:${f.fileKey}:${h.contentHash}`);
          const taken = new Set(
            live.hunkStates.filter((s) => s.plotline !== undefined).map((s) => s.contentHash),
          );
          let applied = 0;
          let dropped = 0;
          await this.opts.reviews.mutate(reviewId, (draft) => {
            for (const [hid, pid] of Object.entries(raw as Record<string, unknown>)) {
              const parsed = parseId(hid);
              if (parsed?.kind !== "h") {
                dropped += 1;
                continue;
              }
              const canonical = `h:${parsed.fileKey}:${parsed.contentHash}`;
              if (!known.has(canonical) || typeof pid !== "string" || !ids.has(pid)) {
                dropped += 1;
                continue;
              }
              if (taken.has(parsed.contentHash)) {
                dropped += 1;
                continue;
              }
              taken.add(parsed.contentHash);
              let state = draft.hunkStates.find((s) => s.contentHash === parsed.contentHash);
              if (!state) {
                state = { contentHash: parsed.contentHash, folded: false, reviewed: false };
                draft.hunkStates.push(state);
              }
              state.plotline = pid;
              applied += 1;
            }
          });
          if (dropped > 0) {
            console.warn(`[reader] ${reviewId}: plotline assign step applied ${applied}, dropped ${dropped}`);
          }
        } finally {
          try {
            await this.opts.runner.close(session);
          } catch {
            // ignore
          }
        }
      },
    });
    return [job];
  }

  private async enqueueAutoGoDeeper(reviewId: string): Promise<Job[]> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return [];
    const effective = await this.effectiveSettings();
    if (!effective.autoGoDeeper) return [];
    const root = snapshot.pages.find((p) => p.id === "root");
    const pending = root?.cards.filter((c) => c.pending) ?? [];
    return pending.map((card) =>
      this.opts.jobs.enqueue({
        reviewId,
        kind: "go-deeper",
        ...roleFields(effective.main),
        priority: JOB_PRIORITY.background,
        dedupe: { anchor: `go-deeper:${card.id}`, requestKind: "go-deeper", baseVersion: `v${snapshot.version.n}` },
        cardId: card.id,
        run: async (ctx) => {
          await this.fillGoDeeper(reviewId, card.id, ctx.signal, (d) => ctx.reportText(d), ctx, { collapseWhenFilled: true });
        },
      }),
    );
  }

  async fillGoDeeper(
    reviewId: string,
    cardId: string,
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    ctx?: {
      setPromptSnapshot: (s: string) => void;
      setSessionId: (s: string) => void;
      reportUsage: (u: TokenUsage) => void;
      reportTool?: ToolCallback;
      setTurnPrompt?: (text: string) => void;
      reportTurnUsage?: (usage: TokenUsage, raw?: unknown) => void;
    },
    opts?: { collapseWhenFilled?: boolean },
  ): Promise<void> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) throw new Error(`unknown review ${reviewId}`);
    const root = snapshot.pages.find((p) => p.id === "root");
    const card = root?.cards.find((c) => c.id === cardId);
    if (!card?.pending) throw new Error(`no pending card ${cardId}`);
    const direction = `${card.pending.label}\n${card.pending.why}`;
    const prompt = withReplayMark(
      this.render("go_deeper", { direction }),
      isReplayRunner(this.opts.runner) ? { kind: "go-deeper", key: cardId.replace(/^g-/, "") } : undefined,
    );
    ctx?.setPromptSnapshot(prompt);
    const base = await this.ensureBase(reviewId);
    void base;
    const forked = await this.forkFor(reviewId);
    ctx?.setSessionId(forked.session.id);
    const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner, forked.session, prompt, signal, onText, (name, detail, extra) =>
      ctx?.reportTool?.(name, detail, extra),
    turnHooks(ctx));
    ctx?.reportUsage(usage);
    await this.recordUsage(reviewId, usage);
    // Issue #50: match the placeholder label (the card's future title).
    const { cards, data, validation } = this.parseAndValidate(reviewId, text, [card.pending.label]);
    const blocks = this.withValidation(
      reviewId,
      cards.flatMap((c) => c.blocks),
      validation,
    );
    // Inline diagrams go through finalize + one repair turn on the fill's
    // own session (#130), so stored blocks carry a real status.
    const stored = await this.finalizeInlineBlocks(
      reviewId,
      forked.session,
      signal,
      direction,
      "standard",
      blocks,
      (u) => ctx?.reportUsage(u),
      reportToolFrom(ctx),
      turnHooks(ctx),
    );
    const title = (data?.["title"] as string | undefined) ?? card.pending.label;
    await this.opts.reviews.mutate(reviewId, (draft) => {
      const r = draft.pages.find((p) => p.id === "root");
      const c = r?.cards.find((x) => x.id === cardId);
      if (!c) return;
      c.title = title;
      c.blocks = stored;
      // #217: a card written automatically (not by a Generate click)
      // stays collapsed — title and why-line, as the placeholder
      // looked — until the reader opens it; opening is the ordinary
      // expand, so the written content shows with no new job.
      if (opts?.collapseWhenFilled) {
        c.collapsed = true;
        if (c.pending?.why) c.why = c.pending.why;
      }
      delete c.pending;
      c.revision += 1;
      const seq = draft.logTail.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      draft.logTail.push({
        seq,
        kind: "new-card",
        payload: { summary: `go-deeper ${cardId}`, unverified: validation.unverified },
        scope: { scope: "global" },
      });
      // On-demand stage bookkeeping: once the last placeholder is filled,
      // the go-deeper stage is done (readiness ignores a pending go-deeper,
      // but the stored stage should still settle).
      if (r && !r.cards.some((x) => x.pending)) {
        if (!draft.pipeline) {
          draft.pipeline = {
            stages: { reader: "pending", base: "pending", critic: "pending", "hunk-pass": "pending", "go-deeper": "pending" },
          };
        }
        (draft.pipeline.stages as Record<string, string>)["go-deeper"] = "done";
      }
    });
    await this.updateRestatedMapping(reviewId);
    // #122: the fill is applied above; bookkeeping joins the chain.
    await this.finishBookkeeping(reviewId, () => this.ingestTurn(reviewId, { sessionId: forked.session.id, cardId, data }));
    // #122: the fill changed the guide — rebuild the base ahead.
    this.warmBase(reviewId);
  }

  // -- helpers --------------------------------------------------------

  /**
   * Issue #198: the hunk's plotline name and purpose for the hunk-pass
   * prompt, when the reader has assigned one; a plain "none yet" line
   * otherwise (the ingest-time pass runs before the reader).
   */
  private plotlineForHunk(snapshot: ReviewSnapshot, contentHash: string): string {
    const id = snapshot.hunkStates.find((s) => s.contentHash === contentHash)?.plotline;
    const plotline = id ? (snapshot.plotlines ?? []).find((p) => p.id === id) : undefined;
    if (!plotline) return "(none assigned yet)";
    return plotline.description ? `${plotline.name} — ${plotline.description}` : plotline.name;
  }

  private formatHunkForPrompt(snapshot: ReviewSnapshot, fileKey: string, contentHash: string): string {
    const file = snapshot.files.find((f) => f.fileKey === fileKey);
    const hunk = file?.hunks.find((h) => h.contentHash === contentHash);
    if (!file || !hunk) return `(unknown hunk ${contentHash})`;
    const lines = hunk.lines
      .map((l) => (l.kind === "add" ? `+${l.text}` : l.kind === "del" ? `-${l.text}` : ` ${l.text}`))
      .join("\n");
    return `### [[h:${fileKey}:${contentHash}]] ${file.path}\n${hunk.header}\n${lines}`;
  }

  private replayKeyForHunk(snapshot: ReviewSnapshot, fileKey: string, contentHash: string): string | null {
    const aliases = aliasesForReview(snapshot, this.opts.fixturesDir);
    const rev = Object.entries(aliases).find(([, v]) => v === fileKey)?.[0];
    const file = snapshot.files.find((f) => f.fileKey === fileKey);
    if (!file) return null;
    const index = file.hunks.findIndex((h) => h.contentHash === contentHash);
    if (index < 0) return null;
    if (rev) return `${rev}:${index}`;
    return null;
  }

  private isCitedByGuide(reviewId: string, contentHash: string): boolean {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return false;
    const targets = new Set<string>();
    for (const page of snapshot.pages) {
      // Only the main guide's citations decide hunk visibility and ladders.
      if (isCustomGuidePage(page)) continue;
      for (const card of page.cards) {
        for (const b of card.blocks) {
          for (const c of citationsOf(b)) targets.add(c);
        }
      }
    }
    for (const t of targets) {
      const parsed = parseId(t);
      if (!parsed) continue;
      if (parsed.kind === "h" && parsed.contentHash === contentHash) return true;
      if (parsed.kind === "diff") {
        const aliases = aliasesForReview(snapshot, this.opts.fixturesDir);
        const fk = aliases[parsed.fileKey] ?? parsed.fileKey;
        const file = snapshot.files.find((f) => f.fileKey === fk);
        if (!file) continue;
        const hunk = file.hunks.find((h) => h.contentHash === contentHash);
        if (!hunk) continue;
        if (parsed.start <= hunk.newEnd && parsed.end >= hunk.newStart) return true;
      }
    }
    return false;
  }

  private isOneLineChange(snapshot: ReviewSnapshot, contentHash: string): boolean {
    for (const f of snapshot.files) {
      const h = f.hunks.find((x) => x.contentHash === contentHash);
      if (h) return h.added + h.removed <= 1;
    }
    return false;
  }

  private mentionsOf(snapshot: ReviewSnapshot, slug: string): string {
    const hits: string[] = [];
    for (const page of snapshot.pages) {
      for (const card of page.cards) {
        if (JSON.stringify(card.blocks).includes(`concept:${slug}`)) hits.push(`card:${card.id}`);
      }
    }
    return hits.length > 0 ? hits.slice(0, 5).join("\n") : "(mentioned in the guide)";
  }

  /**
   * Persist the reader's `pin_context` pins (PRD §9.1 L1b) with their
   * excerpt text resolved at the version head — via the same `git show`
   * source the `get_code` tool serves (`readCodeSlice`, through the
   * injectable command runner). Best-effort per pin: an unresolvable pin
   * is still stored (location + `needsRepining`) so the reader's intent
   * stays visible, and L1b renders it honestly instead of an empty fence.
   * Never throws: one bad pin must not fail the reader stage.
   */
  private async persistPins(reviewId: string): Promise<void> {
    const pins = this.opts.mcp.listPins(reviewId);
    if (pins.length === 0) return;
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot) return;
    const headSha = snapshot.version.headSha;
    const cwd = this.worktreeOf(reviewId);
    // Resolve text before the snapshot mutate below (recipes are sync).
    const resolved: { path: string; start: number; end: number; text: string | null }[] = [];
    for (const pin of pins) {
      const [rawStart, rawEnd] = pin.lines.split("-").map(Number);
      const start = rawStart;
      const end = rawEnd ?? rawStart;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
      let text: string | null = null;
      try {
        McpRegistry.checkPathInRepo(cwd, pin.path);
        const slice = await readCodeSlice(this.opts.commands, cwd, headSha, pin.path, start, end);
        // A range that resolves to nothing but whitespace carries no
        // excerpt: treat it like an unresolvable pin so it renders
        // honestly instead of as an empty fence.
        if ("text" in slice && slice.text.trim() !== "") text = slice.text;
      } catch {
        text = null;
      }
      resolved.push({ path: pin.path, start, end, text });
    }
    if (resolved.length === 0) return;
    await this.opts.reviews.mutate(reviewId, (draft) => {
      const byKey = new Map((draft.pinnedCode ?? []).map((p) => [`${p.path}:${p.start}-${p.end}`, p]));
      for (const r of resolved) {
        const key = `${r.path}:${r.start}-${r.end}`;
        const prev = byKey.get(key);
        const language = languageForPath(r.path);
        if (prev) {
          // Re-pin of a range whose stored excerpt is empty (on disk from
          // before text was persisted, or never resolvable until now):
          // refill it in place. Entries that already have text are left
          // alone, as are empty entries the text still does not resolve for.
          if (prev.text === "" && r.text !== null) {
            prev.text = r.text;
            prev.sha = headSha;
            if (language !== undefined) prev.language = language;
            else delete prev.language;
            delete prev.needsRepining;
            delete prev.remappedSha;
            delete prev.remappedStart;
            delete prev.remappedEnd;
          }
          continue;
        }
        const entry = {
          path: r.path,
          start: r.start,
          end: r.end,
          sha: headSha,
          text: r.text ?? "",
          ...(language !== undefined ? { language } : {}),
          ...(r.text === null ? { needsRepining: true as const } : {}),
        };
        (draft.pinnedCode ??= []).push(entry);
        byKey.set(key, entry);
      }
    });
  }

  /**
   * Recompute the description's "Restated →" mapping (PRD §4.11): paragraph
   * id → guide block ids whose citations restate it. Derived from the root
   * page's `desc:` citations; rerun as the guide grows (reader, critic
   * findings cite description too, go-deeper fills).
   */
  private async updateRestatedMapping(reviewId: string): Promise<void> {
    try {
      await this.opts.reviews.mutate(reviewId, (draft) => {
        if (!draft.description) return;
        const map: Record<string, string[]> = {};
        const root = draft.pages.find((p) => p.id === "root");
        for (const card of root?.cards ?? []) {
          for (const b of card.blocks) {
            for (const t of citationsOf(b)) {
              const parsed = parseId(t);
              if (parsed?.kind === "desc") {
                (map[parsed.paragraph] ??= []).push(b.id);
              }
            }
          }
        }
        for (const k of Object.keys(map)) map[k] = [...new Set(map[k])];
        draft.description!.restated = map;
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Issue #151: record a failed/aborted turn's already-counted usage
   * (carried on the error by `collectStreaming`) on the job and the
   * review totals, exactly once however often the error is rethrown.
   */
  async reportPartialUsage(
    ctx: { reportUsage(usage: Partial<TokenUsage>): void },
    reviewId: string,
    err: unknown,
  ): Promise<void> {
    const usage = partialUsageOf(err);
    if (!usage) return;
    const carrier = err as PartialUsageCarrier;
    if (carrier.partialUsageReported) return;
    carrier.partialUsageReported = true;
    ctx.reportUsage(usage);
    await this.recordUsage(reviewId, usage);
  }

  private async recordUsage(reviewId: string, usage: TokenUsage): Promise<void> {
    try {
      await this.opts.reviews.mutate(reviewId, (draft) => {
        const t = draft.usageTotals ?? {
          inputTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          outputTokens: 0,
          createdAt: draft.review.createdAt,
        };
        t.inputTokens += usage.inputTokens;
        t.cachedReadTokens += usage.cachedReadTokens;
        t.cachedWriteTokens += usage.cachedWriteTokens;
        t.outputTokens += usage.outputTokens;
        // Read share (#125, M0 pitfall #2): input counts uncached input
        // only; writes never count as hits.
        const total = t.inputTokens + t.cachedReadTokens + t.cachedWriteTokens;
        t.cacheHitRate = total > 0 ? t.cachedReadTokens / total : undefined;
        draft.usageTotals = t;
      });
    } catch {
      // best-effort
    }
  }

  private markFirstCard(draft: ReviewSnapshot): void {
    if (!draft.usageTotals?.firstCardAt) {
      draft.usageTotals = {
        inputTokens: draft.usageTotals?.inputTokens ?? 0,
        cachedReadTokens: draft.usageTotals?.cachedReadTokens ?? 0,
        cachedWriteTokens: draft.usageTotals?.cachedWriteTokens ?? 0,
        outputTokens: draft.usageTotals?.outputTokens ?? 0,
        createdAt: draft.review.createdAt,
        firstCardAt: Date.now(),
      };
    }
  }

  private async appendLog(
    reviewId: string,
    kind: string,
    payload: unknown,
    scope: { scope: "global" } | { scope: "card"; cardId: string },
  ): Promise<void> {
    try {
      await this.opts.reviews.mutate(reviewId, (draft) => {
        const seq = draft.logTail.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
        draft.logTail.push({ seq, kind, payload, scope });
      });
    } catch {
      // ignore
    }
  }

  private ensurePipelineField(reviewId: string): void {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    if (!snapshot || snapshot.pipeline) return;
    void this.opts.reviews
      .mutate(reviewId, (draft) => {
        if (!draft.pipeline) {
          draft.pipeline = {
            stages: { reader: "pending", base: "pending", critic: "pending", "hunk-pass": "pending", "go-deeper": "pending" },
          };
        }
      })
      .catch(() => {});
  }

  private stageStates(reviewId: string): Record<string, string> {
    const snapshot = this.opts.reviews.getSnapshot(reviewId);
    const stages = (snapshot?.pipeline?.stages ?? {}) as Record<string, string>;
    return {
      reader: stages.reader ?? "pending",
      base: stages.base ?? "pending",
      critic: stages.critic ?? "pending",
      "hunk-pass": stages["hunk-pass"] ?? "pending",
      "go-deeper": stages["go-deeper"] ?? "pending",
    };
  }

  private setStage(reviewId: string, stage: string, state: "pending" | "running" | "done" | "error", error?: string): void {
    void this.opts.reviews
      .mutate(reviewId, (draft) => {
        if (!draft.pipeline) {
          draft.pipeline = {
            stages: { reader: "pending", base: "pending", critic: "pending", "hunk-pass": "pending", "go-deeper": "pending" },
          };
        }
        (draft.pipeline.stages as Record<string, string>)[stage] = state;
        if (state === "error" && error) {
          draft.pipeline.errors = { ...(draft.pipeline.errors ?? {}), [stage]: error };
        }
      })
      .catch(() => {});
  }

  private maybeMarkStageDone(reviewId: string, stage: "critic" | "hunk-pass", expectedJobs: number): void {
    try {
      const jobs = this.opts.jobs.listByReview(reviewId);
      const kinds: Record<string, JobKind[]> = { critic: ["critic"], "hunk-pass": ["hunk-pass"] };
      const relevant = jobs.filter((j) => (kinds[stage] as string[]).includes(j.kind));
      // Called on the success path inside a relevant job's run(), before the
      // queue flips it to done — so the caller is still "running". Count it
      // as completing (+1); without this the last job always sees
      // done = expected-1 and the stage stays "running" forever. Never
      // overwrite an error set by a failed sibling.
      const done = relevant.filter((j) => j.state === "done").length;
      const errored = relevant.some((j) => j.state === "error");
      if (!errored && done + 1 >= expectedJobs) this.setStage(reviewId, stage, "done");
    } catch {
      // ignore
    }
  }

  updateRunner(): {
    runUpdatePrompt: (
      prompt: string,
      opts: {
        reviewId: string;
        toVersion: number;
        signal?: AbortSignal;
        hooks?: {
          setSessionId(id: string): void;
          reportText(delta: string): void;
          reportTool: ToolCallback;
          reportUsage(usage: TokenUsage): void;
          setTurnPrompt?: (text: string) => void;
          reportTurnUsage?: (usage: TokenUsage, raw?: unknown) => void;
        };
      },
    ) => Promise<string>;
  } {
    return {
      // The versions module renders `update_pass.md` already and encloses
      // this call in the single `update-pass` job. Run directly in that
      // job — enqueuing a second update-pass job here deadlocked on the
      // enclosing job's dedupe key (issue #194: RUNNING forever, no
      // token counts). Retryable errors retry the turn in place.
      runUpdatePrompt: async (prompt, opts) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const base = await this.ensureBase(opts.reviewId);
            void base;
            const forked = await this.forkFor(opts.reviewId);
            opts.hooks?.setSessionId(forked.session.id);
            const { text, usage } = await collectTracked(this.opts.sessions, this.opts.runner,
              forked.session,
              prompt,
              opts.signal,
              (d) => opts.hooks?.reportText(d),
              (name, detail, extra) => opts.hooks?.reportTool(name, detail, extra),
            turnHooks(opts.hooks));
            opts.hooks?.reportUsage(usage);
            await this.recordUsage(opts.reviewId, usage);
            return text;
          } catch (err) {
            if (err instanceof RetryableError && attempt < 3) {
              await sleepMs(50 * (attempt + 1));
              continue;
            }
            throw err;
          }
        }
      },
    };
  }
}
