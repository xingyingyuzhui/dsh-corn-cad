
// Dependency-free DXF (ASCII) -> SVG renderer for preview use.
// Entities: LINE, LWPOLYLINE, POLYLINE+VERTEX, CIRCLE, ARC, ELLIPSE, TEXT, MTEXT,
// ATTRIB, INSERT (nested, arrays), HATCH (polyline and edge boundary paths),
// DIMENSION (via its anonymous block), SOLID/3DFACE, POINT.

const ACI_HEX = (() => {
  const t = new Array(256).fill('#000000');
  const base = ['#000000','#ff0000','#ffff00','#00ff00','#00ffff','#0000ff','#ff00ff','#ffffff','#808080','#c0c0c0'];
  for (let i = 0; i < 10; i++) t[i] = base[i];
  for (let i = 250; i < 256; i++) { const v = Math.round(255 * (i - 249) / 6).toString(16).padStart(2, '0'); t[i] = '#' + v + v + v; }
  const lv = [1.0, 0.72, 0.5, 0.95, 0.46];
  for (let i = 10; i <= 249; i++) {
    const g = Math.floor((i - 10) / 10), j = (i - 10) % 10;
    t[i] = hslHex((g * 15) % 360, (j % 2 === 0) ? 1 : 0.55, (lv[Math.min(Math.floor(j / 2), 4)] ?? 0.7) * 0.5);
  }
  return t;
})();

function hslHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function parsePairs(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

function splitSections(pairs) {
  const out = {};
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === 'SECTION') {
      const name = ((pairs[i + 1] && pairs[i + 1][1]) || '').trim();
      i += 2;
      const start = i;
      while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) i++;
      out[name] = pairs.slice(start, i);
    }
    i++;
  }
  return out;
}

function splitEntities(pairs) {
  const out = [];
  let cur = null;
  for (const [code, raw] of pairs) {
    const v = raw.replace(/\r$/, '');
    if (code === 0) { if (cur) out.push(cur); cur = { type: v.trim(), codes: [] }; }
    else if (cur) cur.codes.push([code, v]);
  }
  if (cur) out.push(cur);
  return out;
}

const num = (e, code, def = 0) => { for (const [c, v] of e.codes) if (c === code) { const n = parseFloat(v); if (!Number.isNaN(n)) return n; } return def; };
const str = (e, code, def = '') => { for (const [c, v] of e.codes) if (c === code) return v.trim(); return def; };
const all = (e, code) => e.codes.filter(([c]) => c === code).map(([, v]) => v);
const fmt = (n) => { const r = Math.round(n * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Resolve the escapes AutoCAD leaves inside TEXT/MTEXT payloads.
 *
 * Two forms show up in real drawings and neither is legal text:
 *  - `\U+XXXX` — a private Unicode escape AutoCAD writes when the code page
 *    cannot carry the character (very common in Chinese drawings: the header
 *    says ANSI_936 but the run is stored as `\U+8BF4\U+660E`).
 *  - `%%c` / `%%d` / `%%p` / `%%%` — the classic font control codes for
 *    diameter, degree, plus-minus and percent.
 *
 * @param {string} s raw payload.
 * @returns {string} the same text with readable characters.
 */
function resolveEscapes(s) {
  return String(s)
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%[cC]/g, '\u2300')   // diameter
    .replace(/%%[dD]/g, '\u00b0')   // degree
    .replace(/%%[pP]/g, '\u00b1')   // plus/minus
    .replace(/%%%/g, '%');
}

function cleanMtext(s) {
  return resolveEscapes(String(s))
    .replace(/\\P/gi, '\n')
    .replace(/\\[AaCcFfHhQqTtWw][^;\\]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\~/g, ' ')
    .trim();
}

function seg(a, b, bulge) {
  if (!bulge) return 'L ' + fmt(b.x) + ' ' + fmt(b.y);
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord === 0) return 'L ' + fmt(b.x) + ' ' + fmt(b.y);
  const r = Math.abs(chord / (2 * Math.sin(Math.abs(theta) / 2)));
  const large = Math.abs(theta) > Math.PI ? 1 : 0;
  const sweep = theta > 0 ? 1 : 0;
  return 'A ' + fmt(r) + ' ' + fmt(r) + ' 0 ' + large + ' ' + sweep + ' ' + fmt(b.x) + ' ' + fmt(b.y);
}

function polyPath(points, closed) {
  if (!points.length) return '';
  let d = 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
  for (let i = 1; i < points.length; i++) d += ' ' + seg(points[i - 1], points[i], points[i - 1].bulge);
  if (closed && points.length > 2) d += ' ' + seg(points[points.length - 1], points[0], points[points.length - 1].bulge) + ' Z';
  return d;
}

