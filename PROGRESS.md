# Progress log

Timestamps are UTC, observed during the build session. Reports are generated from this log.

## 2026-11-05

- **22:28** Session start. Repository held only the spec and env files. An earlier implementation had been reverted in commit f7333a5, so this is a clean build; the old code in git history was not read or restored.
- **22:30** Inspected Cloudflare. The existing Worker already has `EMAIL`, `EMAIL_FROM`, `LLM_PROVIDER`, `LLM_MODEL`, `APP_PUBLIC_URL`, two secrets and a custom domain. Its `DB` binding pointed at a database that no longer exists. Workers Builds: `main`, deploy command `npx wrangler deploy`, empty build command.
- **22:32** Created D1 database `bh-travel-v1-claude-claude-db` (79aa89be-91d5-493f-b115-43bfce80c764). Other `bh-travel-*` databases belong to other runs and were not touched.

### Decisions

- Hono on Workers, D1 for all state, React + Vite client served through Workers Assets. `run_worker_first` so security headers apply to everything.
- `keep_vars: true` and no LLM values in `wrangler.jsonc`, so a deploy cannot alter administrator-managed configuration.
- scrypt (N=2^15) through `node:crypto`, available natively in workerd. Confirmed by tests running in workerd.
- AI edits are a list of operations applied deterministically by the server, so unrelated itinerary content cannot change. Tested by comparing days for exact equality.
- Generation is outline first, then days in parallel (four at a time), streamed as each finishes.
- Login requires a verified email. Registration gives the same response for new and existing addresses, so it cannot be used to discover accounts.
- Leaflet + OpenStreetMap for the map, because the Google key is a server-side secret and must not reach the browser.

### Test results

- **17:54 local / 22:54 UTC** First full backend run: 209 tests, 4 failed. One was a real bug: D1 `meta.changes` includes cascaded rows, so deleting an admin with a session wrongly returned "last administrator". Fixed; 209 of 209 passed.
- **23:09** Real OpenAI and Places through `wrangler dev`: strict schemas accepted, 2-day plan in 22 s, targeted edit left day 1 byte-identical. Reading the real output exposed issues mocks could not: a closed venue marked verified, an invented start date, a duplicate replacement, back-to-back stops, a stub research reply. All fixed, with tests. 223 of 223 passed.
