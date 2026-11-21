import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SITE_ORIGIN: "https://board.test",
            SESSION_SIGNING_KEY: "test-only-session-signing-key-0123456789abcdef",
            VERIFIER: "mock",
            ALLOW_MOCK_VERIFIER: "true",
            RATE_LIMIT_SUBMIT_HOURLY: "5",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
