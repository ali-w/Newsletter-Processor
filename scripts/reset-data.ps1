# reset-data.ps1
#
# Clears all test/development data:
#   - Deletes all objects from both GCS buckets (HTML cache + PDF uploads)
#   - Truncates all articles, newsletters, and OCR data in the database
#
# Usage:
#   .\scripts\reset-data.ps1
#   .\scripts\reset-data.ps1 -Project my-project-id

param(
    [string]$Project      = $env:GCP_PROJECT_ID,
    [string]$HtmlBucket   = $env:GCS_BUCKET,
    [string]$PdfBucket    = $env:GCS_PDF_BUCKET
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== Data Reset ===" -ForegroundColor Red
Write-Host "This will permanently delete ALL articles, newsletters, and cached files."
Write-Host ""

if ($Project)    { Write-Host "GCP project  : $Project" }
if ($HtmlBucket) { Write-Host "HTML bucket  : gs://$HtmlBucket" }
if ($PdfBucket)  { Write-Host "PDF bucket   : gs://$PdfBucket" }
Write-Host "Database     : Turso (from .env / environment)"
Write-Host ""

$Confirm = Read-Host "Type YES to continue"
if ($Confirm -ne 'YES') {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
}

Write-Host ""

# ---------------------------------------------------------------------------
# 1. Clear HTML cache bucket
# ---------------------------------------------------------------------------

if ($HtmlBucket) {
    Write-Host "[1/3] Clearing HTML cache bucket gs://$HtmlBucket ..." -ForegroundColor Yellow
    $Objects = gcloud storage ls "gs://$HtmlBucket/**" --project=$Project 2>$null
    if ($Objects) {
        gcloud storage rm --recursive "gs://$HtmlBucket/**" --project=$Project
        Write-Host "      Cleared." -ForegroundColor Green
    } else {
        Write-Host "      Already empty."
    }
} else {
    Write-Host "[1/3] Skipping HTML bucket (GCS_BUCKET not set)." -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# 2. Clear PDF upload bucket
# ---------------------------------------------------------------------------

if ($PdfBucket) {
    Write-Host "[2/3] Clearing PDF bucket gs://$PdfBucket ..." -ForegroundColor Yellow
    $Objects = gcloud storage ls "gs://$PdfBucket/**" --project=$Project 2>$null
    if ($Objects) {
        gcloud storage rm --recursive "gs://$PdfBucket/**" --project=$Project
        Write-Host "      Cleared." -ForegroundColor Green
    } else {
        Write-Host "      Already empty."
    }
} else {
    Write-Host "[2/3] Skipping PDF bucket (GCS_PDF_BUCKET not set)." -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# 3. Truncate database
# ---------------------------------------------------------------------------

Write-Host "[3/3] Truncating database..." -ForegroundColor Yellow

$ScriptDir = Split-Path -Parent $PSScriptRoot
Push-Location $ScriptDir
try {
    npm run reset-data
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "=== Reset complete ===" -ForegroundColor Green
