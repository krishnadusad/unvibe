/**
 * Custom guides in the guide pane (packages/shared/src/customGuides.ts).
 *
 * - `GuideControls`: right of the guide's heading: the guide picker
 *   ("Main guide" plus each custom guide, once one exists) and "New
 *   guide". `GuideComposerPanel`, under the heading, is the box it
 *   opens: AI-written ideas for this change as buttons, and the request.
 * - `CustomGuideIntro`: on a custom guide's root, between its title and
 *   the cards: the request conversation, scope, and the guide's state
 *   (working, a question to answer, failed, out of date), plus a small
 *   menu with Regenerate and Delete.
 * - `SuggestedComments`: the guide's suggested comments with "Mark for
 *   PR"; a marked comment leaves the guide and joins the main comments
 *   list and the Outbox.
 * - `CustomGuideSync`: keeps the store's open guide and the diff filter's
 *   `guideId` in step with the route, so the diff shows only the open
 *   guide's hunks.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Annotation, CustomGuide } from "@unvibe/shared";
import { CUSTOM_GUIDE_PROMPT_MAX } from "@unvibe/shared";
import { api, friendlyError } from "../api/client.js";
import { threadLocationLabel, threadPostText } from "../comments/threads.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../floating/Toast.js";
import { revealSource } from "../source/reveal.js";
import { useReview } from "../state/store.js";
import { Badge, Button, Card as UiCard, ListRow, Select } from "../ui/index.js";
import { guideScopeLine, parseGuideSplat } from "./customGuideRoutes.js";
import { jobLabel } from "./inflight.js";

const MAIN = "main";

/**
 * Guides created from this tab whose snapshot entry has not arrived yet
 * (the guide route shows a loading state instead of "not found").
 */
const justCreated = new Set<string>();

export function isJustCreatedGuide(guideId: string): boolean {
  return justCreated.has(guideId);
}

/** The guide reached the snapshot (or is gone): stop treating it as new. */
export function settleJustCreatedGuide(guideId: string): void {
  justCreated.delete(guideId);
}

function guidePath(reviewId: string, guideId: string | null): string {
  return guideId === null
    ? `/review/${reviewId}`
    : `/review/${reviewId}/guide/${encodeURIComponent(guideId)}`;
}

/** Short status for the switcher; empty when the guide is ready and current. */
export function guideStatusLabel(guide: Pick<CustomGuide, "status" | "stale">): string {
  switch (guide.status) {
    case "working":
      return "writing";
    case "needs-input":
      return "needs your answer";
    case "failed":
      return "failed";
    case "ready":
      return guide.stale ? "out of date" : "";
  }
}

/**
 * Request box for a new guide or an answer: one bordered box with an
 * auto-growing text area and the send controls inside it. Enter sends,
 * Shift+Enter is a newline, Escape cancels; the text is capped at
 * `CUSTOM_GUIDE_PROMPT_MAX`. Pass `value`/`onValueChange` to fill it from
 * outside (the suggestion buttons).
 */
