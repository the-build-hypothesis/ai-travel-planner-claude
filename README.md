# AI Travel Planner

Conversational AI travel planning: describe a trip, get a structured day-by-day itinerary with a map, verified places and cost estimates, then refine it by chatting or with direct edits. Works for guests and registered users, and has a separate admin console with usage and cost reporting.

Production: the URL in `APP_PUBLIC_URL` (currently https://ai-travel-planner-v1-claude.thebuildhypothesis.com).

## Architecture

```
Browser (React SPA) ──fetch /api/*──▶ Cloudflare Worker (Hono)
                                      ├─ D1 (users, sessions, guests, trips, messages,
                                      │      usage_events, pricing_rules, audit_log,
                                      │      rate_limits, places_cache, admins …)
                                      ├─ Email Service binding (EMAIL)
                                      ├─ OpenAI Chat Completions (structured outputs)
                                      └─ Google Places API (New) Text Search
Static assets (dist/client) are served by the same Worker (Workers Static Assets, SPA fallback).
```

| Layer | Choice |
|---|---|
| Runtime | One Cloudflare Worker (`CLOUDFLARE_WORKER_NAME`) with `run_worker_first: true`: it enforces HTTPS (301 + HSTS), handles `/api/*`, and serves the SPA through the `ASSETS` binding |
| API | Hono, Zod validation, TypeScript |
| Data | Cloudflare D1 (SQLite), SQL migrations in `migrations/` |
| Frontend | React 19, React Router, Tailwind CSS v4, Vite, Leaflet (CARTO/OSM tiles), lucide icons |
| LLM | Provider abstraction (`src/worker/llm`), OpenAI adapter, strict JSON-schema output |
| Places | Google Places API (New) `places:searchText`, server-side only, cached in D1 |
| Email | Cloudflare Email Service via `send_email` binding |
| Tests | Vitest + `@cloudflare/vitest-plugin` (tests run inside workerd with a real local D1) |

Key source locations:

- `src/worker/index.ts`: middleware (CSRF, sessions, security headers, errors), health
- `src/worker/routes/`: `auth.ts` (register/login/verify/reset/account), `trips.ts` (trips, chat, edits, places), `admin/*` (admin auth, accounts, reporting)
- `src/worker/services/planner.ts`: prompt and patch-merge logic (keeps unrelated days unchanged)
- `src/worker/llm/`: `types.ts` (provider interface), `openai.ts`, `index.ts` (config, retries, validation, usage)
- `src/worker/services/usage.ts`: pricing and usage records; `places.ts`: Google Places; `email.ts`: templates and sending
- `src/shared/schemas.ts`: provider-independent itinerary and preference schemas
- `src/client/`: SPA (`pages/`, `components/trip/`, `admin/`)

### How planning works

1. The user message, the current trip state (preferences + compact itinerary) and the last 10 messages are sent to the configured model with a strict JSON schema.
2. The model returns `{reply, intent, preferenceUpdates, itinerary: {mode: replace_all|patch, days[], removeDayNumbers[]}, suggestions}`.
3. The server validates it with Zod (one bounded retry if it is malformed). For `patch`, only the returned days are replaced and every other day is kept exactly as it was. Activities that keep their id and location keep their verified place data. The `changedDays` reported to the UI are found by diffing, so a day the model echoed back unchanged isn't counted. If a modification changed nothing, the reply says so.
4. **New plans are generated in two phases.** First the chat turn returns a day-by-day *outline* (title, area, summary, cost). Then each outlined day is filled with detailed activities in parallel per-day calls (`trip_plan_day`, up to 5 at a time). A 5-day plan takes about 20–26 s in production, down from about 60 s in one call. If a budget currency is known, the outline is switched to it before filling, so all costs can be compared with the budget. Missing days (the outline is shorter than the trip) are requested in up to 3 bounded follow-up calls. Days that still fail are left as outlines, and the reply explains this.
5. New or changed activities that have a `locationName` are looked up with Google Places (bounded, concurrent, cached). A match is only accepted if it is within 60 km of the AI's estimated location. Matches are marked **Verified**; everything else is labelled an AI estimate in the UI.

Users can also edit directly (reorder, move between days, edit, add, remove, add from place search). Those edits go through `PUT /api/trips/:id/itinerary` with optimistic concurrency (`baseVersion`). The server re-validates the itinerary and never accepts client-supplied "verified" place data that it didn't fetch itself.

## Local setup

```bash
npm install                       # npm ≥11 needs workerd/esbuild install scripts; they are allow-listed in package.json
cp .dev.vars.example .dev.vars    # fill in OPENAI_API_KEY, GOOGLE_MAPS_API_KEY, LLM_PROVIDER, LLM_MODEL, EMAIL_FROM
npm run db:migrate:local          # apply D1 migrations to the local database
npx wrangler dev                  # builds the SPA (wrangler build.command) and serves app + API on :8787
# or for frontend hot reload: `npm run dev` (Vite on :5173, proxies /api to :8787)
```

Locally, `wrangler dev` simulates the email binding and logs messages instead of delivering them. Session cookies use the `__Host-` prefix (Secure), which browsers accept on `http://localhost`.

### Scripts

| Command | Purpose |
|---|---|
| `npm test` | Vitest suite (runs in workerd with local D1; all external APIs mocked) |
| `npm run typecheck` | TypeScript for client and worker |
| `npm run build` | Generate `src/worker/build-info.ts` + Vite production build |
| `npm run db:migrate:remote` | Apply migrations to the production D1 database |

## Environment variables

Development and infrastructure (`cloudflare.env`, never committed): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_WORKER_NAME`, `EXPERIMENT_RESOURCE_PREFIX`, `APP_PUBLIC_HOSTNAME`, `APP_PUBLIC_URL`.

Worker runtime (managed by the administrator on the Worker, **not** in this repo):

| Variable | Type | Use |
|---|---|---|
| `LLM_PROVIDER` | var | Selects the LLM adapter (`openai`). There is no default; if it is missing or unsupported, requests fail with `LLM_NOT_CONFIGURED`. |
| `LLM_MODEL` | var | Model id sent to the provider. It is never substituted. |
| `OPENAI_API_KEY` | secret | OpenAI credential |
| `GOOGLE_MAPS_API_KEY` | secret | Places API (New). Optional; without it, verification and place search are turned off and the UI says so. |
| `EMAIL_FROM` | var | Sender address for transactional email |
| `APP_PUBLIC_URL` | var | Canonical URL used in email links (falls back to the request origin) |

`wrangler.jsonc` sets `"keep_vars": true` and defines no `vars`, so deployments never overwrite these values. Secrets are always preserved by Wrangler.

## Authentication design

**Application users**

- The email address is the login id, compared case-insensitively (`email_normalized UNIQUE`). The stable internal id is a UUID.
- Passwords are hashed with PBKDF2-HMAC-SHA256, 100,000 iterations (the Workers runtime maximum) and a 128-bit random salt. They are never logged.
- Sessions use a random 256-bit token in a `__Host-tp_session` cookie (HttpOnly, Secure, SameSite=Lax). The database stores only its SHA-256. Sessions last 30 days at most and expire after 14 days idle. Logout deletes the server row.
- Registration is enumeration-safe. The response is identical whether or not the email is already registered. A new account gets a verification email; an existing owner gets an "account already exists" notice. Registration does not sign the user in.
- Email verification: a 256-bit token (hash stored), 24 h expiry, single use, and only the newest token is valid. Resending is limited to 3 per hour. Unverified users can sign in and see a banner prompting verification.
- Password reset: a single-use token that expires in 30 minutes. Using it deletes **all** sessions and other reset tokens, and also marks the email as verified. The forgot-password response doesn't reveal whether the account exists, and the email is sent in `waitUntil` so response timing doesn't either.
- Changing the password requires the current one and signs out all other sessions.
- Rate limits (D1 fixed windows): login 30 per 15 min per IP; 8 failed logins per 15 min per account, then the account is locked out for the rest of the window; registration 10/h per IP; forgot-password 5 per 15 min per IP and 3/h per email; token submissions 30 per 15 min per IP.
- CSRF protection: every state-changing request must carry `X-Requested-With: fetch`, which a cross-site form can't set without a CORS preflight, and none is ever granted. A present `Origin` must match, and `Sec-Fetch-Site` must be same-origin. Cookies are SameSite.

**Guests**

- A guest gets a random 256-bit token in an `__Host-tp_guest` HttpOnly cookie (180 days). Only its hash is stored, and every guest trip query is scoped to that guest id.
- **Migration:** when a guest signs in, trips belonging to *the guest presented by this browser's cookie* are moved (`UPDATE`, not copied) to the account. Their usage records are re-attributed to the user, the guest is marked claimed and the cookie is cleared. Another guest's trips can't be claimed because the server needs that guest's secret cookie. Signing in again never duplicates trips.

**Authorization:** every trip query includes the owner (`user_id = ?` or `guest_id = ?`). Someone else's trip returns 404, the same as a trip that doesn't exist.

## Administrator bootstrap

- Admins live in separate tables (`admins`, `admin_sessions`), use a separate cookie (`__Host-tp_admin`, SameSite=Strict, 8 h absolute and 30 min idle) and separate routes (`/api/admin/*`, UI at `/admin`). A user session never grants admin access, and an admin session never acts as a user.
- Migration `0001` creates **one** bootstrap admin: username `admin`, password `admin`. Only its PBKDF2 hash is stored, with `must_change_password = 1`. Application code never recreates it, so deleting it is permanent.
- **First login procedure:** go to `/admin` and sign in as `admin` / `admin`. You are sent to a mandatory password-change screen. Until the password is changed, every admin API returns `403 PASSWORD_CHANGE_REQUIRED` and shows no data. The new password needs at least 12 characters, can't be "admin" and can't contain the username. After the change, all sessions for that admin are rotated.
- Admins created by another admin, or whose password was reset by another admin, must also change it at their next sign-in.
- You can't disable or delete your own account. An atomic SQL guard prevents disabling or deleting the last active admin.
- Admin login: 10 attempts per 15 min per IP and 5 failures per 15 min per username. Every attempt is audited.
- The UI never shows the default credentials.

> In this deployment, the bootstrap password was changed during production verification. The new password is stored locally (gitignored) in `.admin-credentials` on the build machine. Hand it over out of band.

## Cloudflare Email Service

- Binding: `"send_email": [{ "name": "EMAIL" }]` in `wrangler.jsonc`. The sender is read from `EMAIL_FROM`. The domain's email configuration was not modified.
- Templates (HTML + text) are in `src/worker/services/email.ts`: verification, account-already-exists notice, and password reset. Links are built from `APP_PUBLIC_URL`.
- Failures: if the binding or `EMAIL_FROM` is missing, the API returns `503 EMAIL_NOT_CONFIGURED` with no details. If the service rejects or fails a send (`e.code`), the failure is recorded in `app_errors` (shown in the admin Monitoring page) and the user is told the email could not be sent. The app never claims success after a failed send.

## Database migrations

- `migrations/0001_initial.sql`: the full schema, seeded pricing rules and the bootstrap admin.
- Apply: `npm run db:migrate:local` / `npm run db:migrate:remote` (needs `cloudflare.env`).
- `audit_log` has triggers that reject `UPDATE` and `DELETE` (append-only).

## Testing

`npm test` runs the Vitest suites inside workerd with a fresh local D1 that has the migrations applied:

- `test/auth.test.ts`: registration, enumeration safety, login/logout, lockout, session expiry, CSRF, verification, reset, password change
- `test/trips.test.ts`: trip CRUD and validation, generation, partial-plan completion, patch preservation, direct edits and concurrency, forged-place rejection, cross-guest and cross-user authorization, LLM rate limits, guest migration, merge unit tests
- `test/llm-usage.test.ts`: provider and model selection, missing/unsupported config, no fallback, bounded retries, schema validation, timeouts, cost maths, snapshot pricing, unknown-model NULL cost, Places SKU cost, caching, attribution, failures
- `test/admin.test.ts`: forced password change, admin/user separation, admin CRUD, last-admin guards, audit (including immutability), user/trip reporting, deletion workflow, date-range filtering, aggregates, attribution split

All OpenAI and Google calls are mocked with a stubbed `fetch`, and the email binding is replaced with an in-memory fake. The test wrangler config is in `test/`, so the real `.dev.vars` secrets are never loaded.

## Deployment

- The GitHub repo is connected to Workers Builds (trigger on `main`, deploy command `npx wrangler deploy`). Wrangler's `build.command` runs `npm run build:client`. That writes the commit SHA into `build-info.ts` and builds the SPA.
- `GET /api/health` reports `commit`, `buildSource`, the LLM provider and model, and whether bindings are present. Use it to confirm that the deployed version matches the intended commit.
- Migrations are applied separately (`npm run db:migrate:remote`) before pushing schema changes.
- Note: during this build, GitHub pushes did not trigger builds automatically (the webhook didn't fire), so builds were started on the same Workers Builds trigger through the Cloudflare API (`POST /accounts/:id/builds/triggers/:trigger/builds {"branch":"main"}`).

## Monitoring & cost accounting

- **Every** billable external request is written to `usage_events`. Each record holds:
  - timestamp, provider, model or SKU, endpoint, operation
  - user, guest and trip
  - status, HTTP status
  - input, cached-input, output and reasoning tokens; units
  - `cost_usd`, currency, pricing version, a **snapshot of the rates applied**
  - duration, attempt number, error code and message
- No credentials are ever stored.
- **LLM cost** = uncached input × input rate + cached input × cached rate + output × output rate, using provider-reported token counts. Dated snapshot models (`gpt-4o-mini-2024-07-18`) map to their base pricing. Unknown models get `cost_usd = NULL` ("unpriced") instead of a guess. Failed attempts that were billed (e.g. invalid output) are recorded with their cost.
- **Google Places cost:** the field mask includes rating and opening hours, which puts requests in the **Text Search Enterprise** SKU ($35 / 1,000, list price before Google's monthly free usage). Failed requests are recorded at $0. Cache hits are neither billed nor recorded.
- **Pricing configuration:** the `pricing_rules` table is editable in Admin → Pricing. Changes are audited and versioned, and historical records keep the rates they were calculated with.
- **Attribution:** usage is attributed to a trip, user or guest where possible. Admin → Usage splits cost into trip-attributed, owner-without-trip, fully unattributed and deleted-user usage. That explains why the sum of per-trip costs can differ from the total.
- **Time zone:** all timestamps are stored as UTC epoch milliseconds, and all reporting and buckets use UTC. In a custom range, the start date begins at 00:00 UTC and the end date runs to 23:59:59.999 UTC. Buckets are hourly for ranges of 3 days or less, daily up to 120 days, and weekly beyond that.
- **User deletion:** deleting a user (an admin must type the user's email to confirm) removes the user, their trips, messages, sessions and tokens. `usage_events` rows are **kept** for cost accounting. They still reference the now-deleted opaque user id but contain no PII, and they appear under "deleted users" in reports. Audit records are kept.
- **Operational:** Admin → Monitoring shows LLM and Places failures, latency (avg, p50, p95, max), recent application errors (5xx and email failures), and request volume charts on the Overview.
- **Cost-abuse controls:**
  - Messages: 2,000 characters max.
  - LLM requests: 6/min per user or guest, 40/day per guest, 150/day per user, 300/day per IP.
  - Output: 14k tokens max; timeouts of 120 s and 90 s.
  - Retries: at most 2 attempts per call, plus at most 3 completion calls.
  - Places search: 25 per 10 min. Verification: 6/h and at most 24–30 lookups per request.
  - Trips: 25 per guest, 300 per user; creation 30/h.
  - JSON bodies: 64 KB.

## Known limitations

- Generating a new multi-day itinerary takes about 20–30 s (outline + parallel day fill), which the UI covers with a progress indicator. Responses are not streamed. Edits take about 5–15 s.
- Google Places verification costs much more than the LLM (about $0.035 per verified stop, roughly $0.75 for a 5-day plan, before Google's free tier).
- No photos (Place Photos would add a billed SKU).
- PBKDF2 is capped at 100k iterations by the Workers runtime. Argon2/bcrypt aren't available natively.
- Rate limits use D1 fixed windows. They are approximate under very high concurrency.
- Email delivery to real inboxes was confirmed only as far as the Email Service accepting the send (see BUILD_REPORT.md).
