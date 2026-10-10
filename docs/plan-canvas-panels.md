# 计划：画布改成 pen 式三栏（左图层树 / 中画布 / 右属性表单）

状态：**已实施**（Phase 1→3）。日期：2025-10-10。改动范围：`canvas/`、`test/canvas-tree.test.mjs`、`test/canvas-groups.test.mjs`、`docs/format-v3.md` §7 的消费者清单、`README.md` 与 `SKILL.md` 的画布段落。格式、写路径、服务端未动。

### 实施记录（与原计划的差异，以及浏览器里抓到的问题）

- 计划外多做了两件小事：右栏分组可折叠（`state.folded`），`W/H`、`min-*`、`left/top` 成对属性并排一行。
- 用户后续要求：**默认全部收起**、栏顶加**全展开/全收起**按钮、画布点选后树要展开并选中那个元素。前两条改的是展开模型（见 §4.1），第三条改的是 `select()` 的来源区分。
- 拖动分隔条**一期就做了**（按确认），并且拖动时同样做相机补偿——"改栏宽不移动画面"由此成为一条统一规则，而不是两种行为。
- 真机测试抓到的四个问题，都已修：
  1. `#stage` 是 grid，隐藏的面板会让后面的 item 顺位前移，画布落进 0 宽轨道。修法：五列显式 `grid-column`。
  2. 图层树一开始既按扁平可见列表渲染、又在父节点里递归渲染，子树被重复画了最多 96 遍（3309 行 vs 652 个不同 id）。修法：只从根递归。
  3. ⇧⌘\ 不生效：按住 shift 时 `event.key` 是 `|` 不是 `\`。修法：改判 `event.code === "Backslash"`。
  4. 在叶子行上按方向键会漏到 window，把选中元素挪了 1px —— 真的写进了 `examples/miniprogram.html`（被 `test/pen-reader.test.mjs` 的对拍断言当场抓住）。修法：树声明自己消费的键集合，另外 window 处理器再加一道目标守卫。
- 一轮独立的只读复核（另一个 agent，读代码 + 跑测试，无浏览器）又找出七个真缺陷，全部已修、并在浏览器里逐条复验：
  5. 我加的"目标在树里就 return"守卫挡在所有快捷键分支之前 —— 从树里选过东西之后，Delete、⌘Z、Escape、⌘\ 全都失灵。修法：守卫只留在会写文件的"方向键微移"那一个分支里。
  6. 选中的元素所在的祖先永远折叠不上：每次渲染都 `openPath`，而点 chevron 本身就会触发一次渲染，于是它被立刻重新打开，chevron 成了死控件。修法：只在**选中变化**时开路径（`state.lastSelection`）。
  7. 点画布边上的折叠按钮会把选中清空：按钮在 `#viewport` 里，pointerdown 冒泡成"没点到任何元素 → select(null)"。修法：pointerdown 里先放过 `.viewport-toggle`；空格键也一样，焦点在按钮上时归按钮。
  8. 拖动条把 token 拖没了：scrub 手柄按属性名（`length`）挂，于是 `gap: var(--space-md)`、`width: fit-content`、`padding: 0 0 24px 0` 都带手柄，拖 1px 就写 `1`，值被静默替换。修法：`scrubFor(property, value)` 同时看语法与当前值，另加"按下没移动就什么都不改"的兜底。这条补了单元测试。
  9. 焦点在分隔条上按方向键：面板改了宽，同一按键还漏到画布，把选中元素挪了 1px 并写入文件。修法：分隔条 `stopPropagation`。
  10. 两栏都能拖到半窗宽：两栏相加超过窗口，中间轨道塌成 0，画布和它身上的两个按钮一起消失（还存进 localStorage）。修法：`clampPanel` 按"另一栏 + 画布最小 160px"算上限。
  11. 子级列表的 13px 缩进带属于父行：点在嵌套行左边会选中父级。修法：点击/悬停先解析 `.tree-row`，两行之间的空白不属于任何一行。
