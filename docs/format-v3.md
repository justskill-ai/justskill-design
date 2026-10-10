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
| `icon` | `svg` | `data-icon` `data-icon-library`，有几何时还要 `viewBox` | 否 |
| `instance` | `div` | `data-ref` | 否 |

`font-family` 的末尾要有一个通用族。`"Noto Serif SC"` 单独出现的意思是「Noto Serif SC，或者这台机器的文档默认字体」，而文档默认在多数引擎上是衬线体。装了 webfont 的机器看着对，装不上的机器（离线、走代理、构建机）就是另一个设计。pen 的导出在它写的每个字体族后面都补 `system-ui, sans-serif`，读入器照做。校验器报 `style/no-generic-family`。

`icon` 的 `viewBox` 在**有几何时**必填。几何图形画在 24×24 的格子上，`viewBox` 说出这个格子。没有 `viewBox` 的 `<svg>` 没有坐标系：浏览器不缩放几何，只裁剪它。`target` 的三个圆变成一个弧，`signal` 的五根柱变成一个点。校验器报 `structure/icon-without-viewbox`。

这条规则是**有条件的**，所以 `ATTR_BY_TYPE.icon` 把它列在 `optional` 而不是 `required`：列进 `required` 会让每个没有几何的空 `<svg>` 也报一次 `structure/missing-attribute`，并在真实图标上把同一个缺失报两次。谁在表里把它挪进 `required`，谁就把这条规则改坏了。

名字大小写：解析器把属性名统一成小写并把原文留在 `rawName`，所以表里的键写 `viewbox`。**写回文件时用原文拼写**，因为 `export --format svg` 产出的是真正的 XML，XML 里没有属性名修复，`viewbox` 不是 `viewBox`，字形会丢掉坐标系。

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

页框块里的 `margin`（默认 `margin:0 0 24px`）是文档流的事：文件在浏览器里打开时，它隔开相邻两页。画布自己摆页面，所以画布把这条外边距清零（`canvasMountCss`）。不清零时它会顶出挂载点，画布的纸就比页面高 24px，底色不是白的页下面会多出一条白边——文件里没有这条边，浏览器里也看不到它。

页面自己的 `border-radius` 是纸的形状（`pagePaperRadius`）：组件库是 24px 的卡片，不是屏幕。纸画在 shadow root 外面，那里的 `var()` 没有定义，所以这个值要先解析。不解析，圆角退回方角，四个角上各留一个月牙形的白。

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
  rootSpans: Array<{open, close, bodyStart, bodyEnd}>,  // 只对 :root 块解析
  rules: CssRule[] }        // 只对页框块解析
