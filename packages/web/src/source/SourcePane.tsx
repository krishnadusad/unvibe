/**
 * Source pane: `PR description` / `Diff` tabs, plus one tab per opened
 * file (#81).
 *
 * `revealSource` (see `source/diff/revealSource.ts` + `source/reveal.ts`)
 * switches tabs from anywhere: this pane listens for its window event and
 * opens the description tab for `desc:` refs, the diff tab for `diff:`/`h:`
 * refs. `openFileAtCommit` (`source/file/openFile.ts` — the entry point
 * #222 reuses) opens file tabs for `code:` refs: one tab per file at a
 * commit, each with a close button.
 */
import { isDocumentReview } from "@unvibe/shared";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDiffCommentBindings } from "../comments/DiffComments.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { performFollowUp } from "../guide/actions.js";
import { PaneLoading } from "../ui/index.js";
import { useDiffExpansionBindings } from "../guide/expansions/DiffExpansions.js";
import { showGuidePane } from "../shell/panes.js";
import { useReview, useVisibleAnnotations } from "../state/store.js";
import { DescriptionView } from "./description/DescriptionView.js";
import { descriptionPaneName } from "./description/paneName.js";
import { DiffView } from "./diff/DiffView.js";
import { REVEAL_EVENT } from "./diff/revealSource.js";
import { FileView } from "./file/FileView.js";
import { OPEN_FILE_EVENT, openFileKey, type OpenFileRequest } from "./file/openFile.js";

export type SourceTab = "desc" | "diff";

interface Props {
  reviewId: string;
  tab: SourceTab;
  onTab: (tab: SourceTab) => void;
}

