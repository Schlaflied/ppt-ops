# 图片语义区域与锚点（Stage 1）

Stage 1 为普通图片和生成图片增加声明式 `image_semantics` 合同。它只记录已经提供的语义标注并检查 Page Spec 引用、裁切和显示尺寸；不会从像素自动推断语义，也不宣称观众理解度已经通过。

资产可以声明：

- `semantic_regions`：稳定区域 ID、角色和归一化边界框；
- `focal_points`、`text_safe_areas` 与 `anchor_edges`；
- `minimum_display_size`；
- `allowed_crops` 与 `forbidden_crops`；
- `annotation_state`：`machine_observed` 或 `user_confirmed`，机器观察不会自动升级为用户确认。

Page Spec 的 `asset_slots[].region_mappings` 使用稳定 `content_id` 将页面内容绑定到 `region_id`，可选绑定 `anchor_id`。引用不存在的区域或锚点会使合同校验失败。

结构 QA 会报告：多区域图片缺少显式映射、机器标注仍待用户确认、无法解析实际放置、低于最小显示尺寸、语义区域或禁止裁切区域被裁掉。所有结果都是声明合同与渲染几何证据；真实图文对齐、遮挡、可辨认性、PowerPoint 编辑效果和人工视觉接受仍需后续阶段验证。