- 用户后续要求（第二批）：**默认全部收起**、栏顶加**全展开/全收起**按钮、画布点选后树要展开并选中（都已落地，见 §4.1）；以及**点画布空白处取消选中** —— 这条原来是坏的：空白处的 pointerdown 走的是"平移"分支，pointerup 里没有对应处理，所以点了没反应。修法：平移拖动记一个 `moved`（3px 阈值，和元素拖动同一个），没动过的按下就是一次"点在空处"，等价于 Escape。
- 用户后续要求（第三批）：**拖动/平移画布时蓝框要跟着元素走，且不能把画布上的文字选成一片蓝**。两个都是真 bug：
  - overlay 是 `.canvas` 的**兄弟**节点而不是子节点，它按视口像素定位、不继承相机 transform，所以相机一动就必须重画；滚轮缩放、Fit、reveal、面板收放都重画了，唯独 `pointermove` 的平移分支只调了 `applyCamera()` —— 于是画布滑走、蓝框留在原地标着一个不存在的位置。修法：平移分支补 `drawOverlay()`。
  - 平移的 `pointerdown` 没有 `preventDefault()`，所以这一拖同时是浏览器的**选择文本**手势，蓝蒙蒙一片扫过设计稿里的每行字。修法三层：按下时取消（规范上会连带抑制 mousedown 等兼容事件）；`.panning { user-select: none }` 兜住 chrome；再加一个 `selectstart` 守卫 —— 因为实测 `user-select` **不跨 shadow 边界**（设计稿的文字在 shadow root 里，计算值仍是 `auto`），而这一层是可观测的：拖动中 `selectstart` 被 prevent，不拖动时不干预。
- `test/purity.test.mjs` 顺带补了一处盲区：它只匹配 `"/lib/…"` 写法的导入，而 `canvas/groups.mjs` 用的是相对路径 `../lib/table.mjs` —— 现在按解析后的路径判断，并断言这次扫描确实解析到了这个相对导入（否则检查会空转通过）。

---

## 1. 目标

三条，都可验收：

1. **左栏是一棵可折叠的图层树。** 页面是根，页面下的元素树逐级展开/折叠；选中、悬停与画布双向同步。
2. **右栏是选中元素的属性表单。** 按语义分组，控件由 `lib/table.mjs` 声明的语法决定，所有写入仍走同一个 `commit` 漏斗。
3. **左右两栏都能收起/展开。** 按钮永远可点，状态刷新后保留，且切换栏不写入设计文件的一个字节。

**非目标**（这一版不做，但结构给它留位置）：左侧工具栏（select/frame/text/pen/hand）、评论、组件库、图层拖动重排、多选、标尺与参考线。

**已确认的三个决定**（2025-10-10）：右栏做到"分组重排 + 按语法选控件 + 兜底组"，不含 `+ 添加属性`；面板宽度**一期就带拖动**（见 §4.3）；按 Phase 1→3 顺序实施。

---

## 2. 现状：要改的地方，带坐标

| 位置 | 现在 | 问题 |
|---|---|---|
| `canvas/index.html:34-50` | 左栏两个独立 `<ul>`：`#page-list`（平铺页面）+ `#layer-list`（当前页的平铺行） | 一个层级被拆成两个列表；页面没有子树 |
| `canvas/styles.css:101` | `#stage { grid-template-columns: 240px minmax(0,1fr) 260px }` | 栏宽写死，没有收起状态 |
| `canvas/styles.css:307` | `.drawer { left: 240px; right: 260px }` | 栏宽在第二个地方又写了一遍，收栏后必错位 |
| `canvas/app.mjs:705` `renderChrome()` / `:723` | 每一行按 `depth * 12` 缩进平铺，没有展开状态 | 深树是一整面墙；折叠无从谈起 |
| `canvas/app.mjs:822` `renderInspector()` | 一个扁平的 `Style` 组 + 身份 `<dl>` | 45 个属性堆成一列，没有分组，没有成组控件 |
| `canvas/app.mjs:1452` | `window.addEventListener("resize", () => drawOverlay())` | 收栏不是 window resize，overlay 不会重画 |

