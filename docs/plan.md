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

**为什么每个元素都要 `data-type`。** `<div>` 同时是 frame、shape、instance、component 四种类型。只看标签分不出来。把类型写出来，"这是什么"就不再依赖"哪个标记属性在场"。这一条让四个旧概念退休：`data-page`、`data-component`、`data-shape`，以及 `<template>`。

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
      <div data-id="home__card" data-type="instance" data-ref="card"
           data-overrides='{"card__title":{"content":"你好"}}'></div>
    </div>
  </section>

  <section data-id="detail" data-type="page" data-name="详情" data-canvas="490,0"
           style="width:390px;height:844px;overflow:hidden">
    <div data-id="detail__root" data-type="frame" style="width:100%;height:100%">…</div>
  </section>

  <!-- 组件库也是一个页。组件是一个 div，渲染行为与 frame 完全相同。 -->
  <section data-id="library" data-type="page" data-name="组件库" data-library="true"
           data-canvas="0,920" style="width:390px;height:400px;overflow:hidden">
    <div data-id="card" data-type="component"
         style="display:flex;flex-direction:column;gap:4px;padding:16px;background-color:#ffffff">
      <p data-id="card__title" data-type="text" style="font-size:14px;color:var(--color-ink)">Card</p>
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
- 组件库 = 一个**普通的页**。里面的组件元素 `data-type="component"`。它和别的页在同一个文件里，没有单独文件，也不需要惰性容器。`data-ref` 按组件的 `data-id` 引用它。
- `data-id` 在整个文件内唯一。CLI 自动补 id 时带页名前缀（`home__title`）。

**浏览器与画布的分工。**

- 浏览器直接打开：页按正常文档流纵向堆叠，像一张联络表。文件是合法网页。
- 画布：画布注入自己的一份作用域样式，把每页绝对定位到 `data-canvas`。**文件里不含画布样式。**

**收益。**

| 收益 | 说明 |
|---|---|
| 令牌只有一份 | `:root` 在整个设计里只出现一次。`tokens set` = 一个文件、一个 op |
| 组件库就是一个页 | 不需要单独文件，也不需要 `<template>` 惰性容器。组件就是一个 div |
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
- `export --inline-assets` 把图片转成 data URI。交付物完全自包含。
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
- 一个 `.pen` 文件写成一个 `.html` 文件。26 个画板 = 26 个 `<section data-type="page">`。画板的 `x`/`y` 进 `data-canvas`。**pen 的 `reusable: true` 变成 `data-type="component"`**，其余属性不变。pen 的 `type: "ref"` 变成 `data-type="instance"` 加 `data-ref`。参考文件里那个叫"组件库 v2"的顶层画板就是一个普通的页。
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
| `pen` | 是。有损，出账本 | 是。尽力，出账本 | 反向排在最后做 |
| `svg` | 否 | 是。只出图 | 不需要浏览器 |
| `png` `jpeg` `webp` | 否 | 是。只出图 | 需要浏览器 |

- **转换 = 读取器 + 写出器。** 所以 `.pen` → HTML 是「pen 读取器 + html 写出器」。HTML → `.pen` 是「html 读取器 + pen 写出器」。**两件事都不是导出器独占的**，导出器只是写出器里的一种。
- **输入格式选读取器，输出格式选写出器。任意组合都成立。**
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
| 在**设计文件内**唯一 | 跨所有页与所有组件。这是硬规则，校验器拒绝重复 |
| 在**渲染与导出的 DOM 里会重复** | 一个组件被实例化 3 次，展开后它的后代 id 出现 4 次。这是预期行为 |
| op 永远不定位展开副本 | 要改实例内部，走 `data-overrides` 路径。见 §4.3 |
| 为什么用 `data-id` 而不是 HTML 的 `id` | 交付物里重复的 `data-id` 无副作用。重复的 `id` 属性是非法 DOM |

**八种类型，与允许的标签。**

