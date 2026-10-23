/**
 * Custom guides (packages/shared/src/customGuides.ts).
 *
 * - `POST /api/reviews/:id/guides` `{prompt}` — create a guide and start
 *   generating it (202; the guide streams in over the WS patch stream).
 * - `POST …/guides/:guideId/answer` `{answer}` — answer the agent's
 *   clarifying question and generate again.
 * - `POST …/guides/:guideId/regenerate` — run the request again against
 *   the current version (also the retry after a failure).
 * - `DELETE …/guides/:guideId` — remove the guide, its pages and its
 *   suggested comments not yet marked for the PR; cancels a running job.
 * - `POST …/guides/suggestions` — guide ideas for the New guide box,
 *   written once per version by a small-model job (200 when reused).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CUSTOM_GUIDE_PROMPT_MAX,
  customGuideFallbackTitle,
  customGuidePageId,
  isDocumentReview,
  type AnswerCustomGuideRequest,
  type CreateCustomGuideRequest,
  type CustomGuide,
  type CustomGuideResponse,
} from "@unvibe/shared";
import type { ServiceContext } from "./context.js";
import type { RouteDeps } from "./deps.js";
import { ingestRefusal } from "../reviews/index.js";
import { removeGuidePages } from "../pipeline/customGuide.js";
import { fetchGuideComments, type GuideComment } from "../pipeline/guideComments.js";

function readText(body: unknown, field: "prompt" | "answer"): string | { error: string } {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") return { error: `${field} is required` };
  if (value.length > CUSTOM_GUIDE_PROMPT_MAX) {
    return { error: `${field} must be at most ${CUSTOM_GUIDE_PROMPT_MAX} characters` };
  }
  return value.trim();
}

export async function registerGuides(app: FastifyInstance, ctx: ServiceContext, deps: RouteDeps = {}): Promise<void> {
  /** Start a run and answer with the guide as it now stands. */
  /**
   * The PR's discussion, read fresh (read-only GETs) so the guide sees
   * comments posted since the review opened. Best effort: undefined
   * falls back to the stored comments.
   */
  const freshComments = async (reviewId: string): Promise<GuideComment[] | undefined> => {
    const snapshot = ctx.reviews.getSnapshot(reviewId);
    const pr = snapshot?.review.prNumber;
    const repo = snapshot ? ctx.repos.get(snapshot.review.repoId) : undefined;
    // The bundled demo has no GitHub behind it, so no discussion (and no gh call).
    if (snapshot?.review.repoId === "demo") return [];
    if (pr === undefined || !repo || !repo.owner || !repo.name) return undefined;
    try {
      return await fetchGuideComments(ctx.runner, repo.localPath, repo.owner, repo.name, pr);
    } catch {
      return undefined;
    }
  };

  const start = async (reply: FastifyReply, reviewId: string, guideId: string): Promise<unknown> => {
    if (!deps.pipeline) return reply.code(503).send({ error: "the agent pipeline is not running" });
    try {
      const githubComments = await freshComments(reviewId);
      const job = await deps.pipeline.runCustomGuide(reviewId, guideId, githubComments ? { githubComments } : {});
      const guide = ctx.reviews.getSnapshot(reviewId)?.guides?.find((g) => g.id === guideId);
      if (!guide) return reply.code(404).send({ error: "unknown custom guide" });
      const body: CustomGuideResponse = { guide, jobId: job.id };
      return reply.code(202).send(body);
    } catch (err) {
      // The guide already shows the failure (status "failed").
      return reply.code(502).send({ error: (err as Error).message });
    }
  };

  const guard = (reply: FastifyReply, reviewId: string): string | null => {
    const snapshot = ctx.reviews.getSnapshot(reviewId);
    if (!snapshot) {
      void reply.code(404).send({ error: "unknown review" });
      return null;
    }
    const refused = ingestRefusal(snapshot);
    if (refused) {
      void reply.code(409).send({ error: refused });
      return null;
    }
    if (isDocumentReview(snapshot)) {
      void reply.code(409).send({ error: "custom guides are for code reviews" });
      return null;
    }
    return reviewId;
  };

  app.post("/api/reviews/:id/guides", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const prompt = readText(req.body as CreateCustomGuideRequest, "prompt");
    if (typeof prompt !== "string") return reply.code(400).send(prompt);
    const guideId = `gd-${randomBytes(4).toString("hex")}`;
    const now = Date.now();
    await ctx.reviews.mutate(id, (draft) => {
      const guide: CustomGuide = {
        id: guideId,
        title: customGuideFallbackTitle(prompt),
        prompt,
        turns: [{ who: "you", text: prompt, at: now }],
        status: "working",
        pageId: customGuidePageId(guideId),
        commits: [],
        hunks: [],
        plotlines: [],
        assignment: {},
        version: draft.version.n,
        createdAt: now,
      };
      draft.guides = [...(draft.guides ?? []), guide];
    });
    return start(reply, id, guideId);
  });

  app.post("/api/reviews/:id/guides/suggestions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    if (!deps.pipeline) return reply.code(503).send({ error: "the agent pipeline is not running" });
    const job = await deps.pipeline.suggestCustomGuides(id);
    const suggestions = ctx.reviews.getSnapshot(id)?.guideSuggestions ?? null;
    return reply.code(job ? 202 : 200).send({ suggestions, ...(job ? { jobId: job.id } : {}) });
  });

  app.post("/api/reviews/:id/guides/:guideId/answer", async (req, reply) => {
    const { id, guideId } = req.params as { id: string; guideId: string };
    if (!guard(reply, id)) return reply;
    const answer = readText(req.body as AnswerCustomGuideRequest, "answer");
    if (typeof answer !== "string") return reply.code(400).send(answer);
    const guide = ctx.reviews.getSnapshot(id)?.guides?.find((g) => g.id === guideId);
    if (!guide) return reply.code(404).send({ error: "unknown custom guide" });
    if (guide.status !== "needs-input") return reply.code(409).send({ error: "the guide is not waiting for an answer" });
    await ctx.reviews.mutate(id, (draft) => {
      const g = draft.guides?.find((x) => x.id === guideId);
      if (!g) return;
      g.turns.push({ who: "you", text: answer, at: Date.now() });
      g.status = "working";
      delete g.question;
    });
    return start(reply, id, guideId);
  });

  app.post("/api/reviews/:id/guides/:guideId/regenerate", async (req, reply) => {
    const { id, guideId } = req.params as { id: string; guideId: string };
    if (!guard(reply, id)) return reply;
    const guide = ctx.reviews.getSnapshot(id)?.guides?.find((g) => g.id === guideId);
    if (!guide) return reply.code(404).send({ error: "unknown custom guide" });
    if (guide.status === "working" && guide.jobId) {
      return reply.code(409).send({ error: "the guide is already being generated" });
    }
    await ctx.reviews.mutate(id, (draft) => {
      const g = draft.guides?.find((x) => x.id === guideId);
      if (!g) return;
      // Same request turns, current version.
      g.status = "working";
      delete g.error;
    });
    return start(reply, id, guideId);
  });

  app.delete("/api/reviews/:id/guides/:guideId", async (req, reply) => {
    const { id, guideId } = req.params as { id: string; guideId: string };
    const snapshot = ctx.reviews.getSnapshot(id);
    if (!snapshot) return reply.code(404).send({ error: "unknown review" });
    const guide = snapshot.guides?.find((g) => g.id === guideId);
    if (!guide) return reply.code(404).send({ error: "unknown custom guide" });
    if (guide.jobId && deps.jobs) {
      try {
        deps.jobs.cancel(guide.jobId);
      } catch {
        // Already settled.
      }
    }
    await ctx.reviews.mutate(id, (draft) => {
      draft.guides = (draft.guides ?? []).filter((g) => g.id !== guideId);
      if (draft.guides.length === 0) delete draft.guides;
      removeGuidePages(draft, guideId);
      draft.annotations = draft.annotations.filter(
        (a) => a.guideId !== guideId || a.post || a.postedAt !== undefined,
      );
      if (draft.diffFilter?.guideId === guideId) {
        delete draft.diffFilter.guideId;
        delete draft.diffFilter.plotline;
        if (Object.keys(draft.diffFilter).length === 0) delete draft.diffFilter;
      }
    });
    return reply.code(204).send();
  });
}
