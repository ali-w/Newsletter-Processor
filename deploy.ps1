<#
.SYNOPSIS
  Deploys the Newsletter Processor Cloud Functions to GCP.

.PARAMETER ProjectId
  GCP project ID (required).

.PARAMETER Region
  GCP region. Default: europe-west1.

.PARAMETER QueueName
  Cloud Tasks queue name. Default: newsletter-ingest.

.PARAMETER RunMigration
  Switch. Pass to run the database migration before deploying.
  Credentials are fetched from Secret Manager automatically.
  Omit on routine deployments where no schema changes were made.

.PARAMETER Setup
  Switch. Pass on first run to enable APIs and create the Cloud Tasks queue.
  Secrets must already exist in Secret Manager before deploying.

.PARAMETER Function
  Deploy only the named function (reader-api, summarize, ingest-worker, ingest).
  Skips the other functions. Build and staging always run.

.EXAMPLE
  .\deploy.ps1 -ProjectId my-gcp-project -Setup -RunMigration
  .\deploy.ps1 -ProjectId my-gcp-project
  .\deploy.ps1 -ProjectId my-gcp-project -Function ingest
#>

param(
  [Parameter(Mandatory)]
  [string]$ProjectId,

  [string]$Region    = 'europe-west1',
  [string]$QueueName = 'newsletter-ingest',
  [string]$Function  = '',
  [switch]$RunMigration,
  [switch]$Setup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Secrets - sourced from GCP Secret Manager at function runtime
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

# Secrets for specific functions
$summarizeSecrets = ($commonSecrets, 'GCS_BUCKET=GCS_BUCKET:latest') -join ','
$readerApiSecrets = ($commonSecrets, 'SUMMARIZE_URL=SUMMARIZE_URL:latest') -join ','

# ---------------------------------------------------------------------------
# Non-secret operational vars - safe to pass as plain env vars
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
    [hashtable]$EnvVars,
    [string]$Secrets = $commonSecrets
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
    "--set-secrets=$Secrets" `
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

# Stage a production package.json into deploy/dist:
#   - scripts cleared so Cloud Build does not attempt to run tsc
#   - main set to deploy-index.js (the compiled functions entry point)
$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
$pkg.scripts = [PSCustomObject]@{}
$pkg.main = 'deploy-index.js'
$json = $pkg | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$PWD\deploy\dist\package.json", $json, $utf8NoBom)
Copy-Item 'package-lock.json' 'deploy/dist/package-lock.json' -Force

# ---------------------------------------------------------------------------
# Step 2: Migrate (optional - pass -RunMigration to enable)
# ---------------------------------------------------------------------------

if ($RunMigration) {
  Write-Host "`nRunning database migration..." -ForegroundColor Yellow
  Write-Host "  Fetching credentials from Secret Manager..." -ForegroundColor Gray

  $env:TURSO_DATABASE_URL = gcloud secrets versions access latest --secret=TURSO_DATABASE_URL --project=$ProjectId
  $env:TURSO_AUTH_TOKEN   = gcloud secrets versions access latest --secret=TURSO_AUTH_TOKEN   --project=$ProjectId
  $env:GEMINI_API_KEY     = gcloud secrets versions access latest --secret=GEMINI_API_KEY     --project=$ProjectId
  $env:RSS_SECRET         = gcloud secrets versions access latest --secret=RSS_SECRET         --project=$ProjectId
  $env:SERVICE_URL        = gcloud secrets versions access latest --secret=SERVICE_URL        --project=$ProjectId

  npm run migrate
  if ($LASTEXITCODE -ne 0) { Write-Error 'Migration failed.'; exit $LASTEXITCODE }

  Remove-Item Env:TURSO_DATABASE_URL, Env:TURSO_AUTH_TOKEN, Env:GEMINI_API_KEY, Env:RSS_SECRET, Env:SERVICE_URL -ErrorAction SilentlyContinue
} else {
  Write-Host "`nSkipping migration (pass -RunMigration to run)." -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# Step 3: First-run setup (optional - pass -Setup to enable)
# ---------------------------------------------------------------------------

if ($Setup) {
  Write-Host "`nEnabling required GCP APIs..." -ForegroundColor Yellow
  gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com storage.googleapis.com --project=$ProjectId

  Write-Host "`nCreating Cloud Tasks queue '$QueueName' in $Region..." -ForegroundColor Yellow
  gcloud tasks queues create $QueueName --location=$Region --project=$ProjectId

  $BucketName = "$ProjectId-article-cache"
  Write-Host "`nCreating GCS article cache bucket '$BucketName'..." -ForegroundColor Yellow
  gsutil mb -p $ProjectId -l $Region "gs://$BucketName"
  $ServiceAccount = "$ProjectId@appspot.gserviceaccount.com"
  Write-Host "  Granting Storage Object Admin to $ServiceAccount..." -ForegroundColor Gray
  gsutil iam ch "serviceAccount:${ServiceAccount}:roles/storage.objectAdmin" "gs://$BucketName"
  Write-Host "  Add GCS_BUCKET secret to Secret Manager:" -ForegroundColor Yellow
  Write-Host "    gcloud secrets create GCS_BUCKET --data-file=- <<< '$BucketName'" -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# Step 4: Deploy reader-api, summarize, ingest-worker
# ---------------------------------------------------------------------------

$deployAll = ($Function -eq '')

if ($deployAll -or $Function -eq 'reader-api') {
  Publish-Function -Name 'reader-api'    -EntryPoint 'readerApi'    -Timeout '60s'  -EnvVars $commonEnvVars -Secrets $readerApiSecrets
}
if ($deployAll -or $Function -eq 'summarize') {
  Publish-Function -Name 'summarize'     -EntryPoint 'summarize'    -Timeout '540s' -EnvVars $commonEnvVars -Secrets $summarizeSecrets
}
if ($deployAll -or $Function -eq 'ingest-worker') {
  Publish-Function -Name 'ingest-worker' -EntryPoint 'ingestWorker' -Timeout '540s' -EnvVars $commonEnvVars
}

# ---------------------------------------------------------------------------
# Step 5: Capture ingest-worker URL, then deploy ingest with it
# ---------------------------------------------------------------------------

if ($deployAll -or $Function -eq 'ingest') {
  Write-Host "`nFetching ingest-worker URL..." -ForegroundColor Yellow
  $IngestWorkerUrl = Get-FunctionUrl 'ingest-worker'

  if (-not $IngestWorkerUrl) {
    Write-Error 'Could not retrieve ingest-worker URL. Deploy of ingest function aborted.'
    exit 1
  }

  Write-Host "  ingest-worker URL: $IngestWorkerUrl" -ForegroundColor Gray

  $ingestEnvVars = $commonEnvVars.Clone()
  $ingestEnvVars['INGEST_WORKER_URL'] = $IngestWorkerUrl

  Publish-Function -Name 'ingest' -EntryPoint 'ingest' -Timeout '30s' -EnvVars $ingestEnvVars
}

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
