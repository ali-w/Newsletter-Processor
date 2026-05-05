# Newsletter Processor Service

A Cloud Run backend service that reads email newsletters via POP3, extracts articles using Gemini 1.5 Flash, stores them in Turso (libSQL), and serves them as an RSS feed.

## Stack
- Node.js & TypeScript
- Express.js
- Google Gen AI SDK (`gemini-1.5-flash`)
- Turso (libSQL for serverless SQLite)
- Docker
- Google Cloud Run & Cloud Scheduler

## Local Development Setup

1. **Install Dependencies:**
   \`\`\`bash
   npm install
   \`\`\`

2. **Configure Environment:**
   Copy \`.env.example\` to \`.env\` and fill in the values:
   - Your POP3 email credentials.
   - Your Gemini API Key.
   - Turso DB URL and Auth Token.
   - A secret for your RSS feed.

3. **Run locally:**
   \`\`\`bash
   npm run dev
   \`\`\`

4. **Trigger Processing:**
   \`\`\`bash
   curl -X POST http://localhost:8080/process
   \`\`\`

5. **View RSS:**
   Open your browser and navigate to:
   \`http://localhost:8080/rss?secret=your_super_secret_for_rss_feed\`

## Deployment to Google Cloud Run

1. **Build and Submit Docker Image:**
   \`\`\`bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/newsletter-processor
   \`\`\`

2. **Deploy to Cloud Run:**
   Deploy the service, ensuring you configure the necessary environment variables. Set it to **Require Authentication** so it is not publicly exposed.
   \`\`\`bash
   gcloud run deploy newsletter-processor \\
     --image gcr.io/YOUR_PROJECT_ID/newsletter-processor \\
     --region us-central1 \\
     --no-allow-unauthenticated \\
     --set-env-vars="POP3_HOST=...,POP3_PORT=995,POP3_USERNAME=...,POP3_PASSWORD=...,POP3_TLS=true,GEMINI_API_KEY=...,TURSO_DATABASE_URL=...,TURSO_AUTH_TOKEN=...,RSS_SECRET=..."
   \`\`\`

## Setting Up Cloud Scheduler

You need to trigger the \`/process\` endpoint periodically (e.g., every 6 hours). Since the Cloud Run service is protected, Cloud Scheduler needs an OIDC token.

1. **Create a Service Account:**
   \`\`\`bash
   gcloud iam service-accounts create scheduler-invoker --display-name "Scheduler Invoker"
   \`\`\`

2. **Grant Invoker Role:**
   \`\`\`bash
   gcloud run services add-iam-policy-binding newsletter-processor \\
     --region=us-central1 \\
     --member=serviceAccount:scheduler-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com \\
     --role=roles/run.invoker
   \`\`\`

3. **Create the Scheduler Job:**
   \`\`\`bash
   gcloud scheduler jobs create http newsletter-processor-job \\
     --schedule="0 */6 * * *" \\
     --uri="https://YOUR_CLOUD_RUN_URL/process" \\
     --http-method=POST \\
     --oidc-service-account-email=scheduler-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com \\
     --oidc-token-audience="https://YOUR_CLOUD_RUN_URL"
   \`\`\`
