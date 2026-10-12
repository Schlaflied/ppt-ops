<div align="center">

<img src="docs/assets/ppt-ops-logo.png" alt="PPT-Ops Logo：机器人手持橙红色演示文稿页面" width="220">

# PPT-Ops

### 把一堆资料变成一套能讲、能改、能交出去的演示文稿

[快速开始](#快速开始) · [现在能做什么](#现在能做什么) · [当前进展](#当前进展)

</div>

## 我为什么做这个

我自己做 PPT 主要是两种场合：线下分享，对着投影讲；线上讲课，开着屏幕共享讲。

两种场合踩的坑不太一样，但都很具体。线下讲到一半，发现时间已经不够了，后面几页只能跳过去。投影一打，笔记本上看着正好的小字，后排根本看不清。线上共享的时候，会议软件的摄像头小窗刚好盖住了图表的一角，回放被压到 720p 以后细线也糊了。讲完了，学员要材料，我又得把讲稿、页面和参考来源重新整理一遍。

这些问题单独看都不难，难的是每次都要靠自己记得去检查。PPT-Ops 就是把这些检查放进流程里：先把内容主线理清楚，再做页面，做完用工具查一遍，最后交出浏览器能直接放的 HTML 和还能继续改的 PowerPoint。

还有一点是我很在意的：我不想让它变成一套死板的模板机。现在的模型本身已经很会写、很会设计，我更希望流程负责把关，把发挥的空间留给模型。这个想法受了花叔的 [huashu-design](https://github.com/alchaincyf/huashu-design) 等 skills 不少启发。

## 现在能做什么

整个流程大致是这样走的：

**理解资料 → 梳理大纲 → 审查内容 → 设计页面 → 生成初稿 → 检查修改 → 打包交付**

你可以给它一个主题、一份逐字稿、一堆项目资料，或者一份想重做的旧 PPT。它会先帮你把大纲和每页要讲的重点定下来，确认方向后再做整套页面。内容审查可以接入已安装的 DBS skills，看观众到底能带走什么、方法能不能落地、术语和理论有没有用过头。

跟讲课最相关的几样，已经合进 main 了：

- **讲稿时间预算**：在项目里声明总时长，`pptops script-review` 会按字数估算每页该讲多久、实际写了多少，超时的话会告诉你先压哪几页。时长都是按字数推算的，不等于彩排实测。详见[内容审查说明](docs/content-review.md)。
- **演讲者视图**：HTML 演示版按 `N` 打开演讲者窗口，能看到下一页、备注、已讲和剩余时间，两个窗口翻页同步，还有黑屏、跳页、缩略图这些现场常用键。线下怎么接投影、线上怎么只共享主屏，见[演讲者视图说明](docs/presenter-view.md)。
- **线上讲课模式**：把项目的 `delivery_mode` 设为 `online_lecture`，字号、对比度和线宽会按 720p 画面来算。你可以声明腾讯会议、Zoom、飞书的摄像头小窗和工具条位置，或回放字幕条，图表和正文压到这些区域时会被指出来；隔太久没有互动页也会提醒。详见[交付选择说明](docs/delivery-selection.md#online-lecture-mode)。

其他已经可用的：

- 同时生成浏览器演示稿和可编辑的 PowerPoint，并对两份产物逐页比对内容是否一致
- 给不用 Git、不碰命令行的评审者生成离线审阅包，意见可以导回项目
- 检查记录和交付文件都留在项目里，下次改的时候有据可查

正在做、还没合并的：

- 讲完之后的分发包，把讲义、讲稿和参考来源一次整理给学员（[#126](https://github.com/luochen211/ppt-ops/issues/126)）
- 讲完复盘：演讲者视图记录实际每页讲了多久，再回流到下一版（[#127](https://github.com/luochen211/ppt-ops/issues/127)）

三个主要入口（资料生成 PPT、结构生成 PPT、已有 PPT 视觉润色）的范围和完成情况，写在[核心功能规划](docs/core-workflows-plan.md)里。图片、音频、视频作为主要素材的理解流程，以及保留原页面元素的视觉润色，都还没做完。

## 真实跑过的案例

我用它完整生成过一套 67 页的案例，在 Chrome 和 Safari 里都从头翻到尾检查过。另外，一场真实的开班直播的工作版 PPTX（54 页）也导进来跑过一遍，产出了可编辑的 PPTX 和审查记录，过程记在 [V1 验收记录](docs/acceptance/v1-release-candidate.md)里。

自动检查能发现很多问题，但字体、视觉细节和现场播放效果，还是要在你最后用的那台电脑和 PowerPoint 里自己看一遍。

## 视觉风格模板

模板是给模型的一个方向，不是要把每一页都套进去。目前有两套。

### 硬切人

低多边形人物，硬边切面。人物用几何平面塑造，轮廓、体块和切面边界都很清楚。

![硬切人风格参考：低多边形人物与清晰的硬边切面](templates/user/hard-cut-people/reference.png)

人物接近真实的成人比例，面部简化，头发、衣服和身体由明暗不同的切面组成。颜色按主题选，人物动作、背景和留白随页面安排。适合商务交付、协作沟通、项目提案、职业培训，或者需要用人物关系讲观点的页面。

用的时候可以直接说：

> 使用「硬切人」template，表现两位项目成员交接成果的场景，人物放在右侧，左侧留白，图片内不生成文字。

[完整模板、参考图与提示词](templates/user/hard-cut-people/README.md)

### 线稿蓝图（Technical Blueprint）

深蓝工程图纸，精密线稿，清楚的系统路径。适合把一个抽象流程画成能拆开、能追踪、能讨论的技术结构。

![线稿蓝图参考：深蓝工程纸上的模块、节点、管线与琥珀色重点](templates/user/technical-blueprint/reference.jpg)

画面是午夜蓝工程纸、灰白结构线、节点、连线和模块剖面，再加少量琥珀色高亮。主体放在页面中部或右侧，输入、处理、输出的路径要看得出来，标题和结论有自己的位置。对比度高，但不堆霓虹光效。适合 AI 工作流、产品架构、技术方案、数据管线这类内容。

用的时候可以直接说：

> 使用「线稿蓝图」template，表现一个从资料输入到多格式导出的 AI 演示文稿工作流，主体放在右侧，左侧留白，图片内不生成文字。

[完整模板、参考图与提示词](templates/user/technical-blueprint/README.md)

## 快速开始

在 Codex 里打开这个仓库，直接说：

> 使用 `$ppt-agent`，把这些资料整理成一份可编辑的演示文稿。

然后把主题、逐字稿、项目资料或旧 PPT 给它就行。最好顺便说清楚：讲给谁听、线下还是线上、大概讲多久、要多少页、什么时候要。

只想查一份现有课件也可以：

> 检查这份课件的讲述逻辑：观众能获得什么，哪些页面需要改，哪些只需补充口述。

内容审查会按需用到 `dbs-jtbd` 和 `dbs-theory-grounding`；你明确说要把方法做成 skill 时，才会调用 `dbs-skill-maker`。审查结果存进项目，演讲者备注作为待校对的草稿交付。

## 安装与更新

需要 Node.js 22 或更新版本、Git 和 npm：

```sh
git clone https://github.com/luochen211/ppt-ops.git
cd ppt-ops
npm ci
```

之后在仓库目录里更新：

```sh
node update.mjs check      # 检查更新
node update.mjs preview    # 查看变化
node update.mjs apply      # 备份并更新
node update.mjs rollback   # 撤回上一次更新
```

更新只取 main 上最近一次通过 GitHub Actions 检查的提交。项目资料和用户模板会保留；如果你本地改过系统文件，更新器会停下来提醒你。更新后会重新安装依赖并跑检查，失败就恢复原来的文件和依赖。

`$ppt-agent` 每个本地会话第一次调用时会做一次只读的更新检查，结果缓存 24 小时。它只提醒，不会自己装，装不装由你决定。

Actions 也会产出带校验文件的系统更新包，用来体验当前进展，不代表正式版已经过人工验收。离线更新和恢复见[系统更新指南](docs/system/updates.md)。

## 最后拿到什么

| 产物 | 说明 |
|---|---|
| HTML 演示版 | 单个文件，离线双击就能放，带演讲者视图 |
| PowerPoint 文件 | 可以继续编辑 |
| 检查记录 | 页面、内容和讲稿的检查结果 |
| 交付包 | 带版本信息，可追溯到对应的源文件 |

源文件和生成结果分开放，后面怎么改都不会覆盖原始资料。

## 当前进展

现在是 **V1.0 发布候选**。正式发布前，我还想多做几轮人工视觉检查、多在真机 PowerPoint 上验证，也想找目标用户实际试用。

所以它现在适合拿来体验、研究和一起改。要用在重要的场合之前，请一定自己复核一遍。

## 进一步了解

- [产品说明](docs/product-v1.0-blueprint.md)
- [使用与排障指南](docs/operations.md)
- [非技术评审反馈包](docs/reviewer-feedback-packages.md)
- [HTML 演讲者视图与现场快捷键](docs/presenter-view.md)
- [开发者指南](docs/developer-guide.md)
- [本地 MCP Server（第一阶段）](docs/mcp-server.md)
- [Accessibility Mode 与证据边界](docs/accessibility-mode.md)
- [Visual Asset Pipeline 需求](docs/visual-asset-pipeline-requirements.md)
- [Visual Asset Pipeline 交付 DAG](docs/visual-asset-pipeline-dag.md)
- [V1 发布候选验收记录](docs/acceptance/v1-release-candidate.md)
- [目标用户试用计划](docs/target-user-trials.md)
- [版本说明](docs/releases/v1.0.0.md)

## 参与项目

用着不顺手、结果不对，或者有想法，欢迎开 Issue。能写清楚是什么场合用、给了什么资料、期望什么、实际得到什么，我会更快定位问题。

## 许可证

[MIT](LICENSE)
