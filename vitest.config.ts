import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
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
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
