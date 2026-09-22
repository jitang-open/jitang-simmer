#!/bin/zsh
# 卸载开机自启（macOS）：移除采集代理与菜单栏图标的 LaunchAgent
set -u
UID_NUM="$(id -u)"

remove_agent() {
  local label="$1" desc="$2"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || launchctl unload -w "$plist" 2>/dev/null || true
  if [ -f "$plist" ]; then
    rm -f "$plist" && echo "✓ 已移除开机自启：$desc"
  else
    echo "· $desc 未安装"
  fi
}

remove_agent "io.jitang.simmer.collector" "采集代理"
remove_agent "io.jitang.simmer.menubar" "菜单栏状态图标"

# 菜单栏图标进程随自启卸载一并结束（采集器不动，见下方提示）
pkill -x simmer-menubar 2>/dev/null && echo "✓ 已关闭菜单栏图标"
echo ""
echo "提示：若仍需统计，请双击「启动 Jitang Simmer.command」手动启动。"
