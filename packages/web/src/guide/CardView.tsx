/**
 * Card rendering (M4 interaction; PRD §4.4 display side + §8 stale state).
 *
 * Collapse chevron first (title row when collapsed); control row (depth
 * stepper with three dots, Use examples, Add diagram, Undo, Second opinion
 * with blind/check switch) wired to
 * `POST /api/reviews/:id/actions`; stale cards
 * show the cited-hunks count with an Update button; "Go deeper"
 * placeholder cards with Generate showing a plain working state. Every
 * agent-starting control sets an in-flight entry on click (dots on the
 * clicked control, conflicting controls disabled, rewrite border or
 * placeholder); the entry hands over to the snapshot job once it appears.
 * Expansions render under their block via `ExpansionCard` (open ones in
 * place; closed ones as dotted-link highlights with a footnote chip on the
 * citations line when the quote is gone); promoted links render as page-link
 * footnote chips. Corrections show as suggestions on the target card with
 * Accept/Dismiss.
 */
import type { Annotation, Card, DepthLevel, Page, Turn } from "@unvibe/shared";
import { displayCardTitle } from "@unvibe/shared";
import { Fragment } from "react";
import { GuideBlockThreads } from "../comments/GuideThreads.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../floating/Toast.js";
import { friendlyError } from "../api/client.js";
import { useReview, useVisibleAnnotations } from "../state/store.js";
import { performAction, performInsertAction, performUpdate } from "./actions.js";
import { blockThreads } from "./annotations.js";
import { BlockView } from "./BlockView.js";
import { DepthControl } from "./DepthControl.js";
import { CorrectionSuggestion } from "./expansions/CorrectionSuggestion.js";
import { ExpansionCard } from "./expansions/ExpansionCard.js";
import { expansionsForBlock } from "./expansions/ExpansionHighlights.js";
import { isClosedExpansion, isOpenExpansion, isPromotedLink } from "./expansions/expansionUtils.js";
import { busyForCard, updateKey } from "./inflight.js";
import { SecondOpinionBlock, SecondOpinionControl } from "./secondOpinion/index.js";
import { Button, Card as UiCard, CardHeader } from "../ui/index.js";

const DEPTH_ORDER: DepthLevel[] = ["simple", "standard", "deep"];

interface Props {
  reviewId: string;
  card: Card;
  lookupPage: (pageId: string) => Page | undefined;
  onOpenPage: (pageId: string) => void;
  onFollowUp: (cardId: string, blockId: string, index: number) => void;
}

function ControlButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  busy,
}: {
  icon: "down" | "right" | "bulb" | "diagram" | "undo";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** This control's action is running: dots in place of the icon. */
  busy?: boolean;
}) {
  return (
    <button
      className="ib"
      type="button"
      data-tip={busy ? "Working…" : label}
      aria-label={busy ? "Working…" : label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? (
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name={icon} />
      )}
    </button>
  );
}

/**
 * Plain processing indicator: dots plus a short fixed label. Never
 * streamed agent text, thinking text, or progress strings (issue #46).
 */
export function Working({ text }: { text: string }) {
  return (
    <div className="working" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{text}</span>
    </div>
  );
}

function runCardAction(reviewId: string, action: Parameters<typeof performAction>[1]): void {
  // performAction toasts + resyncs on failure; swallow here so callers stay
  // fire-and-forget without double toasts.
  void performAction(reviewId, action).catch(() => {});
}

/**
 * Fill state for a page card moved mid-fill (issue #152): the link
 * annotation that promoted this card keeps the unsettled turn as the
 * fill's state owner. Returns the link id (for Retry) and the turn while
 * it still carries a working flag or an error.
 */
function promotedFillFor(
  annotations: Annotation[],
  card: Card,
): { linkId: string; turn: Turn } | null {
  for (const a of annotations) {
    if (a.type !== "link" || a.promotedToPage !== card.pageId) continue;
    const mapping = (a.promotedTurns ?? []).find((m) => m.cardId === card.id);
    if (!mapping) continue;
    const turn = (a.turns ?? []).find((t) => t.id === mapping.turnId);
    if (!turn) continue;
    if ((turn.working ?? "") !== "" && turn.working !== null) return { linkId: a.id, turn };
    if ((turn.error ?? "") !== "" && turn.error !== null) return { linkId: a.id, turn };
  }
  return null;
}



