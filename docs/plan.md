# 项目提示词 v3：skill 形态的可视化设计工具

> 用法：把本文档整篇作为新项目的起始提示词。
> 记号：`【定】`= 必须拍板的决策，附我的建议。`【新】`= 原稿没有、本次补入。`【收】`= 原稿有、本次收紧。

---

## 0. 一句话

一个 skill 形态的可视化设计工具。设计文件是 HTML 加内联 CSS。模型用 CLI 和 HTML 片段改文件。人用画布拖拽。改动经一个本地服务写回同一个文件。

## 1. 产品约束（不可动摇）

- **no MCP。no app。no login。** 随装随用。装完即可用。
- **零依赖指 npm 包。** 不用 `npm install`。没有 lockfile。没有构建步骤。
- **图片导出需要一个浏览器。** 本机的 Chrome / Chromium / Edge，或者在线的画布。HTML 与 SVG 导出不需要任何外部程序。核心路径不受影响。
- **Node.js ≥ 18。** 只用内置模块。
- **纯 ESM。** 一个 `lib/` 同时给 CLI 和浏览器用。
- **没有常驻进程。** 服务由命令启动。关掉标签页就退出。
- **一个仓库就是 skill 本体。** 安装等于把仓库链进 skills 目录。

## 2. 设计文件

### 2.1 主格式：HTML 加内联 CSS（原稿第 1 条）

**理由。** 大模型对 HTML 与 CSS 有大量训练数据。模型不需要分心学一套自造格式。

**三条硬性质。**

1. 文件是合法且自包含的 HTML。有 `<!doctype html>`、`<head>`、`<body>`。
2. 元素样式一律写在 `style` 属性里。**只允许两个例外**：令牌块与页框块。两者都放在 `<head>` 的 `<style>` 里。
3. 每个元素必须带两个属性：`data-id` 与 `data-type`。`data-id` 在整个文件内唯一。`data-type` 必须与标签相符。校验器拒绝缺失或不符的元素。

**为什么每个元素都要 `data-type`。** `<div>` 同时是 frame 与 shape 两种类型。只看标签分不出来。把类型写出来，"这是什么"就不再依赖"哪个标记属性在场"。这一条让三个旧概念退休：`data-page`、`data-shape`，以及 `<template>`。

**为什么允许这两个例外。** CSS 自定义属性必须声明在 `:root`，否则作用域不对。页框块让每页在浏览器里正常显示。元素样式仍然全部内联。

