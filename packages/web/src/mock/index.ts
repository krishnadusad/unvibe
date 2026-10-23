/**
 * Mock API layer (M1 web): an in-memory implementation of the same typed
 * `ApiClient` interface as the real service client, enabled with
 * `VITE_MOCK=1` (`mise run dev:mock`).
 *
 * - Serves a `ReviewSnapshot` fixture: the real urllib3/urllib3#5020 diff
 *   from `mock/diff.ts` + the guide fixture from `mock/guide.ts` (owned by
 *   the guide agent; pages/annotations/description from the generated
 *   `fixtures/urllib3-5020/snapshot.json`).
 * - Applies mutations locally **through the same store path WS patches use**:
 *   every mutation bumps `rev` and emits `{ type: "patch", baseRev, headRev,
 *   ops }` via the zustand store's `applyEvent`, so views update exactly as
 *   they will from live WS events.
 * - `summarizeHunk` returns canned text (prototype `HSUM`) after a short
 *   delay, mimicking the async agent job.
 */
import type {
  ActionResponse,
  AddRepoRequest,
  AddRepoResponse,
  CustomGuide,
  CustomGuideResponse,
  CustomGuideSuggestion,
  CustomGuideSuggestions,
  ChangesFilter,
  Contribution,
  CreateDocumentRequest,
  CreateReviewRequest,
  CreateReviewResponse,
  DiffFilter,
  HunkScoreLevel,
  HunkState,
  Job,
  ModelsResponse,
  PickFolderResponse,
  Plotline,
  PromptExpanded,
  PromptsResponse,
  PromptTemplate,
  ReadinessResponse,
  RefreshResponse,
  RemoveRepoResponse,
  ResetDataResponse,
  ResumeReviewResponse,
  Repo,
  RepoChange,
  RepoChangesResponse,
  ReposResponse,
  Review,
  ReviewAction,
  ReviewSnapshot,
  ReviewsListResponse,
  ReviewSummary,
  Settings,
  SwitchOutcome,
  UpdateBuildInfo,
  UpdateChannel,
  UpdateDiffFilterRequest,
  UpdateHunkRequest,
  UpdatePendingSwitch,
  UpdateReviewResponse,
  UpdateStatusResponse,
  UpdateSwitchResponse,
  Version,
  VersionStatus,
} from "@unvibe/shared";
import type { ApiClient } from "../api/client.js";
import { UpdateJobsBlockedError } from "../api/updateBlocked.js";
import { CUSTOM_GUIDE_PROMPT_MAX, customGuideCardId, customGuideFallbackTitle, customGuidePageId } from "@unvibe/shared";
import { buildOutboxExportMarkdown, freshBlockId, outboxThreads, parseDocumentMarkdown, parseGitHubRepoInput, renderUntrustedMarkdown } from "@unvibe/shared";
import { useReview } from "../state/store.js";
import { HUNK_SUMMARIES, MOCK_FILES } from "./diff.js";
import { mockFileSlice, mockOutline } from "./fileContents.js";
import { MOCK_ANNOTATIONS, MOCK_DESCRIPTION as guideDescription, MOCK_PAGES } from "./guide.js";
import {
  mockAddedD2Block,
  mockDiagramSvg,
  mockErrorD2Block,
  mockMultilineD2Block,
  mockSeedD2Block,
  mockUnavailableD2Block,
} from "./d2diagrams.js";

export const MOCK_MODE: boolean =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_MOCK === "1";

/**
 * Opt-in mock latency override for unit tests (issue #119): `setMockLatency(0)`
 * makes every `wait` below resolve on the next macrotask, so timer-heavy
 * component tests (DiffView) skip ~1.4 s of deliberate latency without
 * touching fake timers. Default `null` keeps the real waits (e2e and
 * timing-dependent unit tests are unaffected). Callers reset to `null`
 * when done.
 */
let mockLatencyMs: number | null = null;

export function setMockLatency(ms: number | null): void {
  mockLatencyMs = ms;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, mockLatencyMs ?? ms));

// --- repos ---------------------------------------------------------------

const NOW = Date.now();

const SEED_REPOS: Repo[] = [
  { id: "urllib3", owner: "urllib3", name: "urllib3", localPath: "~/code/urllib3", lastOpened: NOW },
  {
    id: "demo-lib",
    owner: "you",
    name: "demo-lib",
    localPath: "~/code/demo-lib",
    lastOpened: 0,
    detected: true,
  },
];

const ADDED_KEY = "unvibe.mock.addedRepos";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function getRepos(): Repo[] {
  const added = readJson<Repo[]>(ADDED_KEY, []);
  // Fresh-install state for specs (`unvibe.mock.noRepos`): seeds hidden,
  // repos added during the test still listed.
  let seeds = SEED_REPOS;
  try {
    if (localStorage.getItem("unvibe.mock.noRepos")) seeds = [];
  } catch {
    // Ignore.
  }
  return [...added, ...seeds];
}

// --- review snapshot -----------------------------------------------------

const MOCK_VERSION: Version = {
  n: 1,
  headSha: "bdcc1e493e",
  mergeBaseSha: "443cb01be1",
  baseRef: "main",
  fetchedAt: NOW,
  idMapping: {},
};

const MOCK_REVIEW: Review = {
  id: "demo",
  repoId: "urllib3",
  branch: "fix-obs-fold",
  prNumber: 5020,
  versions: [MOCK_VERSION],
  currentVersion: 1,
  createdAt: NOW - 3600000,
};

function seedHunkStates(): Map<string, HunkState> {
  const map = new Map<string, HunkState>();
  // Issue #169: every hunk carries a canned score (the hunk pass's
  // interestingness level); plotline assignment rides the same states.
  const scores: Record<string, HunkScoreLevel> = {};
  const plotlines: Record<string, string> = {};
  for (const f of MOCK_FILES) {
    f.hunks.forEach((h, i) => {
      scores[h.contentHash] =
        f.path === "src/urllib3/connection.py"
          ? "substantive"
          : f.path === "test/test_connection.py" && i === 2
            ? "routine"
            : f.path === "test/with_dummyserver/test_socketlevel.py" && i === 1
              ? "substantive"
              : f.path === "changelog/1362.bugfix.rst"
                ? "routine"
                : "mechanical";
      if (f.path === "src/urllib3/connection.py") plotlines[h.contentHash] = "unfold";
      else if (f.path === "test/test_connection.py") plotlines[h.contentHash] = "unfold-tests";
      else if (f.path === "test/with_dummyserver/test_socketlevel.py" && i === 1) {
        plotlines[h.contentHash] = "unfold-tests";
      }
      // The socket-level import and the changelog entry stay unassigned:
      // they read as "other" in the filter.
    });
  }
  for (const f of MOCK_FILES) {
    f.hunks.forEach((h, i) => {
      // Mirror the prototype's mid-use seed: one reviewed+folded hunk.
      if (f.path === "test/test_connection.py" && i === 2) {
        map.set(h.contentHash, { contentHash: h.contentHash, folded: true, reviewed: true });
      }
      // Issue #138: one idle hunk summary to activate in tests.
      if (f.path === "src/urllib3/connection.py" && i === 0) {
        map.set(h.contentHash, {
          contentHash: h.contentHash,
          folded: false,
          reviewed: false,
          summary: "Unfolds folded header values before reading.",
        });
      }
      const prev = map.get(h.contentHash) ?? { contentHash: h.contentHash, folded: false, reviewed: false };
      map.set(h.contentHash, {
        ...prev,
        score: scores[h.contentHash] ?? "routine",
        ...(plotlines[h.contentHash] !== undefined ? { plotline: plotlines[h.contentHash] } : {}),
      });
    });
  }
  return map;
}

/**
 * Issue #169: the demo's plotlines — what the reader would name for the
 * bundled change. The socket-level import and the changelog entry stay
 * unassigned, so they read as "other".
 */
const MOCK_PLOTLINES: Plotline[] = [
  {
    id: "unfold",
    name: "Unfold folded values",
    description: "Normalize obsolete folds before reading headers.",
  },
  {
    id: "unfold-tests",
    name: "Prove the unfolding works",
    description: "Unit and socket-level coverage for the new behaviour.",
    buildsOn: "unfold",
  },
];

/**
 * Mock description: the generated fixture's description (stable paragraph
 * ids, PR source). Owned by the guide agent in `mock/guide.ts`; the
 * comments milestone presents author mode (editable) in mock so
 * description editing is exercisable without a service.
 */
const MOCK_DESCRIPTION = { ...guideDescription, editable: true, source: "pr" as const };

/** Canned explanation blocks (fixture-shaped: depth variants + citations). */
function mockExplainBlocks(quote: string): import("@unvibe/shared").Block[] {
  const q = quote.replace(/</g, "&lt;").slice(0, 120) || "this text";
  return [
    {
      type: "paragraph",
      id: `b-mock-exp-${Date.now().toString(36)}`,
      text: {
        simple: `<em>${q}</em> is about unfolding folded header values.`,
        standard: `Mock explanation of <em>${q}</em>: the helper replaces each fold with one space before urllib3 reads the value.`,
        deep: `Mock deep explanation of <em>${q}</em>: obs-fold handling sits at the recipient per RFC 9112 §5.2, before interpretation or forwarding, so every consumer sees one semantic value.`,
      },
      citations: [{ target: "diff:src-urllib3-connection.py:80-82" }],
    },
  ] as unknown as import("@unvibe/shared").Block[];
}

function mockExampleAside(): import("@unvibe/shared").Block {
  return {
    type: "aside",
    id: `b-mock-ex-${Date.now().toString(36)}`,
    kind: "Example",
    inner: [
      { type: "code", id: `b-mock-ex-${Date.now().toString(36)}-c`, code: "# mock example\n# urllib3 now returns: 'a=1; path=/ Max-Age=900'", citations: [] },
    ],
    citations: [],
  } as unknown as import("@unvibe/shared").Block;
}

function mockDiagramAside(): import("@unvibe/shared").Block {
  return mockAddedD2Block() as unknown as import("@unvibe/shared").Block;
}

function mockPrincipleAside(): import("@unvibe/shared").Block {
  return {
    type: "aside",
    id: `b-mock-pr-${Date.now().toString(36)}`,
    kind: "Underlying principle",
    inner: [
      { type: "paragraph", id: `b-mock-pr-${Date.now().toString(36)}-p`, text: { standard: "Resolve encoding at the recipient, before interpretation." }, citations: [] },
    ],
    citations: [],
  } as unknown as import("@unvibe/shared").Block;
}

type MockCardRef =
  | { kind: "page"; pageId: string; card: import("@unvibe/shared").Card }
  | { kind: "answer"; annotation: import("@unvibe/shared").Annotation; turn: import("@unvibe/shared").Turn };

function findMockCard(cardId: string): MockCardRef | null {
  for (const p of mockPages) {
    const card = p.cards.find((c) => c.id === cardId);
    if (card) return { kind: "page", pageId: p.id, card };
  }
  for (const annotation of annotations) {
    const turn = (annotation.turns ?? []).find((t) => t.id === cardId);
    if (turn) return { kind: "answer", annotation, turn };
  }
  return null;
}

function mockCardBlocks(ref: MockCardRef): import("@unvibe/shared").Block[] {
  return (ref.kind === "page" ? ref.card.blocks : ref.turn.blocks) as import("@unvibe/shared").Block[];
}

function mockCardLevel(ref: MockCardRef): import("@unvibe/shared").DepthLevel {
  return (ref.kind === "page" ? ref.card.level : ref.turn.level) as import("@unvibe/shared").DepthLevel;
}

/** Push undo + set blocks/level + bump revision on a page card or answer. */
function setMockCard(ref: MockCardRef, blocks: import("@unvibe/shared").Block[], level: import("@unvibe/shared").DepthLevel): void {
  const cur = mockCardBlocks(ref);
  const body = ref.kind === "page" ? ref.card : ref.turn;
  (body.undoStack as { blocks: unknown; level: unknown }[]).push({
    blocks: JSON.parse(JSON.stringify(cur)),
    level: (body as { level: unknown }).level,
  });
  (body as { blocks: unknown }).blocks = blocks;
  (body as { level: unknown }).level = level;
  (body as { revision: number }).revision += 1;
}

/**
 * Qualify a block anchor the way the service stores it (#116, #136):
 * `<owner>#<block>` with the page card or answer holding the block
 * (aside inner blocks resolve like the service's `findBlock`). Unknown
 * blocks pass through. The web requires qualified hosts to attach an
 * annotation, so the mock must not store bare ones.
 */
function qualifyMockBlock(blockId: string): string {
  const found = findMockBlock(blockId);
  if (!found) return blockId;
  return `${found.ownerId}#${found.blockId}`;
}

function findMockBlock(blockId: string): { ownerId: string; blockId: string } | null {
  const hash = blockId.indexOf("#");
  const owner = hash >= 0 ? blockId.slice(0, hash) : null;
  const short = hash >= 0 ? blockId.slice(hash + 1) : blockId;
  const scan = (
    blocks: { id: string; type: string; inner?: { id: string }[] }[],
    ownerId: string,
  ): { ownerId: string; blockId: string } | null => {
    for (const b of blocks) {
      if (b.id === blockId || b.id === short) return { ownerId, blockId: b.id };
      if (b.type === "aside") {
        for (const ib of b.inner ?? []) {
          if (ib.id === blockId || ib.id === short) return { ownerId, blockId: ib.id };
        }
      }
    }
    return null;
  };
  if (owner !== null) {
    for (const p of mockPages) {
      const c = p.cards.find((c) => c.id === owner);
      if (c) {
        const m = scan(c.blocks as never[], c.id);
        if (m) return m;
        return null;
      }
    }
    const ann = annotations.find((a) => a.id === owner);
    if (ann) {
      for (const t of ann.turns ?? []) {
        const m = scan(t.blocks as never[], t.id);
        if (m) return m;
      }
    }
    return null;
  }
  for (const p of mockPages) {
    for (const c of p.cards) {
      const m = scan(c.blocks as never[], c.id);
      if (m) return m;
    }
  }
  for (const a of annotations) {
    for (const t of a.turns ?? []) {
      const m = scan(t.blocks as never[], t.id);
      if (m) return m;
    }
  }
  return null;
}

/** Card controls in mock: depth/examples/diagram/undo through the patch path. */
function mockCardControl(a: { kind: string; cardId: string; direction?: string }): {
  accepted: boolean;
  cardId: string;
  jobId?: string;
  /** Mirrors the service (issue #65): stored switches and at-the-limit repeats reuse. */
  reused?: boolean;
  /** Resulting level for depth actions (issue #65). */
  level?: import("@unvibe/shared").DepthLevel;
} {
  const ref = findMockCard(a.cardId);
  if (!ref) throw new Error(`unknown card ${a.cardId}`);
  const ORDER: import("@unvibe/shared").DepthLevel[] = ["simple", "standard", "deep"];
  if (a.kind === "depth" && (a.direction === "simpler" || a.direction === "deeper")) {
    const level = mockCardLevel(ref);
    const i = ORDER.indexOf(level);
    const next = a.direction === "simpler" ? ORDER[i - 1] : ORDER[i + 1];
    const blocks = mockCardBlocks(ref);
    if (!next) {
      // + at the deepest level adds the Underlying principle block once.
      if (a.direction === "deeper" && !blocks.some((b) => b.type === "aside" && (b as { kind: string }).kind === "Underlying principle")) {
        const cur = [...blocks];
        // Fresh ID within this body (#116), inner IDs moving along.
        const principle = mockPrincipleAside() as { id: string; inner: { id: string }[] };
        const principleId = freshBlockId(cur as never[], principle.id);
        const stamped =
          principleId === principle.id
            ? principle
            : {
                ...principle,
                id: principleId,
                inner: principle.inner.map((ib) =>
                  ib.id.startsWith(`${principle.id}-`)
                    ? { ...ib, id: `${principleId}-${ib.id.slice(principle.id.length + 1)}` }
                    : ib,
                ),
              };
        setMockCard(ref, [...cur, stamped] as never, level as never);
        emitPages();
        emitAnnotations();
        return { accepted: true, cardId: a.cardId, level };
      }
      return { accepted: true, cardId: a.cardId, reused: true, level };
    }
    const cur = [...blocks];
    setMockCard(ref, cur as never, next as never);
    emitPages();
    emitAnnotations();
    return { accepted: true, cardId: a.cardId, reused: true, level: next };
  }
  if (a.kind === "examples" || a.kind === "diagram") {
    const blocks = mockCardBlocks(ref);
    const level = mockCardLevel(ref);
    const want = a.kind === "examples" ? "Example" : null;
    if (want && blocks.some((b) => b.type === "aside" && (b as { kind: string }).kind === want)) {
      return { accepted: true, cardId: a.cardId };
    }
    if (a.kind === "diagram" && blocks.some((b) => b.type === "diagram")) {
      return { accepted: true, cardId: a.cardId };
    }
    const cur = [...blocks];
    const insert = a.kind === "examples" ? mockExampleAside() : mockDiagramAside();
    // Fresh ID within this body (#116): the timestamp base collides only
    // across same-millisecond inserts, but the used-set makes it exact.
    // Aside inner IDs move with a restamped parent.
    const insertId = freshBlockId(cur as never[], (insert as { id: string }).id);
    const stamped =
      insert.type === "aside" && insert.id !== insertId
        ? {
            ...insert,
            id: insertId,
            inner: (insert.inner as { id: string }[]).map((ib) =>
              ib.id.startsWith(`${insert.id}-`) ? { ...ib, id: `${insertId}-${ib.id.slice(insert.id.length + 1)}` } : ib,
            ),
          }
        : { ...insert, id: insertId };
    // Blocks appear after the paragraphs they relate to: insert after the
    // first paragraph when one exists, else append.
    const at = cur.findIndex((b) => b.type === "paragraph");
    const nextBlocks = at >= 0 ? [...cur.slice(0, at + 1), stamped, ...cur.slice(at + 1)] : [...cur, stamped];
    setMockCard(ref, nextBlocks as never, level as never);
    emitPages();
    emitAnnotations();
    return { accepted: true, cardId: a.cardId };
  }
  if (a.kind === "undo") {
    const body = ref.kind === "page" ? ref.card : ref.turn;
    const prev = (body.undoStack as { blocks: unknown; level: unknown }[]).pop();
    if (!prev) return { accepted: true, cardId: a.cardId };
    (body as { blocks: unknown }).blocks = prev.blocks;
    (body as { level: unknown }).level = prev.level;
    (body as { revision: number }).revision += 1;
    emitPages();
    emitAnnotations();
    return { accepted: true, cardId: a.cardId };
  }
  throw new Error(`unknown mock card control ${(a as { kind: string }).kind}`);
}

