#!/usr/bin/env node
/**
 * Converts assets/icon.png → assets/icon.ico (multi-resolution: 16,32,48,256)
 * Uses PowerShell + System.Drawing on Windows (no extra npm deps).
 * Run: node scripts/build-icons.cjs
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const iconPng = path.join(root, 'assets', 'icon.png')
const iconIco = path.join(root, 'assets', 'icon.ico')

if (!fs.existsSync(iconPng)) {
  console.log('assets/icon.png not found — skipping icon conversion.')
  process.exit(0)
}

// PowerShell script that creates a proper multi-size ICO using .NET System.Drawing
// Sizes: 16, 32, 48, 256 — PNG-compressed inside ICO (Windows Vista+ format)
const psScript = `
Add-Type -AssemblyName System.Drawing

$srcPath  = '${iconPng.replace(/\\/g, '\\\\')}'
$dstPath  = '${iconIco.replace(/\\/g, '\\\\')}'
$sizes    = @(16, 32, 48, 256)

$src = [System.Drawing.Image]::FromFile($srcPath)

# Collect PNG-compressed frames for each size
$frames = @()
foreach ($sz in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $sz, $sz)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $frames += ,$ms.ToArray()
  $ms.Dispose()
}
$src.Dispose()

# Build ICO binary
$out = New-Object System.IO.MemoryStream
$w   = New-Object System.IO.BinaryWriter($out)

# ICO header
$w.Write([uint16]0)               # Reserved
$w.Write([uint16]1)               # Type = ICO
$w.Write([uint16]$sizes.Count)    # Image count

# Directory entries: header=6 bytes, each entry=16 bytes
$dataOffset = 6 + ($sizes.Count * 16)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz   = $sizes[$i]
  $data = $frames[$i]
  $bVal = if ($sz -eq 256) { [byte]0 } else { [byte]$sz }
  $w.Write($bVal)                      # Width  (0 = 256)
  $w.Write($bVal)                      # Height (0 = 256)
  $w.Write([byte]0)                    # Color count (true color)
  $w.Write([byte]0)                    # Reserved
  $w.Write([uint16]1)                  # Planes
  $w.Write([uint16]32)                 # Bits per pixel
  $w.Write([uint32]$data.Length)       # Size of image data
  $w.Write([uint32]$dataOffset)        # Offset of image data
  $dataOffset += $data.Length
}

# Image data
foreach ($data in $frames) { $w.Write($data) }
$w.Flush()

[System.IO.File]::WriteAllBytes($dstPath, $out.ToArray())
Write-Host "Created $dstPath ($($out.Length) bytes)"
$out.Dispose()
`

try {
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', psScript
  ], { stdio: 'inherit' })
} catch (err) {
  console.error('PowerShell ICO creation failed:', err.message)
  process.exit(1)
}