**文件骨架（一个文件，多页）。**

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>miniprogram</title>
  <meta name="design-schema" content="3.0">
  <style>
    /* 只允许两个块：令牌块与页框块。元素样式一律内联。 */
    :root{ --color-bg:#0b0d12; --color-fg:#f5f7fa; --space-md:16px }
    section[data-type="page"]{ margin:0 0 24px }
  </style>
</head>
<body>

  <section data-id="home" data-type="page" data-name="首页" data-canvas="0,0"
           style="width:390px;height:844px;overflow:hidden">
    <div data-id="home__root" data-type="frame"
         style="display:flex;flex-direction:column;width:100%;height:100%;background-color:var(--color-bg)">
      <p data-id="home__title" data-type="text"
         style="font-size:32px;font-weight:700;color:var(--color-fg)">你好</p>
      <svg data-id="home__icon" data-type="icon" data-icon="shield-check"
           style="width:24px;height:24px;color:var(--color-fg)">…</svg>
      <div data-id="home__card" data-type="frame"
           style="display:flex;flex-direction:column;gap:4px;padding:16px;background-color:#ffffff">
        <p data-id="home__card__title" data-type="text" style="font-size:14px;color:var(--color-ink)">Card</p>
      </div>
    </div>
  </section>

  <section data-id="detail" data-type="page" data-name="详情" data-canvas="490,0"
           style="width:390px;height:844px;overflow:hidden">
    <div data-id="detail__root" data-type="frame" style="width:100%;height:100%">…</div>
  </section>

  <section data-id="kit" data-type="page" data-name="起始页" data-canvas="0,920"
           style="width:390px;height:400px;overflow:hidden">
    <div data-id="kit__card" data-type="frame"
         style="display:flex;flex-direction:column;gap:4px;padding:16px;background-color:#ffffff">
      <p data-id="kit__card__title" data-type="text" style="font-size:14px;color:var(--color-ink)">Card</p>
    </div>
  </section>

</body>
</html>
```

### 2.2 【定】页面模型

**规则。一个文件等于一个设计。页面是文件里的 `<section data-type="page">`。**

- 一页 = 一个 `<section data-id="home" data-type="page">`。页在文件里按文档顺序排列。
- 页的 `data-id` 就是页名标识。不再有单独的 `data-page` 属性。
- 画布的页面列表 = 文件里的 `[data-type="page"]` 元素。不扫目录。
- 视口 = 页框自己的 `style` 尺寸。例：`style="width:390px;height:844px;overflow:hidden"`。**不引入 `data-viewport`。**
- 在画布上的位置 = 该 section 的 `data-canvas="x,y"`。
- 显示名 = `data-name`。文件标题 = `<title>`。
- `data-id` 在整个文件内唯一。CLI 自动补 id 时带页名前缀（`home__title`）。

**浏览器与画布的分工。**

- 浏览器直接打开：页按正常文档流纵向堆叠，像一张联络表。文件是合法网页。
- 画布：画布注入自己的一份作用域样式，把每页绝对定位到 `data-canvas`。**文件里不含画布样式。**

**收益。**

| 收益 | 说明 |
|---|---|
| 令牌只有一份 | `:root` 在整个设计里只出现一次。`tokens set` = 一个文件、一个 op |
| 页面列表不依赖文件系统 | 页面 = `[data-type="page"]` 元素 |
| `.pen` 导入变成 1:1 | 一个 `.pen` → 一个 `.html`。26 个画板 = 26 个 `<section data-type="page">`。画板的 `x`/`y` 直接进 `data-canvas` |
| 两个写入者更简单 | 只有一个文件要重读，一个 revision |

**代价与缓解。**

| 代价 | 缓解 |
|---|---|
| 导出要拆文件 | `export --page home -o dist/home.html`。导出时把该页的 `<section>` 内容摊进 `<body>`，并写入对应的 `<meta name="viewport" content="width=390,height=844">` |
| `data-id` 作用域是整个文件 | 跨页不许重名。CLI 自动补 id 时加页名前缀。冲突时拒绝，并给相近 id 的建议 |
| 文件会变长 | 查询面从"建议"变成"必需"：`ls --pages`、`ls --in <page>`、`show <id>`。模型不读全文 |

**为什么不用"一个文件等于一页"。** 那是上一个候选方案，已弃用。理由：一个设计拆成 N 个文件后，令牌块要复制 N 份，改一次令牌要写 N 个文件。而且 `.pen` 导入会产出 N 个文件，与原文件的 1:1 关系断开。

### 2.3 【定】规范形式（canonical form）

**问题。** HTML 有很多合法写法。同一个设计会写出不同字节。diff 变噪声。往返不再精确。

**规则。** 一个意图只有一种写法。归一化器负责。任何写入都先归一。

| 意图 | 唯一写法 |
|---|---|
| 占满父级，父级是 row（主轴） | `flex:1 1 0%` 加 `min-width:0` |
| 占满父级，父级是 column（主轴） | `flex:1 1 0%` 加 `min-height:0` |
| 占满父级（交叉轴） | `align-self:stretch` |
| 固定尺寸 | `width:236px` |
| 缩到内容 | `width:fit-content` |
| 绝对定位 | `position:absolute` 加 `left` 与 `top` |
| 元素间距 | `gap`。**不用 `margin`** |
| 内边距 | `padding`。四值按 CSS 规则压缩 |
| 圆角 | `border-radius`。只允许统一值。不支持逐角 |
| 颜色 | 六位或八位十六进制，小写。`#ffffff`。**禁三位、禁 `rgb()`、禁颜色名** |
| 长度 | `px`。零写作 `0` |
| 数字 | 最多三位小数 |
| 背景色 | `background-color`。**不用 `background` 简写** |
| 边框 | 统一宽度用 `border` 简写。逐边用长写 |
| 字体 | 全部长写。**不用 `font` 简写** |
| 字体族 | 原样写出。不追加 fallback 尾 |
| 声明顺序 | 按属性白名单顺序 |
| 元素间空白 | 不渲染。不可用于间距 |
| 页框块 | `section[data-type="page"]{ margin:0 0 24px }`。格式固定，不许改 |
| 页框尺寸 | 写在 `<section>` 自己的 `style` 里。子元素用 `width:100%` 与 `height:100%` |
| 页在文件里的顺序 | 文档顺序。不许重排 section 来改顺序，用命令 |

### 2.4 【新】版本标记与迁移

- 文件里必须有版本标记。HTML 用 `<meta name="design-schema" content="3.0">`。
- 校验器按版本选规则表。原稿第 3 条要求多版本实现，版本标记是它的前提。
- 提供 `migrate` 命令。迁移后必须校验 0 错误。
- 迁移的验收标准：**渲染结果逐字节相同**。渲染变了就是迁移写错了。

### 2.5 【新】资产策略

- 图片与字体默认用 URL。文件保持自包含的文本。
- 本地文件用相对路径。画布通过服务读取。
- `export --inline-assets` 把图片转成 data URI。**未实现**：今天的交付物保留 URL 形式的图片引用，自包含靠调用方自己保证。
- **图片导出（`png` 等）前必须先内联外链图片。** 否则截图会缺图。
- 栅格化前必须等字体加载完。字体没加载完就截图是这类导出最常见的错。
- 非系统字体族由导出器生成 webfont 链接。只请求用到的字重。

### 2.6 兼容 .pen（导入做主，反向尽力）

**实测数据。** 我读了 `jiazheng-mono/design/miniprogram.pen`：

- 696 KB，19693 行，26 个顶层画板。
- 节点：frame 682、text 479、ref 239、icon 109、ellipse 28、rectangle 4。
- 属性 36 种。含 `variables`、`reusable`、`descendants`、`effect`、`stroke`、`textGrowth`、`clip`、`metadata`。

**官方格式还有**（docs.pencil.dev）：slots、themes、多 fill、linear/radial/angular/mesh 渐变、多 effect、`descendants` 用斜杠路径覆盖（`ok-button/label`）、允许 JSON 注释、版本字段标识 schema、官方保留破坏性变更。

**【定】.pen 的地位。**

- **建议：两个方向都做，但主次分明。** `.pen` → HTML 做全，是主方向。HTML → `.pen` 尽力，带损失清单，排在最后实现。
- 理由：`.pen` 若要求可编辑并可写回（读进来改一改再存回 `.pen`），工作量等于做第二个产品。**写出去**比**写回去**便宜得多。
- 导入必须输出账本。账本记三样：丢失（lost）、改写（converted）、未识别的属性（unmappedProps）。
- 一个 `.pen` 文件写成一个 `.html` 文件。26 个画板 = 26 个 `<section data-type="page">`。画板的 `x`/`y` 进 `data-canvas`。pen 的 `type: "ref"` **就地展开**：被引用节点的子树复制到引用处，副本根保留引用自己的 id，其后代按 `<引用id>__<自己的id>` 重编号，`descendants` 覆盖在导入时应用。参考文件里那个装主节点的顶层画板就是一个普通的页。
- 原稿第 3 条的多实现正为此而设。见 §3.2 读取器与写出器。
- 导入要检查 id：必须符合 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`，且全文唯一。pen 官方没有规定 id 的字符集，所以不符合的要重编号，并计入账本的 `converted`。实测参考文件：1541 个 id 全部唯一、全部合规，所以那份文件不需要重编号。

## 3. 架构总览

### 3.1 六件套（原稿第 2 条）

| 部件 | 输入 | 输出 | 何时运行 |
|---|---|---|---|
| **解析器** | 设计文件的文本 | 文档模型 | 每次读取。每种输入格式一个 |
| **校验器** | 文档模型 | 诊断列表 | 每次写入前。`validate` 命令 |
| **渲染器** | 文档模型 | 画布可挂载的 HTML 加 CSS | 画布启动、每次改动 |
| **导出器** | 文档模型 | 交付物 HTML、SVG、图片，或 `.pen` | `export` 命令。它只管写 |
| **修改器** | 一段片段或一条声明 | op 列表 | `add`、`set`、`remove`、`move` 命令 |
| **归一化器** | 文档模型 | 规范文本 | 每次写入 |

### 3.2 【新】读取器与写出器（原稿第 3 条落地）

格式绑定实现。但**读与写要分开**，它们是两个正交的轴。

**读取器。每种输入格式一个。**

```
FormatReader {
  id                   // "html" | "pen"
  detect(path, text)   // 扩展名加内容嗅探
  version(text)        // 文件版本
  parse(text)          // 文本 → 文档模型。同时产出账本
  syntaxDiagnostics()  // 语法层问题。HTML 未闭合、pen 的 JSON 错误
  capabilities         // { writable, lossy }
}
```

**写出器。每种输出格式一个。**

```
FormatWriter {
  id                       // "html" | "pen" | "svg" | "png" | "jpeg" | "webp"
  serialize(doc, options)  // 文档模型 → 文本或字节
  capabilities             // { lossy, needsBrowser }
}
```

**与格式无关的核心。** 它们只跑在文档模型上，不关心输入来自哪种格式。

`ops.mjs` 变更 ｜ `normalize.mjs` 归一化 ｜ `validate.mjs` 校验 ｜ `render.mjs` 画布挂载 ｜ `diagnostics.mjs` 诊断呈现

**账本属于一次转换，不属于某个格式。** 读的一边与写的一边，损失都记在同一次转换的账本里。

**四个格式的能力。**

| 格式 | 读 | 写 | 说明 |
|---|---|---|---|
| `html` | 是。无损。主格式 | 是。规范形式与交付物 | 两个方向都全 |
| `pen` | 是。有损，出账本 | **否**。写出器未实现 | 读入已落地；写出是这份设计里还没做的两件事之一 |
| `svg` | 否 | 是。只出图 | 不需要浏览器 |
| `png` `jpeg` `webp` | 否 | 是。只出图 | 需要浏览器 |

- **转换 = 读取器 + 写出器。** 所以 `.pen` → HTML 是「pen 读取器 + html 写出器」。**读入这一半实现了**（`lib/readers/pen.mjs`）。
- **写出这一半只有 `html` 与图片。** `writers/pen.mjs` 从未写出来，所以 HTML → `.pen` 不存在；`export --format pen` 会报 `export/unknown-format` 并列出真实可用的格式。设计稿里那两行「两件事都不是导出器独占的」「任意组合都成立」描述的是分层的意图，不是今天的能力。
- 服务按扩展名选读取器。所以 `serve page.html` 与 `serve proto.pen` 是同一个命令（原稿第 8 条收紧）。

### 3.3 【新】一张表，多个消费者

格式表是唯一真相源。它同时驱动六个消费者：

1. 片段编译（接受哪些属性与取值）
2. 渲染（写出什么）
3. 导出（写出什么）
4. 导入（读回什么）
5. 报错提示（"这里接受什么"）
6. 生成文档与测试

理由：子集漂移是这类产品最典型的慢性病。一处定义，六处消费。

## 4. 数据架构

### 4.1 元素与节点约定

**每个元素都有两个属性：`data-id` 与 `data-type`。**

| 属性 | 规则 |
|---|---|
| `data-id` | 必填。在文件内唯一。匹配 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`。它是所有 op 的地址 |
| `data-type` | 必填。值见下表。必须与标签相符，否则报错 |

**`data-id` 的唯一性范围。**

| 规则 | 说明 |
|---|---|
| 在**设计文件内**唯一 | 跨所有页。这是硬规则，校验器拒绝重复 |
| 在**画布上每页各出现一次** | 每页是一个 shadow root，同一个 id 在不同页里是两次挂载 |
| 为什么用 `data-id` 而不是 HTML 的 `id` | 交付物里 `data-id` 无副作用，重复也不构成非法 DOM |

每条 op 用 `data-id` 寻址，所以一个 id 在一份文件里只指向一个元素。

**六种类型，与允许的标签。**

| `data-type` | 允许的标签 | 能带 children | 说明 |
|---|---|---|---|
| `page` | `<section>` | 是 | 一页。不是节点，是页的容器 |
| `frame` | `<div>` | 是 | 盒子 |
| `text` | `<p>` `<h1>`–`<h6>` `<span>` | 否 | 一个元素一段文本 |
| `image` | `<img>` | 否 | `src` 与 `alt` 必填 |
| `shape` | `<div>` | 否 | 配 `data-kind` |
| `icon` | `<svg>` | 否 | 配 `data-icon` 与 `data-icon-library`。字形是内联几何 |

**可选属性。**

| 属性 | 用在 | 规则 |
|---|---|---|
| `data-name` | 任何 | 显示名。给人看 |
| `data-hidden` | 任何 | `"true"`。等价 `display:none`，但保留节点 |
| `data-locked` | 任何 | `"true"`。画布不可拖动。不产生 CSS |
| `data-canvas` | `page` | `"x,y"`。画布摆放位置 |
| `data-kind` | `shape` | `rect`（默认）｜`ellipse`。**没有 `line`**：一条线是带高度的 `rect` 加 `border-radius`，或者一个 `icon`；表里多一个值就要多一条渲染与校验规则，而它没有换回任何表达能力 |
| `data-icon` | `icon` | 字形名 |
| `data-icon-library` | `icon` | 目前只有 `lucide` |
| `data-credit` | `image` | 署名。永不渲染 |

**尺寸意图**用 §2.3 的规范 CSS 写法。**不引入 `data-w` / `data-h`。**

**退休的三个旧概念。** `data-page` → `data-id` 加 `data-type="page"`。`data-shape` → `data-kind`。`<template>` → 不需要了，一个可复用的盒子就是一个 `frame`。

规则变了：以前靠"哪个标记属性在场"判断类型，现在靠 `data-type` 一个必填字段。

### 4.2 【新】设计令牌

**这是原稿完全没写、但价值最高的功能。**

- 令牌声明在 `<style>:root{ --color-accent:#2563eb }</style>`。
- 整个设计只有一份令牌块。它在文件里出现一次。所以 `tokens set` 只改一个文件，只产生一个 op。
- 元素用 `var(--color-accent)` 引用。
- 分组固定七组：`color`、`font`、`space`、`radius`、`size`、`shadow`、`border`。
- 命名：`--<组>-<名字>`。组名是闭集，所以按第一个连字符切分即可反解。
- 数值组的声明带单位：`--space-md:16px`。裸数字补 `px`；非长度值被拒绝。`font`、`shadow`、`border` 三组没有单位规则，值按原样写入 —— 给它们编一条规则，第一个被弄坏的就是 `--font-body`（它的值是一串字体族）。
- 令牌可以引用令牌。深度上限 16。循环被拒绝：校验器报 `style/token-cycle`（error），解析器即使没校验过也不会跟进环里 —— 它曾经会，`export --resolve-tokens` 的整条报告是 `REFUSED Maximum call stack size exceeded`，而同一份文件 `validate` 说 valid。
- 令牌名两半都要对：形状 `--<组>-<名字>`，**且组名在七组闭集里**。`references/schema.md` 对模型写的是 must，校验器就必须报，否则 `--accent-500` 会被判 valid，而 `tokens set accent.500` 被拒 —— 文件说没问题，它的令牌却改不了。
- `export --resolve-tokens` 把令牌烘焙成字面量。

**为什么必须有。** 没有令牌，"把品牌色改成紫色"要改 200 处。

### 4.3 【新】op：唯一的变更单元

**这是原稿第 12 条的地基。** 回退需要粒度。粒度就是 op。

```
{ "op": "set",    "target": "n_cta",  "prop": "border-radius", "value": "12px" }
{ "op": "unset",  "target": "n_cta",  "prop": "border-radius" }
{ "op": "insert", "target": "n_hero", "index": 0, "html": "<div data-id=… data-type=…>…</div>" }
{ "op": "remove", "target": "n_card" }
{ "op": "move",   "target": "n_card", "before": "n_cta" }
{ "op": "set-token",   "name": "--color-accent", "value": "#2563eb" }
{ "op": "unset-token", "name": "--color-accent" }
```

- 七种 op：set、unset、insert、remove、move，加令牌的 set-token、unset-token。后两种单列，因为令牌不是元素、没有 `data-id`，`set` 的寻址到不了它。契约见 `format-v3.md` §4.4。
- 定位用 `data-id`，**不用 CSS 选择器**。理由：选择器有歧义，且有性能问题。
- `data-id` 在整个文件内唯一，跨所有页。所以一个目标 id 不需要再带页名。
- op 不需要 `data-type`。一个 id 就够了。
- 每个 op 列表可逆。`applyOps` 返回逆 op。
- 一个 op 等于一步撤销、一行变更日志。

### 4.4 【新】诊断模型

```
{
  "severity": "error" | "warning",
  "code": "style/unsupported-property",
  "target": "n_card_cta",           // data-id。可选
  "path": "page->n_card->n_cta",    // 人读
  "message": "…",
  "hint": "…",                       // "这里接受什么"
  "fix": "design set n_cta --style 'cursor:default'"  // 可执行修复。可选
}
```

码前缀：`syntax/*`、`style/*`、`structure/*`、`a11y/*`、`geometry/*`、`asset/*`、`version/*`、`ops/*`。

### 4.5 【新】日志：拆成两份（原稿第 12 条收紧）

原稿把两件事混在一起。分开。

| 日志 | 内容 | 谁读 | 用途 |
|---|---|---|---|
| **变更日志** `design.log.jsonl` | op 列表加逆 op 加 revision | 程序 | 撤销、重做、同步 |
| **意图日志** | 人做了什么、动了哪个元素、值从多少变成多少 | 模型 | 理解人的意图 |

- 变更日志记录**动作**，不记录净变化。拖过去又拖回来是两条。
- 每条带结果 `revision`（文件内容哈希）。两条同 revision 表示中间字节相同。
- 撤销与重做各记一条，并指明被撤销或被恢复的那一步。

## 5. 功能架构

### 5.1 CLI（原稿第 4 条）

**【定】一个 dispatcher，动词子命令。** 比"每命令一个文件"更省模型成本。

```sh
design <动词> [参数]
```

| 动词 | 作用 | 关键参数 |
|---|---|---|
| `new` | 新建一页（在文件末尾追加一个 `<section data-type="page">`） | `--page home --name 首页 --size 390x844` |
| `add` | 新增子树 | `--in <id> --html-file f \| --html -`，`--as <id>` 解决重名 |
| `set` | 改已有元素 | `<id> --style 'a:b;c:d' --text "…"` |
| `remove` | 删除元素 | `<id>` |
| `move` | 移动或换父 | `<id> --before X \| --after X \| --index i \| --into P` |
| `rename` | 改 `data-id` | `<old-id> <new-id>` |
| `ls` | 列页与节点 | `[--pages] [--in <page\|id>] [--depth n] [--json]` |
| `show` | 看单个元素 | `<id> [--json]` |
| `tokens` | 令牌增删改查 | `ls \| set <组.名> <值> \| rm <组.名>`。名字也可以写成文件里的 `--组-名`，那时要在 `--` 之后：`tokens f.html set -- --color-accent '#2563eb'` |
| `validate` | 校验 | `[--json] [--strict]` |
| `format` | 归一化 | `[--check]` |
| `export` | 从设计文件出交付物。范围可选 | `[--page <id>] [--all] [-o path] [--format html\|svg\|png\|jpeg\|webp] [--raster auto\|chrome] [--scale 1\|2\|3] [--size WxH] [--resolve-tokens] [--stdout] [--json]`。**这行是实现的全部**：`--id`、`--format pen`、`--raster canvas`、`--background`、`--padding`、`--inline-assets`、`--report` 都写在过这份设计稿里，都没有写出来 |
| `import` | 把别的格式读成设计文件 | `pen <file> [-o out.html] [--report ledger.json]`。只有 `pen` 一个读取器；`--report` 把账本另写一份 |
| `serve` | 开画布 | `[<file>] [--port 0] [--ttl 30]` |
| `log` | 读日志 | `[--tail n] [--intent]` |

- 所有变更类动词共有：`--dry-run`、`--json`、`--quiet`。
- 退出码固定：0 正常 / 1 无效或被拒 / 2 不可读或参数错。
- 命令用 `data-id` 定位元素，所以不需要 `--page`。只有 `new`、`ls --pages`、`export` 用页名。
- **`data-id` 是地址，所以 `set` 不能改它。** 改名要用 `rename`。
- `rename` 只改一个 id：文件里没有别的东西按 id 指向另一个元素。
- `--id` 只对图片格式（`svg`、`png`、`jpeg`、`webp`）有效。HTML 导出只有页粒度。
- **方向只有一个入口，一个出口。** 进来用 `import`（别的格式 → 设计文件）。出去用 `export`（设计文件 → 交付物或别的格式）。
- `import pen` 走「pen 读取器 + html 写出器」。它产出**设计文件**，不是交付物。要交付物再 `export`。
- `export --format pen` 走「html 读取器 + pen 写出器」，并输出账本。**未实现**：pen 写出器不存在，这条路径会拒绝。
- 手写的 HTML 不需要「导入」。主格式就是 HTML。补上 `data-id` 与 `data-type`，跑 `validate` 与 `format`，它就是设计文件。

### 5.2 修改器与片段（原稿第 10 条）

**流程。**

1. 读片段文本。
2. 解析成元素树。结构非法就拒绝。
3. 检查两个必填属性。**每个元素都要有 `data-id` 与 `data-type`。** `data-type` 与标签不符就拒绝。缺失的 `data-id` 按第 5 步补。
4. 按格式表过滤属性。白名单外的属性进"丢弃"账本。
5. 归一化每个取值。`#fff` → `#ffffff`。`16px 16px 16px 16px` → `16px`。
6. 补齐缺失的 `data-id`。加页名前缀，再接 `data-name` 或标签。例：`home__cta`。
7. 检查 id 冲突。冲突就拒绝，并给出相近 id 的建议。
8. 编成一条 op。
9. 应用 op。归一化。校验。**仅在新错误时才拒绝。**
10. 原子写盘。
11. 返回回执。

**输入通道。** 优先 `--html-file` 或 `--html -` 读 stdin。禁止把整段片段塞进 shell 单引号。

### 5.3 【新】回执：修改器的返回值

**没有回执，模型等于盲写。** 模型看不到文件。它只有回执。

```
$ design add --in n_hero --html-file card.html
added:      n_card → n_card_title, n_card_meta   (3 个元素)
normalized: #fff → #ffffff (1 处)；padding 四值 → 16px (1 处)
dropped:    n_card_cta 上的 cursor:pointer — 不是本格式的属性
applied 1 op, revision 5948df95 (0 errors, 0 warnings)
```

失败时也要给回执：

```
REFUSED  会引入重复 id "n_cards"
  did you mean "n_plans"?   或用 --as n_cards_2 自动改名
文件未改动。
```

`--json` 形态：

```json
{
  "ok": true, "verb": "add",
  "applied": [{ "op": "insert", "target": "n_hero", "index": 2 }],
  "added": ["n_card", "n_card_title", "n_card_meta"],
  "normalized": [{ "target": "n_card", "prop": "background-color", "from": "#fff", "to": "#ffffff" }],
  "dropped": [{ "target": "n_card_cta", "prop": "cursor", "value": "pointer", "reason": "not in the format table" }],
  "diagnostics": [], "revision": "…", "changed": true
}
```

**不变量：零静默丢弃。** 每一条声明要么被消费，要么出现在回执里。

### 5.4 校验器（原稿第 7 条）

**四层。**

| 层 | 内容 |
|---|---|
| 语法 | HTML 是否合法。元素是否闭合 |
| 样式 | 属性是否在白名单。取值是否符合语法 |
| 结构 | `data-id` 是否唯一。`data-type` 是否存在，是否与标签相符。文本元素是否有文本。图片是否有 `alt` |
| 语义 | 令牌是否存在，引用是否解得开，几何是否装得下 |

**白名单。** 约 40 个 CSS 属性。这就是原稿第 7 条的具体做法。

- 布局与尺寸：`display`、`flex-direction`、`flex-wrap`、`align-items`、`justify-content`、`gap`、`padding`、`width`、`height`、`min-width`、`max-width`、`min-height`、`max-height`、`flex`、`align-self`
- 定位：`position`、`left`、`top`
- 绘制：`background-color`、`background-image`、`background-size`、`background-position`、`border`、`border-width`、`border-style`、`border-color`、`border-radius`、`box-shadow`、`opacity`、`overflow`
- 文字：`font-family`、`font-size`、`font-weight`、`line-height`、`letter-spacing`、`color`、`text-align`、`text-transform`、`white-space`
- 图片：`object-fit`

**越界写法的处理。** 分三种，不要混：

1. **别名。** 能无损转写的，归一化后接受。例：`background` → `background-color`。
2. **简写。** 能展开的，展开后接受。例：`font` 简写展开成四个长写。
3. **其余。** 拒绝，并给出提示。提示必须内联说明"这里接受什么"。

**为什么提示要内联。** 我实测过一段普通 HTML。结果是 5 个错误（`margin`、`cursor`、`#fff`、`rgba()`）加 1 个静默丢弃（`div` 上的 `color`）。模型看到提示才会改对。

### 5.5 服务与渲染（原稿第 8、11 条）

- 一个 `serve` 命令。按扩展名选读取器。
- 只绑 `127.0.0.1`。打印带一次性 token 的 URL。自动打开浏览器。
- 推送用 SSE。不用 WebSocket。零依赖下用 WebSocket 要手写握手与分帧。
- 标签页关闭或空闲超时后退出。
- **浏览器永不触碰文件系统。** 这条是原稿第 11 条的核心。

### 5.6 【新】安全（三项，缺一不可）

本地服务绑 loopback 后，**浏览器里任何页面都能访问它**。所以：

1. **Host 守卫。** 防 DNS rebinding。
2. **Origin 校验。** 只接受本服务的来源。
3. **能力 token。** 每次请求都要校验。

静态资源用白名单 Map。**绝不用 URL 路径拼接文件路径。**

### 5.7 画布（原稿第 5 条）

- 三区：左侧页面列表加节点树，中间画布，右侧属性面板。三者联动。
- 页面列表 = 文件里的 `[data-type="page"]`，按文档顺序。
- 画布无限大。所有页面同时在场。拖动页面名字条移动页面，写回 `data-canvas`。
- 手势：拖动排序、按住 Alt 或切到 Move 模式自由定位、八个手柄缩放、方向键微调、吸附 6px、空格平移、捏合缩放。
- 属性面板的每个控件提交**恰好一个 op**。数字控件横向拖动预览，松手才提交。
- 底部问题抽屉：按 code 分组，最严重优先。点击一条跳到它的元素。
- 服务拒绝的编辑：打开抽屉显示"它本来会引入什么"。不要用 toast。

**【收】哪些状态不写文件。** 折叠、过滤、相机位置、抽屉开合都是视图状态。**不写文件。** 否则拖一次相机就产生一条日志。

### 5.8 导出器（原稿第 9 条）

**两个轴。** 输入格式选读取器。输出格式选写出器。两者正交。下表是**写出器**，读取器见 §3.2。**表里只有 html 与图片两行是实现的**；`pen` 那一行从未落地。

| 输出格式 | 粒度 | 做法 | 需要外部程序 |
|---|---|---|---|
| `html` | **只有页** | 见下 | 否 |
| `svg` | 页 或 `data-id` | 用 `<svg><foreignObject>` 包住该页或该节点 | 否 |
| `png` `jpeg` `webp` | 页 或 `data-id` | 栅格化。见下 | 是 |
| `.pen` | 整个设计 | 反向导出。尽力加损失清单 | 否 |

**`svg` 能打开的软件有限。** 只有浏览器能正确渲染 `foreignObject`。Figma、Illustrator、Sketch 打开会空白。Safari 对 `foreignObject` 有已知问题，遇到时改用 `png` 或 `--raster chrome`。

**选择导出范围。**

| 选择器 | 导出内容 | HTML | 图片 | 输出文件名 |
|---|---|---|---|---|
| 无 | 整个设计的第一页 | 是 | 是 | `<页名>.<ext>` |
| `--page home` | 该页 | 是 | 是 | `home.<ext>` |
| `--page home --id n_hero` | 该页里 `n_hero` 的子树 | **否** | 是 | `home__n_hero.<ext>` ← **这一行未实现**，见下 |
| `--all` | 每一页一个文件 | 是 | 是 | `<页名>.<ext>` |

- **HTML 的粒度只有页。** 一次一页，或者 `--all` 一次全站。不给片段。
- **理由。** HTML 导出是交付物。交付物是一页，或者一个站点，不是一棵子树。
- **图片的粒度是页或 `data-id`。** 图片指 `svg`、`png`、`jpeg`、`webp`。
- `--id` 与 `--format html` 同时给 → 报错，并提示改用 `show <id>`。
- `--id` 必须指向文件里真实存在的元素，也就是一个带 `data-id` 的元素。
- 互斥：`--all` 与 `--id`。同时给就报错。
- 要一个子树自己的图，用 `--id <data-id>`。**未实现**：下面三样「节点级图片导出要补的东西」也还没有补，所以 `--id` 至今没有实现；`--id` 与 `--format html` 同给的报错、`--all` 与 `--id` 的互斥都随之不存在。

**节点级图片导出要补三样东西。** 一棵子树离开父级后，会丢三样上下文：

| 丢什么 | 补法 |
|---|---|
| 令牌 | `var(--color-accent)` 要么摊平，要么让导出物带上 `:root` 令牌块。由 `--resolve-tokens` 决定 |
| 可继承属性 | 把祖先链上的值物化到导出根上。可继承属性是：`color`、`font-family`、`font-size`、`font-weight`、`line-height`、`letter-spacing`、`text-align`、`text-transform`、`white-space`。**不做这一步，子树的字体与颜色会丢**，因为通常只在页根上写一次 |
| 尺寸 | `flex:1` 与 `width:100%` 的节点脱离父级后没有确定尺寸。栅格化时必须用一个同尺寸的盒子包住它，或用 `--size WxH` 显式指定 |

- 阴影会溢出边框盒。栅格化默认按 `box-shadow` 的外扩量自动加边距。`--padding <px>` 可以覆盖这个默认。**未实现**：外扩量今天不自动补，`--padding` 也不存在。
- 物化可继承属性与补尺寸是节点级导出与整页导出最不一样的地方。要有专门的测试。

**导出目标。**

| 目标 | 做法 |
|---|---|
| 单页 | 抽出该页的 `<section>`，内容摊进 `<body>`，写入对应的 `<meta name="viewport">` |
| 节点（仅图片） | 摊平可继承属性与令牌，补尺寸，再栅格化 |
| 全站 | `export --all -o dist/`。每页一个文件，文件名用页名 |
| `.pen` → HTML | 做全。必须输出账本 |
| HTML → `.pen` | **尽力加损失清单。** 明确会丢：slots、themes、mesh 渐变、多 fill、vector path |

**图片导出（栅格化）。** Node 不能把 HTML 画成像素。所以需要一个浏览器。两条路径，按顺序自动尝试：

| 路径 | 做法 | 前提 |
|---|---|---|
| `chrome` | 调用本机 Chrome / Chromium / Edge 的 headless 模式。参数：`--screenshot=out.png --window-size=W,H --force-device-scale-factor=N --virtual-time-budget=2000` | 装了这三个之一 |
| `canvas` | 让已经打开的画布栅格化，把结果 POST 回服务写盘 | 画布在线 |

- 两条栅格化路径都不通时**必须报错**，并给三条出路：装一个 Chrome 系浏览器、先开画布、或者改用 `--format svg`。**绝不自动换格式。**
- **`svg` 是第三条出路，不是自动兜底。** 必须显式指定。理由：格式变了就是另一份交付物，不该由工具替人决定。
- 可以强制指定：`--raster chrome|canvas`。
- `--raster canvas` 的原理：把该页 HTML 包进 `<svg><foreignObject>`，加载成图片，画到 `<canvas>`，导出 blob。**未接线**：`lib/raster.mjs` 认得这条路径并规划它，但没有任何调用方会传 `canvasOnline: true`，服务端也没有栅格化端点，所以 `--raster canvas` 会抛 `raster/canvas-not-wired`，而 `export` 的 `--help` 只列 `auto|chrome`。原理留着，因为它是无浏览器机器上唯一的出路。
- **本格式对这个做法特别友好。** 元素样式全部内联，只有一份 `:root` 令牌块要摊平。普通网页做不到这一点，因为外部样式表与级联没法在 `foreignObject` 里复现。
- `--scale 1|2|3`，默认 1。`--background transparent|#RRGGBB` **未实现**：今天图片的背景取页框的 `background-color`，没有覆盖它的开关。
- 字体：`chrome` 路径靠 `--virtual-time-budget` 等待。`canvas` 路径靠 `document.fonts.ready`。
- 外链图片：先内联成 data URI。`chrome` 路径也可以改为等网络空闲。

**导出也返回回执。** 写出的文件列表，加每页的像素尺寸。

**双向导出不现实。** 主方向是 `.pen` → HTML。反方向只在确有需求时做。

### 5.9 【新】查询面

设计文件可能很长。参考项目近 2 万行。模型不能每次读全文。

需要：`ls --pages`（列页）、`ls --in <page>`（列某页的节点树）、`show <id>`、`tokens ls`、按名字搜索。全部支持 `--json`。

HTML 导出没有片段粒度。模型读子树用 `ls --in` 与 `show <id>`。**要一张节点的图，今天做不到**：`export --id <data-id> --format png` 没有实现，导出粒度只有页（见 §5.8）。

## 6. 技术架构

### 6.1 分层与目录

```
lib/            纯函数。浏览器安全。不得 import node:*
  table.mjs       格式表（属性、取值、别名、简写、元素映射、令牌组）  ← 唯一真相源
                  （设计稿里叫 format.mjs；落地时叫 table.mjs）
  parse.mjs       HTML → 文档模型，带偏移
  serialize.mjs   文档模型 → 文本，最小改动
  validate.mjs    四层校验
  normalize.mjs   归一化与规范形式
  ops.mjs         七种 op（五种树 op + 两种令牌 op）、id 索引、可逆
  tokens.mjs      令牌：名字、组、值、寻址、环
  fragment.mjs    片段 → op
  render.mjs      文档模型 → 画布 HTML 加 CSS
  export-html.mjs 文档模型 → 交付物 HTML（设计稿里叫 export.mjs）
  export-svg.mjs  一页 → SVG（foreignObject 包装）；纯的那一半
  raster.mjs      栅格化的路径编排、选择与报错
  receipt.mjs     回执模型与呈现
  base-css.mjs    基础规则：没有它们，width 不是盒子的 width
  icons.mjs       内置字形表（生成物）
  diagnostics.mjs 分组、过滤、定位
  spans.mjs       区间替换与重叠检查
  detect.mjs      扩展名加内容嗅探，选读取器
  levenshtein.mjs 距离与建议
  readers/pen.mjs .pen 读取器。有损，出账本

lib/node/       唯一碰文件系统与网络的地方
  cli.mjs           入口判定、参数解析
  fs.mjs            读、原子写、哈希
  static.mjs        提供给浏览器的白名单
  server.mjs        本地服务、事件流、保存端点
  write-verbs.mjs   写入漏斗：读、校验、apply、再校验、原子写、回执
  export-svg.mjs    写图片文件的那一半（spawn 之前的准备）
  raster-run.mjs    探测并调用本机 headless 浏览器（设计稿里叫 browser.mjs）
  verbs/*.mjs       每个动词一个文件。设计稿里的「scripts/ 命令面」落成了这里

scripts/        生成器：references/ 那三份文档由 lib/table.mjs 生成
canvas/         浏览器应用。无构建。原生 ES 模块
references/     生成物。schema 文档与样式文档
test/           node --test
```

**这份树按实际重写过。** 设计稿里点名的 `format.mjs`、`svg-out.mjs`、`readers/html.mjs`、`writers/html.mjs`、`writers/pen.mjs`、`geometry.mjs`、`lib/node/log.mjs`、`lib/node/browser.mjs` 从未存在；`export.mjs` 落成了 `export-html.mjs`，`format.mjs` 落成了 `table.mjs`。**没有被替代的只有两个：`writers/pen.mjs`（pen 写出器）与 `geometry.mjs`（几何检查）** —— 它们是这份设计里确实还没做的两件事，写在 §8 的验收与 `docs/format-v3.md` §6 的「未实现」里。

**纯度边界（可执行的不变量）。** `lib/`（除 `lib/node/`）与 `canvas/` 不得出现 `node:` 导入、`require()`、`process.*`、`Buffer.*`。画布能取的静态资源必须在白名单里。`lib/node/` 永不提供给浏览器。

### 6.2 【新】写入漏斗

**所有写入走同一个函数。**

```
write(path, ops):
  before ← read(path)                 // 总是重读。避免覆盖他人的改动
  beforeErrors ← validate(before)
  next ← applyOps(before, ops)        // 失败就拒绝。文件不变
  next ← normalize(next)
  newErrors ← validate(next) 减去 beforeErrors
  如果 newErrors 且未 --force: 拒绝。回执带 newErrors
  writeAtomic(path, serialize(next))  // 同目录临时文件加 rename
  revision ← hash(text)
  return receipt
```

片段、CLI、画布、导入都走它。这保证画布与 CLI 的行为一致。

### 6.3 【新】两个写入者

- Agent 走 CLI 改文件。人走画布改文件。两者同时发生会丢改动。
- 规则一：写前重读文件。
- 规则二：用内容哈希做 revision。
- 规则三：外部改动由目录监视推给画布。
- 规则四：画布打开时，agent 不要重写全文。用片段和 op。

### 6.4 性能预算

| 项 | 预算 |
|---|---|
| 单页文件 | ≤ 1000 行 |
| 片段编译加校验加写盘 | ≤ 100ms |
| 画布拖动 | 60fps |
| 服务冷启动到打印 URL | ≤ 200ms |
| 单页 PNG（390×844，scale 2） | ≤ 2s，含浏览器启动 |

## 7. 非目标（明确不做）

- 不做通用 HTML 与 CSS。只支持白名单内的属性。
- 不做 grid、`position:fixed`、`position:sticky`。
- 不做响应式断点与变体。
- 不做富文本。一个文本元素一段文本。
- 不做多选、对齐分布按钮、等间距吸附、图层列表内拖动排序（第一版）。
- 不做云端、账号、多人协作。
- 不做手绘与矢量路径。形状只有矩形、椭圆、直线。

## 8. 验收指标

| 指标 | 门槛 |
|---|---|
| **一次写对率**（北极星） | 20 个真实片段的语料，首轮通过率 ≥ 80% |
| 失败提示可操作性 | 人工判定"不改文档就能改对" = 100% |
| 静默丢弃 | 0 |
| 往返精确 | 归一化两次字节相同 |
| 渲染确定性 | 同一文件渲染两次字节相同 |
| `.pen` 参考文件导入 | 0 错误。账本 `unmappedProps` 为空 |
| 图片导出保真 | 与画布所见一致。字体已加载，无缺图。抽查 3 页 |
| 节点级图片保真 | 可继承属性已物化。令牌已摊平或随附。抽查一个靠页根继承字体的子树 |
| 图片导出的静默降级 | 0。两条栅格化路径都不通时报错，并在错误里提到 `--format svg` |
| `svg` 导出保真 | 抽查 1 页。在 Chrome 里与画布所见一致 |

## 9. 测试策略

| 类别 | 内容 | 不变量 |
|---|---|---|
| 交叉积 | 每个白名单属性 × 每种节点类型 | **消费或报告。零静默丢弃** |
| 语料 | 20 个模型会自然写出的片段 | 一次写对率 ≥ 80% |
| 往返 | 归一化幂等 | 两次字节相同 |
| 渲染 | 黄金文件 | 输出确定 |
| 迁移 | 旧版本 → 新版本 | 渲染字节不变 |
| CLI | 每个动词的成功与拒绝路径 | 退出码 0/1/2 稳定 |
| 服务 | 三项安全守卫。两个写入者 | 文件永不被污染 |
| 纯度 | 浏览器边界与静态白名单 | 无 `node:` 泄漏 |

## 10. 第一个里程碑（竖切，不做全功能）

1. HTML 设计文件：多页模型加 `data-type` 强制。`data-id` 与 `data-type` 每个元素都要有，`data-id` 全文唯一。
2. 解析器加归一化器（含 §2.3 的规范形式表，含页框块与页框尺寸）。
3. 校验器：属性白名单、取值语法、id 检查。
4. 修改器：`add` 与 `set` 两个动词，加片段编译，加回执。
5. 20 个片段的语料测试。

**判据：** 一次写对率 ≥ 80%。静默丢弃 0。这两条过了再画布，再 `.pen` 导入，最后图片导出。`svg` 零依赖，可以第一步就带上。`png` 需要一个浏览器，排在最后。

## 11. 附录：原稿 12 条的落位

| 原稿 | 落位 | 补了什么 |
|---|---|---|
| 1 HTML 为主格式 | §2.1、§2.2、§2.3、§2.6、§4.1 | 每个元素两个必填属性：`data-id` 与 `data-type`。多页文件模型。规范形式表。令牌与页框两个例外。版本标记 |
| 2 六件套 | §3.1、§3.2 | 归一化器。读与写的切分。每个部件的输入输出与运行时机 |
| 3 多实现 | §3.2、§2.6、§2.4 | 读取器与写出器两个接口。四个格式的能力表。转换 = 读取器 + 写出器。版本标记与迁移 |
| 4 node CLI | §5.1 | 动词表。退出码。共有参数 |
| 5 画布三区 | §5.7 | 视图状态不写文件。拒绝的编辑可视化 |
| 7 限定样式 | §5.4、§2.3 | 约 40 属性白名单。别名与简写处理。越界三种处理 |
| 8 渲染器与浏览器 | §3.2、§5.5 | 一个服务按扩展名选读取器 |
| 9 双向导出 | §5.8、§2.5、§1 | 粒度规则：HTML 只有页，图片可到 `data-id`。节点级导出要补三样上下文。输出格式含 SVG 与图片。两条栅格化路径与 `svg` 出路 |
| 10 修改器 | §5.2、§5.3、§4.3 | 十步流程。回执四类。op 是变更单元 |
| 11 服务同步 | §5.5、§5.6、§6.2、§6.3 | 三项安全守卫。写入漏斗。两个写入者规则 |
| 12 日志与回退 | §4.5、§4.3 | 拆成变更日志与意图日志。op 是可逆粒度 |
| 缺 | §4.2、§5.9、§8 | 设计令牌。查询面。验收指标 |
