# AI Travel Planner: Build Report

Spec v1.7. Generated 2026-11-05T23:53:45Z. Machine-readable results are in [BUILD_RESULTS.json](BUILD_RESULTS.json).

## 1. Executive Summary

**The application is complete, deployed and usable at https://ai-travel-planner-v1-claude.thebuildhypothesis.com.**

Of 73 tracked requirements, 71 are verified, 1 is partial and 1 is implemented but unverified. None failed, none were blocked, and none were left unstarted. It was built and verified in about 85 minutes of the eight-hour window, with no human intervention.

**Working in production, with real services:** guest planning, conversational edits, real Google Places verification, the interactive map, registration with real email verification, password recovery, guest-to-account migration, the admin console with forced password change, and usage and cost reporting.

**Main gaps:**
- Schedule practicality is marked Partial. Conflicts are corrected and flagged by code, but overall quality depends on the model and was not systematically assessed.
- Accessibility is implemented but has not been audited.
- Some failure paths and limits have only been tested with mocks, because no real failure occurred.

**Decisions for you:**
- **Admin login changed.** `admin`/`admin` no longer works in production. Verification completed the forced change, because the known default was live on a public URL. The new password is in the git-ignored `.admin-credentials` on the build machine.
- **Google map terms.** Places data on an OpenStreetMap map should be reviewed before commercial use. See section 10.
- **Places cost.** Places accounts for 99% of API cost, about $0.88 for a 5-day plan. Review this and the $25 daily cap before opening to real traffic.

## 2. Requirement-by-Requirement Status

Evidence tags: **[prod]** real deployment and real external services. **[local]** real browser and real APIs on `wrangler dev`. **[mocked]** Vitest in workerd with real D1, but mocked external APIs. A requirement can be Verified on mocked evidence alone; the evidence column says when that is the case.

