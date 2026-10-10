# v2 整改记录

> **这是一次整改的历史记录，不是契约。** 契约仍是 `docs/format-v3.md`，设计仍是 `docs/plan.md`。
> 这份文档只有一个用途：让一个约 1800 行的 diff 可以被评审 —— 每一项都写出
> **症状 → 证据 → 改法 → 钉住它的测试**，以及**有意没做的事**。

## 0. 结果

```
node --test "test/*.test.mjs"            → 546 通过 / 0 失败（连跑 3 次）
node scripts/gen-references.mjs --check  → 三份 references 全部 ok
```

| | 数量 |
|---|---|
| 已跟踪文件被修改 | 36（+1836 / −350） |
| 新增文件 | 13（约 2860 行，其中 8 个测试文件约 1900 行） |
| 删除文件 | 1（`lib/pointer.mjs`，70 行无人调用） |
| 测试 | 436 → 546 |

零 npm 依赖、纯 ESM、无构建步骤，这三条没被破坏。

**真实文件诊断数**（改动前后必须一致，唯一有意变化见 §3.9）：

| 文件 | 诊断数 |
|---|---|
| `examples/design.html` | 0 |
| `examples/miniprogram.html` | 18 |
| `test/fixtures/real/pen-pages.html` | 65 |
| `test/fixtures/real/open-design-components.html` | 111 → **141** |

## 1. 这一轮在治什么

三类病根，每一类都能在下面找到实例。

1. **文档与代码各说各话，而没有任何测试比对它们。** 契约里 `a11y/` `asset/` 两个前缀发射 0 条码；§7 点名两个不存在的导出；SKILL.md 教模型躲开一个合法属性；`references/schema.md` 把一个规则写成 must 而代码从不检查。**没有一个缺陷让测试变红**，因为没有测试读文档。
2. **同一件事有两份实现，然后分叉。** `diagnosticKey` 两份（字段还不一样）、令牌解析两份（一份有深度上限、一份没有 —— 这就是 §3.9 那次崩溃）、回执格式化三份、CSS 声明切分两份（这一对**是有意的**，见 §6）。分叉的那一份总是更晚写的那一份。
3. **"声明过的能力"与"实现的能力"之间的账没人对。** pen 写出器、`--id`、五个 export 旗标、`--raster canvas`、`doc.dirty`、10 个模块名 —— 都写在过设计稿里，都没有写出来。

## 2. 怎么读这份 diff

按兴趣挑：

- **想先看最有价值的三处**：§3.9（令牌寻址）、§3.10（契约测试）、§3.13（纯度边界）。
- **想验证我的判断**：§4（我改错的三处订正）与 §5（验证方法，含变异测试纪律）。
- **想知道什么没做**：§6。
- **按文件看**：§7 有一张"改动 → 文件"的索引。

---

## 3. 逐项

### 3.1 【P0-16】图标无法通过文档路径添加

**症状**：`add` 一个带 `<svg data-type="icon">` 的片段，被拒；理由说缺 `viewBox`。

**证据**：`viewBox` 不在 `ATTR_BY_TYPE.icon` 的 `required` 里 → 片段编译器按格式表过滤属性时把它**丢掉**；校验器再看编译结果，以"缺 viewBox"报错。于是**文档里写对的东西，经过工具就变错**。

**改法**：`ATTR_BY_TYPE.icon` 增加 `viewbox`（小写 —— 解析器用小写名查表）与 `data-fill`。写回文件时用 `attr.rawName` 保留作者拼写，因为 `export --format svg` 产出真 XML，`viewbox` 不是 `viewBox`，字形会丢坐标系。生成器补 `viewBox` 行与属性漂移守卫。

**测试**：`test/icon-fragment.test.mjs`（5 条）。

**文件**：`lib/table.mjs`、`lib/fragment.mjs`、`scripts/gen-references.mjs`、`references/schema.md`。

### 3.2 【A4】生成物里的 "undefined glyphs"

**症状**：`references/schema.md` 的字形表里出现 "undefined glyphs"。

**证据**：生成器对**对象**取 `.length`（`ICONS.length`）→ `undefined`；而 `--check` 通过，因为生成器与产物**一致地错**。这是"生成式一致性检查"的经典盲区：它证明的是"产物等于生成器输出"，不是"产物是对的"。

**改法**：`iconNames().length`；生成器加空洞守卫（`undefined` / `NaN` / `[object Object]` 出现即退出非零）。

