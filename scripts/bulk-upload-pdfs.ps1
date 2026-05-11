# bulk-upload-pdfs.ps1
#
# Watches the current directory for PDF files and uploads each one to the
# newsletter processor, letting Gemini auto-generate the title, summary, and
# tags.  Processed files are moved to a 'done' sub-folder.
#
# Parameters
#   -Type        'typed' or 'handwritten'  (REQUIRED)
#   -ApiUrl      Base URL of the reader-api  (or set SERVICE_URL env var)
#   -ApiKey      RSS_SECRET value            (or set RSS_SECRET env var)
#   -IntervalSec Polling interval in seconds (default: 5)
#   -ExtractOcr  Switch — also extract raw OCR text via Gemini
#
# Usage:
#   .\scripts\bulk-upload-pdfs.ps1 -Type handwritten
#   .\scripts\bulk-upload-pdfs.ps1 -Type typed -ExtractOcr -IntervalSec 10

param(
    [Parameter(Mandatory)]
    [ValidateSet('typed', 'handwritten')]
    [string]$Type,

    [string]$ApiUrl      = $env:SERVICE_URL,
    [string]$ApiKey      = $env:RSS_SECRET,
    [int]   $IntervalSec = 5,
    [switch]$ExtractOcr
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------

if (-not $ApiUrl) {
    Write-Error "API URL is required. Set the SERVICE_URL environment variable or pass -ApiUrl."
    exit 1
}
if (-not $ApiKey) {
    Write-Error "API key is required. Set the RSS_SECRET environment variable or pass -ApiKey."
    exit 1
}

$ApiUrl = $ApiUrl.TrimEnd('/')

# ---------------------------------------------------------------------------
# Ensure 'done' folder exists
# ---------------------------------------------------------------------------

$WatchDir = (Get-Location).Path
$DoneDir  = Join-Path $WatchDir 'done'

if (-not (Test-Path $DoneDir)) {
    New-Item -ItemType Directory -Path $DoneDir | Out-Null
    Write-Host "Created folder: $DoneDir" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Helper — upload a single PDF
# ---------------------------------------------------------------------------

function Invoke-UploadPdf {
    param([string]$FilePath)

    $FileName = Split-Path -Leaf $FilePath
    Write-Host ""
    Write-Host "Processing: $FileName" -ForegroundColor Cyan

    # Step 1 — create article record, get signed upload URL
    $CreateBody = @{
        pdf_type    = $Type
        extract_ocr = $ExtractOcr.IsPresent
        saved       = $true
    } | ConvertTo-Json

    try {
        $CreateResponse = Invoke-RestMethod `
            -Method Post `
            -Uri "$ApiUrl/articles/upload-pdf" `
            -Headers @{ 'x-api-key' = $ApiKey; 'Content-Type' = 'application/json' } `
            -Body $CreateBody
    } catch {
        Write-Warning "  [FAIL] Could not create article record: $_"
        return $false
    }

    $ArticleId = $CreateResponse.id
    $UploadUrl = $CreateResponse.upload_url
    Write-Host "  Article ID : $ArticleId"

    # Step 2 — PUT the PDF bytes directly to the signed GCS URL
    try {
        $PdfBytes = [System.IO.File]::ReadAllBytes($FilePath)
        Invoke-RestMethod `
            -Method Put `
            -Uri $UploadUrl `
            -Headers @{ 'Content-Type' = 'application/pdf' } `
            -Body $PdfBytes | Out-Null
        Write-Host "  Uploaded   : $([math]::Round($PdfBytes.Length / 1KB, 1)) KB"
    } catch {
        Write-Warning "  [FAIL] Could not upload PDF to GCS: $_"
        return $false
    }

    # Step 3 — confirm upload, enqueue Gemini processing
    try {
        Invoke-RestMethod `
            -Method Post `
            -Uri "$ApiUrl/articles/$ArticleId/confirm-upload" `
            -Headers @{ 'x-api-key' = $ApiKey; 'Content-Type' = 'application/json' } `
            -Body '{}' | Out-Null
        Write-Host "  Queued     : Gemini will generate title, summary and tags" -ForegroundColor Green
    } catch {
        Write-Warning "  [FAIL] Could not confirm upload: $_"
        return $false
    }

    return $true
}

# ---------------------------------------------------------------------------
# Watch loop
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== PDF Bulk Upload Watcher ===" -ForegroundColor Cyan
Write-Host "  Type        : $Type"
Write-Host "  Extract OCR : $($ExtractOcr.IsPresent)"
Write-Host "  Watching    : $WatchDir"
Write-Host "  Done folder : $DoneDir"
Write-Host "  Polling     : every ${IntervalSec}s"
Write-Host ""
Write-Host "Press Ctrl+C to stop."
Write-Host ""

while ($true) {
    $PdfFiles = Get-ChildItem -Path $WatchDir -Filter '*.pdf' -File -ErrorAction SilentlyContinue

    foreach ($Pdf in $PdfFiles) {
        $Success = Invoke-UploadPdf -FilePath $Pdf.FullName

        if ($Success) {
            $Dest = Join-Path $DoneDir $Pdf.Name
            # Avoid name collisions in done/
            if (Test-Path $Dest) {
                $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                $Dest  = Join-Path $DoneDir ("$($Pdf.BaseName)_$Stamp$($Pdf.Extension)")
            }
            Move-Item -Path $Pdf.FullName -Destination $Dest
            Write-Host "  Moved      : done\$([System.IO.Path]::GetFileName($Dest))" -ForegroundColor Gray
        }
    }

    Start-Sleep -Seconds $IntervalSec
}
