/**
 * Custom guides over HTTP on the demo review with scripted fakes (no real
 * agents, no network): a prompted guide lands as its own page, scope,
 * plotlines and suggested comments without touching the main guide; an
 * ambiguous request asks first and generates after the answer; delete
 * removes the guide but keeps comments the reader marked for the PR.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, CustomGuide, ReviewSnapshot } from "@unvibe/shared";
import { customGuidePageId } from "@unvibe/shared";
import { FakeAgentRunner } from "../src/agent/fake.js";
import { guideRevisionForSnapshot } from "../src/routes/prompts.js";
import { createApp } from "../src/server.js";

const authed = { authorization: "Bearer tok" };

type App = { inject: (o: never) => Promise<{ statusCode: number; json: () => unknown }> };

function textEvents(text: string): AgentEvent[] {
  return [
    { type: "text", delta: text },
    { type: "usage", inputTokens: 10, cachedReadTokens: 5, cachedWriteTokens: 0, outputTokens: 10 },
    { type: "done", stopReason: "end_turn" },
  ];
}

const MINIMAL_READER = `## The problem

The problem paragraph.

## The central change

The central paragraph.

\`\`\`json
{"cardIds": ["problem", "central"], "plotlines": []}
\`\`\`
`;

async function inject(app: App, method: string, url: string, payload?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method, url, headers: authed, ...(payload !== undefined ? { payload } : {}) } as never);
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // 204
  }
  return { status: res.statusCode, json };
}

async function waitFor(check: () => boolean, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** First two demo hunks as `h:` ids, plus one added new-side line of the first. */
function demoTargets(snap: ReviewSnapshot): { h1: string; h2: string; diffLine: string } {
  const hunks = snap.files.flatMap((f) => f.hunks.map((h) => ({ f, h })));
  const [a, b] = hunks;
  const added = a.h.lines.find((l) => l.kind === "add" && l.newLine !== undefined);
  return {
    h1: `h:${a.f.fileKey}:${a.h.contentHash}`,
    h2: `h:${b.f.fileKey}:${b.h.contentHash}`,
    diffLine: `diff:${a.f.fileKey}:${added?.newLine ?? a.h.newStart}`,
  };
}

function guideReply(t: { h1: string; h2: string; diffLine: string }): string {
  return `## What to focus on

The focused answer.

## Input handling

How input is parsed.

\`\`\`json
{"title": "Focused review",
 "scopeNote": "Two hunks that parse input.",
 "scope": {"commits": [], "hunks": ["${t.h1}"]},
 "plotlines": [{"id": "parsing", "name": "Parsing", "description": "Parses input.", "hunks": ["${t.h2}"]}],
 "comments": [{"diff": "${t.diffLine}", "text": "Consider validating this."}]}
\`\`\`
`;
}

async function openDemo(agents: FakeAgentRunner): Promise<{ app: App & { close: () => Promise<void> }; ctx: Awaited<ReturnType<typeof createApp>>["ctx"]; id: string }> {
  const { app, ctx } = await createApp("tok", { agents });
  const created = await inject(app as unknown as App, "POST", "/api/reviews", { repoId: "demo" });
  expect(created.status).toBe(201);
  const id = (created.json as ReviewSnapshot).review.id;
  await waitFor(() => !!ctx.reviews.getSnapshot(id)?.pages.find((p) => p.id === "root")?.cards.length);
  return { app: app as unknown as App & { close: () => Promise<void> }, ctx, id };
}

function guideOf(snap: ReviewSnapshot | null, guideId: string): CustomGuide | undefined {
  return snap?.guides?.find((g) => g.id === guideId);
}