function readChangesFailures(): string[] {
  try {
    const raw = localStorage.getItem("unvibe.mock.repoChangesFail");
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Resolve once the `unvibe.mock.repoChangesHold` key is gone (or soon anyway). */
async function awaitChangesRelease(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    try {
      if (!localStorage.getItem("unvibe.mock.repoChangesHold")) return;
    } catch {
      return;
    }
    await wait(50);
  }
}

/** Resolve once the `unvibe.mock.addRepoHold` key is gone (or soon anyway). */
async function awaitAddRelease(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    try {
      if (!localStorage.getItem("unvibe.mock.addRepoHold")) return;
    } catch {
      return;
    }
    await wait(50);
  }
}

/**
 * Resolve once the `unvibe.mock.turnFillHold` key is gone (or soon
 * anyway). Holds conversation turn fills (ask/reply/retry answers) so
 * mid-fill sequences — e.g. Open as page while the answer is still
 * being written (issue #152) — are deterministic in tests.
 */
async function awaitTurnFillRelease(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    try {
      if (!localStorage.getItem("unvibe.mock.turnFillHold")) return;
    } catch {
      return;
    }
    await wait(50);
  }
}

/** Extra clone latency in mock mode (`unvibe.mock.addRepoDelayMs`, default 150). */
function addRepoDelayMs(): number {
  try {
    const raw = localStorage.getItem("unvibe.mock.addRepoDelayMs");
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // Fall through to the default.
  }
  return 150;
}

/** Forced add failure in mock mode (`unvibe.mock.addRepoFail` = error text). */
function addRepoFailure(): string | null {
  try {
    const raw = localStorage.getItem("unvibe.mock.addRepoFail");
    return raw ? raw : null;
  } catch {
    return null;
  }
}

/** Stale-clone note in mock mode (`unvibe.mock.repoChangesFetchError` = note). */
function changesFetchError(): string | null {
  try {
    const raw = localStorage.getItem("unvibe.mock.repoChangesFetchError");
    return raw ? raw : null;
  } catch {
    return null;
  }
}

let rev = 1;
/** Per-review diff view preferences (issue #168): the mock persists them. */
let mockViewPrefs: import("@unvibe/shared").ReviewViewPrefs = { showExistingComments: true, existingCommentsCollapsed: false };
const hunkStates = seedHunkStates();
/** Per-file fold state (issue #162): the mock persists it like the service. */
const fileStates = new Map<string, import("@unvibe/shared").FileState>();
/** Issue #169: the diff's score/plotline filter, remembered with the review. */
let mockDiffFilter: DiffFilter | undefined;
function seedAnnotations(): import("@unvibe/shared").Annotation[] {
  const list = JSON.parse(JSON.stringify(MOCK_ANNOTATIONS)) as import("@unvibe/shared").Annotation[];
  // Issue #204: conversation cards are pinned, like the service creates them.
  for (const a of list) if (a.type === "conversation") a.pinned = true;
  return list;
}
let annotations: import("@unvibe/shared").Annotation[] = seedAnnotations();
let mockPages: import("@unvibe/shared").Page[] = JSON.parse(
  JSON.stringify(MOCK_PAGES),
) as import("@unvibe/shared").Page[];

/**
 * Seed mock D2 edge cases into the go-deeper flow card: the fixture's own
 * diagram block (rendered fixture SVGs served by `diagramSvg` below)
 * covers the ok path; the seeds add an unverified-anchor block, an
 * unavailable block (no binary), a failed-compile block (plain fallback
 * + retry, #130) and a multi-line-label block, so mock-mode tests
 * exercise those branches without touching the fixture.
 */
function seedMockD2Diagrams(pages: import("@unvibe/shared").Page[]): void {
  const card = pages
    .find((p) => p.id === "root")
    ?.cards.find((c) => c.id === "g-flow");
  if (!card || card.blocks.some((b) => b.id === "b-mock-d2-edge")) return;
  card.blocks = [
    ...card.blocks,
    mockSeedD2Block() as never,
    mockUnavailableD2Block() as never,
    mockErrorD2Block() as never,
    mockMultilineD2Block() as never,
  ];
}
seedMockD2Diagrams(mockPages);
let description = { ...MOCK_DESCRIPTION };
function seedExistingComments(): import("@unvibe/shared").ExistingReviewComment[] {
  const made = (
    c: Omit<import("@unvibe/shared").ExistingReviewComment, "bodyHtml">,
  ): import("@unvibe/shared").ExistingReviewComment => ({ ...c, bodyHtml: renderUntrustedMarkdown(c.body) });
  return [
    made({
      id: 101,
      path: "src/urllib3/connection.py",
      line: 82,
      side: "RIGHT",
      body: "Already on GitHub: consider covering bare LF here too.",
      author: "teammate",
      createdAt: "2026-09-01T12:00:00Z",
      htmlUrl: "https://github.com/urllib3/urllib3/pull/5020#discussion_r101",
    }),
    made({
      id: 102,
      path: "src/urllib3/connection.py",
      line: 82,
      side: "RIGHT",
      body: "Good point — the fast path only checks for `\\r\\n`.",
      author: "author",
      replyTo: 101,
      createdAt: "2026-09-01T12:30:00Z",
      htmlUrl: "https://github.com/urllib3/urllib3/pull/5020#discussion_r102",
    }),
    made({
      id: 103,
      path: "src/urllib3/connection.py",
      line: 500,
      side: "RIGHT",
      body: "Outdated remark: this line moved since the comment.",
      author: "teammate",
      createdAt: "2026-08-20T12:00:00Z",
      htmlUrl: "https://github.com/urllib3/urllib3/pull/5020#discussion_r103",
    }),
    made({
      id: 104,
      path: "src/urllib3/retired.py",
      line: 10,
      side: "RIGHT",
      body: "Remark on a file no longer in the diff.",
      author: "review-bot",
      createdAt: "2026-08-10T12:00:00Z",
      htmlUrl: "https://github.com/urllib3/urllib3/pull/5020#discussion_r104",
    }),
    made({
      id: 105,
      path: "src/example/very/long/path/to/a/deeply/nested/module/with/a/long/name.py",
      line: 42,
      side: "RIGHT",
      body: "A made-up long comment for the menu: `some_function_with_a_rather_long_name(argument_one, argument_two)` plus a superlongunbrokenwordthatwouldotherwiseforcethemenuwiderthanthepanel and several more sentences so the body runs well past two lines in the menu at its minimum width.\n\nA second paragraph with **emphasis** and a list:\n\n- first point\n- second point",
      author: "teammate",
      createdAt: "2026-09-02T12:00:00Z",
      htmlUrl: "https://github.com/urllib3/urllib3/pull/5020#discussion_r105",
    }),
  ];
}

let existingComments: import("@unvibe/shared").ExistingReviewComment[] = seedExistingComments();

const SETTINGS_KEY = "unvibe.mock.settings";

const DEFAULT_MOCK_SETTINGS: Settings = {
  uiTheme: "default",
  main: { provider: "claude", model: "mock-main", effort: "" },
  small: { provider: "claude", model: "mock-small", effort: "" },
  secondOpinion: { provider: "codex", model: "mock-second", effort: "" },
  sessionsPerProvider: 16,
  inlineBudgetTokens: 40000,
  rebuildSupersededRatio: 0.2,
  rebuildAppendedTokens: 10000,
  logBatchTokens: 2000,
  cacheLifetimeMs: 300000,
  idleExitMinutes: 10,
  versionPickerEnabled: false,
  fullAccess: false,
  fullAccessAcknowledgedAt: null,
  autoGoDeeper: true,
};

function getMockSettings(): Settings {
  return { ...DEFAULT_MOCK_SETTINGS, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}) };
}

function seedJobs(): Job[] {
  return [
    {
      id: "job-reader-1",
      kind: "reader",
      provider: "claude",
      model: "mock-main",
      effort: "",
      reviewId: "demo",
      priority: 10,
      state: "done",
      sessionId: "sess-reader-1",
      promptSnapshot: "You are the reader: explore the repo and write the guided review.",
      tools: [
        {
          name: "Read",
          id: "mock-tool-1",
          detail: "{\"path\": \"src/urllib3/response.py\"}",
          result: "Returned the response module (212 lines).",
          resultOriginalLength: 41,
          startedAt: 1700000000000,
          finishedAt: 1700000001000,
        },
      ],
      turnRecords: [
        {
          label: "first",
          prompt: "You are the reader: explore the repo and write the guided review.",
          promptOriginalLength: 66,
          output: "## The problem\n\nFolded headers are unfolded lazily.\n\n```json\n{\"cardIds\": [\"problem\", \"central\"]}\n```\n",
          outputOriginalLength: 104,
          tools: [
            {
              name: "Read",
              id: "mock-tool-1",
              detail: "{\"path\": \"src/urllib3/response.py\"}",
              result: "Returned the response module (212 lines).",
              resultOriginalLength: 41,
              startedAt: 1700000000000,
              finishedAt: 1700000001000,
            },
          ],
          usage: { inputTokens: 48200, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 6300 },
          rawUsage: {
            usage: { inputTokens: 48200, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 6300, totalTokens: 54500 },
            _meta: { quota: { token_count: { inputTokens: 48200, cachedInputTokens: 0, cachedWriteTokens: 0, outputTokens: 6300, totalTokens: 54500 } } },
          },
          startedAt: 1700000000000,
          finishedAt: 1700000005000,
        },
      ],
      usage: { inputTokens: 48200, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 6300 },
      cacheHitRate: 0,
      progress: "Finished: 6 cards",
    },
    {
      id: "job-explain-1",
      kind: "ask",
      provider: "claude",
      model: "mock-main",
      effort: "",
      reviewId: "demo",
      priority: 100,
      state: "running",
      sessionId: "sess-reader-1",
      // Conversation fills are annotation-scoped on the service
      // (annotationId, never cardId): keep the seed faithful so no card
      // shows a stuck busy state.
      annotationId: "ann_seed_thread",
      promptSnapshot: "Explain the quoted text with citations to the diff.",
      usage: { inputTokens: 42500, cachedReadTokens: 38900, cachedWriteTokens: 0, outputTokens: 1200 },
      cacheHitRate: 0.478,
      progress: "Streaming answer…",
    },
    {
      id: "job-hunk-1",
      kind: "hunk-pass",
      provider: "codex",
      model: "mock-small",
      effort: "",
      reviewId: "demo",
      priority: 10,
      state: "queued",
      promptSnapshot: "Summarize this hunk in one line.",
    },
    {
      id: "job-critic-1",
      kind: "critic",
      provider: "claude",
      model: "mock-main",
      effort: "",
      reviewId: "demo",
      priority: 50,
      state: "backing-off",
      attempts: 2,
      nextRetryAt: Date.now() + 45000,
      error: "429 rate limited",
      promptSnapshot: "Critique the change: findings with evidence.",
    },
  ];
}

let mockJobs: Job[] = seedJobs();

function seedContributions(): Contribution[] {
  return [
    {
      id: "ct-seed-1",
      sourceSession: "sess-reader-1",
      items: [
        {
          kind: "fact",
          text: "Folded header values are unfolded lazily on first access.",
          citations: [{ target: "diff:src-urllib3-connection.py:640-660" }],
        },
        { kind: "reader_note", text: "The reader found the regex section hard to follow.", citations: [] },
      ],
      status: "pending",
    },
    {
      id: "ct-seed-2",
      sourceSession: "t-seed",
      items: [
        {
          kind: "correction",
          text: "The central card overstates the scope: only response headers change.",
          target: "card:central#b-rule",
          citations: [],
        },
        { kind: "open_question", text: "Is the new helper covered by a socket-level test?", citations: [] },
      ],
      status: "pending",
    },
  ];
}

let mockContributions: Contribution[] = seedContributions();

/**
 * Mock shared-context debug document (issue #32): canned base + log plus
 * the live seed contributions, so the debug page shows all three parts and
 * delete visibly removes an item in mock mode.
 */
