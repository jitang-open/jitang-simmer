<div align="center">

# 🍲 Jitang Simmer · 鸡汤电脑统计

**个人电脑使用情况统计面板** —— 软件时长 / 硬件监控 / 多设备聚合

GitHub Contributions 式点阵图 × Spotify 深色绿色系 · 纯前端零依赖

</div>

---

## ✨ 功能特性

- **🖥️ 软件使用时长统计**：GitHub 风格年度点阵图、24 小时 / 近 7 天 / 近一年趋势折线图、分软件横向柱状图排行、时长占比环形图
- **🌡️ 硬件监控**：CPU / GPU 占用、内存 / 显存占用、CPU / GPU 温度、整机功耗、硬盘占用——8 张折线图卡片联动切换粒度
- **📋 白名单**：只统计白名单内软件，开关即时生效、全站图表实时重算，状态持久化（localStorage）
- **💻 多设备**：每台电脑独立统计上传，主页面默认汇总，可切换查看单台设备
- **📅 三种时间粒度**：每日（24 小时分布）/ 每周（近 7 天）/ 累计（近一年），全局一键切换
- **🎨 三图同屏详情**：点击任意软件行展开——柱状图（星期分布）与折线图（时长趋势）并排，点阵图（年度记录）独占一行
- **🌙 半隐藏式滚动条、滚动跟随导航、移动端抽屉菜单** 等一整套流畅动效

## 🚀 如何运行

**M1 起系统由三个部分组成**：

```
collector/（C# 采集端·每台电脑） ──上报──▶ server/（Node 后端·SQLite） ◀──查询── 前端（本仓库根目录）
```

1. **启动后端**：使用 Node.js 22，执行 `cd server && npm install && npm start` → `http://localhost:8788`（首启自动生成 `config.json` 含上报 token）
2. **启动采集端**：`cd collector/SimmerCollector && dotnet build -c Release`，运行 `bin/Release/net8.0-windows/SimmerCollector.exe`，托盘右键「设置」填入 Token（无后端时前端自动回退演示数据）
3. **查看面板**：直接访问 `http://localhost:8788/index.html`（顶栏显示 ● 实时数据）

> 无后端时双击 `index.html` 仍可看内置演示假数据（固定种子，365 天 × 3 设备 × 13 软件）。

## 🛠️ 技术栈

- **前端**：HTML + CSS + 原生 JavaScript，零框架、零图表库、零构建；图表手写 SVG（Catmull-Rom 平滑折线、绝对时长 6 档点阵图等）
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
- [ ] 采集端进程映射编辑器与开机自启（CAP-02/04 收尾）
- [ ] 白名单云端同步、多设备长期运行打磨
- [ ] 前端增强（实时仪表 / 时段热力图 / 成就 / 命令面板等，见需求文档 FE 系列）

## 📄 License

[MIT](./LICENSE)
