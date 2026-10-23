/**
 * In-flight action helpers (issue #46): one client-side mechanism for the
 * immediate feedback every agent-starting control shows on click.
 *
 * The zustand store (`state/store.ts`) holds the entries; this module maps
 * actions to entry keys, entries/jobs to plain fixed labels (never
 * streamed agent text or progress strings), and decides rewrite (left
 * border, text stays) versus new-content (placeholder) presentation.
 *
 * Agent-starting kinds (verified against
 * `packages/service/src/pipeline/actions/`): explain, ask, reply, retry,
 * depth, examples, diagram, generate, followup, concept, second_opinion,
 * plus the update pass (`POST …/update`). Local-only kinds — collapse,
 * note, promote, close, delete, undo — need nothing.
 */
import type { ActionAnchor, Annotation, Job, JobKind, ReviewSnapshot } from "@unvibe/shared";
import { isLiveJobState, type InFlightAction, type InFlightKind } from "../state/store.js";

/** Fixed plain label per action (no streamed text, no progress strings). */
export function inflightLabel(kind: InFlightKind): string {
  switch (kind) {
    case "depth":
      return "Rewriting…";
    case "examples":
      return "Adding examples…";
    case "diagram":
      return "Drawing diagram…";
    case "generate":
      return "Writing…";
    case "explain":
      return "Writing explanation…";
    case "ask":
      return "Asking…";
    case "reply":
      return "Writing reply…";
    case "retry":
      return "Retrying…";
    case "followup":
      return "Writing answer…";
    case "second_opinion":
      return "Getting a second opinion…";
    case "concept":
      return "Writing the concept page…";
    case "update":
      return "Updating…";
  }
}

/** Fallback label when only the snapshot job is known (no in-flight entry). */
export function jobLabel(kind: JobKind): string {
  switch (kind) {
    case "depth":
      return inflightLabel("depth");
    case "examples":
      return inflightLabel("examples");
    case "diagram":
      return inflightLabel("diagram");
    case "go-deeper":
      return inflightLabel("generate");
    case "ask":
      return inflightLabel("ask");
    case "concept":
      return inflightLabel("concept");
    case "second-opinion":
      return inflightLabel("second_opinion");
    case "update-pass":
      return inflightLabel("update");
    case "custom-guide":
      return "Writing the guide…";
    default:
      return "Working…";
  }
}

/**
 * Rewrite of existing content (the card/expansion stays visible under a
 * left border) versus new content (a placeholder appears where it lands):
 * depth changes and examples/diagram inserts rewrite; everything else is
 * new content.
 */
export function isRewriteKind(kind: InFlightKind | JobKind): boolean {
  return kind === "depth" || kind === "examples" || kind === "diagram";
}

/** Live (queued/running/backing-off) job working on a card or answer. */
export function liveJobForTarget(
  jobs: Job[],
  targetId: string,
): Job | undefined {
  return jobs.find(
    (j) =>
      (j.cardId === targetId || j.annotationId === targetId) && isLiveJobState(j.state),
  );
}

export interface BusyState {
  kind: InFlightKind | JobKind;
  label: string;
  rewriting: boolean;
}

/** Busy state for a card/expansion: in-flight entry first, live job next. */
export function busyForCard(
  inflight: Record<string, InFlightAction>,
  jobs: Job[],
  cardId: string,
): BusyState | null {
  const entry = inflight[cardId];
  if (entry) {
    return { kind: entry.kind, label: inflightLabel(entry.kind), rewriting: isRewriteKind(entry.kind) };
  }
  const job = liveJobForTarget(jobs, cardId);
  if (job) {
    return { kind: job.kind, label: jobLabel(job.kind), rewriting: isRewriteKind(job.kind) };
  }
  return null;
}

/**
 * Busy state for a conversation card: the direct entry first, then a
 * follow-up chip entry addressing its anchor block (the answer renders
 * before the response retargets), then an anchor-keyed explain entry for
 * a card that landed before its response (issue #97), then the live job.
 */
