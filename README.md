# 玉米 CAD · dsh-corn-cad

[中文](README.md) | [English](README.en.md)

> 在 DeepSeek Harness 侧边栏直接看 `.dxf` / `.dwg` 图纸，**右键圈一块，写句话，交给 agent**。
> agent 拿到的是这张图的这个区域 —— 不是"你刚才说的那个地方"。

![玉米 CAD](docs/example.svg)

---

## 它解决什么

CAD 图纸交给 agent，最难的从来不是"看懂"，而是**对齐指代**。

你说"把这几个孔改大"，agent 不知道是哪个孔；你把图纸截图发过去，它拿到了像素却拿不到坐标。
这个插件把这一步接上：你在预览里右键拖出一个框，框住的图元、图层、句柄、世界坐标范围
会跟着你写的那句话一起进入对话。agent 不需要猜。

**当前版本（0.1.0）只做这一件事，并把它做扎实**：预览 + 圈选 + 气泡发消息。

---

## 功能

### 看图

在工作区文件树里点开 `.dxf` 或 `.dwg`，右侧文档预览标签直接显示矢量图纸。

| 操作 | 行为 |
|---|---|
| 拖拽 | 平移 |
| Ctrl/⌘ + 滚轮 | 缩放 |
| 工具栏 `−` `+` `适应宽度` | 缩放控制 |

### 圈选（画板）

| 操作 | 行为 |
|---|---|
| 单击 | 选中光标下图元 |
| Shift + 单击 | 追加选择 |
| **右键拖框** | 圈选并弹出指令气泡 |
| 左键拖框 | 只圈选，不弹气泡 |

框选按**真实几何覆盖度**判定，不是包围盒相交：图框是一条 420×297 的多段线、表格线横贯全图，
用包围盒判定的话，在任何位置小框一下都会把整张图框拖进选择集。本插件改为统计图元轮廓点
落在框内的比例 —— 完全在框内，或 ≥50% 轮廓点被框住，才算选中。

### 气泡 → 交给 agent

右键拖框、松手，气泡出现在指针位置。写下"这几根线改成黑色"，`Ctrl/⌘ + Enter` 或点「发送」。

进入对话的消息长这样：

```
【图纸修改】文件：30010877-CAD_A01.dxf
图纸路径：/Users/you/work/30010877-CAD_A01.dxf
框选修改内容：这几根线改成黑色
选中 3 个图元：e1(LINE), e2(LINE), e3(LINE)
范围（DXF 世界坐标）：x 3794.3..4102.5, y 1205.34..1502.34
选中集已写入：/Users/you/work/.corncad/selection.json
```

同时选中集写进**图纸旁边的** `.corncad/selection.json`：

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

记录放在图纸同目录而不是进程 cwd，是因为 agent 通常已经知道图纸路径 ——
它可以直接读 `.corncad/selection.json`，不用你告诉它文件在哪。记录里带 `handle`，
agent 能精确回到 DXF 里的那一根线，而不是"左上角第三条"。

---

## 安装

