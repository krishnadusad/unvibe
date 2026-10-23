/**
 * Global review state: one zustand store holding the review snapshot,
 * updated by snapshot fetch + WS state patches (RFC 6902 ops, see
 * `packages/shared/src/api.ts` for the contract).
 *
 * Ordering (the live-pipeline race fix): the service serialises mutations
 * per review, so patches form a strict chain
 * `rev N --(baseRev N)--> N+1 --(baseRev N+1)--> N+2 …`. The client applies
 * a patch only against its exact `baseRev`:
 * - `baseRev === rev` → apply, then drain any queued patches that now chain;
 * - `baseRev < rev` → stale/duplicate (already in the snapshot): drop;
 * - `baseRev > rev` → a patch was missed (stale fetch clobbered newer
 *   state, patches arrived before the first snapshot, or the socket
 *   dropped): queue the patch and raise `resyncSeq` so the route refetches
 *   the snapshot. The refetch converges on confirmed server state and the
 *   queue drains (queued patches already covered by the fresh snapshot are
 *   dropped by `headRev`).
 *
 * Snapshots are rev-gated too: a fetch that started earlier must never
 * clobber newer WS state (`incoming.rev < rev` is ignored; equal revs are
 * accepted so live job lists stay fresh).
 */
import { useMemo } from "react";
import { create } from "zustand";
import type { Annotation, Job, ReviewEvent, ReviewSnapshot, StatePatchOp } from "@unvibe/shared";
import { annotationVisibleIn } from "@unvibe/shared";

type PatchEvent = Extract<ReviewEvent, { type: "patch" }>;

/**
 * One agent action started from a click, shown immediately (issue #46).
 * Set synchronously in the click handler — before the request is sent —
 * and handed over to the real snapshot job once it appears, so the UI
 * reacts on click instead of waiting for the first WS event.
 */
export type InFlightKind =
  | "depth"
  | "examples"
  | "diagram"
  | "generate"
  | "followup"
  | "explain"
  | "ask"
  | "reply"
  | "retry"
  | "second_opinion"
  | "concept"
  | "update";

export interface InFlightAction {
  kind: InFlightKind;
  /** Card id, annotation/thread id, anchor key, or `update:<reviewId>`. */
  targetId: string;
  /** Attached once the action response arrives (the job to follow). */
  jobId?: string;
  /** Card/expansion revision at click time (insert kinds). */
  revision?: number;
  startedAt: number;
  /**
   * Monotonic generation: a stale response (an earlier click whose answer
   * arrives after a newer click re-began the same key) must never clear
   * or reattach the newer entry.
   */
  seq: number;
}

let inflightSeq = 0;

/**
 * Safety cap so an in-flight entry can never spin forever (a lost job
 * event, a mock answer with no snapshot job). The cap only applies while
 * no live job is attached: an entry following a queued/running/
 * backing-off job stays until that job is terminal, however long the
 * queue takes.
 */
export const INFLIGHT_TTL_MS = 120_000;

export function isLiveJobState(state: Job["state"]): boolean {
  return state === "queued" || state === "running" || state === "backing-off";
}

export function isTerminalJobState(state: Job["state"]): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

/**
 * Whether an entry lapses: older than the TTL *and* with no live job
 * (no `jobId` yet, or a `jobId` the snapshot does not know). A live
 * attached job holds the entry past the TTL; its terminal state reaps it.
 */
export function inflightExpired(
  entry: InFlightAction,
  jobs: Job[],
  now: number,
): boolean {
  if (now - entry.startedAt <= INFLIGHT_TTL_MS) return false;
  if (!entry.jobId) return true;
  const job = jobs.find((j) => j.id === entry.jobId);
  if (!job) return true;
  return !isLiveJobState(job.state);
}