export function SourcePane({ reviewId, tab, onTab }: Props) {
  const navigate = useNavigate();
  const ingestStatus = useReview((s) => s.snapshot?.ingest?.status ?? "ready");
  const pages = useReview((s) => s.snapshot?.pages);
  const lookupPage = (id: string): import("@unvibe/shared").Page | undefined =>
    pages?.find((p) => p.id === id);
  const onOpenPage = (pageId: string): void => {
    // "Open as page" from a diff expansion navigates to the guide: bring
    // the guide pane back when only the source pane is showing (#83).
    showGuidePane();
    navigate(`/review/${reviewId}/page/${encodeURIComponent(pageId)}`);
  };
  const onFollowUp = (cardId: string, blockId: string, index: number): void => {
    performFollowUp(reviewId, cardId, blockId, index);
  };
  const annotations = useVisibleAnnotations();
  const diffComments = useDiffCommentBindings(reviewId);
  const diffExpansions = useDiffExpansionBindings(reviewId, lookupPage, onOpenPage, onFollowUp);
  // A comment and a conversation card share a line's slot row: merge
  // the content instead of letting one map overwrite the other (the
  // card used to vanish when a comment landed on its line).
  const lineSlots = useMemo(() => {
    // Issue #214: a card on a comment sits under that comment, so on its
    // line the comment renders first and the card after it.
    const commentHostedKeys = new Set<string>();
    for (const a of annotations ?? []) {
      if (a.type !== "conversation" || a.anchor.host.kind !== "comment") continue;
      const commentId = a.anchor.host.commentId;
      const comment = (annotations ?? []).find((x) => x.id === commentId && x.type === "comment");
      if (comment?.anchor.host.kind === "diff-line") {
        commentHostedKeys.add(`${comment.anchor.host.fileKey}:${comment.anchor.host.line}`);
      }
    }
    const merged: Record<string, React.ReactNode> = { ...diffExpansions.lineSlots };
    for (const [key, node] of Object.entries(diffComments.lineSlots)) {
      const prev = merged[key];
      merged[key] = prev ? (
        commentHostedKeys.has(key) ? (
          <Fragment key={key}>{node}{prev}</Fragment>
        ) : (
          <Fragment key={key}>{prev}{node}</Fragment>
        )
      ) : (
        node
      );
    }
    return merged;
  }, [diffExpansions.lineSlots, diffComments.lineSlots, annotations]);
  // Line-number icons mark comment threads only (expansions use the dotted
  // link); slot rows still render for both via `lineSlots`.
  const commentedLines = diffComments.commentedLines;
  // Finding 22: branch reviews (no PR) name this tab "Commits".
  const snapshot = useReview((s) => s.snapshot);
  const [openFiles, setOpenFiles] = useState<OpenFileRequest[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  useEffect(() => {
    const onReveal = (e: Event): void => {
      const ref = (e as CustomEvent<{ ref?: unknown }>).detail?.ref;
      if (typeof ref === "string" && ref.startsWith("code:")) return;
      setActiveFile(null);
      onTab(typeof ref === "string" && ref.startsWith("desc:") ? "desc" : "diff");
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [onTab]);
  useEffect(() => {
    const onOpenFile = (e: Event): void => {
      const req = (e as CustomEvent<OpenFileRequest>).detail;
      if (!req?.path || !req?.commit) return;
      const key = openFileKey(req);
      setOpenFiles((prev) => {
        const at = prev.findIndex((f) => openFileKey(f) === key);
        if (at < 0) return [...prev, req];
        const next = [...prev];
        next[at] = req;
        return next;
      });
      setActiveFile(key);
    };
    window.addEventListener(OPEN_FILE_EVENT, onOpenFile);
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpenFile);
  }, []);
  const closeFile = (key: string): void => {
    setOpenFiles((prev) => prev.filter((f) => openFileKey(f) !== key));
    setActiveFile((cur) => (cur === key ? null : cur));
  };
  const activeReq = openFiles.find((f) => openFileKey(f) === activeFile) ?? null;
  // Issue #222: a document review's source pane holds only file tabs
  // (opened from `code:` citations in answers) — no description or diff.
  const isDocument = snapshot ? isDocumentReview(snapshot) : false;

  // #92: no diff/description/comments while loading or failed (service also
  // 409s). After all hooks so the hook order never changes. #232: while
  // the review opens, the diff pane shares the guide pane's modest loading
  // state (indicator + short label) inside the pane's normal content
  // padding — the placeholder used to sit unpadded against the left edge.
  if (ingestStatus === "loading") {
    return (
      <div className="pane-loading-pad" data-testid="diff-loading">
        <PaneLoading label="Loading the diff" />
      </div>
    );
  }
  if (ingestStatus === "failed" || ingestStatus === "empty") {
    return (
      <div className="doc">
        <p className="hint">
          {ingestStatus === "empty" ? "No diff — there are no changes to review." : "No diff — the review couldn't be opened."}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* A document with no file tab open has no tab strip either: an
          empty strip above the hint read as a stray band. */}
      {isDocument && openFiles.length === 0 ? null : (
      <div className="rstick">
        <div className="tabs" role="tablist">
          {isDocument ? null : (
            <>
              <button
                className="tab"
                role="tab"
                type="button"
                aria-selected={activeFile === null && tab === "desc"}
                onClick={() => {
                  setActiveFile(null);
                  onTab("desc");
                }}
              >
                {descriptionPaneName(snapshot)}
              </button>
              <button
                className="tab"
                role="tab"
                type="button"
                aria-selected={activeFile === null && tab === "diff"}
                onClick={() => {
                  setActiveFile(null);
                  onTab("diff");
                }}
              >
                Diff
              </button>
            </>
          )}
          {openFiles.map((f) => {
            const key = openFileKey(f);
            const name = f.path.split("/").pop() ?? f.path;
            return (
              <span key={key} className="tab file-tab">
                <button
                  className="tab"
                  role="tab"
                  type="button"
                  aria-selected={activeFile === key}
                  title={f.path}
                  onClick={() => setActiveFile(key)}
                >
                  {name}
                </button>
                <button
                  className="tab-close"
                  type="button"
                  aria-label={`Close ${f.path}`}
                  title={`Close ${f.path}`}
                  onClick={() => closeFile(key)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      </div>
      )}
      <ErrorBoundary
        name="source-pane"
        resetKey={`${reviewId}:${activeFile ?? tab}`}
        fallback={({ reset }) => (
          <InlineFallback message="Couldn't show the source pane: something went wrong" onRetry={reset} />
        )}
      >
        {activeReq ? (
          <FileView
            reviewId={reviewId}
            path={activeReq.path}
            commit={activeReq.commit}
            start={activeReq.start}
            end={activeReq.end}
            lookupPage={lookupPage}
            onOpenPage={onOpenPage}
            onFollowUp={onFollowUp}
          />
        ) : isDocument ? (
          // The diff pane's empty state (`.hint` at 16px padding) — the
          // prototype's empty-state shape, flush with no band above it.
          <p className="hint" style={{ padding: 16 }}>
            Files cited in answers open here. Context:{" "}
            {(snapshot && isDocumentReview(snapshot) ? snapshot.contextRepos : []).map((c) => c.label).join(" · ")}
          </p>
        ) : tab === "desc" ? (
          <DescriptionView reviewId={reviewId} />
        ) : (
          <DiffView
            reviewId={reviewId}
            lineSlots={lineSlots}
            commentedLines={commentedLines}
            onLineClick={diffComments.onLineClick}
            lookupPage={lookupPage}
            onOpenPage={onOpenPage}
            onFollowUp={onFollowUp}
          />
        )}
      </ErrorBoundary>
    </>
  );
}
