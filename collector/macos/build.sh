#!/bin/zsh
# ============================================================
# build.sh · macOS 采集端构建（对应 Windows 的 collector/build.ps1）
#   1) cargo build --release  → simmer-token-scan（Rust Token 扫描器）
#   2) swiftc -O              → simmer-fg-probe（前台应用与空闲探针）
#   3) 复制到 collector/ 根目录，供采集代理调用
#
# 用法：./build.sh [输出目录]
#   cargo 缺失时提示安装 Rust；swiftc 随 Xcode CommandLineTools 提供。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"        # collector/macos
COLLECTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"     # collector
OUTPUT_DIR="${1:-$COLLECTOR_ROOT}"
mkdir -p "$OUTPUT_DIR"

# ---- 1) Rust Token 扫描器 ----
SCANNER_SOURCE="$SCRIPT_DIR/../SimmerTokenScan"
if [ -d "$SCANNER_SOURCE" ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "未找到 cargo，请先安装 Rust：brew install rust" >&2
    exit 1
  fi
  echo "==> 构建 simmer-token-scan (cargo)"
  (cd "$SCANNER_SOURCE" && cargo build --release)
  cp "$SCANNER_SOURCE/target/release/simmer-token-scan" "$OUTPUT_DIR/simmer-token-scan"
  chmod +x "$OUTPUT_DIR/simmer-token-scan"
elif [ -x "$OUTPUT_DIR/simmer-token-scan" ]; then
  echo "==> 跳过 simmer-token-scan：发行包内不含 Rust 源码，沿用已编译的二进制"
else
  echo "未找到 SimmerTokenScan 源码，也没有现成的 simmer-token-scan 二进制" >&2
  exit 1
fi

# ---- 2) Swift 前台探针 + 硬件探针 ----
if ! command -v swiftc >/dev/null 2>&1; then
  echo "未找到 swiftc，请先安装 Xcode CommandLineTools：xcode-select --install" >&2
  exit 1
fi
mkdir -p "$SCRIPT_DIR/build"

echo "==> 构建 simmer-fg-probe (swiftc)"
swiftc -O -o "$SCRIPT_DIR/build/simmer-fg-probe" \
  "$SCRIPT_DIR/Sources/simmer-fg-probe/main.swift" \
  -framework AppKit -framework CoreGraphics
cp "$SCRIPT_DIR/build/simmer-fg-probe" "$OUTPUT_DIR/simmer-fg-probe"
chmod +x "$OUTPUT_DIR/simmer-fg-probe"

echo "==> 构建 simmer-hw-probe (swiftc)"
swiftc -O -o "$SCRIPT_DIR/build/simmer-hw-probe" \
  "$SCRIPT_DIR/Sources/simmer-hw-probe/main.swift" \
  -framework IOKit -framework Foundation
cp "$SCRIPT_DIR/build/simmer-hw-probe" "$OUTPUT_DIR/simmer-hw-probe"
chmod +x "$OUTPUT_DIR/simmer-hw-probe"

# ---- 3) 菜单栏状态图标（打包成 .app，附件应用不占 Dock） ----
echo "==> 构建 simmer-menubar (swiftc + .app)"
swiftc -O -o "$SCRIPT_DIR/build/simmer-menubar" \
  "$SCRIPT_DIR/Sources/simmer-menubar/main.swift" \
  -framework AppKit

# 菜单栏图标是面向用户的应用，放在安装根目录（OUTPUT_DIR 的上一级），
# 与「Jitang Simmer.app」并列，便于在访达里找到
MENUBAR_APP="$(dirname "$OUTPUT_DIR")/Jitang Simmer 图标.app"
rm -rf "$MENUBAR_APP"
mkdir -p "$MENUBAR_APP/Contents/MacOS"
cp "$SCRIPT_DIR/build/simmer-menubar" "$MENUBAR_APP/Contents/MacOS/simmer-menubar"
chmod +x "$MENUBAR_APP/Contents/MacOS/simmer-menubar"
cat > "$MENUBAR_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>simmer-menubar</string>
	<key>CFBundleIdentifier</key>
	<string>io.jitang.simmer.menubar</string>
	<key>CFBundleName</key>
	<string>Jitang Simmer 图标</string>
	<key>CFBundleDisplayName</key>
	<string>Jitang Simmer 图标</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.12.0</string>
	<key>CFBundleVersion</key>
	<string>0.12.0</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<!-- 只在菜单栏出现，不占 Dock、不进程序切换器 -->
	<key>LSUIElement</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
PLIST

echo ""
echo "构建完成："
echo "  $OUTPUT_DIR/simmer-token-scan"
echo "  $OUTPUT_DIR/simmer-fg-probe"
echo "  $OUTPUT_DIR/simmer-hw-probe"
echo "  $MENUBAR_APP"
