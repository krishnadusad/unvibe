/**
 * Diff pane (PRD §4.13): toolbar, files panel, file/hunk list.
 *
 * Behaviour ported from `prototype.html`; data comes from the review
 * snapshot (`files` + `hunkStates` + `fileStates`). Hunk state (folded,
 * reviewed, summary) and file fold state persist through
 * `PATCH /api/reviews/:id/hunks/:hash` and `…/files/:fileKey`; in mock
 * mode the in-memory API applies the same change through the WS-patch path.
 * A file's reviewed state is derived from its hunks, never stored.
 * View preferences persist in `localStorage`.
 *
 * Later milestones plug in here without touching this file's contract:
 * - threads/expansions render under a line via `lineSlots` (prop or
 *   `LineSlotProvider`) keyed `${fileKey}:${newSideLine}`;
 * - line-number clicks emit `onLineClick` ("start a comment" hook);
 * - the guide agent jumps here via `revealSource("diff:…")`.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DiffFilter, Hunk, HunkScoreLevel, Plotline, ReviewFile, UpdateHunkRequest } from "@unvibe/shared";
import { HUNK_SCORE_LABELS, hunkMatchesFilter, HUNK_PASS_FANOUT_LIMIT } from "@unvibe/shared";
import { api, apiErrorCode } from "../../api/client.js";
import { ErrorBoundary, InlineFallback } from "../../components/ErrorBoundary.js";
import { Icon } from "../../components/Icon.js";
import { toast } from "../../floating/Toast.js";
import { useReview } from "../../state/store.js";
import { GuideFilterChip } from "./GuideFilterChip.js";
import {
  statusToBanner,
  VersionBanner,
  type BannerCounts,
} from "../../versions/VersionBanner.js";
import { useReviewVersion } from "../../versions/useReviewVersion.js";
import { useRefresh } from "../../versions/useRefresh.js";
import { FileSection, type DiffViewMode, type HunkActions, type HunkUiState } from "./FileSection.js";
import { Button, DiffStat } from "../../ui/index.js";
import {
  buildFileTree,
  citedHunkHashes,
  filterFiles,
  guideHunkStates,
  hunkInScope,
  hunkOverlaps,
  shouldHideHunk,
  tailPathParts,
  type TreeRow,
} from "./diffLogic.js";
import { useGithubThreads } from "../../comments/GithubThreads.js";
import { useLineSlots, type LineSlots } from "./lineSlots.js";
import {
  observeDiffPinned,
  onRevealSource,
  parseDiffRef,
  refreshDiffPinned,
  revealDiffElement,
  revealSource,
  takePendingReveal,
  type RevealTarget,
} from "./revealSource.js";

export const WIDEN_EVENT = "unvibe:widen-pane";

const PREFS_KEY = "unvibe.diff.prefs.v1";
const CATS = [
  { k: "source", l: "Code" },
  { k: "tests", l: "Tests" },
  { k: "docs", l: "Docs" },
  { k: "config", l: "Config" },
  { k: "generated", l: "Generated" },
] as const;

interface DiffPrefs {
  view: DiffViewMode;
  hideUninteresting: boolean;
  hideReviewed: boolean;
  cats: string[];
  filesOpen: boolean;
}

const DEFAULT_PREFS: DiffPrefs = {
  view: "unified",
  hideUninteresting: true,
  hideReviewed: false,
  cats: CATS.map((c) => c.k),
  filesOpen: false,
};

function loadPrefs(): DiffPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<DiffPrefs>;
    return {
      view: p.view === "split" ? "split" : "unified",
      hideUninteresting: p.hideUninteresting ?? true,
      hideReviewed: p.hideReviewed ?? false,
      cats: Array.isArray(p.cats) && p.cats.length > 0 ? p.cats : [...DEFAULT_PREFS.cats],
      filesOpen: p.filesOpen ?? false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface DiffViewProps {
  reviewId: string;
  /** Extra rows under a diff line, keyed `${fileKey}:${newSideLine}`. */
  lineSlots?: LineSlots;
  /** New-side lines that already have a comment (shows the comment icon). */
  commentedLines?: ReadonlySet<string>;
  /** "Start a comment" hook: fired when a new-side line number is clicked. */
  onLineClick?: (fileKey: string, line: number) => void;
  /**
   * Page lookup + navigation + follow-ups for activated hunk cards
   * (#138). Optional so DiffView stays usable standalone in tests; the
   * review route always passes the real ones.
   */
  lookupPage?: (pageId: string) => import("@unvibe/shared").Page | undefined;
  onOpenPage?: (pageId: string) => void;
  onFollowUp?: (cardId: string, blockId: string, index: number) => void;
}

interface Highlight {
  fileKey: string;
  start: number;
  end: number;
  nonce: number;
}

