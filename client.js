/**
 * DWG / DXF sidebar preview - browser half.
 *
 * Registers one document renderer: the .dwg and .dxf suffixes, claimed at the
 * "extension" band, plus the keyed body that draws them in
 * sidebar.right.tab.document. Bytes are handed to the host half
 * (POST /api/corn-cad/svg), which decodes the DWG with LibreDWG/WASM and
 * returns a self-contained SVG; this half only shows it, so no wasm, worker or
 * third-party viewer library is loaded into the page.
 *
 * @module dsh-corn-cad/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-corn-cad',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    /** Body identity, shared by the metadata registration and the keyed slot. */
    var BODY_ID = 'dsh-corn-cad/drawing'
    /** Locale namespace this bundle registers its dictionary under. */
    var NS = 'dwgPreview'
    /** Marker used to inject the plugin stylesheet once. */
    var STYLE_ID = 'corncad-css'
    /** Suffixes this renderer claims. */
    var EXTENSIONS = ['dwg', 'dxf']

    var DICT = {
      zh: {
        title: 'DWG 图纸',
        loading: '正在解析图纸…',
        failed: '预览失败',
        zoomIn: '放大',
        zoomOut: '缩小',
        fit: '适应宽度',
        entities: '{count} 个图元',
        seconds: '{value} 秒',
        picked: '已选中 {count} 个图元，已记录',
        selected: '已选中 {count} 个',
        clearSel: '清除',
        hint: '左键拖动平移 · 右键框选发消息',
        modeRegion: '区域',
        modeRegionTip: '框选模式：区域 —— 框到哪就选哪，长线只取框内那一段',
        modeEntity: '图元',
        modeEntityTip: '框选模式：图元 —— 框到的图元整体选中，长线也整条算',
        modeLabel: '框选模式',
        bubbleTitle: '这块怎么改？',
        bubblePlaceholder: '例如：这几根线改成黑色 / 整体上移 5mm',
        bubbleSend: '发送',
        bubbleCancel: '取消',
        bubbleHint: 'Ctrl+Enter 发送',
        sent: '已发送（{count} 个图元），等待处理',
        sendFailed: '发送失败：{message}',
        noSession: '找不到当前会话，指令未发送；选中集已写入图纸旁的记录文件',
        recording: '正在写入选中集…',
      },
      en: {
        title: 'DWG drawing',
        loading: 'Reading the drawing…',
        failed: 'Preview failed',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        fit: 'Fit width',
        entities: '{count} entities',
        seconds: '{value} s',
        picked: '{count} entities selected, recorded',
        selected: '{count} selected',
        clearSel: 'Clear',
        hint: 'Drag to pan · right-drag to circle and send',
        modeRegion: 'Region',
        modeRegionTip: 'Selection mode: Region — take what the band touches, and only that run of a long line',
        modeEntity: 'Entity',
        modeEntityTip: 'Selection mode: Entity — take any entity the band touches, whole',
        modeLabel: 'Selection mode',
        bubbleTitle: 'How should this change?',
        bubblePlaceholder: 'e.g. make these lines black / move up 5mm',
        bubbleSend: 'Send',
        bubbleCancel: 'Cancel',
        bubbleHint: 'Ctrl+Enter to send',
        sent: 'Sent ({count} entities), waiting for changes',
        sendFailed: 'Send failed: {message}',
        noSession: 'No conversation scope for this tab, so the instruction was not sent; the selection was still recorded beside the drawing',
        recording: 'Recording the selection…',
      },
    }

    var CSS = [
      '.corncad-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--corncad-bg,#fff)}',
      '.corncad-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.25);flex:none;font-size:12px}',
      '.corncad-btn{min-width:26px;height:22px;padding:0 8px;border:1px solid rgba(127,127,127,.35);border-radius:5px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.corncad-btn:hover{background:rgba(127,127,127,.12)}',
      '.corncad-meta{margin-left:auto;opacity:.6;font-variant-numeric:tabular-nums}',
      // Segmented mode switch: two states, one control, sitting on the toolbar row.
      '.corncad-seg{display:inline-flex;align-items:center;border:1px solid rgba(127,127,127,.35);border-radius:5px;overflow:hidden;flex:none}',
      '.corncad-seg button{min-width:34px;height:22px;padding:0 7px;border:0;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.corncad-seg button+button{border-left:1px solid rgba(127,127,127,.28)}',
      '.corncad-seg button[aria-pressed="true"]{background:#2563eb;color:#fff}',
      '.corncad-seg button:not([aria-pressed="true"]):hover{background:rgba(127,127,127,.12)}',
      '.corncad-notice{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(37,99,235,.12);color:#2563eb;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.corncad-scroll{flex:1 1 auto;min-height:0;overflow:auto;background:var(--corncad-bg,#fff);display:block;padding:4px 0;cursor:grab;touch-action:none}',
      '.corncad-scroll.corncad-dragging{cursor:grabbing}',
      '.corncad-scroll.corncad-dragging .corncad-img{pointer-events:none}',
      '.corncad-img{display:block;margin:0 auto;background:var(--corncad-bg,#fff);user-select:none;-webkit-user-drag:none}',
      '.corncad-canvas{position:relative;margin:0 auto;background:var(--corncad-bg,#fff);user-select:none;cursor:grab}',
      // An inline <svg width="100%" height="100%"> has no intrinsic height, so the
      // canvas gets its height from CSS aspect-ratio (set inline from the viewBox)
      // and the SVG is pinned to fill it exactly. Flowing the SVG instead would
      // collapse the box and leave the panel blank.
      '.corncad-canvas>svg{display:block;position:absolute;inset:0;width:100%;height:100%}',
      '.corncad-canvas-selecting{cursor:crosshair}',
      '.corncad-dragging .corncad-canvas{cursor:grabbing}',
      '.corncad-hit{pointer-events:visiblePainted;cursor:pointer}',
      '.corncad-hit:hover{stroke:#3b82f6 !important;stroke-width:2 !important}',
      '.corncad-sel{stroke:#f97316 !important;stroke-width:2.5 !important}',
      '.corncad-seltext{fill:#f97316 !important}',
      '.corncad-selinfo{display:flex;align-items:center;gap:8px;padding:4px 8px;border-top:1px solid rgba(127,127,127,.25);font-size:12px;flex:none}',
      '.corncad-selinfo b{font-weight:600}',
      '.corncad-selcount{opacity:.75}',
      '.corncad-selclear{margin-left:auto;min-width:20px;height:18px;padding:0 6px;border:1px solid rgba(127,127,127,.35);border-radius:4px;background:transparent;color:inherit;font-size:11px;cursor:pointer}',
      // The overlay layer is absolutely positioned inside the panel, so the band
      // and the bubble are clamped to the panel's own box rather than the window's.
      // A sidebar is far narrower than the window, and `position: fixed` coordinates
      // measured against window.innerWidth put the bubble outside the visible area.
      '.corncad-band{position:absolute;pointer-events:none;border:1px dashed #f97316;background:rgba(249,115,22,.12);z-index:20}',
      '.corncad-bubble{position:absolute;width:300px;max-width:calc(100% - 16px);z-index:21;border-radius:10px;background:#fff;color:#1a1d21;border:1px solid rgba(0,0,0,.14);box-shadow:0 8px 28px rgba(0,0,0,.22);padding:10px;display:flex;flex-direction:column;gap:8px;font-size:12px}',
      '.corncad-bubble-h{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px}',
      '.corncad-bubble-h span{font-weight:400;opacity:.6;font-size:11px}',
      '.corncad-bubble textarea{width:100%;box-sizing:border-box;min-height:58px;resize:vertical;border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px;outline:none}',
      '.corncad-bubble textarea:focus{border-color:#3b82f6}',
      '.corncad-bubble-f{display:flex;align-items:center;gap:6px}',
      '.corncad-bubble-f button{height:24px;padding:0 10px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:12px;cursor:pointer}',
      '.corncad-bubble-f button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
      '.corncad-bubble-f button.primary:disabled{opacity:.5;cursor:default}',
      '.corncad-bubble-f .hint{margin-left:auto;opacity:.5;font-size:11px}',
      '.corncad-status{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;padding:24px;font-size:13px;opacity:.75;text-align:center}',
      '.corncad-msg{opacity:.75;font-size:12px;word-break:break-word;max-width:40ch}',
    ].join('\n')

    /** Inject the plugin stylesheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-corn-cad'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Paint the panel chrome with the same background the host renders the SVG
     * on, so a dark preview does not sit inside a white frame. The host answers
     * /api/corn-cad/theme; failure leaves the default white alone.
     */
    function syncTheme() {
      if (typeof document === 'undefined' || typeof fetch !== 'function') return
      fetch('/api/corn-cad/theme', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (payload) {
          if (payload === null || payload.ok !== true) return
          var bg = typeof payload.background === 'string' ? payload.background : ''
          var fg = typeof payload.foreground === 'string' ? payload.foreground : ''
          var root = document.documentElement
          if (bg) root.style.setProperty('--corncad-bg', bg)
          if (fg) root.style.setProperty('--corncad-fg', fg)
        })
        .catch(function () { /* keep the defaults */ })
    }

    /** Last path segment of a resource address, decoded. */
    function fileNameOf(address) {
      if (typeof address !== 'string') return ''
      var clean = address.split('?')[0].split('#')[0]
      var parts = clean.split('/')
      var last = parts[parts.length - 1] || ''
      try { return decodeURIComponent(last) } catch (error) { return last }
    }

    /**
     * Session id carried by a document address.
     *
     * Document previews hand the body `dsh-resource://file/session/<id>/<path>`;
     * that id is the Agent scope the conversation service has to be resolved
     * through. An `absolute` address carries none.
     *
     * @param {string} address the tab's resourceAddress.
     * @returns {string} the session id, or '' when the address has none.
     */
    function sessionIdOf(address) {
      if (typeof address !== 'string') return ''
      var marker = 'dsh-resource://file/session/'
      if (address.indexOf(marker) !== 0) return ''
      var rest = address.slice(marker.length).split('?')[0].split('#')[0]
      var slash = rest.indexOf('/')
      var raw = slash === -1 ? rest : rest.slice(0, slash)
      try { return decodeURIComponent(raw) } catch (error) { return raw }
    }

    /**
     * File path carried by a document address, decoded.
     * @param {string} address the tab's resourceAddress.
     * @returns {string} the path inside the session scope, or its last segment.
     */
    function pathOf(address) {
      if (typeof address !== 'string') return ''
      var clean = address.split('?')[0].split('#')[0]
      var marker = 'dsh-resource://file/session/'
      if (clean.indexOf(marker) !== 0) return ''
      var rest = clean.slice(marker.length)
      var slash = rest.indexOf('/')
      if (slash === -1) return ''
      var encoded = rest.slice(slash + 1)
      try { return encoded.split('/').map(decodeURIComponent).join('/') } catch (error) { return encoded }
    }

    /**
     * Directory portion of a path, or '.' when there is none.
     * @param {string} value a file path.
     * @returns {string}
     */
    function parentDirOf(value) {
      if (typeof value !== 'string') return '.'
      var cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
      if (cut < 0) return '.'
      if (cut === 0) return '/'
      return value.slice(0, cut)
    }

    /**
     * One-line summary of the selected entities' combined bounds.
     *
     * This is the "which part of the drawing" the agent needs: a circled region is
     * only meaningful together with the coordinates it covers.
     *
     * @param {Array<{bbox?: number[]}>} items pick records.
     * @returns {string} e.g. 'x 120.0..380.5, y 44.0..190.2', or '' when unknown.
     */
    function describeSelection(items) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (var i = 0; i < items.length; i++) {
        var box = items[i] !== null && items[i] !== undefined ? items[i].bbox : undefined
        if (!Array.isArray(box) || box.length < 4) continue
        if (box[0] < minX) minX = box[0]
        if (box[1] < minY) minY = box[1]
        if (box[2] > maxX) maxX = box[2]
        if (box[3] > maxY) maxY = box[3]
      }
      if (!Number.isFinite(minX)) return ''
      var r = function (n) { return Math.round(n * 100) / 100 }
      return 'x ' + r(minX) + '..' + r(maxX) + ', y ' + r(minY) + '..' + r(maxY)
    }

    /** Count of drawn entities, ignoring the renderer's own bookkeeping keys. */
    function countEntities(stats) {
      var total = 0
      if (stats === undefined || stats === null) return total
      for (var key in stats) {
        if (key.indexOf('__') === 0) continue
        var value = stats[key]
        if (typeof value === 'number') total += value
      }
      return total
    }

    /**
     * The DWG body: post the bytes, then show the returned vector drawing.
     * @param props document bytes, resource identity, and copy.
     */
    function DwgBody(props) {
      var t = props.t
      var name = fileNameOf(props.resourceAddress)
      // Absolute path of the drawing, from the preview's own metadata. This is what
      // makes the record findable beside the file and lets the prompt name it.
      var absolutePath = ''
      try {
        var resource = typeof props.useResource === 'function' ? props.useResource(props.resourceAddress) : undefined
        var resolved = resource !== undefined && resource !== null && resource.value !== null && resource.value !== undefined
          ? resource.value.absolutePath
          : undefined
        if (typeof resolved === 'string') absolutePath = resolved
      } catch (error) {
        absolutePath = ''
      }
      // Fall back to the session-relative path the address itself carries.
      var drawingPath = absolutePath !== '' ? absolutePath : pathOf(props.resourceAddress)
      var recordPath = drawingPath !== '' ? parentDirOf(drawingPath) + '/.corncad/selection.json' : '.corncad/selection.json'
      var data = props.content !== undefined && props.content.kind === 'bytes' ? props.content.data : undefined
      var viewState = useState({ status: 'loading' })
      var view = viewState[0]
      var setView = viewState[1]
      var zoomState = useState(0)
      var zoom = zoomState[0]
      var setZoom = zoomState[1]
      var scrollRef = useRef(null)
      var dragRef = useRef(null)
      var sizeRef = useRef(null)
      var dragState = useState(false)
      var dragging = dragState[0]
      var setDragging = dragState[1]
      // ── selection ────────────────────────────────────────────────────────────
      // pickRef: id -> { type, layer, handle, bbox } for every entity the host
      // reported; selectionRef mirrors the current selection for the POST.
      // The panel element the overlays are positioned against.
      var rootRef = useRef(null)
      var canvasRef = useRef(null)
      var pickRef = useRef(null)
      var selectionRef = useRef([])
      var selectBoxRef = useRef(null)
      // The DXF-space band of the last completed drag, so picks can carry the part
      // of each entity that the user actually circled.
      var bandRectRef = useRef(null)
      // 'region' takes the part of an entity the band touches; 'entity' takes the
      // whole entity. Both are legitimate: a detail edit wants the run, a
      // "delete this line" wants the entity.
      var modeState = useState('region')
      var selectMode = modeState[0]
      var setSelectMode = modeState[1]
      var selState = useState([])
      var selection = selState[0]
      var setSelection = selState[1]
      var selectingState = useState(false)
      var selecting = selectingState[0]
      var setSelecting = selectingState[1]
      var noticeState = useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      // Rubber-band rectangle (screen space) and the instruction bubble.
      var bandState = useState(null)
      var band = bandState[0]
      var setBand = bandState[1]
      var bubbleState = useState(null)
      var bubble = bubbleState[0]
      var setBubble = bubbleState[1]
      var bubbleTextState = useState('')
      var bubbleText = bubbleTextState[0]
      var setBubbleText = bubbleTextState[1]
      var bubbleBusyState = useState(false)
      var bubbleBusy = bubbleBusyState[0]
      var setBubbleBusy = bubbleBusyState[1]

      /** Bind our own scroll node and hand the same node to the parent's scroll owner. */
      var bindScrollport = function (node) {
        scrollRef.current = node
        var outer = props.scrollportRef
        if (typeof outer === 'function') outer(node)
        else if (outer !== null && typeof outer === 'object') outer.current = node
      }

      // Keep the point under the viewport centre steady while the drawing scales.
      useEffect(function () {
        var node = scrollRef.current
        var canvas = canvasRef.current
        if (node === null || canvas === null) return
        var width = canvas.clientWidth
        var height = canvas.clientHeight
        var previous = sizeRef.current
        if (previous !== null && previous.width > 0 && width > 0 && (previous.width !== width || previous.height !== height)) {
          node.scrollLeft = (node.scrollLeft + node.clientWidth / 2) * (width / previous.width) - node.clientWidth / 2
          node.scrollTop = (node.scrollTop + node.clientHeight / 2) * (height / previous.height) - node.clientHeight / 2
        }
        sizeRef.current = { width: width, height: height }
      })

      // Ctrl/Cmd + wheel zooms, a plain wheel keeps scrolling. A native listener is
      // needed because React registers wheel passively and cannot preventDefault.
      useEffect(function () {
        var node = scrollRef.current
        if (node === null) return undefined
        var onWheel = function (event) {
          if (event.ctrlKey !== true && event.metaKey !== true) return
          event.preventDefault()
          var factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
          setZoom(function (value) { return Math.min(25, Math.max(0.2, (value || 1) * factor)) })
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return function () { node.removeEventListener('wheel', onWheel) }
      }, [view.status])

      /** Drag anywhere in the viewport to pan, the way a CAD viewer does. */
      var onPointerDown = function (event) {
        // Only pan on the empty gutter around the drawing. Left-button presses on
        // the canvas belong to selection and must not also start a pan, otherwise
        // a rubber-band drag scrolls the drawing away at the same time.
        if (event.button !== 0) return
        if (canvasRef.current !== null && canvasRef.current.contains(event.target)) return
        var node = scrollRef.current
        if (node === null) return
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* capture is best effort */ }
        setDragging(true)
      }
      var onPointerMove = function (event) {
        var drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        var node = scrollRef.current
        if (node === null) return
        node.scrollLeft = drag.left - (event.clientX - drag.x)
        node.scrollTop = drag.top - (event.clientY - drag.y)
      }
      var endDrag = function (event) {
        var drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
      }

      useEffect(function () {
        if (data === undefined) return undefined
        var cancelled = false
        setView({ status: 'loading' })
        setSelection([])
        selectionRef.current = []
        setNotice('')
        var run = async function () {
          try {
            var response = await fetch('/api/corn-cad/svg', {
              method: 'POST',
              credentials: 'include',
              // Header values are ISO-8859-1 only, so a Chinese file name must be
              // percent-encoded before it can travel here; the host only logs it.
              headers: { 'content-type': 'application/octet-stream', 'x-dwg-name': encodeURIComponent(name) },
              cache: 'no-store',
              body: data,
              signal: AbortSignal.timeout(180000),
            })
            var payload = await response.json()
            if (cancelled === true) return
            if (payload.ok !== true) {
              setView({ status: 'error', message: payload.message || t('failed') })
              return
            }
            // Index the pick table: id -> geometry facts.
            var index = {}
            var picks = Array.isArray(payload.picks) ? payload.picks : []
            for (var i = 0; i < picks.length; i++) index[picks[i].id] = picks[i]
            pickRef.current = index
            // Width/height from the SVG viewBox, used to give the canvas an
            // intrinsic aspect ratio (an inline SVG cannot size itself).
            // aspect-ratio is <width> / <height>, so this must be vw/vh.
            var ratio
            var svgText = typeof payload.svg === 'string' ? payload.svg : ''
            var vb = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(svgText)
            if (vb !== null) {
              var vw = parseFloat(vb[3]), vh = parseFloat(vb[4])
              if (vw > 0 && vh > 0) ratio = vw / vh
            }
            // Constant of the drawing's Y-flip wrapper: translate(0 T) scale(1 -1).
            // Needed to compare screen-space rects against DXF-space bboxes.
            var flipY
            var tf = /translate\(0\s+([-\d.]+)\)\s*scale\(1\s+-1\)/.exec(svgText)
            if (tf !== null) {
              var candidate = parseFloat(tf[1])
              if (Number.isFinite(candidate)) flipY = candidate
            }
            setView({ status: 'ready', svg: payload.svg, count: countEntities(payload.stats), kind: payload.kind, ratio: ratio, flipY: flipY })
          } catch (error) {
            if (cancelled === true) return
            setView({ status: 'error', message: String((error && error.message) || error) })
          }
        }
        run()
        return function () { cancelled = true }
      }, [data])

      /**
       * Inline the SVG document the host rendered. Doing it with innerHTML keeps
       * every <path>/<text> a real node, which is the whole point: a hit test can
       * then map a click straight onto a DXF entity id.
       */
      var paintCanvas = function () {
        var node = canvasRef.current
        if (node === null || typeof view.svg !== 'string') return
        if (node.firstChild !== null) return          // already painted for this svg
        // innerHTML on an HTML element parses the SVG markup in the SVG namespace,
        // which is what makes the children addressable as real nodes.
        node.innerHTML = view.svg
        var svg = node.querySelector('svg')
        if (svg !== null) {
          // The stylesheet pins the SVG to the canvas box; keep it from swallowing
          // pointer events meant for the drawing itself.
          svg.style.display = 'block'
        }
        // Decorate entities with a hit-friendly class so the highlight rule applies.
        var arts = node.querySelectorAll('[data-pick]')
        for (var i = 0; i < arts.length; i++) arts[i].classList.add('corncad-hit')
      }

      // Paint whenever a fresh SVG arrives (or the canvas remounts).
      // NOTE: this hook must stay ABOVE the early returns below — React requires
      // the same hook order on every render, and returning early first would make
      // the loading render call one hook fewer and blow up the whole body.
      useEffect(function () {
        if (view.status !== 'ready') return
        paintCanvas()
      })

      if (data === undefined || view.status === 'loading') {
        return h('div', { className: 'corncad-status' }, t('loading'))
      }
      if (view.status === 'error') {
        return h('div', { className: 'corncad-status', role: 'alert' },
          h('strong', null, t('failed')),
          h('span', { className: 'corncad-msg' }, view.message))
      }

      /** Highlight exactly the selected entity ids; everything else goes quiet. */
      var applyHighlight = function (ids) {
        var node = canvasRef.current
        if (node === null) return
        var arts = node.querySelectorAll('[data-pick]')
        var wanted = {}
        for (var k = 0; k < ids.length; k++) wanted[ids[k]] = true
        for (var i = 0; i < arts.length; i++) {
          var art = arts[i]
          var on = wanted[art.getAttribute('data-pick')] === true
          if (on) art.classList.add('corncad-sel')
          else art.classList.remove('corncad-sel')
          // <text> is filled, not stroked, so it needs the fill rule to turn
          // orange at all — the stroke rule alone leaves labels looking unchanged.
          if (art.tagName.toLowerCase() === 'text') {
            if (on) art.classList.add('corncad-seltext')
            else art.classList.remove('corncad-seltext')
          }
        }
      }

      /**
       * Turn the current selection into the host-side record the agent reads.
       *
       * The drawing's absolute path travels with it, so the record lands beside
       * the .dxf/.dwg instead of in whatever directory the host process happens
       * to have been started from — that is what lets the agent answer "which
       * drawing" without being told a path.
       *
       * @param {Array<object>} items pick records for the current selection.
       * @param {string} [instruction] text the user typed in the bubble.
       * @returns {Promise<object|null>} the host acknowledgement, when one arrived.
       */
      var recordSelection = function (items, instruction) {
        var payload = { file: name, path: drawingPath, picks: items }
        if (typeof instruction === 'string' && instruction !== '') payload.instruction = instruction
        return fetch('/api/corn-cad/selection', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(payload),
        }).then(function (response) { return response.ok ? response.json() : null })
          .catch(function () { return null })
      }

      /** Record without blocking the UI, and report the recorded count. */
      var publishSelection = function (items) {
        recordSelection(items).then(function (acknowledged) {
          if (acknowledged !== null && acknowledged.ok === true) {
            setNotice(t('picked', { count: items.length }))
          }
        })
      }

      /** Commit a selection set: state, highlight, and the host record. */
      var commitSelection = function (ids) {
        var index = pickRef.current || {}
        // Only region mode clips: entity mode means the whole entity, so the record
        // stays unclipped and the prompt describes it as a whole.
        var band = selectMode === 'entity' ? null : bandRectRef.current
        var items = []
        for (var i = 0; i < ids.length; i++) {
          var meta = index[ids[i]]
          if (meta === undefined) continue
          if (band !== null) {
            // The circled part, so the agent edits this run rather than the whole
            // entity. Entities with no outline simply carry no `inBand`.
            var inBand = clipToBand(meta, band)
            if (inBand.length >= 4) {
              var copy = {}
              for (var key in meta) copy[key] = meta[key]
              copy.inBand = inBand
              items.push(copy)
              continue
            }
          }
          items.push(meta)
        }
        selectionRef.current = items
        setSelection(items)
        applyHighlight(ids)
        if (items.length > 0) publishSelection(items)
      }

      /**
       * Open the instruction bubble at a screen point.
       *
       * The anchor is stored in viewport coordinates so the bubble can be laid
       * out with position:fixed and stay put while the drawing scrolls; it is
       * clamped so it never runs off the right or bottom edge.
       */
      /**
       * The panel box the overlays are positioned against.
       *
       * The band and the bubble are absolutely positioned inside .corncad-root, so
       * every coordinate has to be in that element's own space. Measuring the
       * window instead was the bug: a document-preview sidebar is a few hundred
       * pixels wide while the window is well over a thousand, so a bubble clamped
       * to window.innerWidth landed outside the panel and was clipped by it.
       *
       * @returns {{left:number,top:number,width:number,height:number}}
       */
      var panelRect = function () {
        var node = rootRef.current
        if (node !== null && typeof node.getBoundingClientRect === 'function') {
          var rect = node.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          }
        }
        return { left: 0, top: 0, width: typeof window === 'undefined' ? 0 : window.innerWidth, height: typeof window === 'undefined' ? 0 : window.innerHeight }
      }

      /** Viewport point -> point inside the panel. */
      var toPanelPoint = function (clientX, clientY) {
        var box = panelRect()
        return { x: clientX - box.left, y: clientY - box.top }
      }

      /**
       * Open the instruction bubble at a screen point.
       *
       * The anchor is converted into panel space and clamped to the panel, so the
       * bubble stays fully visible: beside the pointer when there is room, flipped
       * to the other side when there is not, and never past an edge.
       */
      var openBubble = function (clientX, clientY) {
        var box = panelRect()
        var BW = Math.min(300, Math.max(180, box.width - 16))
        // Height is reserved for the textarea plus the button row and hint.
        var BH = 172
        var point = toPanelPoint(clientX, clientY)
        // Prefer below-right of the pointer; flip when that would overflow.
        var left = point.x + 12
        if (left + BW > box.width - 8) left = point.x - BW - 12
        left = Math.min(Math.max(8, left), Math.max(8, box.width - BW - 8))
        var top = point.y + 12
        if (top + BH > box.height - 8) top = point.y - BH - 12
        top = Math.min(Math.max(8, top), Math.max(8, box.height - BH - 8))
        setBubble({ left: left, top: top })
        setBubbleText('')
      }

      /**
       * Resolve the conversation service for THIS document tab.
       *
       * `conversation.send` is a session-scoped method: it reads the caller's
       * Agent scope tag and throws "requires a session scope" on a root context.
       * A dynamic plugin package mounts at the root, so the root service can
       * never send — the tab's own session scope has to be addressed first.
       *
       * Two routes are tried, cheapest first:
       *   1. the scope the keyed slot already resolved (`ctx.sessions.scope(id)`),
       *   2. the session id carried by the tab's `dsh-resource://file/session/…`
       *      address, which the document preview hands over as resourceAddress.
       *
       * @returns {{ send: (text: string) => Promise<void> } | null}
       */
      var scopedConversation = function () {
        var services = props.ctx !== undefined && props.ctx !== null ? props.ctx : null
        if (services === null || typeof services.get !== 'function') return null
        // 1) The scope this tab was rendered under.
        var fromProps = props.conversation
        if (fromProps !== undefined && fromProps !== null && typeof fromProps.send === 'function') return fromProps
        // 2) Resolve the session scope from the address, then take its conversation.
        var sessions = services.get('sessions')
        var sessionId = sessionIdOf(props.resourceAddress)
        if (sessions !== undefined && sessions !== null && sessionId !== '' && typeof sessions.scope === 'function') {
          var scope = sessions.scope(sessionId)
          if (scope !== undefined && scope !== null && typeof scope.get === 'function') {
            var scoped = scope.get('conversation')
            // Guard against the root service leaking through: it cannot send here.
            if (scoped !== undefined && scoped !== null && typeof scoped.send === 'function') return scoped
          }
        }
        return null
      }

      /**
       * Send the bubble's instruction as a chat prompt.
       *
       * The prompt is self-contained: it names the drawing (file name, absolute
       * path), what the user typed, and every selected entity with its type,
       * layer, handle and world-space bounds. The same facts are written to the
       * record beside the drawing, so the agent can re-read them later instead of
       * depending on this one message.
       */
      /**
       * Compose the prompt handed to the agent.
       *
       * Written in the drawing's own language of reference: what the user typed,
       * which entities, where they sit in DXF world coordinates, and exactly which
       * file holds the machine-readable detail. `recordPath` comes from the host's
       * acknowledgement, so it is the real path, not a client-side guess.
       *
       * @param {Array<object>} items pick records.
       * @param {string} instruction what the user typed.
       * @param {string} recordPath where the host stored the selection.
       * @returns {string} the prompt text.
       */
      var buildPrompt = function (items, instruction, recordPath) {
        var ids = items.map(function (p) {
          return p.id + '(' + p.type + (p.inBand !== undefined ? ', 仅框内部分)' : ')')
        }).slice(0, 20)
        var lines = ['【图纸修改】文件：' + name]
        if (drawingPath !== '') lines.push('图纸路径：' + drawingPath)
        lines.push('框选修改内容：' + instruction)
        lines.push('选中 ' + items.length + ' 个图元：' + ids.join(', '))
        var bounds = describeSelection(items)
        if (bounds !== '') lines.push('范围（DXF 世界坐标）：' + bounds)
        // Say plainly that the circled region is the subject, so a long entity is
        // edited where it was grabbed rather than end to end.
        var clipped = items.filter(function (p) { return p.inBand !== undefined })
        if (clipped.length > 0) {
          lines.push('框选模式：区域 —— 修改范围以框内部分为准（记录里的 inBand 是该段折线，' +
            '坐标为 DXF 世界坐标）；未列 inBand 的图元按整体处理。')
        } else {
          lines.push('框选模式：图元 —— 下列图元整体参与修改。')
        }
        if (recordPath !== '') lines.push('选中集已写入：' + recordPath)
        return lines.join('\n')
      }

      var sendBubble = function () {
        var text = bubbleText.trim()
        if (text === '' || bubbleBusy === true) return
        var items = selectionRef.current
        var conv = scopedConversation()
        if (conv === null) {
          // No session scope reached this tab: keep the user's words, give an
          // honest failure, and never pretend the agent was told.
          setBubbleBusy(true)
          recordSelection(items, text).then(function () {
            setBubbleBusy(false)
            setNotice(t('sendFailed', { message: t('noSession') }))
          })
          return
        }
        setBubbleBusy(true)
        // Record first: even when the send fails, the agent can still read exactly
        // what was circled, and the user's words are not lost.
        recordSelection(items, text).then(function (acknowledged) {
          var stored = acknowledged !== null && acknowledged.ok === true && typeof acknowledged.file === 'string'
            ? acknowledged.file
            : ''
          return Promise.resolve(conv.send(buildPrompt(items, text, stored))).then(function () {
            setBubbleBusy(false)
            setBubble(null)
            setBubbleText('')
            setNotice(t('sent', { count: items.length }))
          })
        }).catch(function (error) {
          // Never claim success here: the record was written, but the prompt was not.
          setBubbleBusy(false)
          setNotice(t('sendFailed', { message: String((error && error.message) || error) }))
        })
      }

      /** Pick the deepest entity under a pointer position. */
      var entityIdAt = function (clientX, clientY) {
        var node = canvasRef.current
        if (node === null || typeof document.elementFromPoint !== 'function') return ''
        var el = document.elementFromPoint(clientX, clientY)
        if (el === null) return ''
        var holder = el.closest !== undefined ? el.closest('[data-pick]') : null
        if (holder !== null) return holder.getAttribute('data-pick') || ''
        return ''
      }

      /**
       * Map a screen-space rectangle to drawing coordinates using the inline
       * SVG's screen CTM.
       *
       * IMPORTANT: the two spaces disagree about the Y axis. `getScreenCTM` lands
       * in SVG user units (Y grows downward) while `picks[].bbox` is authored in
       * DXF world space (Y grows upward, and the document is drawn inside a
       * `translate(0 T) scale(1 -1)` wrapper). Comparing the two directly makes a
       * drag select the vertical mirror image of what was dragged.
       *
       * So we convert the screen rect into SVG units, then flip it into DXF space
       * with  dxfY = flipY - svgY.
       *
       * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
       */
      var rectInDrawing = function (x1, y1, x2, y2) {
        var node = canvasRef.current
        if (node === null) return null
        var svg = node.querySelector('svg')
        if (svg === null || typeof svg.getScreenCTM !== 'function') return null
        var ctm = svg.getScreenCTM()
        if (ctm === null) return null
        var inv = ctm.inverse()
        var pt = svg.createSVGPoint()
        var corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(function (pair) {
          pt.x = pair[0]
          pt.y = pair[1]
          var q = pt.matrixTransform(inv)
          return [q.x, q.y]
        })
        var sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity
        for (var i = 0; i < corners.length; i++) {
          if (corners[i][0] < sxMin) sxMin = corners[i][0]
          if (corners[i][0] > sxMax) sxMax = corners[i][0]
          if (corners[i][1] < syMin) syMin = corners[i][1]
          if (corners[i][1] > syMax) syMax = corners[i][1]
        }
        // Flip into DXF space. flipY is the constant the renderer used in
        // translate(0 flipY) scale(1 -1); without it the Y range is mirrored.
        var flipY = drawingFlipY()
        if (flipY === null) return { minX: sxMin, minY: syMin, maxX: sxMax, maxY: syMax }
        return { minX: sxMin, minY: flipY - syMax, maxX: sxMax, maxY: flipY - syMin }
      }

      /**
       * Read the constant out of the drawing's Y-flip wrapper, e.g.
       * `translate(0 297) scale(1 -1)` -> 297.
       * @returns {number|null}
       */
      var drawingFlipY = function () {
        if (view.flipY !== undefined) return view.flipY
        return null
      }

      /**
       * A left-button press on the drawing pans it, exactly like a CAD viewer, so
       * the drawing is never stuck. Selecting is the right button's job, or Shift
       * + left when the user wants to add without opening the bubble.
       */
      var onCanvasPointerDown = function (event) {
        if (event.button === 2) {
          // Right button: rubber-band select, and open the bubble on release.
          event.preventDefault()
          selectBoxRef.current = {
            x: event.clientX, y: event.clientY, moved: false,
            additive: event.shiftKey === true, bubble: true,
          }
          return
        }
        if (event.button !== 0) return
        if (event.shiftKey === true) {
          // Shift + left: select (additive) without the bubble.
          selectBoxRef.current = {
            x: event.clientX, y: event.clientY, moved: false,
            additive: true, bubble: false,
          }
          return
        }
        // Plain left button: pan.
        var node = scrollRef.current
        if (node === null) return
        dragRef.current = {
          id: event.pointerId, x: event.clientX, y: event.clientY,
          left: node.scrollLeft, top: node.scrollTop, moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* best effort */ }
        setDragging(true)
      }
      var onCanvasPointerMove = function (event) {
        // A left-button drag that started on the drawing pans it.
        var drag = dragRef.current
        if (drag !== null && drag.id === event.pointerId) {
          if (Math.abs(event.clientX - drag.x) > 2 || Math.abs(event.clientY - drag.y) > 2) drag.moved = true
          var node = scrollRef.current
          if (node !== null) {
            node.scrollLeft = drag.left - (event.clientX - drag.x)
            node.scrollTop = drag.top - (event.clientY - drag.y)
          }
          return
        }
        var box = selectBoxRef.current
        if (box === null) return
        var dx = event.clientX - box.x, dy = event.clientY - box.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          box.moved = true
          setSelecting(true)
          // Live rubber band, in panel space like the bubble (see openBubble).
          var from = toPanelPoint(box.x, box.y)
          var to = toPanelPoint(event.clientX, event.clientY)
          setBand({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
                    width: Math.abs(dx), height: Math.abs(dy) })
        }
      }
      var onCanvasPointerUp = function (event) {
        // Finish a pan that the canvas itself started.
        var drag = dragRef.current
        if (drag !== null && drag.id === event.pointerId) {
          dragRef.current = null
          setDragging(false)
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
          // A left press that never moved is a click: select the entity under it,
          // additive with Shift, and no bubble.
          if (drag.moved !== true) {
            var hit = entityIdAt(event.clientX, event.clientY)
            if (hit !== '') {
              var picked = event.shiftKey === true ? selectionRef.current.map(function (p) { return p.id }) : []
              if (picked.indexOf(hit) < 0) picked.push(hit)
              commitSelection(picked)
            }
          }
          return
        }
        var box = selectBoxRef.current
        selectBoxRef.current = null
        setSelecting(false)
        setBand(null)
        if (box === null) return
        var ids = []
        if (box.moved !== true) {
          // Plain click: select the one entity under the cursor.
          var id = entityIdAt(event.clientX, event.clientY)
          if (id !== '') ids = [id]
        } else {
          // Drag: decide by real coverage, not by bounding box.
          //
          // A bbox test cannot work here: the sheet border is a single 420x297
          // polyline and table rules span the full width, so a small band anywhere
          // "intersects" them and drags the whole frame in. The host now sends each
          // entity's outline (`pts`), so we count how many of those points fall in
          // the band and take the entity when most of it is covered — or when it
          // is fully inside, which is the strict directional-select case.
          var rect = rectInDrawing(box.x, box.y, event.clientX, event.clientY)
          var index = pickRef.current || {}
          if (rect !== null) {
            for (var key in index) {
              // Region mode takes anything the band crosses; entity mode keeps the
              // stricter coverage rule so whole large entities are not dragged in.
              var take = selectMode === 'entity' ? coversBand(index[key], rect) : touchesBand(index[key], rect)
              if (take) ids.push(key)
            }
          }
        }
        // Remember the band: the record and the prompt carry the clipped run, not
        // just the entity, so "this bit" means this bit.
        if (box.moved === true) bandRectRef.current = rectInDrawing(box.x, box.y, event.clientX, event.clientY)
        else bandRectRef.current = null
        if (box.additive === true) {
          var current = selectionRef.current.map(function (p) { return p.id })
          for (var k = 0; k < ids.length; k++) if (current.indexOf(ids[k]) < 0) current.push(ids[k])
          ids = current
        }
        if (ids.length === 0) {
          setSelection([])
          selectionRef.current = []
          applyHighlight([])
          setNotice('')
          setBubble(null)
          return
        }
        commitSelection(ids)
        // Right-button selection opens the bubble right where the user released,
        // pre-anchored to that screen point but kept inside the viewport.
        if (box.bubble === true) {
          openBubble(event.clientX, event.clientY)
        }
      }

      /**
       * Does the rubber band take this entity?
       *
       * Uses the entity's real outline when the host supplied one:
       *   - everything inside the band            -> yes (window select)
       *   - most of the outline inside the band   -> yes (what the user aimed at)
       * and falls back to a bbox test only for entities without outline data.
       *
       * The "most of it" threshold is what keeps a full-width table rule or the
       * sheet border out of a small selection: a 10% band covers ~10% of such a
       * line, far below the bar.
       *
       * @param {{bbox:number[], pts?:number[]}} entity pick record.
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect band.
       * @returns {boolean}
       */
      /**
       * Does the band cover enough of this entity to take it whole?
       *
       * This is the "entity" mode: everything inside the band, or at least half of
       * the outline, which keeps a full-sheet border out of a small selection.
       * It is deliberately stricter than {@link touchesBand}.
       *
       * @param {{bbox:number[], pts?:number[]}} entity pick record.
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect band.
       * @returns {boolean}
       */
      var coversBand = function (entity, rect) {
        var b = entity.bbox
        if (b === null || b === undefined) return false
        if (b[0] > rect.maxX || b[2] < rect.minX || b[1] > rect.maxY || b[3] < rect.minY) return false
        if (b[0] >= rect.minX && b[2] <= rect.maxX && b[1] >= rect.minY && b[3] <= rect.maxY) return true
        var pts = entity.pts
        if (pts === undefined || pts.length < 4) {
          var midX = (b[0] + b[2]) / 2, midY = (b[1] + b[3]) / 2
          return midX >= rect.minX && midX <= rect.maxX && midY >= rect.minY && midY <= rect.maxY
        }
        var total = pts.length / 2
        var hit = 0
        for (var i = 0; i < pts.length; i += 2) {
          if (pts[i] >= rect.minX && pts[i] <= rect.maxX && pts[i + 1] >= rect.minY && pts[i + 1] <= rect.maxY) hit++
        }
        return hit / total >= 0.5
      }

      /**
       * Does this entity pass through, or sit inside, the band?
       *
       * This is region semantics, not whole-entity semantics: a band that clips
       * one segment of a full-width centre line takes that line. An earlier
       * version required half of the outline to be covered, which made a line
       * spanning the sheet impossible to grab by its middle — the opposite of what
       * "circle this bit" means.
       *
       * Entities are approximated by their sampled outline (`pts`), which is what
       * the host already returns; a point inside the band, a segment crossing it,
       * or a vertex pair spanning it all count.
       *
       * @param {{bbox:number[], pts?:number[]}} entity pick record.
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect band.
       * @returns {boolean}
       */
      var touchesBand = function (entity, rect) {
        var b = entity.bbox
        if (b === null || b === undefined) return false
        // Fast reject: the boxes do not even overlap.
        if (b[0] > rect.maxX || b[2] < rect.minX || b[1] > rect.maxY || b[3] < rect.minY) return false
        // Whole entity inside the band.
        if (b[0] >= rect.minX && b[2] <= rect.maxX && b[1] >= rect.minY && b[3] <= rect.maxY) return true
        var pts = entity.pts
        if (pts === undefined || pts.length < 4) {
          // No outline: accept on bbox overlap, which the reject above allowed.
          return true
        }
        var inside = function (x, y) {
          return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY
        }
        for (var i = 0; i < pts.length; i += 2) {
          if (inside(pts[i], pts[i + 1])) return true
        }
        // No vertex inside: a long segment can still cross the band corner to
        // corner without either endpoint being inside, so test the edges too.
        var count = pts.length / 2
        for (var k = 0; k < count; k++) {
          var j = (k + 1) % count
          if (segmentHitsRect(pts[k * 2], pts[k * 2 + 1], pts[j * 2], pts[j * 2 + 1], rect)) return true
        }
        return false
      }

      /** Liang-Barsky: does the segment a->b intersect the axis-aligned rect? */
      var segmentHitsRect = function (xa, ya, xb, yb, rect) {
        var dx = xb - xa, dy = yb - ya
        var t0 = 0, t1 = 1
        var clip = function (p, q) {
          if (p === 0) return q >= 0
          var r = q / p
          if (p < 0) {
            if (r > t1) return false
            if (r > t0) t0 = r
          } else {
            if (r < t0) return false
            if (r < t1) t1 = r
          }
          return true
        }
        if (!clip(-dx, xa - rect.minX)) return false
        if (!clip(dx, rect.maxX - xa)) return false
        if (!clip(-dy, ya - rect.minY)) return false
        if (!clip(dy, rect.maxY - ya)) return false
        return t0 <= t1
      }

      /**
       * The part of an entity that falls inside the band, as a polyline.
       *
       * The agent has to know *which bit* was circled. Sending the whole centre
       * line when the user grabbed 10 mm of it is the difference between a usable
       * instruction and a wrong edit, so the clipped run travels with the pick.
       *
       * @param {{pts?:number[]}} entity pick record.
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect band.
       * @returns {number[]} flat [x0,y0,x1,y1,...] inside the band, or [].
       */
      var clipToBand = function (entity, rect) {
        var pts = entity.pts
        if (pts === undefined || pts.length < 4) return []
        var out = []
        var count = pts.length / 2
        for (var k = 0; k < count; k++) {
          var j = (k + 1) % count
          // Clip every segment, including the ones whose endpoints both sit
          // outside the band: a centre line crossing the band is exactly that
          // case, and it is the case this feature exists for.
          var run = clipSegment(pts[k * 2], pts[k * 2 + 1], pts[j * 2], pts[j * 2 + 1], rect)
          if (run === null) continue
          out.push(run[0], run[1], run[2], run[3])
        }
        // Collapse repeated points so the record stays readable.
        var clean = []
        for (var i = 0; i < out.length; i += 2) {
          var n = clean.length
          if (n >= 2 && Math.abs(clean[n - 2] - out[i]) < 1e-6 && Math.abs(clean[n - 1] - out[i + 1]) < 1e-6) continue
          clean.push(out[i], out[i + 1])
        }
        return clean.length >= 2 ? clean : []
      }

      /** Liang-Barsky clip of one segment onto the rect; null when fully outside. */
      var clipSegment = function (xa, ya, xb, yb, rect) {
        var dx = xb - xa, dy = yb - ya
        var t0 = 0, t1 = 1
        var clip = function (p, q) {
          if (p === 0) return q >= 0
          var r = q / p
          if (p < 0) {
            if (r > t1) return false
            if (r > t0) t0 = r
          } else {
            if (r < t0) return false
            if (r < t1) t1 = r
          }
          return true
        }
        if (!clip(-dx, xa - rect.minX)) return null
        if (!clip(dx, rect.maxX - xa)) return null
        if (!clip(-dy, ya - rect.minY)) return null
        if (!clip(dy, rect.maxY - ya)) return null
        if (t0 > t1) return null
        return [xa + t0 * dx, ya + t0 * dy, xa + t1 * dx, ya + t1 * dy]
      }

      var bar = h('div', { className: 'corncad-bar' },
        h('button', {
          type: 'button', className: 'corncad-btn', title: t('zoomOut'),
          onClick: function () { setZoom(function (value) { return Math.max(0.2, (value || 1) * 0.8) }) },
        }, '\u2212'),
        h('button', {
          type: 'button', className: 'corncad-btn', title: t('zoomIn'),
          onClick: function () { setZoom(function (value) { return Math.min(25, (value || 1) * 1.25) }) },
        }, '+'),
        h('button', {
          type: 'button', className: 'corncad-btn', title: t('fit'),
          onClick: function () { setZoom(0) },
        }, t('fit')),
        // How a right-drag translates into a selection. Region takes the part of an
        // entity the band touches (a run of a long line); Entity takes it whole.
        h('div', {
          className: 'corncad-seg', role: 'group',
          'aria-label': t('modeLabel'), title: t('modeLabel'),
        },
          h('button', {
            type: 'button',
            'aria-pressed': selectMode === 'region' ? 'true' : 'false',
            title: t('modeRegionTip'),
            onClick: function () { setSelectMode('region') },
          }, t('modeRegion')),
          h('button', {
            type: 'button',
            'aria-pressed': selectMode === 'entity' ? 'true' : 'false',
            title: t('modeEntityTip'),
            onClick: function () { setSelectMode('entity') },
          }, t('modeEntity'))),
        // Transient feedback (recorded / sent / failed). It used to be stored in
        // state but never rendered, so the user got no confirmation at all.
        notice === '' ? null : h('span', { className: 'corncad-notice' }, notice),
        h('span', { className: 'corncad-meta' }, t('entities', { count: view.count })))

      var style = zoom === 0 ? { width: '100%' } : { width: (zoom * 100) + '%' }
      // Give the canvas a real aspect ratio taken from the SVG's viewBox, so it has
      // an intrinsic height to lay out against. Without this an inline SVG sized
      // 100%x100% has nothing to resolve against and the panel renders blank.
      // ratio is viewBox width / height, matching CSS aspect-ratio semantics.
      if (view.ratio !== undefined && view.ratio > 0) style.aspectRatio = String(view.ratio)
      style.minHeight = '120px'

      // Selection read-out: what the agent was told, so the user can confirm the
      // two of them are talking about the same entity.
      var selBar = null
      if (selection.length > 0) {
        var first = selection[0]
        var label = first.type + (first.layer ? '  ·  ' + first.layer : '')
        selBar = h('div', { className: 'corncad-selinfo' },
          h('b', null, label),
          h('span', { className: 'corncad-selcount' }, t('selected', { count: selection.length })),
          h('button', {
            type: 'button', className: 'corncad-selclear', title: t('clearSel'),
            onClick: function () {
              selectionRef.current = []
              setSelection([])
              setNotice('')
              applyHighlight([])
            },
          }, t('clearSel')))
      }

      return h('div', { className: 'corncad-root', ref: rootRef },
        bar,
        h('div', {
          className: dragging === true ? 'corncad-scroll corncad-dragging' : 'corncad-scroll',
          ref: bindScrollport,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          // Right-click selects here, so the context menu must step aside.
          onContextMenu: function (event) { event.preventDefault() },
        },
          h('div', {
            ref: canvasRef,
            className: selecting ? 'corncad-canvas corncad-canvas-selecting' : 'corncad-canvas',
            style: style,
            // The SVG is inlined (not an <img>) so each entity stays a real DOM
            // node: that is what makes click-to-select possible at all.
            onPointerDown: onCanvasPointerDown,
            onPointerMove: onCanvasPointerMove,
            onPointerUp: onCanvasPointerUp,
            onPointerCancel: onCanvasPointerUp,
          })),
        selBar,
        // Rubber band, then the instruction bubble — both fixed-position so they
        // float above the scroller instead of scrolling with the drawing.
        band === null ? null : h('div', {
          className: 'corncad-band',
          style: { left: band.x + 'px', top: band.y + 'px', width: band.width + 'px', height: band.height + 'px' },
        }),
        bubble === null ? null : h('div', {
          className: 'corncad-bubble',
          style: { left: bubble.left + 'px', top: bubble.top + 'px' },
        },
          h('div', { className: 'corncad-bubble-h' },
            t('bubbleTitle'),
            h('span', null, t('selected', { count: selection.length }))),
          h('textarea', {
            value: bubbleText,
            placeholder: t('bubblePlaceholder'),
            autoFocus: true,
            onChange: function (event) { setBubbleText(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Escape') { setBubble(null); return }
              if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
                event.preventDefault()
                sendBubble()
              }
            },
          }),
          h('div', { className: 'corncad-bubble-f' },
            h('button', {
              type: 'button', className: 'primary',
              disabled: bubbleText.trim() === '' || bubbleBusy === true,
              onClick: sendBubble,
            }, bubbleBusy ? '…' : t('bubbleSend')),
            h('button', {
              type: 'button',
              onClick: function () { setBubble(null) },
            }, t('bubbleCancel')),
            h('span', { className: 'hint' }, t('bubbleHint')))))
    }

    /**
     * Register the dictionaries, the renderer metadata, and its body.
     * @param ctx client plugin context.
     */
    function apply(ctx) {
      ensureStyle()
      syncTheme()
      var locale = ctx.get('locale')
      var translate
      if (locale !== undefined) {
        ctx.effect(function () {
          var offZh = locale.register(NS, 'zh', DICT.zh)
          var offEn = locale.register(NS, 'en', DICT.en)
          try { translate = locale.bind(NS) } catch (error) { translate = undefined }
          return function () {
            translate = undefined
            offZh()
            offEn()
          }
        }, 'dsh-corn-cad: dictionaries')
      }

      var t = function (key, params) {
        var text
        if (translate !== undefined) text = translate(key)
        if (text === undefined || text === null || text === '' || text === key) text = DICT.zh[key] || key
        if (params !== undefined && params !== null) {
          for (var name in params) text = text.split('{' + name + '}').join(String(params[name]))
        }
        return text
      }

      // The document-preview registry is provided by the shipped
      // sidebar-documentpreview plugin, which the bundle metadata loads first; poll
      // briefly so a slow provider cannot silently drop the renderer.
      var attempts = 0
      var wired = false
      var wire = function () {
        if (wired) return
        var previews = ctx.get('documentPreviews')
        if (previews === undefined) {
          if (attempts++ < 40) setTimeout(wire, 150)
          return
        }
        wired = true
        ctx.effect(function () {
          return previews.register({
            id: BODY_ID,
            extensions: EXTENSIONS,
            binaryExtensions: EXTENSIONS,
            priority: 'extension',
            title: function () { return t('title') },
            loading: 'bytes-complete',
            wrap: false,
          })
        }, 'dsh-corn-cad: metadata')
        ctx.slots.inject('sidebar.right.tab.document', function () {
          // The document slot is session-scoped, so its inject factory is handed
          // the owning session id. Resolving the conversation through that scope
          // is the only way `send` can work: the root service has no session tag
          // and rejects every call.
          return ctx.slots.register({
            name: 'sidebar.right.tab.document',
            key: BODY_ID,
            locale: NS,
            inject: function (sessionId) {
              var conversation
              try {
                var sessions = ctx.get('sessions')
                var scope = sessions !== undefined && sessions !== null && sessionId !== undefined && typeof sessions.scope === 'function'
                  ? sessions.scope(sessionId)
                  : undefined
                conversation = scope !== undefined && scope !== null && typeof scope.get === 'function'
                  ? scope.get('conversation')
                  : undefined
              } catch (error) {
                conversation = undefined
              }
              return { conversation: conversation, sessionId: sessionId }
            },
          }, function (bodyProps) {
            return h(DwgBody, Object.assign({}, bodyProps, { t: t, ctx: ctx }))
          })
        })
      }
      wire()
    }

    exports.apply = apply
    // `conversation` is the service that can send a prompt into the session; the
    // bubble uses it to hand the instruction straight to the agent.
    exports.inject = ['slots', 'sessions', 'conversation']
    return module.exports
  },
})
