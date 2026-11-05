# AI Travel Planner

Describe the trip you want in plain language and get a day-by-day itinerary you can reshape by talking to it. Guests can start without an account. A separate admin console covers user management, trip inspection, API usage and cost reporting.

Build and verification results are in [BUILD_REPORT.md](BUILD_REPORT.md) and [BUILD_RESULTS.json](BUILD_RESULTS.json). The running log is in [PROGRESS.md](PROGRESS.md).

## Architecture

| Layer | Choice |
|---|---|
| Hosting | One Cloudflare Worker, with static assets served through Workers Assets |
| API | [Hono](https://hono.dev) on Workers, validated with Zod |
| Data | Cloudflare D1 (one database, used for all state, including rate limits) |
| Client | React 19, React Router, Vite, Tailwind CSS 4 |
| Map | Leaflet with OpenStreetMap tiles |
| AI | OpenAI Chat Completions through a provider adapter; model and provider come from runtime configuration |
| Places | Google Places API (New), Text Search and Place Photos, server-side only |
| Email | Cloudflare Email Service through the `EMAIL` Worker binding |
| Tests | Vitest in workerd with real D1, mocked external APIs; Playwright for browser journeys |

```
src/shared/         Domain schemas and itinerary checks, used by both sides
src/worker/
  index.ts          Entry point: security headers, CSRF checks, routing, scheduled cleanup
  routes/           auth + account, trips + explore, admin
  auth/sessions.ts  User, guest and admin identity
  trips/planner.ts  One conversational turn from message to saved result
  itinerary/ops.ts  Deterministic edit operations
  llm/              Provider contract, OpenAI adapter, schemas, prompts
  places/google.ts  Search, caching, photos
  usage/            Pricing and usage records
  admin/            Reporting periods and metrics
src/client/         React app; admin/ is a separately loaded chunk
migrations/         D1 schema
test/               Vitest suites
e2e/                Playwright journeys
```

### How a planning request works

1. The Worker authorizes the owner, checks spending limits and takes a per-trip lock.
2. The model returns structured output: an intent, a reply, changed trip details, and any edit operations or research queries. The reply streams to the browser as it arrives.
3. For a new plan, the model writes an outline, then each day is generated in parallel and streamed as it finishes.
4. For an edit, the server applies the operations itself. Only the activities named change, so the rest of the itinerary cannot be altered by a model that rewrites more than it should. The conversation shows what actually changed, taken from the server's result rather than the model's claims.
5. New stops are looked up in Google Places. A confident match becomes a verified place; anything else stays labeled as an AI suggestion.

### Verified information and estimates

Only Google Places data is shown as verified: name, address, coordinates, rating, hours and links. A match is rejected if it is implausibly far from where the stop should be. Places that Google lists as permanently closed are flagged. All costs are labeled as estimates. The model is told never to state hours or prices as fact, and opening hours can only ever come from Google.

## Local setup

```sh
npm install
cp .dev.vars.example .dev.vars        # Fill in local API keys
npm run db:migrate:local
npm run dev:worker                    # http://127.0.0.1:8787, serves the built client
```

`dev:worker` builds the client first. For client hot reload, run `npm run dev` alongside it (Vite on port 5173, proxying `/api`). Locally, Cloudflare's send-email binding only simulates sending.

## Environment

**Runtime, managed by the administrator and never changed by this project:**

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | Must be `openai` today. Anything else is an error. |
| `LLM_MODEL` | Model identifier. There is no default and no fallback. |
| `OPENAI_API_KEY` | Secret |
| `GOOGLE_MAPS_API_KEY` | Secret, server-side. Without it, planning still works and stops stay labeled as AI suggestions. |
| `EMAIL_FROM` | Authorized sender address |

`wrangler.jsonc` sets `keep_vars: true` and does not declare the variables above, so deployments cannot change them.

**Runtime, set by this project:** `APP_PUBLIC_URL`, a non-secret value in `wrangler.jsonc`, used for links in email and the CSRF origin check.

**Development only, in the git-ignored `cloudflare.env`:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_WORKER_NAME`, `EXPERIMENT_RESOURCE_PREFIX`, `APP_PUBLIC_HOSTNAME`, `APP_PUBLIC_URL`. `scripts/with-cf-env.sh` loads them for a single command.

## Authentication

**Passwords** use scrypt (N=2^15, r=8, p=1) with a per-password salt. The parameters are stored with each hash so they can be raised later. Application passwords are 10-128 characters; administrator passwords at least 12.

**Sessions** are random 256-bit tokens in `HttpOnly`, `Secure`, `__Host-` cookies. Only a SHA-256 hash is stored, so a database leak does not expose usable sessions. Nothing goes in browser storage.

| Identity | Cookie | SameSite | Lifetime |
|---|---|---|---|
| User | `__Host-tp_session` | Lax | 30 days idle, 90 days absolute |
| Guest | `__Host-tp_guest` | Lax | 180 days |
| Administrator | `__Host-tp_admin` | Strict | 1 hour idle, 12 hours absolute |

**Guests** get an identifier only when they first create something. Trip reads include the owner in the query, so another owner's trip looks exactly like one that does not exist.

**Registration** returns the same response whether or not the address is already registered. An existing owner gets a notice by email instead. Logging in requires a verified address, and that fact is revealed only after the correct password.

**Guest migration** runs at login. It moves only trips owned by the guest cookie on that request, updating rows in place, so it cannot claim other people's trips or create duplicates.

**Password reset** links last 30 minutes and work once. A reset ends all sessions. Reset and verification tokens are stored only as hashes. The token is submitted by POST after the page loads, so mail scanners that follow links cannot use it up.

**Other protections:** Origin and Sec-Fetch-Site checks on every state-changing request; JSON-only bodies; 64 KB body limit; parameterized SQL with allowlisted sort columns; a strict CSP, HSTS and an HTTP-to-HTTPS redirect; rate limits on every authentication route.

### Email delivery honesty

If the binding is missing, the relevant requests return 503 before any account lookup, without detail. Registration reports delivery failure, because its response is identical for new and existing addresses either way. Forgot Password and Resend say "if an account exists" and send in the background, so timing cannot reveal whether an account exists; a failure there is recorded in the admin error log.

## Administrator bootstrap

Migration `0001` creates the account `admin` with the initial password `admin`, stored only as a scrypt hash.

1. Go to `/admin` and log in.
2. You must set a new password of at least 12 characters. Until then, every administrative API returns `403 PASSWORD_CHANGE_REQUIRED`, and no administrative data is available.
3. Create other administrators as needed. They also must change their temporary password at first login.

The bootstrap account is created once, by the migration, and nothing at runtime recreates it. The last active administrator cannot be disabled or deleted, and that check is part of the SQL write so simultaneous requests cannot get around it. Administrators cannot disable or delete themselves.

> **Do this immediately after any fresh deployment.** Until step 2 is done, anyone who knows the documented default could complete it first. `node scripts/activate-admin.mjs <url>` does it and writes a random password to the git-ignored `.admin-credentials`.

## User deletion

Deleting a user requires typing their email. It permanently removes the account, sessions, tokens, trips, conversations and itinerary history through foreign-key cascades.

Usage records are kept, because they are the record of money spent. They have no foreign keys and hold only opaque IDs plus a trip label, never an email, so historical totals stay correct. Trip labels are the trip's own title or destination, which is traveler-entered text; treat that as residual data if your retention rules require it. Audit records also remain.

Deleting one trip works the same way: its usage stays, reported as "Trips since deleted".

## Monitoring and cost accounting

Every external call attempt is one row in `usage_records`, including failures and retries: timestamp, provider, model or endpoint, SKU, operation, user, guest, trip, status, tokens or billable units, cost, pricing version, duration and error. Credentials are scrubbed from stored error text.

**LLM cost** uses provider-reported tokens. Cached input is charged at its own rate, and reasoning tokens are treated as part of output, which is how OpenAI reports them. A call whose output failed validation still records its tokens, because it is billed.

**Places cost** is per request by SKU, with separate rates for each. Cache hits cost nothing and create no row. Failed requests record zero billable units.

**Prices** live in `pricing_rates` and can be changed under Settings. A change adds a new row; existing usage keeps its stored `pricing_snapshot` and is never recalculated. Seed values are list prices checked on 2026-11-05. A model with no rate records its tokens with an **unknown** cost rather than zero, and the dashboard shows how many such requests exist.

| SKU | Assumption |
|---|---|
| `gpt-4o-mini` | $0.15 input, $0.075 cached, $0.60 output per 1M tokens |
| `places.text_search_enterprise` | $35 per 1,000 requests |
| `places.photo` | $7 per 1,000 requests |

**These are estimates.** They are not reconciled with invoices, and Google's monthly free usage and volume discounts are not applied, so Places estimates can run above real bills.

**Per-trip costs do not sum to the total**, because some activity has no saved trip, such as destination ideas and Explore searches. The Overview accounts for the difference: existing trips, deleted trips and outside any trip.

**Reporting periods** use UTC throughout. Custom ranges cover whole UTC days, including the end date. The period lives in the URL and applies to all metrics, charts and usage reports. Lifetime figures are shown separately.

### Cost protection

| Limit | Default |
|---|---|
| AI requests, burst | 10 per minute, per owner |
| AI requests, daily | 40 per guest, 150 per user |
| AI requests, per address | 30 per hour for guests, 120 per hour overall |
| Places requests, daily | 120 per guest, 500 per user |
| Place verification | At most 40 lookups per AI request, cached for 30 days |
| Message length | 2,000 characters |
| Trip length | 14 days |
| Global daily cost cap | $25 estimated over a rolling 24 hours, then AI requests pause |

One AI request runs at a time per trip. Output tokens and request times are bounded on every call. Daily limits and the cap can be changed under Settings, and changes are audited.

## Database migrations

```sh
npm run db:migrate:local
scripts/with-cf-env.sh npx wrangler d1 migrations apply DB --remote
```

Migrations are not run by the deploy pipeline. Apply them before pushing code that needs them.

## Testing

```sh
npm test                 # Vitest in workerd with real D1; external APIs mocked
npm run typecheck
npm run e2e              # Playwright. Set E2E_BASE_URL to target a deployment.
```

`npm run e2e` makes real, billable LLM and Places calls. The account journey reads real email through a public disposable inbox, so it runs only against a deployment.

## Deployment

Pushing to `main` triggers Cloudflare Workers Builds, which installs dependencies and runs `npx wrangler deploy`. Wrangler runs the `build.command` from `wrangler.jsonc`. To verify a deployment:

```sh
scripts/with-cf-env.sh node scripts/wait-build.mjs <commit-sha>
```

`/api/health` reports the deployed commit, taken from `WORKERS_CI_COMMIT_SHA` at build time.

## Known limitations

See section 10 of [BUILD_REPORT.md](BUILD_REPORT.md) for the current list. The main ones:

- Places data appears on an OpenStreetMap-based map, because the only Google key is a server-side secret. Google's terms restrict showing its content on non-Google maps, so this should be reviewed before commercial use.
- OpenStreetMap's public tile servers are not meant for heavy traffic. Use a commercial tile provider if usage grows.
- Email addresses cannot be changed after registration.
- A browser disconnect during generation gives the Worker only a short grace period to finish. Days already completed in a first build are kept.
- Rate limits are fixed-window counters in D1, so a burst around a window boundary can briefly reach twice a limit.
