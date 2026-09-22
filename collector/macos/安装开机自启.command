#!/bin/zsh
# ============================================================
# 安装开机自启（macOS）：注册两个 LaunchAgent
#   1) io.jitang.simmer.collector  登录后自动运行采集代理
#   2) io.jitang.simmer.menubar    登录后显示菜单栏状态图标
# 对应 Windows 采集器的「登录 Windows 后自动启动采集器」。
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"
LABEL="io.jitang.simmer.collector"
MENUBAR_LABEL="io.jitang.simmer.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MENUBAR_PLIST="$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
RUNNER="$DIST/collector/macos/autostart-run.sh"
MENUBAR_BIN="$DIST/Jitang Simmer 图标.app/Contents/MacOS/simmer-menubar"

chmod +x "$RUNNER"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/zsh</string>
		<string>$RUNNER</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<!-- 仅在非正常退出（崩溃）时重启；正常退出不重启，
	     避免“已有实例在运行→本实例退出→被立刻重启”的循环 -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$DIST/logs/launchd.out.log</string>
	<key>StandardErrorPath</key>
	<string>$DIST/logs/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

# ---- 菜单栏状态图标（若已构建） ----
MENUBAR_INSTALLED=0
if [ -x "$MENUBAR_BIN" ]; then
  cat > "$MENUBAR_PLIST" <<MENUBAR_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$MENUBAR_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$MENUBAR_BIN</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<!-- 同上：从菜单里主动退出后不再自动拉起 -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
</dict>
</plist>
MENUBAR_EOF
  MENUBAR_INSTALLED=1
fi

# 已加载则先卸载，保证新路径生效；bootstrap 做退避重试（卸载有竞态）
reload_agent() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl enable "gui/$(id -u)/$label" 2>/dev/null || true
  local attempt=1
  while [ "$attempt" -le 8 ]; do
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && return 0
    sleep 1
    [ "$attempt" -ge 3 ] && launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
    attempt=$((attempt + 1))
  done
  launchctl load -w "$plist" 2>/dev/null
}

if reload_agent "$LABEL" "$PLIST"; then
  echo "✓ 已安装开机自启：采集代理（登录后自动运行）"
else
  echo "⚠️ 采集代理自启加载失败，可稍后重试"
fi

if [ "$MENUBAR_INSTALLED" = "1" ]; then
  if reload_agent "$MENUBAR_LABEL" "$MENUBAR_PLIST"; then
    echo "✓ 已安装开机自启：菜单栏状态图标"
  else
    echo "⚠️ 菜单栏图标自启加载失败；可直接双击「Jitang Simmer 图标.app」手动打开"
  fi
else
  echo "· 未找到菜单栏图标应用（$MENUBAR_BIN），跳过"
fi

echo ""
echo "  登录后将自动：运行采集代理 + 在菜单栏显示状态图标。"
echo "  卸载请双击「卸载开机自启.command」"
