# Newsletter Processor Service

A Cloud Run backend service that receives newsletter emails via CloudMailin, extracts articles using Gemini 1.5 Flash, stores them in Turso (libSQL), and serves them via a JSON API and RSS feed.

## Stack
- Node.js & TypeScript
- Express.js
- Google Gen AI SDK (`gemini-1.5-flash`)
- Turso (libSQL for serverless SQLite)
- CloudMailin (email-to-webhook delivery)
- Google Cloud Tasks (async email processing)
- Docker / Google Cloud Run

## Architecture

Email arrives at CloudMailin, which POSTs it to the ingest webhook. The webhook validates the secret, enqueues the payload to Cloud Tasks, and immediately returns `202` — keeping well within CloudMailin's 30-second timeout. The ingest worker then runs independently to extract articles and write them to the database.

```
Newsletter email
      │
      ▼
  CloudMailin ──── POST /webhook/cloudmailin?secret=<S> ────▶ ingest function
                                                                      │
                                                              enqueue Cloud Task
                                                              respond 202
                                                                      │
                                                                      ▼
                                                              Cloud Tasks queue
                                                                      │
                                                                      ▼
                                                             ingest-worker function
                                                             extractArticles() via Gemini
                                                             insertNewsletter() + insertArticle()×N
                                                                      │
                                                          ┌───────────┴────────────┐
                                                          │ no articles found      │ articles stored
                                                          ▼                        ▼
                                                  forward to review          Turso (libSQL)
                                                  mailbox (CloudMailin               │
                                                  outbound)                          ▼
                                                                             reader-api / summarize
                                                                             functions serve
                                                                             GET /articles
                                                                             GET /rss
                                                                             PATCH /articles/:id
                                                                             GET /articles/:id/summary
```

### Cloud Functions

| Function | Trigger | Responsibility |
|----------|---------|----------------|
| `ingest` | HTTP POST from CloudMailin | Validates secret, enqueues to Cloud Tasks, returns 202 |
| `ingest-worker` | Cloud Tasks | Runs LLM extraction, writes newsletter + articles to DB |
| `reader-api` | HTTP (GET/PATCH/POST) | Serves articles JSON, RSS feed, batch updates |
| `summarize` | HTTP GET/POST | On-demand AI summaries, article caching to GCS |

---

## Local Development Setup

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment:**
   Copy `.env.example` to `.env` and fill in the values:
   - Gemini API Key.
   - Turso DB URL and Auth Token.
   - RSS\_SECRET (used for the CloudMailin webhook URL and as the RSS reader fallback secret).
   - Cloud Tasks queue config and ingest worker URL.

3. **Run locally:**
   ```bash
   npm run dev
   ```

---

## API

### Authentication

The preferred method is the `X-Api-Key` request header:

```
X-Api-Key: <SECRET>
```

A `?secret=<SECRET>` query parameter is also accepted as a fallback — this exists because RSS readers cannot set custom headers. The CloudMailin webhook uses `?secret` in the target URL for the same reason (CloudMailin sets the URL, not request headers).

All values are validated against `RSS_SECRET` from the environment.

---

### Quick reference

| Method  | Path                            | Auth                  | Purpose                                  |
|---------|---------------------------------|-----------------------|------------------------------------------|
| `POST`  | `/webhook/cloudmailin`          | `?secret` in URL      | Receive inbound email from CloudMailin   |
| `GET`   | `/articles`                     | Header or `?secret`   | List articles as JSON                    |
| `GET`   | `/rss`                          | Header or `?secret`   | List articles as RSS 2.0                 |
| `PATCH` | `/articles/<id>`                | Header or `?secret`   | Update status, rating, or notes          |
| `POST`  | `/articles/updates`             | Header or `?secret`   | Batch update (offline flush)             |
| `GET`   | `/summarize/<id>`               | Header or `?secret`   | AI executive summary (plain text)        |
| `GET`   | `/articles/<id>/summary`        | Header                | AI summary (structured)                  |
| `GET`   | `/articles/<id>/describe`       | Header                | AI description + suggested tag           |
| `POST`  | `/articles/<id>/cache`          | Header                | Cache article HTML to GCS                |
| `GET`   | `/articles/<id>/cached-content` | Header or `?secret`   | Retrieve cached HTML                     |

