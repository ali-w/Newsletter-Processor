# setup-gcp-pdf.ps1
#
# Creates and configures GCP resources needed for PDF upload support.
# Run once before deploying the updated Cloud Functions.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - GCP_PROJECT_ID environment variable set, OR pass -Project parameter
#   - Existing Cloud Functions service account must already exist
#
# Usage:
#   .\scripts\setup-gcp-pdf.ps1
#   .\scripts\setup-gcp-pdf.ps1 -Project my-project-id -Region europe-west1

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

Write-Host "[1/5] Discovering Cloud Functions service account..." -ForegroundColor Yellow

$ProjectNumber = gcloud projects describe $Project --format='value(projectNumber)'
$ServiceAccount = "$ProjectNumber-compute@developer.gserviceaccount.com"

Write-Host "      Service account: $ServiceAccount"

# ---------------------------------------------------------------------------
# 2. Create the PDF bucket
# ---------------------------------------------------------------------------

Write-Host "[2/5] Creating GCS bucket gs://$BucketName ..." -ForegroundColor Yellow

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

Write-Host "[3/5] Granting bucket IAM roles to service account..." -ForegroundColor Yellow

gcloud storage buckets add-iam-policy-binding "gs://$BucketName" `
    --member="serviceAccount:$ServiceAccount" `
    --role="roles/storage.objectAdmin" `
    --project=$Project

Write-Host "      roles/storage.objectAdmin granted on $BucketName." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 4. Grant signBlob permission for signed URL generation
# ---------------------------------------------------------------------------
#
# Signed URL v4 generation requires the service account to call
# iam.serviceAccounts.signBlob on itself, satisfied by granting
# roles/iam.serviceAccountTokenCreator on the SA itself.
#
# Without this, getSignedUrl() throws:
#   "Could not load the default credentials" or "Failed to sign data"

Write-Host "[4/5] Granting Service Account Token Creator (for signed URLs)..." -ForegroundColor Yellow

gcloud iam service-accounts add-iam-policy-binding $ServiceAccount `
    --project=$Project `
    --member="serviceAccount:$ServiceAccount" `
    --role="roles/iam.serviceAccountTokenCreator"

Write-Host "      roles/iam.serviceAccountTokenCreator granted on $ServiceAccount." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Reminder: add GitHub Actions repository variable
# ---------------------------------------------------------------------------
#
# GCS_PDF_BUCKET is not sensitive so it is passed as --set-env-vars in
# deploy.yml rather than as a Secret Manager secret. Add it manually:
#
#   GitHub -> Settings -> Secrets and variables -> Variables -> New repository variable
#   Name:  GCS_PDF_BUCKET
#   Value: research-reader-pdfs

Write-Host "[5/5] GitHub Actions variable reminder..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Add the following repository variable in GitHub:" -ForegroundColor White
Write-Host "  Settings -> Secrets and variables -> Variables -> New repository variable" -ForegroundColor Gray
Write-Host ""
Write-Host "  Name  : GCS_PDF_BUCKET" -ForegroundColor Cyan
Write-Host "  Value : $BucketName" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Optional model overrides (defaults to gemini-2.5-flash-lite if omitted):" -ForegroundColor Gray
Write-Host "  Name  : PDF_MODEL_TYPED       Value : gemini-2.5-flash-lite" -ForegroundColor Gray
Write-Host "  Name  : PDF_MODEL_HANDWRITTEN Value : gemini-2.5-flash-lite" -ForegroundColor Gray

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Add GCS_PDF_BUCKET as a GitHub Actions repository variable (see above)"
Write-Host "  2. Run the database migration:"
Write-Host "     GitHub Actions -> Deploy to GCP -> Run workflow -> skip_migration: false"
Write-Host "  3. Deploy both Cloud Functions via GitHub Actions"
Write-Host ""
Write-Host "Smoke test after deployment:"
Write-Host "  POST /articles/upload-pdf  -> get { id, upload_url, gcs_uri }"
Write-Host "  PUT <upload_url> -H 'Content-Type: application/pdf' --data-binary @file.pdf"
Write-Host "  POST /articles/{id}/confirm-upload  -> { ok: true }"
Write-Host "  GET  /articles/{id}/pdf?secret=<key>  -> 302 redirect to signed URL"