| Ref | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1 | Natural-language requests, context, clarifying questions | Verified | [prod] guest and tools journeys; [mocked] trips.test.ts conversation suite |
| 2.1 | Modifies plans and preserves unrelated details | Verified | [prod] guest journey asserts day 1 unchanged after a chat edit; [mocked] exact equality checks on untouched activities and days |
| 2.1 | Distinguishes verified information from estimates | Verified | [prod] stops badged Verified place or AI suggestion, costs labeled est.; [mocked] quality.test.ts |
| 2.1 | Conversation history available on reopen | Verified | [prod] guest journey reopens trip and sees the conversation |
| 2.2 | Create, view, edit, save and reopen trips | Verified | [prod] guest and tools journeys |
| 2.2 | Trip fields, including incomplete requests | Verified | [prod] details form saved and invalid dates refused; [mocked] 10 validation cases |
| 2.3 | Structured day-by-day itineraries with dedicated UI | Verified | [prod] journeys assert day sections and stops; schema validated before saving |
| 2.3 | Geographically and temporally practical schedules | Partial | [mocked] overlap normalization and warnings. Quality depends on the model: gpt-4o-mini grouped days sensibly in observed runs, but its coordinates can be tens of km off, and this was not assessed systematically |
| 2.4 | Add, remove, replace and rearrange activities | Verified | [prod] add, edit, remove with undo, arrow and adjacent drag reorder, chat replace. Long-distance drag needing auto-scroll did not pass automation (see issues) |
| 2.4 | Change preferences and regenerate selected portions | Verified | [prod] details form and Regenerate day, other day unchanged |
| 2.5 | Real-world place research with hours and ratings | Verified | [prod] chat research cards, Explore tab and Explore page, using Google Places |
| 2.5 | No fabricated details presented as verified | Verified | [mocked] hours only from Places, renamed places lose verified data, closed places flagged. [local] a real closed branch was flagged from live Places data |
| 2.6 | Interactive map of destinations and itinerary locations | Verified | [prod] tiles and pins load on desktop and mobile; screenshots reviewed |
| 2.6 | Locations identified by day | Verified | [prod] pins numbered and colored by day, reviewed in screenshots. The day filter buttons render but automation did not click them |
| 2.7 | Polished, responsive UI | Verified | [prod] screenshots reviewed at 1440px and 390px; no horizontal overflow asserted on mobile |
| 2.7 | Loading indicators, empty states and clear errors | Verified | [prod] skeleton days and status lines observed; empty states and field errors asserted |
| 2.7 | Accessible controls | Implemented but Unverified | Labels, focus styles, native dialogs and chart data tables implemented. No screen-reader test or automated accessibility audit was run |
| 3.1 | Guests can create, generate, modify and continue | Verified | [prod] guest journey with no account |
| 3.1 | Server-side guest data with an unguessable identifier | Verified | [prod] HttpOnly cookie attributes; [mocked] token is long and only its hash is stored |
| 3.2 | Registration with validation and unique case-insensitive email | Verified | [prod] registration; [mocked] validation and case-insensitivity |
| 3.2 | Secure password hashing, never stored in plaintext | Verified | [mocked] scrypt format, salts and no plaintext in rows; [prod] login works with scrypt on Workers |
| 3.2 | Email verification supported | Verified | [prod] real email received at a disposable inbox and its link confirmed the account |
| 3.2 | Guest trips retained after registering | Verified | [prod] account journey |
| 3.3 | Login, logout and persistent sessions | Verified | [prod] login across browser contexts; [mocked] server-side invalidation on logout |
| 3.3 | Session expiration | Verified | [mocked] idle and absolute expiry, with timestamps set in the database. Not waited out in production |
| 3.3 | Rate limiting and attack protection | Verified | [mocked] login, reset and registration limits, identical errors for unknown accounts. Admin login lockout also observed locally |
| 3.3 | HTTP-only cookies, no tokens in local storage | Verified | [prod] guest cookie attributes; [mocked] user and admin cookies. Client code uses no web storage |
| 3.4 | Saved trips, reopening and cross-device access | Verified | [prod] second browser context logs in and sees the trip |
| 3.4 | Update basic account information | Verified | [prod] name saved in account journey; [mocked] currency. Email address cannot be changed (see limitations) |
| 3.4 | Change password | Verified | [mocked] change ends other sessions. Not exercised in a production browser |
| 3.4 | Server-side authorization of owned resources | Verified | [mocked] 10 operations return 404 for another user; [prod] same for another guest |
| 3.5 | Guest-to-account migration without claims or duplicates | Verified | [prod] migration on login; [mocked] idempotence, other guests protected, merge into an existing account |
| 4.1 | Cloudflare Email Service binding, sender from EMAIL_FROM | Verified | [prod] real delivery; EMAIL binding confirmed through the API; sender read from the runtime variable |
| 4.2 | Verification tokens: secure, hashed, expiring, single use | Verified | [prod] real link used; [mocked] hash-only storage, expiry and reuse refused |
| 4.2 | Resend with rate limiting | Verified | [mocked] replaces the old link, uniform response, limit enforced |
| 4.3 | Forgot Password link and full reset workflow | Verified | [prod] real email, link, new password; old password refused, new accepted |
| 4.3 | Reset expiry, single use, sessions ended, no enumeration, rate limit | Verified | [prod] link reuse refused and other device logged out; [mocked] 30-minute expiry, identical responses, limit |
| 4.4 | Delivery failures handled honestly | Verified | [mocked] thrown failure and missing binding. No real delivery failure occurred to observe |
| 5 | Separate admin interface and identity | Verified | [prod] guest session refused; [mocked] cookies not interchangeable, user credentials refused |
| 5.1 | Admin auth: hashing, cookies, rate limit, server-side checks, expiry | Verified | [prod] unauthenticated and guest requests refused; [mocked] Strict cookie, expiry, logout, lockout |
| 5.2 | Bootstrap account with forced password change | Verified | [prod] activate-admin.mjs: 7 routes blocked, change succeeded, old password refused. [local] same flow through the browser UI |
| 5.2 | Not recreated after deletion; last admin protected; credentials not in UI | Verified | [mocked] deletion and guard in the SQL write; [prod] page and bundle checked for default credentials |
| 5.3 | Create, reset, disable, delete and view administrators | Verified | [prod] admin-manage journey through the UI, with typed confirmation |
| 5.4 | User list, search, detail, disable and re-enable | Verified | [prod] admin-manage journey; disabled user logged out and refused |
| 5.4 | Protected user deletion, with documented effects | Verified | [prod] typed confirmation, then login refused; [mocked] trips cascade and usage retained; README describes it |
| 5.5 | Trip list, sort, filter, search, guest trips and pagination | Verified | [prod] newest-first and guest filter asserted; [mocked] search, user filter, sort and paging |
| 5.5 | Inspect itinerary, timestamps, usage and cost per trip | Verified | [prod] trip detail API used to validate usage; audit entry confirmed |
| 6.1 | Overview metrics, lifetime separate from period | Verified | [prod] lifetime figures unchanged across ranges; [mocked] exact totals |
| 6.2 | Shared reporting period with all presets and custom range, UTC | Verified | [prod] all 7 presets and a custom range exercised in the UI; [mocked] boundaries |
| 6.3 | User metrics and detail view | Verified | [prod] lists and detail; [mocked] date filter applied to costs, sorting by cost |
| 6.4 | Trip metrics, newest first | Verified | [prod] order asserted; [mocked] per-trip costs respect the range |
| 6.5 | Request-level usage records, no credentials stored | Verified | [prod] records inspected field by field; [mocked] scrubbing of keys from error text |
| 6.6 | LLM cost tracking | Verified | [prod] real tokens, costs matched a hand calculation to within 1e-12; [mocked] cached pricing, unknown cost for unpriced models, history kept |
| 6.7 | Google Places cost tracking by SKU | Verified | [prod] $0.035 search and $0.007 photo; repeat photo not billed; [mocked] outside-trip usage |
| 6.8 | Estimates labeled, explainable, unattributed usage accounted for | Verified | [prod] notes visible, parts add up to total; pricing snapshot per record |
| 6.9 | Monitoring visualizations | Verified | [prod] charts rendered and reviewed in screenshots; series data asserted |
| 6.10 | Operational monitoring | Verified | [prod] latency and request volume returned. Failed requests and errors [mocked] only, because production had none |
| 7 | Audit logging, not editable | Verified | [prod] login, management and trip access entries seen; [mocked] triggers refuse UPDATE and DELETE, no secrets in rows |
| 8.1 | Runtime provider and model, no hardcoding or substitution | Verified | [prod] openai / gpt-4o-mini reported from runtime config; [mocked] missing values fail, no fallback |
| 8.2 | Provider abstraction | Verified | [mocked] adapter and contract; only OpenAI implemented, as the spec allows |
| 8.3 | Structured output validated before saving | Verified | [prod] OpenAI accepted strict schemas; [mocked] malformed output retried and never saved |
| 8.4 | Timeouts, bounded retries, rate-limit handling, clear errors | Verified | [mocked] each failure class. No real provider failure occurred to observe |
| 9 | Cloudflare-only hosting and persistence | Verified | Worker, D1 and Assets confirmed through the API; external services are AI, Places and map tiles only |
| 9.1 | Existing Worker used, prefixed resources, reproducible config | Verified | Worker reused; D1 named with the prefix; wrangler.jsonc and migrations in the repository |
| 9.2 | Email binding, templates and sending | Verified | [prod] verification and reset emails delivered |
| 10.1 | Secrets untouched, administrator configuration preserved | Verified | Bindings read before and after deploys; no wrangler secret commands run; secret scan clean |
| 11 | GitHub-connected deployment verified | Verified | Workers Builds success with health reporting b82d7cf and source workers-builds |
| 12 | Public URL, root serving, HTTPS, redirects and routes | Verified | [prod] verify-prod.mjs: redirect, HSTS, deep links, API 404; no hostnames in source |
| 13 | CSRF, injection and safe error handling | Verified | [prod] cross-origin POST refused; [mocked] SQL metacharacters, sort allowlist, LIKE escaping, body limits, safe messages |
| 13.1 | API cost abuse protection | Verified | [mocked] per-owner, per-address and daily limits, global cost cap, Places quota, output bounds. Limits not load tested in production |
| 13.2 | Administrative security | Verified | [prod] server-side refusal; destructive actions confirmed by typing |
| 14.1-14.4 | Automated application, auth, usage and provider tests | Verified | npm test: 236 passed |
| 14.5 | Production verification walkthrough | Verified | All 20 steps executed. See section 5 of the report |