**已有的、直接复用的东西**（这决定了这个计划的成本）：

- `lib/render.mjs:663 pageTree(node)` 已经给出深度优先的行：`{ id, type, tag, name, depth, hidden, childCount, text }`。折叠要做的事只是把 `depth` 换成嵌套。
- `lib/table.mjs:204 CSS_ALLOWED` + `specFor(name)` 已经为每个属性声明了 `kind`（enum / keyword-set / length / number / color / text / flex / border / shadow / outline / image / font-weight / line-height）和 `hint`。右栏的编辑器应当由它决定——`buildField()`（`canvas/app.mjs:893`）现在是用正则**猜**值（长得像 `#rrggbb` 就当颜色），这是要被换掉的那一段。
- `canvas/app.mjs:1047 commit(ops)` 是唯一的写路径；新表单只是它的一种输入方式。
- `.overlay` + `drawOverlay()`、`select()` / `reveal()`（`:1020`）、`capturePointer()`（`:1093`）、`attachScrub()`（`:974`）都可直接复用。

---

## 3. 计划之外的硬约束（测试会当场抓住）

`test/purity.test.mjs` 有三条结构断言，任何新 DOM 都要先满足：

1. `:240` — `app.mjs` 里每个 `getElementById("x")` 都必须在 `index.html` 里有 `id="x"`。
2. `:266` — `app.mjs` 拼出的每个 class，要么 `styles.css` 里有规则，要么被某处查询。新的树行/分组 class 必须落进 `styles.css`。
3. `:228` — `index.html` 不许有内联 script，引用的资源必须在 static 白名单里。新增的 `canvas/tree.mjs` 由 `SCANNED_DIRS = ["canvas", "lib", "lib/readers"]`（`lib/node/static.mjs:94`）自动进白名单，不需要改表。

顺序上因此是：**先写 HTML 与 CSS，再写 JS**，一轮就能对齐。

---

## 4. 目标形态

```
┌──────────────────────────────────────────────────────────────────────┐
│ top bar: 文件 · revision · zoom · undo/redo · Problems · Export       │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ Layers        │ [⧉]                          [⧉] │ Overview      [⧉] │
│               │                                  │  data-id: home__… │
│ ▸ Dashboard   │        ┌──────────────┐          │ ── Layout ──      │
│ ▾ Sidebar     │        │              │          │  display  [▾]     │
│   ▸ Content   │        │    page      │          │  gap      [20 ]   │
│     Header    │        │              │          │ ── Size ──        │
│     Metrics   │        │              │          │  W 390  H 844     │
│   List Sect.  │        └──────────────┘          │  ☑ Fill width     │
│   ▸ Banner    │           100%  −  +             │ ── Fill ──        │
└───────────────┴──────────────────────────────────┴───────────────────┘
   --panel-left            1fr                   --panel-right
```

### 4.1 左栏：一棵树，页面是根

