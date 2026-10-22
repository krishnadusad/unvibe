/**
 * Guide page (M2, web-guide owner; PRD §4.3, §4.9).
 *
 * Header (type label only where it matters, then the title),
 * trail, collapsible Contents box, cards, and the "Go deeper" divider
 * before pending cards. Finding pages get the rust-accent `.finding`
 * class.
 */
import { Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Card, Page, Plotline } from "@unvibe/shared";
import { DEFAULT_GUIDE_TITLE, isDefaultGuideTitle, PLOTLINE_OTHER_ID } from "@unvibe/shared";
import { api } from "../api/client.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { toast } from "../floating/Toast.js";
import { Icon } from "../components/Icon.js";
import { isLiveJobState, useReview } from "../state/store.js";
import { revealSource } from "../source/reveal.js";
import { performFollowUp } from "./actions.js";
import { CardView } from "./CardView.js";
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
 * Issue #169: the reader's plotlines on the guide root — a small list
 * between Contents and the cards. Each row jumps to its first hunk in
 * the diff; hunks no plotline claimed read as "Other".
 */
function Plotlines({ reviewId }: { reviewId: string }): ReactNode {
  const snapshot = useReview((s) => s.snapshot);
  const plotlines: Plotline[] = snapshot?.plotlines ?? [];
  if (plotlines.length === 0) return null;
  const files = snapshot?.files ?? [];
  const states = new Map((snapshot?.hunkStates ?? []).map((s) => [s.contentHash, s]));
  const firstRefOf = (plotId: string | undefined): string | null => {
    for (const f of files) {
      for (const h of f.hunks) {
        if ((states.get(h.contentHash)?.plotline ?? PLOTLINE_OTHER_ID) === (plotId ?? PLOTLINE_OTHER_ID)) {
          return `diff:${f.fileKey}:${h.newStart}`;
        }
      }
    }
    return null;
  };
  const countOf = (plotId: string | undefined): number => {
    let n = 0;
    for (const f of files) {
      for (const h of f.hunks) {
        if ((states.get(h.contentHash)?.plotline ?? PLOTLINE_OTHER_ID) === (plotId ?? PLOTLINE_OTHER_ID)) n += 1;
      }
    }
    return n;
  };
  const otherCount = countOf(undefined);
  const plotlineOf = (id: string | undefined): Plotline | undefined =>
    id === undefined ? undefined : plotlines.find((p) => p.id === id);
  const nameOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    return plotlineOf(id)?.name ?? id;
  };
  // Picking a plotline is a filter action (#190): filter the diff to
  // it and jump to its first hunk without clearing the file tree's
  // own filters. The builds-on chip (#242) picks the earlier
  // plotline the same way — it goes to that plotline.
  const pick = (plotId: string, ref: string | null): void => {
    const active = snapshot?.diffFilter?.plotline === plotId;
    const body = {
      plotline: active ? null : plotId,
      score: snapshot?.diffFilter?.score ?? null,
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
  const rows = [
    ...plotlines.map((p) => {
      const buildsOn = plotlineOf(p.buildsOn);
      return {
        id: p.id,
        name: p.name,
        desc: p.description,
        buildsOnId: buildsOn?.id,
        buildsOnName: nameOf(p.buildsOn),
        buildsOnRef: buildsOn ? firstRefOf(buildsOn.id) : null,
        count: countOf(p.id),
        ref: firstRefOf(p.id),
      };
    }),
    ...(otherCount > 0
      ? [
          {
            id: PLOTLINE_OTHER_ID,
            name: "Other",
            desc: "Hunks no plotline claimed.",
            buildsOnId: undefined as string | undefined,
            buildsOnName: undefined as string | undefined,
            buildsOnRef: null as string | null,
            count: otherCount,
            ref: firstRefOf(undefined),
          },
        ]
      : []),
  ];
  return (
    <UiCard as="section" variant="inset" className="plotlines" aria-label="Plotlines">
      <h2>Plotlines</h2>
      <ul>
        {rows.map((r) => {
          const active = snapshot?.diffFilter?.plotline === r.id;
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

export function PageView({ reviewId, page, lookupPage, onOpenPage, onJumpToCard }: Props) {
  const [tocOpen, setTocOpen] = useState(true);
  const { title: identityTitle } = useReviewIdentity(reviewId);
  const isFinding = page.kind === "finding";
  // #235: the PR title lives here on the root, using the heading's style.
  // A default-stored root ("Guide") shows the review title (PR title, else
  // branch); non-default roots and other pages keep today's display.
  const rootTitle =
    page.kind === "root" && isDefaultGuideTitle(page.title) ? identityTitle : displayTitle(page.title);
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
      cur = cur.parent ? lookupPage(cur.parent) : undefined;
    }
  }

  const eyebrow = isFinding ? `Agent finding · ${page.confidence ?? ""} confidence` : "";

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
      </div>
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
      {page.kind === "root" ? <Plotlines reviewId={reviewId} /> : null}
      {page.cards.map(renderCard)}
    </div>
  );
}