## 3. What Was Built

**For travelers**
- **Landing page:** describe a trip in plain language, with no account needed.
- **Trip workspace:** chat on the left, with Itinerary, Map, Explore and Details views. Replies and finished days stream in as they are ready. On phones, a bottom bar switches between panels.
- **Itinerary:** day cards with times, durations, estimated costs and source badges. Stops can be edited, moved, removed or dragged, days regenerated, and any change undone. Warnings flag overlaps, overfull days, repeated places and closed venues.
- **Map:** numbered pins colored by day, a day filter, and dashed pins for unverified locations.
- **Research:** chat requests and Explore searches return Google Places cards that can be added to a day.
- **Explore page:** destination ideas and place lookup, outside any trip.
- **Accounts:** registration, verification, login, password recovery, profile and password change.

**For administrators, at `/admin`:** Overview with period and lifetime metrics and six charts; Users; Trips; Usage & costs with a per-record cost explanation; Operations; Administrators; Audit log; and Settings for limits and prices.

**Architecture:** one Cloudflare Worker running Hono, with D1 for all state and React served through Workers Assets. See [README.md](README.md).

**Key design decisions**
- **Edits are operations, not rewrites.** The model proposes operations and the server applies them, so unrelated content cannot change. The chips under a reply come from what the server did, not what the model said.
- **Verified means Google said so.** Opening hours can only come from Places. The model's coordinates are never treated as fact.
- **Registration does not reveal existing accounts.** So login requires a verified email, and new users are not logged in automatically.
- **Unknown cost is shown as unknown.** An unpriced model records its tokens and a null cost, and the dashboard counts those requests rather than treating them as free.

