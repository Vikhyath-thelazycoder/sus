import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          // Worker code and shared pure code, inside the real Workers runtime.
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              remoteBindings: false, // tests never touch Cloudflare's servers
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  ANON_ID_SECRET: "test-secret-current-0123456789abcdef",
                  ANON_ID_SECRET_PREV: "test-secret-previous-0123456789abcd",
                  ADMIN_INGEST_TOKEN: "test-admin-token-0123456789abcdef",
                  LLM_API_KEY: "test-llm-key",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/*.test.ts", "test/shared/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
          },
        },
        {
          // React components in a simulated DOM (T-5.3–T-5.6).
          test: { name: "web", include: ["test/web/**/*.test.{ts,tsx}"], environment: "happy-dom" },
        },
        {
          // pdf.js on real PDFs (Node build), as the ingest script runs it.
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
        },
      ],
    },
  };
});
