/**
 * #123: one `git fetch` at ingest (head + base refspecs together), with
 * `gh pr view` running alongside the repo refresh.
 * #139: a silent fetch failure reports the fetch instead of "commit not
 * found"; a moved head re-reads once and retries.
 *
 * Real `git` against a local bare origin (fast, no network); `gh` and the
 * refresh are faked with delays so the overlap is observable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner, RunOptions, RunResult } from "../../src/exec/index.js";
import { FakeCommandRunner, RealCommandRunner } from "../../src/exec/index.js";
import { ingestReview } from "../../src/ingest/index.js";

const real = new RealCommandRunner();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await real.run("git", { args, cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Seed repo with main + feature; push branches (and optionally the pull ref) to a bare origin; return a fresh clone. */
async function makeCloneWithOrigin(opts: { withPullRef: boolean }): Promise<{
  work: string;
  head: string;
  base: string;
}> {
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-seed-"));
  await git(seed, "init", "-b", "main");
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "a.py"), "x = 1\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "base");
  const base = await git(seed, "rev-parse", "HEAD");
  await git(seed, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(seed, "a.py"), "x = 1\ny = 2\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "feature work");
  const head = await git(seed, "rev-parse", "HEAD");

  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-origin-"));
  await git(origin, "init", "--bare", "-q");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "-q", "origin", "main", "feature");
  if (opts.withPullRef) {
    await git(seed, "push", "-q", "origin", "feature:refs/pull/42/head");
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-work-"));
  const work = path.join(parent, "work");
  await git(parent, "clone", "-q", origin, work);
  return { work, head, base };
}

interface Span {
  label: string;
  start: number;
  end: number;
}

function prInfo(head: string): string {
  return JSON.stringify({
    title: "Feature",
    body: "Body.",
    author: { login: "octocat" },
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: head,
  });
}

