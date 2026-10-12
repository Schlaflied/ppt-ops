# 演讲记录与复盘回流

同一份课件会反复讲：同一门课讲多期、同一个分享换场合再讲。每一场都会暴露「这页讲不顺」「观众在这里有疑问」「这页超时了」。本流程把每一次**实际演讲**变成一份可版本化的记录，并回流到下一版课件。它关注讲演层面；视觉层面的逐页回归见 #115。

流程分三步：

1. 演讲时在 HTML 演讲者视图里计时、打标，结束后导出一份 JSON 记录；
2. 用 `pptops delivery-retro` 把记录导入项目：生成复盘 Markdown，并把逐页结果追加到对应 PageSpec 的 `delivery_feedback`；
3. 下一版改讲稿或排版前读复盘与 `delivery_feedback`；`pptops review` 对连续两场都被标记的页给出提示。

## 1. 演讲时记录

在 HTML 演示版按 `N` 打开演讲者窗口（见 [presenter-view.md](presenter-view.md)）。演讲者窗口首次连上主屏时开始计时，同时开始一份新的演讲记录；记录和计时一样由主屏持有（`sessionStorage`），刷新主屏不丢。

- **逐页用时**：每次翻页记录进入/离开时间。时间按演讲者视图的计时器计，**暂停期间不计入**；黑屏期间计入当前页（人还在讲）。同一页多次进入会累加。
- **场合与日期**：演讲者窗口顶部的「Venue」选择线下（Offline）/线上（Online），「Date」默认当天，「Label」可写期次等备注（最多 120 字符）。
- **现场标记**：只在演讲者窗口生效，再按一次同一个键可撤销本页的该标记。

| 键（演讲者窗口） | 标记 | 记录中的 `kind` |
| --- | --- | --- |
| `!` | 这页讲不顺 | `stumble` |
| `?` | 观众有疑问 | `question` |
| `X` | 跳过了这页 | `skipped` |
| `E` | 导出记录（JSON） | — |
| `H` | 打开/关闭键位表 | — |

键位冲突的处理：主屏的 `?` 仍是键位表；在演讲者窗口里 `?` 用于打标，键位表改用 `H`（或点右上角 `?` 按钮）。在 Label 等输入框里打字不会触发标记；按住 `Ctrl` / `Cmd` / `Alt` 的组合键也不会。

- **重置**：演讲者窗口的「Reset timer」同时开始一份新记录（保留已选的场合与备注）。正式开讲前可以先 Reset 一次，清掉调试时的翻页。
- **导出**：按 `E` 或点「Export record (E)」，浏览器下载 `delivery-<日期>-<场合>.json`。导出完全在本地生成（Blob 下载），从 `file://` 离线打开也可用，不联网。导出不会结束记录，可以多次导出，最后一次为准。

## 2. 记录格式

记录格式由 [`schemas/delivery-record.schema.json`](../schemas/delivery-record.schema.json) 描述，导入时由 `src/delivery/retro.js` 的 `validateDeliveryRecord` 严格校验（未知字段、缺字段、日期/场合非法、逐页用时与进入记录不一致都会拒绝）。

```json
{
  "kind": "delivery_record",
  "schema_version": "1.0",
  "generator": "pptops-presenter",
  "deck": { "id": "1x2y3z", "project": "demo-presentation", "title": "…", "page_count": 2 },
  "delivery": {
    "date": "2026-10-12", "venue": "offline", "label": "第 3 期",
    "started_at": "2026-10-12T01:00:00.000Z", "exported_at": "2026-10-12T01:40:00.000Z",
    "timing_basis": "talk_clock_excluding_pauses", "total_seconds": 2390.4
  },
  "pages": [
    { "page": 1, "id": "page-1", "title": "…", "estimated_seconds": 60, "actual_seconds": 72.5,
      "visits": [{ "enter_seconds": 0, "leave_seconds": 72.5, "entered_at": "…", "left_at": "…" }] }
  ],
  "marks": [{ "page": 2, "kind": "question", "at_seconds": 130.2, "marked_at": "…" }]
}
```

- `pages` 列出主屏的全部页（含没展示过的页，`visits` 为空）；`*_seconds` 是演讲计时器上的秒数，`*_at` 是墙钟时间。
- `id` 只在 V1 项目里出现，导入时优先按 PageSpec `id` 匹配，否则按页码匹配。

## 3. 导入并生成复盘

```bash
pptops delivery-retro <project-dir> --record <delivery-record.json>
```

命令先校验项目和记录，然后：

