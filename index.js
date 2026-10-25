/**
 * DWG / DXF sidebar preview - host half.
 *
 * Registers two read-only routes on the connection's shared /api channel:
 *
 *   GET  /api/corn-cad/ping  - liveness probe (is the plugin mounted?)
 *   POST /api/corn-cad/svg   - DWG or DXF bytes in, renderable SVG out
 *
 * The DWG is decoded by LibreDWG compiled to WebAssembly (@mlightcad/libredwg-web),
 * which runs inside this host process; the resulting DXF is turned into SVG by the
 * local, dependency-free renderer in ./lib/dxf2svg.mjs. Nothing is written to disk
 * and no external converter is required.
 *
 * @module dsh-corn-cad
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { dxfToSvg } from './lib/dxf2svg.mjs'

/** Plugin name; also the bundle row id in cordis.patch.yml. */
export const name = 'dsh-corn-cad'

/** The connection service owns the /api channel these routes register on. */
export const inject = ['connection']

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Upper bound for a preview request body (bytes). */
const MAX_BYTES = 64 * 1024 * 1024

/** How many rendered drawings stay cached. */
const CACHE_LIMIT = 6

/** Upper bound on entities recorded for one selection round-trip. */
const SELECTION_LIMIT = 500

/** sha1 -> { kind, svg, stats } */
const cache = new Map()

/**
 * Locate the LibreDWG wasm directory inside the installed package.
 * @returns {string} directory ending in a separator, as emscripten expects.
 */
function wasmDirectory() {
  const entry = require.resolve('@mlightcad/libredwg-web')
  return path.join(path.dirname(entry), '..', 'wasm') + path.sep
}

/** Lazily instantiated LibreDWG module (its wasm is ~9.5 MB, so build it once). */
let enginePromise
function engine() {
  if (enginePromise === undefined) {
    enginePromise = import('@mlightcad/libredwg-web').then((mod) => mod.LibreDwg.create(wasmDirectory()))
  }
  return enginePromise
}

/**
 * Decide what the bytes are from their content, not from the file name.
 * @param {Buffer} buf
 * @returns {'dwg' | 'dxf' | 'unknown'}
 */
function sniff(buf) {
  const head = buf.subarray(0, 8).toString('latin1')
  if (/^AC10\d\d/.test(head)) return 'dwg'
  const text = buf.subarray(0, 8192).toString('utf8')
  if (text.includes('SECTION') && (text.includes('HEADER') || text.includes('ENTITIES'))) return 'dxf'
  return 'unknown'
}

/**
 * Map a DXF `$DWGCODEPAGE` value to a WHATWG encoding label.
 *
 * DXF R12–R2004 store text as raw bytes in the file's code page; the code page
 * is declared in the header (`ANSI_936` = GBK, `ANSI_950` = Big5, …). Reading
 * such a file as UTF-8 mangles every non-ASCII character, which is why Chinese
 * drawings came back as U+FFFD soup. R2007+ (AC1021+) is UTF-8 by definition.
 *
 * @param {string} raw the declared code page, e.g. 'ANSI_936'.
 * @param {number} version ACAD version code from `$ACADVER`, when known.
 * @returns {string | null} a TextDecoder label, or null for UTF-8.
 */
function codepageEncoding(raw, version) {
  // AC1021 (R2007) and later are always UTF-8 regardless of the header value.
  if (Number.isFinite(version) && version >= 1021) return null
  const table = {
    ANSI_936: 'gbk',
    ANSI_950: 'big5',
    ANSI_932: 'shift_jis',
    ANSI_949: 'euc-kr',
    ANSI_1250: 'windows-1250',
    ANSI_1251: 'windows-1251',
    ANSI_1252: 'windows-1252',
    ANSI_1253: 'windows-1253',
    ANSI_1254: 'windows-1254',
    ANSI_1255: 'windows-1255',
    ANSI_1256: 'windows-1256',
    ANSI_1257: 'windows-1257',
    ANSI_1258: 'windows-1258',
    ANSI_874: 'windows-874',
  }
  return table[raw] ?? null
}