| `data-type` | 允许的标签 | 能带 children | 说明 |
|---|---|---|---|
| `page` | `<section>` | 是 | 一页。不是节点，是页的容器 |
| `frame` | `<div>` | 是 | 盒子 |
| `component` | `<div>` | 是 | 组件。渲染行为与 `frame` 相同，且能被 `data-ref` 引用。见 §4.3 |
| `text` | `<p>` `<h1>`–`<h6>` `<span>` | 否 | 一个元素一段文本 |
| `image` | `<img>` | 否 | `src` 与 `alt` 必填 |
| `shape` | `<div>` | 否 | 配 `data-kind` |
| `icon` | `<svg>` | 否 | 配 `data-icon` 与 `data-icon-library`。字形是内联几何 |
| `instance` | `<div>` | 否 | 配 `data-ref` 与 `data-overrides` |

**可选属性。**

| 属性 | 用在 | 规则 |
|---|---|---|
| `data-name` | 任何 | 显示名。给人看 |
| `data-hidden` | 任何 | `"true"`。等价 `display:none`，但保留节点 |
| `data-locked` | 任何 | `"true"`。画布不可拖动。不产生 CSS |
| `data-canvas` | `page` | `"x,y"`。画布摆放位置 |
| `data-library` | `page` | `"true"`。这是组件库页，不算交付物。`export --all` 跳过它 |
| `data-kind` | `shape` | `rect`（默认）｜`ellipse`｜`line` |
| `data-icon` | `icon` | 字形名 |
| `data-icon-library` | `icon` | 目前只有 `lucide` |
| `data-ref` | `instance` | 组件的 `data-id` |
| `data-overrides` | `instance` | 字段级覆盖。JSON |
| `data-credit` | `image` | 署名。永不渲染 |

**尺寸意图**用 §2.3 的规范 CSS 写法。**不引入 `data-w` / `data-h`。**

**退休的四个旧概念。** `data-page` → `data-id` 加 `data-type="page"`。`data-component` → `data-id` 加 `data-type="component"`。`data-shape` → `data-kind`。`<template>` → 不需要了，组件就是一个 div。

规则变了：以前靠"哪个标记属性在场"判断类型，现在靠 `data-type` 一个必填字段。

### 4.2 【新】设计令牌

**这是原稿完全没写、但价值最高的功能。**

- 令牌声明在 `<style>:root{ --color-accent:#2563eb }</style>`。
- 整个设计只有一份令牌块。它在文件里出现一次。所以 `tokens set` 只改一个文件，只产生一个 op。
- 元素用 `var(--color-accent)` 引用。
- 分组固定七组：`color`、`font`、`space`、`radius`、`size`、`shadow`、`border`。
- 命名：`--<组>-<名字>`。组名是闭集，所以按第一个连字符切分即可反解。
- 数值组的声明带单位：`--space-md:16px`。
- 令牌可以引用令牌。深度上限 16。循环被拒绝。
- `export --resolve-tokens` 把令牌烘焙成字面量。

**为什么必须有。** 没有令牌，"把品牌色改成紫色"要改 200 处。

### 4.3 组件与实例（原稿第 6 条）

**【定】组件是一个类型。它的渲染行为与 `frame` 完全相同。**

- 组件 = `<div data-type="component">`。它能带 children，能放在任何页里，也能嵌套在另一个组件里。
- 它的 `data-id` 就是组件名。引用它用 `data-type="instance"` 加 `data-ref`。
- 它待在原来的位置，照常布局，照常渲染。
- 所以**组件库就是一个普通的页**，按惯例给它 `data-library="true"`。

```html
<!-- 组件库页里的一个组件。它就是个 div -->
<div data-id="card" data-type="component"
     style="display:flex;flex-direction:column;gap:4px;padding:16px">
  <p data-id="card__title" data-type="text" style="font-size:14px">Card</p>
</div>

<!-- 别处引用它。只存引用，不存展开的子树 -->
<div data-id="home__card" data-type="instance" data-ref="card"
     data-overrides='{"card__title":{"content":"你好"}}'></div>
```