function mockSharedContext(reviewId: string): {
  reviewId: string;
  base: string;
  log: string;
  contributions: string;
} {
  const base = [
    "## Base",
    "",
    "1 base built for this review. The pack below is the current pack — what would be sent now, not a historical rebuild.",
    "",
    "### Base `v1|guide-mock|mock|mock-main`",
    "",
    "- version: `v1` · guide revision: `guide-mock` · provider/model: `mock/mock-main`",
    "- base tokens: 12000",
    "- appended since build: 0",
    "- superseded: 0.0%",
    "- last rebuild: built fresh",
    "",
    "### Current pack for `v1|guide-mock|mock|mock-main` (12000 tokens)",
    "",
    "#### L0 system",
    "",
    "```text",
    "You are helping a person read and review a code change.",
    "```",
    "",
    "#### L1 + L1b + L2",
    "",
    "```text",
    "PR #5020 on urllib3/urllib3",
    "Diff: 8 hunks, +42 −18",
    "### The central change [[card:central]]",
    "",
    "Unfold obsolete folded values.",
    "```",
    "",
  ].join("\n");
  const log = [
    "## Log",
    "",
    "2 entries. Entries up to seq 1 are already in base `v1|guide-mock|mock|mock-main`. Batch threshold 2000 tokens.",
    "",
    "### In base (1)",
    "",
    "```text",
    "- [1 new-card global] central card written",
    "```",
    "",
    "### Waiting for batch (1)",
    "",
    "```text",
    "- [2 thread-summary global] ask about retry settled",
    "```",
    "",
  ].join("\n");
  const parts = ["## Contributions", ""];
  if (reviewId === "demo" && mockContributions.length > 0) {
    parts.push(`${mockContributions.length} contributions.`, "");
    for (const c of mockContributions) {
      parts.push(`### ${c.id}`, "");
      parts.push(c.sourceThread ? `- thread: \`${c.sourceThread}\`` : `- session: \`${c.sourceSession}\``);
      if (c.replaces) parts.push(`- replaces: \`${c.replaces}\``);
      if (c.status === "merged" || c.items.some((i) => i.kind === "correction")) parts.push(`- status: ${c.status}`);
      for (const item of c.items) {
        const target = item.target ? ` → \`${item.target}\`` : "";
        parts.push(`- **${item.kind}**${target}: ${item.text}`);
        if (item.citations.length > 0) {
          parts.push(`  - cites: ${item.citations.map((cit) => `\`${cit.target}\``).join(", ")}`);
        }
      }
      parts.push("");
    }
  } else {
    parts.push("(no contributions yet)", "");
  }
  return { reviewId, base, log, contributions: parts.join("\n") };
}

/**
 * Test-only: reset hunk states and the snapshot revision to the seeded
 * fixture (component tests share this module's in-memory state).
 */
export function resetMockState(): void {
  mockReviewList = seedReviewList();
  try {
    localStorage.removeItem(READINESS_KEY);
  } catch {
    // Ignore.
  }
  hunkStates.clear();
  for (const [k, v] of seedHunkStates()) hunkStates.set(k, v);
  fileStates.clear();
  mockViewPrefs = { showExistingComments: true, existingCommentsCollapsed: false };
  annotations = seedAnnotations();
  mockPages = JSON.parse(JSON.stringify(MOCK_PAGES));
  seedMockD2Diagrams(mockPages);
  description = { ...MOCK_DESCRIPTION };
  existingComments = seedExistingComments();
  mockJobs = seedJobs();
  mockContributions = seedContributions();
  mockUpdatePending = null;
  mockUpdateDown = false;
  mockSoSeq = 0;
  mockDiffFilter = undefined;
  mockGuides = [];
  mockGuideSuggestions = undefined;
  mockGuideSeq = 0;
  for (const p of pendingSecondOpinions) window.clearTimeout(p.timer);
  pendingSecondOpinions = [];
  try {
    localStorage.removeItem(UPDATE_KEY);
  } catch {
    // Ignore.
  }
  rev = 1;
}

function seedReviewList(): ReviewSummary[] {
  const total = MOCK_FILES.reduce((n, f) => n + f.hunks.length, 0);
  const reviewed = [...seedHunkStates().values()].filter((s) => s.reviewed).length;
  return [
    {
      id: "demo",
      repoId: "urllib3",
      repoOwner: "urllib3",
      repoName: "urllib3",
      title: "Unfold obsolete folded response header values",
      branch: "fix-obs-fold",
      prNumber: 5020,
      createdAt: NOW - 3600000,
      lastOpened: NOW - 600000,
      versionCount: 1,
      currentVersion: 1,
      stale: false,
      totalHunks: total,
      reviewedHunks: reviewed,
      pendingComments: 1,
      guideStatus: "ready",
      ingestStatus: "ready",
    },
    {
      id: "r-old",
      repoId: "urllib3",
      repoOwner: "urllib3",
      repoName: "urllib3",
      title: "Fix retry backoff on 429s",
      branch: "fix-retry-backoff",
      prNumber: 5011,
      createdAt: NOW - 86400000 * 2,
      lastOpened: NOW - 86400000,
      versionCount: 2,
      currentVersion: 2,
      stale: true,
      totalHunks: total,
      reviewedHunks: 0,
      pendingComments: 0,
      guideStatus: "running",
      guideDetail: "Running: critic",
      ingestStatus: "ready",
    },
    ...readExtraSessions(),
  ];
}

/**
 * Test-only extra sessions for the start page (`unvibe.mock.extraSessions`,
 * a JSON array of `ReviewSummary`): e.g. a review whose repo is no longer
 * in the repo list, which the page renders in its orphan group. Read at
 * seed time so `addInitScript` can set it before the page loads.
 */
function readExtraSessions(): ReviewSummary[] {
  try {
    const raw = localStorage.getItem("unvibe.mock.extraSessions");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ReviewSummary[]) : [];
  } catch {
    return [];
  }
}

let mockReviewList: ReviewSummary[] = seedReviewList();

function mockSummaries(): ReviewSummary[] {
  return [...mockReviewList].sort((a, b) => b.lastOpened - a.lastOpened);
}

const READINESS_KEY = "unvibe.mock.readiness";

function readMockReadiness(): ReadinessResponse {
  try {
    const raw = localStorage.getItem(READINESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ReadinessResponse;
      if (Array.isArray(parsed.checks)) return { ...parsed, cached: false };
    }
  } catch {
    // Fall through to healthy default.
  }
  return {
    checks: [
      { id: "git", label: "git", status: "ok", summary: "git found", fix: "", settingsAnchor: "#environment" },
      { id: "gh", label: "gh (GitHub CLI)", status: "ok", summary: "gh logged in as you", fix: "", settingsAnchor: "#environment" },
      { id: "agent:main", label: "Main model", status: "ok", summary: "claude/mock-main ready", fix: "", settingsAnchor: "#models" },
      { id: "agent:small", label: "Small model", status: "ok", summary: "claude/mock-small ready", fix: "", settingsAnchor: "#models" },
      { id: "agent:secondOpinion", label: "Second-opinion model", status: "ok", summary: "codex/mock-second ready", fix: "", settingsAnchor: "#models" },
      { id: "agents-distinct", label: "Second opinion independence", status: "ok", summary: "Second opinion differs from main", fix: "", settingsAnchor: "#models" },
    ],
    generatedAt: Date.now(),
    cached: false,
  };
}

/** Test-only: seed a failing readiness report (e2e for callouts). */
export function setMockReadiness(next: ReadinessResponse | null): void {
  try {
    if (next) localStorage.setItem(READINESS_KEY, JSON.stringify(next));
    else localStorage.removeItem(READINESS_KEY);
  } catch {
    // Ignore.
  }
}

/** Reviews that carry M5 staleness in mock mode (start page flags `r-old`). */
function isStaleReview(reviewId: string): boolean {
  return reviewId === "r-old" || reviewId === "stale-demo";
}

const STALE_RANGE_DIFF = [
  "1:  a1b2c3d ! unfold folded response headers",
  "    +++ e4f5a6b ! unfold folded response headers (amended)",
  "-:  ------- > 2:  c7d8e9f ! add socket-level test for obs-fold",
].join("\n");

function staleVersionStatus(): VersionStatus {
  const tconn = MOCK_FILES.find((f) => f.path === "test/test_connection.py");
  const changed = tconn?.hunks[2];
  const oldId = changed ? `h:${tconn.fileKey}:${changed.contentHash}` : "h:unknown:old";
  return {
    stale: true,
    fromVersion: 1,
    toVersion: 2,
    unchangedHunks: 7,
    changedHunks: 1,
    newHunks: 2,
    removedHunks: 0,
    renamedFiles: [],
    changedOldIds: [oldId],
    changedNewIds: [`${oldId}:new`],
    rangeDiff: STALE_RANGE_DIFF,
    fetchedAt: NOW,
  };
}

function staleHunkStates(): HunkState[] {
  const states = [...hunkStates.values()];
  const tconn = MOCK_FILES.find((f) => f.path === "test/test_connection.py");
  const changed = tconn?.hunks[2];
  if (!changed) return states;
  return states.map((s) =>
    s.contentHash === changed.contentHash
      ? { ...s, reviewed: false, folded: false, stale: true, needsSummary: true }
      : s,
  );
}

const MOCK_VERSION_2: Version = { ...MOCK_VERSION, n: 2, headSha: "e4f5a6b7c8d", fetchedAt: NOW };

function currentSnapshot(reviewId = "demo", version?: number): ReviewSnapshot {
  const stale = isStaleReview(reviewId);
  const viewing = version ?? (stale ? 2 : 1);
  const base: ReviewSnapshot = {
    review: {
      ...MOCK_REVIEW,
      id: reviewId,
      // The real demo review uses repoId "demo" (service `pipeline/demo.ts`);
      // the mock snapshot matches so demo-only rules apply (no GitHub
      // link-out, no refresh). The summary list keeps its urllib3 row, so
      // the start-page fixtures are unaffected.
      repoId: reviewId === "demo" ? "demo" : MOCK_REVIEW.repoId,
      versions: stale ? [MOCK_VERSION, MOCK_VERSION_2] : [MOCK_VERSION],
      currentVersion: stale ? 2 : 1,
    },
    version: stale ? { ...MOCK_VERSION, n: viewing } : MOCK_VERSION,
    files: MOCK_FILES,
    description,
    ingest: { status: "ready" },
    pages: reviewId === "demo" ? mockPages : MOCK_PAGES,
    annotations,
    hunkStates: stale && viewing === 2 ? staleHunkStates() : [...hunkStates.values()],
    fileStates: [...fileStates.values()],
    viewPrefs: { ...mockViewPrefs },
    jobs: mockJobs.filter((j) => j.reviewId === reviewId || (reviewId === "demo" && !j.reviewId)),
    contributions: reviewId === "demo" ? mockContributions : [],
    logTail: [],
    rev,
    existingComments,
    plotlines: [...MOCK_PLOTLINES],
    ...(mockDiffFilter !== undefined ? { diffFilter: { ...mockDiffFilter } } : {}),
    ...(reviewId === "demo" && mockGuides.length > 0 ? { guides: JSON.parse(JSON.stringify(mockGuides)) as CustomGuide[] } : {}),
    ...(reviewId === "demo" && mockGuideSuggestions ? { guideSuggestions: JSON.parse(JSON.stringify(mockGuideSuggestions)) as CustomGuideSuggestions } : {}),
  };
  if (stale && viewing === 2) base.versionStatus = staleVersionStatus();
  return base;
}

/** Emit the file fold list through the WS-patch path (tab switches keep it). */
function emitFileStates(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/fileStates", value: [...fileStates.values()] }],
  });
}

/** Emit the hunk-states list through the WS-patch path. */
function emitHunkStates(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/hunkStates", value: [...hunkStates.values()] }],
  });
}

/** Issue #169: emit the diff filter through the WS-patch path. */
function emitDiffFilter(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [
      mockDiffFilter === undefined
        ? { op: "remove", path: "/diffFilter" }
        : { op: "replace", path: "/diffFilter", value: { ...mockDiffFilter } },
    ],
  });
}

function findHunkKey(hash: string): string | null {
  for (const f of MOCK_FILES) {
    const idx = f.hunks.findIndex((h) => h.contentHash === hash);
    if (idx >= 0) return `${f.fileKey}:${idx}`;
  }
  return null;
}

/** Emit the annotations list through the WS-patch path (drafts survive). */
function emitAnnotations(): void {  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/annotations", value: JSON.parse(JSON.stringify(annotations)) }],
  });
}

// Playwright hook (mock mode only, like DiffView's `window.__revealSource`):
// stream N no-op annotation patches through the WS-patch path so specs can
// assert highlight idempotence under many snapshot updates without moving
// focus or disturbing the selection (issue #15).
if (MOCK_MODE && typeof window !== "undefined") {
  (window as unknown as { __streamPatches?: (n: number) => void }).__streamPatches = (n: number) => {
    for (let i = 0; i < n; i++) emitAnnotations();
  };
}

/** Emit the pages list through the WS-patch path (card state converges). */
function emitPages(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/pages", value: JSON.parse(JSON.stringify(mockPages)) }],
  });
}

/** Emit the jobs list through the WS-patch path (job handover converges). */
function emitJobs(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/jobs", value: JSON.parse(JSON.stringify(mockJobs)) }],
  });
}

/**
 * Mock agent job (issue #46): like the service, every agent-starting mock
 * action reports a real snapshot job (`running` now, `done` when its fill
 * lands) so the web's in-flight → job handover runs the same path as live.
 */
function trackMockJob(
  jobId: string,
  kind: Job["kind"],
  opts?: { cardId?: string; annotationId?: string; dedupeKey?: string },
): void {
  if (mockJobs.some((j) => j.id === jobId)) return;
  mockJobs.push({
    id: jobId,
    kind,
    provider: "claude",
    model: "mock-main",
    effort: "",
    reviewId: "demo",
    priority: 100,
    state: "running",
    ...(opts?.cardId !== undefined ? { cardId: opts.cardId } : {}),
    ...(opts?.annotationId !== undefined ? { annotationId: opts.annotationId } : {}),
    ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
  });
  emitJobs();
}

function settleMockJob(jobId: string): void {
  const job = mockJobs.find((j) => j.id === jobId);
  if (!job || job.state === "done") return;
  job.state = "done";
  emitJobs();
}

/**
 * Re-target a mock job at a page card (issue #152: like the service's
 * queue retarget, the moved fill's job addresses its new card so the
 * page shows the working state).
 */
function retargetMockJob(jobId: string, cardId: string): void {
  const job = mockJobs.find((j) => j.id === jobId);
  if (!job) return;
  job.cardId = cardId;
  emitJobs();
}

/**
 * Mirror a promoted turn's content onto its page card (issue #152: the
 * mock keeps the service's shape — turns stay on the link while
 * unsettled, the page card is the visible copy).
 */
function mirrorMockPromotedTurn(tid: string, turnId: string): void {
  const link = annotations.find((x) => x.id === tid);
  if (!link || link.type !== "link") return;
  const mapping = ((link as { promotedTurns?: { turnId: string; cardId: string }[] }).promotedTurns ?? []).find(
    (m) => m.turnId === turnId,
  );
  if (!mapping) return;
  const turn = (link.turns ?? []).find((t) => t.id === turnId);
  if (!turn) return;
  for (const p of mockPages) {
    const card = p.cards.find((c) => c.id === mapping.cardId);
    if (!card) continue;
    card.blocks = JSON.parse(JSON.stringify(turn.blocks));
    card.level = turn.level;
    card.revision = turn.revision;
    card.undoStack = JSON.parse(JSON.stringify(turn.undoStack));
    if (turn.secondOpinions) card.secondOpinions = JSON.parse(JSON.stringify(turn.secondOpinions));
    emitPages();
    return;
  }
}

/**
 * Drop a promoted link's turns once every moved turn has settled
 * (issue #152, mirrors the service: the page holds the content).
 */
function dropSettledMockPromotedTurns(tid: string): void {  const link = annotations.find((x) => x.id === tid);
  if (!link || link.type !== "link" || (link.turns?.length ?? 0) === 0) return;
  const unsettled = (link.turns ?? []).some(
    (t) => ((t.working ?? "") !== "" && t.working !== null) || ((t.error ?? "") !== "" && t.error !== null) || t.jobId !== undefined,
  );
  if (unsettled) return;
  delete (link as { turns?: unknown }).turns;
  delete (link as { promotedTurns?: unknown }).promotedTurns;
  emitAnnotations();
}

/**
 * Ensure the hunk's conversation card in mock mode (issue #138, mirrors
 * the service): created from the stored summary text with no job — the
 * first turn carries the summary as a paragraph block. Reuses and
 * reopens the stored card when already activated.
 */
function ensureMockHunkCard(fileKey: string, contentHash: string): { id: string; turnId: string; blockId: string } {
  const file = MOCK_FILES.find((f) => f.fileKey === fileKey);
  if (!file?.hunks.some((h) => h.contentHash === contentHash)) {
    throw new Error(`unknown hunk ${fileKey}:${contentHash}`);
  }
  const summary = hunkStates.get(contentHash)?.summary?.trim();
  if (!summary) throw new Error(`hunk ${fileKey}:${contentHash} has no summary yet`);
  const existing = annotations.find(
    (x) =>
      x.type === "conversation" &&
      (x.anchor.host as { kind?: string }).kind === "hunk" &&
      (x.anchor.host as { fileKey?: string }).fileKey === fileKey &&
      (x.anchor.host as { contentHash?: string }).contentHash === contentHash,
  );
  if (existing) {
    if (!existing.open) {
      existing.open = true;
      emitAnnotations();
    }
    const first = (existing.turns ?? [])[0] as unknown as { id: string; blocks: { id: string }[] } | undefined;
    if (!first) throw new Error(`hunk card ${existing.id} has no turns`);
    return { id: existing.id, turnId: first.id, blockId: first.blocks[0].id };
  }
  const stamp = Date.now().toString(36);
  const id = `ann_mock${Math.floor(Math.random() * 1e9).toString(36)}${stamp}`;
  const turnId = `ans_mock${Math.floor(Math.random() * 1e9).toString(36)}${stamp}`;
  const blockId = `b-hunk-${stamp}`;
  const safe = summary.replace(/</g, "&lt;");
  annotations.push({
    id,
    type: "conversation",
    anchor: {
      host: { kind: "hunk", fileKey, contentHash },
      quotedText: "",
      prefix: "",
      suffix: "",
      position: 0,
      version: 1,
    },
    open: true,
    pinned: true,
    messages: [],
    post: false,
    working: null,
    turns: [
      {
        id: turnId,
        question: null,
        blocks: [{ type: "paragraph", id: blockId, text: { standard: safe }, citations: [] }],
        level: "standard",
        revision: 1,
        undoStack: [],
        working: null,
      },
    ],
  } as unknown as import("@unvibe/shared").Annotation);
  emitAnnotations();
  return { id, turnId, blockId };
}

/**
 * Pending mock second-opinion fills (issue #76): like the service, every
 * run gets its own job id, so a re-run shows its own working state instead
 * of attaching to the previous run's done job. Deleting the opinion drops
 * its fill (a late timer must not resurrect the block) and settles the job
 * cancelled so no working state sticks around.
 */
let mockSoSeq = 0;

interface PendingSecondOpinion {
  cardId: string;
  mode: string;
  jobId: string;
  resultId: string;
  timer: number;
}

let pendingSecondOpinions: PendingSecondOpinion[] = [];

/** Drop pending mock second-opinion fills matching `predicate` (issue #76). */
function cancelPendingSecondOpinions(predicate: (p: PendingSecondOpinion) => boolean): void {
  const dropped = pendingSecondOpinions.filter(predicate);
  if (dropped.length === 0) return;
  pendingSecondOpinions = pendingSecondOpinions.filter((p) => !predicate(p));
  for (const p of dropped) window.clearTimeout(p.timer);
  let changed = false;
  mockJobs = mockJobs.map((j) => {
    if (j.state !== "running" && j.state !== "queued" && j.state !== "backing-off") return j;
    if (!dropped.some((p) => p.jobId === j.id)) return j;
    changed = true;
    return { ...j, state: "cancelled" as const };
  });
  if (changed) emitJobs();
}

/** Emit contributions (accept/dismiss flips status without a refetch). */
function emitContributions(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/contributions", value: JSON.parse(JSON.stringify(mockContributions)) }],
  });
}

function emitDescription(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/description", value: JSON.parse(JSON.stringify(description)) }],
  });
}

function emitExisting(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/existingComments", value: JSON.parse(JSON.stringify(existingComments)) }],
  });
}

function stripMockHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mockPostText(thread: import("@unvibe/shared").Annotation): string {
  if (thread.draft !== undefined && thread.draft !== "") return thread.draft;
  const you = thread.messages.find((m) => m.who === "you" && m.text);
  if (you?.text) return you.text;
  const suggested = thread.messages.find((m) => m.suggested && m.text);
  if (suggested?.text) return suggested.text;
  return thread.messages.find((m) => m.text)?.text ?? "";
}

/** Mock Submit preview: same shape as the service `buildPreview`. */
function buildMockPreview(): import("@unvibe/shared").SubmitPreview {
  // Mirrors the service's locatePendingThreads: only comments are
  // submitted, never conversation cards.
  const pending = annotations.filter(
    (a) => a.type === "comment" && (a as import("@unvibe/shared").Annotation).post && !(a as import("@unvibe/shared").Annotation).postedAt,
  ) as import("@unvibe/shared").Annotation[];
  const alreadyPosted = annotations
    .filter((a) => a.type === "comment" && a.post && a.postedAt)
    .map((a) => a.id);
  const comments = pending.map((thread) => {
    const host = thread.anchor.host;
    let location: import("@unvibe/shared").SubmitCommentLocation;
    if (host.kind === "diff-line") {
      const file = MOCK_FILES.find((f) => f.fileKey === host.fileKey);
      location = file
        ? { kind: "inline", path: file.path, line: host.line, side: "RIGHT" }
        : { kind: "general", reason: `unknown file ${host.fileKey}` };
    } else if (host.kind === "code") {
      // #81: review body with a permalink on the real service; the mock
      // has no real repo to link to, so it shows the same slot plainly.
      location = { kind: "general", reason: `${host.path}:${host.line} is outside the diff, so it goes in the review body with a link to the lines.` };
    } else {
      location = { kind: "general", reason: host.kind === "block" ? "Not tied to a line of the diff, so it posts as a general PR comment." : "A comment on the PR description posts as a general PR comment." };
    }
    return {
      threadId: thread.id,
      location,
      text: mockPostText(thread),
      ...(host.kind === "code" && thread.anchor.quotedText !== ""
        ? { quote: thread.anchor.quotedText }
        : {}),
    };
  });
  const general = comments.filter((c) => c.location.kind !== "inline").map((c) => c.text);
  return {
    comments,
    alreadyPosted,
    reviewBody: general.filter((t) => t.trim() !== "").join("\n\n---\n\n"),
    commitId: MOCK_VERSION.headSha,
    ...(description.pendingMarkdown !== undefined
      ? {
          description: {
            fromRev: description.rev,
            markdown: description.pendingMarkdown,
            html: description.pendingHtml ?? description.html,
          },
        }
      : {}),
  };
}

// --- mock client ---------------------------------------------------------

/**
 * #149: mirror the service dedupe — a PR review and a branch review of
 * the same branch are different sources. The list is newest-first, so
 * the first hit is the most recently active review.
 */
function findMockReview(repoId: string, pr: number | undefined, branch: string | undefined): ReviewSummary | null {
  for (const entry of mockReviewList) {
    if (entry.repoId !== repoId) continue;
    if (pr !== undefined) {
      if (entry.prNumber === pr) return entry;
    } else if (entry.branch === branch && entry.prNumber === undefined) {
      return entry;
    }
  }
  return null;
}

/** #149: mark PR/branch rows that already have a review (open, not start). */
function markMockChanges(changes: RepoChange[], repoId: string): RepoChange[] {
  return changes.map((c) => {
    if (c.kind === "pr" && c.prNumber !== undefined) {
      const m = findMockReview(repoId, c.prNumber, undefined);
      if (m) return { ...c, reviewId: m.id, ...(m.stale ? { stale: true } : {}) };
    } else if (c.kind === "branch" && c.branch) {
      const m = findMockReview(repoId, undefined, c.branch);
      if (m) return { ...c, reviewId: m.id, ...(m.stale ? { stale: true } : {}) };
    }
    return c;
  });
}

function buildMockDiagnostics(): import("@unvibe/shared").DiagnosticsResponse {
  return {
    generatedAt: Date.now(),
    path: {
      shell: "/bin/zsh",
      probedPath: "/mock/bin:/usr/bin:/bin",
      inheritedPath: "/usr/bin:/bin",
      effectivePath: "/mock/bin:/usr/bin:/bin",
      onlyInProbed: ["/mock/bin"],
      onlyInInherited: [],
    },
    tools: [
      {
        tool: "claude",
        minVersion: "2.1.293",
        candidates: [
          {
            path: "/mock/bin/claude",
            source: "login-shell PATH",
            kind: "file",
            runs: true,
            exitCode: 0,
            stdout: "2.1.296",
            stderr: "",
            version: "2.1.296",
            meetsMin: true,
          },
        ],
        chosen: "/mock/bin/claude",
        chosenReason: "first on PATH runs (version 2.1.296)",
        warnings: [],
      },
      {
        tool: "codex",
        minVersion: "0.160.1",
        candidates: [
          {
            path: "/mock/bin/codex",
            source: "login-shell PATH",
            kind: "file",
            runs: true,
            exitCode: 0,
            stdout: "0.162.1",
            stderr: "",
            version: "0.162.1",
            meetsMin: true,
          },
        ],
        chosen: "/mock/bin/codex",
        chosenReason: "first on PATH runs (version 0.162.1)",
        warnings: [],
      },
    ],
    service: {
      pid: 1234,
      startedAt: new Date().toISOString(),
      cwd: "/mock",
      dataDir: "/mock/data",
      port: 4517,
      startMode: "mock",
      nodeVersion: "v24.0.0",
      serviceVersion: "0.0.1",
    },
    warnings: [],
    models: {
      claude: [{ id: "mock-main", name: "Mock Main", description: "Mock main model for tests" }],
      codex: [{ id: "mock-second", name: "Mock Second", description: "Mock second-opinion model" }],
    },
  };
}

/**
 * Version picker (issue #36, step 2) in mock mode: the installed ref and
 * the last outcome persist in localStorage (so a post-switch page reload
 * keeps them, like the real helper's data-dir files); the pending switch
 * and the mid-switch outage are transient module state. The failure mode
 * comes from localStorage `unvibe.mock.update.fail` (`install` |
 * `health` | `fatal`), read when the switch starts.
 */
const UPDATE_KEY = "unvibe.mock.update";
const UPDATE_FAIL_KEY = "unvibe.mock.update.fail";
/** Opt-in running-jobs refusal for the switch-anyway flow (`"1"` refuses). */
const UPDATE_BLOCK_JOBS_KEY = "unvibe.mock.update.blockJobs";
/** Test hook: pretend the running build is this older commit, so the picker shows an update. */
const UPDATE_INSTALLED_COMMIT_KEY = "unvibe.mock.update.installedCommit";

// Distinct build times (issue #73): the picker sorts newest first, so the
// list order is preview/feat-x, preview/fix-y, release.
const MOCK_UPDATE_CHANNELS: UpdateChannel[] = [
  {
    ref: "release",
    kind: "release",
    version: "0.0.1",
    commit: "b535a30ccccccc",
    sourceBranch: null,
    sourceCommit: null,
    baseBranch: null,
    baseCommit: null,
    builtAt: new Date(NOW - 3 * 86400_000).toISOString(),
    current: false,
  },
  {
    ref: "preview/feat-x",
    kind: "preview",
    version: "0.0.1-preview.feat-x.abc1234",
    commit: "abc1234def5678",
    sourceBranch: "feat/x",
    sourceCommit: "abc1234def5678",
    baseBranch: "main",
    baseCommit: "0011223344556677",
    builtAt: new Date(NOW - 3600_000).toISOString(),
    current: false,
  },
  {
    ref: "preview/fix-y",
    kind: "preview",
    version: "0.0.1-preview.fix-y.9f8e7d6",
    commit: "9f8e7d6c5b4a3",
    sourceBranch: "fix/y",
    sourceCommit: null,
    baseBranch: null,
    baseCommit: null,
    builtAt: new Date(NOW - 7200_000).toISOString(),
    current: false,
  },
];

function readUpdatePersisted(): { current: string; outcome: SwitchOutcome | null } {
  const fallback = { current: "release", outcome: null as SwitchOutcome | null };
  try {
    const raw = localStorage.getItem(UPDATE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    if (typeof parsed.current !== "string" || !MOCK_UPDATE_CHANNELS.some((c) => c.ref === parsed.current)) {
      return fallback;
    }
    return { current: parsed.current, outcome: parsed.outcome ?? null };
  } catch {
    return fallback;
  }
}

function writeUpdatePersisted(next: { current: string; outcome: SwitchOutcome | null }): void {
  try {
    localStorage.setItem(UPDATE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal.
  }
}

let mockUpdatePending: UpdatePendingSwitch | null = null;
/** True while the mock "service" is down mid-switch (health throws). */
let mockUpdateDown = false;

function mockUpdateChannels(): UpdateChannel[] {
  const { current } = readUpdatePersisted();
  return MOCK_UPDATE_CHANNELS.map((c) => ({ ...c, current: c.ref === current }));
}

function mockUpdateBuild(): UpdateBuildInfo | null {
  const { current } = readUpdatePersisted();
  const found = MOCK_UPDATE_CHANNELS.find((c) => c.ref === current);
  if (!found?.version) return null;
  let staleCommit: string | null = null;
  try {
    staleCommit = localStorage.getItem(UPDATE_INSTALLED_COMMIT_KEY);
  } catch {
    staleCommit = null;
  }
  return {
    version: found.version,
    channel: found.ref,
    sourceBranch: found.sourceBranch,
    sourceCommit: staleCommit ?? found.sourceCommit,
    baseBranch: found.baseBranch,
    baseCommit: found.baseCommit,
    commit: staleCommit ?? found.commit,
    builtAt: staleCommit ? new Date(NOW - 3 * 86400_000).toISOString() : found.builtAt,
  };
}

/** #92: loading snapshot for a mock loading list entry. */
function mockLoadingSnapshot(entry: ReviewSummary): ReviewSnapshot {
  const now = Date.now();
  return {
    review: {
      id: entry.id,
      repoId: entry.repoId,
      branch: entry.branch,
      ...(entry.prNumber !== undefined ? { prNumber: entry.prNumber } : {}),
      versions: [],
      currentVersion: 0,
      createdAt: entry.createdAt,
    },
    version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
    files: [],
    pages: [],
    annotations: [],
    hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
    jobs: [],
    contributions: [],
    logTail: [],
    rev: 1,
    ingest: { status: "loading", step: entry.ingestStep ?? "fetching" },
  };
}

/** #92: failed snapshot for a mock failed list entry. */
function mockFailedSnapshot(entry: ReviewSummary, error: string): ReviewSnapshot {
  const now = Date.now();
  return {
    review: {
      id: entry.id,
      repoId: entry.repoId,
      branch: entry.branch,
      ...(entry.prNumber !== undefined ? { prNumber: entry.prNumber } : {}),
      versions: [],
      currentVersion: 0,
      createdAt: entry.createdAt,
    },
    version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
    files: [],
    pages: [],
    annotations: [],
    hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
    jobs: [],
    contributions: [],
    logTail: [],
    rev: 1,
    ingest: { status: "failed", error },
  };
}

// --- custom guides ---------------------------------------------------------

/**
 * Custom guides in mock mode: any request produces a guide over the
 * demo's header-unfolding code and its unit tests (the socket-level test
 * and the changelog stay out, so the diff visibly narrows), with two
 * sections, two plotlines and one suggested diff comment. The run goes
 * "working" (the first section streams in, then the second) and lands
 * "ready". A request naming a relative day ("today", "yesterday") is
 * ambiguous: the guide goes "needs-input" with a question first and
 * generates once the reader answers.
 */
let mockGuides: CustomGuide[] = [];
let mockGuideSeq = 0;
const MOCK_GUIDE_AMBIGUOUS = /\b(today|yesterday)\b/i;

function emitGuides(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "replace", path: "/guides", value: JSON.parse(JSON.stringify(mockGuides)) }],
  });
}

function mockGuideText(prompt: string): string {
  const text = prompt.trim();
  if (text === "") throw new Error("prompt is required");
  if (text.length > CUSTOM_GUIDE_PROMPT_MAX) {
    throw new Error(`prompt must be at most ${CUSTOM_GUIDE_PROMPT_MAX} characters`);
  }
  return text;
}

function mockGuideCard(guideId: string, n: number, title: string, text: string, cite: string): import("@unvibe/shared").Card {
  return {
    id: customGuideCardId(guideId, n),
    pageId: customGuidePageId(guideId),
    title,
    level: "standard",
    collapsed: false,
    revision: 1,
    undoStack: [],
    blocks: [
      {
        type: "paragraph",
        id: "b1",
        text: { standard: text, simple: text, deep: text },
        citations: [{ target: cite }],
      } as unknown as import("@unvibe/shared").Block,
    ],
  };
}

/** Write the guide's root page with its first `n` sections. */
function setMockGuidePage(guide: CustomGuide, n: number): void {
  const conn = MOCK_FILES.find((f) => f.path === "src/urllib3/connection.py");
  const tconn = MOCK_FILES.find((f) => f.path === "test/test_connection.py");
  const cards = [
    mockGuideCard(
      guide.id,
      1,
      "Where folded values get unfolded",
      "The response's headers are normalized once, where urllib3 copies them into its own header type: each obsolete fold becomes a single space before any caller reads the value.",
      `diff:${conn?.fileKey ?? ""}:${conn?.hunks[0]?.newStart ?? 1}`,
    ),
    mockGuideCard(
      guide.id,
      2,
      "How the tests pin it down",
      "The unit tests feed folded values through the same path and check that no CR or LF survives in what callers see.",
      `diff:${tconn?.fileKey ?? ""}:${tconn?.hunks[0]?.newStart ?? 1}`,
    ),
  ].slice(0, n);
  const page: import("@unvibe/shared").Page = {
    id: guide.pageId,
    kind: "guide",
    title: guide.title,
    guideId: guide.id,
    cards,
  };
  const idx = mockPages.findIndex((p) => p.id === guide.pageId);
  if (idx >= 0) mockPages[idx] = page;
  else mockPages.push(page);
  emitPages();
}

/** The guide's scope, plotlines and suggested comment (the agent's reply). */
function finishMockGuide(guide: CustomGuide): void {
  const conn = MOCK_FILES.find((f) => f.path === "src/urllib3/connection.py");
  const tconn = MOCK_FILES.find((f) => f.path === "test/test_connection.py");
  const ids = (f: (typeof MOCK_FILES)[number] | undefined): string[] =>
    f ? f.hunks.map((h) => `h:${f.fileKey}:${h.contentHash}`) : [];
  const core = ids(conn);
  const tests = ids(tconn);
  guide.hunks = [...core, ...tests];
  guide.commits = [MOCK_VERSION.headSha];
  guide.scopeNote = "The header-unfolding change and its unit tests; the socket-level test and the changelog are left out.";
  guide.plotlines = [
    { id: "g-core", name: "Normalize on read", description: "Folds become spaces where headers are copied." },
    { id: "g-tests", name: "Pin it with tests", description: "Unit coverage for folded values.", buildsOn: "g-core" },
  ];
  guide.assignment = Object.fromEntries([
    ...core.map((h) => [h, "g-core"] as const),
    ...tests.slice(0, 2).map((h) => [h, "g-tests"] as const),
  ]);
  guide.version = MOCK_VERSION.n;
  delete guide.stale;
  // A rerun replaces the guide's suggestions the reader has not marked.
  annotations = annotations.filter((a) => a.guideId !== guide.id || a.post);
  const hunk = conn?.hunks[0];
  const line = hunk?.lines.find((l) => l.kind === "add")?.newLine ?? hunk?.newStart ?? 1;
  annotations.push({
    id: `ann_mockcg${guide.id.slice(3)}${mockGuideSeq}`,
    type: "comment",
    guideId: guide.id,
    anchor: {
      host: { kind: "diff-line", fileKey: conn?.fileKey ?? "", line },
      quotedText: "",
      prefix: "",
      suffix: "",
      position: 0,
      version: 1,
    },
    open: true,
    pinned: false,
    messages: [
      {
        who: "ai",
        text: "Worth a test where the fold uses a bare LF, not CRLF: this path should unfold both.",
        suggested: true,
      },
    ],
    post: false,
  });
  emitAnnotations();
}

/** One mock generation run: working → sections stream in → ready. */
async function runMockGuide(guideId: string): Promise<string> {
  const guide = mockGuides.find((g) => g.id === guideId);
  if (!guide) throw new Error("unknown custom guide");
  mockGuideSeq += 1;
  const jobId = `job_mockcg_${mockGuideSeq}`;
  guide.status = "working";
  guide.jobId = jobId;
  delete guide.question;
  delete guide.error;
  trackMockJob(jobId, "custom-guide");
  emitGuides();
  const live = (): CustomGuide | undefined => {
    const g = mockGuides.find((x) => x.id === guideId);
    return g && g.jobId === jobId ? g : undefined;
  };
  void (async () => {
    await wait(500);
    const first = live();
    if (!first) return;
    setMockGuidePage(first, 1);
    await wait(700);
    const done = live();
    if (!done) return;
    finishMockGuide(done);
    setMockGuidePage(done, 2);
    done.status = "ready";
    delete done.jobId;
    settleMockJob(jobId);
    emitGuides();
  })();
  return jobId;
}

function mockGuideResponse(guideId: string, jobId?: string): CustomGuideResponse {
  const guide = mockGuides.find((g) => g.id === guideId);
  if (!guide) throw new Error("unknown custom guide");
  return { guide: JSON.parse(JSON.stringify(guide)) as CustomGuide, ...(jobId !== undefined ? { jobId } : {}) };
}

/** Mock guide ideas: a short "working" state, then ideas for the demo change. */
let mockGuideSuggestions: CustomGuideSuggestions | undefined;
const MOCK_SUGGESTIONS: CustomGuideSuggestion[] = [
  { label: "Header unfolding", prompt: "Explain how folded header values are unfolded and which inputs still pass through unchanged." },
  { label: "Injection risks", prompt: "Security review: can a header value still carry a CR or LF into the request? Only the hunks that build or validate headers." },
  { label: "What the tests prove", prompt: "Walk through the new tests: what each one proves about unfolding and which edge cases are not covered." },
  { label: "Today's commits", prompt: "What changed in today's commits?" },
];

function emitGuideSuggestions(): void {
  const baseRev = rev;
  rev += 1;
  useReview.getState().applyEvent({
    type: "patch",
    baseRev,
    headRev: rev,
    ops: [{ op: "add", path: "/guideSuggestions", value: JSON.parse(JSON.stringify(mockGuideSuggestions)) }],
  });
}

const mockGuideApi = {
  suggestGuides: async (): Promise<{ suggestions: CustomGuideSuggestions | null; jobId?: string }> => {
    await wait(40);
    if (mockGuideSuggestions && mockGuideSuggestions.status !== "failed") return { suggestions: mockGuideSuggestions };
    mockGuideSuggestions = { version: 1, status: "working", items: [] };
    emitGuideSuggestions();
    setTimeout(() => {
      mockGuideSuggestions = { version: 1, status: "ready", items: MOCK_SUGGESTIONS };
      emitGuideSuggestions();
    }, 600);
    return { suggestions: mockGuideSuggestions };
  },
  createGuide: async (_id: string, body: { prompt: string }): Promise<CustomGuideResponse> => {
    await wait(80);
    const prompt = mockGuideText(body.prompt);
    const id = `gd-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
    const now = Date.now();
    const guide: CustomGuide = {
      id,
      title: customGuideFallbackTitle(prompt),
      prompt,
      turns: [{ who: "you", text: prompt, at: now }],
      status: "working",
      pageId: customGuidePageId(id),
      commits: [],
      hunks: [],
      plotlines: [],
      assignment: {},
      version: MOCK_VERSION.n,
      createdAt: now,
    };
    mockGuides.push(guide);
    if (MOCK_GUIDE_AMBIGUOUS.test(prompt)) {
      const question =
        "Which commits count as today's: the ones authored today, or the ones pushed to the branch today?";
      guide.status = "needs-input";
      guide.question = question;
      guide.turns.push({ who: "agent", text: question, at: now });
      emitGuides();
      return mockGuideResponse(id);
    }
    const jobId = await runMockGuide(id);
    return mockGuideResponse(id, jobId);
  },

  answerGuide: async (_id: string, guideId: string, body: { answer: string }): Promise<CustomGuideResponse> => {
    await wait(80);
    const answer = mockGuideText(body.answer);
    const guide = mockGuides.find((g) => g.id === guideId);
    if (!guide) throw new Error("unknown custom guide");
    if (guide.status !== "needs-input") throw new Error("the guide is not waiting for an answer");
    guide.turns.push({ who: "you", text: answer, at: Date.now() });
    const jobId = await runMockGuide(guideId);
    return mockGuideResponse(guideId, jobId);
  },

  regenerateGuide: async (_id: string, guideId: string): Promise<CustomGuideResponse> => {
    await wait(80);
    const jobId = await runMockGuide(guideId);
    return mockGuideResponse(guideId, jobId);
  },

  deleteGuide: async (_id: string, guideId: string): Promise<void> => {
    await wait(60);
    const guide = mockGuides.find((g) => g.id === guideId);
    if (!guide) throw new Error("unknown custom guide");
    if (guide.jobId) {
      const job = mockJobs.find((j) => j.id === guide.jobId);
      if (job && job.state === "running") {
        job.state = "cancelled";
        emitJobs();
      }
    }
    mockGuides = mockGuides.filter((g) => g.id !== guideId);
    mockPages = mockPages.filter((p) => p.guideId !== guideId);
    annotations = annotations.filter((a) => a.guideId !== guideId || a.post);
    if (mockDiffFilter?.guideId === guideId) {
      mockDiffFilter = mockDiffFilter.score !== undefined ? { score: mockDiffFilter.score } : undefined;
      emitDiffFilter();
    }
    emitPages();
    emitAnnotations();
    emitGuides();
  },
};

export const mockApi = {
  ...mockGuideApi,
  health: async () => {
    if (mockUpdateDown) throw new Error("mock service restarting");
    return { ok: true as const, version: "mock", build: mockUpdateBuild() };
  },

  repos: async (): Promise<ReposResponse> => ({ repos: getRepos() }),

  addRepo: async (body: AddRepoRequest): Promise<AddRepoResponse> => {
    // #27: mirror the service contract — path adds a local checkout, url
    // clones a managed repo. Test hooks: `unvibe.mock.addRepoHold` holds
    // the clone so specs can observe the busy state,
    // `unvibe.mock.addRepoDelayMs` sets extra latency (default 150 ms),
    // `unvibe.mock.addRepoFail` fails with that error text. Invalid URLs
    // 400 like the service (the UI validates first with the same parser).
    const raw = body.url ?? body.path ?? "";
    if (body.url) {
      let parsed: { owner: string; name: string; prNumber?: number };
      try {
        parsed = parseGitHubRepoInput(raw);
      } catch (err) {
        throw new Error(`POST /api/repos: 400 ${JSON.stringify({ error: (err as Error).message })}`);
      }
      await awaitAddRelease();
      await wait(addRepoDelayMs());
      const forced = addRepoFailure();
      if (forced) {
        throw new Error(`POST /api/repos: 404 ${JSON.stringify({ error: forced })}`);
      }
      const { owner, name, prNumber } = parsed;
      const repo: Repo = {
        id: `managed-${owner.toLowerCase()}-${name.toLowerCase()}`,
        owner,
        name,
        localPath: `/mock/data/repos/${owner.toLowerCase()}/${name.toLowerCase()}`,
        lastOpened: Date.now(),
        managed: true,
      };
      try {
        const added = readJson<Repo[]>(ADDED_KEY, []);
        if (!added.some((r) => r.id === repo.id)) {
          localStorage.setItem(ADDED_KEY, JSON.stringify([repo, ...added]));
        }
      } catch {
        // Non-fatal.
      }
      const out: AddRepoResponse = { repos: getRepos() };
      if (prNumber !== undefined) out.prNumber = prNumber;
      return out;
    }
    const name = raw.split("/").filter(Boolean).pop() ?? raw;
    const repo: Repo = {
      id: `local-${name}`,
      owner: "local",
      name,
      localPath: raw,
      lastOpened: Date.now(),
    };
    try {
      const added = readJson<Repo[]>(ADDED_KEY, []);
      localStorage.setItem(ADDED_KEY, JSON.stringify([repo, ...added]));
    } catch {
      // Non-fatal.
    }
    return { repos: getRepos() };
  },

  removeRepo: async (id: string): Promise<RemoveRepoResponse> => {
    // #27: mirror the service — refuse while mock reviews reference the
    // repo (the seed urllib3 repo has sessions, so removing it 409s).
    const reviews = mockSummaries();
    const n = reviews.filter((r) => r.repoId === id).length;
    if (n > 0) {
      const repo = getRepos().find((r) => r.id === id);
      const label = repo ? `${repo.owner}/${repo.name}` : id;
      throw new Error(
        `DELETE /api/repos/${id}: 409 ${JSON.stringify({ error: `repo ${label} still has ${n} review${n === 1 ? "" : "s"} — delete ${n === 1 ? "it" : "them"} first, then remove the repo` })}`,
      );
    }
    try {
      const added = readJson<Repo[]>(ADDED_KEY, []);
      const found = added.find((r) => r.id === id);
      localStorage.setItem(ADDED_KEY, JSON.stringify(added.filter((r) => r.id !== id)));
      return { ok: true as const, removedClone: found?.managed === true };
    } catch {
      return { ok: true as const, removedClone: false };
    }
  },

  /** Mock folder dialog (#26): pretends the user picked a checkout. */
  pickFolder: async (): Promise<PickFolderResponse> => {
    await wait(50);
    return { status: "picked", path: "/mock/picked/checkout" };
  },

  repoChanges: async (id: string, filter?: ChangesFilter): Promise<RepoChangesResponse> => {
    // Test-only hooks for the start page (all no-ops unless set):
    // - `unvibe.mock.repoChangesHold`: when present, hold every repo-lists
    //   response until the key is removed, so specs can observe the loading
    //   state (the repo-less demo entry is never held);
    // - `unvibe.mock.repoChangesFail`: JSON array of filters to reject
    //   (e.g. ["authoring","review-requested","recent"]), each with a
    //   service-shaped 500 carrying a mock gh error.
    // - `unvibe.mock.repoChangesFetchError`: when present, every response
    //   carries it as `fetchError` (stale managed clone, like the service).
    if (id !== "demo") await awaitChangesRelease();
    const failing = readChangesFailures();
    const key = filter ?? "all";
    if (failing.includes(key)) {
      throw new Error(`GET /api/repos/${id}/changes?filter=${key}: 500 {"error":"mock gh is down"}`);
    }
    const authoring: RepoChange[] = [
      {
        kind: "pr",
        title: "Unfold obsolete folded response header values",
        prNumber: 5020,
        branch: "fix-obs-fold",
        author: "you",
        updatedAt: NOW - 3600000,
        url: "https://github.com/urllib3/urllib3/pull/5020",
        additions: 42,
        deletions: 18,
        changedFiles: 4,
      },
      {
        // #91: keep one branch-less row (as when `gh` omits the head
        // branch) so the row text (no "undefined", no dangling separator)
        // stays exercised.
        kind: "pr",
        title: "Fix retry backoff on 429s",
        prNumber: 5011,
        author: "you",
        updatedAt: NOW - 86400000 * 2,
        url: "https://github.com/urllib3/urllib3/pull/5011",
        additions: 120,
        deletions: 34,
        changedFiles: 6,
      },
    ];
    // #95: review requests split by scope (newest first, like the
    // service): asked of you (#5019 both + #5018 direct) and of your team
    // (#5017 recent, #5016 older than every filter window).
    const requested: RepoChange[] = [
      {
        kind: "pr",
        title: "Docs: clarify retry wording",
        prNumber: 5019,
        branch: "docs-retry-words",
        author: "teammate",
        updatedAt: NOW - 1800000,
        url: "https://github.com/urllib3/urllib3/pull/5019",
        additions: 9,
        deletions: 2,
        changedFiles: 1,
        reviewScope: "direct",
        requestedTeams: ["docs"],
      },
      {
        kind: "pr",
        title: "Pool: reuse connections across redirects",
        prNumber: 5018,
        branch: "pool-redirect-reuse",
        author: "teammate",
        updatedAt: NOW - 7200000,
        url: "https://github.com/urllib3/urllib3/pull/5018",
        additions: 545,
        deletions: 280,
        changedFiles: 30,
        reviewScope: "direct",
      },
      {
        kind: "pr",
        title: "CI: pin the lint action",
        prNumber: 5017,
        branch: "ci-pin-lint",
        author: "teammate",
        updatedAt: NOW - 86400000 * 2,
        url: "https://github.com/urllib3/urllib3/pull/5017",
        additions: 3,
        deletions: 3,
        changedFiles: 1,
        reviewScope: "team",
        requestedTeams: ["core"],
      },
      {
        kind: "pr",
        title: "Changelog: backfill old entries",
        prNumber: 5016,
        branch: "changelog-backfill",
        author: "teammate",
        updatedAt: NOW - 86400000 * 20,
        url: "https://github.com/urllib3/urllib3/pull/5016",
        reviewScope: "team",
        requestedTeams: ["core"],
      },
    ];
    const branches: RepoChange[] = [
      { kind: "branch", title: "fix-obs-fold", branch: "fix-obs-fold", updatedAt: NOW - 3600000 },
      { kind: "branch", title: "main", branch: "main", updatedAt: NOW - 86400000 },
      {
        kind: "branch",
        title: "experiment/lazy-headers",
        branch: "experiment/lazy-headers",
        updatedAt: NOW - 86400000 * 3,
      },
    ];
    // Previous reviews with stale state, like the service's `repoChanges`.
    const previous: RepoChange[] = [
      {
        kind: "review",
        title: "#5020 · fix-obs-fold",
        prNumber: 5020,
        branch: "fix-obs-fold",
        reviewId: "demo",
        stale: false,
      },
      {
        kind: "review",
        title: "#5011 · fix-retry-backoff",
        prNumber: 5011,
        branch: "fix-retry-backoff",
        reviewId: "r-old",
        stale: true,
      },
    ];
    void id;
    // Demo entry point: the start page fetches `repoChanges("demo")` and
    // renders `kind: "demo"` changes as a row inside the Reviews list (no
    // tokens, same pipeline path). Like the service, the demo answers no
    // filtered section.
    if (id === "demo") {
      return {
        changes: [
          {
            kind: "demo",
            title: "Demo: urllib3#5020 — Unfold obsolete folded response headers",
            demo: "urllib3-5020",
          },
        ],
      };
    }
    switch (filter) {
      case "authoring":
        return withFetchNote({ changes: markMockChanges(authoring, id) });
      case "review-requested":
        return withFetchNote({ changes: markMockChanges(requested, id) });
      case "branches":
        return withFetchNote({ changes: markMockChanges(branches, id) });
      case "recent":
        return withFetchNote({ changes: [...markMockChanges(branches, id), ...previous] });
      default:
        return withFetchNote({
          changes: [
            ...markMockChanges(authoring, id),
            ...markMockChanges(requested, id),
            ...markMockChanges(branches, id),
            ...previous,
          ],
        });
    }

    /** Attach the stale-clone note when the `repoChangesFetchError` hook is set. */
    function withFetchNote(res: RepoChangesResponse): RepoChangesResponse {
      const note = changesFetchError();
      return note ? { ...res, fetchError: note } : res;
    }
  },

  repoWorktrees: async (id: string) => {
    const repo = getRepos().find((r) => r.id === id);
    return { worktrees: repo ? [{ path: repo.localPath, branch: "main" }] : [] };
  },

  createDocument: async (body: CreateDocumentRequest): Promise<ReviewSnapshot> => {
    const document = parseDocumentMarkdown(body.markdown);
    if (typeof body.title === "string" && body.title.trim() !== "") document.title = body.title.trim();
    const first = body.contextRepos[0];
    const now = Date.now();
    const id = `mock-doc-${now.toString(36)}`;
    const version: Version = { n: 1, headSha: "mockdoc", mergeBaseSha: "mockdoc", baseRef: "document", fetchedAt: now, idMapping: {} };
    return {
      review: { id, repoId: first?.repoId ?? "demo", branch: "document", versions: [version], currentVersion: 1, createdAt: now },
      document,
      contextRepos: body.contextRepos.map((pick) => {
        const r = getRepos().find((x) => x.id === pick.repoId);
        return {
          repoId: pick.repoId,
          owner: r?.owner ?? "local",
          name: r?.name ?? pick.repoId,
          source: pick.source,
          repoPath: r?.localPath ?? "",
          path: pick.worktreePath ?? r?.localPath ?? "",
          label: `${r?.owner ?? "local"}/${r?.name ?? pick.repoId}`,
        };
      }),
      version,
      files: [],
      pages: [],
      annotations: [],
      hunkStates: [],
      fileStates: [],
      viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
      jobs: [],
      contributions: [],
      logTail: [],
      rev: 1,
      ingest: { status: "ready" },
    };
  },

  createReview: async (body: CreateReviewRequest): Promise<CreateReviewResponse> => {
    // #92 hooks for Playwright (mock mode):
    // - `unvibe.mock.createReviewHold`: return a loading snapshot that stays
    //   loading until the key is removed (then `review()` serves ready).
    // - `unvibe.mock.createReviewFail`: return a failed snapshot with that
    //   error text (retry succeeds once the key is removed).
    let hold = false;
    let fail: string | null = null;
    try {
      hold = localStorage.getItem("unvibe.mock.createReviewHold") !== null;
      fail = localStorage.getItem("unvibe.mock.createReviewFail");
      if (fail === "") fail = null;
    } catch {
      // Ignore.
    }
    // #149: reuse the existing review for the same source, like the service.
    const existing = findMockReview(body.repoId, body.pr, body.branch);
    if (existing) {
      if (existing.ingestStatus === "loading") return { ...mockLoadingSnapshot(existing), reused: true };
      if (existing.ingestStatus === "failed") {
        return { ...mockFailedSnapshot(existing, existing.ingestError ?? "the review couldn't be opened"), reused: true };
      }
      existing.lastOpened = Date.now();
      return { ...currentSnapshot(existing.id), reused: true };
    }
    if (fail) {
      const id = `mock-failed-${Date.now().toString(36)}`;
      const title =
        typeof body.title === "string" && body.title.trim() !== ""
          ? body.title
          : body.pr !== undefined
            ? `PR #${body.pr}`
            : (body.branch ?? "review");
      const branch = body.branch ?? (body.pr !== undefined ? `pr-${body.pr}` : "branch");
      mockReviewList.unshift({
        id,
        repoId: body.repoId,
        repoOwner: "mock",
        repoName: "mock",
        title,
        branch,
        ...(body.pr !== undefined ? { prNumber: body.pr } : {}),
        createdAt: Date.now(),
        lastOpened: Date.now(),
        versionCount: 0,
        currentVersion: 0,
        stale: false,
        totalHunks: 0,
        reviewedHunks: 0,
        pendingComments: 0,
        guideStatus: "idle",
        ingestStatus: "failed",
        ingestError: fail,
      });
      const now = Date.now();
      return {
        review: {
          id,
          repoId: body.repoId,
          branch,
          ...(body.pr !== undefined ? { prNumber: body.pr } : {}),
          versions: [],
          currentVersion: 0,
          createdAt: now,
        },
        version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
        files: [],
        pages: [],
        annotations: [],
        hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
        jobs: [],
        contributions: [],
        logTail: [],
        rev: 1,
        ingest: { status: "failed", error: fail },
      };
    }
    if (hold) {
      const id = `mock-loading-${Date.now().toString(36)}`;
      const title =
        typeof body.title === "string" && body.title.trim() !== ""
          ? body.title
          : body.pr !== undefined
            ? `PR #${body.pr}`
            : (body.branch ?? "review");
      const branch = body.branch ?? (body.pr !== undefined ? `pr-${body.pr}` : "branch");
      const step = "fetching";
      mockReviewList.unshift({
        id,
        repoId: body.repoId,
        repoOwner: "mock",
        repoName: "mock",
        title,
        branch,
        ...(body.pr !== undefined ? { prNumber: body.pr } : {}),
        createdAt: Date.now(),
        lastOpened: Date.now(),
        versionCount: 0,
        currentVersion: 0,
        stale: false,
        totalHunks: 0,
        reviewedHunks: 0,
        pendingComments: 0,
        guideStatus: "idle",
        ingestStatus: "loading",
        ingestStep: step,
      });
      const now = Date.now();
      return {
        review: {
          id,
          repoId: body.repoId,
          branch,
          ...(body.pr !== undefined ? { prNumber: body.pr } : {}),
          versions: [],
          currentVersion: 0,
          createdAt: now,
        },
        version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
        files: [],
        pages: [],
        annotations: [],
        hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
        jobs: [],
        contributions: [],
        logTail: [],
        rev: 1,
        ingest: { status: "loading", step },
      };
    }
    await wait(150);
    return currentSnapshot("demo");
  },

  retryReview: async (id: string): Promise<ReviewSnapshot> => {
    await wait(100);
    let fail: string | null = null;
    try {
      fail = localStorage.getItem("unvibe.mock.createReviewFail");
      if (fail === "") fail = null;
    } catch {
      // Ignore.
    }
    const entry = mockReviewList.find((r) => r.id === id);
    if (!entry) throw new Error(`POST /api/reviews/${id}/retry: 404 {"error":"unknown review"}`);
    if (entry.ingestStatus === "loading") {
      // Already running — return the loading snapshot.
      return mockLoadingSnapshot(entry);
    }
    if (fail) {
      entry.ingestStatus = "failed";
      entry.ingestError = fail;
      delete entry.ingestStep;
      return mockFailedSnapshot(entry, fail);
    }
    delete entry.ingestStep;
    delete entry.ingestError;
    entry.ingestStatus = "ready";
    entry.versionCount = 1;
    entry.currentVersion = 1;
    entry.guideStatus = "ready";
    return currentSnapshot(id);
  },

  reviews: async (): Promise<ReviewsListResponse> => {
    await wait(50);
    return { reviews: mockSummaries() };
  },

  deleteReview: async (id: string): Promise<{ ok: boolean }> => {
    await wait(50);
    const i = mockReviewList.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`DELETE /api/reviews/${id}: 404 {"error":"unknown review"}`);
    mockReviewList.splice(i, 1);
    return { ok: true };
  },

  redoReview: async (id: string): Promise<ReviewSnapshot> => {
    await wait(50);
    if (id === "demo")
      throw new Error(`POST /api/reviews/${id}/redo: 409 {"error":"the demo guide can't be re-done"}`);
    const i = mockReviewList.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`POST /api/reviews/${id}/redo: 404 {"error":"unknown review"}`);
    const old = mockReviewList[i];
    if (old.ingestStatus === "loading")
      throw new Error(`POST /api/reviews/${id}/redo: 409 {"error":"the review is still opening"}`);
    if (old.ingestStatus === "failed")
      throw new Error(
        `POST /api/reviews/${id}/redo: 409 {"error":"${old.ingestError ?? "the review couldn't be opened"}"}`,
      );
    // Same as delete + create: the old row goes, a new loading review
    // takes its source (repo, PR/branch, title).
    const newId = `mock-loading-${Date.now().toString(36)}`;
    mockReviewList.splice(i, 1);
    const entry = {
      ...old,
      id: newId,
      lastOpened: Date.now(),
      versionCount: 0,
      currentVersion: 0,
      stale: false,
      guideStatus: "idle" as const,
      ingestStatus: "loading" as const,
      ingestStep: "fetching" as const,
    };
    delete (entry as { ingestError?: string }).ingestError;
    mockReviewList.unshift(entry);
    return mockLoadingSnapshot(entry);
  },

  resetData: async (): Promise<ResetDataResponse> => {
    await wait(50);
    const reviewsRemoved = mockReviewList.length;
    mockReviewList.length = 0;
    return { ok: true, reviewsRemoved };
  },

  readiness: async (): Promise<ReadinessResponse> => {
    await wait(50);
    return readMockReadiness();
  },

  diagramSvg: async (
    _reviewId: string,
    hash: string,
    theme: "light" | "dark",
  ): Promise<string> => {
    await wait(30);
    return mockDiagramSvg(hash, theme);
  },

  review: async (id: string, version?: number): Promise<ReviewSnapshot> => {
    await wait(50);
    // #92: mock loading/failed reviews — stateless by id prefix + hooks so
    // the status survives SPA navigation even if the list entry is gone.
    try {
      if (id.startsWith("mock-loading-")) {
        const hold = localStorage.getItem("unvibe.mock.createReviewHold") !== null;
        const entry = mockReviewList.find((r) => r.id === id);
        if (hold) {
          if (entry) return mockLoadingSnapshot(entry);
          const now = Date.now();
          return {
            review: { id, repoId: "urllib3", branch: "feature", versions: [], currentVersion: 0, createdAt: now },
            version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
            files: [],
            pages: [],
            annotations: [],
            hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
            jobs: [],
            contributions: [],
            logTail: [],
            rev: 1,
            ingest: { status: "loading", step: "fetching" },
          };
        }
        if (entry) {
          entry.ingestStatus = "ready";
          delete entry.ingestStep;
          entry.versionCount = 1;
          entry.currentVersion = 1;
          entry.guideStatus = "ready";
        }
        return currentSnapshot(id, version);
      }
      if (id.startsWith("mock-failed-")) {
        const fail = localStorage.getItem("unvibe.mock.createReviewFail");
        const entry = mockReviewList.find((r) => r.id === id);
        if (fail) {
          if (entry) return mockFailedSnapshot(entry, fail);
          const now = Date.now();
          return {
            review: { id, repoId: "urllib3", branch: "feature", versions: [], currentVersion: 0, createdAt: now },
            version: { n: 0, headSha: "", mergeBaseSha: "", baseRef: "", fetchedAt: now, idMapping: {} },
            files: [],
            pages: [],
            annotations: [],
            hunkStates: [],
    fileStates: [],
    viewPrefs: { showExistingComments: true, existingCommentsCollapsed: false },
            jobs: [],
            contributions: [],
            logTail: [],
            rev: 1,
            ingest: { status: "failed", error: fail },
          };
        }
        if (entry) {
          entry.ingestStatus = "ready";
          delete entry.ingestError;
          entry.versionCount = 1;
          entry.currentVersion = 1;
          entry.guideStatus = "ready";
        }
        return currentSnapshot(id, version);
      }
    } catch {
      // Fall through to the list lookup below.
    }
    // #92: mock loading/failed reviews (created via the hold/fail hooks).
    const entry = mockReviewList.find((r) => r.id === id);
    if (entry?.ingestStatus === "loading") {
      let hold = false;
      try {
        hold = localStorage.getItem("unvibe.mock.createReviewHold") !== null;
      } catch {
        // Ignore.
      }
      if (hold) return mockLoadingSnapshot(entry);
      // Hold released: the ingest lands — flip to ready like the service.
      entry.ingestStatus = "ready";
      delete entry.ingestStep;
      entry.versionCount = 1;
      entry.currentVersion = 1;
      entry.guideStatus = "ready";
      return currentSnapshot(id, version);
    }
    if (entry?.ingestStatus === "failed") {
      let fail: string | null = null;
      try {
        fail = localStorage.getItem("unvibe.mock.createReviewFail");
        if (fail === "") fail = null;
      } catch {
        // Ignore.
      }
      const error = fail ?? entry.ingestError ?? "mock ingest failed";
      return mockFailedSnapshot(entry, error);
    }
    if (isStaleReview(id) && version !== undefined && version !== 1 && version !== 2) {
      throw new Error(`GET /api/reviews/${id}?version=${version}: 404 {"error":"unknown version ${version}"}`);
    }
    return currentSnapshot(id, version);
  },

  refresh: async (id: string): Promise<RefreshResponse> => {
    await wait(100);
    if (isStaleReview(id)) {
      const status = staleVersionStatus();
      return {
        review: { ...MOCK_REVIEW, id, currentVersion: 2 },
        newVersion: true,
        comparison: {
          oldVersion: status.fromVersion,
          newVersion: status.toVersion,
          oldHeadSha: MOCK_VERSION.headSha,
          newHeadSha: "e4f5a6b7c8",
          renames: [],
          rangeDiff: status.rangeDiff,
          unchangedHunks: status.unchangedHunks,
          changedHunks: status.changedHunks,
          newHunks: status.newHunks,
          removedHunks: status.removedHunks,
          changedOldIds: status.changedOldIds,
          changedNewIds: status.changedNewIds,
        },
        version: { ...MOCK_VERSION, n: 2 },
      };
    }
    return { review: MOCK_REVIEW, newVersion: false };
  },

  update: async (id: string): Promise<UpdateReviewResponse> => {
    await wait(100);
    const jobId = `mock-update-${id}`;
    trackMockJob(jobId, "update-pass");
    window.setTimeout(() => settleMockJob(jobId), 800);
    return { jobId, toVersion: isStaleReview(id) ? 2 : 1 };
  },

  resume: async (): Promise<ResumeReviewResponse> => {
    await wait(50);
    return { resumed: false, jobIds: [], pendingStages: [] };
  },

  action: async (_id: string, a: ReviewAction): Promise<ActionResponse> => {
    // Fill one conversation turn after a delay, like the service seam.
    // Held while `unvibe.mock.turnFillHold` is set (issue #152), and
    // mirrored onto the promoted page card when the turn moved (issue
    // #152: Open as page mid-fill keeps filling the page).
    const answerTurnLater = (tid: string, turnId: string, text: string, jobId: string): void => {
      window.setTimeout(() => {
        void (async () => {
          await awaitTurnFillRelease();
          settleMockJob(jobId);
          const live = annotations.find((x) => x.id === tid);
          const turn = live && (live.type === "conversation" || live.type === "link") ? (live.turns ?? []).find((t) => t.id === turnId) : undefined;
          if (!live || !turn) return;
          turn.blocks = mockExplainBlocks(text || live.anchor.quotedText) as never;
          turn.revision += 1;
          turn.working = null;
          turn.error = null;
          turn.jobId = undefined;
          live.working = null;
          live.error = null;
          live.jobId = undefined;
          delete live.reply;
          mirrorMockPromotedTurn(tid, turnId);
          dropSettledMockPromotedTurns(tid);
          emitAnnotations();
        })();
      }, 700);
    };
    // Second opinion (mock): canned verdicts through the patch path so
    // mock-mode e2e exercises the result block, disagreement styling and
    // the mode switch without a service. Blind → partly, check →
    // disagrees (prominent warn styling).
    if (a.kind === "second_opinion") {
      const jobId = `mock-so-${a.cardId}-${a.mode}-${++mockSoSeq}`;
      const verdict = a.mode === "blind" ? "partly" : "disagrees";
      const missed =
        a.mode === "blind" ? "A lone CR ending is untested too." : "Set-Cookie comma handling is out of scope.";
      const resultId = `so-${a.cardId}-${a.mode}-mock-second`;
      const result = {
        id: resultId,
        cardId: a.cardId,
        mode: a.mode,
        provider: "codex",
        model: "mock-second",
        verdict,
        reasoning: verdict === "partly" ? "Checked the helper; gap is real but narrow." : "Only CRLF-folded values are rewritten.",
        blocks: [
          {
            type: "paragraph",
            id: "b-so-1",
            text: {
              standard:
                verdict === "partly"
                  ? `Partly — the gap is real but narrow. The helper handles the fold.`
                  : `Disagrees — only CRLF-folded values are rewritten.`,
            },
            citations: [{ target: "diff:src-urllib3-connection.py:80-82" }],
          },
        ],
        missed,
        version: 1,
        createdAt: Date.now(),
        jobId,
      };
      trackMockJob(jobId, "second-opinion", { cardId: a.cardId });
      const timer = window.setTimeout(() => {
        pendingSecondOpinions = pendingSecondOpinions.filter((p) => p.jobId !== jobId);
        settleMockJob(jobId);
        // Answers store the result on the turn (survives depth/undo);
        // page cards store on the card.
        let storedOnAnswer = false;
        for (const ann of annotations) {
          const turn = (ann.turns ?? []).find((t) => t.id === a.cardId);
          if (!turn) continue;
          const rest = (turn.secondOpinions ?? []).filter((s) => (s as { mode: string }).mode !== a.mode);
          turn.secondOpinions = [...rest, { ...result, cardId: turn.id } as never];
          storedOnAnswer = true;
        }
        if (storedOnAnswer) {
          emitAnnotations();
          return;
        }
        const snap = useReview.getState().snapshot;
        if (!snap) return;
        const pages = snap.pages.map((p) => ({
          ...p,
          cards: p.cards.map((c) => {
            if (c.id !== a.cardId) return c;
            const rest = (c.secondOpinions ?? []).filter((s) => s.mode !== a.mode);
            return {
              ...c,
              secondOpinions: [...rest, { ...result, cardId: c.id } as never],
            };
          }),
        }));
        mockPages = JSON.parse(JSON.stringify(pages));
        emitPages();
      }, 400);
      pendingSecondOpinions.push({ cardId: a.cardId, mode: a.mode, jobId, resultId, timer });
      return { accepted: true, jobId };
    }
    if (a.kind === "delete") {
      const target = (a as { targetId?: string }).targetId ?? "";
      const m = target.match(/^second-opinion:([^:]+):(blind|check)$/) ?? target.match(/^(so-.*)$/);
      if (m) {
        // Drop the pending fill first (issue #76): a late timer must not
        // resurrect the removed block.
        if (m[1].startsWith("so-")) {
          cancelPendingSecondOpinions((p) => p.resultId === m[1]);
        } else {
          const [, cardId, mode] = target.match(/^second-opinion:([^:]+):(blind|check)$/)!;
          cancelPendingSecondOpinions((p) => p.cardId === cardId && p.mode === mode);
        }
        // Answer results first (stored on the turn).
        let removedExp = false;
        for (const ann of annotations) {
          for (const turn of ann.turns ?? []) {
            const before = turn.secondOpinions ?? [];
            let after = before;
            if (m[1].startsWith("so-")) {
              after = before.filter((s) => (s as { id: string }).id !== m[1]);
            } else {
              const mm = target.match(/^second-opinion:([^:]+):(blind|check)$/)!;
              if (turn.id !== mm[1]) continue;
              after = before.filter((s) => (s as { mode: string }).mode !== mm[2]);
            }
            if (after.length !== before.length) {
              turn.secondOpinions = after as never;
              removedExp = true;
            }
          }
        }
        if (removedExp) {
          emitAnnotations();
          return { accepted: true };
        }
        const snap = useReview.getState().snapshot;
        if (!snap) return { accepted: false };
        const pages = snap.pages.map((p) => ({
          ...p,
          cards: p.cards.map((c) => {
            const before = c.secondOpinions ?? [];
            if (m[1].startsWith("so-")) {
              const after = before.filter((s) => s.id !== m[1]);
              return after.length === before.length ? c : { ...c, secondOpinions: after };
            }
            const [, cardId, mode] = target.match(/^second-opinion:([^:]+):(blind|check)$/)!;
            if (c.id !== cardId) return c;
            return { ...c, secondOpinions: before.filter((s) => s.mode !== mode) };
          }),
        }));
        mockPages = JSON.parse(JSON.stringify(pages));
        emitPages();
        return { accepted: true };
      }
      // Annotation deletion (expansions + threads via the actions route).
      const annIdx = annotations.findIndex((x) => x.id === target);
      if (annIdx >= 0) {
        const [removed] = annotations.splice(annIdx, 1);
        emitAnnotations();
        // Deleting a hunk card removes its stored summary too (#161).
        if (removed.anchor.host.kind === "hunk") {
          const st = hunkStates.get(removed.anchor.host.contentHash);
          if (st?.summary !== undefined) {
            hunkStates.set(removed.anchor.host.contentHash, { ...st, summary: undefined });
            emitHunkStates();
          }
        }
        return { accepted: true, annotationId: target };
      }
      throw new Error(`DELETE actions ${target}: 404 {"error":"unknown annotation"}`);
    }
    // Conversation turns (mock): create/answer through the patch path
    // like the service (working flag, delayed canned answer, patch
    // delivery). Ask creates the card; reply adds a turn; retry refills
    // the last turn in place.
    if (a.kind === "ask" || a.kind === "reply" || a.kind === "retry") {
      const newTurnId = (): string =>
        `ans_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
      if (a.kind === "ask") {
        // Issue #138: a hunk anchor activates the summary into its card,
        // then this same Ask runs nested on the summary block.
        const anchor: import("@unvibe/shared").ActionAnchor =
          a.anchor.where === "hunk"
            ? (() => {
                const ensured = ensureMockHunkCard(a.anchor.fileKey, a.anchor.contentHash);
                return { where: "block", blockId: `${ensured.turnId}#${ensured.blockId}` };
              })()
            : a.anchor;
        const host =
          anchor.where === "block"
            ? { kind: "block", blockId: qualifyMockBlock(anchor.blockId) }
            : anchor.where === "description"
              ? { kind: "description", paragraphId: anchor.paragraphId }
              : anchor.where === "comment"
                ? { kind: "comment", commentId: anchor.commentId }
                : anchor.where === "code"
                  ? { kind: "code", path: anchor.path, commit: anchor.commit, line: anchor.line, ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}) }
                  : { kind: "diff-line", fileKey: anchor.fileKey, line: anchor.line };
        const id = `ann_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
        const turnId = newTurnId();
        const askJobId = `mock-ask-${id}`;
        annotations.push({
          id,
          type: "conversation",
          anchor: {
            host: host as import("@unvibe/shared").Annotation["anchor"]["host"],
            quotedText: a.quote,
            prefix: "",
            suffix: "",
            position: 0,
            version: 1,
            // Issue #166: keep the client's recorded selection offsets so
            // mock-placed marks use them, like the service.
            ...(a.kind === "ask" && a.offsets !== undefined
              ? { startOffset: a.offsets.start, endOffset: a.offsets.end }
              : {}),
          },
          // Ask cards open in place everywhere, like Explain (no
          // closed-thread legacy).
          open: true,
          pinned: true,
          messages: [],
          post: false,
          working: "Thinking…",
          jobId: askJobId,
          turns: [
            {
              id: turnId,
              question: a.message,
              blocks: [],
              level: "standard",
              revision: 1,
              undoStack: [],
              working: "Thinking…",
              jobId: askJobId,
            },
          ],
        } as unknown as import("@unvibe/shared").Annotation);
        emitAnnotations();
        trackMockJob(askJobId, "ask", { annotationId: id });
        answerTurnLater(id, turnId, a.message, askJobId);
        return { accepted: true, annotationId: id, turnId, jobId: askJobId };
      }
      const annotationId = (a as { annotationId: string }).annotationId;
      const found = annotations.find((x) => x.id === annotationId);
      // Retry also runs on promoted links still holding turns (issue #152);
      // reply stays conversation-only (pages have no reply box).
      const fillable = found && (found.type === "conversation" || (found.type === "link" && (found.turns?.length ?? 0) > 0));
      if (!fillable || !found) throw new Error(`unknown conversation ${annotationId}`);
      if (a.kind === "reply") {
        if (found.type !== "conversation") throw new Error(`unknown conversation ${annotationId}`);
        const lastTurn = (found.turns ?? [])[(found.turns ?? []).length - 1];
        // Mirrors the service: a failed turn must be retried explicitly.
        if (lastTurn?.error) throw new Error(`conversation ${found.id} has a failed turn; retry it first`);
        const turnId = newTurnId();
        (found.turns ?? []).push({
          id: turnId,
          question: (a as { message: string }).message,
          blocks: [],
          level: "standard",
          revision: 1,
          undoStack: [],
          working: "Writing reply…",
          jobId: `mock-reply-${found.id}-${turnId}`,
        } as never);
        found.working = "Writing reply…";
        found.error = null;
        found.open = true;
        found.jobId = `mock-reply-${found.id}-${turnId}`;
        delete found.reply;
        emitAnnotations();
        const replyJobId = `mock-reply-${found.id}-${turnId}`;
        trackMockJob(replyJobId, "ask", { annotationId: found.id });
        answerTurnLater(found.id, turnId, (a as { message: string }).message, replyJobId);
        return { accepted: true, annotationId: found.id, turnId, jobId: replyJobId };
      }
      const turns = found.turns ?? [];
      const last = turns[turns.length - 1];
      if (!last || (!last.error && !found.error)) {
        throw new Error(`conversation ${found.id} has no failed turn to retry`);
      }
      last.error = null;
      found.error = null;
      last.working = "Thinking…";
      found.working = "Thinking…";
      if (found.type === "conversation") found.open = true;
      const retryJobId = `mock-retry-${found.id}`;
      last.jobId = retryJobId;
      found.jobId = retryJobId;
      emitAnnotations();
      trackMockJob(retryJobId, "ask", { annotationId: found.id });
      // A retry on a promoted link refills the page (issue #152).
      if (found.type === "link") {
        const cardId = ((found as { promotedTurns?: { turnId: string; cardId: string }[] }).promotedTurns ?? []).find(
          (m) => m.turnId === last.id,
        )?.cardId;
        if (cardId) retargetMockJob(retryJobId, cardId);
      }
      answerTurnLater(found.id, last.id, last.question ?? found.anchor.quotedText, retryJobId);
      return { accepted: true, annotationId: found.id, turnId: last.id, jobId: retryJobId };
    }
    // M4 interaction (mock): explain, depth, examples, diagram, undo,
    // generate, followup, concept, promote, close + instant card state.
    // Canned content derives from the fixture snapshot so the UI exercises
    // the real shapes (working → streamed text → blocks, error + retry via
    // `retry`, anchor-stale fallback, dotted-link close).
    if (a.kind === "explain") {
      // Issue #138: a hunk anchor activates the summary into its card,
      // then this same Explain runs nested on the summary block.
      const anchor: import("@unvibe/shared").ActionAnchor =
        a.anchor.where === "hunk"
          ? (() => {
              const ensured = ensureMockHunkCard(a.anchor.fileKey, a.anchor.contentHash);
              return { where: "block", blockId: `${ensured.turnId}#${ensured.blockId}` };
            })()
          : a.anchor;
      const host =
        anchor.where === "block"
          ? { kind: "block", blockId: qualifyMockBlock(anchor.blockId) }
          : anchor.where === "description"
            ? { kind: "description", paragraphId: anchor.paragraphId }
            : anchor.where === "comment"
              ? { kind: "comment", commentId: anchor.commentId }
              : anchor.where === "code"
                ? { kind: "code", path: anchor.path, commit: anchor.commit, line: anchor.line, ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}) }
                : { kind: "diff-line", fileKey: anchor.fileKey, line: anchor.line };
      const id = `ann_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
      const turnId = `ans_mock${Date.now().toString(36)}`;
      const jobId = `mock-explain-${id}`;
      annotations.push({
        id,
        type: "conversation",
        anchor: {
          host: host as import("@unvibe/shared").Annotation["anchor"]["host"],
          quotedText: a.quote,
          prefix: "",
          suffix: "",
          position: 0,
          version: 1,
          // Issue #166: keep the client's recorded selection offsets so
          // mock-placed marks use them, like the service.
          ...(a.kind === "explain" && a.offsets !== undefined
            ? { startOffset: a.offsets.start, endOffset: a.offsets.end }
            : {}),
        },
        open: true,
        pinned: true,
        messages: [],
        post: false,
        working: "Thinking…",
        jobId,
        turns: [
          {
            id: turnId,
            question: null,
            blocks: [],
            level: "standard",
            revision: 1,
            undoStack: [],
            working: "Thinking…",
            jobId,
          },
        ],
      } as unknown as import("@unvibe/shared").Annotation);
      emitAnnotations();
      trackMockJob(jobId, "ask", { annotationId: id });
      answerTurnLater(id, turnId, a.quote, jobId);
      return { accepted: true, annotationId: id, turnId, jobId };
    }
    if (a.kind === "depth" || a.kind === "examples" || a.kind === "diagram" || a.kind === "undo") {
      const res = mockCardControl(a as never);
      return res as ActionResponse;
    }
    if (a.kind === "generate") {
      const card = mockPages.flatMap((p) => p.cards).find((c) => c.id === a.cardId);
      if (!card) throw new Error(`unknown card ${a.cardId}`);
      if (!card.pending) return { accepted: true, jobId: `mock-generate-${card.id}` };
      const jobId = `mock-generate-${card.id}`;
      trackMockJob(jobId, "go-deeper", { cardId: card.id });
      window.setTimeout(() => {
        settleMockJob(jobId);
        const target = mockPages.flatMap((p) => p.cards).find((c) => c.id === card.id);
        if (!target || !target.pending) return;
        delete target.pending;
        target.blocks = [
          {
            type: "paragraph",
            id: `${card.id}-b1`,
            text: { standard: `Mock generated card for <em>${card.id}</em>: the live agent would fill this from the repo.` },
            citations: [{ target: "diff:src-urllib3-connection.py:80-82" }],
          },
          { type: "follow-up", id: `${card.id}-f1`, items: [{ label: "What happens to a fold that ends in a bare LF?", ask: "bare lf" }], citations: [] },
        ] as never;
        target.revision += 1;
        emitPages();
      }, 700);
      return { accepted: true, jobId };
    }
    if (a.kind === "followup") {
      const { cardId, blockId, index } = a as { cardId: string; blockId: string; index: number };
      // Page cards and conversation answers alike (mirrors the service's findFollowUp).
      const ref = findMockCard(cardId);
      // A suggestion on a conversation card is the next turn in the same
      // conversation (the item stays, like reply-box text).
      if (ref?.kind === "answer") {
        const lastAnswerTurn = (ref.annotation.turns ?? [])[(ref.annotation.turns ?? []).length - 1];
        if (lastAnswerTurn?.error) throw new Error(`conversation ${ref.annotation.id} has a failed turn; retry it first`);
        const holderBlocks = mockCardBlocks(ref);
        const fblock = holderBlocks.find((b) => b.id === blockId && b.type === "follow-up") as
          | { id: string; items: { label: string; ask?: string }[] }
          | undefined;
        if (!fblock || !fblock.items[index]) throw new Error(`unknown follow-up ${index} on block ${blockId}`);
        const item = fblock.items[index];
        const message = item.ask ?? item.label;
        const turnId = `ans_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
        (ref.annotation.turns ?? []).push({
          id: turnId,
          question: message,
          blocks: [],
          level: "standard",
          revision: 1,
          undoStack: [],
          working: "Writing answer…",
        } as never);
        ref.annotation.working = "Writing answer…";
        ref.annotation.error = null;
        ref.annotation.open = true;
        emitAnnotations();
        const answerJobId = `mock-followup-${ref.annotation.id}-${turnId}`;
        trackMockJob(answerJobId, "ask", { annotationId: ref.annotation.id });
        const annId = ref.annotation.id;
        window.setTimeout(() => {
          settleMockJob(answerJobId);
          const live = annotations.find((x) => x.id === annId);
          const turn = live?.type === "conversation" ? (live.turns ?? []).find((t) => t.id === turnId) : undefined;
          if (!live || !turn) return;
          turn.blocks = mockExplainBlocks(message) as never;
          turn.revision += 1;
          turn.working = null;
          live.working = null;
          emitAnnotations();
        }, 700);
        return { accepted: true, annotationId: annId, turnId, cardId, jobId: answerJobId };
      }
      const holderBlocks = ref ? mockCardBlocks(ref) : [];
      const block = holderBlocks.find((b) => b.id === blockId && b.type === "follow-up") as
        | { id: string; items: { label: string; ask?: string }[] }
        | undefined;
      if (!block || !block.items[index]) throw new Error(`unknown follow-up ${index} on block ${blockId}`);
      const item = block.items[index];
      block.items.splice(index, 1);
      emitPages();
      const id = `ann_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
      const turnId = `ans_mock${Date.now().toString(36)}`;
      const jobId = `mock-followup-${id}`;
      annotations.push({
        id,
        type: "conversation",
        anchor: {
          // Qualified like the service stores it (#116): a bare block ID
          // would match the same-numbered block of every card.
          host: { kind: "block", blockId: `${cardId}#${block.id}` },
          quotedText: item.label,
          prefix: "",
          suffix: "",
          position: 0,
          version: 1,
        },
        open: true,
        pinned: true,
        messages: [],
        post: false,
        working: "Writing answer…",
        turns: [
          { id: turnId, question: item.ask ?? item.label, blocks: [], level: "standard", revision: 1, undoStack: [], working: "Writing answer…" },
        ],
      } as unknown as import("@unvibe/shared").Annotation);
      emitAnnotations();
      trackMockJob(jobId, "ask", { cardId, annotationId: id });
      window.setTimeout(() => {
        settleMockJob(jobId);
        const found = annotations.find((x) => x.id === id);
        const turn = found?.type === "conversation" ? (found.turns ?? []).find((t) => t.id === turnId) : undefined;
        if (!found || !turn) return;
        turn.blocks = mockExplainBlocks(item.label) as never;
        turn.revision += 1;
        turn.working = null;
        found.working = null;
        emitAnnotations();
      }, 700);
      return { accepted: true, annotationId: id, turnId, cardId, jobId };
    }
    if (a.kind === "concept") {
      const slug = (a as { slug: string }).slug;
      const pageId = `c-${slug}`;
      let page = mockPages.find((p) => p.id === pageId);
      if (page && (page.cards[0]?.blocks.length ?? 0) > 1) return { accepted: true, pageId };
      if (!page) {
        mockPages.push({
          id: pageId,
          kind: "concept",
          title: slug,
          parent: "root",
          cards: [{ id: `cc-${slug}`, pageId, title: null, level: "standard", collapsed: false, revision: 1, blocks: [], undoStack: [] }],
        });
        emitPages();
        page = mockPages.find((p) => p.id === pageId)!;
      }
      const jobId = `mock-concept-${slug}`;
      trackMockJob(jobId, "concept", { cardId: `cc-${slug}`, dedupeKey: `concept:${slug}|concept-page||v1` });
      window.setTimeout(() => {
        settleMockJob(jobId);
        const live = mockPages.find((p) => p.id === pageId);
        if (!live) return;
        // The demo's obs-fold page is the one the specs read closely:
        // give it its recorded title, its OWS/RWS link and an example
        // aside, like the replayed recording (#216 on-demand fill).
        const known = slug === "obs-fold";
        live.title = known ? "Obsolete line folding (obs-fold)" : `${slug} (mock concept)`;
        live.cards = [
          {
            id: `cc-${slug}`,
            pageId,
            title: null,
            level: "standard",
            collapsed: false,
            revision: 2,
            blocks: [
              { type: "paragraph", id: `cc-${slug}-b1`, text: { standard: `Mock concept page for <em>${slug}</em>: written on first open.` }, citations: [{ target: "diff:src-urllib3-connection.py:80-82" }] },
              ...(known
                ? [
                    { type: "paragraph", id: `cc-${slug}-b2`, text: { standard: 'Whitespace is one of the <a class="cx" data-link="concept:ows-rws">OWS and RWS</a> rules.' }, citations: [] },
                    mockExampleAside(),
                  ]
                : []),
            ] as never,
            undoStack: [],
          },
        ];
        emitPages();
      }, 700);
      return { accepted: true, pageId, jobId };
    }
    if (a.kind === "hunk_card") {
      // Issue #138: the explicit hunk control. Activates (or reopens)
      // the summary card with no job.
      const ensured = ensureMockHunkCard(a.fileKey, a.contentHash);
      return { accepted: true, annotationId: ensured.id, turnId: ensured.turnId };
    }
    if (a.kind === "promote") {
      const annId = (a as { annotationId: string }).annotationId;
      const found = annotations.find((x) => x.id === annId);
      if (!found || found.type !== "conversation" || !found.turns) {
        throw new Error(`annotation ${annId} is not a conversation`);
      }
      // Like the service (issue #152): no cancel — an unsettled turn
      // keeps filling and mirrors onto its page card; second opinions
      // move with the content.
      const quote = found.anchor.quotedText;
      const title = quote.length > 60 ? `${quote.slice(0, 58)}…` : quote || "(untitled)";
      const pageId = `p-mock-${Date.now().toString(36)}`;
      const stamp = Date.now().toString(36);
      const cardIds = (found.turns as unknown[]).map((_, i) => `c-mock-${stamp}-${i}`);
      mockPages.push({
        id: pageId,
        kind: "opened-expansion",
        title,
        parent: "root",
        cards: (found.turns as never[]).map((t, i) => {
          const turn = t as unknown as import("@unvibe/shared").Turn;
          return {
            id: cardIds[i],
            pageId,
            title: i === 0 ? quote || null : (turn.question ?? null),
            level: turn.level,
            collapsed: false,
            revision: turn.revision,
            blocks: JSON.parse(JSON.stringify(turn.blocks)),
            undoStack: JSON.parse(JSON.stringify(turn.undoStack)),
            ...(turn.secondOpinions ? { secondOpinions: JSON.parse(JSON.stringify(turn.secondOpinions)) } : {}),
          };
        }),
      });
      const unsettled = (found.turns as unknown as import("@unvibe/shared").Turn[]).some(
        (t) => ((t.working ?? "") !== "" && t.working !== null) || ((t.error ?? "") !== "" && t.error !== null) || t.jobId !== undefined,
      );
      const fillingIndex = (found.turns as unknown as import("@unvibe/shared").Turn[]).findIndex((t) => t.jobId !== undefined);
      const fillingJob = fillingIndex >= 0 ? (found.turns as unknown as import("@unvibe/shared").Turn[])[fillingIndex].jobId : undefined;
      found.type = "link" as never;
      found.open = false;
      if (unsettled) {
        (found as { promotedTurns?: { turnId: string; cardId: string }[] }).promotedTurns = (
          found.turns as unknown as import("@unvibe/shared").Turn[]
        ).map((turn, i) => ({ turnId: turn.id, cardId: cardIds[i] }));
      } else {
        found.working = null;
        found.error = null;
        found.jobId = undefined;
        delete (found as { turns?: unknown }).turns;
      }
      (found as { promotedToPage?: string }).promotedToPage = pageId;
      if (fillingJob && fillingIndex >= 0) retargetMockJob(fillingJob, cardIds[fillingIndex]);
      emitPages();
      emitAnnotations();
      return { accepted: true, annotationId: annId, pageId };
    }
    if (a.kind === "close") {
      const annId = (a as { annotationId: string }).annotationId;
      const found = annotations.find((x) => x.id === annId);
      if (!found) throw new Error(`unknown annotation ${annId}`);
      found.open = false;
      found.working = null;
      if (found.type === "conversation" || (found.type === "link" && (found.turns?.length ?? 0) > 0)) {
        for (const t of found.turns ?? []) t.working = null;
      }
      emitAnnotations();
      return { accepted: true, annotationId: annId };
    }
    // Guide instant state (PRD §4.4) applies locally through the patch
    // path — page cards and conversation cards alike.
    // (Conversation retries are handled in the ask/reply/retry branch above.)
    if (a.kind !== "collapse") {
      return { accepted: false };
    }
    // Collapse on page cards…
    if (a.kind === "collapse") {
      for (const p of mockPages) {
        for (const c of p.cards) {
          if (c.id !== (a as { cardId: string }).cardId) continue;
          c.collapsed = (a as { collapsed: boolean }).collapsed;
          emitPages();
          return { accepted: true };
        }
      }
      // …and on conversation cards (an answer id collapses its card).
      const ann = annotations.find((x) => x.id === (a as { cardId: string }).cardId);
      if (ann?.type === "conversation") {
        ann.collapsed = (a as { collapsed: boolean }).collapsed;
        emitAnnotations();
        return { accepted: true };
      }
      for (const other of annotations) {
        if ((other.turns ?? []).some((t) => t.id === (a as { cardId: string }).cardId)) {
          other.collapsed = (a as { collapsed: boolean }).collapsed;
          emitAnnotations();
          return { accepted: true };
        }
      }
    }
    return { accepted: false };
  },

  // Mirrors the service PATCH semantics: null clears the summary.
  updateHunk: async (_id: string, hash: string, body: UpdateHunkRequest): Promise<{ ok: boolean }> => {
    const prev = hunkStates.get(hash) ?? { contentHash: hash, folded: false, reviewed: false };
    const next: HunkState = { ...prev };
    if (body.folded !== undefined) next.folded = body.folded;
    if (body.reviewed !== undefined) next.reviewed = body.reviewed;
    if (body.summary === null) delete next.summary;
    else if (body.summary !== undefined) next.summary = body.summary;
    hunkStates.set(hash, next);
    emitHunkStates();
    return { ok: true };
  },

  // Mirrors the service file-fold PATCH (issue #162): fold state lives on
  // the snapshot, so it survives tab switches and reloads.
  updateFile: async (
    _id: string,
    fileKey: string,
    body: import("@unvibe/shared").UpdateFileRequest,
  ): Promise<{ ok: boolean }> => {
    const prev = fileStates.get(fileKey) ?? { fileKey, folded: false };
    fileStates.set(fileKey, { ...prev, ...(body.folded !== undefined ? { folded: body.folded } : {}) });
    emitFileStates();
    return { ok: true };
  },

  // Mirrors the service view PATCH (issue #168).
  updateView: async (
    _id: string,
    body: import("@unvibe/shared").UpdateViewRequest,
  ): Promise<{ ok: boolean }> => {
    if (body.showExistingComments !== undefined || body.existingCommentsCollapsed !== undefined) {
      mockViewPrefs = {
        ...mockViewPrefs,
        ...(body.showExistingComments !== undefined ? { showExistingComments: body.showExistingComments } : {}),
        ...(body.existingCommentsCollapsed !== undefined
          ? { existingCommentsCollapsed: body.existingCommentsCollapsed }
          : {}),
      };
      const baseRev = rev;
      rev += 1;
      useReview.getState().applyEvent({
        type: "patch",
        baseRev,
        headRev: rev,
        ops: [{ op: "replace", path: "/viewPrefs", value: { ...mockViewPrefs } }],
      });
    }
    return { ok: true };
  },

  summarizeHunk: async (_id: string, hash: string): Promise<{ jobId: string }> => {
    await wait(600);
    const key = findHunkKey(hash);
    const summary =
      (key && HUNK_SUMMARIES[key]) || "Mock summary: this hunk normalizes folded header values.";
    const prev = hunkStates.get(hash) ?? { contentHash: hash, folded: false, reviewed: false };
    hunkStates.set(hash, { ...prev, summary });
    emitHunkStates();
    return { jobId: `mock-${hash}` };
  },

  // Issue #169: mirrors the service PATCH semantics (null clears a field;
  // unknown plotlines and levels are refused).
  updateDiffFilter: async (_id: string, body: UpdateDiffFilterRequest): Promise<{ ok: boolean }> => {
    const { plotline, score, guideId } = body;
    // Custom guides: absent keeps the guide, null returns to the main
    // guide; switching guides drops a plotline pick unless one is sent.
    if (typeof guideId === "string" && !mockGuides.some((g) => g.id === guideId)) {
      throw new Error(`unknown custom guide ${guideId}`);
    }
    const effectiveGuide = guideId === undefined ? mockDiffFilter?.guideId : (guideId ?? undefined);
    if (plotline !== undefined && plotline !== null) {
      const guide = mockGuides.find((g) => g.id === effectiveGuide);
      const ids = new Set([...(guide ? guide.plotlines : MOCK_PLOTLINES).map((p) => p.id), "other"]);
      if (!ids.has(plotline)) throw new Error(`unknown plotline ${plotline}`);
    }
    if (score !== undefined && score !== null) {
      const levels: readonly string[] = ["mechanical", "routine", "substantive", "needs-attention"];
      if (!levels.includes(score)) throw new Error(`unknown score ${score}`);
    }
    const next: DiffFilter = { ...(mockDiffFilter ?? {}) };
    if (guideId !== undefined && (guideId ?? undefined) !== next.guideId) {
      if (guideId === null) delete next.guideId;
      else next.guideId = guideId;
      if (plotline === undefined) delete next.plotline;
    }
    if (plotline === null) delete next.plotline;
    else if (plotline !== undefined) next.plotline = plotline;
    if (score === null) delete next.score;
    else if (score !== undefined) next.score = score;
    mockDiffFilter = Object.keys(next).length === 0 ? undefined : next;
    emitDiffFilter();
    return { ok: true };
  },

  fileSlice: async (
    id: string,
    params: { path: string; commit: string; start: number; end: number },
  ): Promise<import("@unvibe/shared").FileSliceResponse> => {
    await wait(60);
    return mockFileSlice(id, params);
  },

  outline: async (
    id: string,
    params: { path: string; commit: string; start: number; end: number },
  ): Promise<import("@unvibe/shared").FileOutlineResponse> => {
    await wait(60);
    return mockOutline(id, params);
  },

  createComment: async (
    _id: string,
    body: import("@unvibe/shared").CreateCommentRequest,
  ): Promise<{ id: string }> => {
    const anchor = body.anchor;
    // Issue #138: comments never anchor hunks (the client maps summary
    // Comments to the hunk's first changed line), mirroring the service.
    if (anchor.where === "hunk") {
      throw new Error("a comment on a hunk summary goes to the hunk's first changed line, not the hunk");
    }
    const host =
      anchor.where === "block"
        ? { kind: "block", blockId: qualifyMockBlock(anchor.blockId) }
        : anchor.where === "description"
          ? { kind: "description", paragraphId: anchor.paragraphId }
          : anchor.where === "comment"
            ? { kind: "comment", commentId: anchor.commentId }
            : anchor.where === "code"
              ? { kind: "code", path: anchor.path, commit: anchor.commit, line: anchor.line, ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}) }
              : { kind: "diff-line", fileKey: anchor.fileKey, line: anchor.line };
    const thread: import("@unvibe/shared").Annotation = {
      id: `ann_mock${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`,
      type: "comment",
      anchor: {
        host: host as import("@unvibe/shared").Annotation["anchor"]["host"],
        quotedText: body.quote ?? "",
        prefix: body.prefix ?? "",
        suffix: body.suffix ?? "",
        position: body.position ?? 0,
        version: 1,
        // Issue #166: keep the client's recorded selection offsets, like
        // the service.
        ...(body.offsets !== undefined
          ? { startOffset: body.offsets.start, endOffset: body.offsets.end }
          : {}),
      },
      open: host.kind === "block" ? false : true,
      pinned: false,
      messages: body.text ? [{ who: "you", text: body.text }] : [],
      // Mirrors the service: a Comment is for the PR by default; an Ask
      // is a conversation card, never a thread.
      post: true,
    };
    if (body.suggested && body.suggestionText) {
      thread.messages = [{ who: "ai", text: body.suggestionText, suggested: true }];
      thread.post = false;
    }
    annotations.push(thread);
    emitAnnotations();
    return { id: thread.id };
  },

  replyComment: async (_id: string, commentId: string, body: { text: string }) => {
    const thread = annotations.find((a) => a.id === commentId);
    if (!thread || thread.type !== "comment") throw new Error("unknown comment");
    thread.messages.push({ who: "you", text: body.text });
    delete thread.reply;
    thread.open = true;
    emitAnnotations();
    return { ok: true };
  },

  updateComment: async (_id: string, commentId: string, body: import("@unvibe/shared").UpdateCommentRequest) => {
    const thread = annotations.find((a) => a.id === commentId);
    if (!thread) throw new Error("unknown comment");
    // Issue #136: `open` and the reply-box draft (`reply`) apply to
    // conversation cards too (dotted-link click). Post/draft stay
    // comment-only.
    if (thread.type === "conversation") {
      if (body.open !== undefined) thread.open = body.open;
      if (body.pinned !== undefined) thread.pinned = body.pinned;
      if (body.post !== undefined || body.draft !== undefined) {
        throw new Error(`annotation ${commentId} is not a thread`);
      }
      if (body.reply === null) delete thread.reply;
      else if (body.reply !== undefined) thread.reply = body.reply;
      emitAnnotations();
      return { ok: true };
    }
    if (thread.type !== "comment") throw new Error("unknown comment");
    if (body.pinned !== undefined) throw new Error(`annotation ${commentId} is not a conversation`);
    if (body.post !== undefined) {
      thread.post = body.post;
      if (body.post) thread.open = true;
    }
    if (body.draft === null) delete thread.draft;
    else if (body.draft !== undefined) thread.draft = body.draft;
    if (body.open !== undefined) thread.open = body.open;
    if (body.reply === null) delete thread.reply;
    else if (body.reply !== undefined) thread.reply = body.reply;
    emitAnnotations();
    return { ok: true };
  },

  deleteComment: async (_id: string, commentId: string) => {
    const idx = annotations.findIndex((a) => a.id === commentId);
    if (idx < 0) throw new Error("unknown comment");
    annotations.splice(idx, 1);
    emitAnnotations();
    return { ok: true };
  },

  updateDescription: async (_id: string, body: { html: string }) => {
    description = {
      ...description,
      pendingHtml: body.html,
      pendingMarkdown: stripMockHtml(body.html),
    };
    emitDescription();
    return { ok: true, changed: true };
  },

  revertDescription: async () => {
    const { pendingHtml: _ph, pendingMarkdown: _pm, ...rest } = description as Record<string, unknown>;
    void _ph;
    void _pm;
    description = rest as typeof description;
    emitDescription();
    return { ok: true };
  },

  submit: async (_id: string, body?: { dryRun?: boolean }) => {
    const preview = buildMockPreview();
    if (body?.dryRun) {
      return { posted: false, commentCount: 0, descriptionUpdated: false, preview };
    }
    const at = Date.now();
    for (const c of preview.comments) {
      const thread = annotations.find((a) => a.id === c.threadId);
      if (thread && thread.type === "comment") {
        thread.postedAt = at;
        thread.postedUrl = "https://github.com/urllib3/urllib3/pull/5020#discussion_r-mock";
      }
    }
    const descriptionUpdated = description.pendingHtml !== undefined;
    if (descriptionUpdated) {
      description = {
        ...description,
        html: description.pendingHtml ?? description.html,
        baseMarkdown: description.pendingMarkdown,
      };
      const { pendingHtml: _h, pendingMarkdown: _m, ...rest } = description as Record<string, unknown>;
      void _h;
      void _m;
      description = rest as typeof description;
    }
    emitAnnotations();
    emitDescription();
    return {
      posted: true,
      commentCount: preview.comments.length,
      descriptionUpdated,
      reviewUrl: "https://github.com/urllib3/urllib3/pull/5020#pullrequestreview-mock",
    };
  },

  submitPreview: async () => ({ preview: buildMockPreview() }),

  prComments: async () => {
    emitExisting();
    return { comments: existingComments };
  },

  outbox: async (id: string) => {
    const snap = currentSnapshot(id);
    return {
      markdown: buildOutboxExportMarkdown(snap, { title: snap.review.branch || id }),
      count: outboxThreads(snap).length,
    };
  },

  viewer: async () => ({ login: "you" }),

  settings: async (): Promise<Settings> => getMockSettings(),

  saveSettings: async (body: Partial<Settings>): Promise<Settings> => {
    // Mirror the service rule (issue #160): enabling full access needs the
    // acknowledgement in the same update; turning it off clears it.
    if (body.fullAccess === true && body.fullAccessAcknowledgedAt == null) {
      throw new Error(
        'PUT /api/settings: 400 {"errors":["fullAccess needs the warning acknowledgement: send fullAccessAcknowledgedAt with the update"]}',
      );
    }
    const merged: Partial<Settings> = { ...body };
    if (body.fullAccess === false) merged.fullAccessAcknowledgedAt = null;
    const next = { ...getMockSettings(), ...merged };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch {
      // Non-fatal.
    }
    return next;
  },

  models: async (provider: string): Promise<ModelsResponse> => {
    const catalog: Record<string, import("@unvibe/shared").ModelInfo[]> = {
      claude: [
        { id: "mock-main", name: "Mock Main", description: "Mock main model for tests" },
        { id: "mock-small", name: "Mock Small", description: "Mock small model for tests" },
        { id: "mock-opus", name: "Mock Opus", description: "Mock opus-class model for tests" },
      ],
      codex: [
        { id: "mock-second", name: "Mock Second", description: "Mock second-opinion model" },
        { id: "mock-mini", name: "Mock Mini", description: "Mock mini model" },
      ],
    };
    const models = catalog[provider];
    if (!models) {
      throw new Error(
        `GET /api/models?provider=${provider}: 404 {"error":"couldn't list ${provider} models — check that its CLI is installed and logged in"}`,
      );
    }
    return { provider, models };
  },

  thinking: async (provider: string): Promise<import("@unvibe/shared").ThinkingResponse> => ({
    provider,
    label: "Effort",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
    current: "medium",
  }),

  prompts: async (reviewId?: string): Promise<PromptsResponse> => {
    const templates: PromptTemplate[] = MOCK_TEMPLATES;
    if (!reviewId) return { templates };
    return { templates, expanded: MOCK_TEMPLATES.map((t) => mockExpanded(t.name)) };
  },

  jobs: async (reviewId?: string): Promise<{ jobs: Job[] }> => ({
    jobs: reviewId ? mockJobs.filter((j) => j.reviewId === reviewId) : [...mockJobs],
  }),

  job: async (id: string) => {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) throw new Error(`GET /api/jobs/${id}: 404 {"error":"unknown job"}`);
    return { job };
  },

  jobOutput: async (id: string) => {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) throw new Error(`GET /api/jobs/${id}/output: 404 {"error":"unknown job"}`);
    if (job.turnRecords === undefined) {
      throw new Error(`GET /api/jobs/${id}/output: 404 {"error":"no output recorded for job"}`);
    }
    return { jobId: job.id, turnRecords: job.turnRecords };
  },

  jobReply: async (id: string) => {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) throw new Error(`GET /api/jobs/${id}/reply: 404 {"error":"unknown job"}`);
    if (job.replySnapshot === undefined) {
      throw new Error(`GET /api/jobs/${id}/reply: 404 {"error":"no reply snapshot for job"}`);
    }
    return { jobId: job.id, replySnapshot: job.replySnapshot };
  },

  cancelJob: async (id: string) => {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) throw new Error(`POST /api/jobs/${id}/cancel: 404 {"error":"unknown job"}`);
    const next = { ...job, state: "cancelled" as const };
    mockJobs = mockJobs.map((j) => (j.id === id ? next : j));
    return { job: next };
  },

  setJobPriority: async (id: string, priority: number) => {
    const job = mockJobs.find((j) => j.id === id);
    if (!job) throw new Error(`PATCH /api/jobs/${id}: 404 {"error":"unknown job"}`);
    const next = { ...job, priority };
    mockJobs = mockJobs.map((j) => (j.id === id ? next : j));
    return { job: next };
  },

  contributions: async (reviewId: string) => ({
    contributions: reviewId === "demo" ? [...mockContributions] : [],
  }),

  sharedContext: async (reviewId: string) => mockSharedContext(reviewId),

  deleteContribution: async (reviewId: string, contributionId: string) => {
    void reviewId;
    if (!mockContributions.some((c) => c.id === contributionId)) {
      throw new Error(`DELETE /api/reviews/demo/contributions/${contributionId}: 404`);
    }
    mockContributions = mockContributions.filter((c) => c.id !== contributionId);
    emitContributions();
    return { ok: true as const, deletedId: contributionId };
  },

  acceptContribution: async (reviewId: string, contributionId: string) => {
    void reviewId;
    const found = mockContributions.find((c) => c.id === contributionId);
    if (!found) throw new Error(`POST /api/reviews/demo/contributions/${contributionId}/accept: 404`);
    const correction = found.items.find((i) => i.kind === "correction");
    if (found.status !== "pending" || !correction?.target) {
      throw new Error(`POST /api/reviews/demo/contributions/${contributionId}/accept: 409 {"error":"not a pending correction"}`);
    }
    // Accept creates a new card revision (undoable): push the current blocks
    // and bump the revision on the target card when it exists in mock.
    const target = correction.target ?? "";
    const cardId = target.startsWith("card:") ? target.slice("card:".length).split("#")[0] : "central";
    const ref = findMockCard(cardId);
    let revision = 2;
    if (ref?.kind === "page") {
      ref.card.undoStack.push({ blocks: JSON.parse(JSON.stringify(ref.card.blocks)), level: ref.card.level });
      ref.card.revision += 1;
      revision = ref.card.revision;
      emitPages();
    }
    mockContributions = mockContributions.map((c) =>
      c.id === contributionId ? { ...c, status: "accepted" as const } : c,
    );
    emitContributions();
    return { ok: true as const, acceptedId: contributionId, cardId, revision };
  },

  dismissContribution: async (reviewId: string, contributionId: string) => {
    void reviewId;
    const found = mockContributions.find((c) => c.id === contributionId);
    if (!found) throw new Error(`POST /api/reviews/demo/contributions/${contributionId}/dismiss: 404`);
    if (found.status !== "pending") {
      throw new Error(`POST /api/reviews/demo/contributions/${contributionId}/dismiss: 409 {"error":"not a pending correction"}`);
    }
    mockContributions = mockContributions.map((c) =>
      c.id === contributionId ? { ...c, status: "dismissed" as const } : c,
    );
    emitContributions();
    return { ok: true as const, dismissedId: contributionId };
  },

  updateStatus: async (): Promise<UpdateStatusResponse> => {
    await wait(30);
    return {
      enabled: getMockSettings().versionPickerEnabled === true,
      build: mockUpdateBuild(),
      pending: mockUpdatePending,
      outcome: readUpdatePersisted().outcome,
    };
  },

  updateChannels: async (): Promise<{ channels: UpdateChannel[] }> => {
    await wait(80);
    // Issue #231: releases are always listed; previews only with the toggle on.
    const all = mockUpdateChannels();
    const visible =
      getMockSettings().versionPickerEnabled === true ? all : all.filter((c) => c.kind !== "preview");
    return { channels: visible };
  },

  updateSwitch: async (ref: string, force?: boolean): Promise<UpdateSwitchResponse> => {
    await wait(80);
    const target = MOCK_UPDATE_CHANNELS.find((c) => c.ref === ref);
    if (!target) {
      throw new Error(`POST /api/update/switch: 404 {"error":"unknown update channel \\"${ref}\\""}`);
    }
    // Issue #231: releases always switch; previews need the toggle on.
    if (target.kind === "preview" && getMockSettings().versionPickerEnabled !== true) {
      throw new Error('POST /api/update/switch: 404 {"error":"previews are hidden (show them in Settings → Version)"}');
    }
    if (mockUpdatePending) {
      throw new Error(
        `POST /api/update/switch: 409 {"error":"a switch to \\"${mockUpdatePending.to}\\" is already in progress"}`,
      );
    }
    // Running-jobs refusal (#36 follow-up): opt-in via localStorage
    // `unvibe.mock.update.blockJobs` ("1"), refused from the live mock job
    // list unless forced — so mock-mode specs exercise the refused →
    // switch-anyway flow without breaking the plain switch specs.
    const blockJobs = (() => {
      try {
        return localStorage.getItem(UPDATE_BLOCK_JOBS_KEY) === "1";
      } catch {
        return false;
      }
    })();
    const active = mockJobs.filter((j) => j.state === "queued" || j.state === "running" || j.state === "backing-off");
    if (blockJobs && active.length > 0 && force !== true) {
      const jobs = active.slice(0, 5).map((j) => ({
        id: j.id,
        kind: j.kind,
        ...(j.reviewId !== undefined ? { reviewId: j.reviewId } : {}),
        state: j.state,
        ...((j.progress ?? j.cardId ?? j.annotationId) ? { label: (j.progress ?? j.cardId ?? j.annotationId) as string } : {}),
      }));
      throw new UpdateJobsBlockedError(
        active.length,
        jobs,
        `cannot switch while ${active.length} job${active.length === 1 ? " is" : "s are"} running; wait for them to finish, then retry`,
      );
    }
    const { current: from } = readUpdatePersisted();
    if (from === ref) {
      // Same channel, same published commit in mock: nothing to do.
      return { from, to: ref, unchanged: true };
    }
    mockUpdatePending = { from, to: ref, startedAt: new Date().toISOString() };
    mockUpdateDown = true;
    // Forced with jobs running: the shutdown path stops them; the count
    // rides the outcome so the UI names it after the reload.
    const interruptedJobs = force === true && active.length > 0 ? active.length : undefined;
    const fail = (() => {
      try {
        return localStorage.getItem(UPDATE_FAIL_KEY);
      } catch {
        return null;
      }
    })();
    window.setTimeout(() => {
      const at = new Date().toISOString();
      if (!fail) {
        writeUpdatePersisted({
          current: ref,
          outcome: {
            status: "ok",
            from,
            to: ref,
            finishedAt: at,
            ...(interruptedJobs !== undefined ? { interruptedJobs } : {}),
          },
        });
      } else if (fail === "fatal") {
        writeUpdatePersisted({
          current: from,
          outcome: {
            status: "failed",
            from,
            to: ref,
            reason: `Mock install of ${ref} failed and the rollback did not come up (simulated)`,
            finishedAt: at,
          },
        });
      } else {
        writeUpdatePersisted({
          current: from,
          outcome: {
            status: "rolled-back",
            from,
            to: ref,
            reason:
              fail === "install"
                ? `Mock install of ${ref} failed (simulated); restored the pre-switch backup`
                : `Mock build of ${ref} never reported ${target.version ?? "a version"} (simulated); restored the pre-switch backup`,
            finishedAt: at,
          },
        });
      }
      mockUpdatePending = null;
      mockUpdateDown = false;
    }, 900);
    return { from, to: ref };
  },

  diagnostics: async () => {
    await wait(50);
    return buildMockDiagnostics();
  },

  reload: async () => {
    await wait(100);
    const diagnostics = buildMockDiagnostics();
    return { ok: true as const, generatedAt: Date.now(), changed: ["no changes"], detail: ["Mock reload: nothing changed."], diagnostics };
  },
} satisfies ApiClient;

