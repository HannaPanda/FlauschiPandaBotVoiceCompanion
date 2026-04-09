<#
.SYNOPSIS
    Build, tag, push, and download the Voice Companion portable exe.

.PARAMETER Minor
    Bump the minor version (default behaviour).

.PARAMETER Major
    Bump the major version.

.PARAMETER Patch
    Bump the patch version.

.PARAMETER Version
    Set a specific version string (e.g. "2.1.0").

.PARAMETER Force
    Skip the uncommitted-changes check.

.PARAMETER SkipWait
    Do not wait for the GitHub release asset to appear.
#>
param(
    [switch]$Minor,
    [switch]$Major,
    [switch]$Patch,
    [string]$Version = "",
    [switch]$Force,
    [switch]$SkipWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ────────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "    ERR $msg" -ForegroundColor Red }

# ── 1. uncommitted changes ─────────────────────────────────────────────────────

Write-Step "Checking for uncommitted changes"
$status = git status --porcelain 2>&1
if ($status -and -not $Force) {
    Write-Err "Uncommitted changes detected. Use -Force to override."
    exit 1
}
Write-OK "Working tree clean"

# ── 2. typecheck ──────────────────────────────────────────────────────────────

Write-Step "Running typecheck"
npm run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Err "Typecheck failed. Aborting."
    exit 1
}
Write-OK "Types OK"

# ── 3. version bump ───────────────────────────────────────────────────────────

Write-Step "Bumping version"
$pkgJson   = Get-Content "package.json" -Raw | ConvertFrom-Json
$current   = [version]$pkgJson.version
$major     = $current.Major
$minor     = $current.Minor
$patch     = $current.Build

if ($Version -ne "") {
    $newVersion = $Version
} elseif ($Major) {
    $newVersion = "$($major + 1).0.0"
} elseif ($Patch) {
    $newVersion = "$major.$minor.$($patch + 1)"
} else {
    # default: Minor
    $newVersion = "$major.$($minor + 1).0"
}

Write-OK "Version: $current -> $newVersion"

# Write back
$pkgRaw = Get-Content "package.json" -Raw
$pkgRaw = $pkgRaw -replace "`"version`": `"$($pkgJson.version)`"", "`"version`": `"$newVersion`""
Set-Content "package.json" $pkgRaw -NoNewline

# ── 4. git commit + tag ───────────────────────────────────────────────────────

Write-Step "Committing and tagging v$newVersion"
git add package.json
git commit -m "chore: release v$newVersion"
git tag "v$newVersion"
git push
git push --tags
Write-OK "Pushed v$newVersion"

# ── 5. optional: wait for release asset ───────────────────────────────────────

if ($SkipWait) {
    Write-Host "`nSkipping wait. Done." -ForegroundColor Yellow
    exit 0
}

# Extract GitHub token from remote URL (https://USER:TOKEN@github.com/ORG/REPO)
$remoteUrl = git remote get-url origin
$repoPath  = ""
$token     = ""

if ($remoteUrl -match "https://[^:]+:([^@]+)@github\.com/(.+?)(?:\.git)?$") {
    $token    = $Matches[1]
    $repoPath = $Matches[2]
} elseif ($remoteUrl -match "https://github\.com/(.+?)(?:\.git)?$") {
    $repoPath = $Matches[1]
} elseif ($remoteUrl -match "git@github\.com:(.+?)(?:\.git)?$") {
    $repoPath = $Matches[1]
} else {
    Write-Err "Cannot parse remote URL: $remoteUrl"
    exit 1
}

Write-Step "Waiting for GitHub Actions to publish release asset..."
Write-Host "    Repo : $repoPath"
Write-Host "    Tag  : v$newVersion"

$headers = @{ "User-Agent" = "deploy.ps1" }
if ($token -ne "") { $headers["Authorization"] = "token $token" }

$assetUrl    = ""
$maxWait     = 900   # 15 minutes
$elapsed     = 0
$pollInterval = 15

while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $pollInterval
    $elapsed += $pollInterval

    try {
        $release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$repoPath/releases/tags/v$newVersion" `
            -Headers $headers `
            -ErrorAction Stop

        $asset = $release.assets | Where-Object { $_.name -eq "Voice-Companion-portable.exe" }
        if ($asset) {
            $assetUrl = $asset.browser_download_url
            break
        }
    } catch {
        # release not yet created — keep waiting
    }

    Write-Host "    Waiting... ($elapsed s elapsed)"
}

if ($assetUrl -eq "") {
    Write-Err "Timed out waiting for release asset."
    exit 1
}

# ── 6. download to Desktop ────────────────────────────────────────────────────

Write-Step "Downloading Voice-Companion-portable.exe to Desktop"
$dest = Join-Path $env:USERPROFILE "Desktop\Voice-Companion-portable.exe"

$dlHeaders = @{ "User-Agent" = "deploy.ps1" }
if ($token -ne "") { $dlHeaders["Authorization"] = "token $token" }

Invoke-WebRequest -Uri $assetUrl -Headers $dlHeaders -OutFile $dest
Write-OK "Saved to: $dest"

Write-Host "`nRelease v$newVersion complete!" -ForegroundColor Green
