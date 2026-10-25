# Corn CAD · dsh-corn-cad

[中文](README.md) | [English](README.en.md)

> Open `.dxf` / `.dwg` drawings in the DeepSeek Harness sidebar, **right-drag a region, type one
> line, hand it to the agent**. The agent gets *this region of this drawing* — not "that spot you
> mentioned".

![Corn CAD](docs/example.svg)

---

## What problem it solves

Handing a CAD drawing to an agent was never really about "reading it" — it is about **anchoring the
reference**.

"Make these holes bigger" leaves the agent guessing which holes. A screenshot gives it pixels but no
coordinates. This plugin closes that gap: right-drag a box in the preview and the circled entities,
layers, handles and world-coordinate extent travel into the conversation together with your sentence.
The agent does not have to guess.

**Version 0.1.0 does exactly this one thing, properly**: preview, circle, send.

---

## What it does

### Viewing

Open a `.dxf` or `.dwg` from the workspace file tree; the document preview tab on the right shows the
vector drawing.

| Action | Behaviour |
|---|---|
| Drag | Pan |
| Ctrl/⌘ + wheel | Zoom |
| Toolbar `−` `+` `Fit width` | Zoom controls |

### Circling (the selection board)

| Action | Behaviour |
|---|---|
| **Left-drag** | Pan the drawing |
| Click | Select the entity under the cursor |
| Shift + click | Add to the selection |
| **Right-drag** | Circle a region and open the instruction bubble |
| Shift + left-drag | Circle a region, no bubble |

The left button is always navigation: press and drag to pan, press without moving
to select. Circling belongs to the right button, so the two never fight over the
same gesture and the drawing is never stuck.

The **Region / Entity** switch on the toolbar decides the granularity of a band selection:

| Mode | Meaning | Use it for |
|---|---|---|
| **Region** (default) | Take what the band touches, and **record only that run**. A centre line spanning the sheet is grabbed by any short segment of it | Editing a detail |
| **Entity** | Take any entity the band covers, whole. Entities the band barely covers are left out (so a large frame is not dragged in) | A whole line or block |

In region mode each pick carries `inBand`: the polyline of that entity lying inside the band, in DXF
world coordinates. The message to the agent states the mode explicitly — "region, edit the circled
part" — so a long line is never rewritten end to end by accident.

Neither mode uses bounding-box intersection. The sheet border is a single 420×297 polyline and table
rules span the whole sheet, so a bbox test drags the entire frame in wherever you drag.

### Bubble → agent

Right-drag, release, and the bubble opens at the pointer. Type "make these lines black" and press
`Ctrl/⌘ + Enter`, or click Send.

The message that reaches the conversation looks like this:

```
【图纸修改】文件：30010877-CAD_A01.dxf
图纸路径：/Users/you/work/30010877-CAD_A01.dxf
框选修改内容：这几根线改成黑色
选中 3 个图元：e1(LINE), e2(LINE), e3(LINE)
范围（DXF 世界坐标）：x 3794.3..4102.5, y 1205.34..1502.34
选中集已写入：/Users/you/work/.corncad/selection.json
```

The same set is written to `.corncad/selection.json` **next to the drawing**:

```json
{
  "at": "2026-10-26T01:00:00.000Z",
  "drawing": "/Users/you/work/30010877-CAD_A01.dxf",
  "file": "30010877-CAD_A01.dxf",
  "instruction": "这几根线改成黑色",
  "count": 3,
  "picks": [
    { "type": "LINE", "layer": "0", "handle": "AF8", "depth": 0, "id": "e1",
      "bbox": [3794.30, 1205.34, 3794.30, 1502.34], "pts": [ ... ] }
  ]
}
```

The record sits beside the drawing rather than in the process cwd because the agent usually already
knows the drawing's path — it can read `.corncad/selection.json` directly without being told where the
file went. The record carries `handle`, so the agent can address the exact line in the DXF instead of
"the third line from the top left".

---

## Installation

