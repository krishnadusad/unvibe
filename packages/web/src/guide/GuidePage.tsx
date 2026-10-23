/**
 * Guide column (`/review/:id` left pane). Owner: web-guide agent.
 *
 * Loads the snapshot through the unified `api` client (in-memory `mockApi`
 * under `VITE_MOCK=1`, the real service otherwise; WS patches converge it).
 * In-app navigation keeps the page id in the URL with browser back/forward
 * working: the root lives at `/review/:id`, other pages at
 * `/review/:id/page/:pageId` (the route is `/review/:id/*`; see `App.tsx`).
 * A custom guide's root lives at `/review/:id/guide/:guideId` and its
 * child pages at `/review/:id/guide/:guideId/page/:pageId`
 * (`customGuideRoutes.ts`); a guide page reached by a main-guide URL is
 * redirected there.
 * Listens for `unvibe:guide-block` (`{ cardId, blockId }` in `detail`,
 * sent by "Restated →" links in the description tab): opens the block's
 * page, expands its card, scrolls and highlights it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Page } from "@unvibe/shared";
import { isDocumentReview } from "@unvibe/shared";
import { api, friendlyError } from "../api/client.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { toast } from "../floating/Toast.js";
import { useReview } from "../state/store.js";
import { useReviewVersion } from "../versions/useReviewVersion.js";
import { GUIDE_BLOCK_EVENT, performAction, scrollToBlock, type GuideBlockRequest } from "./actions.js";
import { emptyGuideState } from "./guideUtils.js";
import { DocumentView } from "./DocumentView.js";
import { guidePagePath, parseGuideSplat } from "./customGuideRoutes.js";
import { CustomGuideIntro, GuideComposerPanel, GuideControls, isJustCreatedGuide, settleJustCreatedGuide, SuggestedComments } from "./CustomGuides.js";
import { PageView } from "./PageView.js";
import { Button, PaneLoading } from "../ui/index.js";
import "./guide-m2.css";

export function GuidePage({ reviewId }: { reviewId: string }) {
  const snapshot = useReview((s) => s.snapshot);
  const setSnapshot = useReview((s) => s.setSnapshot);
  const splat = useParams()["*"];
  const navigate = useNavigate();
  const location = useLocation();
  const versionParam = useReviewVersion();

  useEffect(() => {
    let cancelled = false;
    api
      .review(reviewId, versionParam)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        // Unreachable reviews keep the loading state; the shell shows it.
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, versionParam, setSnapshot]);

  const { guideId, pageId } = parseGuideSplat(splat);
  const pageKey = `${guideId ?? ""}:${pageId ?? "root"}`;
  // Guide error-state retry (issue #86, finding 14): re-enqueue the
  // unfinished pipeline stages, then converge on the fresh snapshot.
  const [retrying, setRetrying] = useState(false);
  const retryGuide = (): void => {
    setRetrying(true);
    api
      .resume(reviewId)
      .then(() => api.review(reviewId))
      .then((snap) => setSnapshot(snap))
      .catch((err: unknown) => {
        toast(`Couldn't retry the guide: ${friendlyError(err)}`);
      })
      .finally(() => setRetrying(false));
  };

  // Reader state (M4): per-page scroll position restored on back/forward.
  // Saved continuously on scroll; restored after the new page renders. The
  // page never scrolls on its own while the user reads (no scroll on
  // patches — only here, on navigation).
  const scrollPos = useRef(new Map<string, number>());
  // The page being rendered now. Leaving a page swaps its content before the
  // old listener is removed, and the browser's clamp to the new content can
  // fire one last scroll event; it must not overwrite the old page's position.
  const currentPageKey = useRef(pageKey);
  currentPageKey.current = pageKey;
  useEffect(() => {
    const el = document.getElementById("page");
    if (!el) return;
    const onScroll = (): void => {
      if (currentPageKey.current !== pageKey) return;
      scrollPos.current.set(pageKey, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pageKey]);
  useEffect(() => {
    const saved = scrollPos.current.get(pageKey);
    const el = document.getElementById("page");
    if (!el) return;
    // Restore after paint so the new page's height is committed.
    const timer = window.setTimeout(() => {
      el.scrollTop = saved ?? 0;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pageKey]);

  const onOpenPage = useCallback(
    (next: string | null) => {
      const target = next === null ? undefined : useReview.getState().snapshot?.pages.find((p) => p.id === next);
      navigate(guidePagePath(reviewId, next, target, guideId));
    },
    [navigate, reviewId, guideId],
  );

  const onJumpToCard = useCallback(
    (cardId: string) => {
      // Contents jumps expand the card when needed (PRD §4.3).
      const snap = useReview.getState().snapshot;
      const card = snap?.pages.flatMap((p) => p.cards).find((c) => c.id === cardId);
      if (card?.collapsed) {
        void performAction(reviewId, { kind: "collapse", cardId, collapsed: false });
      }
      window.setTimeout(() => {
        const el = document.getElementById(`C-${cardId}`);
        if (!el) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
      }, card?.collapsed ? 80 : 0);
    },
    [reviewId],
  );

  useEffect(() => {
    const onRequest = (e: Event): void => {
      const { cardId, blockId } = (e as CustomEvent<GuideBlockRequest>).detail;
      const current = pageId ?? (guideId ? (useReview.getState().snapshot?.guides ?? []).find((g) => g.id === guideId)?.pageId : undefined);
      scrollToBlock(onOpenPage, current ?? "root", cardId, blockId);
    };
    window.addEventListener(GUIDE_BLOCK_EVENT, onRequest);
    return () => window.removeEventListener(GUIDE_BLOCK_EVENT, onRequest);
  }, [onOpenPage, pageId, guideId]);

  // Card deep links (`/review/:id#C-<cardId>`): the snapshot loads async,
  // so poll briefly for the card element instead of relying on the
  // browser's initial-hash scroll.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!snapshot || !/^C-/.test(hash)) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ block: "start" });
        window.clearInterval(timer);
      } else if (++tries > 20) {
        window.clearInterval(timer);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [snapshot, location.hash]);

  const pages = snapshot?.pages;
  const lookupPage = useCallback(
    (id: string) => pages?.find((p) => p.id === id),
    [pages],
  );

  if (!snapshot || !pages) {
    return (
      <div className="doc pane-loading-pad">
        <PaneLoading label="Building the guide" />
      </div>
    );
  }

  // #92: async open — loading shows the shared preparing state; failed shows the error + Retry.
  // The PR title/number/author rode the create request (TopBar shows them
  // from the summary); the loading state itself carries no step label (#232).
  const ingestStatus = snapshot.ingest.status;
  if (ingestStatus === "loading") {
    return (
      <div className="doc pane-loading-pad" data-testid="review-loading">
        <PaneLoading label="Building the guide" />
      </div>
    );
  }
  if (ingestStatus === "failed") {
    const error = snapshot.ingest?.error ?? "could not open the review";
    const pr = snapshot.review.prNumber !== undefined ? `PR #${snapshot.review.prNumber}` : snapshot.review.branch;
    return <FailedOpen reviewId={reviewId} prLabel={pr} error={error} />;
  }
  if (ingestStatus === "empty") {
    const error = snapshot.ingest?.error ?? "No changes to review: the diff is empty.";
    const pr = snapshot.review.prNumber !== undefined ? `PR #${snapshot.review.prNumber}` : snapshot.review.branch;
    return <EmptyOpen reviewId={reviewId} prLabel={pr} error={error} />;
  }

  // Issue #222: a document review's left pane is the document itself.
  if (isDocumentReview(snapshot)) {
    return <DocumentView reviewId={reviewId} onOpenPage={onOpenPage} />;
  }

  // #179: a version whose diff is empty (e.g. a refresh emptied it) says
  // so here instead of the stale guide or "No guide yet / diff is ready".
  // Gated on a real multi-version state so plain no-files fixtures and
  // pipeline-error snapshots keep their own states.
  const isEmptyVersion =
    snapshot.files.every((f) => f.hunks.length === 0 && !f.isBinary) &&
    (snapshot.versionStatus?.empty === true || snapshot.review.versions.length > 1 || snapshot.version.n > 1);
  if (isEmptyVersion) {
    return (
      <EmptyVersionGuide
        versionN={snapshot.version.n}
        versionCount={snapshot.review.versions.length}
        hasGuide={pages.some((p) => p.cards.length > 0)}
      />
    );
  }

  const titleAside = <GuideControls reviewId={reviewId} activeGuideId={guideId} />;
  const belowTitle = <GuideComposerPanel reviewId={reviewId} />;
  if (guideId !== null) {
    return (
      <CustomGuidePane
        reviewId={reviewId}
        guideId={guideId}
        pageId={pageId}
        titleAside={titleAside}
        belowTitle={belowTitle}
        lookupPage={lookupPage}
        onOpenPage={onOpenPage}
        onJumpToCard={onJumpToCard}
      />
    );
  }

  // A custom guide's page reached through a main-guide URL (a comment
  // link, a citation) opens on its guide's route.
  const routed = pageId !== null ? lookupPage(pageId) : undefined;
  if (routed?.guideId) {
    return <Navigate replace to={guidePagePath(reviewId, routed.id, routed, null)} />;
  }

  const current =
    pageId === null ? (pages.find((p) => p.kind === "root") ?? pages.find((p) => !p.guideId)) : lookupPage(pageId);
  // Reviews whose guide is not built yet have no pages; the version
  // selector lives in the review bar, so it still switches here.
  if (!current && pageId === null) {
    const empty = emptyGuideState(snapshot.pipeline, snapshot.jobs ?? []);
    // #232: while the guide builds, both panes share one modest loading
    // state (indicator + short label) — no title-size heading, no stage
    // label, no commentary sentences.
    if (empty.kind === "building") {
      return (
        <div className="doc pane-loading-pad" data-testid="guide-empty" data-state="building">
          <PaneLoading label="Building the guide" />
        </div>
      );
    }
    return (
      <>
        <div className="doc" data-testid="guide-empty" data-state={empty.kind}>
          {empty.kind === "error" ? (
            <>
              <h1 className="title">Couldn't build the guide</h1>
              <p className="hint">{empty.detail}</p>
              <p>
                <Button variant="primary" type="button" disabled={retrying} onClick={retryGuide}>
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              </p>
            </>
          ) : (
            <>
              <h1 className="title">No guide yet</h1>
              <p className="hint">The guide hasn't been started for this review. The diff is ready to read.</p>
            </>
          )}
        </div>
      </>
    );
  }
  if (!current) {
    return (
      <>
        <div className="doc">
          <h1 className="title">Page not found</h1>
          <p className="hint">
            There is no page <code>{pageId}</code> in this review.{" "}
            <button type="button" className="x" onClick={() => onOpenPage(null)}>
              Back to the guide
            </button>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <ErrorBoundary
        name="guide-page"
        resetKey={`${reviewId}:${pageKey}`}
        fallback={({ reset }) => (
          <div className="doc">
            <InlineFallback message="Couldn't show the guide: something went wrong" onRetry={reset} />
          </div>
        )}
      >
        <PageView
          reviewId={reviewId}
          page={current}
          lookupPage={lookupPage}
          onOpenPage={onOpenPage}
          onJumpToCard={onJumpToCard}
          titleAside={titleAside}
          belowTitle={belowTitle}
        />
      </ErrorBoundary>
    </>
  );
}

/**
 * A custom guide's root (`pageId` null) or child page. The root shows
 * before its first card lands (working, or waiting on the reader's
 * answer) as an empty guide page with the guide's state.
 */