**唯一的结构限制。** 组件根必须是一个 `<div>`。所以不能把一个 `<p>` 或 `<img>` 直接变成组件，要那样做就包一层。

实测这条限制不产生损失：参考 pen 文件里 23 个 reusable 节点，**22 个是 frame，1 个是 ellipse**。ellipse 在我们的格式里本来就是 `div` 加 `border-radius:50%`。

**为什么不用 `<template>`。**

- `<template>` 的内容不渲染、不参与布局、没有盒子、不能测量、也不在文档树里。**"组件库正常显示"用它做不到。**
- 它不是元素。它写不了 `data-type`，直接违反"每个元素两个必填属性"。
- 它换不来任何东西。展开发生在导出与画布挂载时，由我们的代码做。`<template>` 的用途是"运行时用 JS 盖章"，我们不那么做。

**展开发生在哪里。** 设计文件只存引用，**不含任何脚本**。展开有两处，共用同一个函数：

```
resolve(instance) = applyOverrides(deepClone(find(ref)), instance.overrides)
```

| 位置 | 做什么 |
|---|---|
| `export` 写交付物 | 把实例元素换成组件子树加覆盖 |
| 画布挂载 | 同样展开。所以画布所见与交付物一致 |

**为什么文件里不存展开的副本。** 那样双击文件就能看到完整效果，但代价是致命的：

- **展开出来的元素会带来重复的 `data-id`。** 一个组件被实例化 3 次，它的后代 id 就出现 4 次。这违反"`data-id` 全文唯一"。两条出路都破坏统一规则：编派生 id（引入第二种命名法），或者不给 id（违反另一条规则）。
- 组件不再是单一真相源。每次写入都要重展开，否则漂移。
- 文件体积随实例数线性增长。参考 pen 文件有 239 个实例。

选择的代价要写进文档：**双击文件时，实例位置是空的。** 要看完整效果用 `export`。

**收益。**

| 收益 | 说明 |
|---|---|
| 一条规则 | 组件和其他元素一样：`data-id` 加 `data-type`。没有额外的布尔标记 |
| 组件能放在任何页里 | 它就是那个页的一部分，照常布局 |
| 少一个标签 | `<template>` 从允许的标签里消失 |
| 少一个导出选择器 | `--component <name>` 取消。组件就是节点，用 `--id <组件id>` 导出它的图 |

**代价（必须写进文档）。**

- 组件定义会**渲染**。组件库页在浏览器里就是它本来的样子。
- 这与 pen 一致：pen 的组件库就是画布上的一个普通画板。
- 所以 `export --all` 要跳过库页。规则：带 `data-library="true"` 的页不算交付物。要导出它就用 `--page library` 显式指定。

**实例的规则（不变）。**

- 理由：组件是单一真相源。没有副本要同步，没有冲突要合并。
- 代价：直接双击页面文件时，实例位置是空的。要看完整效果用 `export`。
- 覆盖是字段级并入。`{"card__title":{"font-size":"20px"}}` 只钉住字号，其余字段继续跟随组件。
- 覆盖不能改结构。`data-id`、`data-type`、`children` 不是可覆盖字段。
- `data-overrides` 是文件里唯一的 JSON。理由：不限制 id 字符集，覆盖可以到任意深度。
- 实例元素自身可带 `style`、`data-name`、`data-hidden`、`data-locked`。这些落在组件根上。
- 解绑（detach）命令把引用换成组件当前展开的子树。**展开副本的后代必须重新编号**，否则与组件定义里的 id 重复。新 id 加实例前缀，例：`home__card__title`。

**pen 就是这么做的。** 证据见 §2.6：任意对象加 `reusable: true` 就是组件，实例是 `{type: "ref", ref: "<id>"}`。参考文件里的"组件库 v2"是一个普通顶层画板，23 个组件里 22 个是 frame。

### 4.4 【新】op：唯一的变更单元