Install the [DeepSeek Harness desktop app](https://www.deepseek.com/download/) first.

### Method 1 · Plugins page (recommended)

Sidebar **Plugins** → **Add plugin**, enter `https://github.com/xingyingyuzhui/dsh-corn-cad` →
install → enable. Then **restart DeepSeek Harness**: the host half is a process-level module.

### Method 2 · Command line

```bash
dsh plugin --profile <profile> add https://github.com/xingyingyuzhui/dsh-corn-cad
```

### Method 3 · Local directory

```bash
git clone https://github.com/xingyingyuzhui/dsh-corn-cad
dsh plugin --profile <profile> add /absolute/path/dsh-corn-cad
```

### Method 4 · Offline / restricted network

This package ships `vendor/@mlightcad/libredwg-web/` (the DWG decoder, about 12 MB). When the plugin
manager cannot reach a registry:

```bash
node tools/install-vendor.mjs --profile <profile>
```

> Only `.dwg` needs it; `.dxf` is plain text and never touches wasm.

---

## After installing

1. Open a `.dxf` from the file tree (`.dwg` needs the decoder above).
2. The drawing and its toolbar appear on the right, with the entity count at the bottom.
3. Right-drag a box → the entities turn orange → the bubble opens.
4. Type the instruction and press `Ctrl/⌘ + Enter`.
5. The agent receives the path, the entity list and the coordinate extent.

### Disable / uninstall

```yaml
# the profile's cordis.patch.yml
- id: corn-cad
  disabled: true
```

Uninstall: `dsh plugin --profile <profile> remove dsh-corn-cad`.

---

## Configuration

Set the theme in the profile's `cordis.patch.yml`:

```yaml
- id: corn-cad
  config:
    background: "#000000"
    foreground: "#ffffff"
```

⚠️ **Change both together.** DXF colour ACI 7 means "black or white, whichever contrasts with the
background" and is drawn with `foreground`. Changing only the background makes every line the same
colour as the page. The default is black on white.

---

## Notes

| Limitation | Detail |
|---|---|
| **`MULTILEADER` is not drawn** | Outside the renderer's entity list; leaders go missing |
| **Read-only** | No editing, no layer toggles, no export; changes need external scripts |
| **HATCH patterns** | The boundary is drawn, the fill pattern is not |
| **50% selection threshold** | An entity covered less than half is not selected (deliberate, to avoid dragging in large entities) |
| **Text boxes are estimated** | Width is estimated per character, not measured glyphs |
| **View state is not saved** | Reopening returns to fit-width |

Supported DXF entities: `LINE` `LWPOLYLINE` (with bulge arcs) `POLYLINE`+`VERTEX` `CIRCLE` `ARC`
`ELLIPSE` `TEXT` `MTEXT` `ATTRIB` `INSERT` (nested blocks, row/column arrays, rotation, scale)
`HATCH` `SOLID` `3DFACE` `POINT` `DIMENSION`. Entities outside that list are ignored silently — no
error, no drawing.

Chinese drawings: the declared `$DWGCODEPAGE` selects among 13 code pages (GBK / Big5 / Shift_JIS /
EUC-KR / windows-1250…1258 / windows-874); R2007+ is always UTF-8. `\U+XXXX`, `%%P`, `%%D` and `%%C`
all decode correctly.

---

## Self-check

The self-check needs no network, no Harness, no React and no installed dependencies. plain Node runs all 36 checks;
a clean run prints `36/36 checks passed` and exits 0, any failure exits non-zero, so it drops straight
into CI.

```bash
node test/selfcheck.mjs
```

Among other things it asserts: the renderer's entity tallies and SVG structure, the pick table,
**that a right-drag takes only the entities it covers**, **that the bubble sends through the session
scope with the path and coordinate extent attached**, **that a tab with no conversation scope reports
the failure instead of claiming success**, the host's four routes, the selection record round-trip,
the two locale dictionaries staying in step, and the packaging/licence invariants.

`pnpm test` first installs `dependencies` for real (writing `node_modules/` and `pnpm-lock.yaml`,
both gitignored and never shipped). With `@mlightcad/libredwg-web` installed the DWG check is skipped
with a printed reason — real decoding can only be verified inside a profile that has the dependency.

---

## Layout

```
index.js              host half: /api/corn-cad/{ping,svg,selection,theme}
client.js             browser half: inline SVG, entity picking, band select, bubble
lib/dxf2svg.mjs       dependency-free DXF -> SVG renderer (with the pick table)
cordis.patch.yml      the bundle patch inserted into a profile
icon.svg              brand mark (vector)
brand/                icon-source.png plus PNG sizes
docs/example.svg      the demo drawing, generated from test/sample.dxf
test/selfcheck.mjs    the plain-Node self-check
tools/                demo generator, offline dependency installer
vendor/               @mlightcad/libredwg-web (GPL-3.0, .dwg only)
```

Seam dependencies — DSH internals with no compatibility promise, which may break on upgrade:

- `documentPreviews.register()` (provided by `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`)
- `slots.register` / `slots.inject` (`sidebar.right.tab.document`, session-scoped)
- `connection.fetch.register` (the `/api` channel)
- `locale.register`
- `ctx.sessions.scope(id).get('conversation')` → `conversation.send()`

Verified against **DSH 0.2.1-rc.3**. If the bubble stops sending after an upgrade, check the last item
first: `conversation.send` is a **session-scoped** method and throws
`conversation.send requires a session scope` on a root context, so it must be reached through
`ctx.sessions.scope(id)`.

---

## Credits and third-party licences

The plugin skeleton and the dependency-free DXF renderer come from
[dsh-dwg-preview](https://github.com/linanbuan/dsh-dwg-preview) v1.0.0 (MIT) by
[@linanbuan](https://github.com/linanbuan). This repository adds the selection board, Chinese
code-page decoding, theming, entity picking and the instruction bubble.

`@mlightcad/libredwg-web` is **GPL-3.0**. It is vendored under `vendor/` for offline installs and is
needed only for `.dwg`. If your distribution must avoid GPL, remove `vendor/` and let users install
the dependency from a registry, or choose another DWG decoder.

---

## License

MIT for this repository's code. See [LICENSE](LICENSE) for the full text and
[THIRD-PARTY.md](THIRD-PARTY.md) for third-party components, including the
GPL-3.0 DWG decoder.

[MIT](LICENSE) © 2026 xingyingyuzhui
