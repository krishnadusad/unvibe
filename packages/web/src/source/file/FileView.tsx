/**
 * File tab (#81): one opened file at its cited commit, next to Diff.
 *
 * Content comes from `GET /api/reviews/:id/file` (the `git show` source
 * `get_code` serves) in 200-line slices. The cited range is highlighted
 * — a range past the end highlights whatever part of it exists — and
 * the first cited line scrolls into view. Text selects like diff lines:
 * Explain, Ask and Comment anchor to the `code:` host and their cards
 * and threads render under the cited lines here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Page } from "@unvibe/shared";
import { api, friendlyError } from "../../api/client.js";
import { NewThreadComposer } from "../../comments/NewThreadComposer.js";
import { ThreadView } from "../../comments/ThreadView.js";
import { NEW_THREAD_EVENT, type NewThreadRequest } from "../../floating/SelectionToolbar.js";
import { toast } from "../../floating/Toast.js";
import { ExpansionCard } from "../../guide/expansions/ExpansionCard.js";
import { useVisibleAnnotations } from "../../state/store.js";
import "./file.css";

const CHUNK = 200;
const MAX_CHUNKS = 50;

interface Props {
  reviewId: string;
  path: string;
  commit: string;
  start?: number;
  end?: number;
  lookupPage: (pageId: string) => Page | undefined;
  onOpenPage: (pageId: string) => void;
  onFollowUp: (cardId: string, blockId: string, index: number) => void;
}

interface Pending {
  line: number;
  endLine?: number;
  quote: string;
  kind: "comment" | "ask";
  initialText?: string;
}

export function FileView({ reviewId, path, commit, start, end, lookupPage, onOpenPage, onFollowUp }: Props) {
  const annotations = useVisibleAnnotations();
  const [lines, setLines] = useState<string[] | null>(null);
  const [totalLines, setTotalLines] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const scrolledFor = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(null);
    setTotalLines(0);
    // A chunk past the end answers 400 with the file's real length —
    // clamp and retry once instead of failing the tab.
    const slice = async (from: number, to: number) => {
      try {
        return await api.fileSlice(reviewId, { path, commit, start: from, end: to });
      } catch (err) {
        const m = err instanceof Error ? err.message.match(/"totalLines":\s*(\d+)/) : null;
        const total = m ? Number(m[1]) : 0;
        if (total > 0 && from <= total) {
          return api.fileSlice(reviewId, { path, commit, start: from, end: total });
        }
        throw err;
      }
    };
    void (async () => {
      try {
        const first = await slice(1, CHUNK);
        if (cancelled) return;
        const all = [...first.lines];
        setTotalLines(first.totalLines);
        setLines([...all]);
        let loaded = first.end;
        let chunks = 1;
        while (loaded < first.totalLines && chunks < MAX_CHUNKS) {
          const next = await slice(loaded + 1, Math.min(first.totalLines, loaded + CHUNK));
          if (cancelled) return;
          all.push(...next.lines);
          loaded = next.end;
          chunks += 1;
          setLines([...all]);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reviewId, path, commit]);

  // Pending Ask/Comment composers for selections in this tab.
  useEffect(() => {
    const onRequest = (e: Event): void => {
      const req = (e as CustomEvent<NewThreadRequest>).detail;
      if (req.anchor.where !== "code") return;
      if (req.anchor.path !== path || req.anchor.commit !== commit) return;
      setPending({
        line: req.anchor.line,
        ...(req.anchor.endLine !== undefined ? { endLine: req.anchor.endLine } : {}),
        quote: req.quote,
        kind: req.kind,
        ...(req.initialText !== undefined ? { initialText: req.initialText } : {}),
      });
    };
    window.addEventListener(NEW_THREAD_EVENT, onRequest);
    return () => window.removeEventListener(NEW_THREAD_EVENT, onRequest);
  }, [path, commit]);

  const hlStart = start ?? 1;
  const hlEnd = Math.min(end ?? hlStart, totalLines);

  useEffect(() => {
    if (!lines || totalLines === 0) return;
    const key = `${path}@${commit}:${hlStart}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const el = document.querySelector(`[data-code-file="${CSS.escape(`${path}@${commit}`)}"] [data-code-line="${hlStart}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [lines, totalLines, path, commit, hlStart]);

  const byLine = useMemo(() => {
    const map = new Map<number, typeof annotations>();
    for (const a of annotations ?? []) {
      if (a.anchor.host.kind !== "code" || a.anchor.host.path !== path) continue;
      const at = a.anchor.host.endLine ?? a.anchor.host.line;
      const list = map.get(at) ?? [];
      list.push(a);
      map.set(at, list);
    }
    return map;
  }, [annotations, path]);

  if (error) {
    return (
      <div className="doc codefile-msg">
        <p className="hint">Couldn’t show {path}: {error}</p>
      </div>
    );
  }
  if (!lines) {
    return (
      <div className="doc codefile-msg">
        <p className="hint">Loading {path}…</p>
      </div>
    );
  }

  const fileKey = `${path}@${commit}`;
  return (
    <div className="codefile" data-code-file={fileKey} data-path={path} data-commit={commit}>
      <div className="codefile-head">
        <span className="codefile-path">{path}</span>
        <span className="codefile-commit">at {commit.slice(0, 10)}</span>
        {hlEnd >= hlStart && totalLines > 0 ? (
          <span className="codefile-range">
            lines {hlStart}–{hlEnd} of {totalLines}
          </span>
        ) : null}
      </div>
      <div className="codefile-body">
        {lines.map((text, i) => {
          const n = i + 1;
          const cited = n >= hlStart && n <= hlEnd;
          const here = byLine.get(n) ?? [];
          const openCards = here.filter((a) => a.type === "conversation" && a.open);
          const openThreads = here.filter((a) => a.type === "comment" && a.open);
          const closed = here.filter((a) => !a.open && a.type !== "link");
          return (
            <div key={n}>
              <div className={`cf-line${cited ? " cited" : ""}`} data-code-line={n}>
                <span className="cf-n">{n}</span>
                <span className="cf-c">{text === "" ? " " : text}</span>
              </div>
              {openCards.map((a) => (
                <div className="cf-slot" key={a.id}>
                  <ExpansionCard reviewId={reviewId} expansion={a} lookupPage={lookupPage} onOpenPage={onOpenPage} onFollowUp={onFollowUp} />
                </div>
              ))}
              {openThreads.map((a) => (
                <div className="cf-slot" key={a.id}>
                  <ThreadView reviewId={reviewId} thread={a} />
                </div>
              ))}
              {closed.map((a) => (
                <div className="cf-slot" key={a.id}>
                  <button
                    type="button"
                    className="cf-reopen"
                    onClick={() => {
                      api.updateComment(reviewId, a.id, { open: true, pinned: true }).catch((err: unknown) => {
                        toast(`Couldn’t open it: ${friendlyError(err)}`);
                      });
                    }}
                  >
                    {a.type === "comment" ? "Comment" : "Explanation"} on “{a.anchor.quotedText.slice(0, 60)}” — reopen
                  </button>
                </div>
              ))}
              {pending && (pending.endLine ?? pending.line) === n ? (
                <div className="cf-slot">
                  <NewThreadComposer
                    reviewId={reviewId}
                    anchor={{ where: "code", path, commit, line: pending.line, ...(pending.endLine !== undefined ? { endLine: pending.endLine } : {}) }}
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
        {totalLines > lines.length ? (
          <p className="hint codefile-more">Showing the first {lines.length} of {totalLines} lines.</p>
        ) : null}
      </div>
    </div>
  );
}