function PromptBox({
  ariaLabel,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  value,
  onValueChange,
  focusKey,
}: {
  ariaLabel: string;
  placeholder: string;
  submitLabel: string;
  /** Resolves when sent; the box clears. Rejects to keep the text. */
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
  value?: string;
  onValueChange?: (text: string) => void;
  /** Changing it refocuses the box with the caret at the end. */
  focusKey?: number;
}): ReactNode {
  const [own, setOwn] = useState("");
  const text = value ?? own;
  const setText = onValueChange ?? setOwn;
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);
  // Grow with the text up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === "" || sending) return;
    setSending(true);
    onSubmit(trimmed)
      .then(() => setText(""))
      .catch((err: unknown) => toast(friendlyError(err)))
      .finally(() => setSending(false));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };
  const left = CUSTOM_GUIDE_PROMPT_MAX - text.length;
  return (
    <div className={`cg-box${sending ? " sending" : ""}`}>
      <textarea
        ref={ref}
        rows={2}
        aria-label={ariaLabel}
        placeholder={placeholder}
        maxLength={CUSTOM_GUIDE_PROMPT_MAX}
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="cg-box-foot">
        <span className="hint">
          {left < 200 ? `${left} characters left` : "Enter to send · Shift+Enter for a new line"}
        </span>
        {onCancel ? (
          <Button variant="quiet" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={sending || text.trim() === ""}
          onClick={send}
        >
          {sending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Whether the New guide box is open, per review (heading control + panel). */
const composerOpen = new Map<string, boolean>();
const composerListeners = new Set<() => void>();

function setComposerOpen(reviewId: string, open: boolean): void {
  composerOpen.set(reviewId, open);
  for (const l of composerListeners) l();
}

function useComposerOpen(reviewId: string): boolean {
  return useSyncExternalStore(
    (l) => {
      composerListeners.add(l);
      return () => composerListeners.delete(l);
    },
    () => composerOpen.get(reviewId) ?? false,
  );
}

/**
 * Right side of the guide's heading row: the guide picker ("Main guide"
 * plus each custom guide, once one exists) and "New guide", which opens
 * the request box under the heading.
 */
export function GuideControls({
  reviewId,
  activeGuideId,
}: {
  reviewId: string;
  activeGuideId: string | null;
}): ReactNode {
  const guides = useReview((s) => s.snapshot?.guides);
  const navigate = useNavigate();
  const open = useComposerOpen(reviewId);
  const list = guides ?? [];
  return (
    <div className="cg-controls" data-testid="guide-switcher">
      {list.length > 0 ? (
        <Select
          aria-label="Guide"
          data-testid="guide-select"
          className="cg-select"
          value={activeGuideId ?? MAIN}
          onValueChange={(v) => navigate(guidePath(reviewId, v === MAIN ? null : v))}
          options={[
            { value: MAIN, label: "Main guide" },
            ...list.map((g) => {
              const status = guideStatusLabel(g);
              return {
                value: g.id,
                label: (
                  <span className="cg-opt">
                    <span className="cg-opt-title">{g.title}</span>
                    {status ? <span className="hint"> · {status}</span> : null}
                  </span>
                ),
              };
            }),
          ]}
        />
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        type="button"
        className="cg-new"
        aria-expanded={open}
        data-tip="Ask for a focused guide over part of the change"
        onClick={() => setComposerOpen(reviewId, !open)}
      >
        + New guide
      </Button>
    </div>
  );
}

/**
 * The New guide box under the heading: AI-written ideas for this change
 * as buttons (asked for the first time the box opens on a version), and
 * the request box. A button fills the box so the request can be edited
 * before sending.
 */
export function GuideComposerPanel({ reviewId }: { reviewId: string }): ReactNode {
  const open = useComposerOpen(reviewId);
  const navigate = useNavigate();
  const suggestions = useReview((s) => s.snapshot?.guideSuggestions);
  const version = useReview((s) => s.snapshot?.version.n);
  const [text, setText] = useState("");
  const [focusKey, setFocusKey] = useState(0);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!open || version === undefined) return;
    const key = `${reviewId}:${version}`;
    if (asked.current === key) return;
    asked.current = key;
    // Ideas are written once per version; the service reuses them.
    api.suggestGuides(reviewId).catch(() => {
      // No ideas: the box still works on its own.
    });
  }, [open, reviewId, version]);
  if (!open) return null;

  const create = async (prompt: string): Promise<void> => {
    const res = await api.createGuide(reviewId, { prompt });
    justCreated.add(res.guide.id);
    setComposerOpen(reviewId, false);
    navigate(guidePath(reviewId, res.guide.id));
  };
  const current = suggestions && suggestions.version === version ? suggestions : undefined;
  return (
    <UiCard as="section" variant="inset" className="cg-panel" aria-label="New guide">
      <div className="cg-panel-h">
        <h2>New guide</h2>
        <span className="hint">A focused view of part of this change; the main guide stays as it is.</span>
      </div>
      <div className="cg-ideas" aria-label="Ideas for this change" data-testid="guide-ideas">
        {current?.status === "ready"
          ? current.items.map((item) => (
              <button
                key={item.label}
                type="button"
                className="cg-idea"
                data-tip={item.prompt}
                onClick={() => {
                  setText(item.prompt);
                  setFocusKey((k) => k + 1);
                }}
              >
                {item.label}
              </button>
            ))
          : current?.status === "failed" || !current
            ? null
            : (
                <span className="cg-ideas-loading" role="status">
                  <span className="dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  Thinking of guides for this change…
                </span>
              )}
      </div>
      <PromptBox
        ariaLabel="New guide request"
        placeholder="Describe the guide: what to include and what to look for"
        submitLabel="Create guide"
        value={text}
        onValueChange={setText}
        focusKey={focusKey}
        onSubmit={create}
        onCancel={() => setComposerOpen(reviewId, false)}
      />
    </UiCard>
  );
}

/** Regenerate / Delete menu on a custom guide (Delete asks first). */
function GuideMenu({ reviewId, guide }: { reviewId: string; guide: CustomGuide }): ReactNode {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const regenerate = (): void => {
    setOpen(false);
    regenerateGuide(reviewId, guide.id);
  };
  const remove = (): void => {
    setOpen(false);
    setConfirming(false);
    settleJustCreatedGuide(guide.id);
    api
      .deleteGuide(reviewId, guide.id)
      .then(() => navigate(`/review/${reviewId}`))
      .catch((err: unknown) => toast(`Couldn't delete the guide: ${friendlyError(err)}`));
  };
  return (
    <span className="cg-menu-wrap" ref={wrapRef}>
      <button
        className="ib"
        type="button"
        aria-label="Guide actions"
        data-tip="Guide actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(false);
        }}
      >
        <Icon name="down" />
      </button>
      {open ? (
        <div className="so-menu cg-menu" role="menu" aria-label="Guide actions">
          {confirming ? (
            <>
              <span className="hint cg-confirm">
                Delete this guide, its pages and the comments you have not marked for the PR?
              </span>
              <button type="button" role="menuitem" className="cg-danger" onClick={remove}>
                Delete guide
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={guide.status === "working"}
                onClick={regenerate}
              >
                <span>Regenerate</span>
                <span className="hint">Run the request again on the current version</span>
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirming(true)}>
                <span>Delete…</span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}

function regenerateGuide(reviewId: string, guideId: string): void {
  api.regenerateGuide(reviewId, guideId).catch((err: unknown) => {
    toast(`Couldn't regenerate the guide: ${friendlyError(err)}`);
  });
}

/** Request, scope and state of a custom guide, above its cards. */
export function CustomGuideIntro({ reviewId, guide }: { reviewId: string; guide: CustomGuide }): ReactNode {
  const job = useReview((s) =>
    guide.jobId ? s.snapshot?.jobs.find((j) => j.id === guide.jobId) : undefined,
  );
  // The open question renders with its answer box, not in the turns.
  const turns =
    guide.status === "needs-input" && guide.question !== undefined
      ? guide.turns.filter(
          (t, i) => !(i === guide.turns.length - 1 && t.who === "agent" && t.text === guide.question),
        )
      : guide.turns;
  const working = guide.status === "working";
  return (
    <div className="cg-intro" data-guide-status={guide.status}>
      <div className="cg-meta">
        <span className="meta">
          {guide.status === "ready" || guide.hunks.length > 0 ? (
            <span data-testid="guide-scope">{guideScopeLine(guide)}</span>
          ) : null}
        </span>
        <GuideMenu reviewId={reviewId} guide={guide} />
      </div>
      <ul className="cg-turns" aria-label="Request">
        {turns.map((t, i) => (
          <li key={i} className={t.who === "you" ? "you" : "agent"}>
            <span className="cg-who">{t.who === "you" ? "You" : "Agent"}</span>
            <span className="cg-text">{t.text}</span>
          </li>
        ))}
      </ul>
      {guide.scopeNote ? <p className="hint cg-scope">{guide.scopeNote}</p> : null}
      {working ? (
        <div className="working" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{job?.state === "queued" ? "Waiting for the agent…" : jobLabel("custom-guide")}</span>
        </div>
      ) : null}
      {guide.status === "needs-input" ? (
        <UiCard as="section" variant="inset" className="cg-ask" aria-label="Question from the agent">
          <p className="cg-question">{guide.question}</p>
          <PromptBox
            ariaLabel="Your answer"
            placeholder="Answer the question; Enter sends"
            submitLabel="Answer"
            onSubmit={async (answer) => {
              await api.answerGuide(reviewId, guide.id, { answer });
            }}
          />
        </UiCard>
      ) : null}
      {guide.status === "failed" ? (
        <div className="cg-notice cg-failed" role="alert">
          <span>Couldn&apos;t write this guide{guide.error ? `: ${guide.error}` : "."}</span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => regenerateGuide(reviewId, guide.id)}
          >
            Regenerate
          </Button>
        </div>
      ) : null}
      {guide.stale && guide.status === "ready" ? (
        <div className="cg-notice" role="status" data-testid="guide-stale">
          <span>Generated for version {guide.version}; the review has changed.</span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => regenerateGuide(reviewId, guide.id)}
          >
            Regenerate
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A guide's suggested comments, each with "Mark for PR". */
export function SuggestedComments({ reviewId, guide }: { reviewId: string; guide: CustomGuide }): ReactNode {
  const snapshot = useReview((s) => s.snapshot);
  const suggested = (snapshot?.annotations ?? []).filter(
    (a): a is Annotation => a.type === "comment" && a.guideId === guide.id && a.messages.length > 0,
  );
  if (suggested.length === 0) return null;
  const toggle = (a: Annotation): void => {
    // The same `post` toggle the comment thread's Outbox control uses.
    api.updateComment(reviewId, a.id, { post: !a.post }).catch((err: unknown) => {
      toast(`Couldn't update the comment: ${friendlyError(err)}`);
    });
  };
  return (
    <UiCard as="section" variant="inset" className="cg-suggested" aria-label="Suggested comments">
      <h2>Suggested comments</h2>
      <ul>
        {suggested.map((a) => {
          const host = a.anchor.host;
          const where = threadLocationLabel(snapshot, a);
          return (
            <li key={a.id} data-suggested={a.id}>
              <ListRow
                primary={
                  host.kind === "diff-line" ? (
                    <button
                      type="button"
                      className="cg-loc"
                      data-tip="Show in the diff"
                      onClick={() => revealSource(`diff:${host.fileKey}:${host.line}`)}
                    >
                      {where}
                    </button>
                  ) : (
                    <span className="cg-loc">{where}</span>
                  )
                }
                meta={<span className="cg-ctext">{threadPostText(a)}</span>}
                trailing={
                  a.post ? (
                    <Button
                      variant="quiet"
                      size="sm"
                      type="button"
                      aria-pressed={true}
                      onClick={() => toggle(a)}
                    >
                      <Badge tone="ok">Marked for PR</Badge>
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      aria-pressed={false}
                      onClick={() => toggle(a)}
                    >
                      Mark for PR
                    </Button>
                  )
                }
              />
            </li>
          );
        })}
      </ul>
    </UiCard>
  );
}

/**
 * Route → store + diff filter: the open guide decides which suggested
 * comments show, and the diff filter's `guideId` scopes the diff to its
 * hunks (cleared on the main guide). Mounted once per review route.
 */
export function CustomGuideSync({ reviewId }: { reviewId: string }): null {
  const routeGuideId = parseGuideSplat(useParams()["*"]).guideId;
  const setActiveGuide = useReview((s) => s.setActiveGuide);
  const loaded = useReview((s) => s.snapshot !== null);
  const known = useReview((s) =>
    routeGuideId ? (s.snapshot?.guides ?? []).some((g) => g.id === routeGuideId) : false,
  );
  const have = useReview((s) => s.snapshot?.diffFilter?.guideId ?? null);
  const sent = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    setActiveGuide(routeGuideId);
  }, [routeGuideId, setActiveGuide]);

  const want = routeGuideId && known ? routeGuideId : null;
  useEffect(() => {
    if (!loaded) return;
    if (want === have) {
      sent.current = undefined;
      return;
    }
    if (sent.current === want) return;
    sent.current = want;
    // Switching guides drops the plotline pick (plotline ids are per
    // guide); the score level carries over.
    api.updateDiffFilter(reviewId, { guideId: want }).catch(() => {
      sent.current = undefined;
    });
  }, [reviewId, loaded, want, have]);
  return null;
}