```

`role` 判定：`<style>` 在 `<head>` 内、内容含 `:root{` 或 `:root {` 时是 `tokens`。内容含 `section[data-type="page"]` 时是 `page-frame`。其余是 `unknown`，报 `style/unsupported-block`。

**两个块都要收集。禁止后用块覆盖前用块。**

`rootSpans` 是 `:root{…}` 的那对花括号。读的一侧用它取出声明，写的一侧用它把新声明放进**同一对花括号里** —— 追加在 `}` 之后不是令牌，下一次归一化就把它丢了。两侧共用一份 `:root` 查找，才不会对"哪对花括号"有第二种理解。

一个令牌块可以含多个 `:root{}`，那就没有唯一的写入位置；`set-token` 因此拒绝，见 §4.4。

### 4.2 CSS 声明列表解析

`parseDeclarations(text) -> CssDeclaration[]`

```js
{ property: "background-image", rawProperty: "background-image",
  value: "...", rawValue: "...", textStart, textEnd }
```

`textStart`/`textEnd` 是**整段**的边界，含两侧空白。`:root{}` 里的声明另外带 `start`/`end`：那是声明本身（属性名到值尾），坐标相对 `<style>` 的文本。两者都要有，理由不同 —— `textStart` 说的是"这一段原文是什么"，`start` 说的是"这条声明从哪开始"，而诊断的 `offset` 与 `unset-token` 要的是后者。`lib/ops.mjs` 的 `parseStyleDeclarations` 产出的就是后者这四个字段，两个解析器在这一点上必须一致，否则改一条声明要先换算坐标。

**曾经**只报 `textStart`/`textEnd`，于是 `collectTokens` 读的 `decl.start` 从来不存在，每一条令牌诊断的 `offset` 都是 `undefined` —— 一条指不出位置的告警。

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

## 4.4 令牌 op：`set-token` 与 `unset-token`

令牌是文档模型里唯一不是元素的东西。它没有 `data-id`，`resolveAddress` 到不了它，所以它有两个自己的 op：

```js
{ "op": "set-token",   "name": "--color-accent", "value": "#2563eb" }
{ "op": "unset-token", "name": "--color-accent" }
```

- `name` 是 CSS 自定义属性名，**带 `--`**。组的闭集（七组）与数值组带的单位是 `lib/tokens.mjs` 的事；`lib/ops.mjs` 刻意不依赖 `lib/table.mjs`，它只要求名字以 `--` 开头。名字不合法时校验器报 `style/token-name`，写入漏斗会因此拒绝。
- 目标块必须**唯一**。文件里有两个令牌块，或一个块里有两处 `:root{}`，"写哪一个"没有唯一答案，op 拒绝（`ops/ambiguous-token-block`），不猜。没有令牌块时拒绝（`ops/no-token-block`）。`<style>` 不在 `<head>` 里不算令牌块（§4.1）。
- `set-token` 找到声明就换值，找不到就**追加在 `:root{}` 里面**，分隔符用 `; `，不在 `}` 前留悬空的 `;`。
- `unset-token` 连声明**和它一侧的分隔符**一起删。只删声明会在原处留下两个空格；令牌块是文件的字节，不是本引擎排版的地方。
- 两者都可以携带对方删掉的确切字节（`set-token`：`at` + `restore`；`unset-token`：`at` + `span`）。令牌块的排版是文件的：`--a:1; --b:2` 与 `--a:1;\n  --b:2` 都合法，而"撤销一次删除"如果重新排版它删掉的那道缝，就把一个字节忠实的文件变成了几乎忠实的文件。`insert` 带片段、`remove` 带子节点表，是同一个理由。
- `unset-token` 带 `span` 时**先核对**那段字节还在原处，不在就报 `ops/stale-inverse`。逆 op 用在不属于它的文档上，必须拒绝而不是切掉碰巧在那个偏移上的东西。

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

`serialize(origin, next)` 的实现：解析时给每个节点留下 `_raw` 快照，序列化时逐节点把 `next` 与快照比。没有不同就返回 `origin.source`，一个字节都不动；有不同就为每个变化的节点产出一个区间，再用 `applyEdits` 替换。区间按 `start` 降序应用，避免偏移漂移。

**没有 `doc.dirty` 这种标志位**，这份文档曾经写它有。一个需要调用方自觉置位的标志位，第一个忘记置位的调用方就会让编辑静默丢失；快照比对把「改没改」变成被问出来的事实，而不是被声称的状态。

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

| 前缀 | 归属 | 覆盖 |
|---|---|---|
| `syntax/` | `lib/parse.mjs` | 未闭合标签、未闭合字符串、坏属性、坏注释 |
| `style/` | `lib/table.mjs` + `lib/validate.mjs` + `lib/tokens.mjs` | 未知属性、未知取值、别名、简写、未知块、令牌名（`style/token-name`）、重复令牌（`style/duplicate-token`）、令牌环（`style/token-cycle`） |
| `structure/` | `lib/validate.mjs` | 缺 id、重复 id、缺 type、类型与标签不符、未识别标签、页在错误位置、页面自己写位置，以及**除下面两条以外**的缺必填属性 |
| `a11y/` | `lib/validate.mjs` | 图片缺 alt（`a11y/missing-alt`）、文字与背景的对比度（`a11y/low-contrast`） |

`a11y/low-contrast` 逐层向上求出文字底下压着的颜色，取 WCAG AA 的 4.5:1 为界，**按最差的那个背景计分**（渐变给出每一个不透明色标，文字压在它们全部之上）。**三种情形不报**，因为比值不可知：背景是一张照片（`url(...)`，看不到图里是什么）、渐变没有任何不透明色标、以及**半透明层底下没有不透明颜色**（页面之下的surface 属于交付物，不属于文件，猜一个底色就是自信地算错）。

半透明层**是合成的，不是弃权的**：一层 `background-color` 的 alpha 叠在不透明底色上是 sRGB 里的算术，浏览器就是这么合的。白字压在白卡片上的一层 `#00000080` 之上读到的是 `#7f7f7f`（不是手算容易得到的 `#808080`），比值 3.97:1，是一条真缺陷。多层按顺序依次合成。v1 在这里**沿用祖先的填充**，把遮罩当成卡片本身来打分，那是另一种错。
| `asset/` | `lib/validate.mjs` | 图片缺 src（`asset/missing-src`） |
| `component/` | `lib/validate.mjs` | 未知组件、循环、未知覆盖目标、覆盖里给字形写文本 |
| `version/` | `lib/validate.mjs` | 缺 `design-schema`、版本不支持 |
| `geometry/` | `lib/geometry.mjs` | 装不下：溢出（`geometry/overflow`）、裁切（`geometry/clipped`）、塌陷（`geometry/fill-collapsed`）、绝对定位越界（`geometry/absolute-outside`）、min 与 max 冲突（`geometry/axis-conflict`） |
| `ops/` | `lib/ops.mjs` | 坏 op、节点未找到、令牌块不唯一或不存在（`ops/ambiguous-token-block`、`ops/no-token-block`）、没有那个令牌（`ops/no-such-token`）、逆 op 不属于本文档（`ops/stale-inverse`） |