**测试**：`test/references.test.mjs`（+2 条）。

### 3.3 【A1】SKILL.md 教模型躲开一个合法属性

**症状**：SKILL.md 三处告诉模型不要用 `margin`；属性数写 40。

**证据**：`margin` 是 `CSS_ALLOWED` 的正式成员（pen 的导出用 `margin:-0.5px 0 0 0` 顶焦点环），只有四个单边属性在 `REJECTED_PROPERTIES`；`CSS_ORDER.length` 是 45。**代码是对的，文档是错的。**

**改法**：三处措辞改正；40 → 45。

**测试**：`test/skill-doc.test.mjs`（4 条，钉住 SKILL.md 的关键数字与说法）。

### 3.4 【A2】契约 §7 与事实不符

**证据**：§7 点名 2 个 `table.mjs` 不存在的导出；`CSS_ALIASES` 少写 2 个键；`Spec` 的 `kind` 文档写 6 种、实际 13 种；消费者写 4 个、实际 9 个。

**改法**：按 `lib/table.mjs` 的实际导出与消费关系重写这一段。

**测试**：`test/contract.test.mjs` 的两条（§7 的导出名必须在表里；§7 的消费者清单必须等于真正 import 表的模块集合）。

### 3.5 【B3】`diagnosticKey` 有两份实现

**证据**：两份实现两套字段；做"只在新错误时拒绝"差集的那一份不符合契约。

**改法**：唯一实现在 `lib/diagnostics.mjs`，键为 `code|offset|target|message` 四段；`lib/validate.mjs` 导入并再导出（`server.mjs` 是从那里取用的）。

**一处诚实的降级**：这个分叉**不可达** —— 实测 331 条真实诊断里 0 条受影响。所以它是**契约不准确**，不是活的 bug。我把它按契约准确性问题处理，没有夸大。

**测试**：`test/diagnostics.test.mjs`（+2 条）。

### 3.6 【C3】`a11y/` 与 `asset/` 发射 0 条

**症状**：契约的诊断前缀表里有这两个前缀，代码里一条都不发射。

**改法**：`lib/validate.mjs` 增加 `REQUIRED_CODE = {"image:alt": "a11y/missing-alt", "image:src": "asset/missing-src"}`，缺必填属性时按类型选码；契约 §6 同步。**光有名字是这个缺陷当时唯一缺的东西。**

**测试**：`test/validate.test.mjs`、`test/write-funnel.test.mjs`、`test/serve.test.mjs` 的相应断言。

### 3.7 【B2】`migrate` 不存在，而报错叫用户去跑它

**症状**：`version/unsupported` 的 hint 写"Run migrate"，而 `migrate` 不是动词。

**改法**：新增 `lib/node/verbs/migrate.mjs`。

**一处实现选择**：它走 **span 编辑**（`applyEdits`），不走 op —— 因为 `ops/insert` 寻址不到 `<meta>`（`resolveAddress` 只认 `data-id` 与四个保留容器词）。无操作路径不调用 `writeAtomic`，所以字节、mtime、inode 都不动：重复迁移必须是免费的。

**测试**：`test/migrate.test.mjs`（9 条）。

### 3.8 【B1】`rename` 不存在

**症状**：改名要走 `set --attr data-id=…`，没有级联。

**证据**：真正缺的不是"能改 id"，而是**两条级联**：组件的 `data-ref`，以及实例 `data-overrides` 的键。

**改法**：新增 `lib/node/verbs/rename.mjs`（`data-ref` 级联 → `data-overrides` 键级联 → 最后才是 `set data-id`）；`set --attr data-id=…` 改为拒绝并指向 `rename`。

**实测**（真实文件 `examples/miniprogram.html`，351,325 字节，23 组件 / 239 实例 / 140 覆盖）：

| 改谁 | 改动处数 | 字节差 | 新增错误 |
|---|---|---|---|
| 组件根 `x2cjUg` → `z2cjUg` | 66 | **0** | 0 |
| 组件内后代 `j4DoG1` → `j4DoG1X` | 36 | +36 | 0 |

**测试**：`test/rename.test.mjs`（9 条）。

### 3.9 【B4】令牌寻址 —— v2 相对 v1 唯一的功能倒退

**症状**：改一个品牌色要**重写整个文件**，撞上 SKILL.md 第一条规则（"写它，不要重写它"）。v1 的文档是 JSON，`/tokens/color/bg` 一条 op 可寻址；v2 的令牌块是 `<style>` 里的一段文本、不是元素、没有 `data-id`。