export function busyForConversation(
  inflight: Record<string, InFlightAction>,
  jobs: Job[],
  snapshot: ReviewSnapshot | null | undefined,
  expansion: Annotation,
): BusyState | null {
  const direct = busyForCard(inflight, jobs, expansion.id);
  if (direct) {
    // A job-derived ask fill on a follow-up answer is its answer, not a
    // question; an entry already carries the exact label.
    if (!inflight[expansion.id] && direct.kind === "ask" && isFollowupAnswer(snapshot, expansion)) {
      return { kind: "followup", label: inflightLabel("followup"), rewriting: false };
    }
    return direct;
  }
  if (expansion.type === "conversation") {
    if (expansion.anchor.host.kind === "block") {
      const chip = followupEntryForAnchorBlock(inflight, expansion.anchor.host.blockId);
      if (chip) return { kind: chip.kind, label: inflightLabel(chip.kind), rewriting: false };
    }
    // The service creates the card at once: its patch lands before
    // the action response retargets the anchor-keyed entry. Carry the
    // Explain label meanwhile, so the card shows one indicator (never the
    // generic fallback) and its content controls stay off.
    const anchorEntry = anchorEntryForConversation(inflight, expansion);
    if (anchorEntry) {
      return { kind: anchorEntry.kind, label: inflightLabel(anchorEntry.kind), rewriting: false };
    }
  }
  return null;
}

/**
 * Anchor-keyed explain entry standing in for a conversation card that
 * arrived before its action response retargeted the entry (issue #97).
 * Only `explain` creates bare cards; follow-up answers match through
 * their chip key above, and every other kind addresses its target id
 * directly. A block entry names the host exactly or by its bare id.
 */
export function anchorEntryForConversation(
  inflight: Record<string, InFlightAction>,
  expansion: Annotation,
): InFlightAction | undefined {
  if (expansion.type !== "conversation") return undefined;
  const host = expansion.anchor.host;
  for (const [key, entry] of Object.entries(inflight)) {
    if (entry.kind !== "explain") continue;
    if (host.kind === "block") {
      if (!key.startsWith("explain:block:")) continue;
      if (blockIdsMatch(key.slice("explain:block:".length), host.blockId)) return entry;
    } else if (host.kind === "description") {
      if (key === `explain:desc:${host.paragraphId}`) return entry;
    } else if (host.kind === "comment") {
      if (key === `explain:comment:${host.commentId}`) return entry;
    } else if (host.kind === "diff-line") {
      const anchor = diffAnchorForExplainKey(key);
      if (anchor && anchor.fileKey === host.fileKey && anchor.line === host.line) return entry;
    }
  }
  return undefined;
}

function bareBlockId(id: string): string {
  const hash = id.indexOf("#");
  return hash >= 0 ? id.slice(hash + 1) : id;
}

/**
 * An anchor-keyed entry addresses an expansion host when it names the host
 * exactly or the host's bare block id (a selection carries the bare id
 * while the service qualifies it `card#block`). A differently-qualified
 * entry never matches, so explains on same-named blocks of other cards
 * stay independent.
 */
export function blockIdsMatch(entryBid: string, hostBlockId: string): boolean {
  return entryBid === hostBlockId || entryBid === bareBlockId(hostBlockId);
}

// --- entry keys -----------------------------------------------------------

/** Stale-card Update / banner Update for a review. */
export function updateKey(reviewId: string): string {
  return `update:${reviewId}`;
}

function anchorSuffix(anchor: ActionAnchor): string {
  if (anchor.where === "block") return `block:${anchor.blockId}`;
  if (anchor.where === "description") return `desc:${anchor.paragraphId}`;
  if (anchor.where === "comment") return `comment:${anchor.commentId}`;
  if (anchor.where === "hunk") return `hunk:${anchor.fileKey}:${anchor.contentHash}`;
  if (anchor.where === "code") return `code:${anchor.path}:${anchor.line}@${anchor.commit}`;
  return `diff:${anchor.fileKey}:${anchor.line}`;
}

/** Explain from a selection: keyed by anchor until the response retargets. */
export function explainKey(anchor: ActionAnchor): string {
  return `explain:${anchorSuffix(anchor)}`;
}

/** Ask from a new-thread composer: keyed by anchor until retargeted. */
export function askKey(anchor: ActionAnchor): string {
  return `ask:${anchorSuffix(anchor)}`;
}

/** Follow-up chip: card + block + item index (prevents double clicks). */
export function followupKey(cardId: string, blockId: string, index: number): string {
  return `followup:${cardId}:${blockId}:${index}`;
}

