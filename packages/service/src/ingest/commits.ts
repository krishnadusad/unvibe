/**
 * Issue #193: map each commit to the PR hunks it touched.
 *
 * Ingest already reads commit subjects/bodies (#92, `readCommitMessages`);
 * this adds files + hunk IDs per commit. A commit's own diff is against
 * its parent, while the PR diff is against the merge-base, so line
 * numbers drift as commits stack: a PR hunk belongs to a commit when
 * they share a file and either their new-side ranges overlap or they
 * share a changed line's text. A commit whose change a later commit
 * overwrote can end up with files but no surviving PR hunks — that is
 * honest, and the reader still sees its message.
 */
import type { ReviewCommit, ReviewFile } from "@unvibe/shared";
import type { CommandRunner } from "../exec/index.js";
import type { CommitMessage } from "./description.js";
import { parseUnifiedDiff, type ParsedFile } from "./diff.js";

/** Most commits whose diffs ingest fetches (messages are kept for all). */
export const MAX_COMMIT_DIFFS = 100;

function changedTexts(lines: { kind: string; text: string }[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.kind === "ctx") continue;
    const t = l.text.trim().replace(/\s+/g, " ");
    if (t.length >= 4 && /[A-Za-z0-9]/.test(t)) out.add(t);
  }
  return out;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Pure mapping from per-commit parsed diffs to stored commit evidence. */
export function buildReviewCommits(
  messages: CommitMessage[],
  diffsBySha: ReadonlyMap<string, ParsedFile[]>,
  files: ReviewFile[],
): ReviewCommit[] {
  const byPath = new Map<string, ReviewFile>();
  for (const f of files) {
    byPath.set(f.path, f);
    if (f.oldPath) byPath.set(f.oldPath, f);
  }
  return messages.map((m) => {
    const commitFiles: string[] = [];
    const hunks: string[] = [];
    const seenHunks = new Set<string>();
    for (const pf of diffsBySha.get(m.sha) ?? []) {
      const rf = byPath.get(pf.path) ?? (pf.oldPath ? byPath.get(pf.oldPath) : undefined);
      const displayPath = rf?.path ?? pf.path;
      if (!commitFiles.includes(displayPath)) commitFiles.push(displayPath);
      if (!rf) continue;
      for (const ph of pf.hunks) {
        const texts = changedTexts(ph.lines);
        for (const rh of rf.hunks) {
          const id = `h:${rf.fileKey}:${rh.contentHash}`;
          if (seenHunks.has(id)) continue;
          const overlap = rangesOverlap(ph.newStart, ph.newEnd, rh.newStart, rh.newEnd);
          const shared = !overlap && [...texts].some((t) => changedTexts(rh.lines).has(t));
          if (overlap || shared) {
            seenHunks.add(id);
            hunks.push(id);
          }
        }
      }
    }
    return {
      sha: m.sha,
      subject: m.subject,
      body: m.body,
      author: m.author,
      authorDate: m.authorDate,
      committerDate: m.committerDate,
      files: commitFiles,
      hunks,
    };
  });
}

/** Per-commit diffs via `git show` (one call per commit, capped). */
export async function readCommitDiffs(
  runner: CommandRunner,
  repoPath: string,
  commits: CommitMessage[],
): Promise<Map<string, ParsedFile[]>> {
  const out = new Map<string, ParsedFile[]>();
  for (const c of commits.slice(0, MAX_COMMIT_DIFFS)) {
    try {
      const res = await runner.run("git", {
        args: ["show", "--format=", "--no-color", "--no-ext-diff", "-U3", "-M", c.sha],
        cwd: repoPath,
      });
      if (res.code === 0) out.set(c.sha, parseUnifiedDiff(res.stdout));
    } catch {
      // Best effort: the commit keeps its message and no file list.
    }
  }
  return out;
}