## 4. How to Access and Test It

**URL:** https://ai-travel-planner-v1-claude.thebuildhypothesis.com

**Local setup**
```sh
npm install
cp .dev.vars.example .dev.vars    # Add local API keys
npm run db:migrate:local
npm run dev:worker                # http://127.0.0.1:8787
```

**Guest workflow:** open the URL, describe a trip, and select Start planning. No account is needed.

**Account workflow:** select Sign up and register with an inbox you can read. Open the emailed link, then log in. Trips made as a guest in that browser move to your account.

**Administrator workflow, production:** go to `/admin`, and log in as `admin` with the password in `.admin-credentials` on the build machine.

**Seeing the forced password change yourself.** The production bootstrap has been used, so `admin`/`admin` no longer works. Either of these shows the same lockout:
- **Easiest:** create a new administrator under Administrators, then log in as them in a private window. They must set a new password, and nothing else is available until they do.
- **The original bootstrap:** use a fresh local database. Run `npm run db:migrate:local` and `npm run dev:worker`, then log in at `/admin` with `admin`/`admin`.

**Recommended walkthrough:** section 12.

## 5. Tests and Verification

All timestamps are UTC, 2026-11-05.

| Command | Environment | Result |
|---|---|---|
| `npm test` | workerd, real D1, **mocked** LLM, Places and email | **236 passed**, 0 failed, 0 skipped |
| `npm run typecheck` | Local | Passed |
| `npm run build` | Local and Workers Builds | Passed |
| `E2E_BASE_URL=<url> npx playwright test` | **Production**, real services, Chromium, on b82d7cf | **9 passed**, 0 failed, 1 skipped |
| `npx playwright test e2e/admin.spec.ts` | Local, real browser | Forced-change browser test passed |
| `node scripts/activate-admin.mjs <url>` | **Production**, on 52634c8, ~23:13 | 13 of 13 passed. Can only run once |
| `node scripts/verify-prod.mjs <url>` | **Production**, real services, on b82d7cf | All checks passed, ~23:49 |
| `npm audit --omit=dev` | Local | 0 vulnerabilities |

