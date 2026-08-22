<div align="center">

# 🍲 Jitang Simmer · 鸡汤电脑统计

**个人电脑使用情况统计面板** —— 软件时长 / 硬件监控 / 多设备聚合

GitHub Contributions 式点阵图 × Spotify 深色绿色系 · 本机真实数据闭环

</div>

---

## ✨ 功能特性

- **🖥️ 软件使用时长统计**：GitHub 风格年度点阵图、24 小时 / 近 7 天 / 近一年趋势折线图、分软件横向柱状图排行、时长占比环形图
- **🌡️ 硬件监控界面**：CPU / GPU 占用、内存 / 显存占用、CPU / GPU 温度、整机功耗、硬盘占用——8 张折线图卡片已完成；真实硬件采集属于 M1.5，当前实时模式显示占位状态
- **📋 白名单**：只统计白名单内软件，开关即时生效、全站图表实时重算；配置持久化到后端 SQLite，跨浏览器及 `localhost` / `127.0.0.1` 共享，localStorage 仅作缓存
- **💻 多设备**：每台电脑独立统计上传，主页面默认汇总，可切换查看单台设备
- **📅 三种时间粒度**：每日（24 小时分布）/ 每周（近 7 天）/ 累计（近一年），全局一键切换
- **🎨 三图同屏详情**：点击任意软件行展开——柱状图（星期分布）与折线图（时长趋势）并排，点阵图（年度记录）独占一行
- **🌙 半隐藏式滚动条、滚动跟随导航、移动端抽屉菜单** 等一整套流畅动效

## 🚀 如何运行

**M1 起系统由三个部分组成**：

```
collector/（C# 采集端·每台电脑） ──上报──▶ server/（Node 后端·SQLite） ◀──查询── 前端（本仓库根目录）
```

1. **启动后端**（必须使用 Node.js 22）：首次运行在 `server/` 执行 `npm install`，以后执行 `npm start`。首启会自动生成 `server/config.json`，其中包含采集端需要的上报 Token。后端窗口需保持运行。
2. **启动采集端**：当前开发机可直接运行 `collector/SimmerCollector.exe`；从源码构建时，在 `collector/SimmerCollector/` 执行 `dotnet build -c Release`，再运行 `bin/Release/net8.0-windows/SimmerCollector.exe`。托盘右键「设置」，填写服务器地址与 `server/config.json` 中的 Token。
3. **查看面板**：访问 `http://127.0.0.1:8788/index.html` 或 `http://localhost:8788/index.html`；顶栏显示“● 实时数据”即连接成功。两个地址及不同浏览器共享同一份后端白名单配置。

当前开发机的默认 `node` 是 24，与现有 `better-sqlite3` 二进制不兼容；可在 `server/` 目录直接运行：

```powershell
& "C:\Users\jitang\.local\nodejs\node.exe" index.js
```

> 无后端时双击 `index.html` 仍可看内置演示假数据（固定种子，2022-01-01 至今 × 3 设备 × 13 软件）。

## 🛠️ 技术栈

- **前端**：HTML + CSS + 原生 JavaScript，零框架、零图表库、零构建；图表手写 SVG（Catmull-Rom 平滑折线、按各图 P95 独立分档的点阵图等）
- **采集端**：C# / .NET 8 WinForms 托盘程序，P/Invoke（`GetForegroundWindow` 前台监听、`GetLastInputInfo` 空闲检测），本地队列断网不丢、失败自动重试
- **后端**：Node.js Express + better-sqlite3；上报接口 Bearer token 鉴权 + 幂等；查询接口与前端 mock 层同构，可无缝切换

## 📁 目录结构

```
├── index.html          # 前端页面（侧边栏 + 顶栏 + 六大区块）
├── css/style.css       # GitHub × Spotify 深色主题与动效
├── js/
│   ├── data.js         # MockDB：演示假数据（后端不可用时回退）
│   ├── live.js         # LiveDB：实时数据源（对接后端，与 MockDB 同构）
│   ├── charts.js       # 图表渲染引擎（heatmap / line / hbars / donut / vbars）
│   └── app.js          # 状态管理 + 渲染调度
├── collector/          # C# 采集端（WinForms 托盘，M1）
├── server/             # Node.js 中心后端（Express + SQLite，M1）
└── docs/               # 交接文档 / 需求文档
```

## 🗺️ 路线图

- [x] M1 最小闭环：Windows 采集端（前台窗口 + 空闲检测 + 托盘 + 断网缓存）+ Node 后端（上报 + SQLite + 聚合接口）+ 前端实时数据源 ✅ 2026-08-21
- [ ] M1.5：硬件指标采集（LibreHardwareMonitor：CPU/GPU 温度、功耗、占用、显存、硬盘）
- [x] 白名单 / 软件名称 / 颜色 / 分类后端持久化，跨浏览器与跨 origin 共享 ✅ v0.6.6
- [x] 年度点阵图按各图 P95 独立比例分档 ✅ v0.6.7
- [ ] 采集端开机自启（CAP-04 收尾）
- [ ] 扩充自动测试与多设备长期运行打磨
- [ ] 前端增强（实时仪表 / 时段热力图 / 成就 / 命令面板等，见需求文档 FE 系列）

## 📄 License

[MIT](./LICENSE)
