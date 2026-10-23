/**
 * PR description tab (comments owner; PRD §4.11).
 *
 * - Description HTML with stable paragraph ids (`desc:` citation targets).
 *   For a branch without a PR the service renders commit messages
 *   (`source: "commits"`, read-only). Author byline from
 *   `description.author`/`state`.
 * - Editing when the user authors an open PR (`description.editable`):
 *   in-place contenteditable body with Discard/Save; Save stores locally
 *   through `PUT …/description` and shows "Edited · goes to GitHub when
 *   you submit the review" with Revert edits. Edits keep paragraph ids so
 *   citations and annotations still resolve; while editing, the draft
 *   survives re-renders (it lives in a ref, not state).
 * - Threads sit under their paragraph (open ones render, closing leaves
 *   the highlight or a marker); selection in the description anchors to
 *   the paragraph id.
 * - "Restated →" links (`button.back[data-back]`): present in the HTML
 *   when the pipeline emits them, otherwise added here from
 *   `description.restated` (paragraph → guide block ids). They jump back
 *   to the guide block that restates the paragraph.
 *
 * The `editor` seam is kept: pass a custom `DescriptionEditor` to replace
 * the built-in contenteditable body.
 */
import type { MutableRefObject, ReactNode } from "react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Annotation } from "@unvibe/shared";
import { api, friendlyError } from "../../api/client.js";
import { clearMarks, placeAnchorSpot, retryUntilSettled, spotFromAnchor, withPreservedSelection } from "../../comments/anchor.js";
import { NewThreadComposer } from "../../comments/NewThreadComposer.js";
import { isReadOnlyVersionNow, useIsReadOnlyVersion } from "../../comments/readOnly.js";
import { showGuidePane } from "../../shell/panes.js";
import { ThreadView } from "../../comments/ThreadView.js";
import { useViewer } from "../../comments/viewer.js";
import { NEW_THREAD_EVENT, type NewThreadRequest } from "../../floating/SelectionToolbar.js";
import { toast } from "../../floating/Toast.js";
import { Icon } from "../../components/Icon.js";
import { WorkingPlaceholder } from "../../components/WorkingPlaceholder.js";
import { Button, Card } from "../../ui/index.js";
import { requestGuideBlock, performFollowUp } from "../../guide/actions.js";
import { DescriptionExpansions } from "../../guide/expansions/DescriptionExpansions.js";
import { inflightForAnchor, inflightLabel } from "../../guide/inflight.js";
import { useReview, useVisibleAnnotations } from "../../state/store.js";
import { hostLabel, recordUnplacedAnchors } from "../../guide/unplacedAnchors.js";
import { cleanEditedHtml, DescriptionEditor as DefaultEditor } from "./DescriptionEditor.js";
import { canEditDescription } from "./canEdit.js";
import { splitDescriptionHtml } from "./segments.js";

export interface DescriptionEditor {
  render(params: { html: string; onSave: (html: string) => void; onDiscard: () => void }): ReactNode;
}

interface Props {
  reviewId: string;
  editor?: DescriptionEditor;
}

function innerOfDesc(html: string): string {
  return html
    .replace(/^[\s\S]*?<div class="desc"[^>]*>/i, "")
    .replace(/<\/div>\s*$/, "");
}

function wrapDesc(inner: string): string {
  return `<div class="desc">${inner}</div>`;
}