先装 [DeepSeek Harness 桌面端](https://www.deepseek.com/download/)。

### 方式一 · 插件页（推荐）

侧栏 **插件** → **添加插件**，填 `https://github.com/xingyingyuzhui/dsh-corn-cad` → 安装 → 启用。
安装后**重启 DeepSeek Harness**：宿主半边是进程级模块。

### 方式二 · 命令行

```bash
dsh plugin --profile <profile> add https://github.com/xingyingyuzhui/dsh-corn-cad
```

### 方式三 · 本地目录

```bash
git clone https://github.com/xingyingyuzhui/dsh-corn-cad
dsh plugin --profile <profile> add /绝对路径/dsh-corn-cad
```

### 方式四 · 离线 / 受限网络

本包自带 `vendor/@mlightcad/libredwg-web/`（DWG 解码依赖，约 12 MB）。
插件管理器无法联网时：

```bash
node tools/install-vendor.mjs --profile <profile>
```

> 只有 `.dwg` 需要这个依赖；`.dxf` 是纯文本，完全不碰 wasm。

---

## 装上之后

1. 在文件树里点开一张 `.dxf`（`.dwg` 需要上面那个解码依赖）。
2. 右侧出现图纸和工具栏，底部显示图元总数。
3. 右键拖一个框 → 图元变橙 → 气泡弹出。
4. 写指令，`Ctrl/⌘ + Enter`。
5. agent 收到带路径、图元清单和坐标范围的完整消息。

### 停用 / 卸载

```yaml
# profile 的 cordis.patch.yml
- id: corn-cad
  disabled: true
```

卸载：`dsh plugin --profile <profile> remove dsh-corn-cad`。

---

## 配置

主题在 profile 的 `cordis.patch.yml` 里改：

```yaml
- id: corn-cad
  config:
    background: "#000000"
    foreground: "#ffffff"
```

⚠️ **两者必须成对修改**。DXF 的 ACI 7 是"与背景对比的黑或白"，渲染时取 `foreground`。
只改背景会让所有线条与背景同色、整张图不可见。不配置则白底黑线。

---

## 注意事项

| 限制 | 说明 |
|---|---|
| **`MULTILEADER` 不渲染** | 渲染器清单之外，引线会缺失 |
| **只读** | 无编辑、无图层开关、无导出；改动需外部脚本 |
| **HATCH 图案填充** | 只画边界轮廓，不画填充图案 |
| **框选阈值 50%** | 覆盖不足一半的图元选不中（刻意为之，避免误选大图元） |
| **文字外框为估算** | 按字符宽度估宽，非真实字形度量 |
| **不保存视图状态** | 重新打开回到适应宽度 |

支持的 DXF 图元：`LINE` `LWPOLYLINE`（含 bulge 弧）`POLYLINE`+`VERTEX` `CIRCLE` `ARC` `ELLIPSE`
`TEXT` `MTEXT` `ATTRIB` `INSERT`（嵌套块 / 行列阵列 / 旋转 / 缩放）`HATCH` `SOLID` `3DFACE`
`POINT` `DIMENSION`。清单之外的实体被静默忽略（不报错、不绘制）。

中文图纸：按 `$DWGCODEPAGE` 自动识别 13 种代码页（GBK / Big5 / Shift_JIS / EUC-KR /
windows-1250~1258 / windows-874），R2007+ 一律 UTF-8。`\U+XXXX`、`%%P`、`%%D`、`%%C` 均正确解码。

---

## 自检

自检不需要网络、不需要 Harness、不需要 React、不需要安装任何依赖，纯 Node 跑完 32 项，
全部通过时打印 `32/32 checks passed` 并以 0 退出，任何一项失败就以非 0 退出（可直接接 CI）。

```bash
node test/selfcheck.mjs
```

它验证的东西包括：渲染器的图元计数与 SVG 结构、图元拾取表、**右键框选只取覆盖到的图元**、
**气泡经 session scope 发出并带上路径与坐标**、**拿不到会话时明确报错而不是假装已发送**、
宿主四条路由、选中集落盘与回读、中英文词典对齐、以及打包与许可约束。

`pnpm test` 会先按 `dependencies` 真的装一遍依赖（写 `node_modules/` 与 `pnpm-lock.yaml`，
两者都在 `.gitignore` 里、不随仓库分发）。装上 `@mlightcad/libredwg-web` 之后，DWG 那一项
会自动跳过并打印原因 —— 真实解码只能在装好依赖的 profile 里验证。

---

## 结构

```
index.js              宿主半边：/api/corn-cad/{ping,svg,selection,theme} 四条路由
client.js             浏览器半边：内联 SVG、图元拾取、框选、气泡
lib/dxf2svg.mjs       零依赖 DXF → SVG 渲染器（含拾取表）
cordis.patch.yml      插进 profile 的 bundle patch
icon.svg              品牌图标（矢量）
brand/                icon-source.png 与多尺寸 PNG
docs/example.svg      由 test/sample.dxf 生成的示例图
test/selfcheck.mjs    纯 Node 自检
tools/                生成示例图、安装离线依赖
vendor/               @mlightcad/libredwg-web（GPL-3.0，仅 .dwg 需要）
```

接缝依赖（DSH 内部形态，官方无兼容承诺，升级后可能失效）：

- `documentPreviews.register()`（由 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 提供）
- `slots.register` / `slots.inject`（`sidebar.right.tab.document`，session 作用域）
- `connection.fetch.register`（`/api` 通道）
- `locale.register`
- `ctx.sessions.scope(id).get('conversation')` → `conversation.send()`

已在 **DSH 0.2.1-rc.3** 上实测。升级后若气泡发不出去，优先检查最后一项：
`conversation.send` 是 **session 作用域**方法，在根上下文调用会抛
`conversation.send requires a session scope`，必须先用 `ctx.sessions.scope(id)` 拿到作用域。

---

## 致谢与第三方许可

插件骨架与零依赖 DXF 渲染器来自 [@linanbuan](https://github.com/linanbuan) 的
[dsh-dwg-preview](https://github.com/linanbuan/dsh-dwg-preview) v1.0.0（MIT）。
本仓库在其基础上做了圈选画板、中文代码页解码、主题、图元拾取与指令气泡。

`@mlightcad/libredwg-web` 是 **GPL-3.0**，随包放在 `vendor/` 便于离线安装，仅 `.dwg` 需要。
若你的分发方式需要规避 GPL，请移除 `vendor/` 并让用户从 registry 安装依赖，或改用其他 DWG 方案。

---

## License

MIT —— 本仓库代码。完整声明见 [LICENSE](LICENSE)，第三方组件（含 GPL-3.0 的
DWG 解码器）见 [THIRD-PARTY.md](THIRD-PARTY.md)。

[MIT](LICENSE) © 2026 xingyingyuzhui