**改法**：新增 `lib/tokens.mjs`（名字、七组闭集、值、寻址、环检测）；`lib/ops.mjs` 增加 `set-token` / `unset-token` 两种 op；新增动词 `tokens <file> ls | set | rm`；契约 §4.4 落笔。

**落地时发现四件事**（都不在原计划里）：

1. **循环令牌让 `export` 崩溃，而 `validate` 说文件合法。** 实测一份 `--color-accent:var(--color-ink)` / `--color-ink:var(--color-accent)` 的文件：`validate` 报 `0 errors, 0 warnings — valid`，`export --resolve-tokens` 的整条报告是 `REFUSED Maximum call stack size exceeded` —— 没有行号、没有名字、没有 hint。原因：`lib/render.mjs` 的解析器有深度 16 上限，`lib/export-html.mjs` **自己那份副本没有**。契约 §4.2 早就写着"循环被拒绝"，所以是**代码错了，不是文档该降级**。修法：实现 `style/token-cycle`（error），删掉重复副本改用唯一那份，并给它一条 `seen` 链集合 —— `export` 必须能读一份有错误的文件（否则没人看得到哪里错），所以解析器不能假设校验器跑过。
2. **组名闭集从来没被检查过。** 校验器只查形状 `--[a-z]+-[A-Za-z0-9_-]+`，于是 `--accent-500` 判 valid，而 `tokens set accent.500` 被拒 —— 文件说没问题，它的令牌却改不了。`references/schema.md`（生成给模型看的那份）写的是组名 must be one of the seven。更能说明问题的是：`test/validate.test.mjs` 有一条测试**名字**就叫 "a token name outside the seven groups is reported"，而它用的样本 `--brand` 恰好也破坏形状，所以一直靠另一半通过。
3. **每条令牌诊断的 `offset` 都是 `undefined`。** `parseDeclarations` 只给 `textStart`/`textEnd`（相对 `:root{}` 内片、含两侧空白），而 `collectTokens` 读的 `decl.start` 从来不存在 —— 一条指不出位置的告警。
4. **`duplicate-token` 的提示"最后一个生效"与契约 §4.1 相反**（§4.1 说两块都收集、禁止后覆盖前）。措辞已改，且 `set`/`rm` 遇到同名跨块声明会**拒绝**：写第一个而第二个仍生效，是静默错答案。

**两条实现约束**（下游别改掉）：

- **`lib/ops.mjs` 仍然不依赖 `lib/table.mjs`。** 那是它写明的设计：它是所有模块都依赖的引擎，表里某个条目被改名时它仍要能加载。令牌 op 因此只要求名字以 `--` 开头，组别与单位交给 `lib/tokens.mjs`；新增的 import 只有零依赖的 `lib/parse.mjs`。
- **令牌 op 的逆 op 携带确切字节**（`set-token`：`at` + `restore`；`unset-token`：`at` + `span`）。令牌块的排版是文件的字节（`--a:1; --b:2` 与 `--a:1;\n  --b:2` 都合法），而"撤销一次增删"如果重新排版它删掉的那道缝，就把字节忠实的文件变成几乎忠实的。实测 **8 种 `:root{}` 排版**（单行/多行 × 有无尾随 `;` × 空/仅空白/单令牌）双方向全部字节精确。`unset-token` 带 `span` 时先核对那段字节还在原处，不在就报 `ops/stale-inverse`，而不是切掉碰巧在那个偏移上的东西。

**一处基线变化（有意）**：`open-design-components.html` 111 → 141。+30 全是 `style/token-name`，其余编码一条未动 —— 那是第 2 条修复在报一份 pen 导出的外来令牌名。这四个 fixture **没有任何测试引用**，是人工回归标尺。

**测试**：`test/tokens.test.mjs`（21 条）、`test/ops.test.mjs`（+9 条 op 往返）。

### 3.10 【C1】契约一致性测试

**症状**：文档与代码之间没有任何测试比对，于是文档可以一直承诺不存在的东西。

**改法**：`test/contract.test.mjs`，7 条检查，**全部从源码推导事实，不再抄第二份清单**：

