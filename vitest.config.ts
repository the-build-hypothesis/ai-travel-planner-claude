import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/worker/index.ts",
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            LLM_PROVIDER: "openai",
            LLM_MODEL: "gpt-4o-mini",
            OPENAI_API_KEY: "test-openai-key",
            GOOGLE_MAPS_API_KEY: "test-google-key",
            EMAIL_FROM: "noreply@example.com",
            APP_PUBLIC_URL: "https://travel.example.com",
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
