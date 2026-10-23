/**
 * Comments menu (comments owner; PRD §4.8; issues #226, #236).
 *
 * Prototype behaviour + classes (`.cmenu`, `.seg`), not code:
 * - two tabs in the app's segmented control — Comments and Outbox, each
 *   with its count; opening the menu shows the Comments tab;
 * - the Comments tab holds This review and On GitHub as sections of one
 *   list, each heading with its count (owner decision A: disjoint, each
 *   thread appears once; posted threads return to This review);
 * - the Outbox tab holds the marked, unposted comments with their
 *   editable post text, followed by the Markdown export box with Copy;
 * - hierarchy: section heading (strong) → group heading such as a file
 *   (secondary; file name, path shortened from the left) → entry meta
 *   (tertiary, small) → entry text (body size, clamped to two lines);
 *   entries under a file group show only their line, not the file again;
 * - kinds at a glance: an AI-suggested tag, and the author on GitHub
 *   entries; shared ListRow + Badge components (#201/#218);
 * - the top-bar "N in Outbox" pill opens the menu on the Outbox tab;
 * - clicking an entry jumps to it (opening the thread, switching
 *   page/tab, unfolding/unhiding as needed);
 * - the Outbox section shows each marked, unposted comment with an
 *   editable draft of the text to post (saved through `PATCH …/comments`,
 *   debounced, never lost on re-render), plus the export Markdown box
 *   with a Copy button (hidden when the Outbox is empty, #223);
 * - counts on the button; it never posts.
 * - Existing PR comments already on GitHub (`existingComments`) render
 *   read-only under On GitHub, which keeps the #183 fold and show/hide
 *   behaviour under its strong section heading.
 * - Issue #222: a document review has no GitHub side at all, so the
 *   On GitHub section (and the Submit-drafts line) is hidden there.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Annotation, ExistingReviewComment, ReviewSnapshot } from "@unvibe/shared";
import { isAiSuggested, isDocumentReview, parseId } from "@unvibe/shared";
import { api, friendlyError } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../floating/Toast.js";
import { anchorMatchesBlock } from "../guide/guideUtils.js";
import { requestGuideBlock } from "../guide/actions.js";
import { REVEAL_EVENT, ensureDiffVisible } from "../source/diff/revealSource.js";
import { revealSource } from "../source/reveal.js";
import { showGuidePane } from "../shell/panes.js";
import { useReview, useVisibleAnnotations } from "../state/store.js";
import { descriptionPaneName } from "../source/description/paneName.js";
import { useIsReadOnlyVersion } from "./readOnly.js";
import { Badge, Button, ListRow } from "../ui/index.js";
import { threadPostText } from "./threads.js";
import { groupGithubComments, isOutdatedComment, requestGithubThread, type GithubThread } from "./GithubThreads.js";

const plain = (s: string): string => s.replace(/<[^>]+>/g, "");

function excerpt(thread: Annotation): string {
  const first = thread.messages[0];
  return plain(first?.text ?? "").slice(0, 140);
}

function resolveFilePath(snapshot: ReviewSnapshot, key: string): string | null {
  // Snapshots store canonical file keys (no alias map).
  return snapshot.files.find((f) => f.fileKey === key)?.path ?? null;
}

function shortDiffLabel(snapshot: ReviewSnapshot, target: string): string | null {
  const parsed = parseId(target);
  if (!parsed || parsed.kind !== "diff") return null;
  const path = resolveFilePath(snapshot, parsed.fileKey);
  const name = path?.split("/").pop() ?? parsed.fileKey;
  return parsed.start === parsed.end ? `${name}:${parsed.start}` : `${name}:${parsed.start}`;
}

function findBlockCitations(snapshot: ReviewSnapshot, blockId: string): string[] {
  for (const page of snapshot.pages ?? []) {
    for (const card of page.cards ?? []) {
      for (const block of card.blocks ?? []) {
        const b = block as { id?: string; citations?: { target: string }[] };
        if (b.id === blockId) return (b.citations ?? []).map((c) => c.target);
      }
    }
  }
  return [];
}

/** Where GitHub will show the thread (client approximation; Submit shows the backend preview). */
export function prLocationLabel(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const file = snapshot.files.find((f) => f.fileKey === host.fileKey);
    const name = file?.path.split("/").pop() ?? host.fileKey;
    return `${name}:${host.line}`;
  }
  if (host.kind === "block") {
    const hash = host.blockId.indexOf("#");
    const bare = hash >= 0 ? host.blockId.slice(hash + 1) : host.blockId;
    for (const candidate of [host.blockId, bare]) {
      const first = findBlockCitations(snapshot, candidate).find((t) => t.startsWith("diff:"));
      if (first) {
        const label = shortDiffLabel(snapshot, first);
        if (label) return label;
      }
    }
    return "General PR comment";
  }
  return "General PR comment";
}

