/**
 * Settings + jobs/settings route tests (PRD §4.14, §14.1).
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import { JobQueue } from "../src/jobs/queue.js";
import { createApp } from "../src/server.js";
import { DEFAULT_SETTINGS, SettingsStore, StaticModelCatalog, type ModelCatalog, type OfferedModels, type OfferedThinking } from "../src/settings/index.js";
import type { ModelInfo } from "@unvibe/shared";

function makeStore(): SettingsStore {
  const db = openDatabase(":memory:");
  migrate(db);
  return new SettingsStore(db);
}

describe("SettingsStore", () => {
  it("returns defaults when nothing is stored", () => {
    expect(makeStore().get()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists partial updates", () => {
    const store = makeStore();
    const res = store.update({ sessionsPerProvider: 8, idleExitMinutes: 0 });
    expect(res.errors).toBeUndefined();
    expect(res.settings?.sessionsPerProvider).toBe(8);
    expect(res.settings?.idleExitMinutes).toBe(0);
    expect(res.settings?.main).toEqual(DEFAULT_SETTINGS.main);
  });

  it("persists the UI theme and rejects unknown themes (issue #196)", () => {
    const store = makeStore();
    expect(store.get().uiTheme).toBe("default");
    const res = store.update({ uiTheme: "studio" });
    expect(res.errors).toBeUndefined();
    expect(res.settings?.uiTheme).toBe("studio");
    expect(store.get().uiTheme).toBe("studio");
    expect(store.update({ uiTheme: "nope" as never }).errors).toMatchObject([
      expect.stringContaining("uiTheme"),
    ]);
    expect(store.get().uiTheme).toBe("studio");
  });

  it("persists the light/dark mode and rejects unknown modes", () => {
    const store = makeStore();
    expect(store.get().colorMode).toBe("system");
    expect(store.update({ colorMode: "light" }).errors).toBeUndefined();
    expect(store.get().colorMode).toBe("light");
    expect(store.update({ colorMode: "sepia" as never }).errors).toMatchObject([
      expect.stringContaining("colorMode"),
    ]);
    expect(store.get().colorMode).toBe("light");
  });

  it("rejects invalid updates", () => {
    const store = makeStore();
    expect(store.update({ sessionsPerProvider: 0 }).errors).toMatchObject([
      expect.stringContaining("sessionsPerProvider"),
    ]);
    expect(store.update({ sessionsPerProvider: 33 }).errors).toHaveLength(1);
    expect(store.update({ rebuildSupersededRatio: 2 }).errors).toHaveLength(1);
    expect(store.update({ main: { provider: "", model: "", effort: "" } }).errors).toHaveLength(1);
    expect(store.update({ nope: 1 } as never).errors).toMatchObject([
      expect.stringContaining("unknown setting"),
    ]);
    // Nothing persisted on failure.
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("StaticModelCatalog", () => {
  it("lists static defaults per provider", () => {
    const catalog = new StaticModelCatalog();
    expect(catalog.listModels("claude").length).toBeGreaterThan(0);
    expect(catalog.listModels("codex").map((m) => m.id)).toContain("gpt-6.1-sol");
    expect(catalog.listModels("unknown")).toEqual([]);
  });

  it("reports no live thinking offering", async () => {
    // StaticModelCatalog.thinking takes no provider (it always answers null).
    expect(await new StaticModelCatalog().thinking()).toBeNull();
  });
});

describe("effort settings (issue #172)", () => {
  /** Catalog with a live model + thinking offering for validation tests.
   * Implements ModelCatalog directly: StaticModelCatalog's offered/thinking
   * are typed Promise<null>, so a subclass cannot widen them. */
  class ThinkingCatalog implements ModelCatalog {
    private readonly base = new StaticModelCatalog();
    listModels(provider: string): ModelInfo[] {
      return this.base.listModels(provider);
    }
    providers(): string[] {
      return this.base.providers();
    }
    offered(provider: string): Promise<OfferedModels> {
      void provider;
      return Promise.resolve({ models: [{ id: "m1" }], defaultId: "m1" });
    }
    thinking(provider: string): Promise<OfferedThinking> {
      void provider;
      return Promise.resolve({ label: "Effort", options: [{ value: "low" }, { value: "high" }], current: "high" });
    }
  }

  function makeApp() {
    const db = openDatabase(":memory:");
    migrate(db);
    return createApp("tok", {
      settings: new SettingsStore(db),
      models: new ThinkingCatalog(),
      jobs: new JobQueue(),
      autoPipeline: false,
    });
  }

  const auth = { authorization: "Bearer tok" };

  it("GET /api/thinking lists the adapter's effort values", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/thinking?provider=claude", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        provider: "claude",
        label: "Effort",
        options: [{ value: "low" }, { value: "high" }],
        current: "high",
      });
      const missing = await app.inject({ method: "GET", url: "/api/thinking", headers: auth });
      expect(missing.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("GET /api/thinking offers Default only with no live adapter", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const { app } = await createApp("tok", {
      settings: new SettingsStore(db),
      models: new StaticModelCatalog(),
      jobs: new JobQueue(),
      autoPipeline: false,
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/thinking?provider=claude", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ provider: "claude", options: [] });
    } finally {
      await app.close();
    }
  });

  it("PUT /api/settings accepts an offered effort and rejects an unoffered one", async () => {
    const { app } = await makeApp();
    try {
      const ok = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: auth,
        payload: { main: { provider: "claude", model: "m1", effort: "low" } },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().main).toEqual({ provider: "claude", model: "m1", effort: "low" });

      const def = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: auth,
        payload: { main: { provider: "claude", model: "m1", effort: "" } },
      });
      expect(def.statusCode).toBe(200);

      const bad = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: auth,
        payload: { small: { provider: "claude", model: "m1", effort: "ultra" } },
      });
      expect(bad.statusCode).toBe(400);
      expect(JSON.stringify(bad.json().errors)).toContain("ultra");
    } finally {
      await app.close();
    }
  });
});

