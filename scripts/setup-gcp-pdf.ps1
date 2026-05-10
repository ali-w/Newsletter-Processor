# setup-gcp-pdf.ps1
#
# Creates and configures GCP resources needed for PDF upload support,
# then verifies all Secret Manager secrets and prints the full list of
# required GitHub Actions repository variables.
#
# Run once before deploying the updated Cloud Functions.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - GCP_PROJECT_ID environment variable set, OR pass -Project parameter
#
# Usage:
#   .\scripts\setup-gcp-pdf.ps1
#   .\scripts\setup-gcp-pdf.ps1 -Project my-project-id -Region europe-west1 -BucketName my-pdfs

param(
    [string]$Project    = $env:GCP_PROJECT_ID,
    [string]$Region     = '',
    [string]$BucketName = 'research-reader-pdfs'
)

if (-not $Region) {
    if ($env:GCP_REGION) { $Region = $env:GCP_REGION } else { $Region = 'europe-west1' }
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Project) {
    Write-Error "GCP project ID is required. Set the GCP_PROJECT_ID environment variable or pass -Project."
    exit 1
}

Write-Host ""
Write-Host "=== PDF Upload - GCP Setup ===" -ForegroundColor Cyan
Write-Host "Project : $Project"
Write-Host "Region  : $Region"
Write-Host "Bucket  : $BucketName"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Discover the Cloud Functions service account
# ---------------------------------------------------------------------------

Write-Host "[1/6] Discovering Cloud Functions service account..." -ForegroundColor Yellow

$ProjectNumber = gcloud projects describe $Project --format='value(projectNumber)'
$ServiceAccount = "$ProjectNumber-compute@developer.gserviceaccount.com"

Write-Host "      Service account: $ServiceAccount"

# ---------------------------------------------------------------------------
# 2. Create the PDF bucket
# ---------------------------------------------------------------------------

Write-Host "[2/6] Creating GCS bucket gs://$BucketName ..." -ForegroundColor Yellow

