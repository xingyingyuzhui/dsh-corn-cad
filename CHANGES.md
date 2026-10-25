# 变更说明 · dsh-corn-cad

本仓库是 **玉米 CAD**：DeepSeek Harness 侧边栏的 DXF/DWG 预览器 + 圈选画板。
0.1.0 是第一个自有版本，聚焦一件事：**右键圈选图纸的一块，把这块和你的指令一起交给 agent**。

---

## 0.1.0 · 圈选画板与指令气泡

### 一、修复：气泡"发送"其实从未发出

这是上游增强分支遗留的实质缺陷，也是本版本最重要的修复。

**现象**：右键框选后写指令、点「发送」，界面提示"已发送，等待处理"，
但对话里什么都没有。用户以为 agent 收到了，实际没有 —— 静默误导。

**根因**：`conversation.send()` 是 **session 作用域**方法。它内部走
`scopedSession()`，需要读取调用方上下文上的 Agent 作用域标签：

```js
scopeId(op) {
  const id = this.requireSessions().scopeOf(this.ctx)
  if (id === undefined) throw new Error(`conversation.${op} requires a session scope`)
  return id
}
```

而动态插件包挂在**根上下文**上，根上下文没有作用域标签，因此必然抛错。
旧代码拿到的是根级 `conversation`，`catch` 之后又提示"已发送"，于是失败被伪装成成功。

**修复**：文档预览的 keyed slot 是 `scope: "session"`，它的 `inject` 工厂本来就会拿到
所属 session id。改为在 slot 注册时经 `ctx.sessions.scope(id).get('conversation')`
取**会话作用域的** conversation，把结果注入 body：

```js
ctx.slots.register({
  name: 'sidebar.right.tab.document',
  key: BODY_ID,
  locale: NS,
  inject: function (sessionId) {
    var scope = ctx.sessions.scope(sessionId)
    return { conversation: scope.get('conversation'), sessionId: sessionId }
  },
}, function (bodyProps) { return h(DwgBody, ...) })
```

同时 `exports.inject` 增加 `sessions`。拿不到会话时**明确失败**，不再提示已发送。

用真实的 `@deepseek-ai/cordis` 复现过修复前后的差别：

```
# 修复前（根上下文）
bubble send FAILED -> conversation.send requires a session scope

# 修复后（会话作用域）
scoped send -> sent to sess-1: ...
```

### 二、新增：agent 知道"是哪张图的哪一部分"

旧版消息只带文件名和图元 id。agent 无法回答"哪个文件"和"哪片区域"。

现在消息带上**绝对路径**与**世界坐标范围**：

```
【图纸修改】文件：30010877-CAD_A01.dxf
图纸路径：/Users/you/work/30010877-CAD_A01.dxf
框选修改内容：这几根线改成黑色
选中 3 个图元：e1(LINE), e2(LINE), e3(LINE)
范围（DXF 世界坐标）：x 3794.3..4102.5, y 1205.34..1502.34
选中集已写入：/Users/you/work/.corncad/selection.json
```

图纸绝对路径来自文档预览提供的 `useResource(resourceAddress).value.absolutePath`，
回退到地址里自带的会话相对路径。选中集记录的路径取自**宿主回执**，不是客户端猜测 ——
消息里写的路径就是文件实际所在。

### 三、修复：选中集写到了错误的目录

旧版写 `path.join(process.cwd(), '.dsh-cad/...')`。DSH 宿主进程的 cwd 是
`~/.dsh/profiles/desktop`，不是用户工作区。于是 agent 按 README 去
`<workspace>/.dsh-cad/` 找不到任何东西。

**修复**：记录写到**图纸同目录** 的 `.corncad/selection.json`。agent 既然知道图纸路径，
就能直接读同目录的记录，不需要被告知。

记录结构：

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

`GET /api/corn-cad/selection?file=<图纸绝对路径>` 可回读；没有记录时返回
`{ "ok": true, "count": 0, "picks": [] }` 而不是报错。

### 四、品牌与命名

- 包名 / bundle 行 id / 客户端模块 id：`dsh-corn-cad`（patch 行 id `corn-cad`）
- API 前缀：`/api/corn-cad/{ping,svg,selection,theme}`
- CSS 前缀：`corncad-*`
- 状态目录：`.corncad/`
- 图标：`icon.svg`，由 `brand/icon-source.png` 重绘为纯矢量（9.6 KB，可任意缩放）

上游 `dsh-dwg-preview` 的名字只保留在许可与致谢处 —— MIT 要求保留署名，这是许可条件。

### 五、测试

上游的 `test/selfcheck.mjs` 是**上游契约测试**：31 项里 14 项硬编码了上游行为
（两条路由、`<img>` 渲染、`@local/dsh-dwg-preview` 包名等），与本仓库的有意改动直接冲突，
因此长期处于"大部分失败"状态 —— 也让上面那个真 bug 一直没被发现。

本版重写为覆盖真实能力的 32 项检查，纯 Node、无依赖、无网络：

| 新检查 | 守住的缺陷 |
|---|---|
| 右键拖框只取覆盖到的图元，并弹出气泡 | 框选判定与事件链路 |
| 气泡经 session scope 发出，带上路径与坐标 | 上面第一条 bug |
| 拿不到会话时明确报错，不假装已发送 | 静默误导 |
| keyed slot 的 inject 解析会话作用域 | 接缝用错 |
| 选中集落在图纸旁并可回读 | 上面第三条 bug |

框选测试用一份 Y 翻转常量为已知值的 SVG，把屏幕坐标与 DXF 世界坐标的对应关系固定下来 ——
这正是上游注释里反复警告却始终没有测试保护的地方。

### 六、其他

- 修复测试自身的 `**` glob 匹配（`vendor/**` 之前被误判为未覆盖）
- 去掉上游占位符 `<your-account>`，换成真实仓库地址
- `README-FORK.md` 合并进 `README.md` / `README.en.md`，不再保留两份互相矛盾的说明

---

## 与上游的关系

插件骨架、零依赖 DXF 渲染器、DWG(WASM) 解码路径来自
[dsh-dwg-preview](https://github.com/linanbuan/dsh-dwg-preview) v1.0.0（MIT）。
本仓库在其之上做上述改动。上游的 MIT 署名完整保留在 [LICENSE](LICENSE) 中。

## 已知限制

| 限制 | 说明 |
|---|---|
| `MULTILEADER` 不渲染 | 渲染器清单之外 |
| 只读 | 无编辑、无图层开关、无导出 |
| HATCH 只画边界 | 不画填充图案 |
| 框选阈值 50% | 覆盖不足一半选不中，避免误选大图元 |
| 文字外框为估算 | 按字符宽度估宽 |
| 不保存视图状态 | 重新打开回到适应宽度 |