1. 反向：扫描根里出现的命令名必须是 `VERBS` 的键（三种形状：`design.mjs <tok>`、带反引号的 `design <tok>`、"Use/Run/Call `<tok>`"）。
2. 正向：每个 verb 有模块、导出非空 `USAGE`、有可运行的默认导出，且 SKILL.md 含该动词。
3. 惰性分发：每个 verb 都是 `() => import(...)`，这样 `--help` 在模块存在之前就能用。
4. 契约点名的 `lib/*.mjs` 路径必须存在。
5. §7 的导出名必须在表里。
6. §7 的消费者清单必须**等于**真正 import 表的模块集合（取"一个不多"那句之后的段落 —— 解释 `ops.mjs` 为何不在清单里的那句话也提到模块路径）。
7. §6 表格里每个 `prefix/` 在 `lib/` 里至少有一个带引号的码字面量。

**顺手抓到的**：§7 的消费者清单漏了 `lib/node/verbs/rename.mjs`（B1 造的）与 `lib/tokens.mjs`（B4 造的）—— 而契约自己规定"新增一个直接读这张表的模块时，把它的路径写进这一段"。**检查建好的当天就抓到了我自己留下的腐烂。**

**测试**：`test/contract.test.mjs`（7 条）。**七条检查逐一做过变异测试**，全部按预期变红：文档点名一个非动词、`SKILL.md` 删光某个动词的全部出现、某个动词不再是惰性 import、契约指向一个不存在的模块、§7 的导出名拼错、§7 漏列一个真实消费者、§6 的表行换成死前缀。

（做这轮复核时抓到两处**我自己的变异写错了**：一次只删掉 SKILL.md 四处出现中的一处，另一次把动词本身从表里删了 —— 两次都"没变红"，而检查其实是对的。变异测试也要评审。）

### 3.11 【A3】evals 的散文描述了一个不存在的实现

**症状**：`evals/evals.json` 的断言说 `margin:0` 会被拒、`display:grid` 报 `style/bad-value`、`<label data-type="text">` 报 `structure/unsupported-tag`、被丢掉的属性会"出现在 style/ 诊断或 normalized 列表里"。

**证据**：`evals/grade.mjs` **从不读 `assertions`**，所以这些从来没人管。实测后：`margin` 是合法成员并被写进文件；真码分别是 `style/bad-enum`、`structure/type-tag-mismatch`；丢掉的属性进的是 `dropped`（第三种东西）。

**改法**：36 处散文改成实测事实，并加**五条散文一致性检查**（在 `test/evals.test.mjs` 里，与回执门禁共用同一个漏斗）：

1. evals 里点名的每个诊断码都必须是 `lib/` 真能发射的字面量。
2. 正面声称的码必须就是实际发射的那个（子句里带否定的跳过）。
3. **被拒绝的片段不能被写成"编译过了"** —— 这条一次抓到 13 处。
4. 回执里丢掉的每个属性，散文必须提到。
5. 散文说"被拒/被丢"的属性，必须在回执的 `dropped` 里（`refused` 阶段跳过 —— 那时没有 drop 列表可比）。

**三个主要事实错误**：`margin` 被说成"因为 `CSS_ALIASES` pins `margin: null` 而被拒"（`CSS_ALIASES` 只有三个键、没有 null 语义）；属性数说 40（实际 45）；说"四个 `background` 简写"（s12 只有三片 chip，且 `rgba(17,17,17,.06)` 归一到 `#1111110f` 八位十六进制）。

### 3.12 【C2】evals 变成真门禁

**改法**：20 个 eval 各加 `expect` 块，`test/evals.test.mjs` 按**精确多重集**比较（投影成 `code@target`、`target|prop|value`、`target|prop|from|to`，忽略措辞 —— 身份是契约，措辞不是）。失败同时报 `missing` 与 `extra`：子集判断会放过"11 条 dropped 缩水成 3 条"这类腐烂。

**一处我自己写错又改对的**：第一版只分"拒绝 / 接受"两态，把"编译成功但写入漏斗拒绝"的那一类的编译产物丢掉了 —— 于是 eval 10 与 16 看起来"什么都没丢"，而它们其实丢了 `object-fit`、`border-top`、`cursor`。**阶段是三态**：`refused`（编译器拒绝）/ `blocked`（漏斗拒绝）/ `accepted`。20 个里 8 / 2 / 10。

**重生成方式**：`SD_EVAL_DUMP=1 node --test test/evals.test.mjs` 打印实测事实，粘回去是改期望的唯一支持方式 —— 手写期望正是散文腐烂的来路。

