#!/bin/zsh
# ============================================================
# build-macos-pkg.sh · 生成 macOS 安装包（.pkg）
# 对应 Windows 的 installer/build-installer.ps1
#
# 产物：artifacts/Jitang-Simmer-macOS-arm64.pkg
#   - 安装到 /Applications/Jitang Simmer
#   - 写入 collector-config.json（聚合服务器地址 + 上报 Token + 面板地址）
#   - 安装并加载当前登录用户的 LaunchAgent（登录后自动采集）
#
# 用法：
#   ./build-macos-pkg.sh --server-url https://119.45.179.55/simmer --token <token>
#   ./build-macos-pkg.sh --source /path/to/Jitang-Simmer-macOS   # 指定发行目录
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR=""
OUTPUT_FILE="$REPO_ROOT/artifacts/Jitang-Simmer-macOS-arm64.pkg"
IDENTIFIER="io.jitang.simmer.macos.pkg"
VERSION="0.11.0"
SERVER_URL=""
TOKEN=""
DASHBOARD_URL=""
# 安装域：user = 装到 ~/Applications（无需管理员，推荐）；
#         system = 装到 /Applications（需要管理员密码）
DOMAIN="user"
INSTALL_LOCATION="Applications/Jitang Simmer"

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --output) OUTPUT_FILE="$2"; shift 2 ;;
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --dashboard-url) DASHBOARD_URL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --identifier) IDENTIFIER="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

# ---- 未指定发行目录时自动探测（仓库内 → 仓库同级构建产物目录） ----
if [ -z "$SOURCE_DIR" ]; then
  if [ -d "$REPO_ROOT/Jitang-Simmer-macOS" ]; then
    SOURCE_DIR="$REPO_ROOT/Jitang-Simmer-macOS"
  else
    SOURCE_DIR="$(cd "$REPO_ROOT/.." && pwd)/Jitang-Simmer-macOS"
  fi
fi

case "$DOMAIN" in
  user)   INSTALL_LOCATION="Applications/Jitang Simmer" ;;
  system) INSTALL_LOCATION="/Applications/Jitang Simmer" ;;
  *) echo "--domain 只能是 user 或 system" >&2; exit 1 ;;
esac

if [ ! -d "$SOURCE_DIR" ]; then
  echo "发行目录不存在：$SOURCE_DIR" >&2
  exit 1
fi
# ---- 未显式指定时，从发行目录已有的采集端配置读取 ----
SOURCE_CONFIG="$SOURCE_DIR/collector/macos/collector-config.json"
if [ -z "$SERVER_URL" ] || [ -z "$TOKEN" ]; then
  if [ ! -f "$SOURCE_CONFIG" ]; then
    echo "缺少 --server-url / --token，且发行目录内没有 collector-config.json" >&2
    exit 1
  fi
  [ -z "$SERVER_URL" ] && SERVER_URL="$(/usr/bin/python3 -c "import json;print(json.load(open('$SOURCE_CONFIG')).get('serverUrl',''))")"
  [ -z "$TOKEN" ] && TOKEN="$(/usr/bin/python3 -c "import json;print(json.load(open('$SOURCE_CONFIG')).get('token',''))")"
  [ -z "$DASHBOARD_URL" ] && DASHBOARD_URL="$(/usr/bin/python3 -c "import json;print(json.load(open('$SOURCE_CONFIG')).get('dashboardUrl',''))" || true)"
fi
SERVER_URL="${SERVER_URL%/}"

# ---- 由上报地址推导面板地址（与 Windows 安装器同一规则） ----
if [ -z "$DASHBOARD_URL" ]; then
  case "$SERVER_URL" in
    */simmer) DASHBOARD_URL="${SERVER_URL%/simmer}/simmer-dashboard/" ;;
    *) DASHBOARD_URL="$SERVER_URL/index.html" ;;
  esac
fi
[ -z "$TOKEN" ] && { echo "上报 Token 为空" >&2; exit 1; }