const TAU = Math.PI * 2;
function arcPoints(cx, cy, r, a0Deg, a1Deg, ccw, steps) {
  let a0 = a0Deg * Math.PI / 180, a1 = a1Deg * Math.PI / 180;
  if (ccw) { while (a1 < a0) a1 += TAU; } else { while (a1 > a0) a1 -= TAU; }
  const n = steps || Math.max(4, Math.min(64, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18))));
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), bulge: 0 }); }
  return pts;
}

function arcPath(cx, cy, r, a0, a1) {
  let s = a0 * Math.PI / 180, e = a1 * Math.PI / 180;
  while (e <= s) e += TAU;
  const p0 = { x: cx + r * Math.cos(s), y: cy + r * Math.sin(s) };
  const p1 = { x: cx + r * Math.cos(e), y: cy + r * Math.sin(e) };
  const large = (e - s) > Math.PI ? 1 : 0;
  return 'M ' + fmt(p0.x) + ' ' + fmt(p0.y) + ' A ' + fmt(Math.abs(r)) + ' ' + fmt(Math.abs(r)) + ' 0 ' + large + ' 1 ' + fmt(p1.x) + ' ' + fmt(p1.y);
}

function parseLayers(pairs) {
  const layers = new Map();
  if (!pairs) return layers;
  for (const e of splitEntities(pairs)) {
    if (e.type !== 'LAYER') continue;
    // libredwg writes every layer colour negated (= "off" in DXF) even when the DWG layer is on,
    // so the sign is ignored and the colour magnitude is used.
    // A negative colour index means the layer is off, per the DXF spec — but
    // libredwg negates EVERY layer colour when it converts a DWG, so taken
    // literally that reading hides the whole drawing. The sign is therefore only
    // trusted when it discriminates: if some layers are positive, the negatives
    // are genuinely off; if every layer is negative, the sign is the converter's
    // quirk and is ignored. Resolved once the table is complete.
    const rawLayerColor = num(e, 62, 7);
    layers.set(str(e, 2), {
      color: Math.abs(rawLayerColor) || 7,
      raw: rawLayerColor,
      off: false,
      frozen: (num(e, 70, 0) & 1) === 1,
    });
  }
  return layers;
}

function parseBlocks(pairs) {
  const blocks = new Map();
  if (!pairs) return blocks;
  let name = null, base = { x: 0, y: 0 }, list = [];
  for (const e of splitEntities(pairs)) {
    if (e.type === 'BLOCK') { name = str(e, 2); base = { x: num(e, 10), y: num(e, 20) }; list = []; }
    else if (e.type === 'ENDBLK') { if (name !== null) blocks.set(name, { base, entities: list }); name = null; list = []; }
    else if (name !== null) list.push(e);
  }
  return blocks;
}