/**
 * In-flight follow-up entry addressing an anchor block. The answer
 * expansion renders from the annotation patch before the action response
 * moves the entry off the chip key, so the expansion matches its busy
 * state through the anchor — never the generic server text.
 * Block ids contain no colons, so the key splits exactly.
 */
export function followupEntryForAnchorBlock(
  inflight: Record<string, InFlightAction>,
  anchorBlockId: string,
): InFlightAction | undefined {
  const bare = anchorBlockId.includes("#") ? anchorBlockId.split("#").pop()! : anchorBlockId;
  for (const [key, entry] of Object.entries(inflight)) {
    if (entry.kind !== "followup") continue;
    const parts = key.split(":");
    if (parts.length !== 4 || parts[0] !== "followup") continue;
    const [, cardId, blockId] = parts;
    if (blockId === anchorBlockId || blockId === bare || anchorBlockId === `${cardId}#${blockId}`) {
      return entry;
    }
  }
  return undefined;
}

/** Block type of an anchor target, following `card#block` qualification. */
export function anchorBlockType(
  snapshot: ReviewSnapshot | null | undefined,
  anchorBlockId: string,
): string | undefined {
  // A qualified anchor addresses one owner's block (#116); only a legacy
  // bare ID searches every owner.
  const hash = anchorBlockId.indexOf("#");
  const owner = hash >= 0 ? anchorBlockId.slice(0, hash) : null;
  const bare = hash >= 0 ? anchorBlockId.slice(hash + 1) : anchorBlockId;
  const match = (id: string): boolean => id === anchorBlockId || id === bare;
  for (const p of snapshot?.pages ?? []) {
    for (const c of p.cards) {
      if (owner !== null && c.id !== owner) continue;
      for (const b of c.blocks) {
        if (match(b.id)) return b.type;
      }
    }
  }
  for (const a of snapshot?.annotations ?? []) {
    if (a.type !== "conversation") continue;
    for (const t of a.turns ?? []) {
      if (owner !== null && a.id !== owner && t.id !== owner) continue;
      for (const b of t.blocks as { id: string; type: string }[]) {
        if (match(b.id)) return b.type;
      }
    }
  }
  return undefined;
}

/** True when a conversation card is a follow-up answer (anchored on a follow-up block). */
export function isFollowupAnswer(
  snapshot: ReviewSnapshot | null | undefined,
  expansion: Annotation,
): boolean {
  const host = expansion.anchor.host;
  if (expansion.type !== "conversation" || host.kind !== "block") return false;
  return anchorBlockType(snapshot, host.blockId) === "follow-up";
}

/** Concept page written on first open. */
export function conceptKey(slug: string): string {
  return `concept:${slug}`;
}

/** In-flight entry addressing an anchor (explain/ask placeholders). */
export function inflightForAnchor(
  inflight: Record<string, InFlightAction>,
  anchor: ActionAnchor,
): InFlightAction | undefined {
  return inflight[explainKey(anchor)] ?? inflight[askKey(anchor)];
}

/**
 * Diff anchor behind an explain entry key (`explain:diff:<fileKey>:<line>`),
 * or null for any other key. The line is the numeric suffix, so file keys
 * containing colons still parse.
 */
export function diffAnchorForExplainKey(key: string): { fileKey: string; line: number } | null {
  if (!key.startsWith("explain:diff:")) return null;
  const rest = key.slice("explain:diff:".length);
  const sep = rest.lastIndexOf(":");
  if (sep < 0) return null;
  const line = Number(rest.slice(sep + 1));
  if (!Number.isSafeInteger(line)) return null;
  return { fileKey: rest.slice(0, sep), line };
}

/**
 * In-flight explain/ask entry for a guide block. Selection anchors use the
 * bare block id while the service may qualify it (`card#block`), so both
 * spellings are checked.
 */
export function inflightForBlock(
  inflight: Record<string, InFlightAction>,
  cardId: string,
  blockId: string,
): InFlightAction | undefined {
  for (const b of [`${cardId}#${blockId}`, blockId]) {
    const anchor: ActionAnchor = { where: "block", blockId: b };
    const found = inflightForAnchor(inflight, anchor);
    if (found) return found;
  }
  return undefined;
}