/** Shorten a path from the left, keeping the file name visible (#226). */
export function shortenLeft(path: string, max = 42): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

/** The guide card holding a block anchor, if any. */
function guideCardOf(
  snapshot: ReviewSnapshot,
  blockId: string,
): { pageTitle: string; cardTitle: string | null; cardId: string } | null {
  const hash = blockId.indexOf("#");
  const cardPart = hash >= 0 ? blockId.slice(0, hash) : null;
  const bare = hash >= 0 ? blockId.slice(hash + 1) : blockId;
  for (const page of snapshot.pages) {
    for (const card of page.cards) {
      if (cardPart !== null && card.id === cardPart) return { pageTitle: page.title, cardTitle: card.title, cardId: card.id };
      if (card.blocks.some((b) => (b as { id?: string }).id === bare)) {
        return { pageTitle: page.title, cardTitle: card.title, cardId: card.id };
      }
    }
  }
  return null;
}

/**
 * Group heading for a local thread (#226): file paths shortened from the
 * left (file name stays visible); guide threads read like the location
 * elsewhere — "Guide › <card title>"; never the review title.
 */
export function groupLabel(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const file = snapshot.files.find((f) => f.fileKey === host.fileKey);
    return shortenLeft(file?.path ?? host.fileKey);
  }
  if (host.kind === "code") return shortenLeft(host.path);
  if (host.kind === "description") return descriptionPaneName(snapshot);
  if (host.kind === "block") {
    if (snapshot.document) return snapshot.document.title;
    const card = guideCardOf(snapshot, host.blockId);
    if (card) return card.cardTitle ? `Guide › ${card.cardTitle}` : "Guide";
  }
  return whereLabel(snapshot, thread);
}

/** Full-length group heading for the tooltip: file paths unshortened. */
export function groupTitle(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const file = snapshot.files.find((f) => f.fileKey === host.fileKey);
    return file?.path ?? host.fileKey;
  }
  if (host.kind === "code") return host.path;
  return groupLabel(snapshot, thread);
}

/** Group key: diff threads share their file; document threads their title. */
function groupKey(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const file = snapshot.files.find((f) => f.fileKey === host.fileKey);
    return `diff:${file?.path ?? host.fileKey}`;
  }
  if (host.kind === "code") return `code:${host.path}`;
  if (host.kind === "description") return "desc";
  if (host.kind === "block" && snapshot.document) return `doc:${snapshot.document.title}`;
  return `where:${whereLabel(snapshot, thread)}`;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Entry meta (tertiary, small): the line under a file group, the quote elsewhere. */
export function entryMeta(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    return host.endLine !== undefined && host.endLine !== host.line ? `:${host.line}-${host.endLine}` : `:${host.line}`;
  }
  if (host.kind === "code") {
    return host.endLine !== undefined && host.endLine !== host.line ? `:${host.line}-${host.endLine}` : `:${host.line}`;
  }
  if (host.kind === "block" && snapshot.document) {
    const bare = host.blockId.includes("#") ? host.blockId.slice(host.blockId.indexOf("#") + 1) : host.blockId;
    return `› ${bare}`;
  }
  if (host.kind === "description") {
    const quote = thread.anchor.quotedText?.trim() ?? "";
    return quote !== "" ? `“${truncate(quote, 48)}”` : `¶ ${host.paragraphId}`;
  }
  const quote = thread.anchor.quotedText?.trim() ?? "";
  return quote !== "" ? `“${truncate(quote, 48)}”` : "Guide comment";
}