The skipped Playwright test is the forced password change in a browser. It needs an unactivated database, so it only runs locally.

Not everything passed first time. See section 11 for the real bugs that production testing found. Earlier failing runs were fixed, not retried until green.

### Production verification (spec 14.5)

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Open APP_PUBLIC_URL | Passed | guest journey |
| 2 | Create a guest trip | Passed | guest journey |
| 3 | Generate an itinerary | Passed | real OpenAI and Places, 15-20 s for 1 day |
| 4 | Modify the itinerary | Passed | chat edit, direct edits, undo |
| 5 | Save and reopen | Passed | reload shows the conversation and days |
| 6 | Register a user | Passed | account journey |
| 7 | Verify the email workflow | Passed | real email to a disposable inbox |
| 8 | Log in | Passed | unverified login refused first |
| 9 | Verify trip persistence | Passed | second browser context |
| 10 | Verify guest-to-account migration | Passed | 1 trip moved |
| 11 | Test password recovery | Passed | real email, link single-use, sessions ended |
| 12 | Log into the admin interface | Passed | browser |
| 13 | Verify the initial password change | Passed | API in production; browser UI locally |
| 14 | Inspect users and trips | Passed | browser and API |
| 15 | Verify usage and cost metrics | Passed | hand calculation matched |
| 16 | Test date-range filtering | Passed | all 7 presets and a custom range |
| 17 | Verify provider and model | Passed | openai / gpt-4o-mini |
| 18 | Verify Cloudflare bindings | Passed | section 6 |
| 19 | Verify HTTPS and the custom domain | Passed | redirect, HSTS |
| 20 | Confirm GitHub Builds | Passed | section 6 |

**Evidence paths:** `e2e/`, `test/`, `scripts/verify-prod.mjs`. Screenshots go to the git-ignored `e2e/screenshots/` on the build machine.

## 6. Deployment and Infrastructure

| Item | Value |
|---|---|
| Branch | `main` |
| Last application commit | `b82d7cf5cbd33bed6f7773107eabc673a9c6b3dc` |
| Workers Builds | Success, build `f054a599-5c68-42f1-825a-fe50ffeedfed` |
| Deployed version check | `/api/health` returned this commit, with `source: workers-builds` and `branch: main` |
| Custom domain | ai-travel-planner-v1-claude.thebuildhypothesis.com, existing association kept |
| HTTPS | Verified: HTTP redirects with 301, HSTS present |

The commit that adds this report changes only documentation, so it cannot name its own SHA. Its build result is in the final response.

**Resources**

| Name | Type | Action |
|---|---|---|
| `ai-travel-planner-claude` | Worker | Existing. Code deployed, D1 binding repointed, daily cron trigger added (the job is tested with mocks; its scheduled run in production has not been observed) |
| `bh-travel-v1-claude-claude-db` (`79aa89be-91d5-493f-b115-43bfce80c764`) | D1 | Created |

**Migrations:** `0001_init.sql` applied to production.

**Bindings checked after deployment:** `APP_PUBLIC_URL`, `ASSETS`, `DB` (new database), `EMAIL`, `EMAIL_FROM`, `GOOGLE_MAPS_API_KEY` (secret), `LLM_MODEL`, `LLM_PROVIDER`, `OPENAI_API_KEY` (secret). All administrator-managed values were preserved.

**Before this build,** the Worker's `DB` binding pointed at a database (`f0ebeb80-...`) that no longer appears in the account. Other `bh-travel-*` databases belong to other runs and were not touched.

## 7. Integrations and Configuration

| Integration | Status | Detail |
|---|---|---|
| LLM | Verified in production | `openai` / `gpt-4o-mini`, read from runtime configuration. The value was read through the API as a plain-text variable. No secret values were retrieved |
| Google Places | Verified in production | Text Search and Place Photos. Key stays server-side |
| Map | Verified in production | Leaflet with OpenStreetMap. Google Maps is not used for display |
| Cloudflare Email Service | Verified in production | `EMAIL` binding, sender from `EMAIL_FROM`. Real verification and reset emails received |