function makeMark(threadId: string): HTMLElement {
  const mark = document.createElement("mark");
  mark.className = "anc";
  mark.dataset.thr = threadId;
  return mark;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function DescriptionView({ reviewId, editor }: Props) {
  const description = useReview((s) => s.snapshot?.description);
  const annotations = useVisibleAnnotations();
  const readOnlyVersion = useIsReadOnlyVersion();
  const viewer = useViewer();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<NewThreadRequest | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  const draftRef = useRef("");

  const displayHtml = description?.pendingHtml ?? description?.html ?? "";
  const segments = useMemo(() => splitDescriptionHtml(displayHtml), [displayHtml]);
  const descThreads = useMemo(
    () =>
      (annotations ?? []).filter(
        (a): a is Annotation => a.type === "comment" && a.anchor.host.kind === "description",
      ),
    [annotations],
  );
  const byPara = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const thread of descThreads) {
      const pid = thread.anchor.host.kind === "description" ? thread.anchor.host.paragraphId : "";
      const list = map.get(pid) ?? [];
      list.push(thread);
      map.set(pid, list);
    }
    return map;
  }, [descThreads]);
  const knownIds = useMemo(
    () => new Set(segments.map((s) => s.id).filter((id): id is string => id !== null)),
    [segments],
  );
  const orphans = useMemo(
    () =>
      descThreads.filter((t) => {
        const pid = t.anchor.host.kind === "description" ? t.anchor.host.paragraphId : "";
        return !knownIds.has(pid);
      }),
    [descThreads, knownIds],
  );

  const restated = useMemo(() => description?.restated ?? {}, [description]);

  useEffect(() => {
    const onRequest = (e: Event): void => {
      const req = (e as CustomEvent<NewThreadRequest>).detail;
      if (req.anchor.where === "comment") {
        const commentId = req.anchor.commentId;
        const comment = useReview.getState().snapshot?.annotations.find((a) => a.id === commentId);
        if (!comment || comment.anchor.host.kind !== "description") return;
        if (isReadOnlyVersionNow()) return;
        setPending(req);
        return;
      }
      if (req.anchor.where !== "description") return;
      if (isReadOnlyVersionNow()) return;
      setPending(req);
    };
    window.addEventListener(NEW_THREAD_EVENT, onRequest);
    return () => window.removeEventListener(NEW_THREAD_EVENT, onRequest);
  }, []);

  if (!description) {
    return (
      <Card variant="plain" className="desc">
        <p className="hint">No description.</p>
      </Card>
    );
  }

  const canEdit =
    canEditDescription(description, viewer === undefined ? null : viewer) && !readOnlyVersion;

  const startEditing = (): void => {
    draftRef.current = innerOfDesc(displayHtml);
    setEditing(true);
  };

  const saveEditing = (): void => {
    const cleaned = cleanEditedHtml(wrapDesc(draftRef.current));
    api
      .updateDescription(reviewId, { html: cleaned })
      .then(() => setEditing(false))
      .catch((err: unknown) => {
        toast(`Couldn't save the description: ${friendlyError(err)}`);
      });
  };

  const revertEdits = (): void => {
    api.revertDescription(reviewId).catch((err: unknown) => {
      toast(`Couldn't revert the description: ${friendlyError(err)}`);
    });
  };

  const byline =
    description.author !== undefined || description.state !== undefined
      ? `by ${description.author ?? "unknown"}${description.state ? ` · ${description.state}` : ""}`
      : null;

  return (
    <>
      {byline ? (
        <div className="dbar">
          <span className="hint">{byline}</span>
          <span className="sp" />
        </div>
      ) : null}
      {description.pendingHtml && !editing ? (
        <div className="dbar">
          <span className="hint">Edited · goes to GitHub when you submit the review</span>
          <span className="sp" />
          <button className="x" type="button" data-descrevert onClick={revertEdits}>
            Revert edits
          </button>
        </div>
      ) : null}
      {!canEdit && !editing ? (
        <div className="dbar">
          <span className="hint">
            {description.source === "commits"
              ? "This branch has no PR, so this tab shows its commit messages. Read-only."
              : "You're reviewing someone else's PR, so the description is read-only."}
          </span>
          <span className="sp" />
        </div>
      ) : null}
      {canEdit && !editing ? (
        <div className="dbar">
          <span className="sp" />
          <button className="x" type="button" data-descedit onClick={startEditing}>
            Edit description
          </button>
        </div>
      ) : null}
      {editing ? (
        <>
          <div className="dbar">
            <span className="hint">Editing the description. Type directly in the text below.</span>
            <span className="sp" />
            <Button variant="secondary" size="sm" type="button" data-descdiscard onClick={() => setEditing(false)}>
              Discard
            </Button>
            <Button variant="primary" size="sm" type="button" data-descsave onClick={saveEditing}>
              Save
            </Button>
          </div>
          {editor ? (
            <div className="desc">
              {editor.render({
                html: displayHtml,
                onSave: (next) => {
                  api
                    .updateDescription(reviewId, { html: next })
                    .then(() => setEditing(false))
                    .catch((err: unknown) => {
                      toast(`Couldn't save the description: ${friendlyError(err)}`);
                    });
                },
                onDiscard: () => setEditing(false),
              })}
            </div>
          ) : (
            <DefaultEditor html={displayHtml} draftRef={draftRef} />
          )}
        </>
      ) : (
        <DescriptionBody
          reviewId={reviewId}
          segments={segments}
          byPara={byPara}
          orphans={orphans}
          highlighted={highlighted}
          setHighlighted={setHighlighted}
          pending={pending}
          setPending={setPending}
          restated={restated}
          readOnly={readOnlyVersion}
        />
      )}
    </>
  );
}

