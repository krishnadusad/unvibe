/**
 * Typed API client. Token: read from the URL (`?token=`) on first load,
 * then persisted in `localStorage` (and mirrored to the `__unvibe_token`
 * cookie so static loads authenticate). Sent as `Authorization: Bearer`.
 */
import type { ApiErrorCode } from "@unvibe/shared";
import type {
  AcceptContributionResponse,
  ActionResponse,
  AddRepoRequest,
  AnswerCustomGuideRequest,
  AddRepoResponse,
  ChangesFilter,
  ContributionsResponse,
  CreateCommentRequest,
  CreateCommentResponse,
  CreateCustomGuideRequest,
  CreateDocumentRequest,
  CustomGuideResponse,
  CustomGuideSuggestions,
  CreateReviewRequest,
  CreateReviewResponse,
  DeleteContributionResponse,
  DiagnosticsResponse,
  DiagramStatusBody,
  DiagramTheme,
  DismissContributionResponse,
  ExistingCommentsResponse,
  OutboxResponse,
  FileOutlineResponse,
  FileSliceResponse,
  HealthResponse,
  Job,
  JobOutputResponse,
  JobReplyResponse,
  JobResponse,
  JobsResponse,
  ModelsResponse,
  PickFolderResponse,
  PromptsResponse,
  ReadinessResponse,
  RefreshResponse,
  ReloadResponse,
  ResumeReviewResponse,
  RemoveRepoResponse,
  ResetDataResponse,
  ReplyCommentRequest,
  ReposResponse,
  RepoChangesResponse,
  RepoWorktreesResponse,
  ReviewAction,
  ReviewSnapshot,
  ReviewsListResponse,
  Settings,
  SharedContextResponse,
  SubmitPreview,
  SubmitReviewRequest,
  SubmitReviewResponse,
  SummarizeHunkResponse,
  ThinkingResponse,
  UpdateChannelsResponse,
  UpdateCommentRequest,
  UpdateDescriptionRequest,
  UpdateDiffFilterRequest,
  UpdateFileRequest,
  UpdateHunkRequest,
  UpdateViewRequest,
  UpdateReviewResponse,
  UpdateStatusResponse,
  UpdateSwitchRequest,
  UpdateSwitchResponse,
  ViewerResponse,
} from "@unvibe/shared";
// Static import keeps mock timing deterministic in dev; the mock modules are
// data + an in-memory client with no side effects on import, so bundlers can
// drop them from production builds where VITE_MOCK is unset.
import { mockApi } from "../mock/index.js";

const TOKEN_KEY = "unvibe_token";
const TOKEN_COOKIE = "__unvibe_token";
/**
 * Cookie lifetime, one year (issue #108): the plain bookmark URL keeps
 * working across browser restarts. Attributes stay as before otherwise —
 * `SameSite=Lax; Path=/`, host-only (no `Domain`), no `Secure` (plain
 * http). `HttpOnly` is impossible here: the cookie is mirrored from JS so
 * static asset loads authenticate; the token's real carriers are
 * `localStorage` (per origin) plus the `Authorization` header.
 * `packages/web/public/start.js` carries the same literal for the offline
 * page; keep the two in step.
 */
export const TOKEN_COOKIE_MAX_AGE = 31536000;

