# Jitang Simmer v0.7.0 AI Token 统计与本地来源发现

## Summary

- 增加“本地 AI 数据源发现模块”，自动寻找 Codex、ZCode、DeepSeek Harness 的数据目录和可执行程序。
- 统计真正以日志或数据库为准，而不是以程序是否安装为准：程序卸载后仍可导入历史；程序已安装但尚无会话时显示“已安装，暂无数据”。
- 第一版统计 Codex、ZCode、DeepSeek Harness，不直接统计 OpenCode、DeepSeek API、网页或套餐额度。
- OpenCode Go 中的 DeepSeek V4 Flash 经 Harness 调用后，以 DeepSeek Harness 为来源、实际 provider/model 为维度统计真实 Token，但不代表 Go 套餐剩余额度。

## Discovery and Collection

- 采集器增加 `TokenSourceDiscovery`，启动时、每 30 分钟及用户点击“重新扫描 AI 工具”时执行：
  - Codex 数据目录优先级：Simmer 手动设置 → `CODEX_HOME` → `%USERPROFILE%\.codex`；检查 `sessions` 和 `archived_sessions`。
  - DSH 数据目录优先级：Simmer 手动设置 → `DSH_HOME` → `%USERPROFILE%\.dsh`；检查 `sessions/**/session.jsonl(.zstd)`。
  - ZCode 数据目录优先级：Simmer 手动设置 → `%USERPROFILE%\.zcode`；检查 `cli\db\db.sqlite` 和 `projects`。
  - 可执行程序仅用于状态和诊断：检查正在运行的进程、PATH、Windows App Paths、卸载注册表及已知用户应用目录；不递归扫描整块硬盘。
- 每个来源返回：
  - `ready`：找到并可读取数据。
  - `installed_no_data`：找到程序，但尚无 Token 数据。
  - `history_only`：找到历史数据，但程序已不存在。
  - `not_found`、`incompatible` 或 `error`。
  - 当前数据目录、程序位置、发现方式和最后扫描时间；程序路径仅留在本机，服务器只接收状态。
- 设置窗口增加“AI Token 来源”区域，显示三种工具的检测结果，并提供“自动检测”“选择数据目录”“打开目录”；用户不需要手改配置文件。
- 同一来源只启用最高优先级的一个数据根，避免复制目录造成重复统计；其他候选仅在设置中提示。
- 检测到路径变化后重建文件监听器；文件变化延迟 5 秒扫描，每 15 分钟兜底，每天完整校准一次。

## Parsing and Privacy

- 随采集器打包隐藏式 `simmer-token-scan.exe`，固定依赖 `tokscale-core` 提交 `b069c85d530c35ba1a3517e80aaa8423428dccd8`。
- 使用原始 `UnifiedMessage` 解析接口保留请求级粒度，而不是调用会按 session/model 汇总的普通 CLI。
- Codex 复用累计值差分、模型切换、乱序快照、分叉会话和归档去重逻辑。[Codex 解析器](https://github.com/junhoyeo/tokscale/blob/b069c85d530c35ba1a3517e80aaa8423428dccd8/crates/tokscale-core/src/sessions/codex.rs)
- ZCode 只读 `model_usage`，兼容新旧 SQLite 字段及缓存/推理重叠语义。[ZCode 解析器](https://github.com/junhoyeo/tokscale/blob/b069c85d530c35ba1a3517e80aaa8423428dccd8/crates/tokscale-core/src/sessions/zcode.rs)
- DSH 读取普通或 Zstandard 会话日志，处理残缺尾帧、子任务种子历史和重复消息。[DSH 解析器](https://github.com/junhoyeo/tokscale/blob/b069c85d530c35ba1a3517e80aaa8423428dccd8/crates/tokscale-core/src/sessions/dsh.rs)
- Sidecar 禁用定价和联网，只输出来源、provider、model、时间及五个互斥 Token 桶；缓存固定写入 `%APPDATA%\SimmerCollector\tokscale`。
- `sourceEventId` 使用上游去重键的 SHA-256；服务器不保存会话 ID、项目路径、提示词、回答、代码、凭据或原始日志。
- 首次导入全部历史；后续扫描最近 48 小时并稳定去重，每日全量扫描用于纠偏。

## Storage, APIs and UI

- 新增 `ai_token_events` 和 `ai_source_status`，以 `(device_id, source, source_event_id)` 保证幂等。
- Token 字段统一为非缓存输入、普通输出、缓存读取、缓存写入、推理及五项总和。
- 新增 Bearer 鉴权的批量上报接口，以及 summary、trend、year、breakdown、sources 查询接口。
- 前端增加“AI Tokens”：
  - Token 分类概览、趋势、年度 P95 热力图、来源排行和模型排行。
  - 设备、来源、provider、model、时间范围筛选。
  - 显示每个设备上的来源状态和本地发现结果摘要。
  - `deepseek-v4-flash` 按实际模型展示，不冒充 OpenCode Go 套餐配额。
- 参考 Token Monitor 的本地解析、增量刷新和历史保留设计，但保留 Simmer 的请求级 SQLite 明细。[Token Monitor 采集器](https://github.com/Javis603/token-monitor/blob/7ad2acce0580d5be23b8a5930a67cb836370a500/src/shared/collector.js)

## Test and Documentation

- 使用临时用户目录测试环境变量、默认路径、手动覆盖、便携安装、仅历史、已安装无数据、多候选优先级和运行中重新发现。
- 验证不会扫描整个磁盘，不会把程序路径或敏感文本上传。
- 覆盖 Codex 分叉与累计差分、ZCode 新旧数据库、DSH 压缩/残缺/子任务去重，以及重复全量导入。
- 验证 sidecar 超时、损坏、版本不兼容时只影响 Token 模块，不拖垮前台时长采集。
- 运行 Rust、.NET、Node 和前端检查，并在真实 Codex、ZCode 环境验收；Harness 接通后补做真实 V4 Flash 对照。
- 更新 README、需求文档和交接文档，记录发现优先级、手动覆盖、来源状态、隐私边界、第三方许可及 v0.7.0 变更；保留 `server/config.example.json`。