- **结构**：`#layer-tree` 一棵 `role="tree"`。页面是 depth 0 的行，元素按 `pageTree()` 的嵌套往下。
- **每行**：`[chevron][类型标记][名称][徽标]`。名称优先级 `data-name` → `data-id` → `(tag)`（沿用 `:734` 的规则）。
- **chevron**：只切换展开，`stopPropagation()`，不改变选中；没有子节点的行留同宽空位以对齐。
- **行点击**：`select(id, { reveal: true })`，与画布 overlay 双向同步；画布上的点选走 `select(id, { expand: true })`——**即使选中的还是同一个元素**也要展开并滚到它（"全部收起"之后再点同一个元素，不然面板看起来像没接住这一下）。
- **行 hover**：`state.hovering = id; drawOverlay()`，沿用 `:741`。
- **展开状态**：三段式 —— 一个"总意图"（`all: "open" | "closed"`）+ 两个例外集合（`expanded` / `collapsed`）。**加载时全部收起**，只有页面名一行行；栏顶两个按钮切换总意图（O(1)，不管文件里有三千行还是三行），chevron 的每一次点击都是例外，例外永远压过总意图，所以"全部收起后单独展开一支"和"全部展开后单独收起一支"都成立。
- **选中项所在路径强制展开**（`openPath` 写的是例外），所以收起状态下从画布点选任何一个元素，树都会展开到它、滚动到它、并高亮它。"选中了但看不见"是树最常见的 bug。
- **滚动与焦点**：选中变化后 `row.scrollIntoView({ block: "nearest" })`（用 `nearest`，否则整页跟着跳）。`renderChrome()` 是全量重建，所以重建前记住"树里有没有焦点"，重建后 `row.focus({ preventScroll: true })` 还回去。
- **键盘**（仅当焦点在树内）：`↑↓` 移动、`→` 展开、`←` 折叠、`Enter` 选中。**必须**让它不冒泡到 window：`canvas/app.mjs:1266` 的全局 keydown 里空格 = 平移模式、方向键 = 移动选中元素 1px/10px，两条都会和树打架。做法是树容器上 `keydown` + `stopPropagation()`，并在 window 处理器开头加一条 `if (event.target.closest?.("#layer-tree")) return;`。
- **顺序**：保持文档顺序，不是 pen 的 z 序。理由：这是 CSS flex 布局，文档顺序就是视觉顺序，也就是导出顺序；z 序是绝对定位世界的直觉，在这里是错的。
- **徽标**：`data-hidden="true"` → `hidden`；库页 → `library`；页面行右侧显示 `W×H`（沿用 `:717`）。
- **大文件**：`examples/miniprogram.html` 是 356KB，树很深。只渲染可见行（`visibleRows`），不做全量 DOM。

### 4.2 右栏：分组属性表单

只在该元素**确实拥有**这一组中的属性时才出现该组。分组是纯展示映射，每一行仍然写 `style:<prop>`，走的还是同一个漏斗。

| 组 | 属性 | 控件 |
|---|---|---|
| Identity | `data-id` / `data-type` / `tag` / `data-name` / `data-hidden` | 只读 dl（`data-name` 可编辑）、可复制 |
| Layout | display, flex-direction, flex-wrap, align-items, justify-content, align-self, flex, flex-shrink, gap | 分段按钮（enum / keyword-set）+ 数值 |
| Position | position, left, top | 分段 + X/Y 成对数值（可 scrub） |
| Size | width, height, min/max-width/height | W/H 成对；`Fill width`（= `100%`）/ `Hug height`（= `fit-content`）复选 |
| Spacing | padding, margin | 4 值成组，沿用 `compressBox` / `expandBox` |
| Appearance | opacity, border-radius, overflow | 数字 + scrub + 分段 |
| Fill | background-color, background-image, background-size, background-position | 色板 + 图片文本 + 分段 |
| Stroke | border, border-width, border-style, border-color, outline, outline-offset | 文本 + 分段 + 色板 |
| Effects | box-shadow, opacity | 文本 + 数字 |
| Text | font-family/size/weight/style, line-height, letter-spacing, color, text-align, text-transform, white-space + 文本内容 | 分段 + 数值 + 色板 + 文本域 |
| Image | object-fit（`img` 元素另加 `alt` / `src` 行） | 分段 + 文本 |

- 编辑器由 `specFor(property).kind` 决定（enum → 分段/select，length → 数值 + 单位 + scrub，color → 色板 + token 提示，…），同时保留现在的"原值行"（`.value-line`）逐字显示原文。
- **兜底组 `Other`**：白名单里将来新增、还没归组的属性落在这里。这是硬要求——表单重构不允许把任何一个属性藏起来，验收里有一条遍历断言盯着它。
- **不要退化 token**：`var(--x)` 现在会被解析出实际值一并显示（`:929` `resolveTokens`），颜色选择器遇到 token 时不覆盖成十六进制（`:920` 已经这么做了），重构必须保住。
- 头部：选中名 + `data-id`。空态与"元素已不在文件里"两句文案（`:828`、`:837`）保留。

