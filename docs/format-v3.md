# format-v3 — 接口契约

本文档冻结 v2 的接口。所有模块按本文档实现。改动本文档需要 Lead 决定。

读者：实现者。读完之后可以直接写代码，不需要再问设计问题。

---

## 1. 设计文件

一个 `.html` 文件等于一个设计。文件必须是合法且自包含的 HTML。

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>miniprogram</title>
  <meta name="design-schema" content="3.0">
  <style>
    /* 只允许两个块：令牌块与页框块。元素样式一律内联。 */
    :root{ --color-bg:#0b0d12; --space-md:16px }
    section[data-type="page"]{ margin:0 0 24px }
  </style>
</head>
<body>
  <section data-id="home" data-type="page" data-name="首页" data-canvas="0,0"
           style="width:390px;height:844px;overflow:hidden">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;width:100%;height:100%">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700">你好</p>
    </div>
  </section>
</body>
</html>
```

规则：

- 页是 `<section data-type="page">`。页在文件里按文档顺序排列。
- 令牌块与页框块只能出现在 `<head>` 的一个或两个 `<style>` 里。两个块都要保留。**它们必须合并，不是后者覆盖前者。**
- 令牌块里，`:root{…}` 之前要写基础规则。基础规则是文件对自己的陈述：

  ```css
  *,*::before,*::after{box-sizing:border-box}
  *{margin:0}
  img{display:block}
  svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  ```

  四条规则各堵一个浏览器默认值：

  | 默认值 | 不写会怎样 |
  |---|---|
  | `box-sizing:content-box` | `width:375px;padding:0 24px` 变 423px 宽 |
  | `p` 自带 `margin:1em` | 一行标签高 1em 的两倍 |
  | `img` 默认 `inline` | 图片下方多出一条基线的空隙 |
  | SVG `fill` 默认黑 | 描边字形变黑剪影 |
  | `stroke-width` 默认 1 | 字形比 24 视框下细一半 |

  文件必须自己说。画布与 `export` 只注入文件里写下的规则，不自己造一条。缺基础规则时校验器报 `style/no-base-rules`，只缺其中几条时报 `style/incomplete-base-rules` 并点名缺哪条：只缺一条的文件盒模型是对的，页面看着没错，只有一个字形或一个形状是错的——静默的差别正是这个格式不允许的东西。

  **基础规则的选择器只认元素，不认 `data-*`。** 一条 `[data-kind="ellipse"]{border-radius:50%}` 比 28 个节点各自声明短，但它是错的：`export` 会丢掉设计层的属性，规则在交付物里不再匹配，圆就变成方。节点长什么样，写在节点自己的 `style` 里。
- `<body>` 里的 `<style>` 是错误。报 `style/style-in-body`。
- 页在画布上的位置写在 `data-canvas="x,y"`。
- 其余元素一律带 `style` 属性。

## 2. 三层模型

| 层 | 内容 | 行为 |
|---|---|---|
| 设计层 | 带 `data-id` 与 `data-type` 的元素 | 建树、校验、渲染、op 改写 |
| 不透明层 | 注释、doctype、未识别标签、`<svg>` 内部几何、裸文本 | 原字节保留，不改写。`<svg>` 内部的元素不校验，带 `data-id` 时报 `structure-id-inside-icon` |
| 页框层 | `section[data-type="page"]`、两个 `<style>` 块 | 只这两块被认可 |

### 2.1 一块必须堵住的失败模式

未识别标签既不在设计层，也不在不透明层。

规则：**解析器保留它的原字节。校验器报 `structure/unsupported-tag`。序列化器不动它。**

两个行为必须同时成立。只做保留会放进坏文件。只做报错会静默删掉文件内容。

## 3. 元素契约

八种 `data-type`。

| `data-type` | 允许的标签 | 必填附加属性 | 能带 children |
|---|---|---|---|
| `page` | `section` | — | 是 |
| `frame` | `div` | — | 是 |
| `component` | `div` | — | 是 |
| `text` | `p` `h1` `h2` `h3` `h4` `h5` `h6` `span` | — | 否 |
| `image` | `img` | `src` `alt` | 否 |
| `shape` | `div` | `data-kind` | 否 |
| `icon` | `svg` | `data-icon` `data-icon-library` `viewBox` | 否 |
| `instance` | `div` | `data-ref` | 否 |

`font-family` 的末尾要有一个通用族。`"Noto Serif SC"` 单独出现的意思是「Noto Serif SC，或者这台机器的文档默认字体」，而文档默认在多数引擎上是衬线体。装了 webfont 的机器看着对，装不上的机器（离线、走代理、构建机）就是另一个设计。pen 的导出在它写的每个字体族后面都补 `system-ui, sans-serif`，读入器照做。校验器报 `style/no-generic-family`。

`icon` 的 `viewBox` 是必填。几何图形画在 24×24 的格子上，`viewBox` 说出这个格子。没有 `viewBox` 的 `<svg>` 没有坐标系：浏览器不缩放几何，只裁剪它。`target` 的三个圆变成一个弧，`signal` 的五根柱变成一个点。校验器报 `structure/icon-without-viewbox`。

`data-kind="ellipse"` 说形状，形状画在节点自己的 `style` 里：`border-radius:50%`。`div` 默认是矩形，圆角是唯一让它变圆的东西，而 `50%` 是唯一画得出椭圆的写法——它按盒子自身的宽高分别计算，所以 60×20 是椭圆，`9999px` 会被截到短边的一半，画成胶囊。校验器报 `style/ellipse-without-radius`。

可选属性：

| 属性 | 用在 | 规则 |
|---|---|---|
| `data-name` | 任何 | 显示名。给人看 |
| `data-hidden` | 任何 | `"true"`。等价 `display:none`，保留节点 |
| `data-locked` | 任何 | `"true"`。画布不拖动。不产生 CSS |
| `data-canvas` | `page` | `"x,y"`。画布位置。缺省时画布按栅格排布 |
| `data-library` | `page` | `"true"`。组件库页，不是交付物 |
| `data-kind` | `shape` | `rect`（默认）｜`ellipse`。`ellipse` 要配 `border-radius:50%` |
| `data-icon` | `icon` | 字形名 |
| `data-icon-library` | `icon` | 目前只有 `lucide` |
| `data-ref` | `instance` | 组件的 `data-id` |
| `data-overrides` | `instance` | 字段级覆盖。JSON 文本。字段见 §3.1 |
| `data-credit` | `image` | 署名。永不渲染 |

`data-id` 规则：匹配 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`。在整个文件内唯一。自动补 id 时带页名前缀，写成 `home__title`。

`data-id` 不是 HTML 的 `id` 属性。展开实例后 `data-id` 重复是预期行为。

页面的位置只有一种写法：`data-canvas`。在页面自己的 `style` 里写 `position:absolute` 加 `left`/`top` 不算第二种写法。画布按 `data-canvas` 摆页面，所以文件里的那两句在画布上看不出问题。交付物里看得出：单页导出就是整篇文档，没有可定位的参照物，页面会被推出自己的左上角。导出会丢掉那几句声明，校验器报 `structure/page-position`。

### 3.1 覆盖的字段

`data-overrides` 是 JSON 文本。键是组件内某个后代的 `data-id`。值是字段对象，只有四种：

| 字段 | 作用 |
|---|---|
| `content` | 换掉该节点的文本 |
| `style` | 追加声明。同名声明覆盖组件自己的 |
| `data-*` | 换掉一个属性。例如 `data-icon` |
| `children` | 换掉该节点的 children。值是 HTML 片段 |

`children` 是唯一的整段替换。`svg` 的几何图形在本格式里是字节，不是名字，所以换字形就是换几何：`data-icon` 和 `children` 要一起写。`content` 写进 `<svg>` 里的文本不在 `<text>` 里，一个字都不画。校验器报 `component/text-override-on-icon`。

`style` 覆盖不了主尺寸。组件的 `width` 比 `align-self:stretch` 更硬，所以让实例跨轴填满要写 `width:100%`。

## 4. 文档模型

`lib/parse.mjs` 产出这棵树。所有模块消费它。

```js
// 文档
{
  kind: "document",
  source: string,          // 完整原文
  children: Node[],        // doctype / comment / 最高层元素
  doctype: Node | null,
  html: Element | null,    // <html> 元素
  head: Element | null,    // <head> 元素
  body: Element | null,    // <body> 元素
  styleBlocks: StyleBlock[],
  diagnostics: Diagnostic[]
}

// 元素
{
  kind: "element",
  tag: "div",              // 小写
  rawTag: "DIV",           // 原文大小写
  attrs: Attr[],           // 按原文顺序
  children: Node[],
  selfClosing: false,      // 原文写了 />
  parent: Element | null,
  start: 0,                // '<' 的字符偏移
  end: 15,                 // 结束标签之后一位的偏移
  openStart: 0,            // start
  openEnd: 10,             // '>' 之后一位
  closeStart: 10,          // '</div>' 的 '<' 偏移。void 与未闭合时为 -1
  closeEnd: 15
}

// 属性
{ kind: "attr", name: "style", rawName: "style", value: "a:b", quote: "\"", start: 6, end: 20, attrStart: 5 }

// 文本
{ kind: "text", value: "你好", raw: "你好", parent, start: 20, end: 22 }

// 注释与 doctype
{ kind: "comment", raw: "<!-- x -->", parent, start: 0, end: 12 }
{ kind: "doctype", raw: "<!doctype html>", parent, start: 0, end: 15 }
```

不变量：

1. 所有节点按 `start` 排序。父节点区间包含子节点区间。
2. `source.slice(start, end)` 是节点的原字节。
3. 元素含子节点时 `openEnd <= children[0].start`、`children[last].end <= closeStart`；`closeEnd` 等于 `end`，未闭合时为 `-1`，此时 `end === openEnd`。
4. 不做隐式标签补全。`<p>` 里遇到另一个 `<p>` 时按原文结束前一个（与 HTML 一致），并在树里如实反映。
5. 不改写任何字节。`attrs` 保留原文的顺序、引号样式、大小写与空格。

### 4.1 StyleBlock

```js
{ kind: "style-block", role: "tokens" | "page-frame" | "unknown",
  node: Element,            // <style> 元素
  text: string,             // 原文
  textStart: number, textEnd: number,  // 文本在 source 中的区间
  declarations: CssDeclaration[],      // 只对 :root 块解析
  rules: CssRule[] }        // 只对页框块解析
```

`role` 判定：`<style>` 在 `<head>` 内、内容含 `:root{` 或 `:root {` 时是 `tokens`。内容含 `section[data-type="page"]` 时是 `page-frame`。其余是 `unknown`，报 `style/unsupported-block`。

**两个块都要收集。禁止后用块覆盖前用块。**

### 4.2 CSS 声明列表解析

`parseDeclarations(text) -> CssDeclaration[]`

```js
{ property: "background-image", rawProperty: "background-image",
  value: "...", rawValue: "...", textStart, textEnd }
```

实现要求：**不得按 `;` 切分。** 必须遍历字符，并追踪四个状态。

1. 单引号字符串。
2. 双引号字符串。
3. 圆括号深度。
4. 注释 `/* */`。

只在状态全部复位时，`;` 才算声明分隔符，`:` 才算属性名与值的分隔符。

原因（实测缺陷）：`background-image:url("data:image/svg+xml;base64,AAA")` 含 `;`。按 `;` 切分会把这条声明切成两段，值读成 `url("data:image/svg+xml`。v1 有这个缺陷。

值里的 `;` 是合法的，例如 data URI、`url("a;b")`、`font-family:"Foo;Bar", sans-serif`。

转义：`\` 之后的字符不参与状态判定。未闭合的引号或括号到文本末尾时报 `syntax/unclosed-string`，并把整段文本当作一条声明。

## 4.3 属性名的大小写与无值属性

两条规则，写死：

1. **属性名不区分大小写。** 解析器把小写形式作为规范名，同时保留原文大小写。`DATA-ID`、`data-id`、`Data-Id` 是同一个属性。校验器按小写形式判断。序列化时，**未被改动的属性写回原文形式**；被改动的属性写小写形式。
2. **无值属性等于空字符串，只有 `data-hidden` 例外。** `data-hidden` 没有值时等于 `data-hidden="true"`。其余 `data-*` 没有值时按空字符串处理，归一化时补成 `data-x=""`。

理由：手写文件里 `DATA-ID` 与 `<img/>` 很常见，拒绝它们没有收益。`data-hidden` 是唯一一个"在场即真"的属性，所以给它一条明写的规则。

## 5. 序列化

`lib/serialize.mjs` 提供三个函数。

```js
serialize(doc)                       // 原文，或按变更重排后的文本
serializeNode(node, options)         // 单个节点的当前内容
applyEdits(source, edits)            // 按区间替换，返回新文本
```

### 5.1 三个层次

| 层 | 行为 | 判据 |
|---|---|---|
| 字节保真 | 没有变更时，`serialize(parse(text)) === text` | 测试断言 |
| 最小改动 | 一个 op 只改一个字节区间 | 测试断言区间数 |
| 语义归一 | 归一化后只改受影响的区间 | 归一化幂等 |

`serialize(doc)` 的实现：若 `doc.dirty` 为空，直接返回 `doc.source`。否则用 `applyEdits` 替换变更区间。区间按 `start` 降序应用，避免偏移漂移。

`applyEdits(source, edits)`：`edits` 是 `[{ start, end, text }]`。函数检查区间不重叠。重叠时抛错。

### 5.2 何时重新生成字节

| 变更 | 动作 |
|---|---|
| 元素的 `style` | 只替换该属性的值区间 |
| 元素的文本 | 只替换文本区间 |
| 元素属性增删 | 只替换 `openStart..openEnd`（开始标签） |
| 子节点增删 | 替换整棵子树区间 `start..end` |
| 未知标签内部 | **永不替换** |

## 6. 诊断

```js
{ severity: "error" | "warning",
  code: "structure/unsupported-tag",
  target: "home__title",      // data-id。可选
  path: "body > section > div > p",  // 人读路径
  offset: 1234,               // 原文偏移。可选
  line: 42, column: 7,        // 由 offset 算出。可选
  message: "…",
  hint: "…",                  // "这里接受什么"
  fix: "node design.mjs set home__title --style 'color:#ffffff'"  // 可执行。可选
}
```

码前缀与本文档的实现者按此分配：

| 前缀 | 归属 | 数量 |
|---|---|---|
| `syntax/` | `lib/parse.mjs` | 未闭合标签、未闭合字符串、坏属性、坏注释 |
| `style/` | `lib/table.mjs` + `lib/validate.mjs` | 未知属性、未知取值、别名、简写、未知块 |
| `structure/` | `lib/validate.mjs` | 缺 id、重复 id、缺 type、类型与标签不符、未识别标签、缺必填属性、页在错误位置、页面自己写位置 |
| `a11y/` | `lib/validate.mjs` | 图片缺 alt、对比度 |
| `geometry/` | `lib/geometry.mjs` | 溢出、塌陷、裁切 |
| `component/` | `lib/components.mjs` | 未知组件、循环、未知覆盖目标、覆盖里给字形写文本 |
| `asset/` | `lib/validate.mjs` | 图片缺 src、字体族未知 |
| `version/` | `lib/validate.mjs` | 缺 `design-schema`、版本不支持 |
| `ops/` | `lib/ops.mjs` | 坏 op、节点未找到 |

诊断的键：`code + "|" + offset + "|" + message`。用于"只在新错误时拒绝"的差集。

## 7. 格式表

`lib/table.mjs` 是唯一真相源。所有消费者都读它。

```js
export const CSS_ORDER = [...];        // 40 个属性，按输出顺序
export const CSS_ALLOWED = { "display": Spec };  // 属性 → 取值语法
export const CSS_ALIASES = { margin: null, background: "background-color" };  // null = 拒绝
export const TAG_TO_TYPE = { div: "frame", section: "page", p: "text", ... };
export const TYPE_TAGS = { text: ["p","h1",...] };  // 反向
export const PROP_BY_TYPE = { text: ["font-size", ...], icon: ["color", ...] };
export const ATTR_BY_TYPE = { image: { required: ["src","alt"] }, ... };
export const VALUE_HINTS = { "display": "flex | block | none" };
```

`Spec` 形状：

```js
{ kind: "enum", values: ["flex","block","none"], hint: "flex | block | none" }
{ kind: "length", unit: "px", min: 0, keyword: ["auto","100%"], hint: "…" }
{ kind: "color", hint: "#rrggbb | #rrggbbaa | var(--color-x)" }
{ kind: "number", min: 0, max: 1, decimals: 3 }
{ kind: "keyword-set", values: ["flex-start","center","flex-end","stretch"] }
{ kind: "text" }                        // 自由文本，例如 font-family
```

四个消费者必须从这一张表读取：片段编译、校验、归一化、提示文本生成。

## 8. 归一化

`lib/normalize.mjs` 分两层。两层都要幂等。

| 层 | 内容 |
|---|---|
| 文本层 | 行尾统一 LF；文件末尾一个换行；属性值引号统一双引号；布尔属性写法统一 `data-x="true"` |
| 语义层 | 颜色六位或八位小写十六进制；长度统一 `px`；零写作 `0`；四值 padding 压缩；数字最多三位小数；属性按 `data-id` `data-type` 其余字母序 `style` 最后；`style` 声明按 `CSS_ORDER` 排序 |

归一化只改必须改的区间。**不改未知标签的内部。不重排页。不重排注释。**

## 9. 模块与所有权

| 模块 | 内容 | 归属 |
|---|---|---|
| `lib/parse.mjs` | HTML → 文档模型，带偏移 | Lead |
| `lib/serialize.mjs` | 文档模型 → 文本，最小改动 | Lead |
| `lib/table.mjs` | 格式表 | Lead |
| `lib/validate.mjs` | 四层校验 | Lead |
| `lib/normalize.mjs` | 两层归一化 | Lead |
| `lib/diagnostics.mjs` | 分组、过滤、定位 | Teammate |
| `lib/spans.mjs` | 区间替换与重叠检查 | Teammate |
| `lib/pointer.mjs` | RFC 6901 工具 | Teammate |
| `lib/levenshtein.mjs` | 距离与建议 | Teammate |
| `lib/detect.mjs` | 扩展名加内容嗅探，选读取器 | Teammate |
| `lib/node/fs.mjs` | 读、原子写、哈希 | Teammate |
| `lib/node/cli.mjs` | 入口判定、参数解析 | Teammate |
| `design.mjs` + `lib/node/verbs/*.mjs` | 动词面 | Teammate |
| `canvas/` | 画布 | 后续里程碑 |
| `test/` | 每个模块各自写自己的测试 | 各自 |

并行规则：一个文件只有一个所有者。需要别的模块时按本文档的接口调用，不改别人的文件。

## 10. 硬约束

1. `lib/` 顶层文件不得 `import "node:*"`、不得用 `require`、`process`、`Buffer`。只有 `lib/node/` 可以。
2. 除 `lib/node/` 外，所有代码在浏览器里可运行。
3. 纯 ESM。没有依赖。没有构建步骤。Node ≥ 18。
4. 测试用 `node --test`。
5. 退出码：0 正常、1 无效或被拒、2 不可读或参数错。
