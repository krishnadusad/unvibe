/**
 * Guide page (M2, web-guide owner; PRD §4.3, §4.9).
 *
 * Header (type label only where it matters, then the title),
 * trail, collapsible Contents box, cards, and the "Go deeper" divider
 * before pending cards. Finding pages get the rust-accent `.finding`
 * class.
 */
import { Fragment, useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Card, CustomGuide, Page, Plotline } from "@unvibe/shared";
import { DEFAULT_GUIDE_TITLE, isDefaultGuideTitle } from "@unvibe/shared";
import { api } from "../api/client.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { toast } from "../floating/Toast.js";
import { Icon } from "../components/Icon.js";
import { isLiveJobState, useReview } from "../state/store.js";
import { revealSource } from "../source/reveal.js";
import { performFollowUp } from "./actions.js";
import { CardView } from "./CardView.js";
import { guidePlotlineOf, hunkCanonicalId, plotlineRows } from "./customGuideRoutes.js";
import { contentsModel } from "./guideUtils.js";
import { Badge, Card as UiCard, ListRow } from "../ui/index.js";
import { inflightLabel } from "./inflight.js";
import { useReviewIdentity } from "../shell/reviewIdentity.js";

interface Props {
  reviewId: string;
  page: Page;
  lookupPage: (pageId: string) => Page | undefined;
  onOpenPage: (pageId: string | null) => void;
  onJumpToCard: (cardId: string) => void;
  /**
   * Custom guide this page belongs to (its root or a child page): the
   * trail stops at the guide's root, the root shows the guide's own
   * plotlines, and `intro` / `outro` frame the cards.
   */
  guide?: CustomGuide;
  /** Right end of the title row on guide-level pages (the guide picker and "New guide"). */
  titleAside?: ReactNode;
  /** Right under the title row (the New guide box when open). */
  belowTitle?: ReactNode;
  /** Between the title and Contents (a custom guide's request and state). */
  intro?: ReactNode;
  /** After the cards (a custom guide's suggested comments). */
  outro?: ReactNode;
}

/** Finding recheck status line (PRD §8): set by refresh / the update pass. */
function RecheckStatus({ page }: { page: Page }) {
  if (page.kind !== "finding") return null;
  const { needsRecheck, recheckStatus, recheckNote } = page;
  if (!needsRecheck && !recheckStatus) return null;
  const text =
    recheckStatus === "still-applies"
      ? "Rechecked · still applies"
      : recheckStatus === "resolved"
        ? "Rechecked · resolved"
        : recheckStatus === "changed"
          ? "Rechecked · changed"
          : "Cited code changed · not rechecked yet";
  return (
    <div className="meta" data-recheck={recheckStatus ?? "pending"}>
      <span>{text}</span>
      {recheckNote ? <span>{recheckNote}</span> : null}
    </div>
  );
}

/** Display form of a page title: the default shows as "Guide". */
function displayTitle(title: string): string {
  return isDefaultGuideTitle(title) ? DEFAULT_GUIDE_TITLE : title;
}

/**
 * Issue #169: the reader's plotlines — a small list between Contents and
 * the cards (the main guide's root, and each custom guide's root with
 * that guide's own plotlines). Each row jumps to its first hunk in the
 * diff; in-scope hunks no plotline claimed read as "Other".
 */
