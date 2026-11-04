# BUILD_REPORT — AI Travel Planner (spec v1.7)

All times are UTC. Machine-readable results are in `BUILD_RESULTS.json`; the running log is in `PROGRESS.md`.

## 1. Executive Summary

**Outcome: complete, deployed and usable.** Production: https://ai-travel-planner-v1-claude.thebuildhypothesis.com

**Major successes**

- **Traveler experience:** works in production against the real OpenAI (`gpt-4o-mini`) and Google Places APIs. The spec §1.4 journey was run end-to-end in production (the Tokyo family request plus all five example follow-ups). It produced a 5-day plan in about 20 s with costs in the budget currency (USD) and 18/18 stops verified by Places. Each follow-up changed only the relevant day; all other days stayed byte-identical.
- **Accounts and guests:** guest, registered-user and guest-to-account migration flows were verified in production.
- **Admin console:** a separate console with a forced bootstrap password change, verified in production. It includes admin management, user and trip inspection, date-filtered cost and usage reporting, monitoring, pricing configuration and an append-only audit log.
- **Tests:** 98 automated tests pass (5 files). Typecheck and build are clean.
- **Deployment:** every deployment ran through the GitHub-connected Workers Builds trigger. `/api/health` reports the deployed commit, and it matched the pushed HEAD each time.

**Major gaps and caveats**

- **Real-inbox email delivery was not observed.** Cloudflare Email Service *accepted* every production send: no error was returned or logged, and `emailSent: true` came back. I couldn't click a link from a real inbox, because creating a disposable inbox was denied by the tool permission policy. Link consumption (verify and reset) is proven by automated tests only.
- **Workers Builds did not start on `git push`.** None of 7 pushes produced a build. Each deployment was started through the Cloudflare API on the **same** GitHub-connected trigger (`POST /builds/triggers/{trigger}/builds {"branch":"main"}`). Those builds clone `main` from GitHub, run `npx wrangler deploy`, and all succeeded.

## 2. Requirement-by-Requirement Status

Summary (from `BUILD_RESULTS.json`, 50 entries): **Verified 47, Partial 2** (2.3 schedule feasibility; 4.3 production reset click-through), **Blocked 1** (production real-inbox email workflow). Failed, Not Started and Implemented-but-Unverified are all 0.

Evidence keys:

- **T:** automated test (externals mocked).
- **P:** production check against the real services (2026-11-04).
- **L:** local `wrangler dev` with the real APIs.
- **UI:** headless-Chromium screenshot review (local).