export function DiffView({ reviewId, lineSlots, commentedLines, onLineClick, lookupPage, onOpenPage, onFollowUp }: DiffViewProps): ReactNode {
  const snapshot = useReview((s) => s.snapshot);
  const setSnapshot = useReview((s) => s.setSnapshot);
  const [prefs, setPrefs] = useState<DiffPrefs>(loadPrefs);
  const [fq, setFq] = useState("");
  // Issue #169: the score/plotline filter — one dropdown in the filter
  // menu, remembered with the review (snapshot `diffFilter`, not local
  // prefs). Local state applies at once; the PATCH persists it and the
  // snapshot echo converges back through the effect below.
  const [plotFilter, setPlotFilter] = useState<DiffFilter>({});
  // Keys of filter values this pane itself sent and has not yet seen
  // echoed back: their echoes must never be adopted over local state
  // (see the adoption effect below).
  const ownFilterEchoes = useRef<Set<string>>(new Set());
  const [unhidden, setUnhidden] = useState<Record<string, boolean>>({});
  const [dirOpen, setDirOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [fileHighlight, setFileHighlight] = useState<string | null>(null);
  // #241: the Refresh button lives in the review top bar now; its banner
  // state is shared (see `versions/refreshStore.ts`) so the "new commits
  // available" UI still renders here.
  const { banner, clearBanner } = useRefresh(reviewId);
  const [eagerFiles, setEagerFiles] = useState<ReadonlySet<string>>(new Set());
  // Reviews without readable file content (issue #133: the service
  // answers `no-content`, e.g. the demo) hide every expansion control
  // instead of showing load errors. One probe per review, decided by the
  // service — never by "is demo".
  const [noContent, setNoContent] = useState(false);
  const versionParam = useReviewVersion();
  const [briefs, setBriefs] = useState<Record<string, string> | null>(null);
  const hlTimer = useRef<number | undefined>(undefined);
  const ctxSlots = useLineSlots();
  const gh = useGithubThreads();
  // A user thread and a GitHub thread share a line's slot row: merge
  // the content instead of letting one map overwrite the other.
  const slots = useMemo(() => {
    const merged: LineSlots = { ...ctxSlots, ...lineSlots };
    for (const [key, node] of Object.entries(gh.lineSlots)) {
      const prev = merged[key];
      merged[key] = prev ? (
        <Fragment key={key}>
          {prev}
          {node}
        </Fragment>
      ) : (
        node
      );
    }
    return merged;
  }, [ctxSlots, lineSlots, gh.lineSlots]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Private mode: prefs just don't persist.
    }
  }, [prefs]);

  // Adopt the review's stored filter when it arrives or changes
  // server-side (e.g. a plotline picked in the guide); ignore echoes
  // of our own changes. An echo is not necessarily the latest value
  // we sent: on a slow client the snapshot patch for change N can be
  // applied after change N+1 already landed locally, and adopting it
  // would resurrect the dimension N+1 cleared (#195). Own echoes are
  // recognised by value and consumed, never adopted — local state is
  // already at or past them.
  const storedFilterKey = JSON.stringify(snapshot?.diffFilter ?? {});
  useEffect(() => {
    ownFilterEchoes.current.clear();
  }, [reviewId]);
  useEffect(() => {
    if (ownFilterEchoes.current.has(storedFilterKey)) {
      ownFilterEchoes.current.delete(storedFilterKey);
      return;
    }
    // A genuinely external value supersedes any echoes still pending.
    ownFilterEchoes.current.clear();
    setPlotFilter(snapshot?.diffFilter ? { ...snapshot.diffFilter } : {});
  }, [reviewId, storedFilterKey, snapshot?.diffFilter]);

  // Custom guides: while one is open (filter `guideId`), only its hunks
  // show and plotlines mean that guide's own (its assignment replaces
  // the main guide's in the hunk states below).
  const activeGuide = useMemo(
    () => (plotFilter.guideId ? (snapshot?.guides ?? []).find((g) => g.id === plotFilter.guideId) : undefined),
    [plotFilter.guideId, snapshot?.guides],
  );
  const guideScope = useMemo(() => (activeGuide ? new Set(activeGuide.hunks) : undefined), [activeGuide]);

  // Snapshot: the guide column fetches it too; fetch here when absent so the
  // diff pane works standalone (tests, deep links). `?version=n` views an
  // older version read-only (PRD §8).
  useEffect(() => {
    if (snapshot) return;
    let cancelled = false;
    api
      .review(reviewId, versionParam)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        // Service stubs return 501 until Service M1 lands; the pane shows loading.
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, versionParam, snapshot, setSnapshot]);

  // Content probe (issue #133): hide expansion where the review has no
  // file content to read. Only `no-content` hides; any other outcome
  // (slices work, other errors) keeps the controls.
  const probeHead = snapshot?.version.headSha;
  const probePath = useMemo(() => {
    const files = snapshot?.files ?? [];
    return (files.find((f) => !f.isBinary && f.hunks.length > 0) ?? files[0])?.path;
  }, [snapshot?.files]);
  useEffect(() => {
    setNoContent(false);
    if (!probeHead || !probePath) return;
    let cancelled = false;
    api
      .fileSlice(reviewId, { path: probePath, commit: probeHead, start: 1, end: 1 })
      .then(() => {})
      .catch((err: unknown) => {
        if (!cancelled && apiErrorCode(err) === "no-content") setNoContent(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, probeHead, probePath]);

  const onUpdated = useCallback(async () => {
    clearBanner();
    try {
      setSnapshot(await api.review(reviewId));
      toast("Review updated");
    } catch {
      toast("Updated. Reload the page to see it.");
    }
  }, [reviewId, setSnapshot, clearBanner]);

  // Mock-only hidden-row brief copy (prototype BRIEF; M2's hunk pass
  // produces these per hunk). Code-split so production never loads it.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK === "1") {
      import("../../mock/diff.js")
        .then((m) => setBriefs(m.HUNK_BRIEFS))
        .catch(() => {});
    }
  }, []);

  // Hunk states keyed by content hash for the file sections below.
  const states = useMemo(() => {
    const base = new Map<string, HunkUiState>((snapshot?.hunkStates ?? []).map((s) => [s.contentHash, s]));
    if (!activeGuide) return base;
    return guideHunkStates<HunkUiState>(snapshot?.files ?? [], base, activeGuide.assignment, () => ({ folded: false, reviewed: false }));
  }, [snapshot, activeGuide]);

  // File fold state lives on the snapshot (issue #162), so it survives
  // tab switches, reloads and restarts — unlike the old local state.
  const fileFolded = useMemo(
    () => new Map<string, boolean>((snapshot?.fileStates ?? []).map((s) => [s.fileKey, s.folded])),
    [snapshot],
  );

  const patchFileFold = useCallback(
    async (fileKey: string, folded: boolean) => {
      try {
        await api.updateFile(reviewId, fileKey, { folded });
      } catch {
        toast("Couldn't save file state");
      }
    },
    [reviewId],
  );

  // Activated hunk summaries (issue #138): content hash → conversation
  // card. Only hashes in the current files draw — a card whose hunk
  // changed stays with the old version and never renders on the new one.
  const hunkCards = useMemo(() => {
    const files = snapshot?.files ?? [];
    const current = new Set(files.flatMap((f) => f.hunks.map((h) => h.contentHash)));
    const map = new Map<string, import("@unvibe/shared").Annotation>();
    for (const a of snapshot?.annotations ?? []) {
      if (a.type !== "conversation" || a.anchor.host.kind !== "hunk") continue;
      if (!current.has(a.anchor.host.contentHash) || map.has(a.anchor.host.contentHash)) continue;
      map.set(a.anchor.host.contentHash, a);
    }
    return map;
  }, [snapshot]);

  // Promoted hunk discussions (issue #138 follow-up): content hash →
  // page id. The hunk keeps its summary text plus a page-link chip; its
  // interactions open the page instead of activating a fresh card.
  const promotedHunks = useMemo(() => {
    const files = snapshot?.files ?? [];
    const current = new Set(files.flatMap((f) => f.hunks.map((h) => h.contentHash)));
    const map = new Map<string, string>();
    for (const a of snapshot?.annotations ?? []) {
      if (a.type !== "link" || a.anchor.host.kind !== "hunk" || !a.promotedToPage) continue;
      if (!current.has(a.anchor.host.contentHash) || map.has(a.anchor.host.contentHash)) continue;
      map.set(a.anchor.host.contentHash, a.promotedToPage);
    }
    return map;
  }, [snapshot]);

  const reviewedCount = useCallback(
    (f: ReviewFile) => f.hunks.filter((h) => states.get(h.contentHash)?.reviewed).length,
    [states],
  );

  const cited = useMemo(
    () =>
      snapshot ? citedHunkHashes(snapshot.files, snapshot.pages, snapshot.annotations) : new Set<string>(),
    [snapshot],
  );

  const isHidden = useCallback(
    (h: Hunk) =>
      shouldHideHunk(h, {
        hideUninteresting: prefs.hideUninteresting,
        unhidden: !!unhidden[h.contentHash],
        cited: cited.has(h.contentHash),
      }),
    [prefs.hideUninteresting, unhidden, cited],
  );

  const cats = useMemo(() => new Set(prefs.cats), [prefs.cats]);
  const hunkStateOf = useCallback(
    (contentHash: string) => {
      const s = states.get(contentHash);
      return s ? { score: s.score, plotline: s.plotline } : undefined;
    },
    [states],
  );
  const plotActive = plotFilter.plotline !== undefined || plotFilter.score !== undefined;
  const visible = useMemo(
    () =>
      snapshot
        ? filterFiles(snapshot.files, {
            query: fq,
            cats,
            hideReviewed: prefs.hideReviewed,
            reviewedCount,
            ...(plotActive ? { plot: plotFilter } : {}),
            hunkStateOf,
            ...(guideScope ? { scope: guideScope } : {}),
          })
        : [],
    [snapshot, fq, cats, prefs.hideReviewed, reviewedCount, plotActive, plotFilter, hunkStateOf, guideScope],
  );

  const progress = useMemo(() => {
    const files = snapshot?.files ?? [];
    const total = files.reduce((s, f) => s + f.hunks.length, 0);
    const rev = files.reduce((s, f) => s + f.hunks.filter((h) => states.get(h.contentHash)?.reviewed).length, 0);
    return { reviewed: rev, total };
  }, [snapshot, states]);

  // Summarize is async (a job on the service, canned text in mock): the
  // button shows progress until the snapshot actually carries a summary.
  // Read the snapshot rows directly: any landed summary settles the
  // request, and the hunk offers Summarize again for unusable text.
  useEffect(() => {
    setBusy((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const landed = new Set(
        (snapshot?.hunkStates ?? []).filter((s) => s.summary !== undefined).map((s) => s.contentHash),
      );
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (landed.has(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [snapshot]);

  const flash = useCallback((hl: Highlight | null, fileKey: string | null) => {
    window.clearTimeout(hlTimer.current);
    setHighlight(hl);
    setFileHighlight(fileKey);
    hlTimer.current = window.setTimeout(() => {
      setHighlight(null);
      setFileHighlight(null);
    }, 2600);
  }, []);

  // Older versions are view-only for user data (reviewed, summaries):
  // those writes are refused with a pointer back. Folding only hides
  // code, so it stays allowed while browsing history.
  const readOnly =
    versionParam !== undefined && snapshot !== null && versionParam !== snapshot.review.currentVersion;

  const setPlotFilterAndPersist = useCallback(
    (next: DiffFilter) => {
      setPlotFilter(next);
      ownFilterEchoes.current.add(JSON.stringify(next));
      // Read-only history: the choice still applies to this view, it just
      // is not remembered with the review.
      if (readOnly) return;
      const body = {
        ...(next.plotline !== undefined ? { plotline: next.plotline } : { plotline: null }),
        ...(next.score !== undefined ? { score: next.score } : { score: null }),
      };
      api.updateDiffFilter(reviewId, body).catch(() => {
        toast("Couldn't save the filter");
      });
    },
    [reviewId, readOnly],
  );

  // Owner direction (#169): dots and chips are the selectors — clicking
  // one toggles that dimension of the stored filter; there are no radio
  // groups in the filter menu any more.
  const toggleScore = useCallback(
    (level: HunkScoreLevel) => {
      const next: DiffFilter = { ...plotFilter };
      if (next.score === level) delete next.score;
      else next.score = level;
      setPlotFilterAndPersist(next);
    },
    [plotFilter, setPlotFilterAndPersist],
  );
  const togglePlotline = useCallback(
    (id: string) => {
      const next: DiffFilter = { ...plotFilter };
      if (next.plotline === id) delete next.plotline;
      else next.plotline = id;
      setPlotFilterAndPersist(next);
    },
    [plotFilter, setPlotFilterAndPersist],
  );
  const hiddenHunks = useMemo(() => {
    const inScope = (f: ReviewFile): number => f.hunks.filter((h) => hunkInScope(f.fileKey, h, guideScope)).length;
    const shown = visible.reduce((s, f) => s + inScope(f), 0);
    const total = guideScope ? (snapshot?.files ?? []).reduce((s, f) => s + inScope(f), 0) : progress.total;
    return Math.max(0, total - shown);
  }, [visible, progress.total, guideScope, snapshot?.files]);

  const plotlines: Plotline[] = useMemo(
    () => activeGuide?.plotlines ?? snapshot?.plotlines ?? [],
    [activeGuide, snapshot?.plotlines],
  );
  const plotlineNames = useMemo(() => new Map(plotlines.map((p) => [p.id, p.name])), [plotlines]);

  const doReveal = useCallback(
    (target: RevealTarget, keepFilters = false) => {
      const snap = useReview.getState().snapshot;
      if (!snap) return;
      const file = snap.files.find((f) => f.fileKey === target.fileKey);
      if (!file) return;
      const st = new Map(snap.hunkStates.map((s) => [s.contentHash, s]));
      const fullyReviewed = file.hunks.every((h) => st.get(h.contentHash)?.reviewed);
      // Citation reveals clear whatever filter hides the target (the
      // line was promised); filter actions jumping to their own first
      // hunk (#190) keep every filter exactly as the user left it.
      if (!keepFilters) {
        setPrefs((p) => ({
          ...p,
          cats: p.cats.includes(file.category) ? p.cats : [...p.cats, file.category],
          hideReviewed: p.hideReviewed && fullyReviewed ? false : p.hideReviewed,
        }));
        setFq((prev) => (file.path.toLowerCase().includes(prev.toLowerCase()) ? prev : ""));
      }
      // A jump target the score/plotline filter would hide clears the
      // filter (citations promise the line will show). The stored filter
      // is the freshest copy (a selector in the guide may have just set
      // it), so check against the snapshot, not local state.
      if (!keepFilters && target.start !== undefined) {
        const end = target.end ?? target.start;
        const activeFilter = snap.diffFilter ?? plotFilter;
        // Inside a custom guide the guide's own plotlines apply, and the
        // guide's scope stays: code outside it is not shown here.
        const guide = activeFilter.guideId ? (snap.guides ?? []).find((g) => g.id === activeFilter.guideId) : undefined;
        const scope = guide ? new Set(guide.hunks) : undefined;
        const plotOf = (h: Hunk): string | undefined =>
          guide ? guide.assignment[`h:${file.fileKey}:${h.contentHash}`] : st.get(h.contentHash)?.plotline;
        const overlapping = file.hunks.filter((h) => hunkOverlaps(h, target.start as number, end));
        if (scope && overlapping.length > 0 && !overlapping.some((h) => hunkInScope(file.fileKey, h, scope))) {
          toast("That code is outside this guide. Switch to the main guide to see it.");
        }
        const seen = overlapping.some(
          (h) =>
            hunkInScope(file.fileKey, h, scope) &&
            hunkMatchesFilter(st.get(h.contentHash)?.score, plotOf(h), activeFilter),
        );
        if (!seen && (activeFilter.plotline !== undefined || activeFilter.score !== undefined)) {
          setPlotFilterAndPersist(activeFilter.guideId ? { guideId: activeFilter.guideId } : {});
        }
      }
      void patchFileFold(file.fileKey, false);
      setEagerFiles((prev) => new Set(prev).add(file.fileKey));
      if (target.start === undefined) {
        flash(null, file.fileKey);
        return;
      }
      const end = target.end ?? target.start;
      setUnhidden((prev) => {
        const next = { ...prev };
        for (const h of file.hunks) if (hunkOverlaps(h, target.start as number, end)) next[h.contentHash] = true;
        return next;
      });
      // Unfold the overlapping hunks so the lines are visible (persisted,
      // like clicking "show" — the prototype has no persistence to keep).
      for (const h of file.hunks) {
        if (hunkOverlaps(h, target.start, end) && st.get(h.contentHash)?.folded) {
          api.updateHunk(reviewId, h.contentHash, { folded: false }).catch(() => {});
        }
      }
      flash({ fileKey: file.fileKey, start: target.start, end, nonce: Date.now() }, null);
    },
    [reviewId, flash, patchFileFold, plotActive, plotFilter, setPlotFilterAndPersist],
  );

  useEffect(() => {
    if (!snapshot) return;
    const p = takePendingReveal();
    if (p) {
      const t = parseDiffRef(p.ref);
      if (t) doReveal(t, p.keepFilters);
    }
  }, [snapshot, doReveal]);

  useEffect(() => onRevealSource((_ref, target, opts) => doReveal(target, opts?.keepFilters ?? false)), [doReveal]);

  // Mock-mode hook for Playwright: `window.__revealSource("diff:conn:82")`.
  useEffect(() => {
    if (import.meta.env.VITE_MOCK === "1") {
      (window as unknown as { __revealSource?: (ref: string) => boolean }).__revealSource = revealSource;
    }
  }, []);

  useEffect(() => {
    if (!highlight && !fileHighlight) return;
    const key = highlight?.fileKey ?? fileHighlight;
    if (!key) return;
    let el: HTMLElement | null = null;
    if (highlight) {
      for (let l = highlight.start; l <= highlight.end; l++) {
        el = document.getElementById(`L-${key}-${l}`);
        if (el) break;
      }
    }
    el ??= document.getElementById(`F-${key}`);
    // The file and hunk headers pin under the actions bar (#140): land the
    // target below the pinned rows through the shared offset, not
    // center-scroll. A line target clears all four rows; a file target is
    // the file header itself, so it clears the strip plus bar only.
    // jsdom (unit tests) has no layout; the helper falls back there.
    if (el) revealDiffElement(el, highlight ? "line" : "file");
  }, [highlight, fileHighlight]);

  // #132/#140: keep the pinned rows' sticky `top`s equal to the rows' live
  // heights (a ResizeObserver, never a scroll listener); re-sample when the
  // snapshot or view changes, which mounts headers without resizing the pane.
  useEffect(() => observeDiffPinned(), []);
  useEffect(() => {
    refreshDiffPinned();
  }, [snapshot, prefs.view]);

  useEffect(() => () => window.clearTimeout(hlTimer.current), []);

  const patchHunk = useCallback(
    async (hash: string, body: UpdateHunkRequest) => {
      if (readOnly && (body.reviewed !== undefined || body.summary !== undefined)) {
        toast("Viewing an older version · read-only");
        return;
      }
      try {
        await api.updateHunk(reviewId, hash, body);
      } catch {
        toast("Couldn't save hunk state");
      }
    },
    [reviewId, readOnly],
  );

  const actions: HunkActions = useMemo(
    () => ({
      toggleFold: (hash, folded) => void patchHunk(hash, { folded: !folded }),
      summarize: (hash) => {
        if (readOnly) {
          toast("Viewing an older version · read-only");
          return;
        }
        setBusy((prev) => ({ ...prev, [hash]: true }));
        api.summarizeHunk(reviewId, hash).catch(() => {
          toast("Couldn't summarize the hunk");
          setBusy((prev) => {
            const next = { ...prev };
            delete next[hash];
            return next;
          });
        });
      },
      deleteSummary: (hash) => void patchHunk(hash, { summary: null }),
      toggleReviewed: (hash, reviewed) => void patchHunk(hash, { reviewed: !reviewed, folded: !reviewed }),
    }),
    [patchHunk, reviewId],
  );

  const setView = useCallback(
    (view: DiffViewMode) => {
      if (view === "split") window.dispatchEvent(new CustomEvent(WIDEN_EVENT));
      setPrefs((p) => ({ ...p, view }));
    },
    [],
  );

  const foldAll = useCallback(async () => {
    if (readOnly) {
      toast("Viewing an older version · read-only");
      return;
    }
    const snap = useReview.getState().snapshot;
    if (!snap) return;
    // The view's hunk states (a custom guide's plotlines when one is open).
    const st = states;
    const targets: { file: ReviewFile; hunk: Hunk }[] = [];
    for (const f of filterFiles(snap.files, {
      query: fq,
      cats: new Set(prefs.cats),
      hideReviewed: prefs.hideReviewed,
      reviewedCount,
      ...(plotActive ? { plot: plotFilter } : {}),
      hunkStateOf: (hash) => {
        const s = st.get(hash);
        return s ? { score: s.score, plotline: s.plotline } : undefined;
      },
      ...(guideScope ? { scope: guideScope } : {}),
    })) {
      f.hunks.forEach((h) => {
        if (!hunkInScope(f.fileKey, h, guideScope)) return;
        if (
          shouldHideHunk(h, {
            hideUninteresting: prefs.hideUninteresting,
            unhidden: !!unhidden[h.contentHash],
            cited: cited.has(h.contentHash),
          })
        ) {
          return;
        }
        if (!hunkMatchesFilter(st.get(h.contentHash)?.score, st.get(h.contentHash)?.plotline, plotFilter)) {
          return;
        }
        targets.push({ file: f, hunk: h });
      });
    }
    // Fold first so the UI settles, then summarize only the hunks still
    // lacking one — except past the hunk-pass fan-out limit (issue #107),
    // where Fold all folds only: requesting a summary per hunk would be
    // exactly the fan-out the pipeline refuses to run, and the per-hunk
    // Summarize button in the hunk header stays as the on-demand path.
    await Promise.all(targets.map(({ hunk }) => api.updateHunk(reviewId, hunk.contentHash, { folded: true }).catch(() => {})));
    const totalHunks = snap.files.reduce((n, f) => n + f.hunks.length, 0);
    const overFanout = totalHunks > HUNK_PASS_FANOUT_LIMIT;
    const foldedNoun = `${targets.length} ${targets.length === 1 ? "hunk" : "hunks"}`;
    if (!overFanout) {
      let missing = 0;
      for (const { hunk } of targets) {
        if (!st.get(hunk.contentHash)?.summary) {
          missing += 1;
          actions.summarize(hunk.contentHash);
        }
      }
      toast(missing > 0 ? `Folded ${foldedNoun}. Summaries appear as they are written.` : `Folded ${foldedNoun}.`);
    } else {
      toast(
        `Folded ${foldedNoun}. ` +
          "This review is past the per-hunk summary limit, so summaries stay on demand — use the spark button on any hunk.",
      );
    }
  }, [reviewId, readOnly, fq, prefs, reviewedCount, unhidden, cited, actions, plotActive, plotFilter, states, guideScope]);

  const unfoldAll = useCallback(async () => {
    if (readOnly) {
      toast("Viewing an older version · read-only");
      return;
    }
    const snap = useReview.getState().snapshot;
    if (!snap) return;
    await Promise.all(
      snap.files.flatMap((f) => [
        api.updateFile(reviewId, f.fileKey, { folded: false }).catch(() => {}),
        ...f.hunks.map((h) => api.updateHunk(reviewId, h.contentHash, { folded: false }).catch(() => {})),
      ]),
    );
  }, [reviewId, readOnly]);

  const markFileReviewed = useCallback(
    (file: ReviewFile, allReviewed: boolean) => {
      if (readOnly) {
        toast("Viewing an older version · read-only");
        return;
      }
      void Promise.all(
        file.hunks.map((h) =>
          api.updateHunk(reviewId, h.contentHash, { reviewed: !allReviewed, folded: !allReviewed }).catch(() => {}),
        ),
      ).catch(() => toast("Couldn't save that change"));
    },
    [reviewId, readOnly],
  );

  // Issue #168: one show/hide control for existing GitHub comments,
  // remembered with the review. Hiding never removes them from the
  // agents' context; the comments menu's section follows this setting.
  const toggleGithubComments = useCallback(() => {
    const current = useReview.getState().snapshot?.viewPrefs.showExistingComments ?? true;
    api.updateView(reviewId, { showExistingComments: !current }).catch(() => {
      toast("Couldn't save that change");
    });
  }, [reviewId]);

  if (!snapshot) {
    return (
      <div>
        <div className="dtool">
          <span className="hint">Loading diff…</span>
        </div>
      </div>
    );
  }

  const tree: TreeRow[] = prefs.filesOpen ? buildFileTree(visible) : [];
  const catCount = (k: string): number => snapshot.files.filter((f) => f.category === k).length;
  // Tooltip is the action only (#225); `foldAll` still computes the
  // fan-out/summary state itself for its behaviour and toast.
  const foldTip = "Fold the code";

  // Update banner: the local refresh result wins; otherwise the snapshot's
  // own `versionStatus` (set when a refresh created a newer version).
  // Hidden while viewing an older version.
  const bannerCounts: BannerCounts | null = readOnly
    ? null
    : (banner ?? (snapshot.versionStatus ? statusToBanner(snapshot.versionStatus) : null));

  return (
    <div>
      <div className="dtool">
        {activeGuide ? <GuideFilterChip reviewId={reviewId} title={activeGuide.title} hunks={activeGuide.hunks.length} /> : null}
        {plotFilter.score !== undefined ? (
          <span className="fchip" data-filterchip="score">
            Score: {HUNK_SCORE_LABELS[plotFilter.score].toLowerCase()} or higher · {hiddenHunks} hidden
            <button
              type="button"
              aria-label="Clear score filter"
              data-tip="Clear filter"
              onClick={() => toggleScore(plotFilter.score as HunkScoreLevel)}
            >
              ×
            </button>
          </span>
        ) : null}
        {plotFilter.plotline !== undefined ? (
          <span className="fchip" data-filterchip="plotline">
            Plotline: {plotlineNames.get(plotFilter.plotline) ?? plotFilter.plotline} · {hiddenHunks} hidden
            <button
              type="button"
              aria-label="Clear plotline filter"
              data-tip="Clear filter"
              onClick={() => togglePlotline(plotFilter.plotline as string)}
            >
              ×
            </button>
          </span>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-expanded={prefs.filesOpen}
          data-tip={prefs.filesOpen ? "Hide file list" : "Show file list"}
          aria-label={prefs.filesOpen ? "Hide file list" : "Show file list"}
          onClick={() => {
            // Opening the list from a scrolled diff shows it at the top
            // (prototype parity: `byId("right").scrollTop = 0`), so the
            // panel and its dropdown open fully visible under the bar.
            if (!prefs.filesOpen) document.getElementById("right")?.scrollTo(0, 0);
            setPrefs((p) => ({ ...p, filesOpen: !p.filesOpen }));
          }}
        >
          <Icon name={prefs.filesOpen ? "down" : "right"} />
          Files <span className="hint">{visible.length}/{snapshot.files.length}</span>
        </Button>
        <FilterMenuButton
          label="Review filters"
          tip="Reviewed and GitHub comment filters"
          icon="filter"
          rows={[
            {
              key: "__reviewed",
              label: "Reviewed",
              checked: !prefs.hideReviewed,
              count: snapshot.files.filter((f) => reviewedCount(f) === f.hunks.length).length,
              toggle: () => setPrefs((p) => ({ ...p, hideReviewed: !p.hideReviewed })),
            },
            {
              key: "__github",
              label: "GitHub comments",
              checked: snapshot.viewPrefs.showExistingComments,
              count: snapshot.existingComments?.length ?? 0,
              toggle: toggleGithubComments,
            },
          ]}
        />
        <span className="seg" role="group" aria-label="Diff view">
          <button
            type="button"
            aria-pressed={prefs.view === "unified"}
            aria-label="Unified"
            data-tip="Unified"
            onClick={() => setView("unified")}
          >
            <Icon name="unified" />
          </button>
          <button
            type="button"
            aria-pressed={prefs.view === "split"}
            aria-label="Split"
            data-tip="Split"
            onClick={() => setView("split")}
          >
            <Icon name="split" />
          </button>
        </span>
        <button
          className="x"
          type="button"
          aria-pressed={prefs.hideUninteresting}
          data-tip="Hide uninteresting"
          aria-label="Hide uninteresting"
          onClick={() =>
            setPrefs((p) => {
              if (!p.hideUninteresting) setUnhidden({});
              return { ...p, hideUninteresting: !p.hideUninteresting };
            })
          }
        >
          <Icon name="eyeOff" />
        </button>
        <button
          className="x"
          type="button"
          data-tip={foldTip}
          aria-label="Fold all"
          onClick={() => void foldAll()}
        >
          <Icon name="fold" />
        </button>
        <button
          className="x"
          type="button"
          data-tip="Unfold the code"
          aria-label="Unfold all"
          onClick={() => void unfoldAll()}
        >
          <Icon name="unfold" />
        </button>
        <span
          className="rprog"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.reviewed}
          aria-label={`${progress.reviewed} of ${progress.total} hunks reviewed`}
          data-tip={`${progress.reviewed} of ${progress.total} hunks reviewed`}
        >
          <i style={{ width: `${progress.total === 0 ? 0 : (100 * progress.reviewed) / progress.total}%` }} />
        </span>
      </div>
      {readOnly ? (
        <div className="dbar" role="status">
          <span className="hint">Viewing v{versionParam} · read-only</span>
        </div>
      ) : null}
      {bannerCounts ? (
        <VersionBanner reviewId={reviewId} counts={bannerCounts} onUpdated={() => void onUpdated()} />
      ) : null}
      {prefs.filesOpen ? (
        <div className="files">
          <div className="frow">
            <input
              type="search"
              id="fq"
              placeholder="Filter files by name"
              aria-label="Filter files by name"
              value={fq}
              onChange={(e) => setFq(e.target.value)}
            />
            <FilterMenuButton
              label="File filters"
              tip="Filter files by type"
              icon="filter"
              rows={CATS.map((c) => ({
                key: c.k,
                label: c.l,
                checked: cats.has(c.k),
                count: catCount(c.k),
                toggle: () =>
                  setPrefs((p) => ({
                    ...p,
                    cats: p.cats.includes(c.k) ? p.cats.filter((x) => x !== c.k) : [...p.cats, c.k],
                  })),
              }))}
            />
          </div>
          <div className="flist">
            {tree.length > 0 ? (
              tree.map((row) =>
                row.type === "dir" ? (
                  <button
                    key={`dir-${row.path}`}
                    className="fr dir"
                    type="button"
                    style={{ paddingLeft: 10 + row.depth * 14 }}
                    aria-expanded={dirOpen[row.path] ?? true}
                    onClick={() => setDirOpen((prev) => ({ ...prev, [row.path]: !(prev[row.path] ?? true) }))}
                  >
                    <Icon name={dirOpen[row.path] ?? true ? "down" : "right"} />
                    <span className="nm" title={row.path}>
                      <PathTail text={row.label} />
                    </span>
                  </button>
                ) : (
                  <FileTreeRow
                    key={`file-${row.file.fileKey}`}
                    file={row.file}
                    depth={row.depth}
                    reviewed={reviewedCount(row.file)}
                    onJump={(key) => {
                      void patchFileFold(key, false);
                      setEagerFiles((prev) => new Set(prev).add(key));
                      setTimeout(() => {
                        const el = document.getElementById(`F-${key}`);
                        // Land the file header below the pinned rows (#132):
                        // the strip plus bar ("file" scope — the target is
                        // the header itself, no file/hunk header pins above it).
                        if (el) revealDiffElement(el, "file");
                      }, 0);
                    }}
                  />
                ),
              )
            ) : (
              <p className="hint" style={{ padding: "4px 10px", margin: 0 }}>
                No files match the filters.
              </p>
            )}
          </div>
        </div>
      ) : null}
      <div className="dband" aria-hidden="true" />
      {visible.length > 0 ? (
        visible.map((f, vi) => (
          // One boundary per file section: a file that fails to render
          // shows a file-shaped notice instead of blanking the whole pane.
          <ErrorBoundary
            key={f.fileKey}
            name="diff-file"
            resetKey={`${reviewId}:${f.fileKey}`}
            fallback={({ reset }) => (
              <div className="dfile" id={`F-${f.fileKey}`}>
                <InlineFallback message="Couldn't show this file: something went wrong" onRetry={reset} />
              </div>
            )}
          >
            <FileSection
              file={f}
              view={prefs.view}
              reviewed={reviewedCount(f)}
              folded={fileFolded.get(f.fileKey) ?? false}
              eager={vi < 3 || eagerFiles.has(f.fileKey)}
              busy={busy}
              slots={slots}
              commentedLines={commentedLines ?? new Set()}
              highlight={highlight?.fileKey === f.fileKey ? { start: highlight.start, end: highlight.end } : null}
              fileHighlighted={fileHighlight === f.fileKey}
              reviewId={reviewId}
              headCommit={snapshot.version.headSha}
              baseCommit={snapshot.version.mergeBaseSha}
              contentAvailable={!noContent}
              briefs={briefs}
              states={states}
              hunkCards={hunkCards}
              promotedHunks={promotedHunks}
              lookupPage={lookupPage ?? (() => undefined)}
              onOpenPage={onOpenPage ?? (() => {})}
              onFollowUp={onFollowUp ?? (() => {})}
              plotFilter={plotActive ? plotFilter : undefined}
              scope={guideScope}
              plotlineNames={plotlineNames}
              onSelectScore={toggleScore}
              onSelectPlotline={togglePlotline}
              isHidden={isHidden}
              actions={actions}
              onLineClick={onLineClick}
              fileTop={gh.fileTops[f.fileKey]}
              onToggleFileFold={(key) => void patchFileFold(key, !(fileFolded.get(key) ?? false))}
              onMarkFileReviewed={markFileReviewed}
              onUnhide={(hashes) => setUnhidden((prev) => ({ ...prev, ...Object.fromEntries(hashes.map((h) => [h, true])) }))}
            />
          </ErrorBoundary>
        ))
      ) : bannerCounts?.empty ? null : (
        // #179: the empty banner above already says it — don't repeat it.
        <p className="hint" style={{ padding: 16 }} {...(snapshot.files.length === 0 ? { "data-testid": "diff-empty" } : {})}>
          {snapshot.files.length === 0 ? "No changes to review — the diff is empty." : "No files match the filters."}
        </p>
      )}
      {gh.orphans ? (
        <div className="ghfile" data-gh-orphans="">
          <span className="hint">GitHub comments on files no longer in the diff</span>
          {gh.orphans}
        </div>
      ) : null}
    </div>
  );
}

interface FilterRow {
  key: string;
  label: string;
  checked: boolean;
  count: number;
  toggle: () => void;
}

/**
 * One icon-button filter menu (issue #184): the file-tree menu holds
 * file types only; the toolbar's second filter holds the review-state
 * rows (Reviewed, GitHub comments). Checked = shown.
 */
function FilterMenuButton({
  label,
  tip,
  icon,
  rows,
}: {
  label: string;
  /** Action-only tooltip (#225); the active state is the dot + accent. */
  tip: string;
  icon: "filter";
  rows: FilterRow[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ctlRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = rows.some((r) => !r.checked);
  const itemCount = rows.length;

  // The menu renders in a portal at the top layer, positioned from its
  // button and clamped into the viewport: the pinned toolbar scrolls
  // sideways (overflow), which used to clip it at the pane edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const btn = btnRef.current;
      const menu = menuRef.current;
      if (!btn || !menu) return;
      const br = btn.getBoundingClientRect();
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      const left = Math.max(8, Math.min(br.right - w, window.innerWidth - w - 8));
      const top = br.bottom + h + 8 <= window.innerHeight ? br.bottom + 4 : Math.max(8, br.top - h - 4);
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open ]);

  // Close on outside press or Escape, like the other dropdowns
  // (SecondOpinionControl, CommentsMenu).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      const n = e.target as Node;
      if (!ctlRef.current?.contains(n) && !menuRef.current?.contains(n)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  // Focus the first row on open so Arrow keys work immediately; Esc
  // returns focus to the button above.
  useEffect(() => {
    if (open && pos) (itemRefs.current[0] ?? menuRef.current?.querySelector("button"))?.focus();
  }, [open, pos]);

  const move = (dir: 1 | -1): void => {
    const el = document.activeElement as HTMLElement | null;
    const at = itemRefs.current.findIndex((b) => b === el);
    const next = at < 0 ? (dir === 1 ? 0 : itemCount - 1) : (at + dir + itemCount) % itemCount;
    itemRefs.current[next]?.focus();
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className="fmenu portal"
      role="menu"
      aria-label={label}
      style={pos ? { position: "fixed", top: pos.top, left: pos.left } : { position: "fixed", visibility: "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          itemRefs.current[0]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          itemRefs.current[itemCount - 1]?.focus();
        }
      }}
    >
      {rows.map((r, i) => (
        <button
          key={r.key}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          role="menuitemcheckbox"
          aria-checked={r.checked}
          onClick={r.toggle}
        >
          <span className="tick" aria-hidden="true">
            {r.checked ? "✓" : ""}
          </span>
          <span className="lbl">{r.label}</span>
          <span className="cnt">{r.count}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <span className="fctl" ref={ctlRef}>
      <Button
        ref={btnRef}
        variant="secondary"
        size="sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active}
        aria-label={label}
        data-tip={tip}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={icon} />
        {active ? <span className="fdot" data-filter-active="" aria-hidden="true" /> : null}
      </Button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}

/** Middle-shortened path label (#227): head ellipsises, tail stays. */
function PathTail({ text }: { text: string }): ReactNode {
  const parts = tailPathParts(text);
  return (
    <>
      {parts.pre ? <span className="nm-pre">{parts.pre}</span> : null}
      <span className="nm-end">{parts.end}</span>
    </>
  );
}

function FileTreeRow({
  file,
  depth,
  reviewed,
  onJump,
}: {
  file: ReviewFile;
  depth: number;
  reviewed: number;
  onJump: (fileKey: string) => void;
}): ReactNode {
  const total = file.hunks.length;
  const added = file.hunks.reduce((s, h) => s + h.added, 0);
  const removed = file.hunks.reduce((s, h) => s + h.removed, 0);
  return (
    <div className="fr file" title={file.path}>
      <button
        className="fr-main"
        type="button"
        style={{ paddingLeft: depth * 14 + 20 }}
        onClick={() => onJump(file.fileKey)}
      >
        <span className="nm">{file.path.split("/").pop()}</span>
        {file.category === "generated" ? <span className="gtag">gen</span> : null}
      </button>
      <DiffStat added={added} removed={removed} />
      <span className={`rv${reviewed === total ? " done" : ""}`}>{reviewed === total ? "✓" : `${reviewed}/${total}`}</span>
    </div>
  );

}