**这是原稿第 12 条的地基。** 回退需要粒度。粒度就是 op。

```
{ "op": "set",    "target": "n_cta",  "prop": "border-radius", "value": "12px" }
{ "op": "unset",  "target": "n_cta",  "prop": "border-radius" }
{ "op": "insert", "target": "n_hero", "index": 0, "html": "<div data-id=… data-type=…>…</div>" }
{ "op": "remove", "target": "n_card" }
{ "op": "move",   "target": "n_card", "before": "n_cta" }
```

- 五种 op：set、unset、insert、remove、move。
- 定位用 `data-id`，**不用 CSS 选择器**。理由：选择器有歧义，且有性能问题。
- `data-id` 在整个文件内唯一，跨所有页。所以一个目标 id 不需要再带页名。
- op 不需要 `data-type`。一个 id 就够了。
- 每个 op 列表可逆。`applyOps` 返回逆 op。
- 一个 op 等于一步撤销、一行变更日志。
- 组件库里的元素也可用 `data-id` 定位。所以"改组件本体"与"改页面元素"是同一条路径。
- 实例内部元素的唯一改法是覆盖路径。

### 4.5 【新】诊断模型

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

码前缀：`syntax/*`、`style/*`、`structure/*`、`a11y/*`、`geometry/*`、`component/*`、`asset/*`、`version/*`、`ops/*`。

### 4.6 【新】日志：拆成两份（原稿第 12 条收紧）

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
| `rename` | 改 `data-id`，并级联更新引用 | `<old-id> <new-id>` |
| `ls` | 列页与节点 | `[--pages] [--in <page\|id>] [--depth n] [--json]` |
| `show` | 看单个元素 | `<id> [--json]` |
| `tokens` | 令牌增删改查 | `ls \| set <组.名> <值> \| rm <组.名>` |
| `component` | 组件是一个类型。`mark` 就是把 `data-type` 从 `frame` 改成 `component` | `mark <id>` ／ `unmark <id>` ／ `use <id> --in <parent>` ／ `detach <instance-id>` |
| `validate` | 校验 | `[--json] [--strict]` |
| `format` | 归一化 | `[--check]` |
| `export` | 从设计文件出交付物。范围可选 | `[--page <id>] [--id <data-id>] [--all] [-o path] [--format html\|pen\|svg\|png\|jpeg\|webp] [--raster auto\|chrome\|canvas] [--scale 1\|2\|3] [--size WxH] [--background transparent\|#RRGGBB] [--padding <px>] [--inline-assets] [--resolve-tokens] [--report r.json]` |
| `import` | 把别的格式读成设计文件 | `pen <file> [-o design.html] [--report r.json]` |
| `serve` | 开画布 | `[<file>] [--port 0] [--ttl 30]` |
| `log` | 读日志 | `[--tail n] [--intent]` |

- 所有变更类动词共有：`--dry-run`、`--json`、`--quiet`。
- 退出码固定：0 正常 / 1 无效或被拒 / 2 不可读或参数错。
- 命令用 `data-id` 定位元素，所以不需要 `--page`。只有 `new`、`ls --pages`、`export` 用页名。
- **`data-id` 是地址，所以 `set` 不能改它。** 改名要用 `rename`。
- `rename` 负责级联：改组件的 id 要更新所有指向它的 `data-ref`。改组件内某后代的 id 要更新所有 `data-overrides` 里对应的键。
- `--id` 只对图片格式（`svg`、`png`、`jpeg`、`webp`）有效。HTML 导出只有页粒度。
- **方向只有一个入口，一个出口。** 进来用 `import`（别的格式 → 设计文件）。出去用 `export`（设计文件 → 交付物或别的格式）。
- `import pen` 走「pen 读取器 + html 写出器」。它产出**设计文件**，不是交付物。要交付物再 `export`。
- `export --format pen` 走「html 读取器 + pen 写出器」，并输出账本。
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
| 语义 | 实例的 `data-ref` 是否指向一个 `data-type="component"` 的元素。`data-overrides` 的键是否都是组件内的后代 id。令牌是否存在。几何是否装得下 |

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