interface BodyProps {
  reviewId: string;
  segments: ReturnType<typeof splitDescriptionHtml>;
  byPara: Map<string, Annotation[]>;
  orphans: Annotation[];
  highlighted: ReadonlySet<string>;
  setHighlighted: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  pending: NewThreadRequest | null;
  setPending: (req: NewThreadRequest | null) => void;
  /** Paragraph → guide block ids for "Restated →" links. */
  restated: Record<string, string[]>;
  readOnly: boolean;
}

const DescriptionBody = forwardRef<HTMLDivElement, BodyProps>(function DescriptionBody(
  { reviewId, segments, byPara, orphans, highlighted, setHighlighted, pending, setPending, restated, readOnly },
  ref,
) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const snapshot = useReview((s) => s.snapshot);
  const inflight = useReview((s) => s.inflight);
  const lookupPage = (id: string): import("@unvibe/shared").Page | undefined =>
    snapshot?.pages.find((p) => p.id === id);
  const onOpenPage = (pageId: string): void => {
    showGuidePane();
    navigate(`/review/${reviewId}/page/${encodeURIComponent(pageId)}`);
  };
  const onFollowUp = (cardId: string, blockId: string, index: number): void => {
    performFollowUp(reviewId, cardId, blockId, index);
  };

  // "Restated →" links from the snapshot mapping (paragraph → guide block
  // ids). Appended after the matching paragraph element; the click
  // delegation below jumps to the guide block. Re-applied whenever the
  // segments or the mapping change (re-renders wipe manual DOM).
  useEffect(() => {
    const root = innerRef.current;
    if (!root) return;
    for (const [paragraphId, blockIds] of Object.entries(restated)) {
      if (blockIds.length === 0) continue;
      let el: Element | null = null;
      try {
        el = root.querySelector(`#${CSS.escape(paragraphId)}`);
      } catch {
        continue;
      }
      if (!el || el.querySelector("button.back[data-back]")) continue;
      const btn = document.createElement("button");
      btn.className = "back";
      btn.type = "button";
      btn.setAttribute("data-back", blockIds[0]);
      btn.textContent = blockIds.length > 1 ? `Restated → (${blockIds.length})` : "Restated →";
      btn.title = "Show where the guide restates this paragraph";
      el.appendChild(btn);
    }
  }, [segments, restated]);

  // Anchor highlights: wrap each thread quote inside its paragraph body.
  // Threads whose quote is gone (or empty) fall back to the marker.
  // Idempotent (issue #15): our own thread marks are cleared first so N
  // store patches leave depth 1, inside one selection-preserving window.
  // Expansion marks (`mark.anc.ex/exl`, `a.cx.pg`) belong to
  // DescriptionExpansions and are never touched (narrow selector).
  useEffect(() => {
    const root = innerRef.current;
    if (!root) return;
    // Issue #166: retry boundedly when a paragraph body isn't there yet.
    const allIds = [...byPara.values()].flat().map((t) => t.id);
    let pending = new Set<string>(allIds);
    const retry = retryUntilSettled({ isSettled: () => pending.size === 0, repass: () => runPass(), attempts: 3, delayMs: 250, onGiveUp: () => recordGaveUp() });
    function recordGaveUp(): void {
      recordUnplacedAnchors(
        "Description threads",
        [...byPara.entries()].flatMap(([pid, threads]) => {
          let body: Element | null = null;
          try {
            body = root!.querySelector(`[data-top="${CSS.escape(pid)}"] .dseg-body`);
          } catch {
            body = null;
          }
          return threads
            .filter((t) => pending.has(t.id))
            .map((t) => ({ id: t.id, kind: t.type, host: hostLabel(t.anchor), reason: body ? ("quote-not-found" as const) : ("host-missing" as const) }));
        }),
      );
    }
    const runPass = (): void => {
      pending = new Set<string>([...byPara.values()].flat().map((t) => t.id));
      withPreservedSelection(root, () => {
        clearMarks(root, "mark.anc[data-thr]");
        const found = new Set<string>();
        for (const [pid, threads] of byPara) {
          const body = root.querySelector(`[data-top="${CSS.escape(pid)}"] .dseg-body`);
          if (!body) continue;
          for (const thread of threads) {
            if (!thread.anchor.quotedText) continue;
            if (placeAnchorSpot(body, spotFromAnchor(thread.anchor), () => makeMark(thread.id)) > 0) {
              found.add(thread.id);
              pending.delete(thread.id);
            }
          }
        }
        setHighlighted((prev: ReadonlySet<string>) => (sameSet(prev, found) ? prev : found));
      });
      if (pending.size === 0) recordUnplacedAnchors("Description threads", []);
      else retry.schedule();
    };
    const timer = window.setTimeout(runPass, 0);
    return () => {
      window.clearTimeout(timer);
      retry.cancel();
    };
  }, [byPara, segments, setHighlighted]);

  const openThread = (id: string): void => {
    if (readOnly) {
      toast("Viewing an older version · read-only");
      return;
    }
    api.updateComment(reviewId, id, { open: true }).catch((err: unknown) => {
      toast(`Couldn't open the comment: ${friendlyError(err)}`);
    });
  };

  const setRefs = (node: HTMLDivElement | null): void => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as MutableRefObject<HTMLDivElement | null>).current = node;
  };

  return (
    <Card
      variant="plain"
      className="desc"
      ref={setRefs}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest?.("mark.anc[data-thr]");
        if (mark) {
          openThread((mark as HTMLElement).dataset.thr ?? "");
          return;
        }
        // Promoted expansion page links inside the description.
        const pg = (e.target as HTMLElement).closest?.("a.cx.pg[data-node]");
        if (pg) {
          const target = (pg as HTMLElement).dataset.node ?? "";
          if (target) onOpenPage(target);
          return;
        }
        const back = (e.target as HTMLElement).closest?.("button.back[data-back]");
        if (!back) return;
        const blockId = back.getAttribute("data-back") ?? "";
        const snap = useReview.getState().snapshot;
        const card = snap?.pages
          .flatMap((p) => p.cards)
          .find((c) => c.id === blockId || c.blocks.some((b) => b.id === blockId));
        // "Restated →" jumps to the guide: bring the guide pane back when
        // only the source pane is showing (#83).
        if (card) showGuidePane();
        if (card) requestGuideBlock(card.id, blockId);
      }}
    >
      {segments.map((seg, i) => {
        const threads = (seg.id && byPara.get(seg.id)) || [];
        const open = threads.filter((t) => t.open);
        const markers = threads.filter((t) => t.messages.length > 0 && !t.open && !highlighted.has(t.id));
        const showPending =
          pending &&
          ((pending.anchor.where === "description" && pending.anchor.paragraphId === seg.id) ||
            (pending.anchor.where === "comment" &&
              threads.some((t) => t.id === (pending.anchor as { commentId: string }).commentId)));
        return (
          <div key={seg.id ?? `seg-${i}`} data-top={seg.id ?? undefined}>
            <div className="dseg-body" dangerouslySetInnerHTML={{ __html: seg.html }} />
            {markers.length > 0 ? (
              <button
                className="lk cm"
                type="button"
                data-threads={markers.map((t) => t.id).join("|")}
                aria-label={`${markers.length} comments`}
                data-tip="Show comments"
                onClick={() => markers.forEach((t) => openThread(t.id))}
              >
                <Icon name="comment" />
                {markers.length}
              </button>
            ) : null}
            {open.map((t) => (
              <div className="dann" key={t.id}>
                <ThreadView reviewId={reviewId} thread={t} readOnly={readOnly} />
              </div>
            ))}
            {seg.id ? (
              <DescriptionExpansions
                reviewId={reviewId}
                paragraphId={seg.id}
                lookupPage={lookupPage}
                onOpenPage={onOpenPage}
                onFollowUp={onFollowUp}
              />
            ) : null}
            {(() => {
              // An explain started from a selection in this paragraph shows
              // a placeholder where the expansion will land (issue #46) —
              // until the expansion itself is in the snapshot (issue #97),
              // so the two never stack.
              if (!seg.id || readOnly) return null;
              const incoming = inflightForAnchor(inflight, {
                where: "description",
                paragraphId: seg.id,
              });
              if (incoming?.kind !== "explain") return null;
              const arrived = (snapshot?.annotations ?? []).some(
                (a) =>
                  a.type === "conversation" &&
                  a.open &&
                  a.anchor.host.kind === "description" &&
                  a.anchor.host.paragraphId === seg.id,
              );
              if (arrived) return null;
              return (
                <div className="dann">
                  <WorkingPlaceholder label={inflightLabel(incoming.kind)} />
                </div>
              );
            })()}
            {showPending && pending && !readOnly ? (
              <div className="dann">
                <NewThreadComposer
              key="pending"
                  reviewId={reviewId}
                  anchor={pending.anchor}
                  quote={pending.quote}
                  kind={pending.kind}
                  initialText={pending.initialText}
                  onDiscard={() => setPending(null)}
                  onCreated={() => setPending(null)}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {orphans.filter((t) => t.open).length > 0 ? (
        <div className="dann">
          {orphans
            .filter((t) => t.open)
            .map((t) => (
              <ThreadView key={t.id} reviewId={reviewId} thread={t} readOnly={readOnly} />
            ))}
        </div>
      ) : null}
    </Card>
  );
});