| Ref | Requirement | Status | Evidence | Remaining |
|---|---|---|---|---|
| 2.1 | Understand NL requests, keep context, ask clarifying questions, personalize | Verified | T: "asks clarifying questions"; P: journey step 1 extracted travelers/ages/budget/interests | — |
| 2.1 | Reference the current itinerary; modify plans; preserve unrelated details | Verified | T: patch preserves other days (deep-equal); P: journey steps 2, 3 and 5 `preservedOthers=true` | — |
| 2.1 | Distinguish verified info from estimates | Verified | `place` data only from Google (T: forged place rejected); UI badges "Verified place" / "AI suggestion · unverified" / "est."; UI screenshot | — |
| 2.1 | Conversation history kept on reopen | Verified | T: reopen; P: 4 messages on reopen | — |
| 2.2 | Create, view, edit, save and reopen trips; all trip fields | Verified | T: CRUD + validation; UI: Trip details form | — |
| 2.2 | Incomplete requests handled | Verified | T: clarify turn | — |
| 2.3 | Structured day-by-day itinerary (times, durations, locations, descriptions, est. costs, transport) | Verified | Zod `itinerarySchema`; P: 5 days × 4–10 activities | — |
| 2.3 | Geographically and temporally practical | Partial | Prompt rules + per-day area outline; activities sorted by time; no server-side travel-time validation | Feasibility checker |
| 2.3 | Rendered in dedicated UI components | Verified | UI: day cards, timeline, map | — |
| 2.4 | Add/remove/replace/rearrange, change preferences, regenerate portions, persist, no needless regeneration | Verified | T: direct edits + optimistic concurrency + forged-data rejection; UI: activity menu, "Regenerate" day, "Replace with AI" | — |
| 2.5 | Real place research; never present fabricated facts as verified | Verified | P: 66 Places lookups, 0 errors; Explore tab search (T); estimates labelled | — |
| 2.6 | Interactive map: destinations, itinerary locations, per-day identification | Verified | UI: OSM tiles, colored numbered markers, routes, day filters (screenshot after fixing the tile host) | — |
| 2.7 | Polished, responsive, accessible UI with loading, empty and error states | Verified (visual review) | UI: desktop 1440/1920 and mobile 390 screenshots of home, trip, map, details, auth and admin; fixed a mobile header and map fit | No formal a11y audit |
| 3.1 | Guests create, generate, modify, continue and reopen in the same browser | Verified | T + P | — |
| 3.1 | Guest IDs secure; no cross-guest access | Verified | 256-bit token, hash stored; T: cross-guest, forged-cookie and stolen-after-claim tests | — |
| 3.2 | Email/password registration; case-insensitive unique email; hashing; validation; verification; stable UUID | Verified | T: auth suite; P: duplicate in a different case got an identical response; hash format checked | — |
| 3.2.7 / 3.5 | Guest trips retained; migration safe and without duplicates | Verified | T: migration suite; P: `migratedTrips = 1` | — |
| 3.3 | Login, logout, persistent sessions, expiry, invalidation, rate limits; HttpOnly cookies; no localStorage tokens | Verified | T: cookie flags, logout replay, absolute + idle expiry, lockout; P: login/logout | — |
| 3.4 | Saved trips, cross-device access, account info, password change, logout | Verified | T + P: password change, re-login, trip persisted | — |
| 3.4 | Server-side authorization; no cross-user access | Verified | T: cross-user tests | — |
| 4.1 | Cloudflare Email Service binding; sender from `EMAIL_FROM`; nothing hardcoded | Verified | Deployed binding `EMAIL` (send_email); P: sends accepted, no `app_errors` | — |
| 4.2 | Verification: secure token, hash stored, expiry, single use, resend with rate limit | Verified (tests) | T: verification suite | **Blocked:** real-inbox click-through |
| 4.3 | Reset: link on login page, ≤30 min, single use, sessions invalidated, no enumeration, rate limited | Verified (tests) / Partial (prod) | T: reset suite; P: identical responses for known and unknown emails; UI: "Forgot Password?" link | **Blocked:** real-inbox click-through |
| 4.4 | Honest handling of delivery failures; missing binding reported safely | Verified | T: failing binding → `emailSent:false` and logged; missing binding → 503 | — |
| 5.1 | Separate admin identity, sessions, hashing, cookies, rate limits, authz, expiry, logout | Verified | T: admin suite; P: admin session ≠ user session; logout → 401 | — |
| 5.2 | Bootstrap admin/admin; forced change; no data before change; never recreated; last-admin protection; no credentials in UI | Verified | T + P: data endpoints 403 before change; weak password rejected; old password rejected afterwards; UI forced-change screen | — |
| 5.3 | Admin account management | Verified | T: create, reset (forces change), disable, enable, delete, self-protection, last-admin SQL guards; UI: Admins page | — |
| 5.4 | User management, including delete with confirmation; deletion semantics documented | Verified | T: typed-email confirmation; trips deleted, usage retained; README | — |
| 5.5 | Trip inspection: sort, filter, guest trips, itinerary, timestamps, cost, pagination | Verified | T + P: newest first, guest filter, detail; UI screenshot | — |
| 6.1 | Overview metrics, lifetime vs. period, guests included | Verified | T + P + UI | — |
| 6.2 | Required presets + custom range; consistent; UTC documented | Verified | T: range inclusion/exclusion; P: last hour, last day, Jan 2020; UI selector | — |
| 6.3 | User metrics list and detail | Verified | T + P | — |
| 6.4 | Trip metrics list (default newest first) | Verified | T + P | — |
| 6.5 | Request-level usage records with all fields; no credentials | Verified | T: field assertions + no keys; P: usage rows | — |
| 6.6 | LLM cost: provider tokens, model pricing, cached tokens, historical snapshot, attribution, calls outside trips | Verified | T: cost maths, snapshot, unknown model → NULL; P: recomputed = stored ($0.0013854, $0.0009387) | — |
| 6.7 | Places cost: SKU, units, configurable pricing, attribution, non-trip requests | Verified | T: SKU cost, cache, failures at $0; P: 66 × $0.035 | — |
| 6.8 | Estimates labelled; unattributed usage accounted | Verified | Attribution split endpoint + UI notes | — |
| 6.9 | Visualizations (cost, trips, registrations, LLM, Places over time) | Verified (visual) | UI: Overview charts render (screenshot) | — |
| 6.10 | Operational monitoring | Verified | P: latency p50/p95, failures (0), app errors (0) | — |
| 7 | Audit logging; immutable | Verified | T: entries + UPDATE/DELETE rejected by triggers; P: 9 entries | — |
| 8.1 | Runtime provider/model; no hardcoded model; no silent substitution | Verified | T: selection, missing/unsupported config, no fallback; P: health shows openai / gpt-4o-mini | — |
| 8.2 | Provider abstraction | Verified | `LlmProvider` interface + OpenAI adapter; only OpenAI implemented, per spec | — |
| 8.3 | Structured-output validation | Verified | T: invalid output → bounded retry → error; malformed, truncated, refusal | — |
| 8.4 | Timeouts, bounded retries, rate-limit handling, errors, usage, cost | Verified | T: timeout, 429 retry, 401 no-retry | — |
| 9 / 9.1 | Cloudflare-only; existing Worker; prefixed new resources; migrations; bindings verified; resources documented | Verified | D1 `bh-travel-v1-claude-claude-db`; bindings listed via API | — |
| 9.2 | Email binding and templates | Verified (config + accepted sends) | — | Inbox check |
| 10.1 | Secrets untouched; admin vars preserved | Verified | `keep_vars: true`; bindings after deploy match the originals | — |
| 11 | GitHub-connected Workers Builds deployment; version verified | Verified (with caveat) | 7 successful builds on trigger `d85467ea…`; health commit = HEAD | Push webhook not firing |
| 12 | Served from root; HTTPS; SPA routes; no hardcoded hostname | Verified | P: `/`, `/trips/x`, `/admin` → 200 over HTTPS; links use `APP_PUBLIC_URL` | — |
| 13 | Security baseline | Verified | T suites; parameterized SQL; CSRF tests; P: cross-origin POST 403 | See §8 risks |
| 13.1 | API cost-abuse protection | Verified | T: LLM per-minute limit, size limits; caps documented | — |
| 14 | Automated tests | Verified | 98/98 | — |
| 17 / 18 | Progress log, README, reports | Verified | `PROGRESS.md`, `README.md`, this file, `BUILD_RESULTS.json` | — |

