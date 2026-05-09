<#
.SYNOPSIS
  Deploys the Newsletter Processor Cloud Functions to GCP.

.PARAMETER ProjectId
  GCP project ID (required).

.PARAMETER Region
  GCP region. Default: europe-west1.

.PARAMETER QueueName
  Cloud Tasks queue name. Default: newsletter-ingest.

.PARAMETER Setup
  Switch. Pass on first run to enable APIs and create the Cloud Tasks queue.
  Secrets must already exist in Secret Manager before deploying.

.NOTES
  Sensitive configuration is read from GCP Secret Manager at runtime.
  The following secrets must exist in Secret Manager before running this script:
    CLOUDMAILIN_API_KEY, CLOUDMAILIN_USERNAME, GEMINI_API_KEY,
    REVIEW_RECIPIENT_EMAIL, RSS_SECRET, SERVICE_URL,
    TURSO_AUTH_TOKEN, TURSO_DATABASE_URL

  The migration step (npm run migrate) reads from your LOCAL environment.
  Ensure GEMINI_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, RSS_SECRET,
  and SERVICE_URL are set in the current shell before running this script.

.EXAMPLE
  .\deploy.ps1 -ProjectId my-gcp-project -Setup
  .\deploy.ps1 -ProjectId my-gcp-project
#>

