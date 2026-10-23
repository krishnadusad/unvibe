/**
 * Conversation card (issue #136; PRD §4.7 + §4.4 + §4.10 + §4.15).
 *
 * One card for Explain and Ask: the card holds a list of turns, each
 * answer rendered as its own unit with the standard card controls (depth
 * stepper, Use examples, Add diagram, Undo, Second opinion) acting on
 * that answer, plus a reply box at the bottom answered in the same
 * conversation. The card itself is never submitted to GitHub and carries
 * the teal Explain look, so it stays easy to tell apart from Comments.
 *
 * Ported behaviour from `prototype.html` (not code):
 * - header: quoted text, then Open as page, Delete, Close; chevron first
 *   when collapsed, × always last;
 * - plain working state with a fixed label while a turn fills
 *   (in-flight entry, then the job); error state with Retry;
 *   "no agent configured" state;
 * - open cards stay in place when the anchor phrase is footnoted (issue
 *   #72); the header adds a muted "from an earlier wording" hint;
 * - typed text elsewhere survives: this component holds no input state
 *   outside the reply box, and preserves React keys, so other drafts are
 *   untouched.
 */
import type { Annotation, Page, Turn } from "@unvibe/shared";
import { Fragment } from "react";
import { GuideBlockThreads } from "../../comments/GuideThreads.js";
import { ReplyBox } from "../../comments/ReplyBox.js";
import { Icon } from "../../components/Icon.js";
import { toast } from "../../floating/Toast.js";
import { api, friendlyError } from "../../api/client.js";
import { useReview, useVisibleAnnotations } from "../../state/store.js";
import { performAction, performInsertAction } from "../actions.js";
import { blockThreads } from "../annotations.js";
import { BlockView } from "../BlockView.js";
import { DepthControl } from "../DepthControl.js";
import { busyForCard, busyForConversation, inflightLabel, isFollowupAnswer, type BusyState } from "../inflight.js";
import { SecondOpinionBlock, SecondOpinionControl } from "../secondOpinion/index.js";
import { conversationTurns, isAnchorStale, isNoAgentMessage, NO_AGENT_COPY } from "./expansionUtils.js";
import { expansionsForBlock } from "./ExpansionHighlights.js";
import { isClosedExpansion, isOpenExpansion, isPromotedLink } from "./expansionUtils.js";
import { useProvisionalBlocks } from "./streamedAnswer.js";
import { Button, Card, CardFooter, CardHeader } from "../../ui/index.js";

const DEPTH_ORDER = ["simple", "standard", "deep"] as const;
type Depth = (typeof DEPTH_ORDER)[number];

function ControlButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  busy,
}: {
  icon: "down" | "right" | "bulb" | "diagram" | "undo" | "trash" | "x" | "open";
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
function Working({ text }: { text: string }) {
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

function isNoAgentError(err: unknown): boolean {
  return isNoAgentMessage(err instanceof Error ? err.message : String(err));
}

interface Props {
  reviewId: string;
  expansion: Annotation;
  lookupPage: (pageId: string) => Page | undefined;
  onOpenPage: (pageId: string) => void;
  onFollowUp: (cardId: string, blockId: string, index: number) => void;
  /**
   * Ancestor card ids (#116, cycle guard). Annotations form a DAG —
   * a child always points at an already-stored host, so a cycle cannot be
   * created — but corrupt data must not recurse forever. A nested card
   * whose id is already above it renders nothing.
   */
  ancestorIds?: string[];
}

/** One answer with its own controls, blocks and second opinions. */
function AnswerView({
  reviewId,
  card,
  turn,
  isFirst,
  isLatest,
  cardBusy,
  lookupPage,
  onOpenPage,
  onFollowUp,
  ancestorIds,
}: {
  reviewId: string;
  card: Annotation;
  turn: Turn;
  isFirst: boolean;
  isLatest: boolean;
  /** Card-level busy (fills address the card; rewrites address the answer). */
  cardBusy: BusyState | null;
  lookupPage: (pageId: string) => Page | undefined;
  onOpenPage: (pageId: string) => void;
  onFollowUp: (cardId: string, blockId: string, index: number) => void;
  ancestorIds: string[];
}) {
  const snapshot = useReview((s) => s.snapshot);
  const annotations = useVisibleAnnotations() ?? [];
  const inflight = useReview((s) => s.inflight);
  const jobs = snapshot?.jobs ?? [];

  const direct = busyForCard(inflight, jobs, turn.id);
  const serverWorking = (turn.working ?? "") !== "" && turn.working !== null;
  // A fill addresses the card (thread id), so its busy lands here only
  // when this turn carries the working flag (or, before any turn does,
  // on the latest turn — issue #97).
  const showWorking = !!direct || serverWorking || (!!cardBusy && isLatest && !hasWorkingTurn(card));
  const workingLabel =
    direct?.label ??
    (serverWorking || (isLatest && !hasWorkingTurn(card)) ? (cardBusy?.label ?? fixedTurnLabel(snapshot, card, turn, isFirst)) : "Working…");
  const errorText = turn.error ?? null;
  const noAgent = isNoAgentMessage(errorText);

  const depthIndex = DEPTH_ORDER.indexOf(turn.level as Depth);
  const safeDepthIndex = depthIndex < 0 ? 1 : depthIndex;
  const undoEnabled = (turn.undoStack?.length ?? 0) > 0;

  const run = (action: Parameters<typeof performAction>[1]): void => {
    void performAction(reviewId, action).catch((err: unknown) => {
      if (isNoAgentError(err)) toast(NO_AGENT_COPY);
      else toast(`Couldn't do that: ${friendlyError(err)}`);
    });
  };

  const onRetry = (): void => {
    void performAction(reviewId, { kind: "retry", annotationId: card.id }).catch((err: unknown) => {
      if (isNoAgentError(err)) toast(NO_AGENT_COPY);
      else toast(`Couldn't retry: ${friendlyError(err)}`);
    });
  };

  const secondOpinions = turn.secondOpinions ?? [];
  const controlsBusy = direct !== null || (!!cardBusy && isLatest);
  const busyKind = direct?.kind ?? (isLatest ? cardBusy?.kind : undefined);
  const depthBusy = busyKind === "depth";
  // Controls that need the text stay off until it arrives (issue #97).
  const contentReady = turn.blocks.length > 0 && !controlsBusy;
  // Issue #126 (experiment): completed paragraphs from the live stream,
  // shown while this turn fills and replaced by the stored turn.
  const provisional = useProvisionalBlocks(card.id, turn, showWorking && !errorText);  // The latest answer shows its controls; earlier answers reveal them on
  // hover or keyboard focus (cheap layout choice, easy to change).
  const olderClass = isLatest ? "" : " ans-older";
  // A later turn's question reads as its heading; the first turn's answer
  // is headed by the card's quoted text, and a follow-up answer that only
  // repeats the header quote needs no second heading.
  const showQuestion = turn.question !== null && turn.question !== card.anchor.quotedText;
  // Issue #203: while this turn is being written (or it failed), there is
  // no answer for the toolbar to act on — show only the writing state
  // (or Retry below). A rewrite of an arrived answer keeps its toolbar.
  const awaitingAnswer = !!errorText || (showWorking && (serverWorking || turn.blocks.length === 0));

  return (
    <div className={`ans${olderClass}`} data-answer={turn.id}>
      {showQuestion ? <div className="ans-q">{turn.question}</div> : null}
      {awaitingAnswer ? null : (
      <div className="ctl">
        <DepthControl
          level={turn.level}
          disabled={!contentReady}
          depthBusy={depthBusy}
          simplerAtLimit={safeDepthIndex <= 0}
          onSimpler={() => run({ kind: "depth", cardId: turn.id, direction: "simpler" })}
          onDeeper={() => run({ kind: "depth", cardId: turn.id, direction: "deeper" })}
        />
        <ControlButton
          icon="bulb"
          label="Use examples"
          busy={busyKind === "examples"}
          disabled={!contentReady}
          onClick={() => performInsertAction(reviewId, turn.id, "examples")}
        />
        <ControlButton
          icon="diagram"
          label="Add diagram"
          busy={busyKind === "diagram"}
          disabled={!contentReady}
          onClick={() => performInsertAction(reviewId, turn.id, "diagram")}
        />
        <ControlButton
          icon="undo"
          label="Undo"
          disabled={!undoEnabled || controlsBusy}
          onClick={() => run({ kind: "undo", cardId: turn.id })}
        />
        <AnswerSecondOpinion
          reviewId={reviewId}
          turnId={turn.id}
          lookupPage={lookupPage}
          disabled={!contentReady}
          busy={busyKind === "second_opinion"}
        />
      </div>
      )}
      {showWorking && !errorText ? <Working text={workingLabel} /> : null}
      {noAgent ? (
        <div className="perr" role="status">
          <span>{NO_AGENT_COPY}</span>
        </div>
      ) : null}
      {errorText && !noAgent ? (
        <div className="perr" role="alert">
          <span>Couldn't get an answer. Retry, or see Debug for details.</span>
          <Button
            variant="primary"
            size="sm"
            type="button"
            data-retry={turn.id}
            disabled={controlsBusy}
            aria-busy={controlsBusy ? true : undefined}
            onClick={onRetry}
          >
            {controlsBusy ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
      <div className={`exp-b${provisional ? " streaming" : ""}`}>
        {provisional?.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            level={turn.level}
            threads={[]}
            lookupPage={lookupPage}
            cardId={turn.id}
            onOpenPage={onOpenPage}
            onFollowUp={(blockId, index) => onFollowUp(turn.id, blockId, index)}
          />
        ))}
        {provisional ? (
          <div className="stream-live" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Still writing…</span>
          </div>
        ) : null}
        {turn.blocks.map((block) => {
          // Annotations on text inside this answer render under their
          // block exactly like page-card annotations do: threads (open
          // ones plus the pending Ask/Comment composer) via
          // GuideBlockThreads, open cards as nested cards. Closed cards
          // and promoted links become footnote chips on the citations
          // line through BlockView. Recursion nests to any depth by the
          // same mechanism (one annotation per level).
          const threads = blockThreads(annotations, turn.id, block.id);
          const exps = expansionsForBlock(annotations, turn.id, block.id);
          const open = exps.filter(isOpenExpansion);
          const footnotes = exps.filter((e) => isClosedExpansion(e) || isPromotedLink(e));
          const below = [...ancestorIds, card.id];
          return (
            <Fragment key={block.id}>
              <BlockView
                block={block}
                level={turn.level}
                threads={threads}
                footnotes={footnotes}
                lookupPage={lookupPage}
                cardId={turn.id}
                onOpenPage={onOpenPage}
                onFollowUp={(blockId, index) => onFollowUp(turn.id, blockId, index)}
              />
              <GuideBlockThreads reviewId={reviewId} cardId={turn.id} blockId={block.id} />
              {open
                .filter((e) => !below.includes(e.id))
                .map((e) => (
                  <ExpansionCard
                    key={e.id}
                    reviewId={reviewId}
                    expansion={e}
                    lookupPage={lookupPage}
                    onOpenPage={onOpenPage}
                    onFollowUp={onFollowUp}
                    ancestorIds={below}
                  />
                ))}
            </Fragment>
          );
        })}
      </div>
      {(secondOpinions).map((so) => (
        <SecondOpinionBlock
          key={so.id}
          reviewId={reviewId}
          card={{ id: turn.id } as never}
          result={so}
          lookupPage={lookupPage}
          onOpenPage={onOpenPage}
          onFollowUp={(cardId, blockId, index) => onFollowUp(cardId, blockId, index)}
        />
      ))}
    </div>
  );
}

/** True when any turn of the card carries the working flag. */
function hasWorkingTurn(card: Annotation): boolean {
  return conversationTurns(card).some((t) => (t.working ?? "") !== "" && t.working !== null);
}

/** Fixed working label for a turn (never streamed text, issue #46). */
function fixedTurnLabel(
  snapshot: import("@unvibe/shared").ReviewSnapshot | null | undefined,
  card: Annotation,
  turn: Turn,
  isFirst: boolean,
): string {
  if (isFollowupAnswer(snapshot, card)) return inflightLabel("followup");
  if ((turn.blocks?.length ?? 0) > 0) return "Working…";
  if (turn.question === null) return inflightLabel("explain");
  return isFirst ? inflightLabel("ask") : inflightLabel("reply");
}

/** Full conversation card: header + one answer view per turn + reply box. */
export function ExpansionCard({ reviewId, expansion, lookupPage, onOpenPage, onFollowUp, ancestorIds }: Props) {
  const snapshot = useReview((s) => s.snapshot);
  const inflight = useReview((s) => s.inflight);

  const jobs = snapshot?.jobs ?? [];
  const turns = conversationTurns(expansion);
  if (expansion.type !== "conversation") return null;

  const stale = isAnchorStale(expansion);
  const cardBusy = busyForConversation(inflight, jobs, snapshot, expansion);
  // Issue #204: open cards are pinned inline in the flow (guide, diff and
  // description alike). There is no floating open state and no unpin;
  // floating survives only as the hover peek on a closed card's mark.

  const onPromote = (): void => {
    void api
      .action(reviewId, { kind: "promote", annotationId: expansion.id })
      .then((res) => {
        if (res.accepted && res.pageId) onOpenPage(res.pageId);
        else if (!res.accepted) toast("Not available with mock data");
      })
      .catch((err: unknown) => {
        toast(`Couldn't open as a page: ${friendlyError(err)}`);
      });
  };

  const onDelete = (): void => {
    void api
      .action(reviewId, { kind: "delete", targetId: expansion.id })
      .catch((err: unknown) => {
        toast(`Couldn't delete the explanation: ${friendlyError(err)}`);
      });
  };

  const onClose = (): void => {
    // Close only hides the card; a running job keeps filling its turn.
    void api
      .action(reviewId, { kind: "close", annotationId: expansion.id })
      .catch(() => {
        // Closed cards fall back to the comment-patch path so the
        // dotted link still appears when the actions route is unavailable.
        void api.updateComment(reviewId, expansion.id, { open: false }).catch(() => {});
      });
  };

  if (expansion.collapsed) {
    return (
      <Card
        as="section"
        variant="plain"
        className="child collapsed"
        id={`B-${expansion.id}`}
        data-expansion={expansion.id}
      >
        <CardHeader className="exp-h">
          <ControlButton icon="right" label="Expand" onClick={() => void performAction(reviewId, { kind: "collapse", cardId: expansion.id, collapsed: false }).catch(() => {})} />
          {expansion.anchor.quotedText ? <q>{expansion.anchor.quotedText}</q> : null}
          {stale ? <span className="hint">from an earlier wording</span> : null}
          <span className="sp" />
          <ControlButton icon="open" label="Open as page" onClick={onPromote} />
          <ControlButton icon="trash" label="Delete" onClick={onDelete} />
          <ControlButton icon="x" label="Close" onClick={onClose} />
        </CardHeader>
      </Card>
    );
  }

  const below = [...(ancestorIds ?? []), expansion.id];
  // Issue #203: the reply box appears only once the latest turn's answer
  // has arrived — not while it is being written, and not on a failure
  // (that turn shows Retry instead).
  const latest = turns[turns.length - 1];
  const latestAwaiting =
    !!latest &&
    (((latest.working ?? "") !== "" && latest.working !== null) ||
      !!latest.error ||
      !!expansion.error ||
      (latest.blocks.length === 0 && (!!expansion.working || !!cardBusy)));
  return (
    <Card
      as="section"
      variant="plain"
      className={`child${cardBusy?.rewriting ? " rewriting" : ""}`}
      id={`B-${expansion.id}`}
      data-expansion={expansion.id}
      aria-busy={cardBusy ? true : undefined}
    >
      <CardHeader className="exp-h">
        {expansion.anchor.quotedText ? <q>{expansion.anchor.quotedText}</q> : null}
        {stale ? <span className="hint">from an earlier wording</span> : null}
        <span className="sp" />
        <ControlButton icon="open" label="Open as page" onClick={onPromote} />
        <ControlButton icon="trash" label="Delete" onClick={onDelete} />
        <ControlButton icon="x" label="Close" onClick={onClose} />
      </CardHeader>
      {turns.map((turn, i) => (
        <AnswerView
          key={turn.id}
          reviewId={reviewId}
          card={expansion}
          turn={turn}
          isFirst={i === 0}
          isLatest={i === turns.length - 1}
          cardBusy={cardBusy}
          lookupPage={lookupPage}
          onOpenPage={onOpenPage}
          onFollowUp={onFollowUp}
          ancestorIds={below}
        />
      ))}
      {latestAwaiting ? null : (
        <CardFooter>
        <ReplyBox
          reviewId={reviewId}
          annotationId={expansion.id}
          serverReply={expansion.reply}
          placeholder="Ask a follow-up…"
          ariaLabel="Ask a follow-up"
          sendLabel="Reply"
          discardLabel="Discard"
          onSend={(text) =>
            performAction(reviewId, { kind: "reply", annotationId: expansion.id, message: text }, { toast: false })
          }
          onDiscard={() => api.updateComment(reviewId, expansion.id, { reply: null })}
        />
        </CardFooter>
      )}
    </Card>
  );
}

function AnswerSecondOpinion({
  reviewId,
  turnId,
  lookupPage,
  disabled,
  busy,
}: {
  reviewId: string;
  turnId: string;
  lookupPage: (pageId: string) => Page | undefined;
  disabled?: boolean;
  busy?: boolean;
}) {
  // Answers reuse the card control with the answer id as cardId; the
  // service resolves answer targets and stores the result on the turn so
  // depth/undo leave it attached.
  void lookupPage;
  return (
    <SecondOpinionControl
      reviewId={reviewId}
      card={{ id: turnId } as never}
      page={undefined}
      disabled={disabled}
      busy={busy}
    />
  );
}
