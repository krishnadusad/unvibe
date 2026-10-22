/**
 * #93: PR merge-base against `origin/<base>` + head fetch via
 * `refs/pull/<n>/head`, through the shared helper.
 *
 * - stacked PR (base != default) resolves via `origin/<base>` when the bare
 *   local branch is gone;
 * - fork PR head fetch tries `refs/pull/<n>/head` first (recorded), then the
 *   branch name, and ingest still succeeds when the branch name is unknown;
 * - default-branch case still works;
 * - error text names the missing base vs head and includes git stderr.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../src/exec/index.js";
import { FakeCommandRunner, RealCommandRunner } from "../../src/exec/index.js";
import {
  baseRefCandidates,
  resolvePrMergeBase,
  resolveHead,
} from "../../src/ingest/source.js";
import { ingestReview } from "../../src/ingest/index.js";

const real = new RealCommandRunner();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await real.run("git", { args, cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Repo: main -> stacked-base -> feature, with SHAs returned. */
async function makeStackedRepo(): Promise<{
  dir: string;
  main: string;
  stackedBase: string;
  head: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-pr93-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.py"), "x = 1\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const main = await git(dir, "rev-parse", "HEAD");
  await git(dir, "checkout", "-b", "stacked-base");
  fs.writeFileSync(path.join(dir, "a.py"), "x = 1\ny = 2\n");
  await git(dir, "commit", "-am", "stacked base change");
  const stackedBase = await git(dir, "rev-parse", "HEAD");
  await git(dir, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(dir, "a.py"), "x = 1\ny = 2\nz = 3\n");
  await git(dir, "commit", "-am", "feature change");
  const head = await git(dir, "rev-parse", "HEAD");
  return { dir, main, stackedBase, head };
}

function ghPrView(opts: {
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}): { cmd: string; stdout: string; stderr: string; code: number } {
  return {
    cmd: "gh",
    stdout: JSON.stringify({
      title: "Test PR",
      body: "Body.",
      author: { login: "octocat" },
      state: "OPEN",
      isDraft: false,
      baseRefName: opts.baseRefName,
      headRefName: opts.headRefName,
      headRefOid: opts.headRefOid,
    }),
    stderr: "",
    code: 0,
  };
}

describe("baseRefCandidates", () => {
  it("tries origin/<base> first, bare second", () => {
    expect(baseRefCandidates("stacked-base")).toEqual(["origin/stacked-base", "stacked-base"]);
  });

  it("passes origin/… through unchanged", () => {
    expect(baseRefCandidates("origin/main")).toEqual(["origin/main"]);
  });
});

describe("resolvePrMergeBase (stubbed git)", () => {
  it("uses origin/<base> when present", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({ cmd: "git", args: ["merge-base", "origin/stacked", "abc123"], stdout: "mbsha\n", stderr: "", code: 0 });
    const out = await resolvePrMergeBase(fake, "/repo", "stacked", "abc123");
    expect(out).toEqual({ baseRef: "origin/stacked", mergeBaseSha: "mbsha" });
  });

  it("falls back to the bare name for remote-less fixtures", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({
      cmd: "git",
      args: ["merge-base", "origin/main", "abc123"],
      stdout: "",
      stderr: "fatal: unknown revision origin/main",
      code: 128,
    });
    fake.enqueue({ cmd: "git", args: ["merge-base", "main", "abc123"], stdout: "mb2\n", stderr: "", code: 0 });
    const out = await resolvePrMergeBase(fake, "/repo", "main", "abc123");
    expect(out).toEqual({ baseRef: "main", mergeBaseSha: "mb2" });
  });

  it("error names a missing base ref plus git stderr", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({
      cmd: "git",
      args: ["merge-base", "origin/gone", "abc123"],
      stdout: "",
      stderr: "fatal: unknown revision origin/gone",
      code: 128,
    });
    fake.enqueue({
      cmd: "git",
      args: ["merge-base", "gone", "abc123"],
      stdout: "",
      stderr: "fatal: unknown revision gone",
      code: 128,
    });
    fake.enqueue({ cmd: "git", args: ["rev-parse", "--verify", "origin/gone"], stdout: "", stderr: "bad", code: 128 });
    fake.enqueue({ cmd: "git", args: ["rev-parse", "--verify", "gone"], stdout: "", stderr: "bad", code: 128 });
    fake.enqueue({ cmd: "git", args: ["cat-file", "-e", "abc123"], stdout: "", stderr: "", code: 0 });
    await expect(resolvePrMergeBase(fake, "/repo", "gone", "abc123")).rejects.toThrow(
      /base branch "gone" wasn't found.*origin\/gone.*unknown revision/,
    );
  });

  it("error names a missing head commit plus git stderr", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({
      cmd: "git",
      args: ["merge-base", "origin/main", "deadsha"],
      stdout: "",
      stderr: "fatal: unknown revision deadsha",
      code: 128,
    });
    fake.enqueue({
      cmd: "git",
      args: ["merge-base", "main", "deadsha"],
      stdout: "",
      stderr: "fatal: unknown revision deadsha",
      code: 128,
    });
    fake.enqueue({ cmd: "git", args: ["rev-parse", "--verify", "origin/main"], stdout: "sha\n", stderr: "", code: 0 });
    fake.enqueue({ cmd: "git", args: ["cat-file", "-e", "deadsha"], stdout: "", stderr: "bad object", code: 128 });
    await expect(resolvePrMergeBase(fake, "/repo", "main", "deadsha")).rejects.toThrow(
      /PR's commit deadsha wasn't found.*unknown revision/,
    );
  });
});

