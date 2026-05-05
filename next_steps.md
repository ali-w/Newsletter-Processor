# Next Steps: Running and Deploying Newsletter Processor

This guide covers everything you need to do to run the application locally and ultimately deploy it to Google Cloud Run using CloudMailin webhooks.

## 1. Prerequisites and Services Signup

Before running the application, you need to set up the following free-tier external services:

1.  **Google AI Studio (Gemini)**:
    *   **Purpose**: Extracts structured data (articles, summaries, links) from raw email HTML using the Gemini 1.5 Flash model.
    *   **Signup**: Go to [Google AI Studio](https://aistudio.google.com/) and sign in with a Google account.
    *   **API Key**: Click on "Get API Key" in the left sidebar and generate a new key.
2.  **Turso (SQLite Database)**:
    *   **Purpose**: Provides a serverless edge SQLite database to store your newsletters and articles persistently.
    *   **Signup**: Go to [Turso](https://turso.tech/) and sign up.
    *   **Setup**:
        *   Install the Turso CLI: `npm install -g @tursodatabase/cli`
        *   Login: `turso auth login`
        *   Create a database: `turso db create newsletter-db`
        *   Get the Database URL: `turso db show newsletter-db --url`
        *   Generate an Auth Token: `turso db tokens create newsletter-db`
3.  **CloudMailin**:
    *   **Purpose**: Receives incoming emails and POSTs them to your application as JSON.
    *   **Signup**: Go to [CloudMailin](https://www.cloudmailin.com/) and sign up for a free account.
    *   **Setup**: Create a new address and set the "Target URL" to your service's webhook endpoint (see below). Use the "JSON Normalized" payload format.

## 2. Environment Variables (`.env`)

Create a `.env` file in the root directory of the project. Populate it with the credentials gathered above:

```env
# LLM Configuration
GEMINI_API_KEY=your_gemini_api_key_here

# Database Configuration (Turso)
TURSO_DATABASE_URL=libsql://newsletter-db-your-username.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token_here

# API Configuration
# Generate a random string for this
RSS_SECRET=my-super-secret-rss-key-123
PORT=8080
```

## 3. Local Testing

Once your `.env` file is configured, you are ready to test locally.

1.  **Start the Local Server**:
    ```bash
    npm run dev
    ```

2.  **Mock a Webhook POST**:
    Use `curl` to simulate an incoming email from CloudMailin.
    ```bash
    curl -X POST "http://localhost:8080/webhook/cloudmailin?secret=my-super-secret-rss-key-123" \
      -H "Content-Type: application/json" \
      -d '{
        "envelope": { "from": "newsletter@example.com" },
        "headers": { "Date": "Mon, 05 May 2026 09:00:00 +0000" },
        "html": "<h1>Newsletter Title</h1><p>Here is an article: <a href=\"https://example.com/article1\">Article 1</a></p>"
      }'
    ```

3.  **View the RSS Feed**:
    Open your browser or an RSS reader and navigate to:
    ```text
    http://localhost:8080/rss?secret=my-super-secret-rss-key-123
    ```

---

## 4. Deploying to Google Cloud Run

To deploy this application to Google Cloud Run:

### Step A: Deploy the Service
1.  **Install the Google Cloud CLI (`gcloud`)** and initialize it with `gcloud init`.
2.  **Deploy from Source**:
    ```bash
    gcloud run deploy newsletter-processor \
      --source . \
      --region us-central1 \
      --allow-unauthenticated \
      --set-env-vars="GEMINI_API_KEY=...,TURSO_DATABASE_URL=...,TURSO_AUTH_TOKEN=...,RSS_SECRET=..."
    ```
3.  After deployment, `gcloud` will output a **Service URL** (e.g., `https://newsletter-processor-xxxxxx.a.run.app`).

### Step B: Configure CloudMailin Webhook
Go to your CloudMailin dashboard and update your address's **Target URL** to:
```text
https://YOUR_CLOUD_RUN_SERVICE_URL/webhook/cloudmailin?secret=YOUR_RSS_SECRET
```
Ensure the payload format is set to **JSON Normalized**.

### Step C: Subscribe to the Live RSS Feed
You can now subscribe to your cloud-hosted RSS feed:
```text
https://YOUR_CLOUD_RUN_SERVICE_URL/rss?secret=YOUR_RSS_SECRET
```
