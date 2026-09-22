#!/bin/zsh
# ============================================================
# 卸载 Jitang Simmer（macOS）
#  - 停止并移除 LaunchAgent
#  - 移动应用目录到废纸篓（保留采集历史数据的选项见提示）
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"
LABEL="io.jitang.simmer.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="$HOME/Library/Application Support/SimmerCollector"

echo "即将卸载 Jitang Simmer（$DIST）"
echo ""
echo "说明："
echo "  · 采集历史数据保存在 $DATA_DIR"
echo "  · 本次卸载不会删除该目录（如需彻底清除请手动删除）"
echo ""
printf "确认卸载？(y/N) "
read answer
case "$answer" in
  y|Y) ;;
  *) echo "已取消"; exit 0 ;;
esac

# 1) 停止并移除 LaunchAgent
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" && echo "✓ 已移除开机自启"
else
  echo "· 未安装开机自启"
fi

# 2) 停止残留进程
pkill -f "simmer-collector.js" 2>/dev/null && echo "✓ 已停止采集代理"
pkill -f "simmer-fg-probe" 2>/dev/null || true
pkill -f "simmer-hw-probe" 2>/dev/null || true

# 3) 应用目录移入废纸篓（比 rm -rf 安全，可恢复）
PARENT="$(dirname "$DIST")"
if [ "$PARENT" = "$HOME/Applications" ]; then
  # 只移走本应用目录，保留 ~/Applications 本身
  osascript -e "tell application \"Finder\" to delete POSIX file \"$DIST\"" >/dev/null 2>&1 \
    && echo "✓ 应用已移入废纸篓" \
    || { rm -rf "$DIST" && echo "✓ 应用目录已删除"; }
else
  osascript -e "tell application \"Finder\" to delete POSIX file \"$DIST\"" >/dev/null 2>&1 \
    && echo "✓ 应用已移入废纸篓" || echo "· 请手动删除：$DIST"
fi
echo ""
echo "卸载完成。采集历史数据仍在：$DATA_DIR"