describe("resolveHead (stubbed)", () => {
  it("fetches the head via refs/pull/<n>/head, falling back to the branch name", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({
      cmd: "gh",
      stdout: JSON.stringify({
        title: "T",
        body: "",
        author: { login: "a" },
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "fork-branch",
        headRefOid: "abc123",
      }),
      stderr: "",
      code: 0,
    });
    fake.enqueue({
      cmd: "git",
      args: ["-c", "credential.https://github.com.helper=!gh auth git-credential", "fetch", "origin", "refs/pull/7/head", "+refs/heads/main:refs/remotes/origin/main"],
      stdout: "",
      stderr: "",
      code: 0,
    });
    const out = await resolveHead(fake, "/repo", { pr: 7 });
    expect(out).toEqual({
      headSha: "abc123",
      baseRef: "main",
      prState: "OPEN",
      isDraft: false,
      reviewDecision: undefined,
      reviewRequests: [],
      latestReviews: [],
    });
    expect(fake.calls.map((c) => `${c.cmd} ${c.opts.args.join(" ")}`)).toContain(
      "git -c credential.https://github.com.helper=!gh auth git-credential fetch origin refs/pull/7/head +refs/heads/main:refs/remotes/origin/main",
    );
  });

  it("falls back to the branch-name fetch when the pull ref is missing", async () => {
    const fake = new FakeCommandRunner();
    fake.enqueue({
      cmd: "gh",
      stdout: JSON.stringify({
        title: "T",
        body: "",
        author: { login: "a" },
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: "abc123",
      }),
      stderr: "",
      code: 0,
    });
    fake.enqueue({
      cmd: "git",
      args: ["-c", "credential.https://github.com.helper=!gh auth git-credential", "fetch", "origin", "refs/pull/9/head", "+refs/heads/main:refs/remotes/origin/main"],
      stdout: "",
      stderr: "couldn't find remote ref",
      code: 128,
    });
    // The combined fetch is best-effort: on failure it still runs the
    // branch-name head fallback and the base as separate fetches.
    fake.enqueue({
      cmd: "git",
      args: ["-c", "credential.https://github.com.helper=!gh auth git-credential", "fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature"],
      stdout: "",
      stderr: "",
      code: 0,
    });
    fake.enqueue({
      cmd: "git",
      args: ["-c", "credential.https://github.com.helper=!gh auth git-credential", "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      stdout: "",
      stderr: "",
      code: 0,
    });
    const out = await resolveHead(fake, "/repo", { pr: 9 });
    expect(out.headSha).toBe("abc123");
    const cmds = fake.calls.map((c) => `${c.cmd} ${c.opts.args.join(" ")}`);
    expect(cmds).toContain(
      "git -c credential.https://github.com.helper=!gh auth git-credential fetch origin refs/pull/9/head +refs/heads/main:refs/remotes/origin/main",
    );
    expect(cmds).toContain(
      "git -c credential.https://github.com.helper=!gh auth git-credential fetch origin +refs/heads/feature:refs/remotes/origin/feature",
    );
    expect(cmds).toContain(
      "git -c credential.https://github.com.helper=!gh auth git-credential fetch origin +refs/heads/main:refs/remotes/origin/main",
    );
  });
});