## 3. What Was Built

**Traveler app** (`/`)

- **Landing:** hero prompt box, example trips, "Continue planning" cards, feature highlights.
- **Trip workspace** (`/trips/:id`):
  - **Desktop:** chat on the left with typing and progress states, retry on error, and suggestion chips.
  - **Itinerary tab:** day cards with color, date and area; a timeline of activities with category, duration, location, estimated cost, "Verified place" and rating badges, listed hours and links, booking hints and transport notes; a per-activity menu (edit, replace with AI, move up/down, move to day, remove); add activity; regenerate day; "Verify places".
  - **Map tab:** Leaflet + OpenStreetMap, numbered markers colored by day, dashed markers for AI-estimated coordinates, route lines, day filters.
  - **Trip details tab:** form for all preferences.
  - **Explore places tab:** Google Places search with add-to-day.
  - **Wide screens:** a live map sits next to the itinerary.
  - **Mobile:** a bottom tab bar.
- **My trips:** cards grid with empty and skeleton states.
- **Auth and account:**
  - Sign in (with a **Forgot Password?** link), registration, and a "check your inbox" screen.
  - Forgot/reset password and verify-email pages.
  - Account settings: display name, verification resend, change password.
  - Verification banner and guest banner.

**Admin console** (`/admin`)

