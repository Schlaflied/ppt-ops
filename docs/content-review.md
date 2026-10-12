# DBS 内容审查接入

PPT Agent 在大纲确认前检查听众能从内容中获得什么，在修改论点、方法和讲述逻辑时按目标页面复查。审查结果分为：保留页面、修改页面、仅补充口述、等待证据。单独的内容审查不要求已有 Build，也不会启动生图或生成 PPT。

## 按需使用三个 skill

| 能力 | 使用时机 | 产出 |
|---|---|---|
| `dbs-jtbd` | 新大纲或内容审查 | 听众的具体处境、想推进的事情、页面是否完成这一作用、缺少什么 |
| `dbs-theory-grounding` | 经验判断、因果推断、专业术语或理论引用 | 先检查命题，再给出措辞边界、理论解释与来源核实状态 |
| `dbs-skill-maker` | 明确要求把方法做成 skill | 独立的 skill 文件及实际完成的验证记录 |

方法页会检查输入、步骤、判断条件、输出和验收方式；故事、概念页或章节页无需强行转成 skill。普通事实介绍和价格信息无需补理论。日常表达可以保留，专业术语需要含义一致。

页面与口述互补时，页面保留最需要被看见的信息，口述补充推理、案例、演示和适用条件。演讲者注释标为待讲者校对的草稿，不能声称已完成排练或课堂验证。

## 安装与更新

这三个 skill 由 DBS 官方独立维护，本仓库只保存调用规则和报告模板。PPT Agent 优先读取会话中的已安装 skill；缺失时仅检查其常见本地安装路径，报告能力不可用并继续独立可完成的工作。不会在审查过程中自行安装或复制官方实现。

如果需要安装或更新，请在 Codex 中明确提出“安装 DBS skills”或“更新 DBS skills”。已有安装无需重复操作。每次审查记录实际使用的 `SKILL.md` 路径和哈希，便于识别更新前后的依据。

## 报告与验收

报告保存在解析后的项目目录 `review/content/<时间戳>-<范围>/review-report.md`。需要时另存 `speaker-notes-draft.md`。报告标明输入文件哈希、页面稳定 ID、当前页码、事实与假设、来源核实程度及待确认事项；材料变化后，旧报告必须标记过期并按需复查。

内容审查不会自动替换已接受的页面，也不代替视觉检查、自动测试、PowerPoint 实机验证和用户验收。已有授权下的修改继续走项目原有流程。正式交付仍执行原有构建与验收规则。

接入规则见 [content-review.md](../.agents/skills/ppt-agent/references/content-review.md)，报告结构见 [content-review-template.md](../.agents/skills/ppt-agent/references/content-review-template.md)。路由测试验证内容审查与正式构建的入口边界；它们不证明理论正确或课堂效果。

## 讲稿审校（总时长预算）

项目可选声明 `talk_budget`：`total_minutes`（必填）、`words_per_minute`（默认 250）、`reserve_minutes`（答疑/缓冲，默认 0）、`tolerance_percent`（总字数允许偏差，默认 10）。预算字数 = (`total_minutes` − `reserve_minutes`) × `words_per_minute`。计数规则：每个汉字（含日文假名、韩文）计 1 字；每个连续的拉丁字母或数字串计 1 词（`GPT-4`、`3.5` 各计 1）；标点和空白不计。

PageSpec 可选 `script_role`：`transition`（一句话，≤40 字）、`core`（默认，优先分配）、`reference`（可压缩、可跳过）；`merged_with: [页码或 PageSpec id]` 表示被列出的页面由本页讲稿一起讲。分配器先给转场页一句话（最多 30 字），剩余字数按 core 1.0、reference 0.4 的权重用最大余数法分配，合并页的份额并入宿主页。代码只计算预算与检查结果，逐字稿仍由 Agent 撰写、讲者校对。

可选 `script_review` 配置语言检查：`banned_phrases`（默认 说白了、简单来说、换句话说、综上所述、总而言之、众所周知；设为 `[]` 关闭）、`max_dashes_per_page`（默认 2）、`quote_style`（`consistent` | `curly` | `corner`，默认 `consistent`）。

运行 `pptops script-review <project-dir> [--baseline <旧的 script-review.json>]`，输出每页目标字数、实际字数、偏差和推算时长，并写入 `outputs/script-review.json`（含每页讲稿全文）与 `outputs/script-review.md`。发现项包括：`script-total-budget`（超时时列出建议压缩的页：先把转场压成一句，再跳过 reference 页，再把 core 页压回目标）、`script-page-budget`、`script-transition-length`、`script-missing`、`script-banned-phrase`（含页码与原句）、`script-dash-limit`、`script-quote-style`，以及 `script-screen-number-missing`（页面标题、副标题、正文或三秒信息中的阿拉伯数字没有出现在该页讲稿中）。每页同时给出 `estimated_seconds`（由字数推算）和实际采用的 `duration_seconds` / `duration_source`：该页导入过演讲记录（`delivery_feedback`，见 [delivery-retro.md](delivery-retro.md)）时，取最近一场未跳过的实测秒数，`duration_source` 为 `rehearsed`，并附 `rehearsed_date` / `rehearsed_delivery_id`；否则为 `estimated`。`summary` 汇总 `total_duration_seconds`、`duration_minutes`、`duration_deviation_percent`（相对 `speaking_minutes`），`duration_source` 为 `estimated`、`rehearsed` 或 `mixed`，`rehearsed_pages` 列出采用实测的页；有实测时 `rehearsed_timing` 为 `latest_delivery`，否则为 `not_claimed`。至少一页有实测且总时长偏差超过 `tolerance_percent` 时，额外给出 `script-total-duration` 发现项；`script-total-budget` 仍只按字数判断。实测只来自导入的演讲记录，自动化不会凭推算声称彩排实测。

声明了 `talk_budget` 或 `script_review` 时，`pptops review` 增加非阻断检查 `speaker-script-review`，交付包另存 `script-review.json` 与 `script-review.md` 审校日志（删页、跳过页、合并页、压缩比、禁用词与破折号计数），并在 manifest 的 `script_review` 中摘要。压缩比需要 `--baseline` 提供压缩前的审校结果；若 `outputs/script-review.json` 与冻结版本的 `script_revision` 一致，交付包沿用它。未声明这两项时，审查与交付行为不变。