describe("ingestReview PR paths (fake gh + real git)", () => {
  it("stacked PR: base is another feature branch, only origin/<base> exists", async () => {
    const { dir, stackedBase, head } = await makeStackedRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-pr93-data-"));
    // Managed-clone layout: no local `stacked-base`, only the remote-tracking ref.
    await git(dir, "checkout", "main");
    await git(dir, "branch", "-D", "stacked-base");
    await git(dir, "update-ref", "refs/remotes/origin/stacked-base", stackedBase);
    // Bare `stacked-base` must be gone for this to prove the fix.
    const bare = await real.run("git", { args: ["rev-parse", "--verify", "stacked-base"], cwd: dir });
    expect(bare.code).not.toBe(0);

    const fake = new FakeCommandRunner();
    fake.enqueue(ghPrView({ baseRefName: "stacked-base", headRefName: "feature", headRefOid: head }));
    const seenFetches: string[] = [];
    const runner: CommandRunner = {
      run: (cmd, opts) => {
        if (cmd === "gh") return fake.run(cmd, opts);
        if (cmd === "git" && opts.args.includes("fetch")) {
          seenFetches.push(opts.args.join(" "));
          // Offline / no real remote: swallow fetch failures like bestEffortFetch.
          return Promise.resolve({ stdout: "", stderr: "no remote", code: 0 });
        }
        return real.run(cmd, opts);
      },
    };

    const out = await ingestReview({ runner, dataDir }, { repoPath: dir, pr: 42 });
    expect(out.review.prNumber).toBe(42);
    expect(out.version.headSha).toBe(head);
    // The merge-base came from origin/stacked-base, not a missing local branch.
    expect(out.version.baseRef).toBe("origin/stacked-base");
    expect(out.version.mergeBaseSha).toBe(stackedBase);
    expect(out.files.length).toBeGreaterThan(0);
  });

  it("fork PR: head branch name unknown locally, pull-ref fetch attempted", async () => {
    const { dir, head } = await makeStackedRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-pr93-fork-"));
    // The fork branch was never fetched by name: only the SHA exists locally
    // (the commit is reachable from `feature`, but no `fork-branch` ref).
    const missing = await real.run("git", { args: ["rev-parse", "--verify", "fork-branch"], cwd: dir });
    expect(missing.code).not.toBe(0);

    const fake = new FakeCommandRunner();
    fake.enqueue(ghPrView({ baseRefName: "main", headRefName: "fork-branch", headRefOid: head }));
    const seenFetches: string[] = [];
    const runner: CommandRunner = {
      run: (cmd, opts) => {
        if (cmd === "gh") return fake.run(cmd, opts);
        if (cmd === "git" && opts.args.includes("fetch")) {
          seenFetches.push(opts.args.join(" "));
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        }
        return real.run(cmd, opts);
      },
    };

    const out = await ingestReview({ runner, dataDir }, { repoPath: dir, pr: 7 });
    expect(out.version.headSha).toBe(head);
    // #123: head and base travel in one fetch; the head still goes through
    // refs/pull/<n>/head (branch-name fallback only when that fails).
    // #139: every fetch carries the gh credential config ahead of the fetch.
    expect(seenFetches[0]).toBe(
      "-c credential.https://github.com.helper=!gh auth git-credential fetch origin refs/pull/7/head +refs/heads/main:refs/remotes/origin/main",
    );
  });

  it("default-branch PR still works", async () => {
    const { dir, head } = await makeStackedRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-pr93-main-"));
    const fake = new FakeCommandRunner();
    fake.enqueue(ghPrView({ baseRefName: "main", headRefName: "feature", headRefOid: head }));
    const runner: CommandRunner = {
      run: (cmd, opts) => (cmd === "gh" ? fake.run(cmd, opts) : real.run(cmd, opts)),
    };
    const out = await ingestReview({ runner, dataDir }, { repoPath: dir, pr: 1 });
    expect(out.version.headSha).toBe(head);
    expect(["origin/main", "main"]).toContain(out.version.baseRef);
    expect(out.files.length).toBeGreaterThan(0);
  });
});

