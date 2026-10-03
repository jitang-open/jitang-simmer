# 更新日志

本文件记录 Jitang Simmer 的用户可见变更。**今后每次改动随代码一同提交推送**，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 未发布

### 修复

- **采集器日志按天轮转**：日志从单个 `log.txt` 改为 `logs\<yyyy-MM>\log-<yyyy-MM-dd>.txt`，以凌晨 4 点为一天的分界（4 点前算前一天），按月分文件夹，历史日志永不删除。旧的单文件 `log.txt` 会在新版首次写日志时自动移动到 `logs\archive\log-legacy.txt` 归档，内容不丢失。（背景：Token 扫描高频日志曾把单文件刷到 24 万行，历史记录几乎不可读。）

### 新增

- **服务端文件日志**：新增 `<数据目录>/logs/<YYYY-MM>/log-<YYYY-MM-DD>.txt`（腾讯云部署落在宿主机 `data/logs/`），与采集器同一套轮转策略：按天轮转、4 点分界、按月分文件夹、永不删除；时间戳与日期分界固定按北京时间（UTC+8）计算，不依赖容器时区。
- **服务端 HTTP 访问日志**：每次 API/页面请求记录一行 `[access] 方法 路径 状态码 耗时`；Docker 健康检查请求带 `x-simmer-health` 标记头，不计入日志。
- 服务端 `console.log/warn/error` 输出同步落盘一份，`docker logs` 行为不变。

### 部署变更

- `deploy/compose.yaml` 与 `deploy/compose.tencent-collector.yaml` 给 simmer 服务设置 `TZ: Asia/Shanghai`。
- `deploy/Dockerfile` 健康检查请求加 `x-simmer-health` 头，更新后需重新构建镜像。

## 0.10.1

- 安装包构建脚本改为 UTF-8 with BOM，安装包版本升至 0.10.1。

## 0.10.0

- 采集端与服务端 0.10 基线（AI Token 统计、硬件监控、macOS 采集端、Windows 安装包与中心面板）。
