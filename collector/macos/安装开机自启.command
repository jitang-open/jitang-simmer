#!/bin/zsh
# ============================================================
# 安装开机自启（macOS）：注册 LaunchAgent，登录后自动运行采集代理
# 对应 Windows 采集器的「登录 Windows 后自动启动采集器」。
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"
LABEL="io.jitang.simmer.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$DIST/collector/macos/autostart-run.sh"

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

# 已加载则先卸载，保证新路径生效
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "✓ 已安装开机自启：$PLIST"
  echo "  登录后自动运行采集代理（软件时长 + Token），无需手动启动。"
else
  launchctl load -w "$PLIST" 2>/dev/null || true
  echo "✓ 已安装开机自启（旧式加载）：$PLIST"
fi
echo "  卸载请双击「卸载开机自启.command」"