/** "From …" origin for menu rows. */
export function whereLabel(snapshot: ReviewSnapshot, thread: Annotation): string {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const file = snapshot.files.find((f) => f.fileKey === host.fileKey);
    return file?.path ?? host.fileKey;
  }
  if (host.kind === "description") return descriptionPaneName(snapshot);
  // Issue #222: a document block names the document and its paragraph ID.
  if (host.kind === "block" && snapshot.document) {
    const bare = host.blockId.includes("#") ? host.blockId.slice(host.blockId.indexOf("#") + 1) : host.blockId;
    if (snapshot.document.blocks.some((b) => b.id === bare)) {
      const title = snapshot.document.title;
      return `${title.length > 34 ? `${title.slice(0, 33)}…` : title} › ${bare}`;
    }
  }
  if (host.kind === "code") return `${host.path}:${host.line}`;
  for (const page of snapshot.pages) {
    for (const card of page.cards) {
      for (const block of card.blocks) {
        const b = block as { id?: string };
        if (b.id && anchorMatchesBlock(host.kind === "block" ? host.blockId : "", card.id, b.id)) {
          const title = page.title.length > 34 ? `${page.title.slice(0, 33)}…` : page.title;
          return card.title ? `${title} › ${card.title}` : title;
        }
      }
    }
  }
  return "Guide";
}

/** Draft textarea: local state survives re-renders; saves debounce to the server. */
function DraftArea({
  reviewId,
  thread,
  readOnly,
}: {
  reviewId: string;
  thread: Annotation;
  readOnly: boolean;
}) {
  const serverDraft = thread.draft ?? threadPostText(thread);
  const [value, setValue] = useState(serverDraft);
  const timer = useRef<number | undefined>(undefined);

  // Resync only when the server value actually changes: unrelated WS
  // patches keep the same draft string, so typing is never overwritten.
  useEffect(() => {
    if (thread.draft !== undefined) setValue(thread.draft);
  }, [thread.draft]);

  // Flush an unsaved draft on unmount (e.g. closing the menu): debounced
  // saves must never be lost on re-render or close.
  const valueRef = useRef(value);
  valueRef.current = value;
  const serverRef = useRef(thread.draft);
  serverRef.current = thread.draft;
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      const current = valueRef.current;
      if (current !== serverRef.current) {
        api.updateComment(reviewId, thread.id, { draft: current }).catch(() => {});
      }
    },
    [reviewId, thread.id],
  );

  return (
    <textarea
      id={`ob-${thread.id}`}
      aria-label="Outbox draft"
      value={value}
      readOnly={readOnly}
      title={readOnly ? "Viewing an older version · read-only" : undefined}
      onChange={(e) => {
        setValue(e.target.value);
        window.clearTimeout(timer.current);
        const next = e.target.value;
        timer.current = window.setTimeout(() => {
          api.updateComment(reviewId, thread.id, { draft: next }).catch((err: unknown) => {
            toast(`Couldn't save the draft: ${friendlyError(err)}`);
          });
        }, 400);
      }}
    />
  );
}

