# tag-untagged.ps1 - Calls /articles/:id/describe for every article with 0 or 1 tag.
# The describe endpoint generates a summary + suggested tag via Gemini and applies
# the tag automatically (for 0-tag articles it sets it; for 1-tag articles this
# script patches it in after reading the response).
#
# Usage: .\scripts\tag-untagged.ps1
# Optional: .\scripts\tag-untagged.ps1 -DelayMs 2000 -DryRun

param(
  [int]$DelayMs = 1500,  # Pause between API calls to avoid hammering Gemini
  [switch]$DryRun        # Print what would happen without calling the API
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

$dbUrl        = $env:TURSO_DATABASE_URL -replace '^libsql://', 'https://'
$dbToken      = $env:TURSO_AUTH_TOKEN
$summarizeUrl = $env:SUMMARIZE_URL
$secret       = $env:RSS_SECRET
$serviceUrl   = $env:SERVICE_URL

if (-not $dbUrl -or -not $dbToken)      { throw 'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set in .env' }
if (-not $summarizeUrl)                  { throw 'SUMMARIZE_URL not set in .env' }
if (-not $secret)                        { throw 'RSS_SECRET not set in .env' }

$dbApiBase  = "$dbUrl/v2/pipeline"
$dbHeaders  = @{ Authorization = "Bearer $dbToken"; 'Content-Type' = 'application/json' }
$apiHeaders = @{ 'X-Api-Key' = $secret; 'Content-Type' = 'application/json' }

# -- DB helper -----------------------------------------------------------------
function Invoke-Sql([string]$Sql) {
  $body = '{"requests":[{"type":"execute","stmt":{"sql":' + ($Sql | ConvertTo-Json) + '}},{"type":"close"}]}'
  $resp = Invoke-RestMethod -Uri $dbApiBase -Method Post -Headers $dbHeaders -Body $body
  return $resp.results[0].response.result
}

# -- Find articles with 0 or 1 tag --------------------------------------------
# tags is stored as a JSON array string e.g. '[]' or '["foo"]'
Write-Host 'Fetching articles with 0 or 1 tag...'
$result = Invoke-Sql "SELECT id, title, tags, content_type FROM articles WHERE json_array_length(tags) <= 1 ORDER BY id"

if ($result.rows.Count -eq 0) {
  Write-Host 'No articles found with 0 or 1 tag. Nothing to do.'
  exit 0
}

Write-Host "$($result.rows.Count) articles to process`n"

$tagged = 0; $skipped = 0; $failed = 0

foreach ($row in $result.rows) {
  $id          = [int]$row[0].value
  $title       = $row[1].value
  $tagsJson    = $row[2].value
  $contentType = $row[3].value

  $currentTags = @()
  try { $currentTags = [string[]]($tagsJson | ConvertFrom-Json) } catch {}
  $tagCount = $currentTags.Count

  Write-Host "  [$id] $title"
  Write-Host "        tags=$tagsJson  type=$contentType"

  if ($DryRun) {
    Write-Host "        DRY RUN - would call GET $summarizeUrl/articles/$id/describe"
    $skipped++
    continue
  }

  # Skip content types that can't be described (no URL to fetch)
  if ($contentType -in @('video', 'podcast', 'other')) {
    Write-Host "        SKIP - content type '$contentType' not supported by describe"
    $skipped++
    continue
  }

  try {
    # Call describe endpoint - generates summary + suggestedTag via Gemini.
    # For 0-tag articles the endpoint sets the tag automatically.
    # For 1-tag articles we patch it in ourselves using the returned suggestedTag.
    $describeResp = Invoke-RestMethod -Uri "$summarizeUrl/articles/$id/describe" `
      -Method Get -Headers $apiHeaders

    $suggestedTag = $describeResp.suggestedTag

    if ($tagCount -eq 1 -and $suggestedTag -and $suggestedTag -notin $currentTags) {
      # describe endpoint only auto-applies when there are 0 tags, so we patch for the 1-tag case
      $newTags     = $currentTags + $suggestedTag
      $patchBody   = @{ tags = $newTags } | ConvertTo-Json -Compress
      $patchUrl    = if ($serviceUrl) { "$serviceUrl/articles/$id" } else { "$summarizeUrl/articles/$id" }
      Invoke-RestMethod -Uri $patchUrl -Method Patch -Headers $apiHeaders -Body $patchBody | Out-Null
      Write-Host "        OK   tag added: $suggestedTag (kept existing: $($currentTags[0]))"
    } else {
      Write-Host "        OK   tag applied: $suggestedTag"
    }

    $tagged++
  } catch {
    Write-Host "        FAIL - $($_.Exception.Message)"
    $failed++
  }

  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}

Write-Host ''
Write-Host "Done. Tagged: $tagged  |  Skipped: $skipped  |  Failed: $failed  |  Total: $($result.rows.Count)"