param(
  [Parameter(Mandatory)]
  [string]$ProjectId,

  [string]$Region    = 'europe-west1',
  [string]$QueueName = 'newsletter-ingest',
  [switch]$Setup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Secrets — sourced from GCP Secret Manager at function runtime
# ---------------------------------------------------------------------------

$commonSecrets = (
  'CLOUDMAILIN_API_KEY=CLOUDMAILIN_API_KEY:latest',
  'CLOUDMAILIN_USERNAME=CLOUDMAILIN_USERNAME:latest',
  'GEMINI_API_KEY=GEMINI_API_KEY:latest',
  'REVIEW_RECIPIENT_EMAIL=REVIEW_RECIPIENT_EMAIL:latest',
  'RSS_SECRET=RSS_SECRET:latest',
  'SERVICE_URL=SERVICE_URL:latest',
  'TURSO_AUTH_TOKEN=TURSO_AUTH_TOKEN:latest',
  'TURSO_DATABASE_URL=TURSO_DATABASE_URL:latest'
) -join ','

# ---------------------------------------------------------------------------
# Non-secret operational vars — safe to pass as plain env vars
# ---------------------------------------------------------------------------

$ArticlesMaxLimit = if ($env:ARTICLES_MAX_LIMIT) { $env:ARTICLES_MAX_LIMIT } else { '200' }

$commonEnvVars = @{
  GCP_PROJECT        = $ProjectId
  GCP_REGION         = $Region
  TASKS_QUEUE        = $QueueName
  ARTICLES_MAX_LIMIT = $ArticlesMaxLimit
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Publish-Function {
  param(
    [string]$Name,
    [string]$EntryPoint,
    [string]$Timeout,
    [hashtable]$EnvVars
  )

  $envString = ($EnvVars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ','

  Write-Host "`nDeploying function: $Name ..." -ForegroundColor Cyan

  gcloud functions deploy $Name `
    --gen2 `
    --project=$ProjectId `
    --region=$Region `
    --runtime=nodejs22 `
    --source=deploy/dist `
    --entry-point=$EntryPoint `
    --trigger-http `
    --allow-unauthenticated `
    --timeout=$Timeout `
    "--set-secrets=$commonSecrets" `
    "--set-env-vars=$envString"

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment of '$Name' failed."
    exit $LASTEXITCODE
  }
}

function Get-FunctionUrl([string]$Name) {
  $url = gcloud functions describe $Name `
    --gen2 `
    --project=$ProjectId `
    --region=$Region `
    --format='value(serviceConfig.uri)' 2>$null
  return $url.Trim()
}

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------

Write-Host 'Building TypeScript (functions target)...' -ForegroundColor Yellow
npm run build:functions
if ($LASTEXITCODE -ne 0) { Write-Error 'Build failed.'; exit $LASTEXITCODE }

# Copy package manifests into the output directory so gcloud can install deps
Copy-Item 'package.json'      'deploy/dist/package.json'      -Force
Copy-Item 'package-lock.json' 'deploy/dist/package-lock.json' -Force

# ---------------------------------------------------------------------------
# Step 2: Migrate (reads from local environment — see .NOTES above)
# ---------------------------------------------------------------------------

Write-Host "`nRunning database migration..." -ForegroundColor Yellow
npm run migrate
if ($LASTEXITCODE -ne 0) { Write-Error 'Migration failed.'; exit $LASTEXITCODE }

# ---------------------------------------------------------------------------
# Step 3: First-run setup (optional)
# ---------------------------------------------------------------------------

if ($Setup) {
  Write-Host "`nEnabling required GCP APIs..." -ForegroundColor Yellow
  gcloud services enable `
    cloudfunctions.googleapis.com `
    cloudbuild.googleapis.com `
    cloudtasks.googleapis.com `
    secretmanager.googleapis.com `
    --project=$ProjectId

  Write-Host "`nCreating Cloud Tasks queue '$QueueName' in $Region..." -ForegroundColor Yellow
  gcloud tasks queues create $QueueName --location=$Region --project=$ProjectId
}

# ---------------------------------------------------------------------------
# Step 4: Deploy reader-api, summarize, ingest-worker
# ---------------------------------------------------------------------------

Publish-Function -Name 'reader-api'    -EntryPoint 'readerApi'    -Timeout '60s'  -EnvVars $commonEnvVars
Publish-Function -Name 'summarize'     -EntryPoint 'summarize'    -Timeout '540s' -EnvVars $commonEnvVars
Publish-Function -Name 'ingest-worker' -EntryPoint 'ingestWorker' -Timeout '540s' -EnvVars $commonEnvVars

# ---------------------------------------------------------------------------
# Step 5: Capture ingest-worker URL, then deploy ingest with it
# ---------------------------------------------------------------------------

Write-Host "`nFetching ingest-worker URL..." -ForegroundColor Yellow
$IngestWorkerUrl = Get-FunctionUrl 'ingest-worker'

if (-not $IngestWorkerUrl) {
  Write-Error 'Could not retrieve ingest-worker URL. Deploy of ingest function aborted.'
  exit 1
}

Write-Host "ingest-worker URL: $IngestWorkerUrl" -ForegroundColor Gray

$ingestEnvVars = $commonEnvVars.Clone()
$ingestEnvVars['INGEST_WORKER_URL'] = $IngestWorkerUrl

Publish-Function -Name 'ingest' -EntryPoint 'ingest' -Timeout '30s' -EnvVars $ingestEnvVars

# ---------------------------------------------------------------------------
# Step 6: Post-deploy summary
# ---------------------------------------------------------------------------

$ReaderApiUrl = Get-FunctionUrl 'reader-api'
$SummarizeUrl = Get-FunctionUrl 'summarize'
$IngestUrl    = Get-FunctionUrl 'ingest'

Write-Host ''
Write-Host '======================================================' -ForegroundColor Green
Write-Host ' Deployment complete' -ForegroundColor Green
Write-Host '======================================================' -ForegroundColor Green
Write-Host ''
Write-Host "  reader-api    : $ReaderApiUrl"
Write-Host "  summarize     : $SummarizeUrl"
Write-Host "  ingest        : $IngestUrl"
Write-Host "  ingest-worker : $IngestWorkerUrl"
Write-Host ''
Write-Host 'CloudMailin webhook URL to configure:' -ForegroundColor Yellow
Write-Host "  $IngestUrl/webhook/cloudmailin"
Write-Host ''
Write-Host 'Set the X-Api-Key header to your RSS_SECRET value in CloudMailin settings.' -ForegroundColor Yellow
Write-Host ''