export function CardView({ reviewId, card, lookupPage, onOpenPage, onFollowUp }: Props) {
  const snapshot = useReview((s) => s.snapshot);
  const jobs = snapshot?.jobs ?? [];
  const annotations = useVisibleAnnotations() ?? [];
  const inflight = useReview((s) => s.inflight);
  const contributions = snapshot?.contributions ?? [];
  const busy = busyForCard(inflight, jobs, card.id);
  const busyKind = busy?.kind;
  // A card moved mid-fill (issue #152) resolves its working/error state
  // through the promoting link until its turn settles.
  const promoted = !busy ? promotedFillFor(annotations, card) : null;

  if (card.pending) {
    // Issue #84: the title and the one-line description stay visible while
    // generating — only the Generate button gives way to the indicator,
    // which sits where the prototype puts a pending card's working state
    // (`.ui-card.pend .working`, full width under the text). Issue #49: the
    // same display title as Contents (stored title, else the pending
    // label through the shared helper, never a new rule).
    const title = displayCardTitle(card.title || card.pending.label, card.blocks);
    return (
      <UiCard as="section" variant="plain" className="pend" id={`C-${card.id}`} aria-busy={busy ? true : undefined}>
        <div className="pl">{title}</div>
        <div className="why">{card.pending.why}</div>
        {busy ? (
          <Working text={busy.label} />
        ) : (
          <button
            className="go"
            type="button"
            data-gen={card.id}
            onClick={() => runCardAction(reviewId, { kind: "generate", cardId: card.id })}
          >
            Generate
          </button>
        )}
      </UiCard>
    );
  }

  const depthIndex = DEPTH_ORDER.indexOf(card.level);
  const threadsFor = (blockId: string): Annotation[] =>
    blockThreads(annotations, card.id, blockId);

  const blocks = card.blocks.map((block) => {
    const exps = expansionsForBlock(annotations, card.id, block.id);
    const open = exps.filter(isOpenExpansion);
    // Closed expansions + promoted links whose quote is gone become footnote
    // chips on the paragraph's citations line (via BlockView → BlockMarkers);
    // the highlight passes reveal them when the mark lands nowhere.
    const footnotes = exps.filter((e) => isClosedExpansion(e) || isPromotedLink(e));
    return (
      // Fragment (not a div): prototype.css child selectors depend on
      // blocks being direct children of the section.
      <Fragment key={block.id}>
        <BlockView
          block={block}
          level={card.level}
          threads={threadsFor(block.id)}
          footnotes={footnotes}
          lookupPage={lookupPage}
          cardId={card.id}
          onOpenPage={onOpenPage}
          onFollowUp={(blockId, index) => onFollowUp(card.id, blockId, index)}
        />
        <GuideBlockThreads reviewId={reviewId} cardId={card.id} blockId={block.id} />
        {open.map((e) => (
          <ExpansionCard
            key={e.id}
            reviewId={reviewId}
            expansion={e}
            lookupPage={lookupPage}
            onOpenPage={onOpenPage}
            onFollowUp={onFollowUp}
          />
        ))}
      </Fragment>
    );
  });

  if (card.collapsed) {
    // Issue #49: the header always shows the title — the real one, else
    // the shared word-boundary fallback. No blank header row, no
    // body-prefix preview.
    const title = displayCardTitle(card.title, card.blocks);
    return (
      <UiCard as="section" variant="raised" className="collapsed" id={`C-${card.id}`}>
        <div className="chead">
          <ControlButton
            icon="right"
            label="Expand"
            onClick={() =>
              runCardAction(reviewId, { kind: "collapse", cardId: card.id, collapsed: false })
            }
          />
          {title ? <h2 className="ct">{title}</h2> : null}
        </div>
        {/* #217: an auto-written go-deeper card keeps its why-line
            while collapsed, the way its placeholder looked. */}
        {card.why ? <div className="why">{card.why}</div> : null}
      </UiCard>
    );
  }

  // While an agent action runs for this card, the conflicting controls go
  // disabled and the clicked one shows dots in place of its icon.
  const controlsBusy = busy !== null;
  const depthBusy = busyKind === "depth";
  const examplesBusy = busyKind === "examples";
  const diagramBusy = busyKind === "diagram";
  const secondOpinionBusy = busyKind === "second_opinion";
  // Issue #49: same display title as the collapsed header and Contents.
  const title = displayCardTitle(card.title, card.blocks);

  return (
    <UiCard
      as="section"
      variant="raised"
      className={busy?.rewriting ? "rewriting" : undefined}
      id={`C-${card.id}`}
      aria-busy={busy ? true : undefined}
    >
      <CardHeader className="chead">
        <ControlButton
          icon="down"
          label="Collapse"
          onClick={() =>
            runCardAction(reviewId, { kind: "collapse", cardId: card.id, collapsed: true })
          }
        />
        {title ? <h2 className="ct">{title}</h2> : null}
      </CardHeader>
      {card.stale ? (
        <div className="stale" role="status">
          <span>
            {card.staleChangedHunks ?? 0} cited{" "}
            {(card.staleChangedHunks ?? 0) === 1 ? "hunk" : "hunks"} changed
          </span>
          <button
            className="x"
            type="button"
            disabled={!!inflight[updateKey(reviewId)]}
            aria-busy={inflight[updateKey(reviewId)] ? true : undefined}
            onClick={() => performUpdate(reviewId)}
          >
            {inflight[updateKey(reviewId)] ? "Updating…" : "Update"}
          </button>
        </div>
      ) : null}
      <div className="ctl">
        <DepthControl
          level={card.level}
          disabled={controlsBusy}
          depthBusy={depthBusy}
          simplerAtLimit={depthIndex <= 0}
          onSimpler={() =>
            runCardAction(reviewId, { kind: "depth", cardId: card.id, direction: "simpler" })
          }
          onDeeper={() =>
            runCardAction(reviewId, { kind: "depth", cardId: card.id, direction: "deeper" })
          }
        />
        <ControlButton
          icon="bulb"
          label="Use examples"
          busy={examplesBusy}
          disabled={controlsBusy}
          onClick={() => performInsertAction(reviewId, card.id, "examples")}
        />
        <ControlButton
          icon="diagram"
          label="Add diagram"
          busy={diagramBusy}
          disabled={controlsBusy}
          onClick={() => performInsertAction(reviewId, card.id, "diagram")}
        />
        <ControlButton
          icon="undo"
          label="Undo"
          disabled={card.undoStack.length === 0 || controlsBusy}
          onClick={() => runCardAction(reviewId, { kind: "undo", cardId: card.id })}
        />
        <SecondOpinionControl
          reviewId={reviewId}
          card={card}
          page={lookupPage(card.pageId)}
          disabled={controlsBusy}
          busy={secondOpinionBusy}
        />
      </div>
      {busy ? <Working text={busy.label} /> : null}
      {!busy && promoted?.turn.working ? <Working text={promoted.turn.working} /> : null}
      {!busy && promoted?.turn.error ? (
        <div className="perr" role="alert">
          <span>Couldn't get an answer. Retry, or see Debug for details.</span>
          <Button
            variant="primary"
            size="sm"
            type="button"
            data-retry={promoted.turn.id}
            onClick={() =>
              performAction(reviewId, { kind: "retry", annotationId: promoted.linkId }).catch((err: unknown) => {
                toast(`Couldn't retry: ${friendlyError(err)}`);
              })
            }
          >
            Retry
          </Button>
        </div>
      ) : null}
      {blocks}
      <CorrectionSuggestion reviewId={reviewId} card={card} contributions={contributions} />
      {(card.secondOpinions ?? []).map((so) => (
        <SecondOpinionBlock
          key={so.id}
          reviewId={reviewId}
          card={card}
          result={so}
          lookupPage={lookupPage}
          onOpenPage={onOpenPage}
          onFollowUp={(cardId, blockId, index) => onFollowUp(cardId, blockId, index)}
        />
      ))}
    </UiCard>
  );
}