**Testing note:** real email was read through a public disposable inbox service (Guerrilla Mail), because no project inbox was available and no personal address should be used. Only throwaway test accounts were involved, with single-use links. `mail.tm` was tried first, but TLS connections to it were reset from this machine.

**Missing configuration:** none.

## 8. Security Review

| Area | Implementation | Evidence |
|---|---|---|
| Passwords | scrypt, N=2^15, per-password salt | Production and mocked |
| Sessions | Random tokens, only hashes stored, HttpOnly, Secure, `__Host-` | Production and mocked |
| Guest ownership | Owner in every trip query; another owner's trip returns 404 | Production and mocked |
| Cross-user access | 10 trip operations return 404 | Mocked, for users. Production, for guests |
| Admin separation | Separate tables, cookie (SameSite=Strict) and session lifetime | Production and mocked |
| CSRF | Origin and Sec-Fetch-Site checks, JSON only, SameSite | Production and mocked |
| Rate limits | Login, registration, reset, resend, admin login, AI and Places | Mocked. Admin lockout also observed locally |
| Enumeration | Identical login, registration and reset responses; a dummy hash equalizes login time | Mocked. Timing was not measured |
| Reset and verification tokens | Hashed, expiring, single-use, consumed atomically | Production and mocked |
| Injection | Parameterized SQL, allowlisted sort columns, escaped LIKE; model text rendered as text, never HTML | Mocked |
| Secrets | Scrubbed from usage records; key sent in headers, never to the client | Mocked; repository scan clean |
| Headers | Strict CSP, HSTS, nosniff, frame denial | Production |
| Audit | Append-only, enforced by database triggers | Production and mocked |

**Known risks and things not tested**
- No third-party penetration test or independent security review was done.
- The bootstrap window on a fresh database. See section 10.
- The CSP allows `'unsafe-inline'` for styles because Leaflet needs it. Scripts are restricted to the site and Cloudflare's analytics beacon.
- The zone injects Cloudflare Web Analytics, so its beacon is allowed in the CSP. Turning it off is a zone setting.
- Response-time differences that could reveal accounts were designed against but not measured.
- A deleted user's trip titles can remain as labels on usage records. Usage records hold no email.

## 9. Usage, Costs, and Estimates

**Measured (production, near the end of verification)**

| | Requests | Tokens or units |
|---|---|---|
| LLM | 67 | 75,017 input, 34,581 output |
| Google Places | 146 billable | 146 |

**Calculated from list prices, not invoices**

| | Estimated cost (USD) |
|---|---|
| LLM | $0.03 |
| Google Places | $4.91 |
| Production total | $4.94 |
| Local testing with real APIs | $1.35 |

**Sample validated calculation.** One production LLM record: 881 input tokens, 0 cached, 833 output tokens. (881 × $0.15 + 833 × $0.60) / 1,000,000 = **$0.00063195**, which matches the stored value. `verify-prod.mjs` recalculates every LLM row for its test trip from the row's own pricing snapshot, and the largest difference was about 1e-19.

**Rates:** gpt-4o-mini at $0.15, $0.075 cached and $0.60 per 1M tokens. Text Search Enterprise at $35 and Photos at $7 per 1,000 requests. These are list prices checked on 2026-11-05 through secondary and Google sources, and are configurable. Sources disagreed on the Text Search Pro price, which this app does not use. Google's free monthly usage is not applied, so real Places bills may be lower.

**Unknown**

| Item | Value |
|---|---|
| Actual provider invoices | Unknown |
| Cloudflare and email charges | Unknown |
| Tokens and cost of the agent building this | Unknown; not available to the agent |

## 10. Known Bugs, Limitations, and Incomplete Work

