# import-pocket.ps1 - One-off Pocket CSV importer
# Usage: .\scripts\import-pocket.ps1 -CsvPath "C:\path\to\pocket.csv"
# Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from .env in the project root.

param(
  [Parameter(Mandatory)][string]$CsvPath,
  [int]$UrlTimeoutSec = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Load .env -----------------------------------------------------------------
$envFile = Join-Path (Join-Path $PSScriptRoot '..') '.env'
if (-not (Test-Path $envFile)) { throw "Could not find .env at $envFile" }

foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+)$') {
    [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim())
  }
}

$dbUrl   = $env:TURSO_DATABASE_URL -replace '^libsql://', 'https://'
$dbToken = $env:TURSO_AUTH_TOKEN
if (-not $dbUrl -or -not $dbToken) { throw 'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set in .env' }

$apiBase = "$dbUrl/v2/pipeline"
$headers = @{ Authorization = "Bearer $dbToken"; 'Content-Type' = 'application/json' }

# -- Turso helper: executes a single SQL statement ----------------------------
# Strings in $Sql must be pre-escaped with EscSql before interpolation.
function Invoke-Sql([string]$Sql) {
  $body = '{"requests":[{"type":"execute","stmt":{"sql":' + ($Sql | ConvertTo-Json) + '}},{"type":"close"}]}'
  $resp = Invoke-RestMethod -Uri $apiBase -Method Post -Headers $headers -Body $body
  return $resp.results[0].response.result
}

# Escapes a string value for safe embedding in a SQL single-quoted literal.
function EscSql([string]$s) { $s -replace "'", "''" }

# -- Ensure Pocket newsletter row exists --------------------------------------
$existing = Invoke-Sql "SELECT id FROM newsletters WHERE name = 'Pocket' LIMIT 1"
if ($existing.rows.Count -gt 0) {
  $newsletterId = [long]$existing.rows[0][0].value
  Write-Host "Using existing Pocket newsletter (id=$newsletterId)"
} else {
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Invoke-Sql "INSERT INTO newsletters (name, received_at) VALUES ('Pocket', '$now')" | Out-Null
  $row = Invoke-Sql 'SELECT last_insert_rowid()'
  $newsletterId = [long]$row.rows[0][0].value
  Write-Host "Created Pocket newsletter (id=$newsletterId)"
}

# -- Load existing URLs to skip duplicates ------------------------------------
$existingUrls = @{}
$urlRows = Invoke-Sql 'SELECT url FROM articles'
foreach ($r in $urlRows.rows) { $existingUrls[$r[0].value] = $true }
Write-Host "$($existingUrls.Count) existing article URLs loaded"

# -- Import CSV ----------------------------------------------------------------
$csv = Import-Csv -Path $CsvPath
$total = $csv.Count
$imported = 0; $skippedDupe = 0; $skippedUrl = 0

Write-Host "Processing $total rows from $CsvPath"
Write-Host ''

foreach ($row in $csv) {
  $url   = $row.url.Trim()
  $title = $row.title.Trim()
  if (-not $title) { $title = $url }

  # Skip duplicates
  if ($existingUrls.ContainsKey($url)) {
    Write-Host "  SKIP (duplicate) $url"
    $skippedDupe++
    continue
  }

  # Test URL reachability
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = 'HEAD'
    $req.Timeout = $UrlTimeoutSec * 1000
    $req.UserAgent = 'Mozilla/5.0 (compatible; PocketImporter/1.0)'
    $req.AllowAutoRedirect = $true
    $response = $req.GetResponse()
    $statusCode = [int]$response.StatusCode
    $response.Close()
    if ($statusCode -ge 400) { throw "HTTP $statusCode" }
  } catch {
    Write-Host "  SKIP (url error) $url -- $($_.Exception.Message)"
    $skippedUrl++
    continue
  }

  # Convert Unix timestamp to ISO datetime
  $epoch   = [int64]$row.time_added
  $created = [System.DateTimeOffset]::FromUnixTimeSeconds($epoch).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

  # Map status: Pocket uses 'unread' / 'archive'
  $status = if ($row.status -eq 'archive') { 'read' } else { 'unread' }

  # Tags: Pocket comma-separates them; store as JSON array
  $tags = '[]'
  if ($row.tags -and $row.tags.Trim()) {
    $tagArray = ($row.tags.Trim() -split '[,\s]+') | Where-Object { $_ } | ForEach-Object { '"' + (EscSql $_) + '"' }
    $tags = '[' + ($tagArray -join ',') + ']'
  }

  $sql = "INSERT INTO articles (newsletter_id, title, summary, url, created_at, status, tags, content_type, saved) " +
         "VALUES ($newsletterId, '$(EscSql $title)', '', '$(EscSql $url)', '$created', '$status', '$(EscSql $tags)', 'article', 1)"

  try {
    Invoke-Sql $sql | Out-Null
    $existingUrls[$url] = $true
    Write-Host "  OK   $url"
    $imported++
  } catch {
    Write-Host "  FAIL (db error) $url -- $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host "Done. Imported: $imported  |  Skipped (duplicate): $skippedDupe  |  Skipped (bad URL): $skippedUrl  |  Total: $total"
