<#
.SYNOPSIS
  Speichert ein Bild aus der Zwischenablage als assets\icon.png

  Anleitung:
  1. Rechtsklick auf das Panda-Bild im Chat -> "Bild kopieren"
  2. In diesem Ordner: .\save-icon.ps1 ausfuehren
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$img = [System.Windows.Forms.Clipboard]::GetImage()
if (-not $img) {
    Write-Host "Kein Bild in der Zwischenablage. Bitte erst das Bild kopieren!" -ForegroundColor Red
    exit 1
}

$assetsDir = Join-Path $PSScriptRoot "assets"
if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir | Out-Null }

$outPath = Join-Path $assetsDir "icon.png"
$img.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Gespeichert: $outPath" -ForegroundColor Green
Write-Host "Jetzt: npm run build:icons" -ForegroundColor Cyan
