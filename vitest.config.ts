import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Deterministic configuration for tests. External calls are mocked in test/helpers.ts.
          bindings: {
            TEST_MIGRATIONS: migrations,
            LLM_PROVIDER: 'openai',
            LLM_MODEL: 'gpt-4o-mini',
            OPENAI_API_KEY: 'test-openai-key',
            GOOGLE_MAPS_API_KEY: 'test-places-key',
            EMAIL_FROM: 'noreply@example.test',
            APP_PUBLIC_URL: 'https://app.example.test',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
