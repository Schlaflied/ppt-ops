# 讲后分发：handout 交付目标

线下分享或线上课程结束后，常见的后续动作是把 PDF 和讲稿发给听众、在社群里放一张概览图、整理回放素材。`handout` 是交付选择中的一个可选格式，一次生成这些讲后材料。它与 `html`、`pptx`、`pdf` 互相独立：不勾选时，默认的 HTML + PPTX 交付流程和交付包内容完全不变；只勾选 `handout` 时，交付包里也不会多出未选择的 `slides.html`。

## 来源与前提

handout 只从**已通过 Review 的 HTML 构建**派生：

- 正式流程：Build 必须包含 `html` 目标，且有一条 `accepted` 的 Review，其 `artifact_hashes` 与当前 `slides.html` 的哈希一致。`delivery-select` 记录 `handout_source`（文件、哈希、Review ID），`handoff-create` 打包前再次核对，HTML 被改动则以 `HANDOUT_SOURCE_CHANGED` 拒绝。
- 简便流程：`pptops handoff|deliver <project-dir> --formats handout --actor user` 以 `outputs/slides.html` 为来源。`deliver` 在只选 `handout` 时也会先渲染 HTML 作为来源，但不把它放进交付包。

逐页讲稿取自 `pptops script-review`（#124）的审校结果 `pages[].script`。若 `outputs/script-review.json` 与冻结版本的 `script_revision` 一致则直接沿用（manifest 记为 `outputs/script-review.json`），否则按同一规则当场审校（记为 `generated:speaker-script-review`）。

## 选择方式

```text
pptops delivery-capabilities ./project --artifact presentation --build build-003
pptops delivery-select ./project --artifact presentation --formats handout \
  --source build-003 --source-revision version-004 --build build-003 --actor user \
  --handout-editions speaker,audience
pptops handoff-create ./project --build build-003 --review review-003 --selection <selection-id>
```

`--handout-editions` 可选 `speaker`（讲者版，默认）和 `audience`（听众版），可以同时选。`delivery-capabilities` 的 `handout` 行会列出 `components`，说明本机能否生成 PDF 与预览图；Agent 应在用户选择前如实告知。

## 交付包中的文件与使用场景

交付包 `outputs/handoff/package-NNN/handout/`：

| 文件 | 内容 | 适用场景 |
|---|---|---|
| `slides.pdf` | 由 Chromium 打印 HTML 得到的矢量 PDF，一页一张幻灯片，文字可选中、可搜索；演讲者备注和翻页控件不进入 PDF | 讲完后发给听众或学员、存档、打印 |
| `script.md` | 逐页讲稿 Markdown，每页标题 `## N. 标题` 与幻灯片标题一致，并注明脚本角色、字数、估计时长和连讲关系 | 讲者复盘、整理回放文字稿、交给剪辑或字幕同事 |
| `previews/NN.png` | 每页 960×540 预览图，文件名按页码编号 | 社群概览图、公众号配图、回放封面候选 |
| `index.html` | 按章节分组的缩略图目录，链接 PDF 和讲稿；无外部资源、无脚本，断网也能直接双击打开 | 快速浏览整份材料、挑选要转发的页 |
| `audience/` | 听众版（可选）：`slides.pdf`、`index.html`、`previews/`，以及有受管引用时的 `citations.md` | 直接整包发给听众 |
| `handout-manifest.json` | 本目录的来源与检查记录，单独转发 handout 目录时也能追溯 | 回溯是哪一次演讲用的哪一版 |

章节分组优先使用大纲（Outline）的 sections；旧项目没有大纲时，以 `script_role: transition` 的页开启新章节；受管引用附录页归入「参考资料」。

### 听众版

- 不含演讲者备注，也不含 `script.md`；
- 合并转场页：`script_role` 为 `transition` 的页不进入听众版 PDF、目录与预览，并在 manifest 的 `audience.merged_transitions` 中记录并入哪一页（声明了 `merged_with` 时为宿主页，否则为后面第一张非转场页）。首页与末页作为标题边界页始终保留；
- 引用附录复用 #94 的受管引用清单：只列出 `disclosure` 为 `public` 且允许进入听众渠道的条目，`organization_internal`、`restricted`、`undisclosed` 来源不会出现；书目信息不完整的条目标注「待补充」，不会编造。Build 未声明引用时记为 `not_declared`。

## 与受众变体（#76）的关系

讲者版与听众版可以来自同一项目的两个受众变体：例如为听众冻结一个去掉练习页、改写标题的变体，再从该变体的 Build 生成 handout。handout 的页码、标题和章节都来自该变体解析后的冻结版本，manifest 的 `source.variant` 记录变体 ID、基线版本与覆盖哈希。

## 检查与可追溯性

manifest（`manifest.json` 的 `handout` 字段，以及 `handout/handout-manifest.json`）记录：

- `source`：Build、冻结版本 ID 与 `snapshot.json` 的哈希、Review、HTML 哈希、`script_revision`、受管引用清单版本、受众变体；
- `pages[]`：每页的 PageSpec 哈希（`page_spec_sha256`）、标题、章节、脚本角色、预览图路径与哈希、在听众版中的去留；
- `checks[]`：
  - `handout-pdf-page-consistency` / `handout-audience-pdf-page-consistency`：复用 #99 的 HTML 页面提取，比对 PDF 页数与 HTML 页数（听众版扣除合并的转场页），并确认 PDF 内嵌字体且含文字绘制指令，避免把截图拼成的 PDF 当成可复制文字；
  - `handout-slide-titles`：HTML 幻灯片标题与 PageSpec 标题一致；
  - `handout-script-titles`：`script.md` 的每页标题与幻灯片标题逐页一致。

全部生成且检查通过时 `status` 为 `complete`，否则为 `incomplete`。

## 降级

PDF 与预览图需要本机的 Google Chrome 或 Chromium（可用 `PPT_OPS_CHROME` 指定）。找不到浏览器时不会伪造或换用其他转换器：`components.pdf`、`components.previews` 记为 `unavailable` 并写明原因，`index.html` 显示「预览不可用」，讲稿与目录照常生成，`status` 为 `incomplete`。打印或截图失败时记为 `failed` 并保留错误信息。时长一律为按字数推算的 `estimated`，`rehearsed_timing` 为 `not_claimed`。
