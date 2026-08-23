<div align="center">

# 🍲 Jitang Simmer · 鸡汤电脑统计

**个人电脑使用情况统计面板** —— 软件时长 / AI Token / 硬件监控 / 多设备聚合

GitHub Contributions 式点阵图 × Spotify 深色绿色系 · 本机真实数据闭环

</div>

---

## ✨ 功能特性

- **🖥️ 软件使用时长统计**：GitHub 风格年度点阵图、24 小时 / 近 7 天 / 近一年趋势折线图、分软件横向柱状图排行、时长占比环形图
- **🤖 AI Token Statistics**：请求级统计 Codex、ZCode、DeepSeek Harness 和 WorkBuddy；展示输入、输出、缓存读取/写入、推理、总 Token、年度点阵、来源/模型排行；来源/provider 使用统一下拉、模型支持多选，支持日/周/月/自定义/累计，年度点阵最高按 1 亿 Tokens 顶格；已经上传的历史不随本地日志、工具或扫描路径消失
- **🌡️ 硬件监控**：基于 LibreHardwareMonitor 0.9.6 每分钟采集 CPU / GPU 占用、内存 / 显存占用、CPU / GPU 温度、可用功耗和硬盘占用；逐项缺失显示为不可用，不阻塞软件时长或 Token 统计
- **📋 白名单**：只统计白名单内软件，开关即时生效、全站图表实时重算；添加软件时可搜索、滚动选择已观测进程或手动输入，软件类型使用统一下拉，清空必须二次确认；配置持久化到后端 SQLite，跨浏览器及 `localhost` / `127.0.0.1` 共享
- **💻 多设备**：每台电脑独立统计上传，主页面默认汇总，可切换查看单台设备
- **🗓️ 日期下钻**：点击软件或 Token 年度点阵格即可查看当天；两个卡片都使用与设备选择器一致的暗色下拉日历，可独立选择日、自然周、自然月或任意起止日期，Token 另有累计全部历史
- **🎨 Token 多模型趋势**：模型筛选支持多选，同一折线图可同时展示多个模型，并使用稳定的独立颜色
- **⏸️ 设备管理**：侧边栏可修改设备显示名并暂停/恢复统计；暂停不删除历史，显示名不会被后续采集上报覆盖
- **🚀 开机自启**：托盘设置可选择“登录 Windows 后自动启动采集器”；使用当前用户启动项，无需管理员权限，关闭开关会清理自身启动项
- **📅 总览时间粒度**：顶栏提供每日（24 小时分布）/ 每周（近 7 天）/ 累计（趋势显示近 12 个月）；总时长和 Token 趋势默认收起，可按需展开
- **☁️ 腾讯云部署**：`deploy/` 提供 Node.js 24 + Caddy Docker Compose，支持自动 HTTPS、面板 Basic Auth、采集端 Bearer Token 与 SQLite 持久卷
- **🎨 三图同屏详情**：点击任意软件行展开——柱状图（星期分布）与折线图（时长趋势）并排，点阵图（年度记录）独占一行
- **🌙 半隐藏式滚动条、滚动跟随导航、移动端抽屉菜单** 等一整套流畅动效

## 🚀 如何运行

**系统由前端、后端、C# 采集器和 Rust Token sidecar 组成**：

```
本地 AI 日志 ──▶ simmer-token-scan.exe（Rust / tokscale-core）
                           │ 仅输出数字事件
collector/（C# 采集端） ──┴──上报──▶ server/（Node 后端·SQLite） ◀──查询── 前端
```

1. **启动后端**（使用 Node.js 24）：首次运行在 `server/` 执行 `npm install`，以后执行 `npm start`。首启会自动生成 `server/config.json`，其中包含采集端需要的上报 Token。后端窗口需保持运行。
2. **启动采集端**：当前开发机可直接运行 `collector/SimmerCollector.exe`，同目录需有 `simmer-token-scan.exe` 才能启用 AI Token 统计。托盘右键「设置」，填写服务器地址与 `server/config.json` 中的 Token；Codex/ZCode/DSH/WorkBuddy 数据目录留空即可自动检测，也可手动选择。需要常驻时勾选“登录 Windows 后自动启动采集器”。
3. **查看面板**：访问 `http://127.0.0.1:8788/index.html` 或 `http://localhost:8788/index.html`；顶栏显示“● 实时数据”即连接成功。两个地址及不同浏览器共享同一份后端白名单配置。