/** Drop in-flight entries whose job settled or whose wait lapsed. */
function reapInflight(
  jobs: Job[],
  inflight: Record<string, InFlightAction>,
  now: number,
): Record<string, InFlightAction> {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  let changed = false;
  const next: Record<string, InFlightAction> = {};
  for (const [key, entry] of Object.entries(inflight)) {
    const job = entry.jobId ? byId.get(entry.jobId) : undefined;
    if ((job && isTerminalJobState(job.state)) || inflightExpired(entry, jobs, now)) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return changed ? next : inflight;
}

/** Cap on queued out-of-order patches (a gap refetch converges instead). */
const MAX_PENDING = 200;

interface ReviewState {
  snapshot: ReviewSnapshot | null;
  connected: boolean;
  /**
   * Agent actions started from a click and not yet settled (issue #46).
   * Keyed by target (card/annotation/thread id, anchor key, or
   * `update:<reviewId>`). Survives snapshot resyncs; entries clear when
   * their job settles, the request fails, or the TTL lapses.
   */
  inflight: Record<string, InFlightAction>;
  /** Out-of-order patches waiting for their `baseRev`. */
  pending: PatchEvent[];
  /**
   * Issue #126 (experiment): accumulated streamed answer text per
   * conversation card, keyed by annotation id. Fed by WS `text` events
   * (dropped on the floor before #126); the unified card renders
   * completed paragraphs from it while the turn fills. Cleared when the
   * turn's blocks land, the turn errors, or its job settles — the stored
   * turn is always the truth afterwards.
   */
  streams: Record<string, { jobId: string; text: string }>;
  /**
   * Incremented whenever a patch gap needs a server resync. `ReviewRoute`
   * refetches the snapshot on change; the fresh snapshot drains `pending`.
   */
  resyncSeq: number;
  /**
   * Custom guide open in the guide pane (`/review/:id/guide/:guideId`),
   * null on the main guide. Set from the route; decides which suggested
   * comments show (`useVisibleAnnotations`).
   */
  activeGuideId: string | null;
  setActiveGuide: (guideId: string | null) => void;
  setSnapshot: (snapshot: ReviewSnapshot) => void;
  setConnected: (connected: boolean) => void;
  applyEvent: (event: ReviewEvent) => void;
  updateJob: (job: Job) => void;
  /** Set synchronously in the click handler, before the request is sent. */
  beginInflight: (targetId: string, kind: InFlightKind, opts?: { revision?: number }) => void;
  /** Attach the response's job id so the entry follows the real job. */
  attachInflightJob: (targetId: string, jobId: string) => void;
  /** Move an entry to its server id (anchor key → annotation/thread id). */
  retargetInflight: (fromId: string, toId: string) => void;
  clearInflight: (targetId: string) => void;
  /**
   * Issue #126 (experiment): append a streamed text delta to a card's
   * buffer. A new job id resets the buffer (repair/retry start clean).
   */
  appendStream: (annotationId: string, jobId: string, delta: string) => void;
  /** Issue #126 (experiment): drop a card's streamed buffer. */
  clearStream: (annotationId: string) => void;
  clear: () => void;
}

function unescapePointer(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Apply one RFC 6902 op (add/remove/replace) at a JSON Pointer path.
 * Throws on out-of-bounds array indices or missing intermediate objects so
 * a corrupt patch triggers a resync instead of silently corrupting state.
 */
export function applyOp(root: unknown, op: StatePatchOp): unknown {
  const segs = op.path.split("/").slice(1).map(unescapePointer);
  if (segs.length === 0) {
    if (op.op === "remove") return undefined;
    return (op as { value: unknown }).value;
  }
  // Clone-on-write along the path.
  const clone = (v: unknown): unknown =>
    Array.isArray(v) ? [...v] : v && typeof v === "object" ? { ...(v as object) } : v;
  const newRoot = clone(root);
  let node: Record<string, unknown> & unknown[] = newRoot as never;
  for (let i = 0; i < segs.length - 1; i++) {
    if (node === null || typeof node !== "object") {
      throw new Error(`patch parent missing at ${op.path}`);
    }
    const key = segs[i];
    const next = (node as Record<string, unknown>)[key];
    const copy = clone(next);
    (node as Record<string, unknown>)[key] = copy;
    node = copy as never;
  }
  if (node === null || typeof node !== "object") {
    throw new Error(`patch parent missing at ${op.path}`);
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(node)) {
    const idx = last === "-" ? node.length : Number(last);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`patch array index out of bounds at ${op.path}`);
    }
    if (op.op === "remove") {
      if (idx >= node.length) throw new Error(`patch array index out of bounds at ${op.path}`);
      node.splice(idx, 1);
    } else if (op.op === "add") {
      if (idx > node.length) throw new Error(`patch array index out of bounds at ${op.path}`);
      node.splice(idx, 0, (op as { value: unknown }).value);
    } else {
      if (idx >= node.length) throw new Error(`patch array index out of bounds at ${op.path}`);
      node[idx] = (op as { value: unknown }).value;
    }
  } else {
    const obj = node as Record<string, unknown>;
    if (op.op === "remove") delete obj[last];
    else obj[last] = (op as { value: unknown }).value;
  }
  return newRoot;
}

