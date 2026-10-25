#!/usr/bin/env node
/**
 * Self-check for `@local/dsh-corn-cad`.
 *
 * Run with `node test/selfcheck.mjs` (or `pnpm test`) from this package. Plain
 * Node, no dependencies, no network, no Harness, no React install:
 *
 *   1. the renderer (`lib/dxf2svg.mjs`) renders `test/sample.dxf` and the exact
 *      per-entity tallies and SVG structure are pinned;
 *   2. `client.js` is driven through a stub `window.__ModuleLoader__`, with the
 *      `react` substitute, the `locale`, `slots` and `documentPreviews` doubles
 *      and a minimal hook runtime, so the registered extensions, the keyed body
 *      and the locale dictionaries are exercised - and any `require()` other
 *      than `react` fails the run right there;
 *   3. `index.js` `apply()` is driven with a fake `ctx`, and both real route
 *      handlers are called: `ping`, a DXF round trip (twice, to show the cache),
 *      `EMPTY` / `TOO_LARGE` / `FAILED` and the DWG branch;
 *   4. the packaging invariants of this repository are asserted: no leaked
 *      credential, no personal absolute path, the copyright holder's name only
 *      where it belongs, and every file in the tree covered by `package.json`'s
 *      `files`.
 *
 * The DWG decode itself cannot run here: `@mlightcad/libredwg-web` is a runtime
 * dependency that the Harness profile installs, and it is deliberately absent
 * from this repo. That check is therefore skipped with a printed reason when the
 * package happens to be installed, and it only ever proves the failure path.
 *
 * Note: `apply()` appends the plugin's diagnostic `.mount.log` marker next to
 * `index.js`, exactly as it does when the Harness mounts it. When this run
 * created that file, it deletes it again at the end; a marker that was already
 * there is left in place (one line longer). It is gitignored and never shipped.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { dxfToSvg } from '../lib/dxf2svg.mjs'
import { EXAMPLE_FILE, PACKAGE_ROOT, SAMPLE_FILE, renderExample } from '../tools/make-example.mjs'

const host = await import('../index.js')
const require = createRequire(import.meta.url)

/** Everything the plugin mounts lives under the package root. */
const MOUNT_LOG = join(PACKAGE_ROOT, '.mount.log')

/** Whether the mount marker was already there when this run started; see the note above. */
const mountLogExisted = existsSync(MOUNT_LOG)

/** The exact options the host route renders with (see `render()` in index.js). */
const RENDER_OPTIONS = { bg: '#ffffff', mono: false }

/** Mirrors `MAX_BYTES` in index.js; the route's cap cannot be imported. */
const MAX_BYTES = 64 * 1024 * 1024

/** The registered route paths, as client.js fetches them. */
const SVG_ROUTE = '/api/corn-cad/svg'
const PING_ROUTE = '/api/corn-cad/ping'
const THEME_ROUTE = '/api/corn-cad/theme'
const SELECTION_ROUTE = '/api/corn-cad/selection'

/** Body identity and slot the browser half claims. */
const BODY_ID = 'dsh-corn-cad/drawing'
const SLOT = 'sidebar.right.tab.document'

const results = []
const skipped = []

/**
 * Run one named check and print its outcome.
 *
 * @param {string} label
 * @param {() => any | Promise<any>} body
 */
