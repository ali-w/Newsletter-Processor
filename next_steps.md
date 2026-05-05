# Next Steps: Running and Deploying Newsletter Processor

This guide covers everything you need to do to run the application locally and ultimately deploy it to Google Cloud Run with a scheduled ingestion task.

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
3.  **POP3 Server**:
    *   **Purpose**: To receive the actual newsletter emails.
    *   *Note: You mentioned you already have this set up.* Ensure you have the Host URL, Port, Username, and Password ready.

## 2. Environment Variables (`.env`)

Create a `.env` file in the root directory of the project (you can copy `.env.example`). Populate it with the credentials gathered above:

```env
# POP3 Configuration
POP3_HOST=your-pop3-server.com
POP3_PORT=995
POP3_USERNAME=your-email@example.com
POP3_PASSWORD=your-pop3-password
POP3_TLS=true

# LLM Configuration
GEMINI_API_KEY=your_gemini_api_key_here

# Database Configuration (Turso)
TURSO_DATABASE_URL=libsql://newsletter-db-your-username.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token_here

# API Configuration
# Generate a random string for this (e.g., using a password generator)
RSS_SECRET=my-super-secret-rss-key-123
PORT=8080
```

## 3. Local Testing

Once your `.env` file is configured, you are ready to test locally.

1.  **Start the Local Server**:
    ```bash
    npm run dev
    ```
    *Note: The application automatically creates the required database tables (`newsletters` and `articles`) on startup if they don't already exist.*

2.  **Trigger Email Processing**:
    Open a new terminal or use an API client like Postman, and send a `POST` request to the `/process` endpoint to force the application to check for new emails and process them.
    ```bash
    curl -X POST http://localhost:8080/process
    ```

3.  **View the RSS Feed**:
    Open your browser or an RSS reader and navigate to the `/rss` endpoint, passing the secret you defined in the `.env` file.
    ```text
    http://localhost:8080/rss?secret=my-super-secret-rss-key-123
    ```

---

## 4. Deploying to Google Cloud Run

To deploy this containerized application to Google Cloud Run and run it automatically, follow these steps.

### Step A: Deploy the Service
1.  **Install the Google Cloud CLI (`gcloud`)** and initialize it with `gcloud init`.
2.  **Deploy from Source**: Run the following command in the project root. This will automatically build the Dockerfile and deploy it.
    ```bash
    gcloud run deploy newsletter-processor \
      --source . \
      --region us-central1 \
      --allow-unauthenticated \
      --set-env-vars="POP3_HOST=...,POP3_PORT=995,POP3_USERNAME=...,POP3_PASSWORD=...,POP3_TLS=true,GEMINI_API_KEY=...,TURSO_DATABASE_URL=...,TURSO_AUTH_TOKEN=...,RSS_SECRET=..."
    ```
    *(Tip: For better security, consider using Google Secret Manager for `POP3_PASSWORD`, `GEMINI_API_KEY`, `TURSO_AUTH_TOKEN`, and `RSS_SECRET` instead of passing them as plain text environment variables).*

3.  After deployment, `gcloud` will output a **Service URL** (e.g., `https://newsletter-processor-xxxxxx.a.run.app`).

### Step B: Schedule Automatic Processing (Cloud Scheduler)
To make the application automatically check for new emails every hour (or any interval), create a Cloud Scheduler job.

1.  **Create a Service Account** (Optional but recommended):
    Create a service account that Cloud Scheduler will use to authenticate with Cloud Run.
    ```bash
    gcloud iam service-accounts create scheduler-invoker \
       --display-name "Cloud Scheduler Invoker"
    ```
    Give it the `roles/run.invoker` role for your Cloud Run service.

2.  **Create the Scheduler Job**:
    This job will send an HTTP `POST` request to your Cloud Run service's `/process` endpoint every hour.
    ```bash
    gcloud scheduler jobs create http process-newsletters-job \
      --schedule="0 * * * *" \
      --uri="https://YOUR_CLOUD_RUN_SERVICE_URL/process" \
      --http-method=POST \
      --oidc-service-account-email="scheduler-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
      --location="us-central1"
    ```
    *(Replace `YOUR_CLOUD_RUN_SERVICE_URL` and `YOUR_PROJECT_ID` with your actual values).*

### Step C: Subscribe to the Live RSS Feed
You can now subscribe to your cloud-hosted RSS feed by passing your secret:
```text
https://YOUR_CLOUD_RUN_SERVICE_URL/rss?secret=YOUR_RSS_SECRET
```
