# Architecture & Design Review

> Engineering reference document. For end-user API call examples see [usage.md](usage.md).

---

## 1. System Overview

Newsletter Processor is a personal backend service that ingests email newsletters, extracts individual articles using a Gemini LLM, and serves them as an RSS feed and JSON API to a reader application. A reader can annotate articles (read status, 1–5 rating, freeform notes) online or offline, with offline changes flushed on reconnect. An on-demand summarisation endpoint fetches the full article text and produces a short executive summary formatted for sharing in Microsoft Teams.

**Runtime:** Google Cloud Run (scale-to-zero, ~6–7 requests/day)  
**Database:** Turso (serverless libSQL / SQLite)  
**LLM:** Google Gemini 2.5 Flash Lite  
**Email ingest:** CloudMailin webhook  

---

## 2. Architecture

```
                     ┌─────────────┐
  Newsletter email   │ CloudMailin │
  ──────────────────▶│  (inbound)  │
                     └──────┬──────┘
                            │ POST /webhook/cloudmailin
                            ▼
               ┌────────────────────────┐
               │   Newsletter Processor │
               │   (Cloud Run, Node.js) │
               │                        │
               │  src/api/server.ts     │
               │  src/llm/parser.ts     │
               │  src/db/database.ts    │
               │  src/rss/generator.ts  │
               └──────┬─────────┬───────┘
                      │         │
           LLM calls  │         │  DB reads/writes
                      ▼         ▼
               ┌────────┐  ┌─────────┐
               │ Gemini │  │  Turso  │
               │  API   │  │ libSQL  │
               └────────┘  └─────────┘
                      │         │
               ┌──────┴─────────┴───────┐
               │      Reader App        │
               │  GET  /articles        │
               │  GET  /rss             │
               │  GET  /summarize/:id   │
               │  PATCH /articles/:id   │
               │  POST /articles/updates│
               └────────────────────────┘

  No-article emails (optional):
               ┌────────────────────────┐
               │   Newsletter Processor │──▶ CloudMailin (outbound)
               └────────────────────────┘    ──▶ review mailbox
```

### Component responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| Entry point | `src/index.ts` | Initialises DB, starts Express server |
| API server | `src/api/server.ts` | All HTTP routes, CORS, auth |
| Config | `src/config.ts` | Zod env-var validation at startup |
| Database | `src/db/database.ts` | Turso client, schema, all queries |
| LLM parser | `src/llm/parser.ts` | Gemini calls for extraction and summarisation |
| RSS generator | `src/rss/generator.ts` | Builds RSS 2.0 XML from article rows |

---

## 3. User Journeys

### Journey 1 — Newsletter arrives (4–5 times/day)

```
Newsletter sender
      │
      │  email
      ▼
  CloudMailin ──── POST /webhook/cloudmailin?secret=<S> ────▶ server.ts
                                                                    │
                                                          parse envelope.from
                                                          parse headers.Date
                                                          extract html/plain body
                                                                    │
                                                                    │  if no body ──▶ 400
                                                                    ▼
                                                          extractArticles(body)  [parser.ts]
                                                          Gemini 2.5 Flash Lite
                                                          structured JSON output
                                                          retries: up to 4×
                                                          backoff: 2s→4s→8s→16s
                                                          max wait: ~30s per retry
                                                                    │
                                              ┌─────────────────────┴──────────────────────┐
                                              │ articles.length === 0                      │ articles found
                                              ▼                                            ▼
                                  (optional) forward email                    insertNewsletter()
                                  to review mailbox via                       insertArticle() × N
                                  CloudMailin outbound                        [database.ts]
                                              │                                            │
                                              └──────────────────┬─────────────────────────┘
                                                                 ▼
                                                          200 response to CloudMailin
```

**Known risk:** CloudMailin's webhook timeout is **30 seconds**. The extraction path with full retries can take up to 2 minutes. If the response arrives after 30 s, CloudMailin marks it failed and retries — causing duplicate newsletter inserts. See [Task #3](#task-list) for the fix.

---

### Journey 2 — Reader browses and annotates (1–2 times/day)

```
Reader App starts
      │
      │  GET /articles?secret=<S>&limit=30
      ▼
  server.ts ──▶ getLatestArticles(30) ──▶ Turso
                                               │
                                               ▼
                              JSON array (id, title, summary, url,
                              status, rating, notes, timestamps, ...)
                                               │
                                               ▼
                                         Reader App renders list

  User action (online):
      │
      │  PATCH /articles/:id?secret=<S>
      │  { status, rating, notes }  (send only changed fields)
      ▼
  server.ts validates ──▶ updateArticle(id, patch) ──▶ Turso
                      ◀── { id, updated_at }

  User action (offline):
      │
      │  write to IndexedDB pendingSync store
      │
  On reconnect:
      │
      │  POST /articles/updates?secret=<S>
      │  [ { id, status }, { id, rating }, ... ]
      ▼
  server.ts ──▶ updateArticles(updates) ──▶ Turso (sequential)
           ◀── { succeeded: [id,...], failed: [{id, error},...] }
      │
      └──▶ remove succeeded IDs from pendingSync
           leave failed IDs for next retry
```