---

### Email ingestion webhook

CloudMailin posts inbound emails here. The secret is embedded in the target URL configured in CloudMailin.

```
POST <BASE_URL>/webhook/cloudmailin?secret=<SECRET>
```

The request is accepted immediately and queued to Cloud Tasks for async processing. Response `202 { "status": "accepted" }`.

---

### List articles (JSON)

Returns the most recent articles, newest newsletter first, articles within each newsletter in original order.

```
GET <BASE_URL>/articles
GET <BASE_URL>/articles?limit=10
GET <BASE_URL>/articles?updated_since=2026-05-01T00:00:00.000Z
```

**Query parameters**

| Parameter       | Type            | Default | Max | Description                                        |
|-----------------|-----------------|---------|-----|----------------------------------------------------|
| `limit`         | integer         | 50      | 200 | Number of articles to return.                      |
| `updated_since` | ISO 8601 string | —       | —   | Return only articles updated after this timestamp. |

**Response** `200 application/json` — array of article objects:

```json
[
  {
    "id": 423,
    "newsletter_id": 17,
    "title": "The compliance angle on token storage",
    "summary": "An overview of current legal requirements around session token handling...",
    "url": "https://example.com/articles/token-storage",
    "article_created_at": "2026-05-09T11:00:00.000Z",
    "newsletter_name": "Security Weekly <newsletter@secweekly.com>",
    "received_at": "2026-05-09T10:45:00.000Z",
    "status": "unread",
    "rating": null,
    "notes": "",
    "updated_at": null,
    "note_updated_at": null
  }
]
```

**Article fields**

| Field                | Type                    | Description                                              |
|----------------------|-------------------------|----------------------------------------------------------|
| `id`                 | integer                 | Unique article ID.                                       |
| `newsletter_id`      | integer                 | ID of the newsletter this article came from.             |
| `title`              | string                  | Article title extracted by the LLM.                     |
| `summary`            | string                  | 2–3 sentence summary extracted by the LLM.              |
| `url`                | string                  | Primary article URL.                                     |
| `article_created_at` | ISO 8601 string         | When the article was stored.                             |
| `newsletter_name`    | string                  | Sender name / address of the source newsletter.          |
| `received_at`        | ISO 8601 string         | When the newsletter email arrived.                       |
| `status`             | string                  | Read state: `"unread"`, `"read"`, or `"skipped"`.        |
| `rating`             | integer or null         | Personal rating 1–5, or `null` if not rated.            |
| `notes`              | string                  | Free-form personal notes. Empty string if none.          |
| `updated_at`         | ISO 8601 string or null | When status, rating, or notes were last changed.         |
| `note_updated_at`    | ISO 8601 string or null | When notes were last written.                            |

---

### RSS feed

Returns the same articles as RSS 2.0, suitable for any RSS reader. Each item includes a `<comments>` link pointing to the summarise endpoint.

```
GET <BASE_URL>/rss
GET <BASE_URL>/rss?limit=10
GET <BASE_URL>/rss?secret=<SECRET>
```

Parameters and limits are identical to the JSON endpoint. Use `?secret` when your RSS reader cannot set the `X-Api-Key` header.

---

### AI-generated summary

Fetches the full article from its URL, sends it to Gemini, and returns a short executive summary written for a senior leadership audience. Generated on demand — not cached.

```
GET <BASE_URL>/summarize/<id>
```

**Response** `200 text/plain` — two or three plain-text paragraphs.

**Structured endpoints** (header auth only):