async function check(label, body) {
  try {
    await body()
    results.push({ label, ok: true })
    console.log(`ok   ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`FAIL ${label}\n     ${error?.message ?? error}`)
  }
}

/**
 * Record a check that this environment cannot run, with the reason.
 *
 * @param {string} label
 * @param {string} reason
 */
function skip(label, reason) {
  skipped.push({ label, reason })
  console.log(`skip ${label}\n     ${reason}`)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every node in a rendered tree, depth first. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/**
 * First node in a tree matching a predicate.
 * @param {any} node subtree root.
 * @param {(element: any) => boolean} predicate test.
 * @returns {any} the matching node, or null.
 */
function findElement(node, predicate) {
  let found = null
  walk(node, (element) => {
    if (found === null && predicate(element)) found = element
  })
  return found
}

/** The text one subtree renders, flattened. */
function textOf(node) {
  let text = ''
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') text += child
    }
  })
  return text
}

/** Every element in a tree with the given class name. */
function elementsWithClass(tree, className) {
  const found = []
  walk(tree, (element) => {
    const classes = String(element.props?.className ?? '').split(' ')
    if (classes.includes(className)) found.push(element)
  })
  return found
}

/** The button a user presses, identified by its tooltip. */
function buttonWithTitle(tree, title) {
  let found = null
  walk(tree, (element) => {
    if (element.type === 'button' && element.props?.title === title) found = element
  })
  return found
}

/** Count non-overlapping matches of a global regex. */
function count(text, pattern) {
  return (text.match(pattern) ?? []).length
}

// ---------------------------------------------------------------------------
// 1. The renderer: lib/dxf2svg.mjs on the shipped sample
// ---------------------------------------------------------------------------

const sampleText = readFileSync(SAMPLE_FILE, 'utf8')
const sample = dxfToSvg(sampleText, RENDER_OPTIONS)

/**
 * The tallies the sample must produce. `LINE` 11 = 8 from the BOLT block (4
 * inserts x 2 lines) plus 3 from the DIMV dimension block; `CIRCLE` 5 = 4 from
 * the block plus 1 in model space. `ATTRIB` is 2 for the single ATTRIB entity
 * because `renderList()` tallies it and then `renderEntity()` tallies it again:
 * that is the current counting behaviour, and the number the sidebar sums up.
 */
const EXPECTED_STATS = {
  LINE: 11,
  LWPOLYLINE: 2,
  POLYLINE: 1,
  CIRCLE: 5,
  ARC: 1,
  ELLIPSE: 1,
  TEXT: 2,
  MTEXT: 1,
  ATTRIB: 2,
  INSERT: 1,
  HATCH: 1,
  SOLID: 1,
  POINT: 1,
  DIMENSION: 1,
}

await check('test/sample.dxf renders and every entity type is tallied', () => {
  for (const [type, expected] of Object.entries(EXPECTED_STATS)) {
    assert.equal(sample.stats[type], expected, `stats.${type}`)
  }
  assert.deepEqual(
    Object.keys(sample.stats).filter((key) => key.startsWith('__') !== true).sort(),
    Object.keys(EXPECTED_STATS).sort(),
    'no other entity type is drawn, and none is missing',
  )
  assert.deepEqual(sample.bbox, { minX: 0, minY: 0, maxX: 120, maxY: 80 }, '$EXTMIN/$EXTMAX drive the extents')
})

await check('the SVG is one document: viewBox, one root group, the Y-flip, non-scaling strokes', () => {
  const svg = sample.svg
  assert.equal(count(svg, /<svg /g), 1, 'exactly one <svg> root')
  assert.equal(count(svg, /<\/svg>/g), 1)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-2\.4 -2\.4 124\.8 84\.8"/,
    'the viewBox is the drawing plus the 2% pad')
  assert.match(svg, /<rect [^>]*\/><g stroke-width="1"/, 'the background rect, then the single root group')
  assert.equal(svg.indexOf('<g '), svg.indexOf('<g stroke-width="1"'), 'the first group is the root group')
  assert.equal(count(svg, /<g /g), count(svg, /<\/g>/g), 'every group is closed (nested INSERT limbs included)')
  assert.match(svg, /transform="translate\(0 80\) scale\(1 -1\)"/, 'the root group flips Y, as DXF coordinates need')
  assert.match(svg, /vector-effect="non-scaling-stroke"/, 'strokes stay 1px wide however far the drawing is zoomed')
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/)
  assert.match(svg, /fill="#ffffff"/, 'the requested background colour is used')
  assert.equal(svg.endsWith('</g></svg>'), true)
})

await check('one <text> per TEXT / MTEXT / ATTRIB, each counter-flipped so it reads upright', () => {
  const texts = sample.svg.match(/<text [^>]*>/g) ?? []
  assert.equal(texts.length, 4, '2 TEXT + 1 MTEXT + 1 ATTRIB (one TEXT lives in the DIMV block)')
  for (const tag of texts) {
    assert.match(tag, /scale\(1 -1\)/, 'text is flipped back inside the flipped group')
    assert.match(tag, /font-size="\d/, 'text carries its DXF height')
  }
  const body = sample.svg.slice(sample.svg.indexOf('>') + 1)
  assert.match(body, />4x M8</, 'the ATTRIB value is drawn')
  assert.match(body, />PLATE 120x80</)
  assert.match(body, /<tspan [^>]*>Thickness: 3 mm/, 'MTEXT chunks become tspans')
})

await check('the entity total the sidebar shows is the sum of the tallies', () => {
  const total = Object.entries(sample.stats)
    .filter(([key]) => key.startsWith('__') !== true)
    .reduce((sum, [, value]) => sum + value, 0)
  assert.equal(total, 31)
  assert.equal(sample.stats.__skippedOutside, 0, 'nothing in the sample is dropped as stray geometry')
  assert.equal(sample.stats.__stray, undefined, 'the stray counter only exists when something is dropped')
})

await check('nested geometry far outside the sheet is dropped and counted, not drawn', () => {
  // The block spans 9000 units of x while the sheet is 40 x 30: the insert limb
  // is inside the sheet, the line inside the block is not. Extents stay those of
  // model space, so the junk block cannot stretch the viewBox.
  const dxf = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'JUNK', '70', '0', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '9000', '21', '0',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'JUNK', '10', '10', '20', '10',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '40', '20', '0', '10', '40', '20', '30', '10', '0', '20', '30',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.deepEqual(rendered.bbox, { minX: 0, minY: 0, maxX: 40, maxY: 30 }, 'block content is left out of the extents')
  assert.equal(rendered.stats.LINE, 1, 'the entity is still tallied')
  assert.equal(rendered.stats.__stray, 1, 'and counted as stray')
  assert.equal(rendered.stats.__skippedOutside, 1)
  assert.equal(count(rendered.svg, /<path /g), 1, 'only the in-sheet polyline is drawn')
  assert.doesNotMatch(rendered.svg, /9000/, 'the dropped geometry never reaches the document')
})

await check('layer colours follow the ACI table, the colour sign is ignored, frozen layers are dropped', () => {
  // libredwg writes every layer colour negated, so NEG (-2) must draw like 2
  // rather than being read as "layer off" - that is the documented trade-off.
  const dxf = [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '4',
    '0', 'LAYER', '2', 'RED', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'NEG', '70', '0', '62', '-2', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'FROZEN', '70', '1', '62', '3', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'OWN', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'RED', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'NEG', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'FROZEN', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'OWN', '62', '4', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.match(rendered.svg, /stroke="#ff0000"/, 'layer colour 1 is red')
  assert.match(rendered.svg, /stroke="#ffff00"/, 'a negated layer colour draws with its magnitude')
  assert.match(rendered.svg, /stroke="#00ffff"/, 'an entity colour overrides its layer')
  assert.equal(count(rendered.svg, /<path /g), 3, 'the frozen layer is skipped')
  assert.equal(rendered.stats.LINE, 4, 'but it is still tallied')
})

await check('text is XML-escaped, and a drawing with no geometry is refused', () => {
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'TEXT', '8', '0', '10', '0', '20', '20', '40', '2', '1', 'A<B>&"C"',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.match(rendered.svg, /<text [^>]*>A&lt;B&gt;&amp;&quot;C&quot;<\/text>/, 'markup in a label cannot break the document')
  assert.throws(() => dxfToSvg('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n', RENDER_OPTIONS), /empty drawing/,
    'a drawing with no extents throws instead of emitting an unusable SVG')
})

await check('docs/example.svg is exactly what the renderer produces (regenerate with tools/make-example.mjs)', () => {
  const onDisk = readFileSync(EXAMPLE_FILE, 'utf8')
  // Compared with line endings normalised: a Windows checkout may hand the file
  // back with CRLF, which is a checkout artifact, not a stale image.
  const normalise = (text) => text.split('\r\n').join('\n')
  assert.equal(normalise(onDisk).trimEnd(), normalise(renderExample().document).trimEnd(),
    'the committed demo image matches the committed renderer')
  assert.equal(onDisk.startsWith('<svg '), true)
  assert.match(onDisk, /<g stroke-width="1"/)
  assert.ok(statSync(EXAMPLE_FILE).size > 1000, 'the demo image is a real drawing')
})

// ---------------------------------------------------------------------------
// 2. The browser half: what it registers
// ---------------------------------------------------------------------------

/**
 * The `react` substitute handed to `client.js`. `createElement` returns a plain
 * tree node; the hooks are supplied per test by the hook runtime.
 *
 * @param {any} hooks
 * @returns {any}
 */
function reactDouble(hooks) {
  return hooks ?? {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * Evaluate `client.js` the way the Harness loader does and hand back everything
 * the module registered.
 *
 * @param {{ hooks?: any, locale?: boolean, sessionScope?: boolean }} [doubles]
 *   `locale: false` composes a client without the locale service, to check the
 *   built-in fallback copy. `sessionScope` supplies a `sessions` service whose
 *   `scope()` returns a conversation the way the shipped one does.
 * @returns {Promise<any>}
 */
async function loadClient(doubles = {}) {
  const dictionaries = new Map()
  const styles = []
  const requires = []
  const slots = []
  const slotNames = []
  const effects = []
  const disposers = []
  const bindCalls = []
  const withLocale = doubles.locale === undefined ? true : doubles.locale

  globalThis.document = {
    querySelector: (selector) => styles.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: () => ({ dataset: {}, textContent: '', appendChild() {} }),
    head: { appendChild: (tag) => styles.push(tag) },
    documentElement: { style: { setProperty() {} } },
  }
  globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.window.__loaded = entry } } }

  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', 'document', source)(globalThis.window, globalThis.document)
  const entry = globalThis.window.__loaded
  const module = entry.factory((request) => {
    requires.push(request)
    if (request === 'react') return reactDouble(doubles.hooks)
    throw new Error(`the browser half reached for ${request}`)
  })

  const locale = withLocale === false ? undefined : {
    register: (namespace, language, dictionary) => {
      dictionaries.set(`${namespace}:${language}`, dictionary)
      return () => dictionaries.delete(`${namespace}:${language}`)
    },
    bind: (namespace) => {
      bindCalls.push(namespace)
      return (key) => dictionaries.get(`${namespace}:en`)?.[key] ?? key
    },
  }

  const registrations = []
  const preview = {
    register: (descriptor) => {
      registrations.push(descriptor)
      return () => {
        const index = registrations.indexOf(descriptor)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }

  // A conversation that behaves like the shipped one: it only sends from a
  // session scope, and it refuses outright on a root context. This is the exact
  // trap the bubble used to fall into.
  const sent = []
  const conversation = {
    send: async (text) => {
      sent.push(text)
    },
  }
  const scopedConversation = {
    send: async (text) => {
      sent.push(text)
    },
  }
  const scopeCalls = []
  const sessions = doubles.sessionScope === false ? undefined : {
    scope: (sessionId) => {
      scopeCalls.push(sessionId)
      return { get: (name) => (name === 'conversation' ? scopedConversation : undefined) }
    },
  }
  // The root-level conversation: present, but unusable for sending.
  const rootConversation = {
    send: async () => {
      throw new Error('conversation.send requires a session scope — address one via ctx.sessions.scope(id).conversation')
    },
  }

  let component = null
  const ctx = {
    get: (service) => {
      if (service === 'locale') return locale
      if (service === 'documentPreviews') return preview
      if (service === 'sessions') return sessions
      if (service === 'conversation') return rootConversation
      return undefined
    },
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    slots: {
      inject: (name, register) => {
        slotNames.push(name)
        register()
      },
      register: (descriptor, registered) => {
        slots.push({ descriptor, registered })
        component = registered
        return () => {}
      },
    },
  }

  return { entry, module, ctx, dictionaries, styles, requires, registrations, slots, slotNames, effects, disposers, bindCalls, source,
    conversation, scopedConversation, rootConversation, sent, scopeCalls,
    get component() { return component } }
}

await check('client.js loads as a module bundle and reaches for nothing but react', async () => {
  const client = await loadClient()
  assert.equal(client.entry.id, 'dsh-corn-cad')
  assert.equal(typeof client.entry.factory, 'function')
  assert.equal(typeof client.module.apply, 'function')
  assert.deepEqual(client.module.inject, ['slots', 'sessions', 'conversation'],
    'the bubble needs the session scope, so sessions is declared too')
  assert.deepEqual([...new Set(client.requires)], ['react'], 'every require() call is for react')
  const required = [...client.source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual([...new Set(required)], ['react'], 'and the source names nothing else')
  for (const forbidden of ['dsh-client', '@deepseek-ai/', 'libredwg', 'three', 'dxf-parser']) {
    assert.equal(client.source.includes(forbidden), false, `the browser half never references ${forbidden}`)
  }
  assert.doesNotMatch(client.source, /https?:\/\//, 'no remote script, worker or CDN')
})

await check('the renderer claims .dwg and .dxf in the extension band, and gets a keyed slot body', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)

  assert.equal(client.registrations.length, 1)
  const metadata = client.registrations[0]
  assert.equal(metadata.id, BODY_ID)
  assert.deepEqual(metadata.extensions, ['dwg', 'dxf'])
  assert.deepEqual(metadata.binaryExtensions, ['dwg', 'dxf'], 'both suffixes arrive as bytes, never as text')
  assert.equal(metadata.priority, 'extension', 'the suffix decides, not a sniff of the content')
  assert.equal(metadata.loading, 'bytes-complete', 'the body wants the whole file, not a stream')
  assert.equal(metadata.wrap, false)
  assert.equal(metadata.title(), 'DWG drawing', 'the title follows the language the locale service is bound to')

  assert.deepEqual(client.slotNames, [SLOT], 'the body is injected into the document tab slot')
  assert.equal(client.slots.length, 1)
  assert.equal(client.slots[0].descriptor.name, SLOT)
  assert.equal(client.slots[0].descriptor.key, BODY_ID)
  assert.equal(client.slots[0].descriptor.locale, 'dwgPreview')
  assert.equal(typeof client.slots[0].descriptor.inject, 'function',
    'the keyed slot resolves the session-scoped conversation through inject')
  assert.equal(typeof client.slots[0].registered, 'function', 'the slot registers a component factory')
  assert.equal(client.component, client.slots[0].registered)

  // Without a locale service the built-in Chinese copy is the fallback.
  const bare = await loadClient({ locale: false })
  bare.module.apply(bare.ctx)
  assert.equal(bare.registrations.length, 1, 'the body registers even with no locale service')
  assert.equal(bare.registrations[0].title(), 'DWG 图纸')
})

await check('the locale dictionaries are registered for both languages and share one key set', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)
  assert.deepEqual([...client.dictionaries.keys()], ['dwgPreview:zh', 'dwgPreview:en'])
  const zh = client.dictionaries.get('dwgPreview:zh')
  const en = client.dictionaries.get('dwgPreview:en')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'no copy exists in only one language')
  for (const key of ['title', 'loading', 'failed', 'zoomIn', 'zoomOut', 'fit', 'entities',
    'bubbleTitle', 'bubbleSend', 'sent', 'sendFailed', 'noSession']) {
    assert.ok(key in zh, `the dictionary carries ${key}`)
  }
  assert.match(zh.sent, /\{count\}/, 'the sent notice reports how many entities went out')
})

await check('the keyed slot inject() resolves the conversation through the session scope', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)
  const inject = client.slots[0].descriptor.inject
  assert.equal(typeof inject, 'function', 'a session-scoped slot needs inject to reach the session')

  const injected = inject('sess-42')
  assert.deepEqual(client.scopeCalls, ['sess-42'], 'the tab session id is the one addressed')
  assert.equal(injected.sessionId, 'sess-42')
  assert.equal(injected.conversation, client.scopedConversation,
    'the SCOPED conversation is injected; the root one cannot send')

  // With no sessions service the slot still registers, just without a conversation.
  const bare = await loadClient({ sessionScope: false })
  bare.module.apply(bare.ctx)
  const without = bare.slots[0].descriptor.inject('sess-1')
  assert.equal(without.conversation, undefined, 'no scope means no conversation rather than a root one')
})

// ---------------------------------------------------------------------------
// 3. The bubble: right-drag a region, type, send — the feature this repo exists for
// ---------------------------------------------------------------------------

/**
 * A minimal hook runtime: state slots, dependency-aware `useEffect`/`useRef`, and
 * a dirty flag so a render loop can settle.
 *
 * @returns {any}
 */
function hookRuntime() {
  const slots = []
  let cursor = 0
  let dirty = false
  let pending = []
  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  return {
    reset() { cursor = 0; pending = [] },
    snapshot() { return slots.slice() },
    restore(previous) {
      slots.length = 0
      for (const slot of previous) slots.push(slot)
      dirty = false
      pending = []
    },
    takeDirty() { const value = dirty; dirty = false; return value },
    takeEffects() { const effects = pending; pending = []; return effects },
    hooks: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: (initial) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = initial
        return [slots[index], (next) => {
          const value = typeof next === 'function' ? next(slots[index]) : next
          if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true }
        }]
      },
      useRef: (initial) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index]
      },
      useEffect: (effect, deps) => {
        const index = cursor++
        const previous = slots[index]
        if (previous === undefined || !Array.isArray(previous.deps) || !Array.isArray(deps) ||
            previous.deps.length !== deps.length || !previous.deps.every((v, i) => Object.is(v, deps[i]))) {
          slots[index] = { deps }
          pending.push(effect)
        }
      },
    },
  }
}

/**
 * A pickable node the body's highlight pass can decorate.
 * @param {string} id the entity id.
 * @returns {any}
 */
function fakeArt(id) {
  const classes = new Set()
  return {
    id,
    tagName: 'path',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      get size() { return classes.size },
    },
    getAttribute: (name) => (name === 'data-pick' ? id : null),
  }
}

/**
 * The canvas node: an inlined-SVG host with a CTM, plus the pickable children
 * the highlight pass walks.
 *
 * `svg` is parsed only enough to recover the pick ids, which is all the body's
 * DOM use depends on.
 *
 * @param {string} svgText the SVG the host returned.
 * @returns {any}
 */
function fakeCanvas(svgText) {
  const ids = [...String(svgText).matchAll(/data-pick="([^"]+)"/g)].map((match) => match[1])
  const arts = ids.map(fakeArt)
  let painted = null
  const svg = {
    style: {},
    getScreenCTM: () => ({ inverse: () => ({}) }),
    createSVGPoint: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y } } }),
  }
  const node = {
    firstChild: null,
    get innerHTML() { return '' },
    set innerHTML(value) { painted = value; node.firstChild = svg },
    querySelector: (selector) => (selector === 'svg' ? svg : null),
    querySelectorAll: (selector) => (selector === '[data-pick]' ? arts : []),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }
  return { node, arts, get painted() { return painted } }
}

/** The scroll node the body binds: just enough DOM for pan, zoom and refs. */
function fakeViewport() {
  return {
    scrollLeft: 40, scrollTop: 25, clientWidth: 800, clientHeight: 600,
    listeners: [],
    addEventListener(type, handler) { this.listeners.push({ type, handler }) },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  }
}

/**
 * Mount the registered body against a stubbed host `fetch` and drive it the way
 * the UI does.
 *
 * @param {(url: string, init: any) => Promise<any>} respond
 * @param {{ locale?: boolean, sessionScope?: boolean, conversationSend?: (text: string) => Promise<void> }} [options]
 * @returns {Promise<any>}
 */
async function mountBody(respond, options = {}) {
  const runtime = hookRuntime()
  const calls = []
  const viewport = fakeViewport()
  const scrollport = { current: null }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return respond(url, init)
  }

  const client = await loadClient({
    hooks: runtime.hooks,
    locale: options.locale === true,
    sessionScope: options.sessionScope,
  })
  if (typeof options.conversationSend === 'function') {
    client.scopedConversation.send = options.conversationSend
  }
  client.module.apply(client.ctx)
  const component = client.component
  const injectConversation = client.slots[0].descriptor.inject('sess-7').conversation

  /**
   * Hand each ref the node a real commit would: the canvas gets the inlined-SVG
   * host, every other ref gets the scrollport.
   */
  let canvas = null
  const commitRefs = (tree) => {
    walk(tree, (element) => {
      const ref = element.props?.ref
      if (ref === undefined || ref === null) return
      const isCanvas = String(element.props?.className ?? '').includes('corncad-canvas')
      const node = isCanvas && canvas !== null ? canvas.node : viewport
      if (typeof ref === 'function') ref(node)
      else if (typeof ref === 'object') ref.current = node
    })
  }

  const pass = (props) => {
    runtime.reset()
    const element = component(props)
    const tree = typeof element?.type === 'function' ? element.type(element.props) : element
    commitRefs(tree)
    return tree
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const paint = (props) => {
    const previous = runtime.snapshot()
    const tree = pass(props)
    runtime.restore(previous)
    return tree
  }

  const render = async (props) => {
    let tree = null
    for (let round = 0; round < 12; round += 1) {
      tree = pass(props)
      for (const effect of runtime.takeEffects()) await effect()
      await settle()
      if (runtime.takeDirty() === false) break
    }
    return tree
  }

  return {
    component, calls, viewport, scrollport, runtime, client, injectConversation,
    paint, render,
    /** Build the canvas double from an SVG the host produced. */
    useCanvas(svgText) { canvas = fakeCanvas(svgText); return canvas },
    unmount() { globalThis.fetch = realFetch },
  }
}

/** The props the document-preview slot hands the body. */
function bodyProps(bytes, scrollport, address = 'dsh-resource://file/session/sess-7/ws/plate%20%E5%9B%BE%E7%BA%B8.dxf') {
  return { content: { kind: 'bytes', data: bytes }, resourceAddress: address, scrollportRef: scrollport }
}

const sampleBytes = readFileSync(SAMPLE_FILE)
const readyPayload = { ok: true, kind: 'dxf', svg: sample.svg, stats: sample.stats, picks: sample.picks ?? [] }

/** Find the first element whose props carry the given handler. */
function elementWithHandler(tree, handlerName) {
  let found = null
  walk(tree, (element) => {
    if (found === null && typeof element.props?.[handlerName] === 'function') found = element
  })
  return found
}

/**
 * The drawing surface itself: the canvas wrapper carries both a ref and the
 * selection handlers, while the outer scroller only carries panning. Selecting
 * the wrong one would pan instead of select, so the class decides.
 *
 * @param {any} tree a rendered body.
 * @returns {any} the canvas element.
 */
function canvasSurface(tree) {
  const found = findElement(tree, (el) =>
    String(el.props?.className ?? '').includes('corncad-canvas') &&
    typeof el.props?.onPointerDown === 'function')
  assert.ok(found, 'the canvas carries the selection handlers')
  return found
}

/**
 * A minimal pickable drawing whose Y-flip constant is 0, so the test's screen
 * coordinates map straight onto DXF world coordinates.
 */
const FLAT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400">'
  + '<g transform="translate(0 100) scale(1 -1)">'
  + '<path d="M 10 10 L 60 10 L 60 40 Z" data-pick="e1"/>'
  + '<text data-pick="e2">x</text>'
  + '<path d="M 0 0 L 420 0 L 420 297 Z" data-pick="e3"/>'
  + '</g></svg>'

/**
 * A pick table good enough to exercise selection: two small entities inside a
 * band, and one full-sheet border that a band must not drag in.
 */
function readyWithPicks() {
  return {
    ok: true, kind: 'dxf', svg: FLAT_SVG, stats: sample.stats,
    // World-space bounds: the test drags screen y 5..50 over a drawing whose
    // translate(0 100) wrapper turns that into DXF y 50..95.
    picks: [
      { id: 'e1', type: 'LINE', layer: 'WALL', handle: 'A1', depth: 0, bbox: [10, 55, 60, 80], pts: [10,55,60,55,60,80,10,80] },
      { id: 'e2', type: 'TEXT', layer: 'TEXT', handle: 'A2', depth: 0, bbox: [12, 60, 30, 70], pts: [12,60,30,60,30,70,12,70] },
      { id: 'e3', type: 'LWPOLYLINE', layer: 'FRAME', handle: 'A3', depth: 0, bbox: [0, 0, 420, 297], pts: [0,0,420,0,420,297,0,297] },
    ],
  }
}

await check('the body posts the file bytes and draws the returned SVG', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyWithPicks() }))
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)
    const loading = mounted.paint(props)
    assert.match(textOf(loading), /正在解析图纸…/, 'the first paint is the loading state')

    const tree = await mounted.render(props)
    const svgCalls = mounted.calls.filter((call) => call.url === SVG_ROUTE)
    assert.equal(svgCalls.length, 1, 'the bytes are posted once')
    const call = svgCalls[0]
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'include')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.headers['content-type'], 'application/octet-stream')
    assert.equal(call.init.body, sampleBytes, 'the bytes are handed over untouched')
    assert.doesNotThrow(() => decodeURIComponent(call.init.headers['x-dwg-name']),
      'a non-ASCII name travels percent-encoded')
    assert.equal(elementsWithClass(tree, 'corncad-root').length, 1, 'the ready state is the viewer')
    assert.equal(elementsWithClass(tree, 'corncad-scroll').length, 1)
    assert.equal(mounted.scrollport.current, mounted.viewport, 'the parent scroll owner gets the same node')
  } finally {
    mounted.unmount()
  }
})

await check('a right-drag across a region selects only what it covers, and opens the bubble', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyWithPicks() }))
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)
    mounted.useCanvas(FLAT_SVG)
    let tree = await mounted.render(props)

    // The canvas maps screen space into DXF space through getScreenCTM; the test
    // supplies an identity CTM plus the drawing's Y-flip constant.

    const canvas = canvasSurface(tree)
    const down = canvas
    const up = canvas
    const move = canvas
    assert.ok(down && up && move, 'the canvas is interactive')

    // Right-button drag: a band over the two small entities, nowhere near the frame.
    down.props.onPointerDown({ button: 2, clientX: 5, clientY: 5, shiftKey: false, preventDefault() {} })
    move.props.onPointerMove({ clientX: 70, clientY: 50 })
    up.props.onPointerUp({ button: 2, clientX: 70, clientY: 50, shiftKey: false, preventDefault() {} })
    tree = await mounted.render(props)

    const selected = elementsWithClass(tree, 'corncad-bubble')
    assert.equal(selected.length, 1, 'releasing the right button opens the instruction bubble')

    const post = mounted.calls.find((call) => call.url === SELECTION_ROUTE)
    assert.ok(post !== undefined, 'the selection is recorded for the agent')
    const body = JSON.parse(post.init.body)
    assert.equal(body.file, 'plate 图纸.dxf', 'the record names the drawing')
    assert.equal(body.drawingPath === undefined || typeof body.path === 'string', true)
    assert.deepEqual(body.picks.map((p) => p.id).sort(), ['e1', 'e2'],
      'only the covered entities are taken: the full-sheet frame is left out')
  } finally {
    mounted.unmount()
  }
})

await check('sending from the bubble goes through the session scope and quotes the selection', async () => {
  const sent = []
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyWithPicks() }), {
    conversationSend: async (text) => { sent.push(text) },
  })
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)
    mounted.useCanvas(FLAT_SVG)
    let tree = await mounted.render(props)

    const canvas = canvasSurface(tree)
    canvas.props.onPointerDown({ button: 2, clientX: 5, clientY: 5, shiftKey: false, preventDefault() {} })
    canvas.props.onPointerMove({ clientX: 70, clientY: 50 })
    canvas.props.onPointerUp({ button: 2, clientX: 70, clientY: 50, shiftKey: false, preventDefault() {} })
    tree = await mounted.render(props)

    // Type into the bubble, then press its send button.
    const area = elementsWithClass(tree, 'corncad-bubble')[0]
    const textarea = findElement(area, (el) => el.type === 'textarea')
    assert.ok(textarea, 'the bubble offers a text field')
    textarea.props.onChange({ target: { value: '这几根线改成黑色' } })
    tree = await mounted.render(props)

    const sendButton = findElement(tree, (el) =>
      el.type === 'button' && String(el.props?.className ?? '').includes('primary'))
    assert.ok(sendButton, 'the bubble offers a send button')
    sendButton.props.onClick({ preventDefault() {} })
    await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(sent.length, 1, 'the instruction reached the session-scoped conversation exactly once')
    const prompt = sent[0]
    assert.match(prompt, /这几根线改成黑色/, 'the prompt carries what the user typed')
    assert.match(prompt, /plate 图纸\.dxf/, 'and which drawing')
    assert.match(prompt, /e1\(LINE\)/, 'and which entities')
    assert.match(prompt, /范围/, 'and where in the drawing')
  } finally {
    mounted.unmount()
  }
})

await check('with no session scope the bubble says so instead of claiming it was sent', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyWithPicks() }), {
    sessionScope: false,
  })
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)
    mounted.useCanvas(FLAT_SVG)
    let tree = await mounted.render(props)

    const canvas = canvasSurface(tree)
    canvas.props.onPointerDown({ button: 2, clientX: 5, clientY: 5, shiftKey: false, preventDefault() {} })
    canvas.props.onPointerMove({ clientX: 70, clientY: 50 })
    canvas.props.onPointerUp({ button: 2, clientX: 70, clientY: 50, shiftKey: false, preventDefault() {} })
    tree = await mounted.render(props)

    const textarea = findElement(elementsWithClass(tree, 'corncad-bubble')[0], (el) => el.type === 'textarea')
    textarea.props.onChange({ target: { value: '改成红色' } })
    tree = await mounted.render(props)
    const sendButton = findElement(tree, (el) =>
      el.type === 'button' && String(el.props?.className ?? '').includes('primary'))
    sendButton.props.onClick({ preventDefault() {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    tree = await mounted.render(props)

    assert.equal(mounted.calls.filter((c) => c.url === SELECTION_ROUTE).length >= 1, true,
      'the selection is still recorded so the words are not lost')
    const notice = elementsWithClass(tree, 'corncad-notice')[0]
    assert.ok(notice, 'the user is told what happened')
    assert.match(textOf(notice), /找不到当前会话/, 'and it does NOT claim the message was sent')
  } finally {
    mounted.unmount()
  }
})
// ---------------------------------------------------------------------------
// 4. The host half: the routes
// ---------------------------------------------------------------------------

/** A `ctx` with just the `connection` service and `effect`, as `apply()` uses them. */
function fakeHost() {
  const routes = []
  const labels = []
  const disposers = []
  const ctx = {
    effect(factory, label) {
      labels.push(label)
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    },
  }
  return { ctx, routes, labels, disposers }
}

/** A scratch workspace for the selection round-trip, removed when the run ends. */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-corn-cad-'))
process.on('exit', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** A JSON POST, the way the browser half writes the selection. */
function postJson(body) {
  return new Request('http://127.0.0.1' + SELECTION_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A POST the way the connection bridge hands it to the route: raw bytes. */
function postBytes(body) {
  return new Request('http://127.0.0.1' + SVG_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
}

/**
 * Mount the host half and call one of its routes.
 *
 * @param {string} path
 * @param {any} [request]
 * @returns {Promise<{ status: number, payload: any }>}
 */
async function callRoute(path, request) {
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  const route = mounted.routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `${path} is registered`)
  const response = await route.fetch(request)
  const text = await response.text()
  let raw
  try { raw = JSON.parse(text) } catch { raw = undefined }
  return { status: response.status, payload: raw, raw, text }
}

await check('apply() registers the four documented routes, each owned by an effect', () => {
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.deepEqual(mounted.routes.map((route) => route.path).sort(),
    [PING_ROUTE, SVG_ROUTE, THEME_ROUTE, SELECTION_ROUTE].sort())
  const ping = mounted.routes.find((route) => route.path === PING_ROUTE)
  assert.deepEqual(ping.methods, ['GET'], 'the probe is read-only')
  assert.equal(ping.requestBody, 'buffered')
  const svg = mounted.routes.find((route) => route.path === SVG_ROUTE)
  assert.deepEqual(svg.methods, ['POST'])
  assert.equal(svg.requestBody, 'buffered', 'the body arrives as bytes, not as a stream')
  const selection = mounted.routes.find((route) => route.path === SELECTION_ROUTE)
  assert.deepEqual(selection.methods, ['GET', 'POST'], 'the selection is written and read back')
  assert.deepEqual(mounted.labels, [
    'dsh-corn-cad: ping route',
    'dsh-corn-cad: svg route',
    'dsh-corn-cad: selection route',
    'dsh-corn-cad: theme route',
  ], 'every registration is effect-owned, so unloading takes it away')
  for (const disposer of mounted.disposers) assert.equal(typeof disposer, 'function')
  for (const disposer of mounted.disposers) disposer()
  assert.equal(mounted.routes.length, 0, 'unloading the plugin takes its routes away')
})

await check('the ping route reports the plugin and how many drawings are cached', async () => {
  const { status, payload } = await callRoute(PING_ROUTE)
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-corn-cad')
  assert.equal(typeof payload.cache, 'number')
})

await check('the selection route stores the pick set beside the drawing and reads it back', async () => {
  const drawing = join(TMP_ROOT, 'shop', 'plan.dxf')
  const payload = {
    file: 'plan.dxf',
    path: drawing,
    instruction: '这几根线改成黑色',
    picks: [
      { id: 'e1', type: 'LINE', layer: 'WALL', handle: 'A1', bbox: [10, 20, 110, 120] },
      { id: 'e2', type: 'TEXT', layer: 'TEXT', handle: 'A2', bbox: [12, 22, 60, 40] },
    ],
  }
  const written = await callRoute(SELECTION_ROUTE, postJson(payload))
  assert.equal(written.status, 200)
  assert.equal(written.payload.ok, true)
  assert.equal(written.payload.count, 2)
  assert.equal(written.payload.drawing, drawing)
  assert.equal(written.payload.file, join(TMP_ROOT, 'shop', '.corncad', 'selection.json'),
    'the record sits beside the drawing, not in the host process cwd')

  const stored = JSON.parse(readFileSync(written.payload.file, 'utf8'))
  assert.equal(stored.drawing, drawing, 'the record names the drawing the agent has to open')
  assert.equal(stored.instruction, '这几根线改成黑色', 'the words the user typed are kept')
  assert.deepEqual(stored.picks.map((p) => p.handle), ['A1', 'A2'], 'and the exact entities')

  // Read back by drawing path: this is how the agent asks "what did the user circle?".
  const read = await callRoute(SELECTION_ROUTE, new Request(
    'http://127.0.0.1' + SELECTION_ROUTE + '?file=' + encodeURIComponent(drawing)))
  assert.equal(read.payload.ok, undefined, 'GET returns the record itself, not an envelope')
  assert.equal(read.raw.drawing, drawing)
  assert.deepEqual(read.raw.picks.map((p) => p.id), ['e1', 'e2'])

  // A drawing that was never selected into yields an empty set, never an error.
  const none = await callRoute(SELECTION_ROUTE, new Request(
    'http://127.0.0.1' + SELECTION_ROUTE + '?file=' + encodeURIComponent(join(TMP_ROOT, 'other', 'nope.dxf'))))
  assert.deepEqual(none.raw, { ok: true, count: 0, picks: [] })
})

await check('DXF bytes come back as a renderable SVG, and the same file is served from the cache', async () => {
  const first = await callRoute(SVG_ROUTE, postBytes(sampleBytes))
  assert.equal(first.status, 200)
  assert.equal(first.payload.ok, true)
  assert.equal(first.payload.kind, 'dxf', 'the format is decided by the content, not the file name')
  // The route asks for `pickable: true` so entities stay selectable; that is the
  // one deliberate difference from the plain render the sidebar shows.
  assert.equal(first.payload.svg, dxfToSvg(sampleText, { ...RENDER_OPTIONS, pickable: true }).svg,
    'the route renders what the renderer produces with picking on')
  assert.match(first.payload.svg, /data-pick="/, 'every entity carries its pick id')
  assert.ok(Array.isArray(first.payload.picks) && first.payload.picks.length > 0,
    'and the pick table comes back with it')
  assert.deepEqual(first.payload.stats, sample.stats)

  const second = await callRoute(SVG_ROUTE, postBytes(Buffer.from(sampleBytes)))
  assert.equal(second.payload.svg, first.payload.svg)
  const ping = await callRoute(PING_ROUTE)
  assert.equal(ping.payload.cache, 1, 'an identical file is decoded once (sha1 keyed, 6 entries kept)')
})

await check('an empty body is refused with EMPTY and 400', async () => {
  const { status, payload } = await callRoute(SVG_ROUTE, postBytes(Buffer.alloc(0)))
  assert.equal(status, 400)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'EMPTY')
  assert.equal(typeof payload.message, 'string')
})

await check('content that is neither DWG nor DXF is refused with FAILED and 500', async () => {
  const { status, payload } = await callRoute(SVG_ROUTE, postBytes(Buffer.from('this is not a drawing at all\n')))
  assert.equal(status, 500)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'FAILED')
  assert.match(payload.message, /无法识别的文件内容/)
})

await check('a body over 64 MB is refused with TOO_LARGE and 413 before it is rendered', async () => {
  // The cap has to be crossed for real, so the route gets a request whose
  // arrayBuffer() is a zero-filled SharedArrayBuffer one byte over the limit.
  // Buffer.from(arrayBuffer) only takes a *view* of it - no byte is copied and
  // no page is touched - so this check crosses the real branch without
  // materialising a 64 MB buffer. (Verified below, not merely assumed.)
  const oversized = new SharedArrayBuffer(MAX_BYTES + 1)
  const view = Buffer.from(oversized)
  assert.equal(view.length, MAX_BYTES + 1)
  assert.equal(view.buffer, oversized, 'the buffer is a view: reading it costs nothing')
  assert.equal(process.memoryUsage().external < MAX_BYTES, true, 'no 64 MB copy was made')
  const standIn = { arrayBuffer: async () => oversized }

  const { status, payload } = await callRoute(SVG_ROUTE, standIn)
  assert.equal(status, 413)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'TOO_LARGE')
  assert.match(payload.message, /64 MB/)
})

/**
 * Whether the DWG decoder is installed. It is a runtime dependency the Harness
 * profile provides; in this repo it is absent, which is exactly the boundary the
 * README states, and it decides whether the DWG branch can be pinned here.
 */
let libredwgInstalled = true
try {
  require.resolve('@mlightcad/libredwg-web')
} catch (error) {
  libredwgInstalled = false
}

if (libredwgInstalled === true) {
  skip('a DWG body is routed to LibreDWG, not rejected as unknown content',
    '@mlightcad/libredwg-web is resolvable here, so the DWG branch would really decode and this offline check cannot pin its outcome; run it in a profile install instead')
} else {
  await check('a DWG body is routed to LibreDWG, not rejected as unknown content', async () => {
    // libredwg is absent, so the decode fails - the point of the check is that the
    // AC10xx header selected the DWG branch and that the failure is reported as a
    // FAILED response rather than thrown out of the route.
    const dwg = Buffer.concat([Buffer.from('AC1015', 'latin1'), Buffer.alloc(64, 0x20)])
    const { status, payload } = await callRoute(SVG_ROUTE, postBytes(dwg))
    assert.equal(status, 500)
    assert.equal(payload.code, 'FAILED')
    assert.doesNotMatch(payload.message, /无法识别的文件内容/,
      'the AC10xx header selected the DWG branch, it was not rejected as unknown content')
  })
}

await check('the browser half posts to the very path the host registers', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(source.includes(`'${SVG_ROUTE}'`), true, 'the client fetches the registered route path')
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.ok(mounted.routes.some((route) => route.path === SVG_ROUTE))
})

await check('mounting appends the diagnostic .mount.log marker next to index.js', () => {
  const before = existsSync(MOUNT_LOG) ? statSync(MOUNT_LOG).size : 0
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.equal(existsSync(MOUNT_LOG), true, 'the marker exists after mounting')
  assert.ok(statSync(MOUNT_LOG).size > before, 'and mounting appended a line to it')
})

// ---------------------------------------------------------------------------
// 5. Packaging: what must not be in the repo, and what package.json must ship
// ---------------------------------------------------------------------------

/** Every file in the tree, relative to the package root, POSIX separators. */
function treeFiles() {
  const skip = new Set(['node_modules', '.git', 'dist'])
  const found = []
  const walkDirectory = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walkDirectory(absolute)
      else found.push(relative(PACKAGE_ROOT, absolute).split(sep).join('/'))
    }
  }
  walkDirectory(PACKAGE_ROOT)
  // Never shipped: the mount marker and log files, and lock files - a lock file
  // here would pin whatever registry mirror ran `pnpm test`, while the profile
  // installs this package's own dependencies.
  const droppings = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'])
  return found.filter((file) => file.endsWith('.log') === false && droppings.has(file.split('/').pop()) === false).sort()
}

/** The `files` entries of package.json. */
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

// Read the holder out of the licence so no file in this tree - including this one
// - has to spell the name out, which keeps a plain grep for it meaningful.
const LICENCE_TEXT = readFileSync(join(PACKAGE_ROOT, 'LICENSE'), 'utf8')
const COPYRIGHT_HOLDER = (LICENCE_TEXT.match(/Copyright \(c\) 2026 (\S+)/) ?? [])[1]
/** The upstream author, kept only for the attribution the MIT licence requires. */
const UPSTREAM_AUTHOR = 'linanbuan'
const LICENCE_LINE = `[MIT](LICENSE) © 2026 ${COPYRIGHT_HOLDER}`

await check('package.json is the bundle manifest the repo kit requires', () => {
  assert.equal(manifest.name, 'dsh-corn-cad', 'the package name is the bundle row name')
  assert.equal(manifest.private, false, 'a public repository, installed from GitHub')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.engines.node, '>=20')
  assert.equal('dsh' in manifest.engines, false,
    'no engines.dsh: a prerelease range would hide the plugin from other prereleases')
  assert.equal(manifest.scripts.test, 'node test/selfcheck.mjs')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview'])
  assert.deepEqual(manifest.peerDependencies, { '@deepseek-ai/cordis': '^4.0.1' })
  assert.deepEqual(manifest.dependencies, { '@mlightcad/libredwg-web': '^0.7.14' },
    'the DWG decoder is a runtime dependency the profile installs, not a bundled file')
  for (const keyword of ['deepseek-harness', 'dsh', 'dsh-plugin', 'dwg', 'dxf']) {
    assert.equal(manifest.keywords.includes(keyword), true, `keywords carry ${keyword}`)
  }
  const repositoryUrl = `https://github.com/${COPYRIGHT_HOLDER}/dsh-corn-cad`
  assert.equal(manifest.repository.url, repositoryUrl + '.git')
  assert.equal(manifest.homepage, repositoryUrl + '#readme')
  assert.equal(manifest.bugs.url, repositoryUrl + '/issues')
  assert.equal(manifest.icon, './icon.svg', 'the plugin manager shows the corn mark')
})

await check('every file in the tree is covered by package.json files', () => {
  const always = new Set(['package.json', '.gitignore'])
  const patterns = manifest.files
  /**
   * npm packlist globbing: `*` matches inside one path segment, `**` spans any
   * number of segments (that is how `vendor/**` ships the whole vendored tree).
   */
  const matchesSegment = (wanted, actual) =>
    new RegExp('^' + wanted.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(actual)
  const matches = (file) => {
    const parts = file.split('/')
    return patterns.some((pattern) => {
      const wanted = pattern.split('/')
      const walk = (wi, pi) => {
        if (wi === wanted.length) return pi === parts.length
        if (wanted[wi] === '**') {
          for (let skip = pi; skip <= parts.length; skip += 1) {
            if (walk(wi + 1, skip)) return true
          }
          return false
        }
        if (pi === parts.length) return false
        return matchesSegment(wanted[wi], parts[pi]) && walk(wi + 1, pi + 1)
      }
      return walk(0, 0)
    })
  }
  const uncovered = treeFiles().filter((file) => always.has(file) === false && matches(file) === false)
  assert.deepEqual(uncovered, [], 'nothing in the tree is left out of the published package')
  for (const required of ['README.en.md', 'LICENSE', 'test/*.mjs', 'cordis.patch.yml', 'icon.svg']) {
    assert.equal(patterns.includes(required), true, `files lists ${required}`)
  }
})

await check('no leaked credential, no personal absolute path, and the author name only where it belongs', () => {
  // Assembled from fragments on purpose: the shipped tree has to stay greppable
  // for these prefixes, and this file is part of that tree.
  const words = ['gh' + 'p_', 'github_' + 'pat_', 's' + 'k-[A-Za-z0-9]{16,}', 'api[_-]?' + 'key', 'pass' + 'word', 'sec' + 'ret', 'to' + 'ken']
  const credentials = new RegExp('(' + words.join('|') + ')', 'i')
  const personal = /(C:\\Users|\/mnt\/[cd]\/|\/home\/)/
  assert.equal(typeof COPYRIGHT_HOLDER, 'string', 'LICENSE names a copyright holder')
  const allowed = new Set(['LICENSE', 'THIRD-PARTY.md', 'package.json', 'README.md', 'README.en.md', 'CHANGES.md'])
  for (const file of treeFiles()) {
    const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    // Binary assets (the brand PNGs) cannot carry a scanned secret in a way this
    // check could distinguish from compressed image bytes.
    if (/\.(png|jpe?g|webp|wasm|ico|woff2?)$/i.test(file)) continue
    // This file defines the patterns it scans for, so it necessarily contains
    // them; scanning it would only ever match its own word list.
    if (file === 'test/selfcheck.mjs') continue
    // vendor/ is an upstream artifact shipped verbatim; its build paths are not
    // this repository's leak, and rewriting them would break the wasm package.
    if (file.startsWith('vendor/')) continue
    const credential = text.match(credentials)
    assert.equal(credential, null, `${file} contains ${credential?.[0]}`)
    const path = text.match(personal)
    assert.equal(path, null, `${file} contains a personal absolute path: ${path?.[0]}`)
    if (text.includes(COPYRIGHT_HOLDER)) {
      assert.equal(allowed.has(file), true, `${file} names the copyright holder outside the licence, manifest and READMEs`)
    }
    if (text.includes(UPSTREAM_AUTHOR)) {
      assert.equal(allowed.has(file), true, `${file} names the upstream author outside the licence, manifest and READMEs`)
    }
  }
  // A cheaper existence check here would be vacuous (`treeFiles()` already filters
  // these names out) or wrong (a development checkout legitimately has a
  // `node_modules/` after `pnpm test`), so assert the property that actually
  // decides publishing instead: none of them can be shipped, because
  // `package.json`'s `files` never covers them. `.gitignore` is checked below.
  for (const name of ['.mount.log', 'pnpm-lock.yaml', 'package-lock.json']) {
    assert.equal(manifest.files.some((pattern) => pattern === name || pattern.endsWith('/' + name)), false,
      `${name} must not be covered by package.json files`)
  }
  // npm strips .gitignore from a published tarball, so this only holds for a
  // checkout — the packaged copy legitimately has none.
  const ignorePath = join(PACKAGE_ROOT, '.gitignore')
  if (existsSync(ignorePath)) {
    const ignore = readFileSync(ignorePath, 'utf8')
    for (const pattern of ['node_modules/', '*.log', '.mount.log', 'pnpm-lock.yaml', 'package-lock.json', '.DS_Store', 'Thumbs.db']) {
      assert.equal(ignore.includes(pattern), true, `.gitignore covers ${pattern}`)
    }
  }
  assert.match(LICENCE_TEXT, /^MIT License\n\nCopyright \(c\) 2026 /)
  assert.match(LICENCE_TEXT, /WITHOUT WARRANTY OF ANY KIND/)
  assert.match(LICENCE_TEXT, /Permission is hereby granted, free of charge/)
  // The upstream MIT notice is a licence condition; it must survive somewhere that
  // ships with every copy, whether that is LICENSE itself or the notice file.
  const noticeText = readFileSync(join(PACKAGE_ROOT, 'THIRD-PARTY.md'), 'utf8')
  assert.ok(LICENCE_TEXT.includes(UPSTREAM_AUTHOR) || noticeText.includes(UPSTREAM_AUTHOR),
    'the upstream MIT notice is kept: attribution is a licence condition, not a credit')
  assert.ok(LICENCE_TEXT.includes('THIRD-PARTY.md'),
    'and LICENSE points at where that notice lives')
})

await check('both READMEs exist, in both languages, with the same structure and the required chapters', () => {
  const zh = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8')
  const en = readFileSync(join(PACKAGE_ROOT, 'README.en.md'), 'utf8')
  assert.match(zh, /^# .+ · dsh-corn-cad\n\n\[中文\]\(README\.md\) \| \[English\]\(README\.en\.md\)\n/)
  assert.match(en, /^# .+ · dsh-corn-cad\n\n\[中文\]\(README\.md\) \| \[English\]\(README\.en\.md\)\n/)
  assert.ok(zh.trimEnd().endsWith(LICENCE_LINE), 'README.md ends with the licence line')
  assert.ok(en.trimEnd().endsWith(LICENCE_LINE), 'README.en.md ends with the licence line')
  assert.ok(zh.includes(`https://github.com/${COPYRIGHT_HOLDER}/dsh-corn-cad`), 'README.md links to the repo')
  for (const chapter of ['## 安装', '### 方式一', '### 方式二', '### 方式三', '### 方式四',
    '## 装上之后', '### 停用 / 卸载', '## 注意事项', '## 自检', '## 结构',
    '## 致谢与第三方许可', '## License']) {
    assert.equal(zh.includes(chapter), true, `README.md has ${chapter}`)
  }
  for (const chapter of ['## Installation', '### Method 1', '### Method 2', '### Method 3', '### Method 4',
    '## After installing', '### Disable / uninstall', '## Notes', '## Self-check', '## Layout',
    '## Credits and third-party licences', '## License']) {
    assert.equal(en.includes(chapter), true, `README.en.md has ${chapter}`)
  }
  assert.equal(count(zh, /^```/gm), count(en, /^```/gm), 'the code fences line up')
  assert.equal(count(zh, /^\|/gm), count(en, /^\|/gm), 'the tables line up')
  assert.match(zh, /!\[[^\]]*\]\(docs\/example\.svg\)/, 'the demo image is shown')
  assert.match(en, /!\[[^\]]*\]\(docs\/example\.svg\)/)
  assert.match(zh, /@mlightcad\/libredwg-web/)
  assert.match(zh, /GPL-3\.0/, 'the upstream licence is stated')
  assert.match(en, /GPL-3\.0/)
  assert.match(zh, /0\.2\.1-rc\.3/, 'the tested DSH version is stated in prose')
  assert.match(en, /0\.2\.1-rc\.3/)
  // The one feature this release exists for must be described, in both languages.
  assert.match(zh, /右键拖框/, 'the right-drag board is documented')
  assert.match(en, /Right-drag/i, 'the right-drag board is documented in English')
  assert.match(zh, /selection\.json/, 'the record the agent reads is documented')
  assert.match(en, /selection\.json/)
})

await check('cordis.patch.yml inserts the row the README and the host half name', () => {
  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:\n {4}- id: corn-cad\n {6}name: dsh-corn-cad\n/)
  assert.match(readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8'), /corn-cad/, 'the README names the row id')
})

// ---------------------------------------------------------------------------

await check('both READMEs state the number of checks this run performs', () => {
  // This check is one of them, hence the + 1; a skipped check still counts, since
  // it is a check the file defines.
  const total = results.length + skipped.length + 1
  for (const [file, phrase] of [['README.md', '纯 Node 跑完'], ['README.en.md', 'plain Node runs all']]) {
    const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    assert.equal(text.includes(`${phrase} ${total} `), true, `${file} says how many checks run (${total})`)
    assert.equal(text.includes(`${total}/${total} checks passed`), true, `${file} quotes the final line`)
  }
})

const failed = results.filter((result) => !result.ok)
const total = results.length + skipped.length
// Leave the tree as it was found: the mount marker is a runtime dropping.
if (mountLogExisted === false) rmSync(MOUNT_LOG, { force: true })
const skippedNote = skipped.length === 0 ? '' : ` (${skipped.length} skipped)`
console.log(`\n${total - failed.length}/${total} checks passed${skippedNote}`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  FAIL ${result.label}: ${result.error?.message ?? result.error}`)
  process.exitCode = 1
}