function applyPatchOps(snapshot: ReviewSnapshot, event: PatchEvent): ReviewSnapshot {
  let root: unknown = snapshot;
  for (const op of event.ops) root = applyOp(root, op);
  return { ...(root as ReviewSnapshot), rev: event.headRev };
}

/**
 * Drain queued patches against `snapshot`: drop patches the snapshot
 * already covers (`headRev <= rev`), apply the longest chain starting at
 * `rev`, keep the rest. Returns the snapshot, the leftover queue, and
 * whether a gap remains (caller raises `resyncSeq`).
 */
function drainPending(
  snapshot: ReviewSnapshot,
  pending: PatchEvent[],
): { snapshot: ReviewSnapshot; pending: PatchEvent[]; gap: boolean } {
  const covered = pending.filter((p) => p.headRev > snapshot.rev);
  const rest = [...covered].sort((a, b) => a.baseRev - b.baseRev || a.headRev - b.headRev);
  let cur = snapshot;
  let progressed = true;
  while (progressed) {
    progressed = false;
    const idx = rest.findIndex((p) => p.baseRev === cur.rev);
    if (idx < 0) break;
    const [next] = rest.splice(idx, 1);
    try {
      cur = applyPatchOps(cur, next);
    } catch {
      // Corrupt patch: drop it and let the resync converge.
      break;
    }
    progressed = true;
  }
  const gap = rest.length > 0 && !rest.some((p) => p.baseRev === cur.rev);
  return { snapshot: cur, pending: rest, gap };
}

function queuePatch(pending: PatchEvent[], event: PatchEvent): PatchEvent[] {
  if (pending.some((p) => p.baseRev === event.baseRev && p.headRev === event.headRev)) {
    return pending;
  }
  const next = [...pending, event];
  return next.length > MAX_PENDING ? next.slice(next.length - MAX_PENDING) : next;
}

/**
 * True when `next` is an older fetch of the review already in the store.
 * `rev` counts per review, so a snapshot of another review is never stale.
 */
function isStale(current: ReviewSnapshot | null, next: ReviewSnapshot): boolean {
  return current !== null && current.review.id === next.review.id && next.rev < current.rev;
}