BUILD_ROOT="$REPO_ROOT/artifacts/pkg-build"
PAYLOAD="$BUILD_ROOT/payload"
SCRIPTS="$BUILD_ROOT/scripts"
rm -rf "$BUILD_ROOT"
mkdir -p "$PAYLOAD" "$SCRIPTS" "$(dirname "$OUTPUT_FILE")"

echo "==> 组装载荷"
# 排除运行期数据与日志，保持安装包干净
# COPYFILE_DISABLE：避免 macOS 生成 ._* AppleDouble 文件（pkgbuild 会因此报错）
export COPYFILE_DISABLE=1
rsync -a --exclude '._*' \
  --exclude 'server/data' \
  --exclude 'server/config.json' \
  --exclude 'logs/*' \
  --exclude 'collector/macos/build' \
  "$SOURCE_DIR/" "$PAYLOAD/"

# 清除扩展属性，避免 AppleDouble 残留
find "$PAYLOAD" -name '._*' -delete 2>/dev/null || true
xattr -cr "$PAYLOAD" 2>/dev/null || true

# ---- 写入采集端配置（聚合模式） ----
cat > "$PAYLOAD/collector/macos/collector-config.json" <<JSON
{
  "serverUrl": "$SERVER_URL",
  "dashboardUrl": "$DASHBOARD_URL",
  "token": "$TOKEN",
  "uploadIntervalMinutes": 5,
  "tokenIntervalMinutes": 15,
  "idleThresholdMinutes": 5
}
JSON

