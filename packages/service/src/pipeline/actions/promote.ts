/**
 * `promote` action ("Open as page", PRD §4.7).
 *
 * Moves a conversation's content to a new page — one card per answer
 * (issue #136: an answer and a page card share the content body, so each
 * answer becomes an independently controllable card). The first card is
 * titled with the quoted text, later ones with their questions. The new
 * page is parented to the current page for the trail; the anchor becomes
 * a link to that page.
 *
 * Issue #152: opening as a page never discards work. An active fill job
 * is NOT cancelled: the turns stay on the link annotation as the fill's
 * state owner (with the card's session), each moved turn maps to its page
 * card (`promotedTurns`), and the fill mirrors finished blocks onto the
 * mapped card until it settles. The page shows the usual working state
 * (the job is re-targeted at the page card) and the error-with-Retry
 * state (resolved through the mapping) until then. Turns are dropped —
 * and the session closed — once every moved turn has settled
 * successfully. Second opinions move to the page with the content, so
 * nothing a reader made is lost.
 */
import { randomBytes } from "node:crypto";
import type { Annotation, Block, Card } from "@unvibe/shared";
import { findBlock } from "../../interaction/index.js";
import { getSnapshotOrThrow, type ActionContext } from "./common.js";
import { isTurnUnsettled } from "./conversation.js";

export async function promoteAction(
  ctx: ActionContext,
  annotationId: string,
): Promise<{ annotationId: string; pageId: string }> {
  const { reviews, reviewId } = ctx;
  const snapshot = getSnapshotOrThrow(reviews, reviewId);
  const found = snapshot.annotations.find((a) => a.id === annotationId);
  if (!found) throw new Error(`unknown annotation ${annotationId}`);
  if (found.type !== "conversation" || !found.turns) {
    throw new Error(`annotation ${annotationId} is not a conversation`);
  }
  // The fill keeps running: no cancel here (issue #152).

  // Parent for the trail: the page hosting the anchor block, else root.
  let parent = "root";
  if (found.anchor.host.kind === "block") {
    const located = findBlock(snapshot, found.anchor.host.blockId);
    if (located?.pageId) parent = located.pageId;
  }
  const quote = found.anchor.quotedText;
  const title = quote.length > 60 ? `${quote.slice(0, 58)}…` : quote || "(untitled)";
  const pageId = `p-${randomBytes(4).toString("hex")}`;
  // Pre-assign the page-card ids so the live fill job can be re-targeted
  // at its card inside the same mutate.
  const cardIds = found.turns.map(() => `c-${randomBytes(4).toString("hex")}`);
  const unsettled = found.turns.some(isTurnUnsettled);
  // The live fill job (if any) moves to its page card with the content.
  const filling = found.turns.find((t) => t.jobId !== undefined);
  const fillingCardId = filling ? cardIds[found.turns.indexOf(filling)] : undefined;
  const fillingJobId = filling?.jobId ?? found.jobId;

  await reviews.mutate(reviewId, (draft) => {
    const ann = (draft.annotations as unknown as Annotation[]).find((a) => a.id === annotationId);
    if (!ann || ann.type !== "conversation" || !ann.turns) throw new Error(`unknown conversation ${annotationId}`);
    const cards: Card[] = ann.turns.map((turn, i) => ({
      id: cardIds[i],
      pageId,
      // First card carries the quoted text, later ones their questions.
      title: i === 0 ? ann.anchor.quotedText || null : (turn.question ?? null),
      level: turn.level,
      collapsed: false,
      revision: turn.revision,
      blocks: JSON.parse(JSON.stringify(turn.blocks)) as Block[],
      undoStack: JSON.parse(JSON.stringify(turn.undoStack)) as Card["undoStack"],
      // Second opinions are reader-made results, not revisable content:
      // they move to the page with the answer (issue #152).
      ...(turn.secondOpinions ? { secondOpinions: JSON.parse(JSON.stringify(turn.secondOpinions)) as Card["secondOpinions"] } : {}),
    }));
    // A page opened from a custom guide belongs to that guide.
    const guideId = draft.pages.find((p) => p.id === parent)?.guideId;
    draft.pages.push({ id: pageId, kind: "opened-expansion", title, parent, cards, ...(guideId ? { guideId } : {}) });
    // The anchor becomes a link to the new page (prototype `link` block).
    ann.type = "link";
    ann.open = false;
    ann.promotedToPage = pageId;
    if (unsettled) {
      // The fill (or its retry) still owns these turns: keep them as the
      // state owner and mirror content onto the page cards until they
      // settle.
      ann.promotedTurns = ann.turns.map((turn, i) => ({ turnId: turn.id, cardId: cardIds[i] }));
    } else {
      ann.working = null;
      ann.error = null;
      ann.jobId = undefined;
      delete ann.turns;
    }
  });
  if (fillingJobId && fillingCardId) {
    try {
      ctx.jobs.retarget(fillingJobId, fillingCardId);
    } catch {
      // Unknown job (restart) or already settled: the page still resolves
      // the working state through the promoted-turn mapping.
    }
  }
  // The content entered the log when each turn filled (`new-card`);
  // moving it to a page adds no new shared knowledge. A turn that fills
  // after the move logs on completion like any other turn.
  return { annotationId, pageId };
}
