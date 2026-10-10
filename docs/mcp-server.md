# 本地 MCP Server（第一阶段）

PPT-Ops 提供本地 `stdio` MCP Server，让支持 MCP 的智能体读取一个明确指定的 V1 项目。第一阶段只开放查询工具，不会构建文件、推进评审状态或创建交付包。

运行环境要求 Node.js 22 或更高版本；Server 使用 Node 内置的 `node:sqlite`。在部分 Node 版本中，`stderr` 会出现 `ExperimentalWarning: SQLite is an experimental feature`，这不是启动失败，也不会污染只用于 MCP 协议的 `stdout`。

## 启动边界

启动时必须用 `--project-dir` 指定一个项目目录。Server 不扫描父目录，也不允许工具调用临时切换项目。

```bash
npm run mcp -- --project-dir /absolute/path/to/ppt-ops-project
```

也可以在支持 MCP 的客户端中直接配置 Node 入口：

```json
{
  "mcpServers": {
    "ppt-ops": {
      "command": "node",
      "args": [
        "/absolute/path/to/ppt-ops/src/mcp/server.js",
        "--project-dir",
        "/absolute/path/to/ppt-ops-project"
      ],
      "cwd": "/absolute/path/to/ppt-ops"
    }
  }
}
```

`stdout` 仅承载 MCP 协议消息。启动错误和运行日志写入 `stderr`，避免破坏协议流。启动失败或工具内部错误会输出单行 JSON，例如 `{"error":{"code":"MCP_START_FAILED","message":"..."}}`；客户端可记录该行用于排障，但不应把它当作协议响应。

Server 以 SQLite 只读模式打开已有的 `.pptops/metadata.sqlite`，不会创建数据库、迁移 schema、登记项目，也不会执行中断 Build 恢复。因此轮询一个处于 `preparing`、`rendering` 或 `validating` 的 Build 不会改变其状态、attempt 或事件。如果项目尚未由 PPT-Ops CLI 初始化 metadata store，工具会返回 `STORE_NOT_INITIALIZED`；请先用 CLI 打开或执行一次项目命令，再重新启动 Server。

## 当前工具

| 工具 | 输入 | 返回内容 |
| --- | --- | --- |
| `pptops_project_inspect` | 无 | 项目身份、契约数量、工作流对象数量 |
| `pptops_build_status` | `build_id` | Build、尝试记录、事件 |
| `pptops_candidate_diff` | `candidate_id` | Candidate 补丁、目标版本、是否过期 |
| `pptops_review_inspect` | `review_id` | Review 证据状态和关联 Build |
| `pptops_delivery_capabilities` | `artifact_type`，presentation 另需 `build_id` | 当前可选择的交付格式 |

所有工具均声明为只读、幂等且不访问外部网络。成功返回值同时包含同形状的文本 JSON 和 `structuredContent`。进入工具 handler 后的业务错误使用稳定的 `error.code`；未知内部错误返回 `MCP_TOOL_FAILED`，不会向客户端暴露堆栈，并会在 `stderr` 留下单行 JSON。

SDK 在进入 handler 前执行输入 schema 校验。未知字段、缺少必填字段或不合法枚举会返回 `isError: true` 和纯文本 `Input validation error: ...`，此类响应由 SDK 生成，不含 `structuredContent` 或 PPT-Ops `error.code`。这是与上述业务错误不同的第二种错误形态。

## 排障与停用

- 握手超时：直接运行配置中的 `command` 和 `args`，检查 `stderr` 的单行 JSON，并确认 Node 版本至少为 22、项目路径存在且包含 `project.json`。
- `STORE_NOT_INITIALIZED`：先用 PPT-Ops CLI 打开该项目，确认 `.pptops/metadata.sqlite` 已存在，再重启 MCP 客户端。
- `Input validation error`：对照上表移除未知字段，并补齐对应 ID；Server 的输入 schema 为严格模式。
- 停用：从 MCP 客户端配置中移除 `ppt-ops` 条目并结束对应进程即可。Server 不安装后台服务，也不写入外部配置；停用不会删除或修改项目数据库。

## 当前限制

- 仅支持本机 `stdio` 传输。
- 一个 Server 进程只服务一个项目。
- Source 导入、Build、Review 和 Handoff 等有状态操作尚未开放为 MCP 工具。
- Server 复用 `ApplicationService`，不维护第二套业务状态或生命周期规则。