describe("refreshReview PR paths (fake gh + real git)", () => {
  it("stacked PR refresh finds the new head through origin/<base>", async () => {
    const { createApp } = await import("../../src/server.js");
    const { dir, stackedBase, head } = await makeStackedRepo();
    // Managed-clone layout for the stacked base.
    await git(dir, "checkout", "main");
    await git(dir, "branch", "-D", "stacked-base");
    await git(dir, "update-ref", "refs/remotes/origin/stacked-base", stackedBase);
    await git(dir, "checkout", "feature");

    const fake = new FakeCommandRunner();
    // Ingest PR view.
    fake.enqueue(ghPrView({ baseRefName: "stacked-base", headRefName: "feature", headRefOid: head }));
    const runner: CommandRunner = {
      run: (cmd, opts) => {
        if (cmd === "gh") return fake.run(cmd, opts);
        if (cmd === "git" && opts.args.includes("fetch")) {
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        }
        return real.run(cmd, opts);
      },
    };
    const { app } = await createApp("tok", { runner, autoPipeline: false });
    const authed = { authorization: "Bearer tok" };
    try {
      process.env.UNVIBE_REPO_ROOTS = "";
      const added = await app.inject({ method: "POST", url: "/api/repos", headers: authed, payload: { path: dir } });
      const repoId = (added.json() as { repos: { id: string }[] }).repos.find((r) => r.id !== "demo")!.id;
      const created = await app.inject({
        method: "POST",
        url: "/api/reviews",
        headers: authed,
        payload: { repoId, pr: 42 },
      });
      expect([201, 202]).toContain(created.statusCode);
      const id = (created.json() as { review: { id: string } }).review.id;
      // #92: wait for the background ingest before refreshing.
      {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const got = await app.inject({ method: "GET", url: `/api/reviews/${id}`, headers: authed });
          if (got.statusCode === 200) {
            const snap = got.json() as { ingest?: { status?: string }; version?: { n?: number } };
            if ((snap.ingest?.status ?? "ready") === "ready" && (snap.version?.n ?? 0) >= 1) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // New commit on the PR head, then refresh (second gh pr view).
      fs.writeFileSync(path.join(dir, "a.py"), "x = 1\ny = 2\nz = 3\nw = 4\n");
      await git(dir, "commit", "-am", "more");
      const newHead = await git(dir, "rev-parse", "HEAD");
      fake.enqueue(ghPrView({ baseRefName: "stacked-base", headRefName: "feature", headRefOid: newHead }));

      const refreshed = await app.inject({ method: "POST", url: `/api/reviews/${id}/refresh`, headers: authed });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({ newVersion: true });
    } finally {
      await app.close();
    }
  });

  it("default-branch PR refresh still works", async () => {
    const { createApp } = await import("../../src/server.js");
    const { dir, head } = await makeStackedRepo();
    const fake = new FakeCommandRunner();
    fake.enqueue(ghPrView({ baseRefName: "main", headRefName: "feature", headRefOid: head }));
    const runner: CommandRunner = {
      run: (cmd, opts) => {
        if (cmd === "gh") return fake.run(cmd, opts);
        if (cmd === "git" && opts.args.includes("fetch")) {
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        }
        return real.run(cmd, opts);
      },
    };
    const { app } = await createApp("tok", { runner, autoPipeline: false });
    const authed = { authorization: "Bearer tok" };
    try {
      process.env.UNVIBE_REPO_ROOTS = "";
      const added = await app.inject({ method: "POST", url: "/api/repos", headers: authed, payload: { path: dir } });
      const repoId = (added.json() as { repos: { id: string }[] }).repos.find((r) => r.id !== "demo")!.id;
      const created = await app.inject({
        method: "POST",
        url: "/api/reviews",
        headers: authed,
        payload: { repoId, pr: 1 },
      });
      expect([201, 202]).toContain(created.statusCode);
      const id = (created.json() as { review: { id: string } }).review.id;
      {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const got = await app.inject({ method: "GET", url: `/api/reviews/${id}`, headers: authed });
          if (got.statusCode === 200) {
            const snap = got.json() as { ingest?: { status?: string }; version?: { n?: number } };
            if ((snap.ingest?.status ?? "ready") === "ready" && (snap.version?.n ?? 0) >= 1) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      await git(dir, "checkout", "feature");
      fs.writeFileSync(path.join(dir, "a.py"), "x = 1\ny = 2\nz = 3\nw = 5\n");
      await git(dir, "commit", "-am", "more");
      const newHead = await git(dir, "rev-parse", "HEAD");
      fake.enqueue(ghPrView({ baseRefName: "main", headRefName: "feature", headRefOid: newHead }));

      const refreshed = await app.inject({ method: "POST", url: `/api/reviews/${id}/refresh`, headers: authed });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({ newVersion: true });
    } finally {
      await app.close();
    }
  });
});
