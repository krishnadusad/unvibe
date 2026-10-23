/**
 * The PR's GitHub discussion for a custom guide: inline review comments,
 * conversation comments and review summaries (approve / request changes),
 * read with `gh api` GETs only (never posts). Fetched fresh for every
 * guide run, paginated, so a "summarize the reviewers' comments" request
 * sees what was said up to now — not only the first page the comments
 * menu loads at ingest.
 */
import type { CommandRunner } from "../exec/index.js";
import { runGh } from "../exec/index.js";

export interface GuideComment {
  id: number;
  kind: "inline" | "conversation" | "review";
  author?: string;
  createdAt?: string;
  body: string;
  path?: string;
  line?: number;
  /** Inline replies: the comment they answer. */
  replyTo?: number;
  /** Reviews: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state?: string;
}

/** Most comments read per endpoint (keeps a huge PR's prompt bounded). */
const PER_ENDPOINT_MAX = 300;

/** One `gh api --paginate` GET, one compact JSON object per line. */
async function listJson(
  runner: CommandRunner,
  cwd: string,
  path: string,
  jq: string,
): Promise<Record<string, unknown>[]> {
  const args = ["api", "--paginate", path, "--jq", jq];
  const res = await runGh(runner, args, { args, cwd, timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`gh api ${path} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  const out: Record<string, unknown>[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip a malformed line rather than lose the rest.
    }
    if (out.length >= PER_ENDPOINT_MAX) break;
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export async function fetchGuideComments(
  runner: CommandRunner,
  repoPath: string,
  owner: string,
  repo: string,
  pr: number,
): Promise<GuideComment[]> {
  const base = `repos/${owner}/${repo}`;
  const [inline, conversation, reviews] = await Promise.all([
    listJson(runner, repoPath, `${base}/pulls/${pr}/comments`,
      ".[] | {id, body, path, line: (.line // .original_line), author: .user.login, createdAt: .created_at, replyTo: .in_reply_to_id}"),
    listJson(runner, repoPath, `${base}/issues/${pr}/comments`,
      ".[] | {id, body, author: .user.login, createdAt: .created_at}"),
    listJson(runner, repoPath, `${base}/pulls/${pr}/reviews`,
      ".[] | {id, body, state, author: .user.login, createdAt: .submitted_at}"),
  ]);
  const out: GuideComment[] = [];
  for (const c of inline) {
    const id = num(c["id"]);
    if (id === undefined) continue;
    out.push({
      id,
      kind: "inline",
      body: str(c["body"]) ?? "",
      ...(str(c["path"]) ? { path: str(c["path"]) } : {}),
      ...(num(c["line"]) !== undefined ? { line: num(c["line"]) } : {}),
      ...(str(c["author"]) ? { author: str(c["author"]) } : {}),
      ...(str(c["createdAt"]) ? { createdAt: str(c["createdAt"]) } : {}),
      ...(num(c["replyTo"]) !== undefined ? { replyTo: num(c["replyTo"]) } : {}),
    });
  }
  for (const c of conversation) {
    const id = num(c["id"]);
    if (id === undefined) continue;
    out.push({
      id,
      kind: "conversation",
      body: str(c["body"]) ?? "",
      ...(str(c["author"]) ? { author: str(c["author"]) } : {}),
      ...(str(c["createdAt"]) ? { createdAt: str(c["createdAt"]) } : {}),
    });
  }
  for (const r of reviews) {
    const id = num(r["id"]);
    const state = str(r["state"]);
    const body = str(r["body"]) ?? "";
    // A bare "commented" review carries nothing beyond its inline comments.
    if (id === undefined || (body === "" && (state === undefined || state === "COMMENTED"))) continue;
    out.push({
      id,
      kind: "review",
      body,
      ...(state ? { state } : {}),
      ...(str(r["author"]) ? { author: str(r["author"]) } : {}),
      ...(str(r["createdAt"]) ? { createdAt: str(r["createdAt"]) } : {}),
    });
  }
  return out;
}