---

### Journey 3 — Article shared to Teams (occasional)

```
Reader App (or RSS reader)
      │
      │  GET /summarize/:id?secret=<S>
      ▼
  server.ts ──▶ getArticleById(id) ──▶ Turso
                                            │
                                            ▼
                                     article.url
                                            │
                                fetch(article.url)        timeout: 15s
                                strip <style>, <script>, HTML tags
                                cap at 100,000 chars
                                            │
                                            ▼
                              summarizeArticleFromUrl()   [parser.ts]
                              Gemini prompt: 2–3 paragraph
                              executive summary for:
                              • Agility Leads
                              • HR Business Partners
                              • Op Model Owners
                              temperature: 0.4
                              retries: up to 4×
                                            │
                                            ▼
                              text/plain response
                                            │
                              User pastes into Microsoft Teams
```

---

## 4. API Endpoints

Full request/response examples: [usage.md](usage.md)

| Method | Path | Purpose | Auth fail |
|--------|------|---------|-----------|
| `GET` | `/articles` | JSON article list (limit ≤ 30) | 401 |
| `GET` | `/rss` | RSS 2.0 feed (limit ≤ 30) | 401 |
| `GET` | `/summarize/:id` | On-demand AI executive summary | 401 |
| `PATCH` | `/articles/:id` | Update status / rating / notes | 403 |
| `POST` | `/articles/updates` | Batch annotation flush | 403 |
| `POST` | `/webhook/cloudmailin` | CloudMailin ingest webhook | 401 |

**Authentication:** all endpoints require `?secret=<RSS_SECRET>` query parameter.

### Data model — articles table

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `newsletter_id` | INTEGER FK | References newsletters.id |
| `title` | TEXT | LLM-extracted |
| `summary` | TEXT | 2–3 sentence LLM summary |
| `url` | TEXT | Primary article link |
| `created_at` | DATETIME | Row insertion time |
| `status` | TEXT | `unread` / `read` / `skipped` (default `unread`) |
| `rating` | INTEGER | 1–5, nullable |
| `notes` | TEXT | Free-form, default `''` |
| `updated_at` | DATETIME | Last change to status/rating/notes |
| `note_updated_at` | DATETIME | Last change to notes specifically |

---

## 5. 12-Factor App Review

| # | Factor | Status | Finding |
|---|--------|--------|---------|
| I | Codebase | ✅ Pass | Single repo, git tracked |
| II | Dependencies | ⚠️ Partial | `@google/genai: "latest"` is unpinned — a breaking SDK change could silently break production at next deploy |
| III | Config | ⚠️ Partial | Env vars validated with Zod at startup (good). But schema migrations run inside `initDb()` on every startup, conflating the run stage with release-time schema work. `.env` is present in the repo — should be `.env.example` only |
| IV | Backing services | ⚠️ Partial | Turso URL/token come from config (good). The `db` client (`database.ts:4`) and `ai` client (`parser.ts:5`) are both instantiated at module load time, which makes test doubles require module-level mocking rather than injection |
| V | Build / release / run | ⚠️ Partial | Multi-stage Dockerfile correctly separates build from run. Schema migrations inside `initDb()` should instead be a discrete release step |
| VI | Processes | ✅ Pass | Stateless Express server — no in-process article state |
| VII | Port binding | ✅ Pass | `PORT` from config, `EXPOSE 8080` in Dockerfile |
| VIII | Concurrency | ⚠️ Partial | Cloud Run can scale to N instances. Concurrent cold-starts each run `initDb()` migrations; the try/catch on "duplicate column" prevents hard failures but the design is not concurrent-migration-safe |
| IX | Disposability | ❌ Fail | No `SIGTERM` handler. Cloud Run sends `SIGTERM` before terminating an instance; in-flight LLM requests (up to 2 min with retries) are cut off mid-flight. No graceful drain. |
| X | Dev/prod parity | ⚠️ Partial | `ts-node` in dev vs compiled JS in prod is acceptable. `package.json` description still says "via POP3" (stale). No `.env.example` file |
| XI | Logs | ⚠️ Partial | Writes to stdout via `console.log/error` (correct direction). Logs are unstructured plain text with emoji prefixes — Cloud Logging prefers structured JSON (`{"severity":"INFO","message":"..."}`) for filtering and alerting |
| XII | Admin processes | ❌ Fail | `initDb()` schema migration runs on every server start. A migration should be a one-off, idempotent admin command (`npm run migrate`) executed once per deployment, not embedded in the boot path |