**两个轴。** 输入格式选读取器。输出格式选写出器。两者正交。下表是**写出器**，读取器见 §3.2。

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
| `--page home --id n_hero` | 该页里 `n_hero` 的子树 | **否** | 是 | `home__n_hero.<ext>` |
| `--all` | 每一页一个文件。跳过组件库页 | 是 | 是 | `<页名>.<ext>` |

- **HTML 的粒度只有页。** 一次一页，或者 `--all` 一次全站。不给片段。
- **理由。** HTML 导出是交付物。交付物是一页，或者一个站点，不是一棵子树。
- **图片的粒度是页或 `data-id`。** 图片指 `svg`、`png`、`jpeg`、`webp`。
- `--id` 与 `--format html` 同时给 → 报错，并提示改用 `show <id>`。
- `--id` 必须指向文件里真实存在的元素。**实例内部的后代不是元素，没有 `data-id`，不能作为目标。** 要导出一个实例，就导出实例元素本身。
- 互斥：`--all` 与 `--id`。同时给就报错。
- 要一个组件的图，用 `--id <组件id>`。组件就是节点，所以走同一条路。

**节点级图片导出要补三样东西。** 一棵子树离开父级后，会丢三样上下文：

| 丢什么 | 补法 |
|---|---|
| 令牌 | `var(--color-accent)` 要么摊平，要么让导出物带上 `:root` 令牌块。由 `--resolve-tokens` 决定 |
| 可继承属性 | 把祖先链上的值物化到导出根上。可继承属性是：`color`、`font-family`、`font-size`、`font-weight`、`line-height`、`letter-spacing`、`text-align`、`text-transform`、`white-space`。**不做这一步，子树的字体与颜色会丢**，因为通常只在页根上写一次 |
| 尺寸 | `flex:1` 与 `width:100%` 的节点脱离父级后没有确定尺寸。栅格化时必须用一个同尺寸的盒子包住它，或用 `--size WxH` 显式指定 |

- 阴影会溢出边框盒。栅格化默认按 `box-shadow` 的外扩量自动加边距。`--padding <px>` 可以覆盖这个默认。
- 物化可继承属性与补尺寸是节点级导出与整页导出最不一样的地方。要有专门的测试。

**导出目标。**

| 目标 | 做法 |
|---|---|
| 单页 | 抽出该页的 `<section>`，内容摊进 `<body>`，写入对应的 `<meta name="viewport">`。展开全部实例 |
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
- `--raster canvas` 的原理：把该页 HTML 包进 `<svg><foreignObject>`，加载成图片，画到 `<canvas>`，导出 blob。
- **本格式对这个做法特别友好。** 元素样式全部内联，只有一份 `:root` 令牌块要摊平。普通网页做不到这一点，因为外部样式表与级联没法在 `foreignObject` 里复现。
- `--scale 1|2|3`，默认 1。`--background transparent|#RRGGBB`，默认取页框的 `background-color`。
- 字体：`chrome` 路径靠 `--virtual-time-budget` 等待。`canvas` 路径靠 `document.fonts.ready`。
- 外链图片：先内联成 data URI。`chrome` 路径也可以改为等网络空闲。

**导出也返回回执。** 写出的文件列表，加每页的像素尺寸。

**双向导出不现实。** 主方向是 `.pen` → HTML。反方向只在确有需求时做。

### 5.9 【新】查询面

设计文件可能很长。参考项目近 2 万行。模型不能每次读全文。

需要：`ls --pages`（列页）、`ls --in <page>`（列某页的节点树）、`show <id>`、`tokens ls`、按名字搜索。全部支持 `--json`。

HTML 导出没有片段粒度。模型读子树用 `ls --in` 与 `show <id>`。要一张节点的图，用 `export --id <data-id> --format png`。

