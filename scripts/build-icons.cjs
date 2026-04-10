#!/usr/bin/env node
/**
 * Converts assets/icon.png → assets/icon.ico (multi-resolution)
 * Run: node scripts/build-icons.cjs
 */
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
const iconPng = path.join(root, 'assets', 'icon.png')
const iconIco = path.join(root, 'assets', 'icon.ico')

if (!fs.existsSync(iconPng)) {
  console.log('assets/icon.png not found — skipping icon conversion.')
  process.exit(0)
}

const pngToIco = require('png-to-ico')
pngToIco([iconPng])
  .then((buf) => {
    fs.writeFileSync(iconIco, buf)
    console.log(`Created assets/icon.ico (${buf.length} bytes)`)
  })
  .catch((err) => {
    console.error('Icon conversion failed:', err.message)
    process.exit(1)
  })