function CustomGuidePane({
  reviewId,
  guideId,
  pageId,
  titleAside,
  belowTitle,
  lookupPage,
  onOpenPage,
  onJumpToCard,
}: {
  reviewId: string;
  guideId: string;
  pageId: string | null;
  titleAside: ReactNode;
  belowTitle: ReactNode;
  lookupPage: (id: string) => Page | undefined;
  onOpenPage: (id: string | null) => void;
  onJumpToCard: (cardId: string) => void;
}) {
  const guide = useReview((s) => (s.snapshot?.guides ?? []).find((g) => g.id === guideId));
  const arrived = guide !== undefined;
  useEffect(() => {
    if (arrived) settleJustCreatedGuide(guideId);
  }, [arrived, guideId]);
  if (!guide) {
    if (isJustCreatedGuide(guideId)) {
      return (
        <div className="doc pane-loading-pad">
          <PaneLoading label="Starting the guide" />
        </div>
      );
    }
    return (
      <div className="doc" data-testid="guide-missing">
        <div className="title-row">
          <h1 className="title">Guide not found</h1>
          {titleAside}
        </div>
        <p className="hint">
          This custom guide is gone (it may have been deleted).{" "}
          <button type="button" className="x" onClick={() => onOpenPage(null)}>
            Back to the main guide
          </button>
        </p>
      </div>
    );
  }
  const isRoot = pageId === null || pageId === guide.pageId;
  const page: Page | undefined = isRoot
    ? (lookupPage(guide.pageId) ?? { id: guide.pageId, kind: "guide", title: guide.title, guideId: guide.id, cards: [] })
    : lookupPage(pageId);
  if (!page) {
    return (
      <div className="doc">
        <PaneLoading label="Opening the page" />
      </div>
    );
  }
  return (
    <ErrorBoundary
      name="guide-page"
      resetKey={`${reviewId}:${guideId}:${page.id}`}
      fallback={({ reset }) => (
        <div className="doc">
          <InlineFallback message="Couldn't show the guide: something went wrong" onRetry={reset} />
        </div>
      )}
    >
      <PageView
        reviewId={reviewId}
        page={page}
        lookupPage={lookupPage}
        onOpenPage={onOpenPage}
        onJumpToCard={onJumpToCard}
        guide={guide}
        titleAside={titleAside}
        belowTitle={belowTitle}
        intro={isRoot ? <CustomGuideIntro reviewId={reviewId} guide={guide} /> : undefined}
        outro={isRoot ? <SuggestedComments reviewId={reviewId} guide={guide} /> : undefined}
      />
    </ErrorBoundary>
  );
}

