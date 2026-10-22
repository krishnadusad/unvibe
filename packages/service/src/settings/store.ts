/**
 * Settings storage (PRD §4.14): `GET/PUT /api/settings` persisted in SQLite.
 *
 * The table is created lazily by this module (`CREATE TABLE IF NOT EXISTS`)
 * so parallel review-state work in `store/migrate.ts` never conflicts.
 * Every field has a default; `get()` always returns a complete `Settings`.
 */
import { COLOR_MODE_IDS, isColorModeId, isUiThemeId, UI_THEME_IDS } from "@unvibe/shared";
import type { ModelPick, Settings } from "@unvibe/shared";
import type { DatabaseSync } from "../store/db.js";

export const DEFAULT_SETTINGS: Settings = {
  uiTheme: "default",
  colorMode: "system",
  // Static fallback only (issue #88): live defaults from
  // `resolveEffectiveSettings` win whenever adapter listings are known.
  // These ids must exist on a fresh install with both providers logged in
  // so the fallback never warns "not offered"; they surface only when no
  // listing is known (offline, adapter down) or no allowed family is
  // offered, where readiness reports them plainly.
  // Effort is "" (Default) for every role: the adapter's own thinking
  // level stands unless the owner picks one (issue #172).
  main: { provider: "claude", model: "claude-opus-5-5", effort: "" },
  small: { provider: "claude", model: "claude-haiku-5-5", effort: "" },
  secondOpinion: { provider: "codex", model: "gpt-6.1-sol", effort: "" },
  sessionsPerProvider: 16,
  inlineBudgetTokens: 40_000,
  rebuildSupersededRatio: 0.2,
  rebuildAppendedTokens: 10_000,
  logBatchTokens: 2_000,
  cacheLifetimeMs: 5 * 60 * 1000,
  idleExitMinutes: 10,
  /**
   * Version picker (issue #36, step 2; toggle meaning #231): releases
   * are always listed and switchable, and the update check always runs
   * (listing shells out through `gh` under the user's own login, like
   * every other `gh` use — PRD §16). Off by default; only preview
   * channels stay hidden until it is on.
   */
  versionPickerEnabled: false,
  /**
   * Issue #160: full access for agent sessions. Off by default; enabling
   * requires the warning acknowledgement in the same update (enforced in
   * `validateSettings`, so the API refuses without it, not only the web).
   */
  fullAccess: false,
  fullAccessAcknowledgedAt: null,
  /** Issue #217: go-deeper cards write themselves after the guide. On by default. */
  autoGoDeeper: true,
};

function isModelPick(v: unknown): v is ModelPick {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["provider"] === "string" && typeof o["model"] === "string" && typeof o["effort"] === "string"
  );
}

/** Validate a partial update; returns error messages (empty = valid). */
export function validateSettings(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const role of ["main", "small", "secondOpinion"] as const) {
    const v = patch[role];
    if (v === undefined) continue;
    // An empty second-opinion model is the unset marker (no Codex yet);
    // main/small must always name a model.
    const allowEmptyModel = role === "secondOpinion";
    if (!isModelPick(v) || !v.provider || (!allowEmptyModel && !v.model)) {
      errors.push(
        role === "secondOpinion"
          ? `${role} must be { provider, model } (model may be empty when unset)`
          : `${role} must be { provider, model } with non-empty strings`,
      );
    }
  }
  const int = (name: string, min: number, max: number): void => {
    const v = patch[name];
    if (v === undefined) return;
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
      errors.push(`${name} must be an integer in [${min}, ${max}]`);
    }
  };
  int("sessionsPerProvider", 1, 32);
  int("inlineBudgetTokens", 1, 10_000_000);
  int("rebuildAppendedTokens", 1, 10_000_000);
  int("logBatchTokens", 1, 10_000_000);
  int("cacheLifetimeMs", 1000, 24 * 60 * 60 * 1000);
  int("idleExitMinutes", 0, 24 * 60);
  const ratio = patch["rebuildSupersededRatio"];
  if (ratio !== undefined && (typeof ratio !== "number" || ratio <= 0 || ratio > 1)) {
    errors.push("rebuildSupersededRatio must be a number in (0, 1]");
  }
  const uiTheme = patch["uiTheme"];
  if (uiTheme !== undefined && !isUiThemeId(uiTheme)) {
    errors.push(`uiTheme must be one of: ${UI_THEME_IDS.join(", ")}`);
  }
  const colorMode = patch["colorMode"];
  if (colorMode !== undefined && !isColorModeId(colorMode)) {
    errors.push(`colorMode must be one of: ${COLOR_MODE_IDS.join(", ")}`);
  }
  const picker = patch["versionPickerEnabled"];
  if (picker !== undefined && typeof picker !== "boolean") {
    errors.push("versionPickerEnabled must be a boolean");
  }
  // Issue #160: full access is opt-in with a stored acknowledgement. The
  // service refuses to enable without it (not only the web): enabling
  // requires the acknowledgement timestamp in the SAME update, and turning
  // the setting off clears the stored acknowledgement (see `update`).
  const autoGoDeeper = patch["autoGoDeeper"];
  if (autoGoDeeper !== undefined && typeof autoGoDeeper !== "boolean") {
    errors.push("autoGoDeeper must be a boolean");
  }
  const fullAccess = patch["fullAccess"];
  if (fullAccess !== undefined && typeof fullAccess !== "boolean") {
    errors.push("fullAccess must be a boolean");
  }
  const ack = patch["fullAccessAcknowledgedAt"];
  if (ack !== undefined && ack !== null && (!Number.isInteger(ack) || (ack as number) < 0)) {
    errors.push("fullAccessAcknowledgedAt must be null or a non-negative integer epoch ms");
  }
  if (fullAccess === true && (ack === undefined || ack === null)) {
    errors.push("fullAccess needs the warning acknowledgement: send fullAccessAcknowledgedAt with the update");
  }
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_SETTINGS)) errors.push(`unknown setting: ${key}`);
  }
  return errors;
}

export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  /** Full settings: stored values merged over defaults. */
  get(): Settings {    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const out: Settings = structuredClone(DEFAULT_SETTINGS);
    for (const row of rows) {
      if (!(row.key in out)) continue;
      (out as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  /** Keys the user (or a test) explicitly saved. Never-saved roles take live defaults. */
  savedKeys(): string[] {
    try {
      const rows = this.db.prepare("SELECT key FROM settings").all() as { key: string }[];
      return rows.map((r) => r.key);
    } catch {
      return [];
    }
  }

  /** Merge a partial update over current settings and persist it. */
  update(patch: Partial<Settings>): { settings?: Settings; errors?: string[] } {
    const errors = validateSettings(patch as Record<string, unknown>);
    if (errors.length > 0) return { errors };
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    // Issue #160: turning full access off clears the acknowledgement, so
    // turning it on again asks again.
    const effective: Record<string, unknown> = { ...patch };
    if (patch.fullAccess === false) effective["fullAccessAcknowledgedAt"] = null;
    for (const [key, value] of Object.entries(effective)) {
      if (value !== undefined) stmt.run(key, JSON.stringify(value));
    }
    return { settings: this.get() };
  }
}