/**
 * Decode DXF bytes using the file's own declared code page.
 *
 * @param {Buffer | Uint8Array} bytes raw DXF bytes.
 * @returns {string} decoded text.
 */
function decodeDxf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  // The header lives at the very start, so a shallow ASCII scan is enough.
  const head = buf.subarray(0, Math.min(buf.length, 16 * 1024)).toString('latin1')
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/.exec(head)
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d+)/.exec(head)
  const label = codepageEncoding(cp?.[1] ?? '', ver === null ? NaN : Number(ver[1]))
  if (label === null) return buf.toString('utf8')
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    // Unknown/unsupported label on an old Node build — fall back rather than fail.
    return buf.toString('utf8')
  }
}

/**
 * Preview theme. Overridable from the profile's cordis.patch.yml:
 *
 *   - id: corn-cad
 *     config:
 *       background: '#000000'
 *       foreground: '#ffffff'
 *
 * `foreground` is what ACI 7 (and BYLAYER/BYBLOCK that resolves to 7) is drawn
 * with. AutoCAD's colour 7 is "black or white, whichever contrasts with the
 * background", so the pair has to move together — a black background with the
 * default black foreground would make every line invisible.
 */
const DEFAULT_THEME = { background: '#ffffff', foreground: '#000000' }

/** Live theme, replaced by apply() when the profile supplies a config block. */
let theme = { ...DEFAULT_THEME }

/**
 * Normalise a user-supplied colour to `#rrggbb`, or return the fallback.
 * @param {unknown} value raw config value.
 * @param {string} fallback colour to use when the value is unusable.
 * @returns {string}
 */
function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const v = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase()
  if (/^[0-9a-fA-F]{6}$/.test(v)) return '#' + v.toLowerCase()
  return fallback
}

/**
 * Convert DWG/DXF bytes into a single renderable SVG document.
 * @param {Buffer} buf raw file bytes.
 * @returns {Promise<{ kind: string, svg: string, stats: object }>}
 */
async function render(buf) {
  const kind = sniff(buf)
  let dxfText
  if (kind === 'dwg') {
    const libredwg = await engine()
    const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const out = libredwg.dwg_write_dxf(view)
    if (out === null || out === undefined || out.length === 0) {
      throw new Error('LibreDWG 无法解析这个 DWG（版本过旧或不支持的对象）')
    }
    // LibreDWG emits its DXF with the original code page header intact, so the
    // same detection applies.
    dxfText = decodeDxf(out)
  } else if (kind === 'dxf') {
    dxfText = decodeDxf(buf)
  } else {
    throw new Error('无法识别的文件内容：既不是 DWG（缺少 AC10xx 头）也不是 DXF')
  }
  const rendered = dxfToSvg(dxfText, { bg: theme.background, fg: theme.foreground, mono: false, pickable: true })
  return { kind, svg: rendered.svg, stats: rendered.stats, picks: rendered.picks ?? [] }
}

/**
 * JSON response helper.
 * @param {unknown} payload
 * @param {number} [status]
 * @returns {Response}
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Handler for POST /api/corn-cad/svg.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSvg(request) {
  try {
    const buf = Buffer.from(await request.arrayBuffer())
    if (buf.length === 0) return json({ ok: false, code: 'EMPTY', message: '文件内容为空' }, 400)
    if (buf.length > MAX_BYTES) return json({ ok: false, code: 'TOO_LARGE', message: '文件超过 64 MB，预览已跳过' }, 413)
    const key = crypto.createHash('sha1').update(buf).digest('hex')
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = await render(buf)
      cache.set(key, entry)
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next()
        if (oldest.done === true) break
        cache.delete(oldest.value)
      }
    }
    return json({ ok: true, kind: entry.kind, svg: entry.svg, stats: entry.stats, picks: entry.picks })
  } catch (error) {
    return json({ ok: false, code: 'FAILED', message: String((error && error.message) || error) }, 500)
  }
}

/**
 * Where a selection is written so the agent can read it back.
 *
 * The panel is a browser view with no channel of its own into the conversation,
 * so the picked entities land in a small JSON file next to the drawing itself.
 * Any tool that can read files (or the agent itself) then knows exactly what the
 * user circled: which drawing, entity id, kind, layer, handle, world-space
 * bounds, and the conversation they typed.
 *
 * The record is written beside the .dxf/.dwg so the agent finds it without
 * being told a path, and it never pollutes the drawing's own folder with more
 * than one dot-directory: <drawing dir>/.dsh-corn-cad/selection.json
 *
 * @param {string} drawingPath absolute path of the drawing, when the browser knew it.
 * @returns {string} absolute path of the record.
 */