export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Max-Age=${TOKEN_COOKIE_MAX_AGE}; SameSite=Lax; path=/`;
}

export function initTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    document.cookie = tokenCookie(fromUrl);
    // Strip the token from the address bar without reloading.
    params.delete("token");
    const rest = params.toString();
    const clean = window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash;
    window.history.replaceState(null, "", clean);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Plain-words error detail for toasts: what happened and what to do, never
 * a method/path/status-code transport prefix and never raw JSON. Callers
 * already say what they were doing ("Couldn't save the draft: …").
 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|offline/i.test(raw)) {
    return "the Unvibe service isn't answering — check that it is running, then try again";
  }
  const m = raw.match(/^[A-Z]+ \/\S+: (\d{3})?\s?([\s\S]*)$/);
  // 401 answers its own copy even when the body is JSON (finding 1): the
  // token is missing, so the fix is reconnecting — not the body's wording.
  // (`request` throws 401s with the same status prefix as every other
  // failure, so this branch runs for real rejections.)
  if (m?.[1] === "401") {
    return "this browser isn't connected to Unvibe — run `unvibe open` in a terminal";
  }
  const body = (m?.[2] ?? raw).trim();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; errors?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
      return parsed.error.trim().slice(0, 220);
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors.map(String).join("; ").slice(0, 220);
    }
  } catch {
    // Not JSON: fall through to status-mapped copy.
  }
  switch (m?.[1]) {
    case "404":
      return "not found — it may have been removed";
    case "409":
      return body.slice(0, 220) || "something changed in the meantime — reload the page and try again";
    case "500":
    case "502":
      return "the service couldn't reach the repo or the agent — try again";
    default:
      return body.slice(0, 220) || "something went wrong — try again";
  }
}

const API_ERROR_CODES: ReadonlySet<string> = new Set([
  "not-found",
  "invalid-request",
  "no-agent",
  "head-moved",
  "not-implemented",
  "no-content",
]);

function validCode(v: unknown): ApiErrorCode | undefined {
  return typeof v === "string" && API_ERROR_CODES.has(v) ? (v as ApiErrorCode) : undefined;
}

/**
 * Machine code + status behind a failed request (issue #86, finding
 * 10): parses the `METHOD path: STATUS {json}` transport error the
 * client itself throws. `code` is optional — old responses and stored
 * errors without one keep working, so every caller falls back to its
 * previous text match when it is absent.
 */
export interface ParsedApiError {
  status?: number;
  code?: ApiErrorCode;
  /** Raw body text after the status (JSON when the service sent one). */
  bodyText: string;
}

export function parseApiError(err: unknown): ParsedApiError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/^[A-Z]+ \/\S+: (\d{3}) ([\s\S]*)$/);
  if (!m) return { bodyText: raw };
  const status = Number(m[1]);
  const bodyText = (m[2] ?? "").trim();
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown };
    const code = validCode(parsed.code);
    return code === undefined ? { status, bodyText } : { status, code, bodyText };
  } catch {
    return { status, bodyText };
  }
}

/** Error code for a failed request, or undefined when it carries none. */
export function apiErrorCode(err: unknown): ApiErrorCode | undefined {
  return parseApiError(err).code;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  // Only claim JSON when there is a body: Fastify 400s a bodyless POST
  // that carries `content-type: application/json` (refresh, update,
  // summarize, cancel all post without one).
  const hasBody = init?.body !== undefined;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

import { DiagramStatusError } from "./diagram.js";
import { parseJobsBlocked, UpdateJobsBlockedError } from "./updateBlocked.js";

/**
 * `409` from the diagram endpoint: the hash is known but has no SVG
 * (binary missing/too old, or the source failed to compile). Thrown typed
 * so the diagram component renders the matching fallback branch.
 * Re-exported here (the class itself lives in the leaf `./diagram.js`
 * so the mock can import it without an import cycle).
 */
export { DiagramStatusError };
export { UpdateJobsBlockedError };

/**
 * Same auth as `request`, but returns raw text: diagram SVGs are
 * `image/svg+xml`, and an `<img src>` could neither carry the
 * `Authorization` header nor keep the citation anchors interactive.
 */
async function requestText(path: string, init?: RequestInit): Promise<string> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${body}`);
  }
  return res.text();
}