### 3.13 【D1】纯度边界

**症状**：`lib/export-svg.mjs` 在函数里 `await import("node:fs")`；`lib/raster.mjs` 顶层 `import { existsSync } from "node:fs"` 并把 `platform` 默认成 `process.platform`。

**为什么这是缺陷而不是风格**：每个直接位于 `lib/` 下的文件都会被提供给画布（`buildRoutes` 浅扫 `lib/`）。所以一个 import `node:fs` 的模块，是浏览器下载下来就会死的模块 —— 而失败现象是**空白的画布**，不是测试失败。

**改法**：
- `lib/export-svg.mjs` **按纯度拆**，不是整文件挪：纯符号留下，`exportFile` 与 slug 进新建 `lib/node/export-svg.mjs`。顺带把尺寸策略抽成纯函数 `renderSize(page, sizeOption)`，这样"一页按多大渲染"不再由写文件的那一半决定。
- `lib/raster.mjs` 的三个环境事实改成**参数**，且**没有默认值**（默认值必然要伸手够 `node:fs`/`process`）；缺了抛 `raster/no-environment` 并给 hint。`lib/node/raster-run.mjs` 成为全树唯一回答"这台机器是什么样"的地方。

**三条检查在写的过程中被变异测试证明是假的**（详见 §5）：

- 我的净化器把字符串内容也剥掉了，于是 `"node:fs"` 变成 `""` —— 查找 node: 导入的检查**永远匹配不到**。
- `serialize(parse(text), text) === text` **恒真**（无编辑时序列化器按设计返回原文），所以"examples 是规范的"永远不会失败。改用 `lib/normalize.mjs` 的 `isCanonical`。
- "canvas 建的每个 class 都要有 CSS 规则"对 v2 太严：`page-host` 的尺寸由页面自己声明，样式内联，class 只是查询锚点。改成"要么有规则，要么是有人查询的锚点"。

**测试**：`test/purity.test.mjs`（10 条，含"examples 已是规范形式"）。

### 3.14 【D2】死代码

**改法**：
- **删 `lib/pointer.mjs` 整文件**（70 行 RFC 6901，生产代码零引用）。不能只摘白名单：`buildRoutes` 浅扫 `lib/`，会把它扫回来。连带清 4 处引用。
- **canvas 两处死状态**：`state.mode`（全文件没有读取点 —— `state.model` 才是被用的那个）与每个 box 的 `statements`（`box.*` 真正被读的只有 8 个位置字段）。
- **白名单棘轮**：`STATIC_ROUTES` 承诺"文件在"，新的 `PLACEHOLDER_ROUTES` 承诺"文件不在"，**两个方向都检查**。原来那条测试容忍缺失文件，于是"模块落地了"和"模块被改名了"从测试里看是同一件事。

**一处对我自己笔记的订正**：`formatReceipt` **不是死代码** —— `test/ops.test.mjs` 与 `test/fragment.test.mjs` 有 9 处在用它，它是被测试钉住的那份人读回执。真正的重复是 `add.mjs` 手写了一份**输出不同**的格式，而 SKILL.md 印的是那一版。收拢它会改产品输出，属于产品决策 —— 见 §6。

### 3.15 【D3】画布导出

**改法**：
- 服务端 `POST /api/export`，body `{page?, all?, resolveTokens?}`；两个渲染函数走 `deps` 加载，与其它 `lib/` 模块同一条路径（于是"被改名"报成 `CliError` 而不是半路崩掉一个请求）。
- **画布与命令行导出同一份字节**，有测试直接比：服务调用的是 `design.mjs export` 调的那两个函数。交付物是这个工具存在的理由，两扇门必须通向同一个房间。
- 文件名一律 `<pageId>.export.html`。**理由是 v2 特有的**：这个格式的设计文件本身就是 `.html`，`home.html` 放在 `design.html` 旁边是歧义的（可能是 `home` 页的交付物，也可能是另一个设计），而"人会这么起名"正是歧义产生的方式。
- 唯一被明确拒绝的目标是**设计文件本身**（`export/would-overwrite-design`）：页面 id 与文件名对上时导出会覆盖设计稿，而设计稿是意图的唯一副本。
- 画布：`Export` / `Export all` 两个按钮，只读时禁用；拒绝时**有 diagnostics 就开问题抽屉**，不是裸 toast。
- **接通 `/api/save`**：这是服务端从存在起就有、而没有任何客户端调用的端点。文件不解析时抽屉里出现 `Fix text…`，把原文读进等宽的 `<textarea>`，`Save and reload` 带 `baseRevision` 提交；服务端答 `rebased` 时明确告诉用户"保存了，但你打字期间文件变过"。