| Severity | Issue | Impact | Workaround or fix |
|---|---|---|---|
| Medium | **Google Places content on a non-Google map.** Google's terms restrict displaying Places content on non-Google maps. Verified coordinates are shown on OpenStreetMap, because the only Google key is a server-side secret that must not reach the browser. | Possible terms issue for commercial use. No user-visible defect. | Get a browser-restricted Maps JavaScript key and use Google Maps, or use a non-Google geocoder for pins. Review the terms. |
| Medium | **Places dominates API cost.** Each verified stop is a $0.035 lookup, against about $0.0005 per LLM call. Measured: $4.91 of $4.94 in production. A 5-day plan with 25 uncached stops is about $0.88. | Spend grows quickly with traffic. The $25 daily cap would be reached at roughly 28 such plans, after which AI requests pause for everyone. | Verify lazily when a stop is opened, or request a cheaper field mask without hours and ratings. Tune the cap before launch. |
| Medium | **Bootstrap window on a fresh deployment.** Until the password is changed, anyone who knows the documented default could complete the forced change first. This is inherent to the required admin/admin bootstrap. | On this deployment, closed within minutes of first going live. Applies again to any new database. | Run scripts/activate-admin.mjs as part of provisioning. |
| Low | **Long-distance drag not confirmed.** Dragging a stop from the bottom to the top of a long day did not reorder under Playwright, which may be a limit of its synthetic drag rather than the app. Adjacent drag passes. Touch drag is not implemented. | Arrow buttons and the Day field in Edit work on all devices. | Test by hand, and add an accessible reorder library if it reproduces. |
| Low | **Model output quality varies.** gpt-4o-mini sometimes writes pseudo-stops such as "Travel to Ryoan-ji", overly optimistic costs, or coordinates tens of km off. Unmatched stops keep those coordinates, shown as dashed approximate pins. | Occasional awkward stops. All are labeled and editable. | Filter transport stops, or try a stronger model through LLM_MODEL (add a rate in Settings). |
| Low | **Google place types can look odd.** Google labeled tofu restaurants in Kyoto as "Korean Restaurant" in one result. The label is shown as Google returned it. | Cosmetic. | Hide the type label on cards if this proves common. |
| Low | **Email address cannot be changed.** Account settings cover name, default currency and password. | Users must contact support, and no support route exists. | Add a re-verified email change flow. |
| Low | **Disconnect during generation.** If the browser disconnects, the Worker has only a short grace period to finish. Completed days of a first build are saved. The trip lock clears on completion or within 3 minutes. | A rare lost reply, and possibly a brief "still working" state. | Move generation to a Cloudflare Workflow or Durable Object. |
| Low | **Fixed-window rate limits.** Counters reset on window boundaries, so a burst across a boundary can reach about twice a limit. The cost cap is checked when a request starts, so it can overshoot slightly. | Small overspend at worst. | Use sliding windows if abuse appears. |
| Low | **Admin login limit counts successes.** Five login attempts per 15 minutes per address and username includes successful ones. This was hit during testing. | An administrator logging in repeatedly can wait up to 15 minutes. | Count only failures if this is a nuisance. |
| Low | **OpenStreetMap public tiles.** The public tile servers are not intended for heavy use. | Tiles could be throttled under real traffic. | Switch to a commercial tile provider. |
| Low | **Test data in production.** Verification left guest trips and test accounts in production, which appear in the dashboard and cost totals. Test accounts use disposable inbox addresses. | Totals include about $4.94 of test usage. | Delete them under Users, or clear the tables before launch. |
| Info | **CJK glyphs in test screenshots.** Headless Chromium on this machine has no CJK fonts, so some Japanese address text appeared as boxes. Real devices should fall back to system fonts, but this was not checked. | Expected to affect only this test environment. | Check on a real device. |

**Reproduction for the drag issue:** on a day with six or more stops, drag the last stop to the top of the list.

**Requirements with incomplete verification:** see the Partial and Implemented but Unverified rows in section 2.

## 11. Agent Execution Summary

**Observed:** started 2026-11-05T22:28:20Z. This report was generated at 2026-11-05T23:53:45Z, about 85 minutes in. No human interventions occurred.

