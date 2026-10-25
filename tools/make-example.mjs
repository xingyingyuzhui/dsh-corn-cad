#!/usr/bin/env node
/**
 * Regenerate `docs/example.svg` from `test/sample.dxf`.
 *
 * The README shows this file as the demo image, so it must stay exactly what the
 * shipped renderer produces: both halves go through `dxfToSvg()` with the same
 * options the host route uses, and the renderer is pure (no clock, no random, no
 * platform lookup), so the same input always yields byte-identical output.
 *
 *   node tools/make-example.mjs
 *
 * Importing this module is side-effect free; only running it writes the file.
 *
 * @module tools/make-example
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dxfToSvg } from '../lib/dxf2svg.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Package root, i.e. the directory holding `package.json`. */
export const PACKAGE_ROOT = resolve(here, '..')

/** The sample drawing the self-check and the demo image both use. */
export const SAMPLE_FILE = join(PACKAGE_ROOT, 'test', 'sample.dxf')

/** The rendered demo image referenced by the README. */
export const EXAMPLE_FILE = join(PACKAGE_ROOT, 'docs', 'example.svg')

/**
 * Render the sample drawing the way the host route renders a preview.
 *
 * @returns {{ document: string, svg: string, stats: object, bbox: object }} `document`
 *   is the exact byte string written to disk (the SVG plus one trailing newline).
 */
export function renderExample() {
  const text = readFileSync(SAMPLE_FILE, 'utf8')
  const { svg, stats, bbox } = dxfToSvg(text, { bg: '#ffffff', mono: false })
  return { document: svg + '\n', svg, stats, bbox }
}

/** Write the demo image and report where it went. */
function main() {
  const { document, stats, bbox } = renderExample()
  if (document.startsWith('<svg ') !== true || document.endsWith('</svg>\n') !== true) {
    throw new Error('the renderer did not produce a complete SVG document')
  }
  mkdirSync(dirname(EXAMPLE_FILE), { recursive: true })
  writeFileSync(EXAMPLE_FILE, document, 'utf8')
  const entities = Object.entries(stats)
    .filter(([key]) => key.startsWith('__') !== true)
    .reduce((total, [, value]) => total + value, 0)
  console.log(`wrote ${EXAMPLE_FILE}`)
  console.log(`  bytes: ${Buffer.byteLength(document, 'utf8')}`)
  console.log(`  entities: ${entities} (${Object.keys(stats).length} stat keys)`)
  console.log(`  bbox: ${bbox.minX},${bbox.minY} .. ${bbox.maxX},${bbox.maxY}`)
  console.log(`  source: ${SAMPLE_FILE}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