- Separate dark-themed login and a forced password-change screen.
- A sidebar app with a shared period selector (7 presets + custom UTC range, stored in the URL):
  - **Overview:** lifetime vs. period cards; 5 charts with table toggles.
  - **Users:** search, sort, status filter, pagination. Detail shows trips, per-trip costs and usage history, with disable/enable and delete (typed email).
  - **Trips:** search, owner filter, "created in period", sort, pagination. Detail shows itinerary, transcript and usage.
  - **Usage & Costs:** breakdown, attribution split, raw events with an expandable pricing snapshot.
  - **Monitoring:** latency, API failures, app errors.
  - **Admins:** create, reset, disable/enable, delete, change own password.
  - **Audit log** (read-only).
  - **Pricing:** edit and add rules (audited).

**Architecture**

- One Worker (`ai-travel-planner-claude`) runs a Hono API under `/api/*` and serves the Vite-built React SPA as static assets.
- D1 holds all persistent state, including rate-limit counters and the Places cache.
- The LLM provider abstraction asks for structured output and merges patches server-side.
- New plans use two phases: an outline turn, then parallel per-day fill calls (~3× faster than a single call).
- See `README.md` for the full design.

## 4. How to Access and Test It

- **URL:** https://ai-travel-planner-v1-claude.thebuildhypothesis.com (`APP_PUBLIC_URL`)
- **Local setup:**
  1. `npm install`
  2. `cp .dev.vars.example .dev.vars` (fill in the values)
  3. `npm run db:migrate:local`
  4. `npx wrangler dev` → http://localhost:8787
- **Tests:** `npm test` and `npm run typecheck`.
- **Guest workflow:**
  1. On `/`, click the "Family week in Tokyo" chip, then **Plan my trip**. Expect about 20–30 s.
  2. Send "Make day three less expensive" and "Replace the museum with something outdoors". The changed day flashes and the other days stay the same.
  3. Check the Map tab, the activity "…" menu and Explore places.
  4. Reload, or open "My trips", to reopen the trip.
- **Account workflow:**
  1. Create an account with a **real inbox** and click the verification link.
  2. Sign in. The guest trips from that browser move to the account (a toast confirms it).
  3. Change the password in Account settings.
  4. Sign out, use **Forgot Password?**, follow the email link, then sign in with the new password.
- **Administrator bootstrap:**
  - On a fresh database, go to `/admin` and sign in as `admin` / `admin`. Only the mandatory "Set a new password" screen is shown.
  - **In this production deployment the bootstrap password has already been changed** during verification. The new password is stored locally in the gitignored `.admin-credentials` file on the build machine; hand it over out of band.
  - To see the forced-change flow again, create a new admin (they must change their password at first login) or reset another admin's password.
- **Recommended walkthrough:**
  1. Guest plan, then modify, then reopen.
  2. Register (real inbox), verify, sign in (migration).
  3. Reset the password.
  4. In Admin, use the "Last hour" preset and check Overview, then Users → your user → trip → Usage tab, then Usage & Costs, then the Audit log.

## 5. Tests and Verification

| Check | Command / procedure | Environment | Result |
|---|---|---|---|
| Automated tests | `npm test` (Vitest 4.1.12 + @cloudflare/vitest-plugin 1.5.1) | local workerd + D1; OpenAI, Google and email mocked | **98 passed, 0 failed, 0 skipped** (admin 34, trips 24, auth 20, llm-usage 18, smoke 2), last run 18:36Z |
| Typecheck | `npm run typecheck` (TypeScript 7.0.2) | local | pass |
| Build | `npm run build` (Vite 8) | local + Workers Builds | pass |
| Live planner (real APIs) | `e2e.mjs` vs `wrangler dev` | local | pass: 5 days, 21/21 → 24/24 verified, patch preserved |
| Production guest flow | `e2e.mjs` | prod, 18:06Z | pass: 5 days in 59 s (single-call version), 22/22 verified, day 3 only changed, 4 messages on reopen |
| Production §1.4 journey | `journey.mjs` (6 steps) | prod, 18:35Z, commit `df2a383` | pass: plan in 20.1 s, USD, 18/18 verified. Each step's changed days: [3], [3], answer-only, [2,3,4,5], answer-only. Untouched days preserved in every step. |
| Production accounts | `prod-auth.mjs` (example.com address) | prod, 18:07Z | pass: register `emailSent:true`, duplicate identical, wrong password 401, login + migration 1, resend 200, password change, logout/login, forgot-password identical, cross-origin POST 403 |
| Real-inbox email click-through | disposable mail.tm inbox | prod | **blocked:** tool permission policy denied creating a third-party inbox; not attempted further |
| Production admin | `prod-admin.mjs` | prod, 18:12Z and 18:38Z | pass: forced change, 403s before change, weak password rejected, old password rejected, overview/users/trips/usage/monitoring/audit/admins correct, separation, logout |
| Cost recomputation | stored tokens × stored pricing snapshot | prod | exact match (e.g. 7,630 in / 4,096 cached / 169 out → $0.0009387) |
| Bindings | Cloudflare API `GET workers/scripts/{name}/settings` | prod | ASSETS, DB (d1), EMAIL (send_email); APP_PUBLIC_URL, EMAIL_FROM, LLM_MODEL, LLM_PROVIDER (plain_text, preserved); OPENAI_API_KEY, GOOGLE_MAPS_API_KEY (secret, preserved) |
| HTTPS, domain, SPA | `curl` | prod | `/`, `/trips/xyz`, `/api/health` → 200 over HTTPS on the custom domain |
| UI review | Playwright + Chrome headless shell, 1440/1920/390 px | local | Done; found and fixed 3 bugs (map tile host, initial map fit, mobile day-header layout) |