### 4.3 收栏

- **CSS**：`:root { --panel-left: 240px; --panel-right: 260px }`；`#stage { grid-template-columns: var(--panel-left) minmax(0,1fr) var(--panel-right) }`；收起时把变量按下去（`.panels-left-hidden { --panel-left: 0 }`）。
- **面板自身**用 `hidden` 属性隐藏，而不是宽度 0——宽度 0 的栏里，里面的控件还能被 Tab 到。
- **按钮位置**：画布区左上、右上各一个常驻按钮（`.viewport-toggle`，28×28），`aria-pressed` 反映状态。收起后按钮仍在原位——这是 pen 的做法，也是唯一"收起后按钮不跟着消失"的布局。`.overlay` 是 `pointer-events: none`（`styles.css:233`），按钮要盖在它上面。
- **快捷键**：`⌘/Ctrl + \` 切左栏，`⇧⌘/Ctrl + \` 切右栏；复用 `:1267` 的 `inField` 守卫，输入框里打字时不触发。
- **拖动改宽（本期做）**：每栏内侧一条 6px 的 `.divider`（`role="separator"`，`aria-orientation="vertical"`）。`pointerdown` → `capturePointer`（复用 `:1093`）→ `pointermove` 里写 `--panel-left/--panel-right`（夹在 `160px … 50vw` 之间）→ `pointerup` 落盘。拖动过程中每一帧都要 `drawOverlay()`：viewport 宽度在变，选中框是屏幕坐标。双击分隔条回到默认宽度。宽度与可见性一起存进同一个 localStorage 键。
- **`.drawer`**（`styles.css:307`）的 `left/right` 改用同一组变量，栏宽从此只有一处定义。
- **相机补偿**：收起左栏后 `.viewport` 的左边缘左移 240px，而 `.canvas` 是 `inset: 0`、transform 原点跟着容器走——画面会整体左跳。做法：切换前记 `viewport.getBoundingClientRect().left`，切换后 `state.camera.x += (newLeft - oldLeft)`，再 `applyCamera(); drawOverlay()`。拖动改宽时**不做**这个补偿：拖动中内容跟着变宽是符合直觉的，跳回去才是 bug。
- **持久化**：`localStorage["skill-design.canvas.panels"] = {"left":true,"right":true}`，只此一项。**树的展开状态不持久化**——id 会随编辑变化，恢复了也是一堆指向不存在节点的状态。读写都套 `try/catch`（隐私模式下 localStorage 会抛）。
- **边界**：面板状态属于 chrome，绝不进设计文件，也绝不发给服务端；切换栏不产生任何 `commit`，文件字节不变（Phase 1 的验收就是这条）。

---

## 5. 改动清单（按文件）

| 文件 | 改动 |
|---|---|
| `canvas/index.html` | 左栏改成 `#panel-left` + `#layer-tree`；右栏 `#panel-right` + `#inspector`；viewport 内加 `#toggle-left` / `#toggle-right`；删掉 `#page-list` / `#layer-list` |
| `canvas/styles.css` | 栏宽变量化；新增 `.tree-row` `.chevron` `.guide` `.group` `.field-grid` `.viewport-toggle` `.badge` 等规则；`.drawer` 跟随变量 |
| `canvas/tree.mjs`（新） | 纯函数，零 import、零 DOM：`nest(rows)` / `defaultExpanded(tree, limit)` / `visibleRows(tree, expanded, collapsed)` / `pathTo(tree, id)` |
| `canvas/app.mjs` | `state.expanded / collapsed / panels`；`renderChrome()` 拆出 `renderLayerTree()`；`togglePanel(side)`；树键盘；相机补偿；`renderInspector()` 改分组渲染，`buildField()` 换成按 `specFor().kind` 选编辑器 |
| `test/canvas-tree.test.mjs`（新） | 嵌套、默认展开、可见行、路径、文档顺序、隐藏徽标、显式折叠优先 |
| `test/purity.test.mjs` | 不改。它本来就该抓住 id / class 漏配 |
| `README.md`、`SKILL.md` | 画布段落里"Pages + Layers 两个列表"的描述更新 |

