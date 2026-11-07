# 它是怎么工作的

README 讲这是什么、给谁用。这篇文档是工程视角：设计文件是什么、CLI 对它做了什么、画布如何改同一个文件，以及工具故意不做什么。

英文原文：[docs/how-it-works.md](../how-it-works.md)

## 为什么设计文件是 HTML

模型本来就很会写 HTML 和 CSS。让它去写一套私有的 JSON 文档，等于把注意力花在一个还得先学的格式上；而且每个这样的文件都得先有渲染器，别人才看得到设计。

所以设计文件就是标记本身。它是一张合法、自包含的 HTML 文件：用浏览器打开，设计就在那里。这个工具加上的不是一种格式，而是四个保证：

| 保证 | 意味着什么 |
|---|---|
| 它会被检查 | 每个元素、每条声明，要么被接受，要么被报告。不会有东西被静默丢弃。 |
| 它可以被编辑 | 每个元素都有 `data-id`，所以一次编辑就是一个字节区间，而不是重写。 |
| 它是规范形式 | 同一个意图只有一种写法。diff 保持可读，往返保持精确。 |
| 它是诚实的 | 没人编辑过的文件，会一个字节不变地回来。你自己的格式、你的注释、你手写的 `<svg>`，都还留在你放的地方。 |

检查命令和画布是同一个文件的两种视图：

```
design.html  ──validate──▶  diagnostics       (what is wrong, and what to write instead)
     ▲          format   ──▶  canonical text    (one intent, one spelling)
     │          export   ──▶  a deliverable      (one page, or a whole site)
     │
     └──── canvas ◀── add / set / remove / move / rename
```