The `npm test` checks are mocked. All P checks used the real OpenAI, Google Places, Email Service, D1 and custom domain. Scratch scripts live outside the repo (in the agent's scratchpad) and are described here.

## 6. Deployment and Infrastructure

- **Repository and branch:** `git@github.com:the-build-hypothesis/ai-travel-planner-claude.git`, `main`.
- **Commits (in order):**
  - `067cef5`: initial
  - `c7142f9`: admin UI, completion loop
  - `725f902`: tests, commit detection
  - `e5c021b`: map/mobile fixes, docs
  - `81a0be6`: two-phase generation
  - `df2a383`: currency enforcement, honest no-change
  - Final docs commit(s): see `BUILD_RESULTS.json` and the final chat response.
- **Workers Builds:** trigger `d85467ea-cc51-4d5f-960e-6a106d8d23d2` (deploy command `npx wrangler deploy`, branch `main`). Every build was started via the API on this trigger; the push webhook didn't fire.

  | Build | Result | Notes |
  |---|---|---|
  | `29841bd0` | success | health reported `"main"`: commit-detection bug, fixed in `725f902` |
  | `dbbb9670` | success | → `725f902` |
  | `475dfdfc` | success | → `e5c021b` |
  | `dd84d576` | success | → `81a0be6` |
  | `8b7a5961` | success | → `df2a383` |

  Each was verified with `/api/health` `commit` = pushed SHA and `buildSource: workers-builds`.
- **Resources created:** D1 `bh-travel-v1-claude-claude-db` (`f0ebeb80-b6b6-4360-bc95-87674614a4f4`, ENAM). No other resources were created.
- **Resources modified:** the existing Worker `ai-travel-planner-claude` gained D1, send_email and static-assets bindings. Admin vars and secrets were preserved, and `workers_dev` and preview URLs are disabled.
- **Migrations:** `0001_initial.sql` applied remotely (`wrangler d1 migrations apply DB --remote`) and locally.
- **Custom domain:** `ai-travel-planner-v1-claude.thebuildhypothesis.com` was already attached to the Worker (confirmed via API; certificate active) and serves HTTPS. DNS was not modified.

## 7. Integrations and Configuration

- **LLM:** provider `openai`, model `gpt-4o-mini`. Read from the Worker's runtime vars, shown by `/api/health`, and confirmed by usage records (the provider reports `gpt-4o-mini-2024-07-18`). Secret values were never read or printed.
- **Google Places (New) Text Search:** configured and working. 66 production lookups, 0 failures, p50 470 ms. Billed under the Enterprise SKU because the field mask includes rating and hours.
- **Maps:** Leaflet with OpenStreetMap standard tiles; no key needed. CARTO was tried first, but it now requires a key; that was found in UI review.
- **Email:** the `EMAIL` send_email binding and `EMAIL_FROM` are configured. Production sends were accepted with no errors. Inbox delivery was not observed (§1).
- **Missing configuration:** none.

## 8. Security Review

- **Passwords:** PBKDF2-SHA256 at 100k iterations (the platform maximum) with a 128-bit salt.
- **Secrets:** all tokens are 256-bit random values; only SHA-256 hashes are stored.
- **Cookies:** `__Host-` prefix, HttpOnly, Secure, SameSite (Lax for users, Strict for admins). No tokens are kept in JS storage.
- **Sessions:**
  - Users: 30 days absolute / 14 days idle.
  - Admins: 8 h absolute / 30 min idle.
  - A password reset clears all of the user's sessions; a password change clears all other sessions.
- **Authorization:** every trip query is owner-scoped, and someone else's trip returns 404. Tests cover cross-guest, cross-user, forged-cookie and stolen-after-claim cases. Clients can't inject "verified" place data.
- **Separation:** admins use separate tables, cookies and middleware; user context is cleared on admin routes and vice versa.
- **Enumeration:**
  - Registration gives the same response and sends a notice email to an existing owner.
  - Login gives the same error.
  - Forgot-password gives the same response, and the email is sent asynchronously so timing doesn't reveal account existence.
- **Rate limits:** login (per IP and per account lockout), admin login, registration, resend, forgot-password, token submission, LLM (per minute, per day, per IP), Places search and verification, and trip creation.
- **CSRF:** a custom header + `Origin` + `Sec-Fetch-Site` check; tested.
- **Injection:** SQL is fully parameterized and sort keys are whitelisted. React escapes output and map popups are escaped manually. Model output is validated with Zod.
- **Errors:** responses are generic; details go to `app_errors` (path only, no query strings).
- **Risks and untested areas:**
  - No CAPTCHA.
  - The PBKDF2 iteration count is below OWASP's 600k (a platform cap).
  - D1 fixed-window limits are approximate under heavy concurrency.
  - Prompt injection can steer the assistant only within the user's own trip.
  - The real-inbox email flow is unverified.
  - Unverified accounts can sign in (by design, so an email outage doesn't lock users out); a banner prompts them to verify.

## 9. Usage, Costs, and Estimates

**Measured by the app** (application-level estimates from provider-reported tokens and configured list prices; not an invoice). Production totals for 2026-11-04 after verification:

- LLM: 25 requests, **$0.0260**
- Google Places: 66 requests, **$2.31**
- Combined: **$2.336**
- All attributed to trips; $0 unattributed.

By operation:

| Operation | Requests | Cost |
|---|---|---|
| place_verify | 66 | $2.31 |
| trip_chat | 11 | $0.0149 |
| trip_plan_day | 10 | $0.0072 |
| trip_plan | 3 | $0.0021 |
| trip_plan_continue | 1 | $0.0019 |

- **Sample calculation:** 7,630 input tokens (4,096 cached) and 169 output tokens at $0.15 / $0.075 / $0.60 per 1M = 3,534×0.15e-6 + 4,096×0.075e-6 + 169×0.60e-6 = **$0.0009387**. This matches the stored value.
- **Typical cost per new 5-day plan:** LLM about $0.005–0.01; Places about $0.65–0.90 (18–25 verified stops × $0.035, before Google's monthly free usage).
- **Not included / unknown:**
  - Local `wrangler dev` runs (3 live plans, recorded in the local D1 only).
  - Actual provider invoices: **unknown**; never reconciled.
  - Agent/LLM compute cost of this build session: **unknown**.

## 10. Known Bugs, Limitations, and Incomplete Work

| Severity | Issue | User impact | Workaround | Recommended fix |
|---|---|---|---|---|
| Medium | Workers Builds doesn't trigger on GitHub push | Pushes don't deploy automatically | Start a build for `main` from the dashboard or API | Reconnect the GitHub integration / check the webhook in the Cloudflare dashboard |
| Medium | Email inbox delivery not observed | Verify/reset not proven end-to-end in prod | Reviewer tests with a real inbox | — |
| Low | Places verification dominates cost (~$0.7/plan) | Spend | — | Verify only key stops, or drop rating/hours (Pro SKU) |
| Low | Model quality: occasional echoed day, repeated restaurant, or closed venue | Minor | No-change note; "closed" badge from Google status | Stronger model or post-filtering |
| Low | No streaming; first plan takes 20–30 s | Wait time | Progress UI | Stream the outline, fill days progressively |
| Low | Schedule feasibility relies on the prompt | Occasional tight days | Manual edits | Server-side travel-time check |
| Info | Production DB contains verification data (4 trips, 1 example.com user) | Shows up in admin metrics | — | Delete via admin if desired |

## 11. Agent Execution Summary

- **Start:** 2026-11-04T17:24:43Z (observed: first command output). **End:** recorded in `BUILD_RESULTS.json` (`execution.endedAt`).
- **Timeline (observed):**

  | Time | Milestone |
  |---|---|
  | 17:24 | Environment and Worker inspection |
  | 17:35 | D1 created |
  | ~17:45 | Backend typechecked |
  | 17:45–18:00 | Frontend; admin UI + admin tests built by a parallel sub-agent |
  | 17:53 | First push |
  | 17:55 | Live local e2e |
  | 18:04 | First Workers Build (API-triggered) |
  | 18:06–18:12 | Production guest, account and admin verification |
  | 18:16 | `725f902` deployed |
  | 18:20–18:27 | Headless-browser UI review and fixes; `e5c021b` deployed |
  | 18:30 | Two-phase generation; `81a0be6` deployed |
  | 18:33 | `df2a383` deployed |
  | 18:35 | Production §1.4 journey |
  | 18:38 | Final metrics and reports |

- **Self-corrections:**
  1. Test config loaded the real `.dev.vars`; it was isolated in `test/`.
  2. The model returned 1 of 5 days; prompt rules and a continuation loop were added, later replaced by the two-phase design.
  3. JPY was used with a USD budget; a prompt rule was added, then server-side enforcement.
  4. `wrangler dev` got into an infinite rebuild loop; build-info writing was made idempotent.
  5. The health check reported "main" as the commit; SHA validation was added.
  6. One test assumed no Places cache; the assertion was fixed.
  7. UI review found the wrong tile host, then CARTO's key requirement (switched to OSM), the map fit timing, the mobile header layout, and admin selects ignoring width classes.
  8. "No-change" edits were shown as changes; real diffing was added.
- **Retries and blocks:**
  - The Playwright browser download stalled, so Chrome-for-Testing was fetched directly with user-space libraries.
  - The disposable-inbox test was denied by the permission policy and not worked around.
  - A heredoc file-writing command was blocked by a safety parser, so files were written with the Write tool.
- **Human interventions:** none.

## 12. What to Expect During Independent Review

- **First plan:** about 20–30 s with animated progress text and skeleton day cards, then the itinerary and the changed-day highlight. Edits take about 5–15 s; questions about 3–5 s.
- **Badges:** green "Verified place" means Google matched it (with rating and listed hours under "More"). Amber "AI suggestion · unverified" marks AI-only content. All prices show "est.". The map draws dashed markers for AI-estimated coordinates.
- **Fragile areas:**
  - LLM variability (wording, occasionally echoing a day unchanged; the app then says nothing changed).
  - Very long trips (14 days → 14 parallel fills, higher Places cost).
  - Destinations where Google matches poorly. Matches more than 60 km from the estimate are rejected and stay unverified.
- **Suggested tests:**
  1. Open a trip URL in a private window: expect "Trip not found".
  2. Send 7 messages quickly: expect a rate-limit message.
  3. Admin "Last hour" preset after planning: costs appear.
  4. Try to disable yourself as admin (blocked) and to delete the last admin (blocked).
  5. Check the Audit log after admin actions.
  6. Delete a test user (requires typing the email) and confirm their usage still counts under "deleted users".
  7. Edit a pricing rule, then confirm old usage rows keep their original rates.

## 13. Final Assessment and Next Steps

**Ready:** the traveler (guest and account), admin, and cost/usage features, all verified in production with the real LLM and Places APIs. Security controls are covered by tests. Deployment runs on Workers Builds and the deployed version is verified.

**Remaining:**
1. Confirm real-inbox email delivery.
2. Repair the push → Workers Builds webhook.

**Next steps:**
1. Stream responses or fill days progressively.
2. Reduce Places cost per plan.
3. Validate travel times server-side.
4. Add Turnstile to registration and reset.
5. Add a formal accessibility audit.