**`canvas/tree.mjs` 为什么放 `canvas/` 而不是 `lib/`**：展开策略是 chrome 策略，`lib/` 是格式库，不该长出一条只有画布在用的规则。放在 `canvas/` 里，`node:test` 可以直接 `import` 它来测（零依赖），而 `SCANNED_DIRS` 已经包含 `canvas/`，浏览器照样拿得到。

**明确不碰**：`lib/parse.mjs`、`lib/serialize.mjs`、`lib/ops.mjs`、`lib/node/server.mjs`、任何格式与写路径、`docs/format-v3.md`（格式没变）。

---

## 6. 分期与验收

**Phase 1 — 骨架（可独立合入）**
变量化栏宽 + 两条可拖动分隔条 + 两个常驻按钮 + 快捷键 + localStorage（可见性与宽度）+ `.drawer` 跟随 + 相机补偿。
验收：折叠/展开来回 5 次、拖动分隔条若干次，设计文件零字节改动；`npm test` 全绿；1440 与 1024 两个宽度下按钮位置正确、不难看；宽度被夹在最小/最大之间，双击能回到默认。

**Phase 2 — 左栏树**
`canvas/tree.mjs` + 渲染 + chevron + 自动展开与滚动 + hover 同步 + 键盘。
验收：`node --test test/canvas-tree.test.mjs` 绿；在 `examples/miniprogram.html`（大文件）上展开三层，只渲染可见行、不卡。

**Phase 3 — 右栏表单**
分组 + 按 grammar 的编辑器 + 成组控件 + `Other` 兜底。
验收：遍历比对 `CSS_ALLOWED` 与实际渲染出的控件集合，45 个属性一个不少；改一个值 → 走 `commit` → 文件改了、Problems 不新增错误；token 值不被覆盖成十六进制。

**Phase 4 — 可选，暂不做**
`+ 添加属性`（用 `CSS_ALLOWED` 生成选择器、`specFor` 决定控件）、图层拖动重排与重命名、左侧工具栏。

**手工验证的方式**：`node design.mjs serve examples/miniprogram.html` 拿带 token 的 URL，浏览器打开，用 chrome-devtools 截图与点按核对；每一步都在真实文件上做，不看 mock。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 全量重建丢焦点、丢滚动位置 | 重建前记住树内焦点，重建后归还；`scrollIntoView({ block: "nearest" })` |
| 收栏后 overlay / 选中框错位 | 相机补偿 + 显式 `drawOverlay()`；不能只依赖 window 的 resize |
| purity 的三条结构断言 | 先写 HTML 与 CSS 再写 JS，一轮对齐 |
| 键盘冲突（空格=平移、方向键=移动元素） | 树内 `stopPropagation()` + window 处理器里的目标守卫 |
| 大文件深树 | 只渲染可见行；默认展开深度 3 |
| 表单重构把某个属性藏起来 | `Other` 兜底组 + 一条遍历断言 |
| `localStorage` 在隐私模式抛异常 | 读写都套 `try/catch`，失败就退回默认（两栏都开） |

---

## 8. 已确认

1. 右栏一期：分组重排 + 按语法选控件 + 兜底组；`+ 添加属性` 留到 Phase 4。
2. 面板宽度：**一期就带拖动分隔条**，最小 160px，双击回默认。
3. 默认展开深度取 3（Phase 2 落地后可再调）。→ **已改**：用户要求"默认全锁起来"，于是深度上限整个删掉了（`DEFAULT_DEPTH` 不复存在，避免留一个没人用的旋钮），改成上面的"总意图 + 例外"三段式，并在栏顶加了全展开/全收起两个按钮。