describe("settings + jobs routes", () => {
  it("GET/PUT /api/settings and GET /api/models", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT OR IGNORE INTO repos (id, owner, name, local_path) VALUES ('r', 'o', 'n', '/t')").run();
    db.prepare("INSERT OR IGNORE INTO reviews (id, repo_id, branch, created_at) VALUES ('r1', 'r', 'b', 0)").run();
    const { app } = await createApp("tok", {settings: new SettingsStore(db),
      models: new StaticModelCatalog(),
      jobs: new JobQueue(), autoPipeline: false});
    const auth = { authorization: "Bearer tok" };
    try {
      const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
      expect(get.statusCode).toBe(200);
      expect(get.json().sessionsPerProvider).toBe(16);
      expect(get.json().cacheLifetimeMs).toBe(DEFAULT_SETTINGS.cacheLifetimeMs);

      const put = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: auth,
        payload: { sessionsPerProvider: 2 },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().sessionsPerProvider).toBe(2);

      const bad = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: auth,
        payload: { sessionsPerProvider: 99 },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().errors).toHaveLength(1);

      const models = await app.inject({ method: "GET", url: "/api/models?provider=codex", headers: auth });
      expect(models.statusCode).toBe(200);
      expect(models.json().provider).toBe("codex");
      expect(models.json().models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(["gpt-6.1-sol"]));

      const missing = await app.inject({ method: "GET", url: "/api/models", headers: auth });
      expect(missing.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("GET /api/jobs?review=, one job, prompt snapshot, cancel, reprioritise", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT OR IGNORE INTO repos (id, owner, name, local_path) VALUES ('r', 'o', 'n', '/t')").run();
    db.prepare("INSERT OR IGNORE INTO reviews (id, repo_id, branch, created_at) VALUES ('r1', 'r', 'b', 0)").run();
    const { JobStore } = await import("../src/jobs/store.js");
    const store = new JobStore(db);
    const queue = new JobQueue({ getConcurrencyCap: () => 0, persist: store });
    const { app } = await createApp("tok", {jobs: queue, autoPipeline: false});
    const auth = { authorization: "Bearer tok" };
    try {
      const job = queue.enqueue({
        reviewId: "r1",
        kind: "ask",
        provider: "claude",
        model: "m",
        effort: "",
        priority: 10,
        promptSnapshot: "THE PROMPT",
        run: async () => {},
      });

      const list = await app.inject({ method: "GET", url: "/api/jobs?review=r1", headers: auth });
      expect(list.statusCode).toBe(200);
      expect(list.json().jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);

      const one = await app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: auth });
      expect(one.statusCode).toBe(200);
      expect(one.json().job.promptSnapshot).toBe("THE PROMPT");

      // #207: the old per-job prompt endpoint is gone; the prompt lives
      // in the turn records served by GET /api/jobs/:id/output.
      const prompt = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/prompt`, headers: auth });
      expect(prompt.statusCode).toBe(404);

      const missing = await app.inject({ method: "GET", url: "/api/jobs/nope", headers: auth });
      expect(missing.statusCode).toBe(404);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/jobs/${job.id}`,
        headers: auth,
        payload: { priority: 100 },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().job.priority).toBe(100);

      const cancelled = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/cancel`, headers: auth });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().job.state).toBe("cancelled");

      const noReview = await app.inject({ method: "GET", url: "/api/jobs", headers: auth });
      expect(noReview.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
