# API Usage Guide

All endpoints require a `secret` query parameter. Requests with a missing or incorrect secret are rejected with `401` or `403`.

Replace `<SECRET>` with your `RSS_SECRET` value and `<BASE_URL>` with the deployed service URL throughout this guide.

---

## Authentication

The secret is passed as a query string parameter on every request:

```
?secret=<SECRET>
```

There is no login flow or token exchange — keep the secret out of client-side source code and logs.

---

## Retrieve articles

### List articles (JSON)

Returns the most recent articles, newest newsletter first, articles within each newsletter in original order.

```
GET <BASE_URL>/articles?secret=<SECRET>
GET <BASE_URL>/articles?secret=<SECRET>&limit=10
```

**Query parameters**

| Parameter | Type    | Default | Max | Description                     |
|-----------|---------|---------|-----|---------------------------------|
| `secret`  | string  | —       | —   | Required. API secret.           |
| `limit`   | integer | 50      | 200 | Number of articles to return.   |

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

| Field              | Type            | Description                                              |
|--------------------|-----------------|----------------------------------------------------------|
| `id`               | integer         | Unique article ID.                                       |
| `newsletter_id`    | integer         | ID of the newsletter this article came from.             |
| `title`            | string          | Article title extracted by the LLM.                     |
| `summary`          | string          | 2–3 sentence summary extracted by the LLM.              |
| `url`              | string          | Primary article URL.                                     |
| `article_created_at` | ISO 8601 string | When the article was stored.                          |
| `newsletter_name`  | string          | Sender name / address of the source newsletter.          |
| `received_at`      | ISO 8601 string | When the newsletter email arrived.                       |
| `status`           | string          | Read state: `"unread"`, `"read"`, or `"skipped"`.        |
| `rating`           | integer or null | Personal rating 1–5, or `null` if not rated.            |
| `notes`            | string          | Free-form personal notes. Empty string if none.          |
| `updated_at`       | ISO 8601 string or null | When status, rating, or notes were last changed. |
| `note_updated_at`  | ISO 8601 string or null | When notes were last written.                   |

---

### RSS feed

Returns the same articles formatted as an RSS 2.0 feed, suitable for any RSS reader.

```
GET <BASE_URL>/rss?secret=<SECRET>
GET <BASE_URL>/rss?secret=<SECRET>&limit=10
```

Parameters and limits are identical to the JSON endpoint. The feed includes a `<comments>` link for each item that points to the summarise endpoint (see below).

---

### Get an AI-generated summary

Fetches the full article from its URL, sends it to Gemini, and returns a short executive summary written for a senior leadership audience. The summary is generated on demand and is not cached — each call makes a live LLM request.

```
GET <BASE_URL>/summarize/<id>?secret=<SECRET>
```

**Response** `200 text/plain` — two or three plain-text paragraphs.

**Error responses**

| Status | Meaning                                  |
|--------|------------------------------------------|
| `400`  | ID is not a positive integer.            |
| `401`  | Wrong or missing secret.                 |
| `404`  | No article with that ID exists.          |
| `500`  | Article page could not be fetched, or LLM call failed. |

---

## Update an article

Use these endpoints to record how you engaged with an article — mark it read, rate it, or add notes. All fields are optional; send only what changed.

### Update a single article

```
PATCH <BASE_URL>/articles/<id>?secret=<SECRET>
Content-Type: application/json
```

**Request body** — include only the fields you want to change:

```json
{
  "status": "read",
  "rating": 4,
  "notes": "Good overview of the compliance angle. Follow up on the token storage point — worth sharing with the security team."
}
```

**Field rules**

| Field    | Type            | Accepted values                                      |
|----------|-----------------|------------------------------------------------------|
| `status` | string          | `"unread"` \| `"read"` \| `"skipped"`               |
| `rating` | integer or null | `1`, `2`, `3`, `4`, or `5`. Send `null` to clear.   |
| `notes`  | string          | Any text. Send `""` to clear. No enforced length limit, but aim for roughly one side of A4. |

All three fields are optional — you can send any combination. A body with no recognised fields returns `400`.

**Success response** `200`:

```json
{
  "id": 423,
  "updated_at": "2026-05-09T14:32:00.000Z"
}
```

**Error responses**

| Status | Meaning                                       |
|--------|-----------------------------------------------|
| `400`  | Validation error, or no recognised fields sent. |
| `403`  | Wrong or missing secret.                      |
| `404`  | No article with that ID exists.               |

---

### Batch update (offline flush)

Sends multiple article updates in a single request. Designed for flushing a local pending-sync queue when the device comes back online. Partial failures are allowed — each item is processed independently.

```
POST <BASE_URL>/articles/updates?secret=<SECRET>
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

Remove only the `succeeded` IDs from your local queue; leave `failed` IDs for retry on the next sync.

**Error responses**

| Status | Meaning                              |
|--------|--------------------------------------|
| `400`  | Body is not a JSON array.            |
| `403`  | Wrong or missing secret.             |

---

## Offline sync pattern

The intended client-side flow:

1. **Online** — call `PATCH /articles/<id>` immediately after any user action (fire-and-forget).
2. **Offline** — write the update to a local `pendingSync` store (IndexedDB or similar).
3. **On reconnect** — flush the queue with `POST /articles/updates`, then remove the `succeeded` IDs from the local store.

---

## Quick reference

| Method  | Path                        | Purpose                              |
|---------|-----------------------------|--------------------------------------|
| `GET`   | `/articles`                 | List articles as JSON                |
| `GET`   | `/rss`                      | List articles as RSS 2.0             |
| `GET`   | `/summarize/<id>`           | AI executive summary for one article |
| `PATCH` | `/articles/<id>`            | Update status, rating, or notes      |
| `POST`  | `/articles/updates`         | Batch update (offline flush)         |