**Score: 2 pass, 7 partial, 2 fail** out of 12 factors.

---

## 6. API Design Review

### Issues

| Issue | Severity | Detail |
|-------|----------|--------|
| Secret in query string | **High** | `?secret=<SECRET>` appears in Cloud Run access logs, browser history, CloudMailin callback config, and the RSS `<comments>` URLs. Use `Authorization: Bearer <token>` or `X-API-Key: <key>` header instead |
| RSS secret embedded in feed | **High** | Every `<comments>` element contains `/summarize/:id?secret=<SECRET>`. Any RSS reader that logs or indexes item metadata leaks the secret. Decouple: either drop the summarise link from the feed or use a separate read-only token |
| Webhook timeout / duplicate ingest | **High** | CloudMailin's webhook timeout is 30 s. LLM extraction with 4 retries can exceed 2 min. On timeout CloudMailin retries the delivery → duplicate newsletter rows. Fix: respond `202 Accepted` immediately and process asynchronously (see §7) |
| Inconsistent auth error codes | Medium | `/rss` and `/summarize` return `401`; `/articles/:id` and `/articles/updates` return `403`. Use `401` consistently (no authenticated session exists) |
| Inconsistent error body shape | Medium | Webhook uses `{status, message}`, reader endpoints use `{error}`. Standardise to one shape, e.g. `{"error": {"code": "NOT_FOUND", "message": "..."}}` |
| Verb in resource URL | Low | `GET /summarize/:id` uses a verb. REST convention: `GET /articles/:id/summary` |
| Hardcoded limit cap | Low | `Math.min(parsedLimit, 30)` with no documentation or override. As the archive grows (30 articles ≈ 6–8 newsletters) readers will need a larger window |
| No pagination | Low | `limit` only — no offset or cursor-based pagination |
| CORS wildcard | Low | `Access-Control-Allow-Origin: *` is fine for a personal tool; prevents credentialed requests if authentication is ever upgraded |
| No API versioning | Low | No `/v1/` prefix or version header. Low risk for a personal tool but makes future breaking changes harder to coordinate |
| Batch endpoint naming | Low | `POST /articles/updates` is non-standard. `PATCH /articles` (with array body) is closer to REST convention |

---

## 7. Redesign Proposal — Cloud Functions Decomposition

### Cost context

At 4–5 webhook calls/day and 1–2 feed reads/day, Cloud Run with scale-to-zero and Cloud Functions 2nd gen have **identical cost** at this scale — both land in the free tier or cost pennies/month. The case for decomposition is **operational**, not financial.

### Why decompose?

| Concern | Current (single Cloud Run) | Decomposed (Cloud Functions) |
|---------|--------------------------|------------------------------|
| Request timeout | One setting for all endpoints | Each function sets its own timeout |
| LLM outage blast radius | All endpoints return 500 | Only `ingest` and `summarize` are affected; `reader-api` continues |
| Deployment coupling | Updating the summarise prompt redeploys everything | Deploy `summarize` only |
| Webhook timeout bug | LLM work blocks HTTP response; CloudMailin retries | `ingest` responds in <1 s; worker runs independently |
| Observability | All logs mixed in one service | Per-function log streams and dashboards |

### Proposed function map

| Function | HTTP trigger | Endpoints | Max timeout |
|----------|-------------|-----------|-------------|
| `ingest` | POST | `/webhook/cloudmailin` — validates, stores raw payload, enqueues Cloud Task, responds `202` | 30 s |
| `ingest-worker` | Cloud Tasks | (internal) — runs `extractArticles` + DB write | 540 s |
| `reader-api` | GET / PATCH / POST | `/articles`, `/rss`, `/articles/:id`, `/articles/updates` | 60 s |
| `summarize` | GET | `/articles/:id/summary` | 540 s |

### Async ingest flow

```
CloudMailin
    │  POST /webhook/cloudmailin
    ▼
ingest function                          responds 202 in < 1 s
    │  enqueue Cloud Task
    ▼
Cloud Tasks queue
    │  (retries built in, deduplication window configurable)
    ▼
ingest-worker function
    │  extractArticles(body)             up to 2 min with retries
    │  insertNewsletter()
    │  insertArticle() × N
    ▼
Turso DB
```

This eliminates the duplicate-ingest bug entirely: CloudMailin gets its `202` within a second, and Cloud Tasks handles retry logic independently with configurable deduplication.