/** #179: the viewed version's diff is empty (a refresh emptied it). */
export function EmptyVersionGuide({
  versionN,
  versionCount,
  hasGuide,
}: {
  versionN: number;
  versionCount: number;
  hasGuide: boolean;
}) {
  return (
    <div className="doc" data-testid="guide-empty-version">
      <h1 className="title">No changes to review</h1>
      <p className="hint" data-testid="guide-empty-version-message">
        This version&apos;s diff is empty — the branch is the same as its base, so there is nothing to read in v{versionN}.
      </p>
      {versionCount > 1 ? (
        <p className="hint">
          Earlier versions are still available in the version picker above
          {hasGuide ? " — pick one to read its guide and diff" : " — pick one to read its diff"}.
        </p>
      ) : null}
    </div>
  );
}

/** #179: empty diff — nothing to review, with Retry / Remove like #92. */
export function EmptyOpen({ reviewId, prLabel, error }: { reviewId: string; prLabel: string; error: string }) {
  const setSnapshot = useReview((s) => s.setSnapshot);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const onRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const snap = await api.retryReview(reviewId);
      setSnapshot(snap);
    } catch (err) {
      setRetryError(friendlyError(err));
    } finally {
      setRetrying(false);
    }
  }, [reviewId, setSnapshot]);
  // The heading already says "No changes to review"; the body explains why.
  const reason = error.replace(/^No changes to review:\s*/i, "");
  const body = reason.charAt(0).toUpperCase() + reason.slice(1);
  return (
    <div className="doc" data-testid="review-empty">
      <h1 className="title">No changes to review</h1>
      <p className="hint" data-testid="review-empty-message">
        {body}
      </p>
      <p className="hint">{prLabel} has no diff to read, so no guide was started.</p>
      <div className="frow" style={{ gap: 8 }}>
        <Button variant="primary" type="button" disabled={retrying} onClick={() => void onRetry()}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
      {retryError ? (
        <p className="hint" role="alert">
          Couldn&apos;t retry: {retryError}
        </p>
      ) : null}
      <p className="hint">You can remove it from Reviews on the start page.</p>
    </div>
  );
}

/** #92: failed open — the error plus Retry (removing happens in Reviews). */
export function FailedOpen({ reviewId, prLabel, error }: { reviewId: string; prLabel: string; error: string }) {
  const setSnapshot = useReview((s) => s.setSnapshot);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const onRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const snap = await api.retryReview(reviewId);
      setSnapshot(snap);
    } catch (err) {
      setRetryError(friendlyError(err));
    } finally {
      setRetrying(false);
    }
  }, [reviewId, setSnapshot]);
  return (
    <div className="doc" data-testid="review-failed">
      <h1 className="title">Couldn&apos;t open {prLabel}</h1>
      <p className="hint" data-testid="review-failed-error">
        {error}
      </p>
      <div className="frow" style={{ gap: 8 }}>
        <Button variant="primary" type="button" disabled={retrying} onClick={() => void onRetry()}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
      {retryError ? (
        <p className="hint" role="alert">
          Couldn&apos;t retry: {retryError}
        </p>
      ) : null}
      <p className="hint">You can remove it from Reviews on the start page.</p>
    </div>
  );
}