- 把原始记录复制到 `<project>/deliveries/<delivery_id>.json`，复盘报告写到 `<project>/deliveries/<delivery_id>.md`，与源文件一起版本化；`delivery_id` 形如 `2026-10-12-offline-1a2b3c4d`（日期、场合、记录内容哈希）。
- 复盘报告包含：总用时与推算合计对比、逐页「推算 / 实际 / 差值 / 进入次数 / 标记」表、被跳过的页、超时的页、按类型汇总的现场标记、连续两场被标记的页及修改建议、匹配提示。
- 对每个匹配到的页，在 `pages.json` 的 PageSpec 上追加一条 `delivery_feedback`（只追加，不改其他字段；校验见 [`schemas/delivery-feedback.schema.json`](../schemas/delivery-feedback.schema.json)）：

```json
"delivery_feedback": [
  { "delivery_id": "2026-10-12-offline-1a2b3c4d", "date": "2026-10-12", "venue": "offline",
    "actual_seconds": 95, "estimated_seconds": 60, "visit_count": 1,
    "skipped": false, "overtime": true, "marks": ["question"],
    "report": "deliveries/2026-10-12-offline-1a2b3c4d.md" }
]
```

判定规则：

- **跳过**：现场按了 `X`，或整场没展示，或停留不足 5 秒（快速翻过）。
- **超时**：实际用时超过推算 20% 且至少多 10 秒；没有推算值的页不判超时，跳过的页也不判超时。推算值以项目当前的 `estimated_duration_seconds` 为准，没有时用记录里的值。

安全约束：

- 记录里的 `deck.project` 与项目名不一致时拒绝导入（`DELIVERY_RECORD_PROJECT_MISMATCH`）；同一份记录重复导入会被拒绝（`DELIVERY_ALREADY_IMPORTED`）；记录不合法时不写任何文件（`DELIVERY_RECORD_INVALID`）。
- 演讲之后页面被增删、改标题时，报告的「匹配提示」会列出差异；已不存在的页不会写回。
- `delivery_feedback` 是证据元数据：直接写入 `pages.json`，不经过 Candidate 流程，也不会改变页面内容或已接受状态。

## 4. 回流到下一版

- **实测时长替代推算值**：`src/delivery/retro.js` 导出 `latestRehearsedDuration(page)`、`resolvePageDuration(page)`（返回 `{ seconds, source: "rehearsed" | "estimated" }`）和 `rehearsedDurations(pages)`。有实测记录时取最近一场未跳过的实测秒数，否则回退到 `estimated_duration_seconds`。演讲者视图已用它在每页估计旁显示「Last delivery m:ss（日期）」。
- **QA 提示**：项目里有 `delivery_feedback` 后，`pptops review` 的报告会多一个 `delivery-feedback` 自动检查（`required: false`，不阻断）。同一页在**最近两场**演讲中都被标记（讲不顺、观众有疑问、跳过或超时）时，状态为 `pending`，并在 `evidence.repeated_pages` 中给出两场的信号和修改建议；否则为 `passed`。
- **改稿时**：Agent 修改讲稿或排版前应读取对应页的 `delivery_feedback` 与复盘报告，把反复出现的问题当作改稿输入；但实测时长和标记都只是讲演证据，不代表内容已被接受。

### 与 #124（讲稿时长预算）的衔接

`pptops script-review`（#124）逐页取时长时调用 `resolvePageDuration(page)`：最近一场演讲有未跳过的实测时，该页 `duration_seconds` 取实测秒数、`duration_source` 为 `rehearsed`（附 `rehearsed_date` / `rehearsed_delivery_id`），否则按字数推算、标为 `estimated`；`estimated_seconds` 始终保留字数推算值便于对照。`summary.total_duration_seconds` / `duration_minutes` 按逐页采用值求和，`summary.duration_source` 为 `estimated`、`rehearsed` 或 `mixed`。只要有一页用了实测且总时长偏离 `talk_budget` 的讲述时长超过容差，就给出 `script-total-duration` 发现项（字数预算检查 `script-total-budget` 不变）。演讲者视图的剩余时长仍按 #139 的规则（`talk_budget.total_minutes` 优先，否则推算之和）。详见 [content-review.md](content-review.md)。

## 未验证范围

- 自动测试覆盖记录的纯函数、记录与 `delivery_feedback` 校验、CLI 导入（Foundation 与 V1 项目）、QA 提示，以及无头 Chrome 中主屏记录、演讲者窗口按键打标与导出下载。
- Safari、Firefox 未实测；有头浏览器的下载提示行为未实测。