export function CommentsMenu({ reviewId }: { reviewId: string }) {
  const snapshot = useReview((s) => s.snapshot);
  // Issue #222: a document review has no PR and no GitHub side at all.
  // One flag hides the GitHub parts of this menu (the "Already on
  // GitHub" section and the Submit-drafts line); #226's menu rework
  // honours the same flag.
  const isDocument = snapshot ? isDocumentReview(snapshot) : false;
  const readOnly = useIsReadOnlyVersion();
  const [open, setOpen] = useState(false);
  // #236: the menu has two tabs — Comments (This review + On GitHub) and
  // the Outbox. Opening the menu shows the first tab.
  const [tab, setTab] = useState<"comments" | "outbox">("comments");
  const [exportMd, setExportMd] = useState<string | null>(null);
  const [fetchedExisting, setFetchedExisting] = useState<ExistingReviewComment[] | null>(null);
  const navigate = useNavigate();
  const rootRef = useRef<HTMLSpanElement>(null);

  // Issue #136: the menu lists comments only. Conversations (Explain
  // and Ask cards) never appear here; they are found through their
  // dotted links in place.
  // Custom guides: a guide's suggested comments list only inside that
  // guide until marked for the PR (then they are in the Outbox anyway).
  const visible = useVisibleAnnotations();
  const threads = useMemo(
    () =>
      ((visible ?? []).filter(
        (a) => a.type === "comment" && (a as Annotation).messages.length > 0,
      ) as Annotation[]),
    [visible],
  );
  // Owner decision A (#226): disjoint sections — This review holds the
  // unmarked threads (posted ones return here), the Outbox the marked,
  // unposted ones. Each thread appears once.
  const thisReview = useMemo(() => threads.filter((t) => !t.post || t.postedAt), [threads]);
  const outbox = useMemo(() => threads.filter((t) => t.post && !t.postedAt), [threads]);

  interface MenuGroup {
    label: string;
    title: string;
    threads: Annotation[];
  }

  const thisGroups: MenuGroup[] = useMemo(() => {
    if (!snapshot) return [];
    const order: MenuGroup[] = [];
    const at = new Map<string, MenuGroup>();
    for (const t of thisReview) {
      const key = groupKey(snapshot, t);
      let g = at.get(key);
      if (!g) {
        g = { label: groupLabel(snapshot, t), title: groupTitle(snapshot, t), threads: [] };
        at.set(key, g);
        order.push(g);
      }
      g.threads.push(t);
    }
    return order;
  }, [snapshot, thisReview]);

  const outboxGroups: MenuGroup[] = useMemo(() => {
    if (!snapshot) return [];
    const order: MenuGroup[] = [];
    const at = new Map<string, MenuGroup>();
    for (const t of outbox) {
      const key = groupKey(snapshot, t);
      let g = at.get(key);
      if (!g) {
        g = { label: groupLabel(snapshot, t), title: groupTitle(snapshot, t), threads: [] };
        at.set(key, g);
        order.push(g);
      }
      g.threads.push(t);
    }
    return order;
  }, [snapshot, outbox]);

  // #223: export Markdown from the service (shared builder), shown in a
  // box with Copy in the Outbox section. Hidden (and unfetched) when empty.
  useEffect(() => {
    if (!open || outbox.length === 0) return;
    let cancelled = false;
    api
      .outbox(reviewId)
      .then((res) => {
        if (!cancelled) setExportMd(res.markdown);
      })
      .catch(() => {
        if (!cancelled) setExportMd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, outbox.length, reviewId, snapshot?.rev]);

  const copyExport = (): void => {
    if (exportMd === null) return;
    navigator.clipboard
      .writeText(exportMd)
      .then(() => toast("Copied the Outbox Markdown"))
      .catch(() => toast("Couldn't copy — select the text in the box instead"));
  };
  // Branch reviews have no PR number and therefore no GitHub side:
  // treat them as an empty list instead of loading forever.
  const existing = snapshot?.existingComments ?? fetchedExisting ?? (snapshot && !snapshot.review.prNumber ? [] : null);

  // Fetch read-only GitHub comments once per menu opening when the
  // snapshot doesn't carry them yet.
  useEffect(() => {
    if (!open || !snapshot || snapshot.existingComments) return;
    if (isDocumentReview(snapshot)) return;
    if (!snapshot.review.prNumber) return;
    api
      .prComments(reviewId)
      .then((res) => setFetchedExisting(res.comments))
      .catch(() => {});
  }, [open, snapshot, reviewId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open ]);

  const jump = (thread: Annotation): void => {
    const snap = useReview.getState().snapshot;
    if (!snap) return;
    setOpen(false);
    api.updateComment(reviewId, thread.id, { open: true }).catch(() => {});
    const host = thread.anchor.host;
    if (host.kind === "diff-line") {
      revealSource(`diff:${host.fileKey}:${host.line}`);
      window.setTimeout(() => {
        // The thread renders under the revealed line: keep it out from
        // behind the pinned diff rows (#132) instead of plain nearest-scroll.
        const el = document.getElementById(thread.id);
        if (el) ensureDiffVisible(el);
      }, 300);
      return;
    }
    // Issue #222: a document thread jumps to its block in the document.
    if (host.kind === "block" && snap.document) {
      const bare = host.blockId.includes("#") ? host.blockId.slice(host.blockId.indexOf("#") + 1) : host.blockId;
      if (snap.document.blocks.some((b) => b.id === bare)) {
        showGuidePane();
        navigate(`/review/${reviewId}`);
        revealSource(`doc:${bare}`);
        window.setTimeout(() => {
          document.getElementById(thread.id)?.scrollIntoView({ block: "center" });
        }, 300);
        return;
      }
    }
    if (host.kind === "description") {
      window.dispatchEvent(
        new CustomEvent(REVEAL_EVENT, { detail: { ref: `desc:${host.paragraphId}` } }),
      );
      window.setTimeout(() => {
        const el = document.getElementById(thread.id) ?? document.getElementById(host.paragraphId);
        el?.scrollIntoView({ block: "center" });
      }, 200);
      return;
    }
    // Guide thread: open its page, expand a collapsed card, scroll to it.
    // The menu now lives in the review bar, so jumping to a guide thread
    // while only the source pane is showing brings the guide back (#83).
    // Comments never anchor hunks (the service rejects them); anything
    // else here is a corrupt snapshot, not a jump target.
    if (host.kind !== "block") return;
    const holder = snap.pages
      .flatMap((p) => p.cards.map((c) => ({ page: p, card: c })))
      .find(({ card }) =>
        card.blocks.some((b) => anchorMatchesBlock(host.blockId, card.id, (b as { id: string }).id)),
      );
    if (!holder) return;
    const go = (): void => {
      showGuidePane();
      if (holder.card.collapsed) {
        api.action(reviewId, { kind: "collapse", cardId: holder.card.id, collapsed: false }).catch(() => {});
      }
      window.setTimeout(() => {
        const blockId = host.blockId.includes("#") ? host.blockId.split("#")[1] : host.blockId;
        requestGuideBlock(holder.card.id, blockId);
        window.setTimeout(() => {
          document.getElementById(thread.id)?.scrollIntoView({ block: "center" });
        }, 200);
      }, 120);
    };
    if (holder.page.kind === "root") navigate(`/review/${reviewId}`);
    else navigate(`/review/${reviewId}/page/${encodeURIComponent(holder.page.id)}`);
    go();
  };

  // Existing GitHub threads grouped by file, in fetch order (issue #168).
  // Left-shortening is for file paths only (#226); "General" stays whole.
  const githubGroups = useMemo(() => {
    if (!snapshot || !existing) return [];
    const groups = new Map<string, { label: string; title: string; threads: GithubThread[] }>();
    for (const t of groupGithubComments(existing)) {
      const full = t.root.path ?? "General";
      const g = groups.get(full) ?? {
        label: t.root.path === undefined ? "General" : shortenLeft(full),
        title: full,
        threads: [],
      };
      g.threads.push(t);
      groups.set(full, g);
    }
    return [...groups.values()];
  }, [snapshot, existing]);
  // #226: the On GitHub count is the threads shown, not the comments.
  const ghThreadCount = useMemo(() => githubGroups.reduce((n, g) => n + g.threads.length, 0), [githubGroups]);

  // Issue #183 addition: the section follows the diff's show/hide setting
  // (`showExistingComments`). Hidden collapses it to its heading with a
  // count, and clicking the heading shows them again (here and in the
  // diff). While shown, the heading's chevron folds the section alone,
  // remembered in `existingCommentsCollapsed`. #226 keeps this behaviour
  // under the strong "On GitHub" section heading.
  const ghShown = snapshot?.viewPrefs.showExistingComments ?? true;
  const ghCollapsed = snapshot?.viewPrefs.existingCommentsCollapsed ?? false;
  const ghOpen = ghShown && !ghCollapsed;
  const onGhHead = (): void => {
    const body = !ghShown
      ? { showExistingComments: true }
      : { existingCommentsCollapsed: !ghCollapsed };
    api.updateView(reviewId, body).catch(() => {
      toast("Couldn't save that change");
    });
  };

  const jumpExisting = (thread: GithubThread): void => {
    const snap = useReview.getState().snapshot;
    if (!snap) return;
    setOpen(false);
    const file = thread.root.path ? snap.files.find((f) => f.path === thread.root.path) : undefined;
    const outdated = isOutdatedComment(snap.files, thread.root);
    if (file && thread.root.line !== undefined && !outdated) {
      revealSource(`diff:${file.fileKey}:${thread.root.line}`);
    } else if (file) {
      revealSource(`diff:${file.fileKey}`);
    }
    // Expands the thread in the diff (and scrolls to it when shown).
    requestGithubThread(thread.root.id);
  };

  // #226: rows are ListRows; the div acts as the jump button.
  const rowKeys = (onJump: () => void): { role: string; tabIndex: number; onKeyDown: (e: ReactKeyboardEvent) => void } => ({
    role: "button",
    tabIndex: 0,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onJump();
      }
    },
  });

  const localRow = (thread: Annotation, withDraft: boolean): React.JSX.Element => {
    const meta = entryMeta(snapshot as ReviewSnapshot, thread);
    const go = (): void => jump(thread);
    const row = (
      <ListRow
        data-cjump={thread.id}
        onClick={go}
        {...rowKeys(go)}
        primary={excerpt(thread)}
        meta={meta.startsWith(":") ? <span className="mono">{meta}</span> : meta}
        trailing={isAiSuggested(thread) ? <Badge tone="neutral">AI-suggested</Badge> : null}
      />
    );
    if (!withDraft) return <span key={thread.id}>{row}</span>;
    return (
      <span className="cm-entry" key={thread.id}>
        {row}
        <DraftArea reviewId={reviewId} thread={thread} readOnly={readOnly} />
      </span>
    );
  };

  return (
    <span ref={rootRef} style={{ position: "relative" }}>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        data-cm=""
        aria-expanded={open}
        onClick={(e) => {
          if (open) {
            setOpen(false);
            return;
          }
          // The "N in Outbox" pill opens the menu on the Outbox tab;
          // anywhere else on the button opens the first tab (#236).
          const pill = (e.target as Element | null)?.closest?.("[data-outbox-pill]");
          setTab(pill ? "outbox" : "comments");
          setOpen(true);
        }}
      >
        <Icon name="comment" />
        Comments {threads.length}
        {outbox.length > 0 ? (
          <span data-outbox-pill="">
            <Badge tone="warn">{outbox.length} in Outbox</Badge>
          </span>
        ) : null}
      </Button>
      {open && snapshot ? (
        <div className="cmenu" role="dialog" aria-label="Comments">
          <div className="frow">
            <span className="seg" role="group" aria-label="Comments sections">
              <button
                type="button"
                data-cmtab="comments"
                aria-pressed={tab === "comments"}
                onClick={() => setTab("comments")}
              >
                Comments {thisReview.length}
              </button>
              <button
                type="button"
                data-cmtab="outbox"
                aria-pressed={tab === "outbox"}
                onClick={() => setTab("outbox")}
              >
                Outbox {outbox.length}
              </button>
            </span>
            <span className="sp" />
            <button className="ib" type="button" data-tip="Close" aria-label="Close" data-cmclose="" onClick={() => setOpen(false)}>
              <Icon name="x" />
            </button>
          </div>
          {tab === "comments" ? (
          <section data-cmsec="review" aria-label={`This review, ${thisReview.length} comments`}>
            <div className="cmsec-head">
              <strong>This review</strong> <Badge tone="neutral">{thisReview.length}</Badge>
            </div>
            {thisGroups.map((g) => (
              <div key={g.label}>
                <span className="cmgroup" title={g.title}>{g.label}</span>
                {g.threads.map((t) => localRow(t, false))}
              </div>
            ))}
            {thisReview.length === 0 ? (
              <p className="hint" style={{ margin: 4 }}>
                {threads.length === 0
                  ? "No comments yet. Select text and choose Ask or Comment."
                  : "Everything is marked in the Outbox tab."}
              </p>
            ) : null}
          </section>
          ) : null}
          {tab === "outbox" ? (
          <section data-cmsec="outbox" aria-label={`Outbox, ${outbox.length} comments`}>
            {outboxGroups.map((g) => (
              <div key={g.label}>
                <span className="cmgroup" title={g.title}>{g.label}</span>
                {g.threads.map((t) => localRow(t, true))}
              </div>
            ))}
            {outbox.length === 0 ? (
              <p className="hint" style={{ margin: 4 }}>
                Nothing in the Outbox yet. Use “Add to Outbox” on any comment.
              </p>
            ) : null}
            {outbox.length > 0 && !isDocument ? (
              <span className="hint">These are drafts. Nothing reaches GitHub until you use Submit review.</span>
            ) : null}
            {outbox.length > 0 ? (
              <div className="obbox">
                <div className="frow">
                  <span className="hint">Export</span>
                  <span className="sp" />
                  <Button variant="secondary" size="sm" type="button" data-copy-outbox="" disabled={exportMd === null} onClick={copyExport}>
                    Copy
                  </Button>
                </div>
                <pre className="obmd" data-outbox-md="">{exportMd ?? "Loading…"}</pre>
              </div>
            ) : null}
          </section>
          ) : null}
          {tab === "comments" && !isDocument ? (
          <section data-cmsec="github" aria-label={`On GitHub, ${ghThreadCount} threads`}>
            <button
              className="cmsec-head ghhead"
              type="button"
              data-ghhead=""
              aria-expanded={ghOpen}
              onClick={onGhHead}
            >
              <Icon name={ghOpen ? "down" : "right"} />
              <strong>On GitHub</strong> <Badge tone="neutral">{ghThreadCount}</Badge>
              {ghShown ? null : <span className="hint">hidden</span>}
            </button>
            {!ghOpen ? null : existing === null ? (
              <p className="hint" style={{ margin: 4 }}>
                Loading comments from GitHub…
              </p>
            ) : existing.length === 0 ? (
              <p className="hint" style={{ margin: 4 }}>
                No review comments on GitHub yet.
              </p>
            ) : (
              githubGroups.map((g) => (
                <div key={g.label}>
                  <span className="cmgroup" title={g.title}>{g.label}</span>
                  {g.threads.map((t) => {
                    const snap = snapshot;
                    const outdated = snap ? isOutdatedComment(snap.files, t.root) : false;
                    const count = 1 + t.replies.length;
                    // Entries under a file group show only their line (#226).
                    const meta =
                      g.label === "General"
                        ? `${t.root.author ?? "GitHub"} · ${count} ${count === 1 ? "comment" : "comments"}${outdated ? " · outdated" : ""}`
                        : t.root.line !== undefined
                          ? `:${t.root.line} · ${t.root.author ?? "GitHub"} · ${count} ${count === 1 ? "comment" : "comments"}${outdated ? " · outdated" : ""}`
                          : `${t.root.author ?? "GitHub"} · ${count} ${count === 1 ? "comment" : "comments"}${outdated ? " · outdated" : ""}`;
                    const go = (): void => jumpExisting(t);
                    return (
                      <ListRow
                        key={`existing-${t.root.id}`}
                        data-ghjump={t.root.id}
                        onClick={go}
                        {...rowKeys(go)}
                        primary={<span className="ghmenu" dangerouslySetInnerHTML={{ __html: t.root.bodyHtml }} />}
                        meta={meta}
                        trailing={
                          t.root.htmlUrl ? (
                            <a
                              className="ib"
                              href={t.root.htmlUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              data-tip="Open on GitHub"
                              aria-label="Open on GitHub"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Icon name="open" />
                            </a>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              ))
            )}
          </section>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