function headerExtents(headerPairs) {
  if (!headerPairs) return null;
  let min = null, max = null;
  for (let i = 0; i < headerPairs.length; i++) {
    if (headerPairs[i][0] !== 9) continue;
    const n = headerPairs[i][1].trim();
    if (n === '$EXTMIN' && headerPairs[i + 1] && headerPairs[i + 2]) min = { x: parseFloat(headerPairs[i + 1][1]), y: parseFloat(headerPairs[i + 2][1]) };
    if (n === '$EXTMAX' && headerPairs[i + 1] && headerPairs[i + 2]) max = { x: parseFloat(headerPairs[i + 1][1]), y: parseFloat(headerPairs[i + 2][1]) };
  }
  if (!min || !max) return null;
  if (![min.x, min.y, max.x, max.y].every(Number.isFinite)) return null;
  if (max.x - min.x <= 0 || max.y - min.y <= 0) return null;
  return { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
}

export function dxfToSvg(text, options = {}) {
  const opts = Object.assign({ mono: false, bg: '#ffffff', fg: '#000000', font: "SimSun, 'Microsoft YaHei', sans-serif", maxHatchAreaRatio: 0.35, pickable: false }, options);
  const sections = splitSections(parsePairs(text));
  const layers = parseLayers(sections.TABLES);
  const blocks = parseBlocks(sections.BLOCKS);
  const root = splitEntities(sections.ENTITIES || []);
  const header = headerExtents(sections.HEADER);
  const stats = {};
  const body = [];
  // Selection support: every drawn entity gets a stable id plus the DXF facts a
  // human would quote when asking for a change ("the layer-0 line at ...").
  const picks = [];

  // Extents: the file's own $EXTMIN/$EXTMAX when usable, otherwise the raw span of
  // model-space coordinates. Block content is deliberately excluded: a few blocks carry
  // junk geometry far outside the sheets and would otherwise dominate the view.
  let bbox = header;
  if (!bbox) {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const e of root) {
      for (const [c, v] of e.codes) {
        if (![10, 11, 12, 13, 20, 21, 22, 23].includes(c)) continue;
        const n = parseFloat(v);
        if (!Number.isFinite(n)) continue;
        if (c < 20) { if (n < mnx) mnx = n; if (n > mxx) mxx = n; } else { if (n < mny) mny = n; if (n > mxy) mxy = n; }
      }
    }
    if (!Number.isFinite(mnx) || mxx <= mnx || mxy <= mny) throw new Error('empty drawing');
    bbox = { minX: mnx, minY: mny, maxX: mxx, maxY: mxy };
  }
  const spanX = bbox.maxX - bbox.minX, spanY = bbox.maxY - bbox.minY;
  // Skip anything that sits clearly outside the sheet area (junk blocks).
  const clip = { minX: bbox.minX - spanX * 0.6, minY: bbox.minY - spanY * 0.6, maxX: bbox.maxX + spanX * 0.6, maxY: bbox.maxY + spanY * 0.6 };
  const outside = (x, y) => x < clip.minX || x > clip.maxX || y < clip.minY || y > clip.maxY;
  let skipped = 0;
  const note = () => {};

  function colorFor(layerName, aciRaw) {
    if (opts.mono) return opts.fg;
    let aci = aciRaw;
    if (aci === undefined || aci === null || aci === 256 || aci === 0) { const l = layers.get(layerName); aci = l ? l.color : 7; }
    aci = Math.abs(aci) | 0;
    if (aci === 7 || aci === 0) return opts.fg;
    return ACI_HEX[Math.min(255, aci)] || opts.fg;
  }

  /** Selection ids are assigned in draw order. */
  let pickSeq = 0;
  let curH = '';
  // Identity of the entity currently being drawn (assigned in renderEntity).
  let curId = '';
  let curMeta = null;
  /** Current block transform (identity at model-space depth 0). */
  let curMat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  /** Apply the current transform to a local point. */
  const matApply2 = (x, y) => ({ x: curMat.a * x + curMat.c * y + curMat.e, y: curMat.b * x + curMat.d * y + curMat.f });
  /**
   * Tag a drawn element so the browser half can hit-test it.
   * `data-pick` carries the entity id; nothing is emitted in the default
   * (non-pickable) mode, so normal previews stay byte-identical.
   */
  const pickAttrs = () => opts.pickable ? ' data-pick="' + curId + '"' : '';
  function emit(d, stroke) { if (d) body.push('<path d="' + d + '" fill="none" stroke="' + stroke + '"' + pickAttrs() + (opts.tagHandles ? ' data-h="' + curH + '"' : '') + '/>'); }
  /**
   * Record one selectable entity: id, kind, layer, colour, world bounds — plus the
   * actual outline points when the caller passes them.
   *
   * A bbox alone cannot answer "what did the user lasso?": the sheet border is one
   * 420x297 polyline and table rules span the full width, so any rectangle-based
   * test drags them in wherever the band sits. The outline lets the caller measure
   * real coverage instead.
   *
   * @param {Array<{x:number,y:number}>} pts bounding points (block-local space).
   * @param {Array<{x:number,y:number}>|undefined} outline the shape itself.
   */
  function recordPick(pts, outline) {
    if (!opts.pickable || curMeta === null) return;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of pts) {
      const n = matApply2(p.x, p.y);
      if (n.x < mnx) mnx = n.x; if (n.x > mxx) mxx = n.x;
      if (n.y < mny) mny = n.y; if (n.y > mxy) mxy = n.y;
    }
    if (!Number.isFinite(mnx)) return;
    const entry = { ...curMeta, id: curId, bbox: [mnx, mny, mxx, mxy] };
    if (outline !== undefined && outline.length >= 2) {
      const flat = [];
      for (const p of outline) {
        const n = matApply2(p.x, p.y);
        flat.push(Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100);
      }
      entry.pts = flat;
    }
    picks.push(entry);
  }

  // ── outlines for selection maths ──────────────────────────────────────────
  // Coarse sampling is deliberate: these points only answer "is this entity
  // inside the band?", never "draw this", so 24-48 segments is plenty and keeps
  // the pick payload small.
  const OUTLINE_STEPS = 32;

  /** Sample a full circle as a closed polygon. */
  function circleOutline(cx, cy, r) {
    const out = [];
    for (let i = 0; i < OUTLINE_STEPS; i++) {
      const a = (i / OUTLINE_STEPS) * Math.PI * 2;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  /** Sample an elliptical arc as a polyline (angles in degrees). */
  function ellipseOutline(cx, cy, rx, ry, rotation) {
    const out = [];
    const cr = Math.cos(rotation), sr = Math.sin(rotation);
    for (let i = 0; i <= OUTLINE_STEPS; i++) {
      const a = (i / OUTLINE_STEPS) * Math.PI * 2;
      const px = rx * Math.cos(a), py = ry * Math.sin(a);
      out.push({ x: cx + px * cr - py * sr, y: cy + px * sr + py * cr });
    }
    return out;
  }

  /** Sample an arc (DXF start/end angles in degrees) as a polyline. */
  function arcOutline(cx, cy, r, a0Deg, a1Deg) {
    let a0 = a0Deg * Math.PI / 180;
    let a1 = a1Deg * Math.PI / 180;
    while (a1 <= a0) a1 += Math.PI * 2;
    const steps = Math.max(8, Math.min(48, Math.ceil((a1 - a0) / (Math.PI / 18))));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };  const matMul = (m, n) => ({
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  });
  const matApply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

  const maxDepth = opts.maxDepth === undefined ? 10 : opts.maxDepth;
  function renderList(list, layerName0, depth, mat) {
    if (depth > maxDepth) return;
    let i = 0;
    while (i < list.length) {
      const e = list[i];
      if (e.type === 'POLYLINE') {
        const pts = [];
        let j = i + 1;
        while (j < list.length && list[j].type === 'VERTEX') {
          const v = list[j];
          pts.push({ x: num(v, 10), y: num(v, 20), bulge: num(v, 42, 0) });
          j++;
        }
        if (j < list.length && list[j].type === 'SEQEND') j++;
        const closed = (num(e, 70, 0) & 1) === 1;
        const stroke = colorFor(str(e, 8, layerName0), e.codes.some(([c]) => c === 62) ? num(e, 62, 256) : 256);
        for (const p of pts) note(p.x, p.y);
        stats.POLYLINE = (stats.POLYLINE || 0) + 1;
        emit(polyPath(pts, closed), stroke);
        i = j;
        continue;
      }
      if (e.type === 'VERTEX' || e.type === 'SEQEND') { i++; continue; }
      if (e.type === 'ATTRIB') stats.ATTRIB = (stats.ATTRIB || 0) + 1;
      if (e.type === 'ATTDEF') { i++; continue; }
      renderEntity(e, layerName0, depth, mat);
      i++;
    }
  }

  const drawDiag = Math.hypot(spanX, spanY);
  /** Rough local bounding box from the entity's own point codes (radius expanded for arcs/circles). */
  function localBBox(e) {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const [c, v] of e.codes) {
      if (c < 10 || c > 26) continue;
      const n = parseFloat(v);
      if (!Number.isFinite(n)) continue;
      if (c < 20) { if (n < mnx) mnx = n; if (n > mxx) mxx = n; }
      else { if (n < mny) mny = n; if (n > mxy) mxy = n; }
    }
    if (!Number.isFinite(mnx)) return null;
    if (e.type === 'CIRCLE' || e.type === 'ARC') {
      const r = Math.abs(num(e, 40, 0));
      mnx -= r; mxx += r; mny -= r; mxy += r;
    }
    return { mnx, mny, mxx, mxy };
  }
  /** True when the entity's world footprint is absurdly larger than the sheet: stray block junk. */
  function isStray(e, mat) {
    const b = localBBox(e);
    if (!b) return false;
    const corner = (x, y) => mat ? matApply(mat, x, y) : { x, y };
    const p1 = corner(b.mnx, b.mny), p2 = corner(b.mxx, b.mny), p3 = corner(b.mnx, b.mxy), p4 = corner(b.mxx, b.mxy);
    const dx = Math.max(p1.x, p2.x, p3.x, p4.x) - Math.min(p1.x, p2.x, p3.x, p4.x);
    const dy = Math.max(p1.y, p2.y, p3.y, p4.y) - Math.min(p1.y, p2.y, p3.y, p4.y);
    if (Math.hypot(dx, dy) > drawDiag * 3) return true;
    const cx = (p1.x + p4.x) / 2, cy = (p1.y + p4.y) / 2;
    return outside(cx, cy) && Math.hypot(dx, dy) > drawDiag * 0.8;
  }

  function renderEntity(e, layerName0, depth, mat) {
    const t = e.type;
    stats[t] = (stats[t] || 0) + 1;
  // Only now is it known whether the colour signs discriminate. See the note where
  // layers are collected: a DWG converted by libredwg negatives all of them.
  {
    let negatives = 0
    for (const layer of layers.values()) {
      if (layer.raw < 0) negatives += 1
    }
    if (negatives > 0 && negatives < layers.size) {
      for (const layer of layers.values()) layer.off = layer.raw < 0
    }
  }

  curH = str(e, 5) + '@' + depth;
    curMat = mat;
    if (depth > 0 && isStray(e, mat)) { skipped++; stats.__stray = (stats.__stray || 0) + 1; return; }
    const layerName = str(e, 8, layerName0 || '0');
    const layer = layers.get(layerName);
    if (layer && (layer.off || layer.frozen)) return;
    const raw62 = e.codes.some(([c]) => c === 62) ? num(e, 62, 256) : 256;
    const stroke = colorFor(layerName, raw62);
    // Identity for selection: sequence keeps duplicates apart (many DXF entities
    // share or omit handles), handle+depth is what the file itself offers.
    curId = 'e' + (++pickSeq);
    curMeta = { type: t, layer: layerName, handle: str(e, 5) || '', depth };

    switch (t) {
      case 'LINE': {
        const x1 = num(e, 10), y1 = num(e, 20), x2 = num(e, 11), y2 = num(e, 21);
        note(x1, y1); note(x2, y2);
        recordPick([{ x: x1, y: y1 }, { x: x2, y: y2 }], [{ x: x1, y: y1 }, { x: x2, y: y2 }]);
        emit('M ' + fmt(x1) + ' ' + fmt(y1) + ' L ' + fmt(x2) + ' ' + fmt(y2), stroke);
        break;
      }
      case 'LWPOLYLINE': {
        const closed = (num(e, 70, 0) & 1) === 1;
        const pts = [];
        let cx = null;
        for (const [c, v] of e.codes) {
          if (c === 10) cx = parseFloat(v);
          else if (c === 20 && cx !== null) { pts.push({ x: cx, y: parseFloat(v), bulge: 0 }); cx = null; }
          else if (c === 42 && pts.length) pts[pts.length - 1].bulge = parseFloat(v);
        }
        for (const p of pts) note(p.x, p.y);
        recordPick(pts, pts);
        emit(polyPath(pts, closed), stroke);
        break;
      }
      case 'CIRCLE': {
        const cx = num(e, 10), cy = num(e, 20), r = Math.abs(num(e, 40));
        note(cx - r, cy - r); note(cx + r, cy + r);
        recordPick([{ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }], circleOutline(cx, cy, r));
        body.push('<circle cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" r="' + fmt(r) + '" fill="none" stroke="' + stroke + '"' +
          pickAttrs() + '/>');
        break;
      }
      case 'ARC': {
        const cx = num(e, 10), cy = num(e, 20), r = Math.abs(num(e, 40)), a0 = num(e, 50), a1 = num(e, 51);
        // Bounds come from the arc itself, not its full circle. A 30..210 arc of
        // r=18 at (45,32.5) reaches y 23.5..50.5, while the circle would claim
        // 14.5..50.5 — a phantom band that made a band selection grab the arc
        // from empty space and report a range the user never circled.
        const outline = arcOutline(cx, cy, r, a0, a1);
        const arcPts = [{ x: cx, y: cy }, ...outline];
        for (const point of outline) note(point.x, point.y);
        recordPick(arcPts, outline);
        emit(arcPath(cx, cy, r, a0, a1), stroke);
        break;
      }
      case 'ELLIPSE': {
        const cx = num(e, 10), cy = num(e, 20), mx = num(e, 11), my = num(e, 21), ratio = num(e, 40, 1);
        const major = Math.hypot(mx, my), rot = Math.atan2(my, mx) * 180 / Math.PI;
        // Same lesson as ARC: the bounds must come from the actual outline (a
        // rotated, flattened ellipse), not a square around the major axis.
        const ellOutline = ellipseOutline(cx, cy, major, major * ratio, Math.atan2(my, mx));
        const ellPts = [{ x: cx, y: cy }, ...ellOutline];
        for (const point of ellOutline) note(point.x, point.y);
        recordPick(ellPts, ellOutline);
        body.push('<ellipse cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" rx="' + fmt(major) + '" ry="' + fmt(major * ratio) +
          '" transform="rotate(' + fmt(rot) + ' ' + fmt(cx) + ' ' + fmt(cy) + ')" fill="none" stroke="' + stroke + '"' +
          pickAttrs() + '/>');
        break;
      }
      case 'SOLID': case '3DFACE': {
        const pts = [];
        const n = t === '3DFACE' ? 3 : 4;
        const xs = [num(e, 10), num(e, 11), num(e, 12), num(e, 13)];
        const ys = [num(e, 20), num(e, 21), num(e, 22), num(e, 23)];
        for (let k = 0; k < n; k++) pts.push({ x: xs[k], y: ys[k], bulge: 0 });
        for (const p of pts) note(p.x, p.y);
        recordPick(pts, pts);
        body.push('<path d="' + polyPath(pts, true) + '" fill="' + stroke + '" fill-opacity="0.9" stroke="none"' +
          pickAttrs() + '/>');
        break;
      }
      case 'POINT': {
        const x = num(e, 10), y = num(e, 20);
        note(x, y);
        recordPick([{ x, y }]);
        body.push('<circle cx="' + fmt(x) + '" cy="' + fmt(y) + '" r="0.1" fill="' + stroke + '" stroke="' + stroke + '"' +
          pickAttrs() + '/>');
        break;
      }
      case 'TEXT': case 'ATTRIB': {
        const x = num(e, 10), y = num(e, 20), h = Math.abs(num(e, 40, 2.5)) || 2.5, rot = num(e, 50, 0);
        const txt = resolveEscapes(e.codes.filter(([c]) => c === 1).map(([, v]) => v).join(''));
        if (!txt.trim()) break;
        const hjust = num(e, 72, 0), vjust = num(e, 73, 0);
        const bx = hjust ? num(e, 11, x) : x;
        const by = (hjust || vjust) ? num(e, 21, y) : y;
        note(x, y); note(bx, by);
        // Width is estimated from CJK taking roughly one em and ASCII half of it;
        // good enough to make the text clickable at its real footprint.
        const wpx = [...txt].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? h : h * 0.55), 0);
        const rad = rot * Math.PI / 180;
        const cs = Math.cos(rad), sn = Math.sin(rad);
        const ux = wpx * cs, uy = wpx * sn;
        recordPick([
          { x: bx, y: by },
          { x: bx + ux, y: by + uy },
          { x: bx + ux - h * sn, y: by + uy + h * cs },
          { x: bx - h * sn, y: by + h * cs },
        ], [
          // Text is a box for selection purposes; the glyphs are not traced.
          { x: bx, y: by },
          { x: bx + ux, y: by + uy },
          { x: bx + ux - h * sn, y: by + uy + h * cs },
          { x: bx - h * sn, y: by + h * cs },
        ]);
        const anchor = (hjust === 1 || hjust === 4) ? 'middle' : (hjust === 2 ? 'end' : 'start');
        const baseline = vjust === 3 ? 'hanging' : (vjust === 2 ? 'middle' : 'auto');
        body.push('<text font-size="' + fmt(h) + '" text-anchor="' + anchor + '" dominant-baseline="' + baseline + '" fill="' + stroke + '"' +
          pickAttrs() + ' transform="translate(' + fmt(bx) + ' ' + fmt(by) + ') scale(1 -1) rotate(' + fmt(rot) + ')">' + esc(txt) + '</text>');
        break;
      }
      case 'MTEXT': {
        const x = num(e, 10), y = num(e, 20), h = Math.abs(num(e, 40, 2.5)) || 2.5, rot = num(e, 50, 0);
        const txt = cleanMtext(all(e, 3).concat(all(e, 1)).join(''));
        if (!txt.trim()) break;
        const att = num(e, 71, 1);
        const anchor = (att === 2 || att === 5 || att === 8) ? 'middle' : ((att === 3 || att === 6 || att === 9) ? 'end' : 'start');
        const baseline = att <= 3 ? 'hanging' : (att <= 6 ? 'middle' : 'auto');
        note(x, y);
        const lines = txt.split('\n');
        const lh = h * 1.5;
        const widest = lines.reduce((m, ln) => Math.max(m, [...ln].reduce((s, ch) => s + (ch.charCodeAt(0) > 0x2e7f ? h : h * 0.55), 0)), 0);
        const bh = lh * lines.length;
        const rad = rot * Math.PI / 180;
        const cs = Math.cos(rad), sn = Math.sin(rad);
        const ux = widest * cs, uy = widest * sn;
        recordPick([
          { x, y },
          { x: x + ux, y: y + uy },
          { x: x + ux - bh * sn, y: y + uy + bh * cs },
          { x: x - bh * sn, y: y + bh * cs },
        ], [
          { x, y },
          { x: x + ux, y: y + uy },
          { x: x + ux - bh * sn, y: y + uy + bh * cs },
          { x: x - bh * sn, y: y + bh * cs },
        ]);
        const runs = lines.map((ln, k) => '<tspan x="0" dy="' + fmt(k === 0 ? h * 0.9 : lh) + '">' + esc(ln) + '</tspan>').join('');
        body.push('<text font-size="' + fmt(h) + '" text-anchor="' + anchor + '" dominant-baseline="' + baseline + '" fill="' + stroke + '"' +
          pickAttrs() + ' transform="translate(' + fmt(x) + ' ' + fmt(y) + ') scale(1 -1) rotate(' + fmt(rot) + ')">' + runs + '</text>');
        break;
      }
      case 'INSERT': {
        const name = str(e, 2);
        const block = blocks.get(name);
        const x = num(e, 10), y = num(e, 20);
        const sx = num(e, 41, 1), sy = num(e, 42, 1), rot = num(e, 50, 0);
        const cols = num(e, 70, 1) || 1, rows = num(e, 71, 1) || 1;
        const dx = num(e, 44, 0), dy = num(e, 45, 0);
        note(x, y);
        if (!block) break;
        const limb = (ox, oy) => {
          const p = matApply(mat, ox, oy);
          if (outside(p.x, p.y)) { skipped++; return; }
          const rad = rot * Math.PI / 180;
          const local = matMul(matMul(matMul(mat,
            { a: 1, b: 0, c: 0, d: 1, e: ox, f: oy }),
            { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: 0, f: 0 }),
            { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
          const child = matMul(local, { a: 1, b: 0, c: 0, d: 1, e: -block.base.x, f: -block.base.y });
          body.push('<g transform="translate(' + fmt(ox) + ' ' + fmt(oy) + ') rotate(' + fmt(rot) + ') scale(' + fmt(sx) + ' ' + fmt(sy) +
            ') translate(' + fmt(-block.base.x) + ' ' + fmt(-block.base.y) + ')">');
          renderList(block.entities, layerName, depth + 1, child);
          body.push('</g>');
        };
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) limb(x + c * dx, y + r * dy);
        break;
      }
      case 'DIMENSION': {
        const name = str(e, 2);
        const block = name ? blocks.get(name) : null;
        if (block && block.entities.length) { renderList(block.entities, layerName, depth + 1, mat); break; }
        const x1 = num(e, 13), y1 = num(e, 23), x2 = num(e, 14), y2 = num(e, 24);
        note(x1, y1); note(x2, y2);
        recordPick([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
        emit('M ' + fmt(x1) + ' ' + fmt(y1) + ' L ' + fmt(x2) + ' ' + fmt(y2), stroke);
        break;
      }

      case 'HATCH': {
        const solid = (num(e, 70, 0) & 1) === 1;
        const aci = e.codes.some(([c]) => c === 62) ? num(e, 62, 256) : 256;
        const hc = opts.mono ? opts.fg : colorFor(layerName, aci);
        const codes = e.codes;
        const nPaths = num(e, 91, 0);
        let i = codes.findIndex(([c]) => c === 92);
        const subpaths = [];
        /** Every boundary vertex, world space — used for the pick bounds. */
        const hatchVerts = [];
        for (let p = 0; p < nPaths && i > 0 && i < codes.length; p++) {
          if (codes[i][0] !== 92) break;
          const flags = parseInt(codes[i][1], 10);
          i++;
          const verts = [];
          if ((flags & 2) !== 0) {
            while (i < codes.length && (codes[i][0] === 72 || codes[i][0] === 73)) i++;
            let count = 0;
            if (i < codes.length && codes[i][0] === 93) { count = parseInt(codes[i][1], 10); i++; }
            let cx = null, got = 0;
            while (i < codes.length && got < count) {
              const c = codes[i][0];
              if (c === 10) { cx = parseFloat(codes[i][1]); i++; }
              else if (c === 20 && cx !== null) { verts.push({ x: cx, y: parseFloat(codes[i][1]), bulge: 0 }); cx = null; got++; i++; }
              else if (c === 42 && verts.length) { verts[verts.length - 1].bulge = parseFloat(codes[i][1]); i++; }
              else break;
            }
          } else {
            if (i < codes.length && codes[i][0] === 93) i++;
            let end = i;
            while (end < codes.length) { const c = codes[end][0]; if (c === 92 || c === 97 || c === 98 || c === 75 || c === 76) break; end++; }
            const region = codes.slice(i, end);
            i = end;
            const edges = [];
            let cur = null;
            for (const pair of region) {
              if (pair[0] === 72) { if (cur) edges.push(cur); cur = { kind: parseInt(pair[1], 10), list: [] }; }
              else if (cur) cur.list.push(pair);
            }
            if (cur) edges.push(cur);
            for (const ed of edges) {
              const gv = (code) => { for (const [c, v] of ed.list) if (c === code) return parseFloat(v); return undefined; };
              if (ed.kind === 1) {
                const x1 = gv(10), y1 = gv(20), x2 = gv(11), y2 = gv(21);
                if (x1 !== undefined && y1 !== undefined) verts.push({ x: x1, y: y1, bulge: 0 });
                if (x2 !== undefined && y2 !== undefined) verts.push({ x: x2, y: y2, bulge: 0 });
              } else if (ed.kind === 2) {
                const cx = gv(10) || 0, cy = gv(20) || 0, r = gv(40) || 0, a0 = gv(50) || 0, a1 = gv(51) || 0;
                const ccw = gv(73);
                for (const q of arcPoints(cx, cy, r, a0, a1, ccw === undefined ? true : ccw === 1)) verts.push(q);
              } else if (ed.kind === 3) {
                const cx = gv(10) || 0, cy = gv(20) || 0, mx = gv(11) || 1, my = gv(21) || 0;
                const ratio = gv(40) === undefined ? 1 : gv(40), a0 = gv(50) || 0, a1 = gv(51) === undefined ? 360 : gv(51);
                const major = Math.hypot(mx, my), rot = Math.atan2(my, mx);
                const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 15));
                for (let k = 0; k <= n; k++) {
                  const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180;
                  const px = major * Math.cos(a), py = major * ratio * Math.sin(a);
                  verts.push({ x: cx + px * Math.cos(rot) - py * Math.sin(rot), y: cy + px * Math.sin(rot) + py * Math.cos(rot), bulge: 0 });
                }
              } else {
                const fit = [];
                let fx = null;
                for (const [c, v] of ed.list) { if (c === 11) fx = parseFloat(v); else if (c === 21 && fx !== null) { fit.push({ x: fx, y: parseFloat(v), bulge: 0 }); fx = null; } }
                if (fit.length >= 2) for (const q of fit) verts.push(q);
                else { let cxp = null; for (const [c, v] of ed.list) { if (c === 10) cxp = parseFloat(v); else if (c === 20 && cxp !== null) { verts.push({ x: cxp, y: parseFloat(v), bulge: 0 }); cxp = null; } } }
              }
            }
          }
          if (verts.length >= 3) {
            let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
            for (const q of verts) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y; }
            if (Math.hypot(mxx - mnx, mxy - mny) <= drawDiag * 3) {
              subpaths.push(polyPath(verts, true));
              for (const q of verts) hatchVerts.push(q);
            } else { skipped++; stats.__stray = (stats.__stray || 0) + 1; }
          }
        }
        if (subpaths.length) {
          // Selection bounds = the union of every boundary vertex collected above.
          if (hatchVerts.length) recordPick(hatchVerts);
          body.push('<path d="' + subpaths.join(' ') + '" fill="' + hc + '" fill-opacity="' + (solid ? '0.85' : '0.20') + '" fill-rule="evenodd" stroke="none"' +
            pickAttrs() + '/>');
        }
        break;
      }
      default: break;
    }
  }

  renderList(root, '0', 0, IDENT);
  stats.__skippedOutside = skipped;

  if (!Number.isFinite(bbox.minX) || bbox.maxX <= bbox.minX || bbox.maxY <= bbox.minY) throw new Error('empty drawing');
  const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
  const pad = Math.max(w, h) * 0.02;
  const x0 = bbox.minX - pad, y0 = bbox.minY - pad, vw = w + pad * 2, vh = h + pad * 2;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [x0, y0, vw, vh].map(fmt).join(' ') +
    '" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision">' +
    '<rect x="' + fmt(x0) + '" y="' + fmt(y0) + '" width="' + fmt(vw) + '" height="' + fmt(vh) + '" fill="' + opts.bg + '"/>' +
    '<g stroke-width="1" vector-effect="non-scaling-stroke" font-family="' + opts.font + '" transform="translate(0 ' + fmt(bbox.maxY + bbox.minY) + ') scale(1 -1)">' +
    body.join('') + '</g></svg>';
  return { svg, stats, picks: opts.pickable ? picks : undefined, bbox: { minX: bbox.minX, minY: bbox.minY, maxX: bbox.maxX, maxY: bbox.maxY } };
}

export default dxfToSvg;