const MOCK_TEMPLATES: PromptTemplate[] = [
  {
    name: "instructions",
    role: "system",
    tier: "main",
    variables: [],
    template: "You are helping a person read and review a code change.\nLink code as [[diff:file:line]] tokens.",
  },
  {
    name: "reader",
    role: "user",
    tier: "main",
    variables: ["source", "diff_inline", "repo_path"],
    template:
      "You are the reader: explore the change.\n\n## Source under review\n\n{{source}}\n\n## Diff\n\n{{diff_inline}}\n\nThe branch is checked out at `{{repo_path}}`.",
  },
  {
    name: "base_pack",
    role: "user",
    tier: "main",
    variables: ["source", "diff_inline", "pinned_code", "guide", "concepts", "hunk_summaries"],
    template:
      "Base context pack.\n\n{{source}}\n\n{{diff_inline}}\n\n{{pinned_code}}\n\n{{guide}}\n\n{{concepts}}\n\n{{hunk_summaries}}",
  },
  {
    name: "ask",
    role: "user",
    tier: "main",
    variables: ["anchor", "card", "thread", "change_list", "message"],
    template:
      "Answer the question about the selected text.\n\nQuote: {{anchor.quote}}\n\nCard:\n{{card}}\n\nConversation so far:\n{{thread}}\n\nChanges:\n{{change_list}}\n\nQuestion: {{message}}",
  },
  {
    name: "ask_turn",
    role: "user",
    tier: "main",
    variables: ["change_list", "message"],
    template: "Answer only what is new.\n\nChanges:\n{{change_list}}\n\nQuestion: {{message}}",
  },
];