`geometry/` 的五个码**全是 warning**，所以它们永不阻塞写入 —— 这不是约定，是结构：`newErrors` 只对 `severity === "error"` 的诊断做差集。它们**不带 `offset`**（说的是布局，不是文本位置），因此键是 `code|""|target|message` —— 下面那条「`target` 不能省」的规则，主要是为它们写的。

`geometry/` 里没有布局引擎，这是刻意的：第二份 flexbox 实现会在边角上和浏览器不一致，而**会喊狼来了的检查比安静的检查更糟**。凡是需要测量才能知道的量（一段文字多宽、一张图多大、没有展开的实例多大）一律是 `unknown` 并向上传播，依赖它的检查随即不报。同一个码最多报 20 条。

`geometry/` 读 `display` 时只认 `none` 和 `flex` 两个值，其余一律**不下压 flex 语义**：

- `display:none` 与 `data-hidden="true"` 等价（见 §5），所在子树不进父级的排版，自己也不被走查。
- `display:flex`、或没写 `display`（`data-type="frame"` 在本文档里就是 flex 容器）按 flex 算。
- `display:block` 是表里的合法取值，但 block 布局不是 flexbox：`flex-direction` 在它身上无效，`flex-shrink` 也不作用于它的孩子。按 flex 算会换来一批新的漏报，所以它**两个轴都不检查**，自己需要 hug 的轴也不报；它自己声明的 `width`/`height` 照读。

`geometry/` 读 `margin` 时只读**主轴那一对**（row 读左右，column 读上下），作为孩子占用的空间计入。`margin` 是表里的正式成员，只接受四值简写；`margin-top` 一类的单边写法在 `REJECTED_PROPERTIES` 里，所以这里也只读简写。百分比的 margin **四个方向都按包含块的宽度**解析（含上下），负值保留符号，`auto` 不可知因而弃权。交叉轴那一对仍不读。

`geometry/` **不检查交叉轴**的溢出：200px 的列里放 500px 的孩子，命令行不报。这是 v1 的 `lib/geometry.mjs` 就有的限制（它同样只算主轴）。画布的实测遍会报，因为它比的是两个真实盒子的两个轴。

`geometry/` 里 `position:absolute` 的节点，包含块是**最近的定位祖先**而不是父级：父级 `static` 而祖父 `relative` 时，浏览器按祖父摆放。没有定位祖先时包含块是初始包含块，其尺寸不在文件里，因此弃权。页面算作包含块 —— 页面不允许自己写 `position`（`structure/page-position`），不这样规定这类盒子就没有基准。绝对定位的盒子**不拉伸**（`align-items` 到不了脱离文档流的盒子），需要尺寸时按 hug 算。

规则一直是 `lib/table.mjs` 的（`ATTR_BY_TYPE` 说哪个属性必填），校验器只负责给它一个名字。`image` 是唯一有两个必填属性的类型，所以也只有它有两条例外：缺 `alt` 是可达性发现，缺 `src` 是资产发现。其余类型（`icon` 缺 `data-icon-library`、`instance` 缺 `data-ref`）仍是 `structure/missing-attribute`。

`a11y/` 与 `asset/` 这两行曾经写在表里而在代码里发射 0 条 —— 两个声明过、没人兑现的前缀。名字就是当时缺的东西。

**划掉一条，不实现：`asset/` 的未知字体族。** `lib/` 是纯的：它没有文件系统，也没有网络，所以它无法知道一个字体族是否存在。唯一确定的判据是「这个族不在系统字体表里」，而那**几乎每个真实设计都命中**（Inter、Noto Sans SC），正撞在「会喊狼来了的检查比安静的检查更糟」上。这个风险已经由两条规则覆盖：`style/no-generic-family`，以及读取器给每个字体族补通用尾。要做它只能做成显式开关（`validate --offline`），那是一个功能，不是一条码。

诊断的键：`code + "|" + offset + "|" + target + "|" + message`，缺的字段写空串。用于"只在新错误时拒绝"的差集，也用于报告去重。

`target` 是四段里不能省的一段：没有 `offset` 的诊断很常见，少了 `target`，两条只差"说的是哪个元素"的错误会压成同一个键 —— 门禁照样拒绝这次编辑，而报告里两条并成一条，那就是静默丢弃。

**实现只有一份**，在 `lib/diagnostics.mjs`；`lib/validate.mjs` 导入并再导出它，因为 `server.mjs` 是从那里 `loadExport` 取用的。这里曾经有两份实现、两套字段，而且做差集的那一份不符合本文档 —— 同一件事只有一处实现，才不会再分叉。

## 7. 格式表