当前开发机也可直接双击 [`启动 Jitang Simmer.cmd`](./启动%20Jitang%20Simmer.cmd)，它会使用终端 PATH 中的 Node.js 24 启动后端、采集端并打开面板。若需从源码重新生成两个采集端程序，在 PowerShell 执行 `collector/build.ps1`。

如需显式使用当前开发机的 Node.js 24，可在 `server/` 目录运行：

```powershell
& "C:\Users\jitang\.local\nodejs\node.exe" index.js
```

> 无后端时双击 `index.html` 仍可看内置演示假数据（固定种子，2022-01-01 至今 × 3 设备 × 13 软件）。

## 🛠️ 技术栈

- **前端**：HTML + CSS + 原生 JavaScript，零框架、零图表库、零构建；图表手写 SVG（Catmull-Rom 平滑折线、按各图 P95 独立分档并设置业务硬上限的点阵图等）
- **采集端**：C# / .NET 8 WinForms 托盘程序，P/Invoke（`GetForegroundWindow` 前台监听、`GetLastInputInfo` 空闲检测）+ [LibreHardwareMonitorLib 0.9.6](https://www.nuget.org/packages/LibreHardwareMonitorLib/)（MPL-2.0），软件与硬件使用独立本地队列，断网不丢、失败自动重试
- **Token 解析器**：Rust 独立 sidecar，固定 `tokscale-core` 提交 `b069c85d530c35ba1a3517e80aaa8423428dccd8`；解析 Codex JSONL、ZCode SQLite、DSH JSONL/Zstandard 与 WorkBuddy 项目 JSONL，只向采集器输出五类互斥数字桶
- **后端**：Node.js Express + better-sqlite3；上报接口 Bearer token 鉴权 + 幂等；查询接口与前端 mock 层同构，可无缝切换

## 📁 目录结构

```
├── index.html          # 前端页面（侧边栏 + 顶栏 + 七大区块）
├── css/style.css       # GitHub × Spotify 深色主题与动效
├── js/
│   ├── data.js         # MockDB：演示假数据（后端不可用时回退）
│   ├── live.js         # LiveDB：实时数据源（对接后端，与 MockDB 同构）
│   ├── charts.js       # 图表渲染引擎（heatmap / line / hbars / donut / vbars）
│   └── app.js          # 状态管理 + 渲染调度
├── collector/
│   ├── SimmerCollector/ # C# 托盘采集、来源发现、离线队列与上报
│   ├── SimmerTokenScan/ # Rust 请求级 Token 解析 sidecar
│   └── build.ps1       # 生成两个本机运行 EXE
├── server/             # Node.js 中心后端（软件时长 + AI Token + 硬件 SQLite/API）
└── docs/               # 交接文档 / 需求文档
```

## 🗺️ 路线图

- [x] M1 最小闭环：Windows 采集端（前台窗口 + 空闲检测 + 托盘 + 断网缓存）+ Node 后端（上报 + SQLite + 聚合接口）+ 前端实时数据源 ✅ 2026-08-21
- [x] M1.5 Token Statistics：Codex / ZCode / DSH / WorkBuddy 来源发现、请求级解析、幂等存储、筛选与 Token 面板 ✅ v0.8.1（DSH V4 Flash 与 WorkBuddy 均已真实验收）
- [x] M2 硬件指标采集：LibreHardwareMonitor 分钟快照、离线队列、SQLite 幂等存储、聚合 API 与真实折线卡片 ✅ v0.9.0
- [x] 白名单 / 软件名称 / 颜色 / 分类后端持久化，跨浏览器与跨 origin 共享 ✅ v0.6.6
- [x] 年度点阵图按各图 P95 独立比例分档 ✅ v0.6.7
- [x] 全站下拉样式统一、Token 时间按钮、进程搜索滚动、清空确认与趋势默认收起 ✅ v0.7.1
- [x] 日期格下钻、统一下拉日历、日/周/月查询、Token 多模型折线、设备改名/暂停及腾讯云部署工程化 ✅ v0.8.0
- [x] 采集端当前用户级开机自启；软件/Token 任意起止日期、Token 累计；软件 5 小时与 Token 1 亿硬上限 ✅ v0.8.2
- [ ] 扩充自动测试与多设备长期运行打磨
- [ ] 前端增强（实时仪表 / 时段热力图 / 成就 / 命令面板等，见需求文档 FE 系列）

## 📄 License

[MIT](./LICENSE)
