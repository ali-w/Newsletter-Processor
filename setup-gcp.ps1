<#
.SYNOPSIS
  One-time GCP setup for Newsletter Processor Cloud Functions deployment.
  Run this before triggering the GitHub Actions workflow for the first time.

.PARAMETER ProjectId
  GCP project ID (required).

.PARAMETER GitHubRepo
  GitHub repository in OWNER/REPO format, e.g. AliW/newsletter-processor

.PARAMETER Region
  GCP region. Default: europe-west1.

.PARAMETER QueueName
  Cloud Tasks queue name. Default: newsletter-ingest.

.EXAMPLE
  .\setup-gcp.ps1 -ProjectId my-project -GitHubRepo AliW/newsletter-processor
#>

param(
  [Parameter(Mandatory)]
  [string]$ProjectId,

  [Parameter(Mandatory)]
  [string]$GitHubRepo,

  [string]$Region    = 'europe-west1',
  [string]$QueueName = 'newsletter-ingest'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helper: write a secret to Secret Manager via temp file.
# Avoids newline injection that can occur when piping strings in PowerShell.
# ---------------------------------------------------------------------------

function New-GcpSecret {
  param(
    [string]$Name,
    [string]$Value,
    [string]$Project
  )
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.Encoding]::UTF8)
    gcloud secrets create $Name --data-file=$tmp --project=$Project
    if ($LASTEXITCODE -ne 0) { throw "Failed to create secret '$Name'" }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# Step 1: Enable APIs
# ---------------------------------------------------------------------------

Write-Host "`n[1/5] Enabling GCP APIs..." -ForegroundColor Yellow

gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com iam.googleapis.com --project=$ProjectId

if ($LASTEXITCODE -ne 0) { Write-Error 'API enablement failed.'; exit 1 }

# ---------------------------------------------------------------------------
# Step 2: Create Cloud Tasks queue
# ---------------------------------------------------------------------------

Write-Host "`n[2/5] Creating Cloud Tasks queue '$QueueName'..." -ForegroundColor Yellow

gcloud tasks queues create $QueueName --location=$Region --project=$ProjectId

if ($LASTEXITCODE -ne 0) {
  Write-Warning "Queue may already exist - continuing."
}

# ---------------------------------------------------------------------------
# Step 3: Create deployer service account and grant roles
# ---------------------------------------------------------------------------

Write-Host "`n[3/5] Creating deployer service account..." -ForegroundColor Yellow

$SA = "deploy-sa@$ProjectId.iam.gserviceaccount.com"

gcloud iam service-accounts create deploy-sa --display-name="GitHub Actions Deploy" --project=$ProjectId

if ($LASTEXITCODE -ne 0) {
  Write-Warning "Service account may already exist - continuing."
}

Write-Host "  Granting IAM roles to $SA..." -ForegroundColor Gray

$deployerRoles = @(
  'roles/cloudfunctions.developer',
  'roles/run.admin',
  'roles/iam.serviceAccountUser',
  'roles/secretmanager.secretAccessor',
  'roles/storage.objectAdmin',
  'roles/artifactregistry.writer',
  'roles/cloudtasks.admin'
)

foreach ($role in $deployerRoles) {
  Write-Host "    $role" -ForegroundColor Gray
  gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$SA" --role=$role --quiet
  if ($LASTEXITCODE -ne 0) { Write-Error "Failed to bind role '$role'."; exit 1 }
}

# ---------------------------------------------------------------------------
# Step 4: Grant Cloud Functions runtime SA access to secrets and Cloud Tasks
# ---------------------------------------------------------------------------

Write-Host "`n[4/5] Granting runtime service account permissions..." -ForegroundColor Yellow

$ProjectNumber = gcloud projects describe $ProjectId --format='value(projectNumber)'
$RuntimeSA     = "$ProjectNumber-compute@developer.gserviceaccount.com"

Write-Host "  Runtime SA: $RuntimeSA" -ForegroundColor Gray

$runtimeRoles = @(
  'roles/secretmanager.secretAccessor',
  'roles/cloudtasks.enqueuer'
)

foreach ($role in $runtimeRoles) {
  Write-Host "    $role" -ForegroundColor Gray
  gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$RuntimeSA" --role=$role --quiet
  if ($LASTEXITCODE -ne 0) { Write-Error "Failed to bind role '$role'."; exit 1 }
}

# ---------------------------------------------------------------------------
# Step 5: Set up Workload Identity Federation
# ---------------------------------------------------------------------------

Write-Host "`n[5/5] Setting up Workload Identity Federation..." -ForegroundColor Yellow

gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions" --project=$ProjectId

if ($LASTEXITCODE -ne 0) {
  Write-Warning "WIF pool may already exist - continuing."
}

gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github --display-name="GitHub" --issuer-uri="https://token.actions.githubusercontent.com" --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --project=$ProjectId

if ($LASTEXITCODE -ne 0) {
  Write-Warning "WIF provider may already exist - continuing."
}

Write-Host "  Binding service account to WIF pool for repo: $GitHubRepo" -ForegroundColor Gray

$WifMember = "principalSet://iam.googleapis.com/projects/$ProjectNumber/locations/global/workloadIdentityPools/github/attribute.repository/$GitHubRepo"

gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser --member=$WifMember --project=$ProjectId

if ($LASTEXITCODE -ne 0) { Write-Error "Failed to bind WIF to service account."; exit 1 }

# ---------------------------------------------------------------------------
# Summary: print values to add to GitHub
# ---------------------------------------------------------------------------

$ProviderResourceName = "projects/$ProjectNumber/locations/global/workloadIdentityPools/github/providers/github"

Write-Host ''
Write-Host '======================================================' -ForegroundColor Green
Write-Host ' Setup complete - add these to GitHub' -ForegroundColor Green
Write-Host '======================================================' -ForegroundColor Green
Write-Host ''
Write-Host 'Repository VARIABLE (Settings -> Variables):' -ForegroundColor Yellow
Write-Host "  GCP_PROJECT_ID  =  $ProjectId"
Write-Host ''
Write-Host 'Repository SECRETS (Settings -> Secrets):' -ForegroundColor Yellow
Write-Host "  GCP_WORKLOAD_IDENTITY_PROVIDER  =  $ProviderResourceName"
Write-Host "  GCP_SERVICE_ACCOUNT             =  $SA"
Write-Host "  GEMINI_API_KEY                  =  (as stored in Secret Manager)"
Write-Host "  TURSO_DATABASE_URL              =  (as stored in Secret Manager)"
Write-Host "  TURSO_AUTH_TOKEN                =  (as stored in Secret Manager)"
Write-Host "  RSS_SECRET                      =  (as stored in Secret Manager)"
Write-Host "  SERVICE_URL                     =  (as stored in Secret Manager)"
Write-Host ''
Write-Host 'After adding those, trigger the GitHub Actions workflow.' -ForegroundColor Cyan
Write-Host 'Once deployed, update the SERVICE_URL secret in Secret Manager' -ForegroundColor Cyan
Write-Host 'to the reader-api function URL shown in the workflow summary,' -ForegroundColor Cyan
Write-Host 'then re-run the workflow to pick it up.' -ForegroundColor Cyan
Write-Host ''