### Shared code structure

```
newsletter-processor/
├── packages/
│   ├── shared/          ← db/database.ts, config.ts, types
│   ├── ingest/          ← webhook handler, Cloud Task enqueue
│   ├── ingest-worker/   ← extractArticles + DB write
│   ├── reader-api/      ← GET /articles, GET /rss, PATCH, POST batch
│   └── summarize/       ← fetch URL + Gemini summary
├── package.json         ← npm workspaces root
└── cloudbuild.yaml      ← build + migrate + deploy all functions
```

Each package imports `@newsletter/shared` locally. Turso and Gemini remain unchanged — both are stateless HTTP services with no connection pool concerns.

### Migration path (least disruption first)

| Step | Change | Risk |
|------|--------|------|
| 1 | Add `SIGTERM` handler + structured JSON logging | Minimal — no behaviour change |
| 2 | Pin `@google/genai` to an exact version | Minimal |
| 3 | Move `initDb()` to `npm run migrate`, run in Cloud Build | Low — needs Cloud Build yaml update |
| 4 | Add `.env.example`, remove `.env` from repo | Minimal |
| 5 | Extract `packages/shared` from current `src/` | Medium — repo restructure, no logic change |
| 6 | Deploy `ingest` + `ingest-worker` as Cloud Functions | Medium — fixes the timeout bug, requires Cloud Tasks setup |
| 7 | Deploy `summarize` as Cloud Function | Low — independent long-timeout endpoint |
| 8 | Optionally migrate `reader-api` to Cloud Function | Low — already fast, Cloud Run is fine here |

---

## 8. Task List

Prioritised list of improvements identified in this review. Items marked **quick win** can be done in the current monolith with no architectural change.

### High priority

- [ ] **Fix webhook duplicate-ingest bug** — respond `202 Accepted` to CloudMailin immediately, move LLM extraction + DB write to an async worker (Cloud Tasks or, short-term, a background `Promise` that doesn't block the response). *(See §7)*
- [ ] **Move the secret out of the query string** — switch all endpoints from `?secret=` to an `Authorization: Bearer` or `X-API-Key` header. Update CloudMailin webhook callback URL and the reader app accordingly. *(§6)*
- [ ] **Remove the secret from RSS `<comments>` URLs** — either strip the summarise link from the feed or introduce a separate read-only token that can only call `/summarize`. *(§6)*

### Medium priority

- [ ] **Add `SIGTERM` graceful shutdown** *(quick win)* — register `process.on('SIGTERM', ...)` in `src/index.ts`; call `server.close()` and allow in-flight requests a drain window before `process.exit(0)`. *(Factor IX)*
- [ ] **Switch to structured JSON logging** *(quick win)* — replace `console.log/error` with a thin wrapper that writes `{"severity":"INFO","message":"...","data":{...}}` to stdout. Improves Cloud Logging filtering and alerting. *(Factor XI)*
- [ ] **Pin `@google/genai` to an exact version** *(quick win)* — change `"latest"` to the current installed version in `package.json`. *(Factor II)*
- [ ] **Move `initDb()` migrations to a release step** — add `"migrate": "ts-node src/db/migrate.ts"` script and call it from `cloudbuild.yaml` before deploying. Remove migration code from the server boot path. *(Factor XII)*
- [ ] **Standardise auth error codes** *(quick win)* — all endpoints should return `401` (not `403`) when the secret is wrong or missing. *(§6)*
- [ ] **Standardise error response shape** *(quick win)* — agree on one format (`{error: string}` or `{status, message}`) and apply it consistently across all endpoints. *(§6)*
- [ ] **Raise the article limit cap** — the hardcoded 30-article ceiling will hit readers with more than ~6 newsletters. Make it configurable (e.g. max 200, with a default of 50). *(§6)*

### Low priority / housekeeping

- [ ] **Add `.env.example`** *(quick win)* — commit a template with placeholder values; add `.env` to `.gitignore` if not already there. *(Factor X)*
- [ ] **Update `package.json` description** *(quick win)* — remove the stale "via POP3" text. *(Factor X)*
- [ ] **Rename `GET /summarize/:id`** — to `GET /articles/:id/summary` for REST consistency. Coordinate with reader app and RSS feed `<comments>` URLs. *(§6)*
- [ ] **Add cursor-based pagination** to `GET /articles` — offset pagination is fine for a personal archive of a few thousand articles, but a `?after=<id>` cursor is simpler to implement correctly in libSQL. *(§6)*
- [ ] **Evaluate Cloud Functions decomposition** — follow the migration path in §7 when the operational benefits (independent timeouts, per-function deployments) become worthwhile. Start with `ingest-worker` to fix the timeout bug. *(§7)*