# ---- 权限 ----
chmod +x "$PAYLOAD"/*.command 2>/dev/null || true
chmod +x "$PAYLOAD"/collector/macos/*.sh 2>/dev/null || true
chmod +x "$PAYLOAD"/collector/simmer-* 2>/dev/null || true
chmod +x "$PAYLOAD/Jitang Simmer.app/Contents/MacOS/JitangSimmer" 2>/dev/null || true
mkdir -p "$PAYLOAD/logs"

echo "==> 生成安装后脚本"
cat > "$SCRIPTS/postinstall" <<'POSTINSTALL'
#!/bin/sh
# 安装后：为当前登录用户安装并加载 LaunchAgent（登录后自动采集）
set -u
LABEL="io.jitang.simmer.collector"
LOG="/tmp/jitang-simmer-postinstall.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# 目标用户：控制台登录用户
CONSOLE_USER="$(stat -f "%Su" /dev/console 2>/dev/null || echo "")"
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ] || [ "$CONSOLE_USER" = "loginwindow" ]; then
  CONSOLE_USER="$(/usr/bin/dscl . -list /Users 2>/dev/null | grep -v '^_' | grep -v '^root$' | head -1)"
fi
if [ -z "$CONSOLE_USER" ]; then
  log "未找到登录用户，跳过 LaunchAgent（可稍后双击「安装开机自启.command」）"
  exit 0
fi
USER_HOME="$(/usr/bin/dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -z "$USER_HOME" ] && USER_HOME="/Users/$CONSOLE_USER"
UID_NUM="$(id -u "$CONSOLE_USER" 2>/dev/null || echo "")"
log "目标用户 $CONSOLE_USER (uid=$UID_NUM) home=$USER_HOME"
[ -z "$UID_NUM" ] && exit 0

# 安装目录：用户域在 ~/Applications，系统域在 /Applications
if [ -d "$USER_HOME/Applications/Jitang Simmer" ]; then
  APP_DIR="$USER_HOME/Applications/Jitang Simmer"
elif [ -d "/Applications/Jitang Simmer" ]; then
  APP_DIR="/Applications/Jitang Simmer"
else
  APP_DIR="$USER_HOME/Applications/Jitang Simmer"
fi
log "安装目录 $APP_DIR"

LA_DIR="$USER_HOME/Library/LaunchAgents"
/bin/mkdir -p "$LA_DIR"
PLIST="$LA_DIR/$LABEL.plist"
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
		<string>$APP_DIR/collector/macos/autostart-run.sh</string>
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
	<string>$APP_DIR/logs/launchd.out.log</string>
	<key>StandardErrorPath</key>
	<string>$APP_DIR/logs/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

/bin/chown -R "$CONSOLE_USER" "$USER_HOME/Library/LaunchAgents" 2>/dev/null || true
/bin/chmod 644 "$PLIST"

# 重新加载：升级场景先卸载旧的。
# 注意：bootout 之后 launchd 需要一点时间完成卸载，紧接着 bootstrap 同一 label
# 会返回错误，因此这里做退避重试（这是升级安装最容易踩的坑）。
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true

LOADED=0
ATTEMPT=1
while [ "$ATTEMPT" -le 8 ]; do
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    LOADED=1
    break
  fi
  sleep 1
  [ "$ATTEMPT" -ge 3 ] && launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
  ATTEMPT=$((ATTEMPT + 1))
done

if [ "$LOADED" = "1" ]; then
  log "LaunchAgent 已加载（第 $ATTEMPT 次尝试）"
else
  # 最后兜底：旧式 load
  if launchctl load -w "$PLIST" 2>/dev/null; then
    log "LaunchAgent 已通过 load -w 加载"
  else
    log "LaunchAgent 加载失败，可手动双击应用目录内「安装开机自启.command」"
  fi
fi

# 若已加载但未运行，主动拉起一次
launchctl kickstart "gui/$UID_NUM/$LABEL" 2>/dev/null || true

# 目录归属：日志与状态文件由用户写入
/bin/chown -R "$CONSOLE_USER" "$APP_DIR/logs" 2>/dev/null || true

# Node 检查（采集代理与后端需要 Node 24）
if ! command -v node >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/node ] && [ ! -x /usr/local/bin/node ]; then
  log "警告：未检测到 Node.js，采集代理无法运行"
fi
log "postinstall 完成"
exit 0
POSTINSTALL
chmod +x "$SCRIPTS/postinstall"

echo "==> pkgbuild 组件包"
COMPONENT="$BUILD_ROOT/JitangSimmer-component.pkg"
pkgbuild \
  --root "$PAYLOAD" \
  --identifier "$IDENTIFIER.component" \
  --version "$VERSION" \
  --install-location "$INSTALL_LOCATION" \
  --scripts "$SCRIPTS" \
  "$COMPONENT" >/dev/null

echo "==> productbuild 分发用安装包"
DIST_XML="$BUILD_ROOT/distribution.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Jitang Simmer · 鸡汤时迹</title>
    <organization>io.jitang</organization>
    <domains enable_localSystem="$([ "$DOMAIN" = "system" ] && echo true || echo false)" enable_currentUserHome="$([ "$DOMAIN" = "user" ] && echo true || echo false)" enable_anywhere="false"/>
    <options customize="never" require-scripts="true" hostArchitectures="arm64"/>
    <allowed-os-versions>
        <os-version min="12.0"/>
    </allowed-os-versions>
    <volume-check>
        <allowed-os-versions>
            <os-version min="12.0"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default">
            <line choice="$IDENTIFIER.component"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="$IDENTIFIER.component" visible="false">
        <pkg-ref id="$IDENTIFIER.component"/>
    </choice>
    <pkg-ref id="$IDENTIFIER.component" version="$VERSION" onConclusion="none">JitangSimmer-component.pkg</pkg-ref>
</installer-gui-script>
XML

productbuild \
  --distribution "$DIST_XML" \
  --package-path "$BUILD_ROOT" \
  "$OUTPUT_FILE" >/dev/null

echo ""
echo "构建完成：$OUTPUT_FILE"
echo "  安装位置：$INSTALL_LOCATION"
echo "  聚合地址：$SERVER_URL"
echo "  面板地址：$DASHBOARD_URL"
ls -lh "$OUTPUT_FILE"
