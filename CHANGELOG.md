# 更新日志

本文件记录 Jitang Simmer 的用户可见变更。**今后每次改动随代码一同提交推送**，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 未发布

（无）

## 0.11.0

### 修复

- **采集端 Token 扫描 5 秒自激循环**：文件监听根从整个数据根（`~/.zcode` 等）收窄到扫描器真正读取的目录（ZCode `cli/db`、Codex `sessions`/`archived_sessions`、DSH `sessions`、WorkBuddy `projects`），并按文件名过滤（会话 JSONL 与 `db.sqlite*`）。此前 ZCode CLI 自身的 WAL、日志、rollout、exec 输出每秒触发监听器，最多一天 1.6 万次 `file_changed` 扫描，96% 以上是"0 事件"日志。
- **监听触发的扫描限速**：最小间隔 60 秒；连续 0 事件时按 1→2→5→10 分钟退避，扫到新事件立即恢复。扫描器按 48 小时修改窗口重读文件，被限速跳过的扫描不会丢数据。
- **监听器不再每轮销毁重建**：目标目录不变时直接复用（此前每天约 1.1 万次重建）；缓冲区 4KB→64KB；缓冲溢出只标记失效待重建，不再直接触发扫描。
- **0 变化不上报**：无新事件且来源状态实质未变时，最多每 15 分钟上报一次状态（此前每轮扫描都 POST，单机一天约 1.1 万次请求）；状态实质变化仍立即上报。
- **手动全量扫描不再重置自动 24 小时计时器**：修复一次手动扫描把下次自动全量顺延的问题（实测出现过 39 小时间隔）。
- **采集器日志按天轮转**：日志从单个 `log.txt` 改为 `logs\<yyyy-MM>\log-<yyyy-MM-dd>.txt`，以凌晨 4 点为一天的分界（4 点前算前一天），按月分文件夹，历史日志永不删除。旧的单文件 `log.txt` 会在新版首次写日志时自动移动到 `logs\archive\log-legacy.txt` 归档，内容不丢失。

### 新增

- **服务端文件日志**：新增 `<数据目录>/logs/<YYYY-MM>/log-<YYYY-MM-DD>.txt`（腾讯云部署落在宿主机 `data/logs/`），与采集器同一套轮转策略：按天轮转、4 点分界、按月分文件夹、永不删除；时间戳与日期分界固定按北京时间（UTC+8）计算，不依赖容器时区。
- **服务端 HTTP 访问日志**：每次 API/页面请求记录一行 `[access] 方法 路径 状态码 耗时`；Docker 健康检查请求带 `x-simmer-health` 标记头，不计入日志。
- 服务端 `console.log/warn/error` 输出同步落盘一份，`docker logs` 行为不变。

### 变更

- **macOS 采集端日志按天轮转**：与 Windows 采集器同一套策略——日志改为 `~/Library/Application Support/SimmerCollector/logs/<YYYY-MM>/log-<YYYY-MM-DD>.txt`，本地时间凌晨 4 点为一天分界、按月分文件夹、永不删除；旧版单文件 `mac-collector.log` 自动归档到 `logs/archive/`，内容不丢失。
- **macOS Token 解析器升级**：`tokscale-core` 由 `b069c85` 升至 `1d9a939`（v4.17.0），`PARSER_VERSION` 同步为 `tokscale-1d9a939-wb1`（扫描器与采集端两端必须一致）。实测同一份数据下新旧解析器结果几乎一致（DSH 事件 4782 → 4783），同时确认 9-19 的 DSH 版本化文件名匹配对 `session.v4.jsonl.zstd` 依然有效。
- **macOS 状态脚本适配**：`查看 Jitang Simmer 状态.command` 改为按轮转规则定位当日日志。

### 部署变更

- `deploy/compose.yaml` 与 `deploy/compose.tencent-collector.yaml` 给 simmer 服务设置 `TZ: Asia/Shanghai`。
- `deploy/Dockerfile` 健康检查请求加 `x-simmer-health` 头，更新后需重新构建镜像。

## 0.10.1

- 安装包构建脚本改为 UTF-8 with BOM，安装包版本升至 0.10.1。

## 0.10.0

- 采集端与服务端 0.10 基线（AI Token 统计、硬件监控、macOS 采集端、Windows 安装包与中心面板）。