export const useReview = create<ReviewState>()((set, get) => ({
  snapshot: null,
  connected: false,
  inflight: {},
  pending: [],
  streams: {},
  resyncSeq: 0,
  activeGuideId: null,
  setActiveGuide: (guideId) => set((s) => (s.activeGuideId === guideId ? s : { activeGuideId: guideId })),
  setSnapshot: (snapshot) =>
    set((s) => {
      // A stale fetch must never clobber newer WS state. Equal revs are
      // accepted (live job lists merge into the snapshot without a bump).
      // In-flight entries survive resyncs; only settled jobs reap them.
      if (isStale(s.snapshot, snapshot)) return s;
      const drained = drainPending(snapshot, s.pending);
      return {
        snapshot: drained.snapshot,
        inflight: reapInflight(drained.snapshot.jobs, s.inflight, Date.now()),
        pending: drained.pending,
        resyncSeq: drained.gap ? s.resyncSeq + 1 : s.resyncSeq,
      };
    }),
  setConnected: (connected) => set({ connected }),
  applyEvent: (event) =>
    set((s) => {
      switch (event.type) {
        case "snapshot": {
          const snapshot = event.snapshot;
          if (isStale(s.snapshot, snapshot)) return s;
          const drained = drainPending(snapshot, s.pending);
          return {
            snapshot: drained.snapshot,
            inflight: reapInflight(drained.snapshot.jobs, s.inflight, Date.now()),
            pending: drained.pending,
            resyncSeq: drained.gap ? s.resyncSeq + 1 : s.resyncSeq,
          };
        }
        case "patch": {
          if (!s.snapshot) {
            // Before the first snapshot: queue until the fetch lands.
            return { pending: queuePatch(s.pending, event) };
          }
          if (event.baseRev === s.snapshot.rev) {
            let applied: ReviewSnapshot;
            try {
              applied = applyPatchOps(s.snapshot, event);
            } catch {
              return { pending: queuePatch(s.pending, event), resyncSeq: s.resyncSeq + 1 };
            }
            const drained = drainPending(applied, s.pending);
            return {
              snapshot: drained.snapshot,
              inflight: reapInflight(drained.snapshot.jobs, s.inflight, Date.now()),
              pending: drained.pending,
              resyncSeq: drained.gap ? s.resyncSeq + 1 : s.resyncSeq,
            };
          }
          if (event.baseRev < s.snapshot.rev) return s; // stale duplicate: drop
          return { pending: queuePatch(s.pending, event), resyncSeq: s.resyncSeq + 1 };
        }
        case "job": {
          if (!s.snapshot) return s;
          // Upsert: jobs created after the snapshot was fetched (every
          // user-started action) join the list here, so in-flight entries
          // can hand over to them and reap when they settle. Without this
          // the event would drop and the entry would stick until its TTL.
          const known = s.snapshot.jobs.some((j) => j.id === event.job.id);
          const jobs = known
            ? s.snapshot.jobs.map((j) => (j.id === event.job.id ? event.job : j))
            : [...s.snapshot.jobs, event.job];
          // Issue #126: a settled job ends its card's stream — the stored
          // turn (blocks or error) is the truth from here on.
          let streams = s.streams;
          if (isTerminalJobState(event.job.state) && event.job.annotationId) {
            const cur = streams[event.job.annotationId];
            if (cur && cur.jobId === event.job.id) {
              streams = { ...streams };
              delete streams[event.job.annotationId];
            }
          }
          return {
            snapshot: { ...s.snapshot, jobs },
            inflight: reapInflight(jobs, s.inflight, Date.now()),
            streams,
          };
        }
        case "text": {
          // Issue #126 (experiment): conversation deltas accumulate per
          // card for paragraph-by-paragraph answers. Deltas for anything
          // else (reader/critic jobs carry a card id, not an annotation
          // id) are still ignored — the working indicator stays a fixed
          // label (issue #46), only answer CONTENT streams.
          if (!event.annotationId || !event.delta) return s;
          const cur = s.streams[event.annotationId];
          return {
            ...s,
            streams: {
              ...s.streams,
              [event.annotationId]:
                !cur || cur.jobId !== event.jobId
                  ? { jobId: event.jobId, text: event.delta }
                  : { jobId: cur.jobId, text: cur.text + event.delta },
            },
          };
        }
        default:
          return s; // error handled by streaming views later
      }
    }),
  updateJob: (job) =>
    set((s) => {
      if (!s.snapshot) return s;
      const known = s.snapshot.jobs.some((j) => j.id === job.id);
      const jobs = known
        ? s.snapshot.jobs.map((j) => (j.id === job.id ? job : j))
        : [...s.snapshot.jobs, job];
      return {
        snapshot: { ...s.snapshot, jobs },
        inflight: reapInflight(jobs, s.inflight, Date.now()),
      };
    }),
  beginInflight: (targetId, kind, opts) => {
    const startedAt = Date.now();
    const seq = ++inflightSeq;
    const entry: InFlightAction = {
      kind,
      targetId,
      ...(opts?.revision !== undefined ? { revision: opts.revision } : {}),
      startedAt,
      seq,
    };
    set((s) => ({ inflight: { ...s.inflight, [targetId]: entry } }));
    // Backstop for entries nobody waits on: re-armed while a live job is
    // attached, so a long queue never drops the indicator mid-rewrite.
    const arm = (): void => {
      window.setTimeout(() => {
        if (get().inflight[targetId]?.seq !== seq) return;
        const st = get();
        if (!inflightExpired(st.inflight[targetId], st.snapshot?.jobs ?? [], Date.now())) {
          arm();
          return;
        }
        set((s) => {
          if (s.inflight[targetId]?.seq !== seq) return s;
          const next = { ...s.inflight };
          delete next[targetId];
          return { inflight: next };
        });
      }, INFLIGHT_TTL_MS + 50);
    };
    arm();
  },
  attachInflightJob: (targetId, jobId) =>
    set((s) => {
      const cur = s.inflight[targetId];
      if (!cur) return s;
      // The job can finish before the response is processed (fast or
      // replayed fills): attaching to an already-terminal job would stick
      // until the TTL, so reconcile immediately instead.
      const job = s.snapshot?.jobs.find((j) => j.id === jobId);
      if (job && isTerminalJobState(job.state)) {
        const next = { ...s.inflight };
        delete next[targetId];
        return { inflight: next };
      }
      return { inflight: { ...s.inflight, [targetId]: { ...cur, jobId } } };
    }),
  retargetInflight: (fromId, toId) =>
    set((s) => {
      const cur = s.inflight[fromId];
      if (!cur || fromId === toId) return s;
      const next = { ...s.inflight };
      delete next[fromId];
      next[toId] = { ...cur, targetId: toId };
      return { inflight: next };
    }),
  clearInflight: (targetId) =>
    set((s) => {
      if (!s.inflight[targetId]) return s;
      const next = { ...s.inflight };
      delete next[targetId];
      return { inflight: next };
    }),
  appendStream: (annotationId, jobId, delta) =>
    set((s) => {
      if (!delta) return s;
      const cur = s.streams[annotationId];
      return {
        streams: {
          ...s.streams,
          [annotationId]:
            !cur || cur.jobId !== jobId
              ? { jobId, text: delta }
              : { jobId, text: cur.text + delta },
        },
      };
    }),
  clearStream: (annotationId) =>
    set((s) => {
      if (!s.streams[annotationId]) return s;
      const next = { ...s.streams };
      delete next[annotationId];
      return { streams: next };
    }),
  clear: () => set({ snapshot: null, inflight: {}, pending: [], streams: {}, resyncSeq: 0, activeGuideId: null }),
}));

/**
 * Annotations shown in the current view: a custom guide's suggested
 * comments stay inside that guide until marked for the PR
 * (`annotationVisibleIn`). Returns the input list itself when nothing is
 * left out, so callers memoising on it keep their identity.
 */
export function visibleAnnotations(annotations: Annotation[], activeGuideId: string | null): Annotation[] {
  if (!annotations.some((a) => !annotationVisibleIn(a, activeGuideId))) return annotations;
  return annotations.filter((a) => annotationVisibleIn(a, activeGuideId));
}

/** `snapshot.annotations` filtered by `visibleAnnotations` for the open guide. */
export function useVisibleAnnotations(): Annotation[] | undefined {
  const annotations = useReview((s) => s.snapshot?.annotations);
  const activeGuideId = useReview((s) => s.activeGuideId);
  return useMemo(
    () => (annotations ? visibleAnnotations(annotations, activeGuideId) : undefined),
    [annotations, activeGuideId],
  );
}