| Time (UTC) | Milestone |
|---|---|
| 22:28 | Inspected the repository, environment and Cloudflare account |
| 22:32 | Created the D1 database |
| 22:54 | Backend test suite passing |
| 23:06 | First client build |
| 23:09 | First real end-to-end run against OpenAI and Places |
| 23:11 | First push; Workers Build succeeded |
| 23:13 | Production bootstrap password replaced |
| 23:44 | Last application code deployed |
| 23:49 | Final production checks passed |
| 23:53 | Cleanup job test added, 236 tests passing |

**Major decisions:** treated the earlier reverted implementation as off limits and built from scratch; its code in git history was not read. See section 3 for design decisions.

**Bugs found by testing, then fixed**

| Bug | Found by |
|---|---|
| Deleting an admin who had a session falsely reported "last administrator", because D1 counts cascaded rows | Mocked test |
| A closed venue was marked verified | Reading real output |
| The model invented a start date from "April" | Reading real output |
| Replacement stops could duplicate existing ones | Reading real output |
| Stops scheduled back to back with no travel time | Reading real output |
| CSP blocked the zone's analytics beacon | Production browser test |
| A hand-added stop with no place was labeled as an AI suggestion | Production browser test |
| The app jumped to the map when the model set the flag unprompted | Production browser test |
| Correct Places matches were rejected because the model's coordinates were about 67 km off, leaving famous places labeled as AI suggestions | Reviewing a production screenshot |

Self-review also closed a guest quota bypass (clearing cookies) and over-long trips silently falling back to 3 days.

**Blockers and retries**
- The push of `42e6ea9` was rejected three times by GitHub with `fatal error in commit_refs_rules`. GitHub's status page showed no incident. It went through unchanged after about five minutes, with no change to rules or use of force.
- The first push was rejected because `main` had a new commit (`de443e8`, a small change to `cloudflare.env.example` by the repository owner). It was rebased onto, not overwritten.
- Chromium lacked system libraries here. They were unpacked into a temporary directory, with no system changes.
- Many Playwright failures were mistakes in the tests rather than the app, such as ambiguous selectors. These were corrected individually, and the real bugs above came out of the same process.

## 12. What to Expect During Independent Review

| Feature | Try this | Expect |
|---|---|---|
| Generation | The Tokyo family prompt from the spec | Chat lead-in, then days appearing one by one. About 15-20 s for short trips, more for longer ones |
| Targeted edit | "Replace the museum with something outdoors" | Only that stop changes, and a chip names the change |
| Cost edit | "Make day three less expensive" | Swaps or a rewrite of day 3 only |
| Research | "Find good restaurants near our hotel" | Google cards that can be added to a day. It works best once lodging is known |
| Map | "Show me the itinerary on a map" | Switches to the Map view |
| Undo | Remove a stop, then Undo | The stop returns |
| Verification | Register with a real inbox | Email arrives; login is refused until the link is used |
| Admin lockout | Create an admin, then log in as them | Only the password form is available |
| Costs | Open Usage & costs, then How on any row | The rates and arithmetic behind that row |

**Fragile areas**
- Output varies between runs, because the model is not deterministic.
- Stops the model invents or misnames stay labeled AI suggestion. That is intended.
- Rate limits are real. Guests share 30 AI requests per hour per address, and admin login allows 5 attempts per 15 minutes. If you hit one while testing, wait for the window to reset.
- Dashboard totals include test data from verification.

**Specific checks worth doing by hand**
- A screen reader and keyboard pass, which has not been done.
- A real phone, particularly Japanese text rendering and the map.
- Long-distance drag and drop.
- A full 14-day generation in production. The longest real runs were short trips; 14 days was only tested with mocks.

## 13. Final Assessment and Next Steps

**Demonstrably ready:** the guest and account journeys, real email, Places verification, the map, the admin console and cost reporting, all tested in production.

**Prioritized follow-up**
1. Review Google's terms for Places data on a non-Google map, and decide on map provider.
2. Reduce Places cost per plan, and set the daily cap for expected traffic.
3. Run an accessibility audit and a by-hand pass on real devices.
4. Test a 14-day generation in production, and consider moving generation to a Cloudflare Workflow so it survives disconnects.
5. Clear test data before launch.
6. Add email change and a cleanup route for abandoned guests.