$BucketExists = gcloud storage buckets list --filter="name=$BucketName" --project=$Project --format='value(name)'
if ($BucketExists) {
    Write-Host "      Bucket already exists - skipping creation."
} else {
    gcloud storage buckets create "gs://$BucketName" `
        --project=$Project `
        --location=$Region `
        --uniform-bucket-level-access `
        --no-public-access-prevention
    Write-Host "      Bucket created." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 3. Grant the service account access to the PDF bucket
# ---------------------------------------------------------------------------

Write-Host "[3/6] Granting bucket IAM roles to service account..." -ForegroundColor Yellow

gcloud storage buckets add-iam-policy-binding "gs://$BucketName" `
    --member="serviceAccount:$ServiceAccount" `
    --role="roles/storage.objectAdmin" `
    --project=$Project

Write-Host "      roles/storage.objectAdmin granted on $BucketName." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 4. Grant signBlob permission for signed URL generation
# ---------------------------------------------------------------------------
#
# Signed URL v4 requires the service account to sign blobs on itself.
# Without this, getSignedUrl() throws "Failed to sign data".

Write-Host "[4/6] Granting Service Account Token Creator (for signed URLs)..." -ForegroundColor Yellow

gcloud iam service-accounts add-iam-policy-binding $ServiceAccount `
    --project=$Project `
    --member="serviceAccount:$ServiceAccount" `
    --role="roles/iam.serviceAccountTokenCreator"

Write-Host "      roles/iam.serviceAccountTokenCreator granted on $ServiceAccount." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Verify Secret Manager secrets
# ---------------------------------------------------------------------------
#
# These secrets must exist in Secret Manager before deployment.
# Sensitive values (API keys, tokens) are never stored in GitHub.

Write-Host "[5/6] Checking Secret Manager secrets..." -ForegroundColor Yellow

$RequiredSecrets = @(
    'CLOUDMAILIN_API_KEY',
    'CLOUDMAILIN_USERNAME',
    'GEMINI_API_KEY',
    'REVIEW_RECIPIENT_EMAIL',
    'RSS_SECRET',
    'SERVICE_URL',
    'TURSO_AUTH_TOKEN',
    'TURSO_DATABASE_URL'
)

$MissingSecrets = @()
foreach ($Secret in $RequiredSecrets) {
    $Exists = gcloud secrets describe $Secret --project=$Project --format='value(name)' 2>$null
    if ($Exists) {
        Write-Host "      [OK]      $Secret" -ForegroundColor Green
    } else {
        Write-Host "      [MISSING] $Secret" -ForegroundColor Red
        $MissingSecrets += $Secret
    }
}

if ($MissingSecrets.Count -gt 0) {
    Write-Host ""
    Write-Host "  Create missing secrets with:" -ForegroundColor Yellow
    foreach ($Secret in $MissingSecrets) {
        Write-Host "    gcloud secrets create $Secret --project=$Project --replication-policy=automatic" -ForegroundColor Gray
        Write-Host "    echo -n 'VALUE' | gcloud secrets versions add $Secret --data-file=- --project=$Project" -ForegroundColor Gray
    }
}

# ---------------------------------------------------------------------------
# 6. GitHub Actions repository variables checklist
# ---------------------------------------------------------------------------
#
# These are non-sensitive and set as repository variables (not secrets).
# GitHub -> Settings -> Secrets and variables -> Variables

Write-Host "[6/6] GitHub Actions repository variables checklist..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Set the following repository variables in GitHub:" -ForegroundColor White
Write-Host "  Settings -> Secrets and variables -> Variables" -ForegroundColor Gray
Write-Host ""

$Variables = @(
    @{ Name = 'GCP_PROJECT_ID';        Value = $Project;       Note = 'Required' },
    @{ Name = 'GCP_REGION';            Value = $Region;        Note = 'Required' },
    @{ Name = 'TASKS_QUEUE';           Value = 'newsletter-ingest'; Note = 'Required - Cloud Tasks queue name' },
    @{ Name = 'GCS_BUCKET';            Value = '<html-cache-bucket-name>'; Note = 'Required - bucket for cached article HTML' },
    @{ Name = 'GCS_PDF_BUCKET';        Value = $BucketName;    Note = 'Required - bucket for PDF uploads (just created)' },
    @{ Name = 'ARTICLES_MAX_LIMIT';    Value = '200';          Note = 'Optional - default 200' },
    @{ Name = 'PDF_MODEL_TYPED';       Value = 'gemini-2.5-flash-lite'; Note = 'Optional - Gemini model for typed PDFs' },
    @{ Name = 'PDF_MODEL_HANDWRITTEN'; Value = 'gemini-2.5-flash-lite'; Note = 'Optional - Gemini model for handwritten PDFs' }
)

foreach ($Var in $Variables) {
    Write-Host ("  {0,-26} = {1}" -f $Var.Name, $Var.Value) -ForegroundColor Cyan
    Write-Host ("  {0,-26}   ({1})" -f '', $Var.Note) -ForegroundColor Gray
    Write-Host ""
}

Write-Host "  Repository secret (Settings -> Secrets and variables -> Secrets):" -ForegroundColor White
Write-Host "  GCP_SA_KEY  = <service account key JSON>" -ForegroundColor Cyan
Write-Host "  (generate: gcloud iam service-accounts keys create key.json --iam-account=$ServiceAccount)" -ForegroundColor Gray

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
if ($MissingSecrets.Count -gt 0) {
    Write-Host "=== Setup complete with warnings ===" -ForegroundColor Yellow
    Write-Host "  $($MissingSecrets.Count) Secret Manager secret(s) still need to be created (see above)." -ForegroundColor Yellow
} else {
    Write-Host "=== Setup complete ===" -ForegroundColor Green
}
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Create any missing Secret Manager secrets listed above"
Write-Host "  2. Set all GitHub Actions repository variables listed above"
Write-Host "  3. Run the database migration:"
Write-Host "     GitHub Actions -> Deploy to GCP -> Run workflow -> skip_migration: false"
Write-Host "  4. Deploy all Cloud Functions via GitHub Actions"
Write-Host ""
Write-Host "Smoke test after deployment:"
Write-Host "  POST /articles/upload-pdf  -> get { id, upload_url, gcs_uri }"
Write-Host "  PUT <upload_url> with Content-Type: application/pdf"
Write-Host "  POST /articles/{id}/confirm-upload  -> { ok: true }"
Write-Host "  GET  /articles/{id}/pdf?secret=<key>  -> 302 redirect to signed URL"
