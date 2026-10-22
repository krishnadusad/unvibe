/**
 * Stacked PRs in a single-branch clone: the clone's fetch refspec covers
 * only `main`, and the PR's base is another feature branch. A bare
 * `git fetch origin <base>` writes only FETCH_HEAD there, so `origin/<base>`
 * never existed and ingest failed with "the base branch … wasn't found".
 * The base fetch now names its destination (`branchRefspec`), at ingest and
 * on refresh.
 *
 * Real `git` against a local bare origin (fast, no network); `gh` is faked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../src/exec/index.js";
import { RealCommandRunner } from "../../src/exec/index.js";
import { ingestReview } from "../../src/ingest/index.js";
import { branchRefspec, resolveHead } from "../../src/ingest/source.js";

const real = new RealCommandRunner();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await real.run("git", { args, cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** main -> stacked-base -> feature on a bare origin (with the pull ref); a `--single-branch` clone of main. */
async function makeSingleBranchClone(): Promise<{
  seed: string;
  work: string;
  stackedBase: string;
  head: string;
}> {
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-stack-seed-"));
  await git(seed, "init", "-b", "main");
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "a.py"), "x = 1\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "base");
  await git(seed, "checkout", "-b", "stacked-base");
  fs.writeFileSync(path.join(seed, "a.py"), "x = 1\ny = 2\n");
  await git(seed, "commit", "-am", "stacked base change");
  const stackedBase = await git(seed, "rev-parse", "HEAD");
  await git(seed, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(seed, "a.py"), "x = 1\ny = 2\nz = 3\n");
  await git(seed, "commit", "-am", "feature change");
  const head = await git(seed, "rev-parse", "HEAD");

  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-stack-origin-"));
  await git(origin, "init", "--bare", "-q");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "-q", "origin", "main", "stacked-base", "feature", "feature:refs/pull/42/head");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-stack-work-"));
  const work = path.join(parent, "work");
  await git(parent, "clone", "-q", "--single-branch", "-b", "main", origin, work);
  return { seed, work, stackedBase, head };
}

function ghRunner(head: () => string): CommandRunner {
  return {
    run: (cmd, opts) => {
      if (cmd !== "gh") return real.run(cmd, opts);
      return Promise.resolve({
        stdout: JSON.stringify({
          title: "Stacked",
          body: "",
          author: { login: "octocat" },
          state: "OPEN",
          isDraft: false,
          baseRefName: "stacked-base",
          headRefName: "feature",
          headRefOid: head(),
        }),
        stderr: "",
        code: 0,
      });
    },
  };
}

describe("branchRefspec", () => {
  it("maps a branch to its remote-tracking ref", () => {
    expect(branchRefspec("stacked-base")).toBe("+refs/heads/stacked-base:refs/remotes/origin/stacked-base");
  });

  it("strips an origin/ prefix", () => {
    expect(branchRefspec("origin/main")).toBe("+refs/heads/main:refs/remotes/origin/main");
  });
});

describe("stacked PR in a single-branch clone", () => {
  it("ingest fetches the base into origin/<base> and diffs against it", async () => {
    const { work, stackedBase, head } = await makeSingleBranchClone();
    // The fixture reproduces the failure: no origin/stacked-base before ingest.
    const before = await real.run("git", { args: ["rev-parse", "--verify", "origin/stacked-base"], cwd: work });
    expect(before.code).not.toBe(0);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-stack-data-"));
    const out = await ingestReview({ runner: ghRunner(() => head), dataDir }, { repoPath: work, pr: 42 });
    expect(out.version.headSha).toBe(head);
    expect(out.version.baseRef).toBe("origin/stacked-base");
    expect(out.version.mergeBaseSha).toBe(stackedBase);
    // Only the feature commit, not the base's change.
    expect(out.files.map((f) => f.path)).toEqual(["a.py"]);
  });

  it("refresh brings a moved stacked base up to date", async () => {
    const { seed, work, head } = await makeSingleBranchClone();
    // The base moves on the remote after the review was opened.
    await git(seed, "checkout", "stacked-base");
    fs.writeFileSync(path.join(seed, "b.py"), "w = 4\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "base moved");
    const movedBase = await git(seed, "rev-parse", "HEAD");
    await git(seed, "push", "-q", "origin", "stacked-base");

    const got = await resolveHead(ghRunner(() => head), work, { pr: 42 });
    expect(got).toEqual({ headSha: head, baseRef: "stacked-base" });
    expect(await git(work, "rev-parse", "origin/stacked-base")).toBe(movedBase);
  });
});