## 6. 技术架构

### 6.1 分层与目录

```
lib/            纯函数。浏览器安全。不得 import node:*
  format.mjs      格式表（属性、取值、别名、简写、元素映射）  ← 唯一真相源
  parse.mjs       HTML → 文档模型
  validate.mjs    四层校验
  normalize.mjs   归一化与规范形式
  ops.mjs         五种 op、id 索引、可逆
  render.mjs      文档模型 → 画布 HTML 加 CSS
  export.mjs      文档模型 → 交付物 HTML
  svg-out.mjs     HTML → SVG（foreignObject 包装）          ← 新
  raster.mjs      栅格化的路径编排、选择与报错              ← 新
  fragment.mjs    片段 → op            ← 新写的核心
  receipt.mjs     回执模型与呈现
  tokens.mjs      令牌解析
  components.mjs  展开、覆盖、循环检测
  readers/html.mjs    HTML 读取器。无损，主格式
  readers/pen.mjs     .pen 读取器。有损，出账本
  writers/html.mjs    HTML 写出器。规范形式与交付物
  writers/pen.mjs     .pen 写出器。尽力，出账本
  icons.mjs       内置字形表（生成物）
  geometry.mjs    几何检查。只报确定的错误
  diagnostics.mjs 分组、过滤、定位

lib/node/       唯一碰文件系统与网络的地方
  cli.mjs  fs.mjs  server.mjs  log.mjs
  browser.mjs     ★新 探测并调用本机 headless 浏览器。唯一会 spawn 进程的模块

scripts/        命令面（薄）
canvas/         浏览器应用。无构建。原生 ES 模块
references/     生成物。schema 文档与样式文档
test/           node --test
```

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

**判据：** 一次写对率 ≥ 80%。静默丢弃 0。这两条过了再画布，再 `.pen` 导入，再组件，最后图片导出。`svg` 零依赖，可以第一步就带上。`png` 需要一个浏览器，排在最后。

## 11. 附录：原稿 12 条的落位

| 原稿 | 落位 | 补了什么 |
|---|---|---|
| 1 HTML 为主格式 | §2.1、§2.2、§2.3、§2.6、§4.1 | 每个元素两个必填属性：`data-id` 与 `data-type`。多页文件模型。规范形式表。令牌与页框两个例外。版本标记 |
| 2 六件套 | §3.1、§3.2 | 归一化器。读与写的切分。每个部件的输入输出与运行时机 |
| 3 多实现 | §3.2、§2.6、§2.4 | 读取器与写出器两个接口。四个格式的能力表。转换 = 读取器 + 写出器。版本标记与迁移 |
| 4 node CLI | §5.1 | 动词表。退出码。共有参数 |
| 5 画布三区 | §5.7 | 视图状态不写文件。拒绝的编辑可视化 |
| 6 组件机制 | §4.3、§4.1 | 组件是 `data-type="component"`，渲染同 frame，可放任何页。组件库就是一个页。实例只存引用。覆盖是字段级并入。解绑 |
| 7 限定样式 | §5.4、§2.3 | 约 40 属性白名单。别名与简写处理。越界三种处理 |
| 8 渲染器与浏览器 | §3.2、§5.5 | 一个服务按扩展名选读取器 |
| 9 双向导出 | §5.8、§2.5、§1 | 粒度规则：HTML 只有页，图片可到 `data-id`。节点级导出要补三样上下文。输出格式含 SVG 与图片。两条栅格化路径与 `svg` 出路 |
| 10 修改器 | §5.2、§5.3、§4.4 | 十步流程。回执四类。op 是变更单元 |
| 11 服务同步 | §5.5、§5.6、§6.2、§6.3 | 三项安全守卫。写入漏斗。两个写入者规则 |
| 12 日志与回退 | §4.6、§4.4 | 拆成变更日志与意图日志。op 是可逆粒度 |
| 缺 | §4.2、§5.9、§8 | 设计令牌。查询面。验收指标 |
