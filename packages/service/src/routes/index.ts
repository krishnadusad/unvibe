import type { FastifyInstance } from "fastify";
import { registerMcp } from "../mcp/index.js";
import type { ServiceContext } from "./context.js";
import { registerComments } from "./comments.js";
import { registerContributions } from "./contributions.js";
import { registerDescription } from "./description.js";
import type { RouteDeps } from "./deps.js";
import { registerEvents } from "./events.js";
import { registerFileSlices } from "./files.js";
import { registerGuides } from "./guides.js";
import { registerHunks } from "./hunks.js";
import { registerOutline } from "./outline.js";
import { registerJobs } from "./jobs.js";
import { registerPrompts, toPromptSnapshot } from "./prompts.js";
import { registerReadiness } from "./readiness.js";
import { registerRepos } from "./repos.js";
import { registerDiagrams } from "./diagrams.js";
import { registerReviews, type ReviewsRouteDeps } from "./reviews.js";
import { registerSettings } from "./settings.js";
import { registerSharedContext } from "./shared-context.js";
import { registerOutbox } from "./outbox.js";
import { registerSubmit } from "./submit.js";
import { registerViewer } from "./viewer.js";
import { registerDiagnostics } from "./diagnostics.js";
import { registerUpdate } from "./update.js";
import { registerView } from "./view.js";

/**
 * One route module per area; each registers its PRD §14.1 endpoints.
 * M3 unification: `ctx` is the full `AppContext` (core stores + M3
 * singletons); `deps` carries the same plus per-test overrides (jobs,
 * baseRunner, ...). Route modules read pipeline/jobs/settings from the
 * merged view.
 */
export async function registerRoutes(
  app: FastifyInstance,
  ctx: ServiceContext,
  deps: RouteDeps & ReviewsRouteDeps = {},
): Promise<void> {
  const full = { ...ctx, ...deps } as ServiceContext & RouteDeps & ReviewsRouteDeps & {
    pipeline?: import("../pipeline/index.js").Pipeline;
    dataDir?: string;
    fixturesDir?: string;
  };
  await registerRepos(app, ctx, deps);
  await registerReadiness(app, ctx, deps);
  await registerReviews(app, ctx, deps);
  await registerDiagrams(app, ctx, deps);
  await registerHunks(app, full as unknown as ServiceContext, full as unknown as RouteDeps);
  await registerGuides(app, full as unknown as ServiceContext, full as unknown as RouteDeps);
  await registerFileSlices(app, ctx);
  await registerOutline(app, ctx);
  await registerComments(app, ctx);
  await registerContributions(app, full as unknown as ServiceContext);
  await registerSharedContext(app, full as unknown as ServiceContext);
  await registerDescription(app, ctx);
  await registerSubmit(app, ctx);
  await registerOutbox(app, ctx);
  await registerViewer(app, ctx);
  await registerSettings(app, deps);
  await registerDiagnostics(app, ctx, deps);
  await registerUpdate(app, ctx, deps);
  await registerView(app, ctx);
  await registerPrompts(app, {
    snapshots: {
      getSnapshot: async (reviewId: string) => {
        const snap = ctx.reviews.getSnapshot(reviewId);
        return snap ? toPromptSnapshot(snap) : null;
      },
    },
    ...(full.settings ? { settings: full.settings } : {}),
  });
  await registerJobs(app, deps);
  await registerEvents(app, ctx.bus);
  if (deps.mcp) await registerMcp(app, deps.mcp);
}

export type { RouteDeps, UpdateHooks } from "./deps.js";
export type { ReviewsRouteDeps, RegisterReviewsDeps } from "./reviews.js";