describe("custom guides", () => {
  beforeEach(() => {
    process.env.UNVIBE_REPO_ROOTS = "";
  });

  it("generates a scoped guide without touching the main guide", { timeout: 90000 }, async () => {
    const agents = new FakeAgentRunner([
      { match: "reply with exactly", events: textEvents("ready") },
      { match: "# Reader task", events: textEvents(MINIMAL_READER) },
    ]);
    const { app, ctx, id } = await openDemo(agents);
    try {
      const before = ctx.reviews.getSnapshot(id)!;
      const targets = demoTargets(before);
      agents.addScript({ match: "# Custom guide", events: textEvents(guideReply(targets)) });
      const mainRevision = guideRevisionForSnapshot(before);
      const mainPlotlines = JSON.stringify(before.plotlines ?? []);
      const mainHunkPlotlines = JSON.stringify(before.hunkStates.map((s) => s.plotline ?? null));

      const res = await inject(app, "POST", `/api/reviews/${id}/guides`, { prompt: "Security review of input parsing" });
      expect(res.status).toBe(202);
      const guideId = (res.json as { guide: CustomGuide }).guide.id;
      await waitFor(() => guideOf(ctx.reviews.getSnapshot(id), guideId)?.status === "ready");

      const snap = ctx.reviews.getSnapshot(id)!;
      const guide = guideOf(snap, guideId)!;
      expect(guide.title).toBe("Focused review");
      expect(guide.scopeNote).toBe("Two hunks that parse input.");
      // Scope = explicit hunks + every plotline's hunks, in diff order.
      expect(guide.hunks).toEqual([targets.h1, targets.h2]);
      expect(guide.plotlines.map((p) => p.id)).toEqual(["parsing"]);
      expect(guide.assignment).toEqual({ [targets.h2]: "parsing" });
      const page = snap.pages.find((p) => p.id === customGuidePageId(guideId))!;
      expect(page).toMatchObject({ kind: "guide", guideId });
      expect(page.cards.map((c) => c.title)).toEqual(["What to focus on", "Input handling"]);
      const suggested = snap.annotations.filter((a) => a.guideId === guideId);
      expect(suggested).toHaveLength(1);
      expect(suggested[0]).toMatchObject({ type: "comment", post: false });

      // The main guide is untouched: same base key, plotlines, assignment.
      expect(guideRevisionForSnapshot(snap)).toBe(mainRevision);
      expect(JSON.stringify(snap.plotlines ?? [])).toBe(mainPlotlines);
      expect(JSON.stringify(snap.hunkStates.map((s) => s.plotline ?? null))).toBe(mainHunkPlotlines);

      // The diff filter scopes to the guide and takes its plotline ids.
      expect((await inject(app, "PATCH", `/api/reviews/${id}/diff-filter`, { guideId, plotline: "parsing" })).status).toBe(200);
      expect(ctx.reviews.getSnapshot(id)!.diffFilter).toMatchObject({ guideId, plotline: "parsing" });
      // Back to the main guide clears the guide's plotline pick.
      expect((await inject(app, "PATCH", `/api/reviews/${id}/diff-filter`, { guideId: null })).status).toBe(200);
      expect(ctx.reviews.getSnapshot(id)!.diffFilter).toBeUndefined();
      expect((await inject(app, "PATCH", `/api/reviews/${id}/diff-filter`, { guideId: "gd-nope" })).status).toBe(400);

      // The agent saw commit dates and the reader's clock.
      const sent = agents.prompts.find((p) => p.text.includes("# Custom guide"))!.text;
      expect(sent).toContain("Security review of input parsing");
      expect(sent).toContain("## Reader's clock");
      // The PR discussion section is there; the demo has no GitHub behind
      // it, so it reads as empty (and no gh call is made).
      expect(sent).toContain("## The PR's discussion on GitHub");
      expect(sent).toContain("(nobody has commented on the PR yet)");
    } finally {
      await app.close();
    }
  });

  it("asks a clarifying question, then generates after the answer", { timeout: 90000 }, async () => {
    const agents = new FakeAgentRunner([
      { match: "reply with exactly", events: textEvents("ready") },
      { match: "# Reader task", events: textEvents(MINIMAL_READER) },
    ]);
    const { app, ctx, id } = await openDemo(agents);
    try {
      const targets = demoTargets(ctx.reviews.getSnapshot(id)!);
      // The answered run carries the reader's reply; the first run does not.
      agents.addScript({ match: "Reader: the last two", events: textEvents(guideReply(targets)) });
      agents.addScript({
        match: "# Custom guide",
        events: textEvents('```json\n{"clarify": "Today has no commits. Did you mean the last two from yesterday?"}\n```\n'),
      });

      const res = await inject(app, "POST", `/api/reviews/${id}/guides`, { prompt: "What changed in today's commits?" });
      expect(res.status).toBe(202);
      const guideId = (res.json as { guide: CustomGuide }).guide.id;
      await waitFor(() => guideOf(ctx.reviews.getSnapshot(id), guideId)?.status === "needs-input");
      const waiting = guideOf(ctx.reviews.getSnapshot(id), guideId)!;
      expect(waiting.question).toMatch(/last two from yesterday/);
      expect(waiting.turns.map((t) => t.who)).toEqual(["you", "agent"]);

      // Answering only works while a question is open.
      expect((await inject(app, "POST", `/api/reviews/${id}/guides/${guideId}/answer`, { answer: " " })).status).toBe(400);
      const answered = await inject(app, "POST", `/api/reviews/${id}/guides/${guideId}/answer`, { answer: "the last two" });
      expect(answered.status).toBe(202);
      await waitFor(() => guideOf(ctx.reviews.getSnapshot(id), guideId)?.status === "ready");
      const ready = guideOf(ctx.reviews.getSnapshot(id), guideId)!;
      expect(ready.question).toBeUndefined();
      expect(ready.turns.map((t) => t.who)).toEqual(["you", "agent", "you"]);
      expect((await inject(app, "POST", `/api/reviews/${id}/guides/${guideId}/answer`, { answer: "again" })).status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("delete removes the guide but keeps comments marked for the PR", { timeout: 90000 }, async () => {
    const agents = new FakeAgentRunner([
      { match: "reply with exactly", events: textEvents("ready") },
      { match: "# Reader task", events: textEvents(MINIMAL_READER) },
    ]);
    const { app, ctx, id } = await openDemo(agents);
    try {
      const targets = demoTargets(ctx.reviews.getSnapshot(id)!);
      agents.addScript({ match: "# Custom guide", events: textEvents(guideReply(targets)) });
      const res = await inject(app, "POST", `/api/reviews/${id}/guides`, { prompt: "Security review" });
      const guideId = (res.json as { guide: CustomGuide }).guide.id;
      await waitFor(() => guideOf(ctx.reviews.getSnapshot(id), guideId)?.status === "ready");
      const comment = ctx.reviews.getSnapshot(id)!.annotations.find((a) => a.guideId === guideId)!;
      // Mark it for the PR the way the UI does (post: true).
      await ctx.reviews.mutate(id, (draft) => {
        const a = draft.annotations.find((x) => x.id === comment.id);
        if (a) a.post = true;
      });
      expect((await inject(app, "PATCH", `/api/reviews/${id}/diff-filter`, { guideId })).status).toBe(200);

      expect((await inject(app, "DELETE", `/api/reviews/${id}/guides/${guideId}`)).status).toBe(204);
      const snap = ctx.reviews.getSnapshot(id)!;
      expect(snap.guides ?? []).toEqual([]);
      expect(snap.pages.some((p) => p.guideId === guideId)).toBe(false);
      expect(snap.annotations.find((a) => a.id === comment.id)?.post).toBe(true);
      expect(snap.diffFilter?.guideId).toBeUndefined();
      expect((await inject(app, "DELETE", `/api/reviews/${id}/guides/${guideId}`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("writes guide ideas once per version and reuses them", { timeout: 90000 }, async () => {
    const agents = new FakeAgentRunner([
      { match: "reply with exactly", events: textEvents("ready") },
      { match: "# Reader task", events: textEvents(MINIMAL_READER) },
      {
        match: "# Custom guide ideas",
        events: textEvents(
          '```json\n{"suggestions": [{"label": "Header unfolding", "prompt": "Explain how folded headers are unfolded."}, {"label": "", "prompt": "dropped"}]}\n```\n',
        ),
      },
    ]);
    const { app, ctx, id } = await openDemo(agents);
    try {
      const first = await inject(app, "POST", `/api/reviews/${id}/guides/suggestions`);
      expect(first.status).toBe(202);
      await waitFor(() => ctx.reviews.getSnapshot(id)?.guideSuggestions?.status === "ready");
      expect(ctx.reviews.getSnapshot(id)!.guideSuggestions!.items).toEqual([
        { label: "Header unfolding", prompt: "Explain how folded headers are unfolded." },
      ]);
      const again = await inject(app, "POST", `/api/reviews/${id}/guides/suggestions`);
      expect(again.status).toBe(200);
      expect(agents.prompts.filter((p) => p.text.includes("# Custom guide ideas"))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