## 一屏看懂格式

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Landing</title>
  <meta name="design-schema" content="3.0">
  <style>:root{ --color-ink:#111827; --space-md:16px }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;padding:24px">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)">你好</p>
    </div>
  </section>
</body>
</html>
```

`<head>` 里只允许两个 `<style>` 块，而且两个都会读取：token 块（`:root`）和页面框架块。除此之外，每个元素都带内联 `style`。每个元素都带 `data-id` 和 `data-type`。

延伸阅读：

- `docs/format-v3.md` —— 冻结的契约：元素模型、规范形式、诊断码、模块边界。
- `references/styling.md` —— 允许的属性和它们的取值语法。
- `references/schema.md` —— 元素契约，由格式表生成。
- `references/images.md` —— 经过校验的 Unsplash 图片，用户没有提供图片时可以使用；每张都写明拍的是什么、谁拍的。
- `references/product-flow.md` —— 从想法到代码的分阶段剧本，agent 按它推进。
- `SKILL.md` —— agent 每次被触发时读的指令。

## 命令

```sh
node design.mjs new      design.html --name home --title Landing
node design.mjs validate design.html --json
node design.mjs format   design.html --check
node design.mjs ls       design.html --pages
node design.mjs show     design.html home__title
node design.mjs add      design.html --html-file card.html --in home__root
node design.mjs set      design.html home__title --style 'font-size:40px'
node design.mjs move     design.html home__card --index 0
node design.mjs rename   design.html home__card product
node design.mjs migrate  design.html
node design.mjs remove   design.html home__note
node design.mjs export   design.html --all -o dist
node design.mjs import   pen some.pen -o design.html
node design.mjs serve    design.html
```

`serve` 会打印一个带 token 的 URL，并打开画布。画布和 CLI 走同一个写入漏斗，所以拖拽和 `set` 不可能互相矛盾。

退出码：`0` 成功，`1` 被拒绝或无效，`2` 文件不可读或参数错误。

## 画布

画布分三列：左边是图层树——每一页和它下面嵌套的元素，默认收起，表头有全部展开和全部收起，在画布上点中一个元素会展开到它的路径；中间是设计本身；右边是选中元素自己的属性，按分区组织，用该属性的语法所要求的控件来编辑。

悬停时会显示指针所在的容器（实线）和该容器的直接子元素（虚线）——单击选中这个容器，双击进入指针下的虚线框（深一层），Escape 往回退一层。每一页左上角都有一个胶囊形状的页名，页名属于界面外壳而不是画面内容：它在任何缩放下都保持自己的字号和那几像素的留白，所以 10% 和 100% 看起来一样。

任一侧都能用画布边缘的按钮或 `⌘\`（图层树）、`⇧⌘\`（检查器）折叠，边缘也可以拖动改宽度。这些都不是文档状态：面板只把状态记在浏览器里，从不往设计文件写一个字节。

## 写入漏斗

每一次写入都走同一条路径，无论来自命令还是画布：

1. 重新读取文件——可能有另一个写入者改过它
2. 先校验它，这样已有的错误不会被算到这次编辑头上
3. 把改动编译成 ops
4. 应用 ops
5. 再校验一次；除非这次编辑**没有引入任何新错误**，否则拒绝
6. 只规范化被改动的节点，然后原子写入
7. 打印回执

第 5 步让坏文件变得可修。文件可以本来就有错误；一次编辑可以修掉它们；但一次编辑不能再加上一个错误。

## 回执

模型看不到文件，所以回执就是它拥有的全部。每条声明要么被消费，要么被报告：

```
$ node design.mjs add design.html --html-file card.html --in home__root
added:      home__cta, home__cta-label  (2 elements)
normalized: #fff → #ffffff
normalized: 12px 12px 12px 12px → 12px
normalized: rgba(0,0,0,0.6) → #00000099
dropped:    cursor:pointer — The format describes appearance, not interaction. A cursor is behavior.
applied 1 op, revision a161db2c (0 errors, 0 warnings)
```

拒绝是一个结果，不是失败，而且它会告诉你该写什么：

```
REFUSED  display: grid is not a value of display.
  Accepted: flex | block | none
design.html was not changed.
```

## 范围

这不是一个通用的 HTML 和 CSS 工具。它支持一个封闭集合：flexbox 布局、绝对定位、固定的属性白名单、图片、内联 SVG 图标，以及每个文本元素一段文字。没有 grid，没有 `position:fixed`，除了旋转没有别的 transform，没有动画，没有响应式断点，没有富文本。

原因在 `docs/plan.md`，每个允许属性的取值语法在 `references/styling.md`。收窄的代价是真实的：有些页面用这个格式画不出来，诚实的答案是换一个工具。

## 从 checkout 安装 skill

README 里用 skills CLI 安装。如果你更想把 checkout 本身当成 skill，用安装脚本把它链进去：

```sh
git clone https://github.com/justskill-ai/justskill-design.git ~/Developer/justskill-design
node ~/Developer/justskill-design/scripts/install.mjs
```

仓库就是 skill，所以这次安装就是一条 symlink，指向 agent 本来就会读取的 skills 目录。它把 checkout 链接到 `~/.agents/skills/justskill-design` 和 `~/.claude/skills/justskill-design`，所以任何读取这些目录的 agent（包括 Claude Code）都能拿到它；改 checkout 就是更新。`--uninstall` 删除两条链接，`--dry-run` 打印它准备做什么。

## 运行时到底需要什么

skill 本身很小：`SKILL.md`、`references/`、`design.mjs`、`lib/`、`canvas/`，大约 1 MB。仓库里还带着一些没有任何命令会读取的媒体文件：演示 GIF（约 3.3 MB）、演示 MP4（约 0.8 MB），以及截图（约 1 MB，包括案例墙）。

如果 skill 是复制进 skills 目录的（而不是 symlink 到 checkout），安装后可以删掉这些，腾出约 5 MB，`validate`、`set`、`serve`、`export` 都不受影响：

```sh
rm -rf docs/*.gif docs/*.mp4 docs/*.png
```

其余都是文本，保留：文档、示例、测试和 README 都很小，而且值得读。保留 `LICENSE` 和 `package.json`。如果 checkout 本身被 symlink 进 skills 目录，不要删——那就是仓库本身，安装是跟着它走的。

## 质量

测试套件固定了哪些不变量、今天量到的数据，见 [quality.md](quality.md)。
