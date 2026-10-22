import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { suiteOptions } from "../../vitest.shared.js";

/**
 * Emit `dist/web-meta.json` (issue #14): the esbuild-metafile-shaped module
 * list the release notices are generated from (`{ inputs: { <id>: {} } }`
 * for every bundled `node_modules/` module, same shape as the service
 * `dist/meta.json` files). Rollup has no built-in metafile, so this plugin
 * collects module ids at `generateBundle` time instead of a hand-kept list:
 * React, the state library, the `@fontsource/*` packages, etc. are whatever
 * the build actually compiled in.
 */
function webMetaPlugin(): Plugin {
  return {
    name: "unvibe-web-meta",
    generateBundle() {
      const inputs: Record<string, object> = {};
      for (const id of this.getModuleIds()) {
        if (!id.includes("node_modules/")) continue;
        inputs[id] = {};
      }
      this.emitFile({ type: "asset", fileName: "web-meta.json", source: JSON.stringify({ inputs }, null, 2) });
    },
  };
}

// Dev: the service runs on 127.0.0.1:$UNVIBE_PORT (default 4517); proxy API + WS
// there. Following UNVIBE_PORT lets dev run beside whatever else holds 4517.
const servicePort = process.env.UNVIBE_PORT ?? "4517";

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), webMetaPlugin()],
  define: {
    // Dev-only Sentry (issue #29): the DSN reaches the app only in the Vite
    // dev server. Builds and tests get "", which drops the SDK entirely.
    __SENTRY_DSN__: JSON.stringify(
      command === "serve" && mode !== "test" ? (process.env.SENTRY_DSN_REACT ?? "") : "",
    ),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${servicePort}`,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    setupFiles: ["./vitest.setup.ts"],
    // Fast/slow split (issue #119): UNVIBE_TEST_SUITE=fast skips
    // *.slow.test.*, =slow runs only those; worker caps in vitest.shared.ts.
    ...suiteOptions(["src/**/*.test.{ts,tsx}"]),
  },
}));
