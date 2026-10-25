#!/usr/bin/env node
/**
 * Install this checkout into the Desktop profile WITHOUT disturbing the profile's
 * existing bundles.
 *
 * The sibling lab pattern (`dsh-restart/scripts/install-desktop-local.mjs`)
 * rewrites `dsh.profile.bundles` from a two-entry base list, which silently drops
 * every other installed plugin. This profile carries thirteen entries, so that
 * script is not safe to run here. This one reads the current manifest, appends
 * only this package, and leaves `dependencies` and every other bundle untouched.
 *
 * Quit DeepSeek Harness completely (Cmd+Q) before running: the host half is a
 * process-level module, so a running app cannot pick it up.
 *
 *   node scripts/install-desktop-local.mjs [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const profile = join(homedir(), '.dsh', 'profiles', 'desktop')
const localDir = join(profile, '.dsh-local-plugins')
const tarballName = `${pkg.name}-${pkg.version}.tgz`
const tarballPath = join(localDir, tarballName)
const dryRun = process.argv.includes('--dry-run')
// --force installs while the app runs: the files land on disk and the next launch
// picks them up, but the host half cannot mount until then.
const force = process.argv.includes('--force')

if (!existsSync(join(profile, 'package.json'))) {
  console.error(`Desktop profile missing: ${profile}`)
  process.exit(1)
}

let appRunning = false
if (!dryRun) {
  const running = spawnSync('pgrep', ['-f', 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'], { encoding: 'utf8' })
  appRunning = running.status === 0
  if (appRunning && !force) {
    console.error('Quit DeepSeek Harness completely (Cmd+Q) before installing into the Desktop profile.')
    console.error('Pass --force to write the files anyway; they take effect on the next launch.')
    process.exit(2)
  }
}

const manifestPath = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []

// Refuse to continue if the plug-in is already listed under a different name; a
// second row would mount the host half twice and double-register its routes.
const nameCollisions = bundles.filter((entry) => entry === pkg.name)
console.log(JSON.stringify({
  event: 'dsh-corn-cad.install.plan',
  profile,
  package: `${pkg.name}@${pkg.version}`,
  alreadyListed: nameCollisions.length > 0,
  bundlesBefore: bundles.length,
  bundles: bundles,
}, null, 2))

if (dryRun) {
  console.log('\n--dry-run: nothing written')
  process.exit(0)
}

mkdirSync(localDir, { recursive: true })
const cache = mkdtempSync(join(tmpdir(), 'corncad-pack-'))
const pack = spawnSync('npm', ['pack', '--cache', cache, '--pack-destination', localDir], {
  cwd: root,
  encoding: 'utf8',
})
rmSync(cache, { recursive: true, force: true })
if (pack.status !== 0) {
  console.error(pack.stdout || pack.stderr)
  process.exit(pack.status ?? 1)
}
if (!existsSync(tarballPath)) {
  console.error(`expected pack output at ${tarballPath}`)
  process.exit(1)
}
console.log(`packed ${tarballName}`)

// Dependencies: keep every existing entry, add (or repoint) only this package.
const before = { ...(manifest.dependencies ?? {}) }
manifest.dependencies = { ...before, [pkg.name]: `file:./.dsh-local-plugins/${tarballName}` }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const install = spawnSync('pnpm', ['install', '--config.strict-dep-builds=false', '--no-frozen-lockfile'], {
  cwd: profile,
  encoding: 'utf8',
  env: { ...process.env, CI: '' },
})
process.stdout.write(install.stdout || '')
process.stderr.write(install.stderr || '')
if (install.status !== 0) {
  // Leave the manifest usable even when the install fails.
  manifest.dependencies = before
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.exit(install.status ?? 1)
}

// Pin the exact installed version, as the lab scripts do, but keep the bundle
// order stable and append this package only if it is not already there.
const pins = { ...manifest.dependencies }
pins[pkg.name] = pkg.version
manifest.dependencies = pins
const nextBundles = bundles.includes(pkg.name) ? bundles : [...bundles, pkg.name]
manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: nextBundles } }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const installedDir = join(profile, 'node_modules', ...pkg.name.split('/'))
console.log(JSON.stringify({
  event: 'dsh-corn-cad.install.done',
  profile,
  package: `${pkg.name}@${pkg.version}`,
  tarball: tarballPath,
  installedAt: installedDir,
  installed: existsSync(join(installedDir, 'index.js')),
  bundlesBefore: bundles.length,
  bundlesAfter: nextBundles.length,
  added: nextBundles.filter((entry) => !bundles.includes(entry)),
  restartRequired: appRunning,
  ok: true,
}, null, 2))