export function Plotlines({
  reviewId,
  plotlines,
  plotlineOf,
  inScope,
  guideId,
}: {
  reviewId: string;
  plotlines: Plotline[];
  /** A hunk's plotline id (absent = "other"). */
  plotlineOf: (fileKey: string, contentHash: string) => string | undefined;
  /** Hunks counted (a custom guide counts only its own); default all. */
  inScope?: (fileKey: string, contentHash: string) => boolean;
  /** Custom guide the plotlines belong to; null for the main guide. */
  guideId: string | null;
}): ReactNode {
  const files = useReview((s) => s.snapshot?.files);
  const diffFilter = useReview((s) => s.snapshot?.diffFilter);
  if (plotlines.length === 0) return null;
  const rows = plotlineRows(plotlines, files ?? [], plotlineOf, inScope);
  const sameGuide = (diffFilter?.guideId ?? null) === guideId;
  // Picking a plotline is a filter action (#190): filter the diff to
  // it and jump to its first hunk without clearing the file tree's
  // own filters. The builds-on chip (#242) picks the earlier
  // plotline the same way — it goes to that plotline.
  const pick = (plotId: string, ref: string | null): void => {
    const active = sameGuide && diffFilter?.plotline === plotId;
    const body = {
      plotline: active ? null : plotId,
      score: diffFilter?.score ?? null,
      guideId,
    };
    api
      .updateDiffFilter(reviewId, body)
      .then(() => {
        if (!active && ref) revealSource(ref, { keepFilters: true });
      })
      .catch(() => {
        toast("Couldn't save the filter");
      });
  };
  return (
    <UiCard as="section" variant="inset" className="plotlines" aria-label="Plotlines">
      <h2>Plotlines</h2>
      <ul>
        {rows.map((r) => {
          const active = sameGuide && diffFilter?.plotline === r.id;
          const clickable = r.ref !== null;
          return (
            <li key={r.id}>
              <ListRow
                className={active ? "ui-row sel" : "ui-row"}
                {...(clickable
                  ? {
                      role: "button",
                      tabIndex: 0,
                      "aria-pressed": active,
                      "data-plotpick": r.id,
                      "data-tip": active ? "Show all hunks" : `Show only ${r.name}`,
                      onClick: (e: MouseEvent) => {
                        // The click that ends a drag-selection inside the row
                        // is a copy of the text, not a pick.
                        const sel = window.getSelection();
                        if (sel && !sel.isCollapsed && e.currentTarget instanceof Node && e.currentTarget.contains(sel.anchorNode)) return;
                        pick(r.id, r.ref);
                      },
                      onKeyDown: (e: KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          pick(r.id, r.ref);
                        }
                      },
                    }
                  : {})}
                primary={<span className="plname">{r.name}</span>}
                meta={
                  <>
                    {r.desc ? <span className="pldesc">{r.desc}</span> : null}
                    {r.buildsOnId && r.buildsOnName ? (
                      <span className="plbuilds">
                        Builds on{" "}
                        <button
                          type="button"
                          className="plbuilds-chip"
                          data-buildson={r.buildsOnId}
                          data-tip={`Show only ${r.buildsOnName}`}
                          aria-label={`Show only ${r.buildsOnName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(r.buildsOnId as string, r.buildsOnRef);
                          }}
                        >
                          <Badge tone="outline">{r.buildsOnName}</Badge>
                        </button>
                      </span>
                    ) : null}
                  </>
                }
                trailing={
                  <Badge tone="outline">
                    {r.count === 0 ? "no hunks" : r.count === 1 ? "1 hunk" : `${r.count} hunks`}
                  </Badge>
                }
              />
            </li>
          );
        })}
      </ul>
    </UiCard>
  );
}

/** The main guide's plotlines (assignment rides `hunkStates`). */
function MainPlotlines({ reviewId }: { reviewId: string }): ReactNode {
  const plotlines = useReview((s) => s.snapshot?.plotlines);
  const hunkStates = useReview((s) => s.snapshot?.hunkStates);
  const plotlineOf = useMemo(() => {
    const states = new Map((hunkStates ?? []).map((st) => [st.contentHash, st.plotline]));
    return (_fileKey: string, contentHash: string): string | undefined => states.get(contentHash);
  }, [hunkStates]);
  return <Plotlines reviewId={reviewId} plotlines={plotlines ?? []} plotlineOf={plotlineOf} guideId={null} />;
}

/** A custom guide's own plotlines, counted over its hunks only. */
function GuidePlotlines({ reviewId, guide }: { reviewId: string; guide: CustomGuide }): ReactNode {
  const scope = useMemo(() => new Set(guide.hunks), [guide.hunks]);
  const plotlineOf = useCallback(
    (fileKey: string, contentHash: string) => guidePlotlineOf(guide, fileKey, contentHash),
    [guide],
  );
  const inScope = useCallback(
    (fileKey: string, contentHash: string) => scope.has(hunkCanonicalId(fileKey, contentHash)),
    [scope],
  );
  return (
    <Plotlines
      reviewId={reviewId}
      plotlines={guide.plotlines}
      plotlineOf={plotlineOf}
      inScope={inScope}
      guideId={guide.id}
    />
  );
}

export function PageView({ reviewId, page, lookupPage, onOpenPage, onJumpToCard, guide, titleAside, belowTitle, intro, outro }: Props) {
  const [tocOpen, setTocOpen] = useState(true);
  const { title: identityTitle } = useReviewIdentity(reviewId);
  const isFinding = page.kind === "finding";
  // #235: the PR title lives here on the root, using the heading's style.
  // A default-stored root ("Guide") shows the review title (PR title, else
  // branch); non-default roots and other pages keep today's display.
  const rootTitle =
    page.kind === "guide" && guide
      ? guide.title
      : page.kind === "root" && isDefaultGuideTitle(page.title)
        ? identityTitle
        : displayTitle(page.title);
  const allPages = useReview((s) => s.snapshot?.pages);
  const jobs = useReview((s) => s.snapshot?.jobs ?? []);
  const inflight = useReview((s) => s.inflight);
  const { cards, links } = contentsModel(page, lookupPage, allPages);

  // Breadcrumb back to the root (PRD §4.3 trail), following parent links.
  const trail: Page[] = [];
  {
    const seen = new Set<string>();
    let cur: Page | undefined = page;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      trail.unshift(cur);
      // A custom guide's trail stops at the guide's root page.
      cur = cur.kind !== "guide" && cur.parent ? lookupPage(cur.parent) : undefined;
    }
  }

  const eyebrow = isFinding
    ? `Agent finding · ${page.confidence ?? ""} confidence`
    : page.kind === "guide"
      ? "Custom guide"
      : "";

  const goDeeperIndex = page.cards.findIndex((c) => c.pending);

  // Concept pages are written on first open: while the `concept` action is
  // in flight (or its job runs) for an empty stub card, show a plain
  // working state with a fixed label — never streamed or progress text.
  const conceptWorking = (() => {
    if (page.kind !== "concept" && page.kind !== "opened-expansion") return null;
    const stub = page.cards[0];
    if (!stub || stub.blocks.length > 0) return null;
    const entry = inflight[page.id] ?? inflight[stub.id];
    if (entry) return inflightLabel(entry.kind);
    const job = jobs.find(
      (j) =>
        (j.cardId === stub.id || j.dedupeKey?.includes(`concept:${page.id.slice(2)}`)) &&
        isLiveJobState(j.state),
    );
    if (!job) return null;
    return inflightLabel("concept");
  })();

  const renderCard = (card: Card, index: number) => (
    // Fragment (not a div): `.doc.finding > .ui-card` and other child
    // selectors in prototype.css depend on the section being a direct child.
    // The boundary itself renders no element, and its fallback keeps the
    // card shape, so the selectors hold in both states.
    <Fragment key={card.id}>
      {index === goDeeperIndex ? <div className="divider">Go deeper</div> : null}
      <ErrorBoundary
        name="guide-card"
        resetKey={`${reviewId}:${card.id}:${card.revision ?? 0}`}
        fallback={({ reset }) => (
          <UiCard as="section" variant="raised">
            <InlineFallback message="Couldn't show this card: something went wrong" onRetry={reset} />
          </UiCard>
        )}
      >
        <CardView
          reviewId={reviewId}
          card={card}
          lookupPage={lookupPage}
          onOpenPage={(id) => onOpenPage(id)}
          onFollowUp={(cardId, blockId, i) => performFollowUp(reviewId, cardId, blockId, i)}
        />
      </ErrorBoundary>
    </Fragment>
  );

  const titleFor = (p: Page): string =>
    p.id === page.id ? rootTitle : p.kind === "root" && isDefaultGuideTitle(p.title) ? rootTitle : displayTitle(p.title);

  // Guide controls live on guide-level pages only (the main guide's root
  // and a custom guide's root), never on concept or finding pages.
  const guideLevel = page.kind === "root" || page.kind === "guide";
  return (
    <div className={`doc${isFinding ? " finding" : ""}`}>
      {trail.length > 1 ? (
        <nav className="crumbs" aria-label="Trail">
          {trail.map((p, i) =>
            i === trail.length - 1 ? (
              <span key={p.id}>{titleFor(p)}</span>
            ) : (
              <span key={p.id}>
                <button type="button" onClick={() => onOpenPage(p.id === "root" ? null : p.id)}>
                  {titleFor(p)}
                </button>
                <span> › </span>
              </span>
            ),
          )}
        </nav>
      ) : null}
      {eyebrow ? <div className={`eyebrow${isFinding ? " find" : ""}`}>{eyebrow}</div> : null}
      <div className="title-row">
        <h1 className="title">{rootTitle}</h1>
        {guideLevel ? titleAside : null}
      </div>
      {guideLevel ? belowTitle : null}
      {isFinding && page.summary ? <div className="meta">{page.summary}</div> : null}
      <RecheckStatus page={page} />
      {conceptWorking ? (
        <div className="working" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{conceptWorking}</span>
        </div>
      ) : null}
      {intro}
      {page.kind === "guide" && cards.length === 0 && links.length === 0 ? null : (
        <UiCard as="nav" variant="inset" className="toc" aria-label="Contents">
          <div className="toc-h">
            <button
              className="ib"
              type="button"
              data-tip={tocOpen ? "Hide contents" : "Show contents"}
              aria-label={tocOpen ? "Hide contents" : "Show contents"}
              data-toc=""
              onClick={() => setTocOpen((v) => !v)}
            >
              <Icon name={tocOpen ? "down" : "right"} />
            </button>
            <span>Contents</span>
          </div>
          {tocOpen ? (
            <div className="toc-g">
              <div>
                <h3>On this page</h3>
                <ul>
                  {cards.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        data-tocard={entry.id}
                        onClick={() => onJumpToCard(entry.id)}
                      >
                        <span className="tt">{entry.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {links.length ? (
                <div>
                  <h3>Linked pages</h3>
                  <ul>
                    {links.map((entry) => (
                      <li key={entry.id}>
                        <button type="button" data-node={entry.id} onClick={() => onOpenPage(entry.id)}>
                          <span className="tt">{entry.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </UiCard>
      )}
      {page.kind === "root" ? <MainPlotlines reviewId={reviewId} /> : null}
      {page.kind === "guide" && guide ? <GuidePlotlines reviewId={reviewId} guide={guide} /> : null}
      {page.cards.map(renderCard)}
      {outro}
    </div>
  );
}
