#!/bin/zsh
# 卸载开机自启（macOS）：移除 LaunchAgent
set -u
LABEL="io.jitang.simmer.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
if [ -f "$PLIST" ]; then
  rm -f "$PLIST" && echo "✓ 已移除开机自启：$PLIST"
else
  echo "开机自启未安装"
fi
echo "提示：若仍需统计，请双击「启动 Jitang Simmer.command」手动启动。"