`lib/table.mjs` 是唯一真相源。所有消费者都读它。

```js
export const CSS_ORDER = [...];        // 输出顺序。每个属性恰好出现一次；数量由表自己决定，本文档不抄
export const CSS_ALLOWED = { "display": Spec };  // 属性 → 取值语法
export const CSS_ALIASES = { background: "background-color", "background-colour": "background-color", "bg-color": "background-color" };  // 别名 → 规范属性名
export const VALUE_ALIASES = { "font-weight": { normal: "400", semibold: "600" }, ... };  // 取值别名 → 规范写法
export const REJECTED_PROPERTIES = { transform: { replacement: null, reason: "No transforms." }, ... };  // 拒绝的属性。replacement 为 null 表示没有替代写法
export const TAG_TO_TYPE = { div: "frame", section: "page", p: "text", ... };
export const TYPE_TAGS = { text: ["p","h1",...] };  // 反向
export const ATTR_BY_TYPE = { image: { required: ["src","alt"] }, ... };
export const COMMON_OPTIONAL = ["data-name", "data-hidden", "data-locked"];
```

`CSS_ALIASES` 只做同名改写：键与值都是字符串，**没有 `null` 语义**。拒绝是另一张表 `REJECTED_PROPERTIES` 的事，它的值是 `{ replacement, reason }`，`replacement` 才允许是 `null`。

`margin` 是 `CSS_ALLOWED` 的正式成员，只接受四值简写；`margin-top` / `margin-right` / `margin-bottom` / `margin-left` 在 `REJECTED_PROPERTIES` 里，各自点名简写写法。理由：把元素挪半个像素是真实需求（pen 的导出用 `margin:-0.5px 0 0 0` 顶焦点环），彻底拒绝会为了半个像素逼出一个 wrapper 元素；而单边写法是同一意图的第二种拼法。

`Spec` 是 `CSS_ALLOWED` 的一项。`kind` 决定这一项怎么检查、怎么归一化，`hint` 是给人看的取值说明。**13 种 kind**：

```js
{ kind: "enum", values: ["flex","block","none"], hint: "flex | block | none" }
{ kind: "keyword-set", values: ["flex-start","center","flex-end","stretch"], hint: "…" }
{ kind: "number", min: 0, max: 1, hint: "…" }
{ kind: "length", hint: "…" }
{ kind: "color", hint: "…" }
{ kind: "flex", hint: "…" }
{ kind: "border", hint: "…" }
{ kind: "shadow", hint: "…" }
{ kind: "outline", hint: "…" }
{ kind: "font-weight", hint: "…" }
{ kind: "line-height", hint: "…" }
{ kind: "image", hint: "…" }
{ kind: "text", hint: "…" }              // 自由文本，例如 font-family
```

字段只有这五个：`kind` 与 `hint` 每一项都有；`values` 只在 `enum` 与 `keyword-set` 上；`min`、`max` 只在 `number` 上且可省。**没有 `unit`、`keyword`、`decimals`**：长度一律写 `px`，关键字写在 `values` 里，小数位数由 §8 统一限制。

直接 `import` 这张表的就是下面这些模块，一个不多（测试不算）：

`lib/fragment.mjs`（片段编译）、`lib/validate.mjs`（校验）、`lib/geometry.mjs`（几何检查：读长度、padding、border 与 gap 的取值语法）、`lib/tokens.mjs`（令牌的名字、组与单位）、`lib/normalize.mjs`（归一化）、`lib/render.mjs`（渲染；画布经它间接读表）、`lib/export-html.mjs`（导出）、`lib/readers/pen.mjs`（pen 导入）、`lib/node/verbs/set.mjs`、`lib/node/verbs/rename.mjs` 与 `lib/node/write-verbs.mjs`（CLI 写入）、`scripts/gen-references.mjs`（生成 `references/` 里的文档）。

**`lib/ops.mjs` 不在这张表里，这是有意的。** 它是每个模块都依赖的引擎，所以宁可自己重写三个 `data-type` 名字也不 import 这张表 —— 表里某个条目被改名时，它仍要能加载。令牌 op 因此只要求名字以 `--` 开头，组别与单位由 `lib/tokens.mjs` 判定（见 §4.4）。

新增一个直接读这张表的模块时，把它的路径写进这一段。

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
| `lib/validate.mjs` | 四层校验 + 对比度（`a11y/low-contrast`） | Lead |
| `lib/normalize.mjs` | 两层归一化 | Lead |
| `lib/tokens.mjs` | 令牌：名字、组、值、寻址、环、`var()` 解析 | Teammate |
| `lib/geometry.mjs` | 几何检查：只报确定的事，算不出的量一律 unknown | Lead |
| `lib/diagnostics.mjs` | 分组、过滤、定位 | Teammate |
| `lib/spans.mjs` | 区间替换与重叠检查 | Teammate |
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