/** Fetch one cached diagram SVG, throwing `DiagramStatusError` on 409. */
async function fetchDiagramSvg(reviewId: string, hash: string, theme: DiagramTheme): Promise<string> {
  const path = `/api/reviews/${encodeURIComponent(reviewId)}/diagrams/${encodeURIComponent(hash)}?theme=${theme}`;
  try {
    return await requestText(path);
  } catch (err) {
    if (err instanceof Error) {
      const m = err.message.match(/: 409 ([\s\S]*)$/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as DiagramStatusBody;
          if (parsed.status === "unavailable" || parsed.status === "error") {
            throw new DiagramStatusError(parsed.status, parsed.error);
          }
        } catch (nested) {
          if (nested instanceof DiagramStatusError) throw nested;
        }
      }
    }
    throw err;
  }
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Mock mode (`VITE_MOCK=1`, `mise run dev:mock`): the API client is replaced
 * by an in-memory implementation of the same typed interface, serving a
 * `ReviewSnapshot` fixture and applying mutations through the WS-patch path.
 */
const MOCK = typeof import.meta !== "undefined" && import.meta.env?.VITE_MOCK === "1";

const realApi = {
  health: (): Promise<HealthResponse> => fetch("/api/health").then((r) => r.json()),

  repos: (): Promise<ReposResponse> => get("/api/repos"),
  addRepo: (body: AddRepoRequest): Promise<AddRepoResponse> =>
    request("/api/repos", { method: "POST", body: JSON.stringify(body) }),
  removeRepo: (id: string): Promise<RemoveRepoResponse> =>
    request(`/api/repos/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Ask the service to open a native folder dialog (#26). No request body. */
  pickFolder: (): Promise<PickFolderResponse> => post("/api/repos/pick-folder"),
  repoChanges: (id: string, filter?: ChangesFilter): Promise<RepoChangesResponse> =>
    get(`/api/repos/${encodeURIComponent(id)}/changes${filter ? `?filter=${filter}` : ""}`),

  createReview: (body: CreateReviewRequest): Promise<CreateReviewResponse> =>
    post("/api/reviews", body),
  /** Issue #222: create a document review (answered with its ready snapshot). */
  createDocument: (body: CreateDocumentRequest): Promise<ReviewSnapshot> =>
    post("/api/reviews", body),
  /** Issue #222: reading locations of a repo for the context-repo picker. */
  repoWorktrees: (id: string): Promise<RepoWorktreesResponse> =>
    get(`/api/repos/${encodeURIComponent(id)}/worktrees`),
  /** #92: re-run a failed ingest (409 when ready/loading, 202 with loading when retried). */
  retryReview: (id: string): Promise<ReviewSnapshot> =>
    post(`/api/reviews/${encodeURIComponent(id)}/retry`),
  reviews: (): Promise<ReviewsListResponse> => get("/api/reviews"),
  deleteReview: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** #115: re-do the guide (delete + create in one call); answers with the new loading review. */
  redoReview: (id: string): Promise<ReviewSnapshot> =>
    post(`/api/reviews/${encodeURIComponent(id)}/redo`),
  resetData: (): Promise<ResetDataResponse> => post("/api/reset"),
  readiness: (force?: boolean): Promise<ReadinessResponse> =>
    get(`/api/readiness${force ? "?force=1" : ""}`),
  review: (id: string, version?: number): Promise<ReviewSnapshot> =>
    get(`/api/reviews/${encodeURIComponent(id)}${version !== undefined ? `?version=${version}` : ""}`),
  refresh: (id: string): Promise<RefreshResponse> => post(`/api/reviews/${encodeURIComponent(id)}/refresh`),
  /** Re-enqueue the pipeline stages that never finished (guide error-state Retry). */
  resume: (id: string): Promise<ResumeReviewResponse> => post(`/api/reviews/${encodeURIComponent(id)}/resume`),
  update: (id: string): Promise<UpdateReviewResponse> => post(`/api/reviews/${encodeURIComponent(id)}/update`),
  action: (id: string, action: ReviewAction): Promise<ActionResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/actions`, action),

  updateHunk: (id: string, hash: string, body: UpdateHunkRequest): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/hunks/${encodeURIComponent(hash)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  summarizeHunk: (id: string, hash: string): Promise<SummarizeHunkResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/hunks/${encodeURIComponent(hash)}/summarize`),

  /** Per-file fold state (issue #162): persisted on the review. */
  updateFile: (id: string, fileKey: string, body: UpdateFileRequest): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/files/${encodeURIComponent(fileKey)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** Per-review diff view preferences (issue #168): persisted on the review. */
  updateView: (id: string, body: UpdateViewRequest): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/view`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** The diff's score/plotline filter, remembered with the review. */
  updateDiffFilter: (id: string, body: UpdateDiffFilterRequest): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/diff-filter`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** Custom guides: create one from the reader's request (202; streams over WS). */
  createGuide: (id: string, body: CreateCustomGuideRequest): Promise<CustomGuideResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/guides`, body),
  /** Answer a custom guide's clarifying question; generation continues. */
  answerGuide: (id: string, guideId: string, body: AnswerCustomGuideRequest): Promise<CustomGuideResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/guides/${encodeURIComponent(guideId)}/answer`, body),
  /** Guide ideas for the New guide box (written once per version, then reused). */
  suggestGuides: (id: string): Promise<{ suggestions: CustomGuideSuggestions | null; jobId?: string }> =>
    post(`/api/reviews/${encodeURIComponent(id)}/guides/suggestions`),
  regenerateGuide: (id: string, guideId: string): Promise<CustomGuideResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/guides/${encodeURIComponent(guideId)}/regenerate`),
  /** Remove a custom guide, its pages and its suggested comments not marked for the PR. */
  deleteGuide: (id: string, guideId: string): Promise<void> =>
    // 204, no JSON body: read it as text.
    requestText(`/api/reviews/${encodeURIComponent(id)}/guides/${encodeURIComponent(guideId)}`, {
      method: "DELETE",
    }).then(() => undefined),

  /** Raw file lines at a commit (issue #133: diff expansion). */
  fileSlice: (
    id: string,
    params: { path: string; commit: string; start: number; end: number },
  ): Promise<FileSliceResponse> =>
    get(
      `/api/reviews/${encodeURIComponent(id)}/file?path=${encodeURIComponent(params.path)}&commit=${encodeURIComponent(params.commit)}&start=${params.start}&end=${params.end}`,
    ),

  /** Enclosing units of a line range at a commit (issue #133, stage 2). */
  outline: (
    id: string,
    params: { path: string; commit: string; start: number; end: number },
  ): Promise<FileOutlineResponse> =>
    get(
      `/api/reviews/${encodeURIComponent(id)}/outline?path=${encodeURIComponent(params.path)}&commit=${encodeURIComponent(params.commit)}&start=${params.start}&end=${params.end}`,
    ),

  createComment: (reviewId: string, body: CreateCommentRequest): Promise<CreateCommentResponse> =>
    request(`/api/reviews/${encodeURIComponent(reviewId)}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  replyComment: (reviewId: string, commentId: string, body: ReplyCommentRequest): Promise<{ ok: boolean }> =>
    post(`/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}/replies`, body),
  updateComment: (reviewId: string, commentId: string, body: UpdateCommentRequest): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteComment: (reviewId: string, commentId: string): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    }),

  updateDescription: (id: string, body: UpdateDescriptionRequest): Promise<{ ok: boolean; changed?: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/description`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  revertDescription: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/reviews/${encodeURIComponent(id)}/description`, { method: "DELETE" }),
  submit: (id: string, body: SubmitReviewRequest): Promise<SubmitReviewResponse> =>
    post(`/api/reviews/${encodeURIComponent(id)}/submit`, body),
  submitPreview: (id: string): Promise<{ preview: SubmitPreview }> =>
    get(`/api/reviews/${encodeURIComponent(id)}/submit/preview`),
  prComments: (id: string): Promise<ExistingCommentsResponse> =>
    get(`/api/reviews/${encodeURIComponent(id)}/pr-comments`),
  outbox: (id: string): Promise<OutboxResponse> =>
    get(`/api/reviews/${encodeURIComponent(id)}/outbox`),

  viewer: (): Promise<ViewerResponse> => get("/api/viewer"),
  settings: (): Promise<Settings> => get("/api/settings"),
  saveSettings: (body: Partial<Settings>): Promise<Settings> =>
    request("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  models: (provider: string): Promise<ModelsResponse> =>
    get(`/api/models?provider=${encodeURIComponent(provider)}`),
  /** Thinking levels the provider's adapter offers (Default when none). */
  thinking: (provider: string): Promise<ThinkingResponse> =>
    get(`/api/thinking?provider=${encodeURIComponent(provider)}`),
  diagnostics: (): Promise<DiagnosticsResponse> => get("/api/diagnostics"),
  reload: (): Promise<ReloadResponse> => post("/api/reload"),

  updateStatus: (): Promise<UpdateStatusResponse> => get("/api/update/status"),
  updateChannels: (refresh?: boolean): Promise<UpdateChannelsResponse> =>
    get(`/api/update/channels${refresh ? "?refresh=1" : ""}`),
  /**
   * Switch builds, throwing `UpdateJobsBlockedError` (typed, with the
   * blocking jobs) when the service refuses for running jobs. Pass
   * `force` to switch anyway — the shutdown path stops the jobs and the
   * outcome records how many were interrupted.
   */
  updateSwitch: async (ref: string, force?: boolean): Promise<UpdateSwitchResponse> => {
    const body: UpdateSwitchRequest = force ? { ref, force: true } : { ref };
    try {
      return await post<UpdateSwitchResponse>("/api/update/switch", body);
    } catch (err) {
      if (err instanceof Error) {
        const m = err.message.match(/^POST \/api\/update\/switch: (\d{3}) ([\s\S]*)$/);
        if (m) {
          const blocked = parseJobsBlocked(Number(m[1]), m[2]);
          if (blocked) throw blocked;
        }
      }
      throw err;
    }
  },

  prompts: (reviewId?: string): Promise<PromptsResponse> =>
    get(`/api/prompts${reviewId ? `?review=${encodeURIComponent(reviewId)}` : ""}`),
  jobs: (reviewId?: string): Promise<JobsResponse> =>
    get(`/api/jobs${reviewId ? `?review=${encodeURIComponent(reviewId)}` : ""}`),
  job: (id: string): Promise<JobResponse> => get(`/api/jobs/${encodeURIComponent(id)}`),
  jobReply: (id: string): Promise<JobReplyResponse> =>
    get(`/api/jobs/${encodeURIComponent(id)}/reply`),
  jobOutput: (id: string): Promise<JobOutputResponse> =>
    get(`/api/jobs/${encodeURIComponent(id)}/output`),
  cancelJob: (id: string): Promise<{ job: Job }> => post(`/api/jobs/${encodeURIComponent(id)}/cancel`),
  setJobPriority: (id: string, priority: number): Promise<{ job: Job }> =>
    request(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ priority }),
    }),

  contributions: (reviewId: string): Promise<ContributionsResponse> =>
    get(`/api/reviews/${encodeURIComponent(reviewId)}/contributions`),

  sharedContext: (reviewId: string): Promise<SharedContextResponse> =>
    get(`/api/reviews/${encodeURIComponent(reviewId)}/shared-context`),

  diagramSvg: (reviewId: string, hash: string, theme: DiagramTheme): Promise<string> =>
    fetchDiagramSvg(reviewId, hash, theme),  deleteContribution: (reviewId: string, contributionId: string): Promise<DeleteContributionResponse> =>
    request(`/api/reviews/${encodeURIComponent(reviewId)}/contributions/${encodeURIComponent(contributionId)}`, {
      method: "DELETE",
    }),
  acceptContribution: (reviewId: string, contributionId: string): Promise<AcceptContributionResponse> =>
    post(`/api/reviews/${encodeURIComponent(reviewId)}/contributions/${encodeURIComponent(contributionId)}/accept`),
  dismissContribution: (reviewId: string, contributionId: string): Promise<DismissContributionResponse> =>
    post(`/api/reviews/${encodeURIComponent(reviewId)}/contributions/${encodeURIComponent(contributionId)}/dismiss`),
};

export type ApiClient = typeof realApi;

export const api: ApiClient = MOCK ? mockApi : realApi;
