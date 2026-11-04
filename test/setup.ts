import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      LLM_PROVIDER: string;
      LLM_MODEL: string;
      OPENAI_API_KEY: string;
      GOOGLE_MAPS_API_KEY: string;
      EMAIL_FROM: string;
      APP_PUBLIC_URL: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
