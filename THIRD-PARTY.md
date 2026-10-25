# 第三方组件 / Third-party components

本仓库自身代码为 MIT（见 [LICENSE](LICENSE)）。下列第三方组件各有自己的许可。

This repository's own code is MIT (see [LICENSE](LICENSE)). The components below
carry their own licences.

## 运行依赖 / Runtime dependency

### @mlightcad/libredwg-web

- 版本 / version: 0.7.17（随包放在 `vendor/`）
- 许可 / licence: **GPL-3.0**
- 用途 / purpose: 把 `.dwg` 解成 DXF。**只有 `.dwg` 需要它**；`.dxf` 是纯文本，完全不碰 wasm。
  Decodes `.dwg` into DXF. **Only `.dwg` needs it**; `.dxf` is plain text and never touches wasm.
- 上游 / upstream: https://github.com/mlightcad/libredwg-web

**分发提醒 / Distribution note**

`vendor/` 里的是 GPL-3.0 代码。若你的分发方式需要规避 GPL 传染，请移除 `vendor/`
并让用户从 registry 安装该依赖（`dependencies` 里已声明），或改用其他 DWG 方案；
`.dxf` 预览不受影响。

`vendor/` holds GPL-3.0 code. If your distribution must avoid GPL, remove `vendor/`
and let users install the dependency from a registry (it is already declared in
`dependencies`), or choose another DWG decoder. `.dxf` preview is unaffected.

## 代码来源 / Code lineage

插件骨架、零依赖 DXF 渲染器与 DWG(WASM) 解码路径来自
[dsh-dwg-preview](https://github.com/linanbuan/dsh-dwg-preview) v1.0.0（MIT），
作者 [@linanbuan](https://github.com/linanbuan)。其 MIT 署名保留在 [LICENSE](LICENSE)。

The plugin skeleton, the dependency-free DXF renderer and the DWG (WASM) decode
path come from [dsh-dwg-preview](https://github.com/linanbuan/dsh-dwg-preview)
v1.0.0 (MIT) by [@linanbuan](https://github.com/linanbuan). Its MIT notice is
retained in [LICENSE](LICENSE).