function selectionFile(drawingPath) {
  const base = typeof drawingPath === 'string' && drawingPath !== ''
    ? path.dirname(drawingPath)
    : process.cwd()
  return path.join(base, '.corncad', 'selection.json')
}

/**
 * Handler for POST /api/corn-cad/selection.
 *
 * Body: { file?, path?, instruction?, picks: [{ id, type, layer, handle, bbox, pts }] }
 *
 * `path` is the drawing's absolute path when the browser could resolve it; the
 * record then lands beside that drawing. Without it the workspace cwd is used.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSelection(request) {
  try {
    const body = await request.json()
    const picks = Array.isArray(body?.picks) ? body.picks.slice(0, SELECTION_LIMIT) : []
    const drawingPath = typeof body?.path === 'string' ? body.path : ''
    const record = {
      at: new Date().toISOString(),
      // What the agent needs to answer "which drawing, which part".
      drawing: drawingPath,
      file: typeof body?.file === 'string' ? body.file : (drawingPath === '' ? '' : path.basename(drawingPath)),
      instruction: typeof body?.instruction === 'string' ? body.instruction : '',
      count: picks.length,
      picks,
    }
    const target = selectionFile(drawingPath)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, JSON.stringify(record, null, 2), 'utf8')
    return json({ ok: true, count: record.count, file: target, drawing: drawingPath })
  } catch (error) {
    return json({ ok: false, code: 'FAILED', message: String((error && error.message) || error) }, 500)
  }
}

/**
 * Handler for GET /api/corn-cad/selection.
 *
 * `?file=<absolute drawing path>` reads the record stored beside that drawing;
 * without it the workspace cwd record is returned. This is how the agent gets
 * the selection without knowing where the panel last wrote it.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSelectionRead(request) {
  try {
    let drawingPath = ''
    try {
      const url = new URL(request.url)
      drawingPath = url.searchParams.get('file') ?? ''
    } catch {
      // A request without a parseable URL still reads the cwd record.
    }
    const target = selectionFile(drawingPath)
    const text = await fs.promises.readFile(target, 'utf8')
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch {
    return json({ ok: true, count: 0, picks: [] })
  }
}

/**
 * Mount the plugin's routes.
 * @param {any} ctx plugin context.
 * @param {{ background?: string, foreground?: string }} [config] profile config.
 */
export function apply(ctx, config = {}) {
  // Take the theme from the profile config; unknown values fall back rather than
  // producing an unreadable (e.g. black-on-black) preview.
  theme = {
    background: normalizeColor(config?.background, DEFAULT_THEME.background),
    foreground: normalizeColor(config?.foreground, DEFAULT_THEME.foreground),
  }
  try {
    fs.appendFileSync(path.join(here, '.mount.log'), new Date().toISOString() + '\n')
  } catch (error) {
    /* the marker is only a diagnostic; never let it break mounting */
  }
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/corn-cad/ping',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => json({ ok: true, plugin: name, cache: cache.size, background: theme.background, foreground: theme.foreground }),
      }),
    'dsh-corn-cad: ping route',
  )
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/corn-cad/svg',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleSvg(request),
      }),
    'dsh-corn-cad: svg route',
  )
  // Selection round-trip: the browser posts what the user clicked, the host
  // writes it where the agent can read it.
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/corn-cad/selection',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => (request.method === 'POST' ? handleSelection(request) : handleSelectionRead(request)),
      }),
    'dsh-corn-cad: selection route',
  )
  // Tell the browser half which background to paint behind the drawing, so the
  // panel chrome matches the SVG instead of flashing white around it.
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/corn-cad/theme',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => json({ ok: true, background: theme.background, foreground: theme.foreground }),
      }),
    'dsh-corn-cad: theme route',
  )
}