function mockExpanded(name: string): PromptExpanded {
  const spans: { layer: "L0" | "L1" | "L1b" | "L2" | "L3" | "L4"; label: string; text: string; cached: boolean }[] =
    name === "instructions"
      ? [{ layer: "L0", label: "instructions", text: "You are helping a person read and review a code change.", cached: false }]
      : [
          { layer: "L0", label: "instructions", text: "You are helping a person read and review a code change.", cached: true },
          { layer: "L1", label: "source", text: "PR #5020 on urllib3/urllib3\nDiff: 8 hunks, +42 −18", cached: true },
          { layer: "L1b", label: "pinned", text: "(no pinned excerpts)", cached: true },
          { layer: "L2", label: "guide", text: "### The central change [[card:central]]\n\nUnfold obsolete folded values.", cached: true },
          { layer: "L3", label: "log", text: "(log is empty)", cached: true },
          {
            layer: "L4",
            label: name,
            text: name === "ask" || name === "ask_turn" ? "(no text selected — open this template from Explain/Ask)" : `Task for ${name}.`,
            cached: false,
          },
        ];
  const parts: string[] = [];
  let cachedTokens = 0;
  const layers = spans.map((s) => {
    const tokens = Math.max(1, Math.ceil(s.text.length / 4));
    if (s.cached) cachedTokens += tokens;
    const flag = s.cached ? "cached:yes" : "cached:no";
    parts.push(
      `<!-- layer:${s.layer} label:${s.label} tokens:${tokens} ${flag} -->\n${s.text}\n<!-- /layer:${s.layer} -->\n`,
    );
    return { layer: s.layer, tokens };
  });
  return { name, expanded: parts.join("\n"), layers, cachedTokens };
}
