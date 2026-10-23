/**
 * Source resolution (ingest, PRD §11.1 step 1 + §15).
 *
 * - PR: `gh pr view <n> --json …` for metadata, then `git fetch` (best
 *   effort: forks may only be reachable as `pull/<n>/head`), then the
 *   merge-base and a local `git diff` (more reliable than `gh pr diff` for
 *   large PRs, PRD §15).
 * - Branch: `git fetch` (best effort for remote-less test repos), head via
 *   `git rev-parse`, base = upstream → default branch → root commit.
 *
 * All commands go through the injectable `CommandRunner`; `gh` runs with
 * `GITHUB_TOKEN` unset (PRD §15). Fetches stay best-effort — local
 * branches and test fixtures have no remote — but every attempt is kept
 * (#139): when the PR head is missing afterwards, ingest fails with the
 * fetch failure in plain words instead of "commit not found".
 */
import type { CommandRunner } from "../exec/index.js";
import { runGh, runGitFetch } from "../exec/index.js";
import type { CommitMessage } from "./description.js";

export interface IngestSource {
  /** Absolute path of the user's checkout (never written to). */
  repoPath: string;
  pr?: number;
  branch?: string;
}

export interface PrInfo {
  title: string;
  body: string;
  authorLogin: string;
  /** OPEN | CLOSED | MERGED (gh `state` field). */
  state: string;
  isDraft: boolean;
  /** gh `reviewDecision` (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""). */
  reviewDecision: string;
  /** #230: gh `reviewRequests` (users carry `login`; teams carry `slug`/`name`). */
  reviewRequests: unknown;
  /** #230: gh `latestReviews` (entries carry `author.login` + `state`). */
  latestReviews: unknown;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

export interface ResolvedSource {
  /** Display title: PR title or branch name. */
  title: string;
  branch: string;
  prNumber?: number;
  baseRef: string;
  headSha: string;
  mergeBaseSha: string;
  diffText: string;
  descriptionMarkdown: string;
  commits: CommitMessage[];
  /** M1 approximation of "user authors an open PR" (PRD §4.11). */
  descriptionEditable: boolean;
  /** PR author login + gh state (OPEN/CLOSED/MERGED) for the author line. Absent on branches. */
  descriptionAuthor?: string;
  descriptionState?: string;
  /** #224: gh `isDraft` for the stored description. Absent on branches. */
  descriptionIsDraft?: boolean;
  /** #224: raw gh `reviewDecision` for the stored description. Absent on branches. */
  descriptionReviewDecision?: string;
  /** #230: raw gh `reviewRequests` for the displayed-decision rule. Absent on branches. */
  descriptionReviewRequests?: unknown;
  /** #230: raw gh `latestReviews` for the displayed-decision rule. Absent on branches. */
  descriptionLatestReviews?: unknown;
  worktreePath: string;
}

async function runGit(
  runner: CommandRunner,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await runner.run("git", { args, cwd });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/**
 * What one `git fetch` attempt did (#139). Every fetch (combined and
 * fallback) is kept, so when the head commit is missing afterwards the
 * error can name the fetch failure instead of blaming the repo.
 */
export interface FetchAttempt {
  /** The exact command, e.g. "git fetch origin refs/pull/42/head main". */
  command: string;
  ok: boolean;
  /** Shortened git stderr (or stdout) when it failed. */
  detail: string;
}

/**
 * Run one `git fetch origin …` with the user's `gh` login (#139) and record
 * what happened (never throws). The recorded command omits the per-command
 * credential config: the user sees which fetch failed, not the plumbing.
 */
async function runFetch(runner: CommandRunner, repoPath: string, refspecs: string[]): Promise<FetchAttempt> {
  const command = `git fetch origin ${refspecs.join(" ")}`.trim();
  try {
    const res = await runGitFetch(runner, refspecs, { cwd: repoPath });
    return {
      command,
      ok: res.code === 0,
      detail: res.code === 0 ? "" : (res.stderr.trim() || res.stdout.trim()).slice(0, 300),
    };
  } catch (e) {
    return { command, ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/**
 * Explicit refspec for a branch name: `+refs/heads/<b>:refs/remotes/origin/<b>`.
 * A bare `git fetch origin <b>` only writes `FETCH_HEAD`; it updates
 * `origin/<b>` only when the remote's configured fetch refspec already
 * covers `<b>`. Single-branch clones (`clone --single-branch`, CI-style
 * checkouts, `remote.origin.fetch` narrowed to `main`) don't, so a stacked
 * PR's base never became `origin/<base>` and the merge-base failed. Naming
 * the destination makes the remote-tracking ref exist after the fetch,
 * whatever the clone's refspec. Already-qualified `origin/…` names map to
 * their branch.
 */
export function branchRefspec(branch: string): string {
  const name = branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
  return `+refs/heads/${name}:refs/remotes/origin/${name}`;
}

async function bestEffortFetch(runner: CommandRunner, repoPath: string, branch: string): Promise<FetchAttempt> {
  if (!branch) return { command: "git fetch origin", ok: false, detail: "no ref to fetch" };
  // No remote / offline / test fixture: ingest proceeds with local refs.
  return runFetch(runner, repoPath, [branchRefspec(branch)]);
}

/**
 * Ordered merge-base candidates for a base branch name (#93). The managed
 * clone only has `origin/<base>` for non-default branches (stacked PRs),
 * so the remote-tracking name comes first; the bare name is the fallback
 * for remote-less fixtures. Already-qualified `origin/…` names pass
 * through unchanged. All git/gh access in this module assumes the
 * `origin` remote (like `defaultBranch` below, `detect.ts`, and the
 * managed clones): a checkout whose GitHub remote has another name is not
 * handled — detection itself reads only `origin`.
 */
export function baseRefCandidates(baseRefName: string): string[] {
  if (!baseRefName) return [];
  if (baseRefName.startsWith("origin/")) return [baseRefName];
  return [`origin/${baseRefName}`, baseRefName];
}

/**
 * #123: one `git fetch` for the PR head and the base together (was two
 * sequential fetches). The head keeps its #93 shape — `refs/pull/<n>/head`
 * with the branch-name fallback — and the base stays best-effort. The base
 * goes through `branchRefspec` so `origin/<base>` exists afterwards even in
 * a single-branch clone (stacked PRs). Refresh uses the same fetch, so a
 * stacked base that moved since ingest is current too.
 *
 * #139: every attempt is returned (combined and fallback). Best-effort
 * stays — offline use and remote-less fixtures keep working — it just
 * stops discarding what happened, so a missing head can report the fetch
 * failure instead of "commit not found".
 */
async function fetchPrHeadAndBase(
  runner: CommandRunner,
  repoPath: string,
  pr: number,
  headRefName: string,
  baseRefName: string,
): Promise<FetchAttempt[]> {
  const first = await runFetch(
    runner,
    repoPath,
    [`refs/pull/${pr}/head`, ...(baseRefName ? [branchRefspec(baseRefName)] : [])],
  );
  if (first.ok) return [first];
  const out = [first];
  if (headRefName) {
    out.push(await bestEffortFetch(runner, repoPath, headRefName));
  }
  if (baseRefName) {
    out.push(await bestEffortFetch(runner, repoPath, baseRefName));
  }
  return out;
}

/**
 * #139: the head commit is missing after fetching. Name the fetch failure
 * and its reason in plain words (which fetch, what git said, what to try)
 * instead of "commit not found". When every fetch worked but the commit is
 * still gone (moved head that the retry below did not catch, shallow or
 * partial clone), say that instead.
 */
function headFetchError(pr: number, headSha: string, attempts: FetchAttempt[]): Error {
  const failed = attempts.filter((a) => !a.ok);
  if (failed.length > 0) {
    const first = failed[0];
    const reason = first.detail ? `: ${first.detail}` : "";
    return new Error(
      `couldn't download the commits for PR #${pr} (${first.command} failed${reason}). ` +
        `Check that this machine can reach GitHub, then try again — your repo is fine, ` +
        `Unvibe downloads the PR's commits itself.`,
    );
  }
  return new Error(
    `couldn't download the commits for PR #${pr}: the download seemed to work but commit ` +
      `${headSha} isn't there. The PR may have changed just now — try again, and if it keeps ` +
      `failing run \`git fetch origin refs/pull/${pr}/head\` in the repo and open the PR again.`,
  );
}

/**
 * Merge-base against `origin/<base>` first, bare `<base>` second (#93).
 * Shared by the PR path here and `versions/refresh.ts` so stacked-PR
 * bases (and a local default branch behind `origin`) resolve the same way
 * in both. Throws a plain message naming what is missing (base ref vs
 * head commit) plus git's stderr.
 */
export async function resolvePrMergeBase(
  runner: CommandRunner,
  repoPath: string,
  baseRefName: string,
  headSha: string,
): Promise<{ baseRef: string; mergeBaseSha: string }> {
  const candidates = baseRefCandidates(baseRefName);
  let lastDetail = "";
  for (const base of candidates) {
    const mb = await runGit(runner, ["merge-base", base, headSha], repoPath);
    if (mb.ok && mb.stdout.trim()) {
      return { baseRef: base, mergeBaseSha: mb.stdout.trim().split("\n")[0] };
    }
    lastDetail = (mb.stderr.trim() || mb.stdout.trim()).slice(0, 500);
  }
  const baseOk = await baseRefExists(runner, repoPath, candidates);
  if (!baseOk) {
    const tried = candidates.length > 0 ? ` (looked for ${candidates.join(", ")})` : "";
    throw new Error(
      `the base branch "${baseRefName}" wasn't found in this repo${tried}${lastDetail ? `: ${lastDetail}` : ""}`,
    );
  }
  const headOk = await headCommitExists(runner, repoPath, headSha);
  if (!headOk) {
    throw new Error(
      `the PR's commit ${headSha} wasn't found in this repo${lastDetail ? `: ${lastDetail}` : ""}`,
    );
  }
  throw new Error(
    `the shared history with ${candidates[0] ?? baseRefName} couldn't be found${lastDetail ? `: ${lastDetail}` : ""}`,
  );
}

async function baseRefExists(runner: CommandRunner, repoPath: string, candidates: string[]): Promise<boolean> {
  for (const base of candidates) {
    try {
      const res = await runner.run("git", { args: ["rev-parse", "--verify", base], cwd: repoPath });
      if (res.code === 0) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

async function headCommitExists(runner: CommandRunner, repoPath: string, headSha: string): Promise<boolean> {
  if (!headSha) return false;
  try {
    const res = await runner.run("git", { args: ["cat-file", "-e", headSha], cwd: repoPath });
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function fetchPrInfo(
  runner: CommandRunner,
  repoPath: string,
  pr: number,
): Promise<PrInfo> {
  const args = [
    "pr",
    "view",
    String(pr),
    "--json",
    "title,body,author,state,isDraft,reviewDecision,reviewRequests,latestReviews,baseRefName,headRefName,headRefOid",
  ];
  const res = await runGh(runner, args, { args, cwd: repoPath });
  if (res.code !== 0) {
    throw new Error(`gh pr view ${pr} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const json = JSON.parse(res.stdout) as {
    title: string;
    body: string;
    author: { login: string };
    state: string;
    isDraft: boolean;
    reviewDecision?: string;
    reviewRequests?: unknown;
    latestReviews?: unknown;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
  };
  return {
    title: json.title ?? `PR #${pr}`,
    body: json.body ?? "",
    authorLogin: json.author?.login ?? "",
    state: json.state ?? "",
    isDraft: json.isDraft ?? false,
    reviewDecision: json.reviewDecision ?? "",
    reviewRequests: json.reviewRequests ?? [],
    latestReviews: json.latestReviews ?? [],
    baseRefName: json.baseRefName ?? "",
    headRefName: json.headRefName ?? "",
    headRefOid: json.headRefOid ?? "",
  };
}

/**
 * Commits in merge-base..head order (oldest first), null-separated:
 * sha, author, author date, committer date, subject, body. Dates are
 * strict ISO 8601 with the author's offset, so "today's commits" can be
 * judged in the reader's own timezone.
 */
export async function readCommitMessages(
  runner: CommandRunner,
  repoPath: string,
  mergeBase: string,
  head: string,
): Promise<CommitMessage[]> {
  const res = await runGit(runner, [
    "log",
    "--reverse",
    "--format=%H%x00%an%x00%aI%x00%cI%x00%s%x00%b%x1e",
    `${mergeBase}..${head}`,
  ], repoPath);
  if (!res.ok) return [];
  const commits: CommitMessage[] = [];
  for (const record of res.stdout.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [sha = "", author = "", authorDate = "", committerDate = "", subject = "", body = ""] = trimmed.split("\0");
    if (!sha) continue;
    commits.push({
      sha: sha.trim(),
      subject: subject.trim(),
      body: body.trim(),
      author: author.trim(),
      authorDate: authorDate.trim(),
      committerDate: committerDate.trim(),
    });
  }
  return commits;
}

/** Default branch from `origin/HEAD`, e.g. `origin/main`. Null when unknown. */
async function defaultBranch(runner: CommandRunner, repoPath: string): Promise<string | null> {
  const res = await runGit(runner, ["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath);
  if (!res.ok) return null;
  const ref = res.stdout.trim().replace(/^refs\/remotes\//, "");
  return ref || null;
}

async function resolveBranchBase(
  runner: CommandRunner,
  repoPath: string,
  branch: string,
  headSha: string,
): Promise<{ baseRef: string; mergeBaseSha: string }> {
  const candidates: string[] = [];
  const upstream = await runGit(runner, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], repoPath);
  if (upstream.ok && upstream.stdout.trim()) candidates.push(upstream.stdout.trim());
  const def = await defaultBranch(runner, repoPath);
  if (def) candidates.push(def);
  for (const fallback of ["origin/main", "origin/master", "main", "master"]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  for (const base of candidates) {
    const mb = await runGit(runner, ["merge-base", base, headSha], repoPath);
    if (mb.ok && mb.stdout.trim()) {
      return { baseRef: base, mergeBaseSha: mb.stdout.trim().split("\n")[0] };
    }
  }
  // Degenerate (remote-less single-branch fixture): diff against the root.
  const root = await runGit(runner, ["rev-list", "--max-parents=0", headSha], repoPath);
  const rootSha = root.ok ? root.stdout.trim().split("\n")[0] : headSha;
  return { baseRef: branch, mergeBaseSha: rootSha ?? headSha };
}

/**
 * Ensure the managed worktree for a review exists at `<dataDir>/worktrees/<id>`
 * and points at `headSha`; reuse when it already does. Never writes into the
 * user's checkout (PRD §14).
 */
export async function ensureWorktree(
  runner: CommandRunner,
  repoPath: string,
  dataDir: string,
  id: string,
  headSha: string,
): Promise<string> {
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs");
  const wt = path.join(dataDir, "worktrees", id);
  try {
    if (fs.existsSync(wt)) {
      const cur = await runGit(runner, ["rev-parse", "HEAD"], wt);
      if (cur.ok && cur.stdout.trim() === headSha) return wt;
      // Stale worktree dir: remove and re-add below.
      await runner.run("git", { args: ["worktree", "remove", "--force", wt], cwd: repoPath });
      fs.rmSync(wt, { recursive: true, force: true });
      await runner.run("git", { args: ["worktree", "prune"], cwd: repoPath });
    }
  } catch {
    // Fall through to re-add.
  }
  const res = await runner.run("git", { args: ["worktree", "add", wt, headSha], cwd: repoPath });
  if (res.code !== 0) {
    throw new Error(`couldn't create a working copy (git worktree add): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return wt;
}

/**
 * Resolve a PR or branch source to SHAs + diff text + worktree.
 *
 * `refresh` (PR sources on managed checkouts): the repo-wide `git fetch`
 * started by the caller. The PR path awaits it alongside `gh pr view`
 * (#123: API vs git, independent) instead of serially before it.
 */
export async function resolveSource(
  runner: CommandRunner,
  source: IngestSource,
  dataDir: string,
  reviewId: string,
  refresh?: Promise<unknown> | null,
): Promise<ResolvedSource> {
  const { repoPath } = source;
  let title: string;
  let branch: string;
  let prNumber: number | undefined;
  let baseRef: string;
  let headSha: string;
  let descriptionMarkdown = "";
  let descriptionEditable = false;
  let descriptionAuthor: string | undefined;
  let descriptionState: string | undefined;
  let descriptionIsDraft: boolean | undefined;
  let descriptionReviewDecision: string | undefined;
  let descriptionReviewRequests: unknown = [];
  let descriptionLatestReviews: unknown = [];

  if (source.pr !== undefined) {
    const [info] = await Promise.all([fetchPrInfo(runner, repoPath, source.pr), refresh ?? null]);
    prNumber = source.pr;
    title = info.title;
    branch = info.headRefName;
    baseRef = info.baseRefName;
    headSha = info.headRefOid;
    descriptionMarkdown = info.body;
    // M1 approximation: editable when the PR is open. The author check
    // needs the viewer login (an extra `gh api user` call); M4 refines it.
    descriptionEditable = info.state === "OPEN";
    descriptionAuthor = info.authorLogin || undefined;
    descriptionState = info.state || undefined;
    descriptionIsDraft = info.isDraft;
    descriptionReviewDecision = info.reviewDecision || undefined;
    descriptionReviewRequests = info.reviewRequests ?? [];
    descriptionLatestReviews = info.latestReviews ?? [];
    let attempts = await fetchPrHeadAndBase(runner, repoPath, source.pr, info.headRefName, baseRef);
    if (!headSha) {
      const local = await runGit(runner, ["rev-parse", info.headRefName], repoPath);
      if (!local.ok) {
        // #139: the branch is missing locally most often because the fetch
        // above failed — report that instead of the bare rev-parse stderr.
        if (attempts.some((a) => !a.ok)) throw headFetchError(source.pr, info.headRefName || `#${source.pr}`, attempts);
        const detail = (local.stderr.trim() || local.stdout.trim()).slice(0, 300);
        throw new Error(
          `the PR's branch ${info.headRefName || `#${source.pr}`} wasn't found in this repo${detail ? `: ${detail}` : ""}`,
        );
      }
      headSha = local.stdout.trim();
    } else if (!(await headCommitExists(runner, repoPath, headSha))) {
      // #139: the head may have moved between `gh pr view` and the fetch
      // (force-push) — re-read once and retry for the new head.
      const reread = await fetchPrInfo(runner, repoPath, source.pr).catch(() => null);
      if (reread && reread.headRefOid && reread.headRefOid !== headSha) {
        headSha = reread.headRefOid;
        baseRef = reread.baseRefName || baseRef;
        attempts = [
          ...attempts,
          ...(await fetchPrHeadAndBase(runner, repoPath, source.pr, reread.headRefName, baseRef)),
        ];
      }
      if (!(await headCommitExists(runner, repoPath, headSha))) {
        throw headFetchError(source.pr, headSha, attempts);
      }
    }
  } else if (source.branch !== undefined) {
    branch = source.branch;
    title = source.branch;
    await bestEffortFetch(runner, repoPath, branch);
    let head = await runGit(runner, ["rev-parse", branch], repoPath);
    if (!head.ok) {
      head = await runGit(runner, ["rev-parse", `origin/${branch}`], repoPath);
    }
    if (!head.ok) throw new Error(`branch ${branch} was not found in this repo`);
    headSha = head.stdout.trim();
    const base = await resolveBranchBase(runner, repoPath, branch, headSha);
    baseRef = base.baseRef;
    const mergeBaseSha = base.mergeBaseSha;
    return finishResolve(runner, {
      repoPath, title, branch, prNumber, baseRef, headSha, mergeBaseSha,
      descriptionMarkdown: "", descriptionEditable: false, dataDir, reviewId,
    });
  } else {
    throw new Error("ingest needs either pr or branch");
  }

  const resolvedBase = await resolvePrMergeBase(runner, repoPath, baseRef, headSha);
  baseRef = resolvedBase.baseRef;
  const mergeBaseSha = resolvedBase.mergeBaseSha;
  return finishResolve(runner, {
    repoPath, title, branch, prNumber, baseRef, headSha, mergeBaseSha,
    descriptionMarkdown, descriptionEditable, descriptionAuthor, descriptionState, descriptionIsDraft, descriptionReviewDecision, descriptionReviewRequests, descriptionLatestReviews, dataDir, reviewId,
  });
}

async function finishResolve(
  runner: CommandRunner,
  r: {
    repoPath: string;
    title: string;
    branch: string;
    prNumber?: number;
    baseRef: string;
    headSha: string;
    mergeBaseSha: string;
    descriptionMarkdown: string;
    descriptionEditable: boolean;
    descriptionAuthor?: string;
    descriptionState?: string;
    descriptionIsDraft?: boolean;
    descriptionReviewDecision?: string;
    descriptionReviewRequests?: unknown;
    descriptionLatestReviews?: unknown;
    dataDir: string;
    reviewId: string;
  },
): Promise<ResolvedSource> {
  const diff = await runGit(
    runner,
    ["diff", "-U3", "-M", "--no-color", "--no-ext-diff", r.mergeBaseSha, r.headSha, "--"],
    r.repoPath,
  );
  if (!diff.ok) throw new Error(`git diff failed for ${r.headSha}`);
  const commits = await readCommitMessages(runner, r.repoPath, r.mergeBaseSha, r.headSha);
  const worktreePath = await ensureWorktree(runner, r.repoPath, r.dataDir, r.reviewId, r.headSha);
  return {
    title: r.title,
    branch: r.branch,
    ...(r.prNumber !== undefined ? { prNumber: r.prNumber } : {}),
    baseRef: r.baseRef,
    headSha: r.headSha,
    mergeBaseSha: r.mergeBaseSha,
    diffText: diff.stdout,
    descriptionMarkdown: r.descriptionMarkdown,
    commits,
    descriptionEditable: r.descriptionEditable,
    ...(r.descriptionAuthor !== undefined ? { descriptionAuthor: r.descriptionAuthor } : {}),
    ...(r.descriptionState !== undefined ? { descriptionState: r.descriptionState } : {}),
    ...(r.descriptionIsDraft !== undefined ? { descriptionIsDraft: r.descriptionIsDraft } : {}),
    ...(r.descriptionReviewDecision !== undefined ? { descriptionReviewDecision: r.descriptionReviewDecision } : {}),
    ...(r.descriptionReviewRequests !== undefined ? { descriptionReviewRequests: r.descriptionReviewRequests } : {}),
    ...(r.descriptionLatestReviews !== undefined ? { descriptionLatestReviews: r.descriptionLatestReviews } : {}),
    worktreePath,
  };
}

/**
 * Lightweight re-resolution for `POST /reviews/:id/refresh`: fetch, then
 * report whether the head SHA moved. No version is created here (M5 seam:
 * version creation + ID mapping happens in the M5 update pass).
 */
export async function resolveHead(
  runner: CommandRunner,
  repoPath: string,
  opts: { pr?: number; branch?: string },
): Promise<{ headSha: string; baseRef: string; prState?: string; isDraft?: boolean; reviewDecision?: string; reviewRequests?: unknown; latestReviews?: unknown }> {
  if (opts.pr !== undefined) {
    const info = await fetchPrInfo(runner, repoPath, opts.pr);
    // #139: same gh-login handling as the ingest fetch (refresh path stays quiet).
    await fetchPrHeadAndBase(runner, repoPath, opts.pr, info.headRefName, info.baseRefName);
    let headSha = info.headRefOid;
    if (!headSha) {
      const local = await runGit(runner, ["rev-parse", info.headRefName], repoPath);
      headSha = local.ok ? local.stdout.trim() : "";
    }
    return { headSha, baseRef: info.baseRefName, prState: info.state || undefined, isDraft: info.isDraft, reviewDecision: info.reviewDecision || undefined, reviewRequests: info.reviewRequests ?? [], latestReviews: info.latestReviews ?? [] };
  }
  const branch = opts.branch ?? "";
  await bestEffortFetch(runner, repoPath, branch);
  let head = await runGit(runner, ["rev-parse", branch], repoPath);
  if (!head.ok) head = await runGit(runner, ["rev-parse", `origin/${branch}`], repoPath);
  return { headSha: head.ok ? head.stdout.trim() : "", baseRef: branch };
}
