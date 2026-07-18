# Frontend Spec: Email → Tag Mapping Settings Page

## What this feature does

When the backend processes an inbound newsletter email, it looks up the sender's email address in a mapping table. If a match is found, all articles extracted from that email are automatically tagged with the configured tag — no manual tagging needed.

This settings page is where users manage those mappings: add a new one, change the tag for an existing sender, or delete a mapping.

---

## API Contract

Base URL and auth follow your existing conventions. All endpoints require the `X-Api-Key` header (same key used elsewhere in the app).

---

### GET `/email-tag-mappings`

Returns all configured mappings.

**Response `200`:**
```json
{
  "mappings": [
    {
      "id": 1,
      "email": "governors@newsletter.com",
      "tag": "governors",
      "created_at": "2026-07-18T10:00:00.000Z"
    }
  ]
}
```

---

### POST `/email-tag-mappings`

Create a new mapping, or update the tag for an existing email (upsert — the backend deduplicates on `email`).

**Request body:**
```json
{ "email": "governors@newsletter.com", "tag": "governors" }
```

**Response `201`:**
```json
{
  "mapping": { "id": 1, "email": "governors@newsletter.com", "tag": "governors" }
}
```

**Errors:**
- `400` — email missing or has no `@`, tag is empty
- `401` — missing/wrong API key

---

### DELETE `/email-tag-mappings/:id`

Remove a mapping by its numeric `id`.

**Response:** `204 No Content`

**Errors:**
- `400` — id is not a positive integer
- `404` — mapping not found

---

## Tag slug convention

Tags throughout this app are **lowercase, hyphen-separated slugs**, max 50 characters. Examples: `governors`, `tech-news`, `local-council`. Apply this normalization client-side before submitting: lowercase, replace anything that isn't `a-z 0-9 -` with a hyphen, collapse consecutive hyphens, trim leading/trailing hyphens.

---

## Articles now include `sender_email`

`GET /articles` responses now include a `sender_email: string | null` field on each article (alongside the existing `newsletter_name`). Surface this somewhere on article cards/rows so users can see which address sent a given newsletter — this helps them know what to add a mapping for.

---

## UI: Settings Page — Email Tag Mappings

### Layout

A settings section (or dedicated route) titled **"Email Tag Mappings"** with:

1. **Mappings table** — lists current mappings
2. **Add mapping form** — inline or below the table

---

### Mappings table

| Sender Email | Auto-Tag | Added | Actions |
|---|---|---|---|
| governors@newsletter.com | `governors` | 18 Jul 2026 | Edit · Delete |

- **Sender Email** — display as plain text; non-editable
- **Auto-Tag** — display as a tag chip/badge using the same tag styling used elsewhere in the app
- **Added** — formatted date from `created_at`
- **Actions:**
  - **Edit** — opens an inline edit or small modal to change the tag (re-submits via `POST` with the same email, which upserts)
  - **Delete** — calls `DELETE /email-tag-mappings/:id`; show a confirmation before deleting

Empty state: _"No mappings configured. Add one below to automatically tag articles by sender."_

---

### Add mapping form

Two fields side by side (or stacked on mobile):

- **Sender email** — text input, `type="email"`, placeholder `governors@newsletter.com`
- **Tag** — text input, placeholder `governors`, normalize to slug on blur/submit

**Submit button:** "Add mapping"

On success: clear the form, refresh/prepend the new row in the table.

On error: show inline validation message (e.g. "Enter a valid email address" / "Tag is required").

The `POST` endpoint acts as an upsert, so submitting an existing email just updates its tag — no need for a separate edit endpoint.

---

### Editing an existing mapping

Simplest approach: clicking **Edit** pre-fills the add form (or shows an inline input on the row) with the existing tag. On save, `POST` with the same email overwrites the tag. On cancel, discard.

---

### Delete confirmation

Before calling `DELETE`, show a brief confirmation — either an inline "Are you sure? [Confirm] [Cancel]" below the row, or a small modal/popover. Do not use `window.confirm`.

---

## Surfacing `sender_email` on articles

On article cards or list rows, show the sender email address where relevant so users can identify which address to configure. A small secondary line like:

```
From: governors@newsletter.com
```

This only needs to appear when `sender_email` is non-null. If a mapping already exists for that address, optionally show the mapped tag as a hint (client-side join against the mappings list if you have it cached).

---

## Error & loading states

- Show a loading indicator while fetching mappings on mount
- If the fetch fails, show an error message with a retry option
- Disable the submit button while a `POST` is in flight
- Show per-row loading state while a `DELETE` is in flight

---

## Notes for implementation

- The `id` field on each mapping is the stable identifier to use for `DELETE` — don't use email as the URL param
- Emails are normalized to lowercase by the backend; display them as-is from the API response
- The tag returned from the API is already normalized; display it as-is
- No pagination needed — the mapping list is expected to be small (tens of entries at most)
