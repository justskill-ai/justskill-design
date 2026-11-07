# 中文文档

英文文档的中文版本。英文原文是权威版本（source of truth）：如果两边不一致，以英文为准，也欢迎直接提 PR 修正。

| 文档 | 内容 |
|---|---|
| [一种软件新范式](paradigm.md) | 长文：软件 Skill 化、app 之后的设计软件、可进化性、九阶段循环，以及这套东西的代价 |
| [它是怎么工作的](how-it-works.md) | 为什么设计文件是 HTML、一屏看懂格式、所有命令、画布、写入漏斗、回执、范围，以及从 checkout 安装 |
| [质量](quality.md) | 测试套件固定了哪些不变量，以及今天量到的数据 |

没有翻译的文档，原因写在下面：

- `docs/format-v3.md` —— 冻结的契约。它是格式的权威定义，逐字翻译容易和代码、测试漂移，所以保持英文。
- `references/*.md` —— 由格式表生成（`styling.md`、`schema.md`），或由脚本检查（`images.md`、`product-flow.md`），保持英文，避免翻译副本落后于生成内容。
- `docs/plan*.md`、`docs/remediation.md` —— 内部工作记录，不面向使用者，不翻译。