**一条澄清**：交接里担心的"递归 watcher 会误发 `changed`"其实由 basename 过滤覆盖（`server.mjs` 里 `event.filename === base`）。命名之所以仍然重要，是歧义与"覆盖设计稿"这两件事。

**测试**：`test/serve.test.mjs`（+6 条，覆盖 401 / 403 / 405 / 413 / 415 / 409 各条拒绝路径，以及"与命令行同字节"）。

### 3.16 【E1】契约修订

一律**划掉或降级，不实现**：

- `format-v3.md` §5.1 的 `serialize(doc)` / `doc.dirty` **两份都不对**：真签名是 `serialize(origin, next)`，"改没改"由解析时的 `_raw` 快照逐节点比对回答。**没有标志位** —— 一个需要调用方自觉置位的标志位，第一个忘记置位的调用方就会让编辑静默丢失。
- §6 的"未实现"清单原来点名了一个不存在的模块，占着"谁拥有什么"的表。
- `plan.md` 的 `export` 旗标行改成**实现的全部**，并逐条写明 `--id`、`--format pen`、`--raster canvas`、`--background`、`--padding`、`--inline-assets`、`--report` 都写在过设计稿里、都没有写出来。
- §3.2 能力表：`pen` 的"写"从"是"改成"**否**"。
- §4.1 删掉 `data-kind` 的 `line`。
- §6.1 的模块树**按实际重写**：设计稿点名的 9 个模块从未存在，其中两个被替代（`format.mjs` → `table.mjs`，`export.mjs` → `export-html.mjs`，`browser.mjs` → `raster-run.mjs`），**没被替代的只有两个**：pen 写出器与几何检查。

**验收**：C1 的契约测试全绿，包括那条唯一的 `PENDING` 红灯消失后**把 `PENDING` 常量本身删掉** —— 留一个空的，就是给下一个豁免留了个位置。

### 3.17 【计划外】`walkWatch` 测试的竞态

**症状**：`test/cli.test.mjs` 的 `walkWatch` 测试约 1/10 概率失败（`expected at least one watch event`）。

**证据**：固定 `setTimeout(400)` 对 macOS FSEvents 的投递延迟 + 100ms 去抖太紧；我新增的 23 个测试增加了负载。**测试与 `lib/node/fs.mjs` 都没被我改过 —— 是既有竞态。**

**改法**：写同一个文件名直到观测到事件，5 秒上限。之后连跑 8 次全套无失败。

### 3.18 【计划外】`add` 的 JSON 拒绝载荷缺 `refused` 块

**症状**：`add` 一个带 `<label data-type="text">` 的片段，人读输出是 `REFUSED …` + `was not changed.`，退出码 1；而同一件事加 `--json`，载荷是 `{ok:false, applied:[], changed:false}` —— **没有 code、没有 message、没有 hint**。

**证据**：JSON 消费者分不清"因为类型与标签不符被拒"和"这次编辑恰好没改变什么"，而两者不是同一个答案。`lib/receipt.mjs` 的 R2 与契约 §6 都写着失败要带这个块。人读分支读的是另一份对象，所以同一份结果的两种读者互相矛盾。

**改法**：`refuse()` 改用共享的 `refusedReceipt()`；`refusedReceipt` 顺带透传 `suggestion`。**测试**：`test/verbs.test.mjs`（+2 条）。

---

## 4. 我改错的三处（对我自己判断的订正）

评审时值得看这几条，因为它们说明前面的结论是怎么收敛的。

1. **"`margin` 污染北极星指标"是错的。** `evals/grade.mjs` 的 `judge()` 从不读 `assertions`，所以那些陈旧断言**不是机器门禁**。
2. **"没有 `rename` 就没法改 id"是错的。** `set --attr data-id=…` 一直可用（带护栏）。真正缺的是两条级联。
3. **"`diagnosticKey` 分叉是活的 bug"要降级成"契约不准确"。** 实测 331 条真实诊断里 0 条受影响。
4. 另有两处：
   - **组件环检测一直存在**（`validate.mjs` 的 `component/cycle`），只有令牌环没检测。
   - **`margin` 的四条断言里只有三条是坏的**（eval 17 通过，因为 `margin-left` 确实被拒）。

