# 多媒体来源导入：Stage 1 合同与安全登记

本阶段只建立图片、音频和视频的本地优先登记、能力报告与统一证据合同，不声称已经提供 OCR、语音转写、讲者识别或视频理解。`pptops source-capabilities <project-dir>` 会报告当前格式、定位器和明确的待实现能力。

支持登记的格式与默认大小上限：PNG/JPEG、WAV/MP3、MP4/WebM；每个文件默认不超过 50 MiB。格式由扩展名与文件签名共同验证。原始字节以 SHA-256 为身份写入 `.pptops/sources/<sha256>/`，重复导入返回同一 Source；原文件不会被改写。失败、取消或进程中断后可安全重试，内容寻址写入不会覆盖已有文件。

规范化 extraction manifest 分开记录 `structured_extraction`、`visual_observation`、`transcription`、`model_inference` 与 `user_confirmation`。图片证据使用页码/归一化区域，音频使用毫秒时间范围，视频可组合时间范围、关键帧和区域。低置信度、不可读、听不清和冲突必须进入 review 状态，不得静默成为已确认事实。

Stage 1 不调用任何外部模型，也没有上传路径。manifest 明确记录 `local_only` 与 `external_authorized: false`。未来接入供应商时，必须在发送前展示供应商、拟发送内容和隐私策略，并取得显式授权。

尚未实现：真实 OCR/表格识别、音频转写/讲者区分、视频音画联合理解、混合来源索引与冲突处理、Page Spec/Review/Handoff 串接，以及真实案例的隐私与中断恢复验收。这些属于后续阶段。