```
GET <BASE_URL>/articles/<id>/summary     — structured summary response
GET <BASE_URL>/articles/<id>/describe    — description + suggested tag
POST <BASE_URL>/articles/<id>/cache      — cache article HTML to GCS
GET <BASE_URL>/articles/<id>/cached-content  — retrieve cached HTML
```

**Error responses**

| Status | Meaning                                                        |
|--------|----------------------------------------------------------------|
| `400`  | ID is not a positive integer.                                  |
| `401`  | Wrong or missing secret.                                       |
| `404`  | No article with that ID exists.                                |
| `500`  | Article page could not be fetched, or LLM call failed.         |

---

### Update a single article

Records how you engaged with an article — mark it read, rate it, or add notes. All fields are optional; send only what changed.

```
PATCH <BASE_URL>/articles/<id>
Content-Type: application/json
```

**Request body:**

```json
{
  "status": "read",
  "rating": 4,
  "notes": "Good overview. Follow up on the token storage point."
}
```

**Field rules**

| Field    | Type            | Accepted values                               |
|----------|-----------------|-----------------------------------------------|
| `status` | string          | `"unread"` \| `"read"` \| `"skipped"`         |
| `rating` | integer or null | `1`–`5`. Send `null` to clear.                |
| `notes`  | string          | Any text. Send `""` to clear.                 |

A body with no recognised fields returns `400`.

**Success response** `200`:

```json
{
  "id": 423,
  "updated_at": "2026-05-09T14:32:00.000Z"
}
```

**Error responses**

| Status | Meaning                                         |
|--------|-------------------------------------------------|
| `400`  | Validation error, or no recognised fields sent. |
| `403`  | Wrong or missing secret.                        |
| `404`  | No article with that ID exists.                 |

---

### Batch update (offline flush)

Sends multiple article updates in a single request. Designed for flushing a local pending-sync queue when coming back online. Each item is processed independently — partial failures are allowed.

```
POST <BASE_URL>/articles/updates
Content-Type: application/json
```

**Request body** — array of update objects, each requiring `id`:

```json
[
  { "id": 423, "status": "read", "rating": 4 },
  { "id": 407, "status": "skipped", "notes": "" },
  { "id": 391, "rating": null }
]
```

Field rules per item are the same as the single-update endpoint. Items with non-integer or non-positive `id` values are silently dropped. Invalid `rating` values are coerced to `null` rather than rejecting the whole batch.

**Response** `200`:

```json
{
  "succeeded": [423, 407],
  "failed": [
    { "id": 391, "error": "Article not found" }
  ]
}
```

Remove only the `succeeded` IDs from your local queue; leave `failed` IDs for retry.

**Error responses**

| Status | Meaning                   |
|--------|---------------------------|
| `400`  | Body is not a JSON array. |
| `403`  | Wrong or missing secret.  |

---

## Offline sync pattern

1. **Online** — call `PATCH /articles/<id>` immediately after any user action (fire-and-forget).
2. **Offline** — write the update to a local `pendingSync` store (IndexedDB or similar).
3. **On reconnect** — flush the queue with `POST /articles/updates`, then remove the `succeeded` IDs from the local store.

---

## Deployment to Google Cloud Run

1. **Build and Submit Docker Image:**
   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/newsletter-processor
   ```

2. **Deploy to Cloud Run:**
   Set the service to **Require Authentication** so it is not publicly exposed.
   ```bash
   gcloud run deploy newsletter-processor \
     --image gcr.io/YOUR_PROJECT_ID/newsletter-processor \
     --region us-central1 \
     --no-allow-unauthenticated \
     --set-env-vars="GEMINI_API_KEY=...,TURSO_DATABASE_URL=...,TURSO_AUTH_TOKEN=...,RSS_SECRET=...,INGEST_WORKER_URL=...,TASKS_QUEUE=..."
   ```

3. **Configure CloudMailin:**
   Point your CloudMailin target URL at:
   ```
   https://YOUR_CLOUD_RUN_URL/webhook/cloudmailin?secret=<RSS_SECRET>
   ```