---

## 5. 验证方法

```sh
node --test "test/*.test.mjs"             # 546 通过
node scripts/gen-references.mjs --check   # 三份 references
node design.mjs validate examples/design.html
```

**真实文件回归**：对 §0 那张表逐个 `validate --json` 数诊断条数。这四个 fixture 没有任何测试引用，是人工标尺。

**变异测试纪律。** 一个新写的检查，如果没人证明过它会失败，就不知道它是不是恒真的。这一轮对**契约测试、纯度测试、白名单棘轮**都做了：改坏一处代码（或文档），确认对应检查变红，再还原。它抓出了三条恒真的假检查（§3.13），其中两条是我刚写的。

**先红后绿。** C1 引入过一个 `PENDING` 常量冻结"已知会红"的检查：它按**检查名分组**（扁平清单会让通过的检查指控别人的待办过期），判断是**双向相等**（多出来的失败要报，修好却留着行也要报），键必须是真实的检查名，且不允许空清单。最后一条落定后，常量本身被删掉。

---

## 6. 有意没做的事

| 不做 | 为什么 |
|---|---|
| pen 写出器 | 它是设计里确实还没做的两件事之一。E1 把它标注出来，没有实现。 |
| 几何检查（`geometry/`） | 同上。画布已经能测量，把实测结果接回诊断是独立的一项工作。 |
| `--id` 节点级导出、`--inline-assets`、`--background`、`--padding`、`--report`（export 侧） | 契约已按实际划掉。 |
| `--raster canvas` 接线 | 原理留着并标注"未接线"——它是无浏览器机器上唯一的出路。 |
| 统一 `formatReceipt` 与 `add` 的回执格式 | **这是产品决策，不是死代码清理**：两者输出不同且都被测试钉住，SKILL.md 印的是 `add` 那一版。合一会改产品输出。 |
| 两份 CSS 声明切分器合一（`parse.mjs` 的 `parseDeclarations` 与 `ops.mjs` 的 `parseStyleDeclarations`） | 它们的语义**有意不同**：`ops.mjs` 那份额外带**值的确切字节区间**（`valueStart`/`valueEnd`），令牌 op 靠它做字节精确的替换；而契约 §4.2 固定了 `parse.mjs` 那份的形状（`textStart`/`textEnd`，含两侧空白）。合并要么改契约 §4.2 的形状，要么让 op 引擎丢掉它需要的区间。 |
| 令牌环的 CSS 后备值语义 | `var(--a, #f00)` 指向一个环成员时，CSS 会把它当"保证无效"并用后备值。实现它要在环里走一圈给每个成员分类；而校验器本来就拒绝环，解析器的职责只是**不崩**。已在测试里钉住这个选择。 |

---

## 7. 改动索引

| 关注点 | 文件 |
|---|---|
| 格式表、图标属性 | `lib/table.mjs` |
| 片段编译 | `lib/fragment.mjs` |
| 令牌 | `lib/tokens.mjs`（新）、`lib/node/verbs/tokens.mjs`（新） |
| op 引擎、令牌 op | `lib/ops.mjs` |
| 解析（`:root` 声明坐标） | `lib/parse.mjs` |
| 校验、令牌收集与环 | `lib/validate.mjs` |
| 令牌解析（深度与环） | `lib/render.mjs` |
| 诊断键 | `lib/diagnostics.mjs` |
| 生成器与产物 | `scripts/gen-references.mjs`、`references/schema.md` |
| 写入漏斗、回执形状 | `lib/node/write-verbs.mjs` |
| 动词 | `design.mjs`、`lib/node/verbs/*.mjs` |
| 画布导出、`/api/save` | `lib/node/server.mjs`、`lib/node/static.mjs`、`canvas/` |
| 纯度拆分 | `lib/export-svg.mjs`、`lib/node/export-svg.mjs`（新）、`lib/raster.mjs`、`lib/node/raster-run.mjs` |
| 契约与设计 | `docs/format-v3.md`、`docs/plan.md`、`SKILL.md`、`README.md` |
| evals | `evals/evals.json` |
| 新测试 | `test/contract.test.mjs`、`test/purity.test.mjs`、`test/evals.test.mjs`、`test/tokens.test.mjs`、`test/rename.test.mjs`、`test/migrate.test.mjs`、`test/icon-fragment.test.mjs`、`test/skill-doc.test.mjs` |
