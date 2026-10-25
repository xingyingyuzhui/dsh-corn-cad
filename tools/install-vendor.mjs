#!/usr/bin/env node
/**
 * Install the vendored DWG decoder into the profile that hosts this plugin.
 *
 * `@mlightcad/libredwg-web` is only needed for .dwg files; .dxf needs nothing.
 * When the plugin is installed through DSH's plugin manager, npm/pnpm fetches it
 * from the registry per `dependencies`. In an offline or locked-down profile that
 * fails, and this script copies the bundled copy into place instead.
 *
 * Usage (from the plugin directory):
 *   node tools/install-vendor.mjs [--profile <name>]
 *
 * Exits 0 when the dependency ends up resolvable, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)
const vendorRoot = path.join(pluginRoot, 'vendor', '@mlightcad', 'libredwg-web')

/** @returns {string|null} already-installed dependency directory, if any. */
function resolvedInstall() {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@mlightcad/libredwg-web')
    return path.dirname(path.dirname(entry))
  } catch {
    return null
  }
}

const already = resolvedInstall()
if (already !== null) {
  console.log('ok   @mlightcad/libredwg-web 已可解析:')
  console.log('     ' + already)
  process.exit(0)
}

if (!fs.existsSync(vendorRoot)) {
  console.error('fail vendor copy missing: ' + vendorRoot)
  console.error('     (this package was built without the offline dependency copy)')
  process.exit(1)
}

// Locate the profile to install into.
const args = process.argv.slice(2)
const at = args.indexOf('--profile')
const explicit = at >= 0 ? args[at + 1] : undefined
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')

let profileDir = null
if (explicit !== undefined) {
  profileDir = path.join(profilesRoot, explicit)
} else {
  // Prefer the profile that already contains this plugin.
  const entries = fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot, { withFileTypes: true }) : []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(profilesRoot, entry.name)
    if (fs.existsSync(path.join(candidate, 'node_modules', 'dsh-corn-cad')) ||
        fs.existsSync(path.join(candidate, 'node_modules', '@local', 'dsh-corn-cad'))) {
      profileDir = candidate
      break
    }
  }
  if (profileDir === null && fs.existsSync(path.join(profilesRoot, 'desktop'))) {
    profileDir = path.join(profilesRoot, 'desktop')
  }
}

if (profileDir === null || !fs.existsSync(profileDir)) {
  console.error('fail cannot locate a DSH profile under ' + profilesRoot)
  console.error('     pass one explicitly: node tools/install-vendor.mjs --profile desktop')
  process.exit(1)
}

const target = path.join(profileDir, 'node_modules', '@mlightcad', 'libredwg-web')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(vendorRoot, target, { recursive: true, force: true })

console.log('ok   copied vendored decoder into:')
console.log('     ' + target)
console.log('')
console.log('next: restart DeepSeek Harness so the host half picks it up.')