describe("#123 one fetch at ingest", () => {
  it("gh pr view runs alongside the refresh; one fetch carries head + base", async () => {
    const { work, head, base } = await makeCloneWithOrigin({ withPullRef: true });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-data-"));
    const spans: Span[] = [];
    const fetches: string[][] = [];
    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        spans.push({ label, start, end: Date.now() });
      }
    };
    const runner: CommandRunner = {
      run: async (cmd: string, opts: RunOptions): Promise<RunResult> => {
        if (cmd === "gh") {
          return timed("gh", async () => {
            await sleep(300);
            return { stdout: prInfo(head), stderr: "", code: 0 };
          });
        }
        // #139: fetches carry the credential config ahead of the subcommand.
        if (cmd === "git" && opts.args.includes("fetch")) {
          fetches.push(opts.args);
        }
        return real.run(cmd, opts);
      },
    };
    // The repo-wide refresh the service starts for managed checkouts.
    const refreshP = (async (): Promise<unknown> => {
      const start = Date.now();
      try {
        await sleep(300);
        return null;
      } finally {
        spans.push({ label: "refresh", start, end: Date.now() });
      }
    })();

    const out = await ingestReview({ runner, dataDir }, { repoPath: work, pr: 42 }, undefined, refreshP);

    expect(out.version.headSha).toBe(head);
    expect(out.version.mergeBaseSha).toBe(base);
    expect(out.files.length).toBeGreaterThan(0);
    // One git fetch, both refspecs (with the #139 gh credential config).
    expect(fetches).toEqual([
      ["-c", "credential.https://github.com.helper=!gh auth git-credential", "fetch", "origin", "refs/pull/42/head", "+refs/heads/main:refs/remotes/origin/main"],
    ]);
    // gh and the refresh overlapped. The spans prove it; a wall-clock
    // bound flaked on the slower macOS runner (597 ms against 550).
    const gh = spans.find((s) => s.label === "gh")!;
    const rf = spans.find((s) => s.label === "refresh")!;
    expect(gh.start).toBeLessThan(rf.end);
    expect(rf.start).toBeLessThan(gh.end);
  });

  it("#139: a failed fetch reports the fetch failure, not 'commit not found'", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-fail-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-data-"));
    const missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const view = {
      cmd: "gh",
      stdout: prInfo(missing),
      stderr: "",
      code: 0,
    };
    const fake = new FakeCommandRunner();
    // `gh pr view` succeeds twice (initial read + the #139.3 re-read, which
    // returns the same head, so no retry can help).
    fake.enqueue({ ...view });
    fake.enqueue({ ...view });
    const cred = ["-c", "credential.https://github.com.helper=!gh auth git-credential"];
    fake.enqueue({
      cmd: "git",
      args: [...cred, "fetch", "origin", "refs/pull/42/head", "+refs/heads/main:refs/remotes/origin/main"],
      stdout: "",
      stderr: "fatal: Authentication failed for 'https://github.com/o/r/'",
      code: 1,
    });
    fake.enqueue({
      cmd: "git",
      args: [...cred, "fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature"],
      stdout: "",
      stderr: "fatal: Authentication failed for 'https://github.com/o/r/'",
      code: 1,
    });
    fake.enqueue({
      cmd: "git",
      args: [...cred, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      stdout: "",
      stderr: "fatal: Authentication failed for 'https://github.com/o/r/'",
      code: 1,
    });
    for (let i = 0; i < 2; i++) {
      fake.enqueue({ cmd: "git", args: ["cat-file", "-e", missing], stdout: "", stderr: "fatal: Not a valid object name", code: 1 });
    }
    let message = "";
    try {
      await ingestReview({ runner: fake, dataDir }, { repoPath, pr: 42 });
      expect.unreachable();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("couldn't download the commits for PR #42 (git fetch origin refs/pull/42/head +refs/heads/main:refs/remotes/origin/main failed");
    expect(message).toContain("fatal: Authentication failed");
    expect(message).toContain("then try again");
    expect(message).not.toContain("wasn't found in this repo");
    // The view ran twice (initial + re-read); every fetch attempt was kept.
    expect(fake.calls.filter((c) => c.cmd === "gh").length).toBe(2);
    const gitCalls = fake.calls.filter((c) => c.cmd === "git");
    expect(gitCalls.length).toBe(5);
    // Fetches run with GITHUB_TOKEN unset, like every `gh` call (PRD §15).
    for (const c of gitCalls) expect(c.opts.env?.["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("#139: a moved head re-reads once and retries", async () => {
    const { work, head } = await makeCloneWithOrigin({ withPullRef: true });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-data-"));
    const bogus = "a".repeat(40);
    const fake = new FakeCommandRunner();
    const viewFor = (oid: string): { cmd: string; stdout: string; stderr: string; code: number } => ({
      cmd: "gh",
      stdout: JSON.stringify({
        title: "Feature",
        body: "Body.",
        author: { login: "octocat" },
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: oid,
      }),
      stderr: "",
      code: 0,
    });
    // First read: a stale head (force-pushed since); re-read: the real one.
    fake.enqueue(viewFor(bogus));
    fake.enqueue(viewFor(head));
    const runner: CommandRunner = {
      run: (cmd, opts) => (cmd === "gh" ? fake.run(cmd, opts) : real.run(cmd, opts)),
    };
    const out = await ingestReview({ runner, dataDir }, { repoPath: work, pr: 42 });
    expect(out.version.headSha).toBe(head);
    expect(fake.calls.filter((c) => c.cmd === "gh").length).toBe(2);
  });

  it("falls back to branch + base fetches when the remote has no pull refs", async () => {
    const { work, head, base } = await makeCloneWithOrigin({ withPullRef: false });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-fetch-data-"));
    const fetches: string[][] = [];
    const runner: CommandRunner = {
      run: async (cmd: string, opts: RunOptions): Promise<RunResult> => {
        if (cmd === "gh") return { stdout: prInfo(head), stderr: "", code: 0 };
        if (cmd === "git" && opts.args.includes("fetch")) fetches.push(opts.args);
        return real.run(cmd, opts);
      },
    };
    const out = await ingestReview({ runner, dataDir }, { repoPath: work, pr: 42 });
    expect(out.version.headSha).toBe(head);
    expect(out.version.mergeBaseSha).toBe(base);
    // Combined attempt first (fails on the pull refspec), then the #93
    // per-refspec fallback: branch head + base.
    const cred = ["-c", "credential.https://github.com.helper=!gh auth git-credential"];
    expect(fetches[0]).toEqual([...cred, "fetch", "origin", "refs/pull/42/head", "+refs/heads/main:refs/remotes/origin/main"]);
    expect(fetches.slice(1)).toEqual([
      [...cred, "fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature"],
      [...cred, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    ]);
  });
});
