#!/bin/bash
# 下载 PDFium 预编译库
# 使用 bblanchon/pdfium-binaries 项目的预编译版本

set -e

# 检测操作系统和架构
case "$(uname -s)" in
    Linux*)
        PLATFORM="linux"
        ;;
    Darwin*)
        PLATFORM="mac"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        PLATFORM="win"
        ;;
    *)
        echo "Unsupported OS: $(uname -s)"
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|amd64)
        ARCH="x64"
        ;;
    aarch64|arm64)
        ARCH="arm64"
        ;;
    armv7l)
        ARCH="arm"
        ;;
    *)
        echo "Unsupported architecture: $(uname -m)"
        exit 1
        ;;
esac

# 目标目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${SCRIPT_DIR}/../pdfium"
mkdir -p "$TARGET_DIR"

echo "Platform: ${PLATFORM}-${ARCH}"
echo "Target directory: ${TARGET_DIR}"

# 使用 bblanchon/pdfium-binaries 的 release
# https://github.com/AhmetAkgok/pdfium-binaries/releases
# 版本号格式: chromium/6721
PDFIUM_VERSION="6721"

# 构建下载 URL - 使用 bblanchon 的镜像
if [ "$PLATFORM" = "linux" ]; then
    if [ "$ARCH" = "x64" ]; then
        FILENAME="pdfium-linux-x64.tgz"
    elif [ "$ARCH" = "arm64" ]; then
        FILENAME="pdfium-linux-arm64.tgz"
    else
        echo "Unsupported Linux architecture: $ARCH"
        exit 1
    fi
elif [ "$PLATFORM" = "mac" ]; then
    if [ "$ARCH" = "arm64" ]; then
        FILENAME="pdfium-mac-arm64.tgz"
    else
        FILENAME="pdfium-mac-x64.tgz"
    fi
elif [ "$PLATFORM" = "win" ]; then
    FILENAME="pdfium-win-x64.tgz"
fi

# 尝试多个下载源
DOWNLOAD_URLS=(
    "https://github.com/AhmetAkgok/pdfium-binaries/releases/download/chromium/${PDFIUM_VERSION}/${FILENAME}"
    "https://github.com/AhmetAkgok/pdfium-binaries/releases/download/chromium%2F${PDFIUM_VERSION}/${FILENAME}"
)

TMP_FILE="/tmp/${FILENAME}"
DOWNLOADED=false

for URL in "${DOWNLOAD_URLS[@]}"; do
    echo "Trying: ${URL}"
    if curl -fsSL -o "$TMP_FILE" "$URL" 2>/dev/null; then
        # 验证是否为有效的 gzip 文件
        if file "$TMP_FILE" | grep -q "gzip"; then
            DOWNLOADED=true
            echo "Downloaded successfully!"
            break
        else
            echo "Downloaded file is not a valid gzip archive"
            rm -f "$TMP_FILE"
        fi
    else
        echo "Failed to download from this URL"
    fi
done

if [ "$DOWNLOADED" = false ]; then
    echo ""
    echo "❌ Failed to download PDFium from all sources."
    echo ""
    echo "Please download manually:"
    echo "1. Go to https://github.com/AhmetAkgok/pdfium-binaries/releases"
    echo "2. Download ${FILENAME}"
    echo "3. Extract to ${TARGET_DIR}"
    echo ""
    echo "Or install PDFium via package manager:"
    echo "  Ubuntu/Debian: apt-get install libpdfium-dev (if available)"
    echo "  macOS: brew install AhmetAkgok/pdfium/pdfium"
    exit 1
fi

# 解压
echo "Extracting to ${TARGET_DIR}..."
tar -xzf "$TMP_FILE" -C "$TARGET_DIR"
rm "$TMP_FILE"

# 检查库文件
if [ "$PLATFORM" = "linux" ]; then
    LIB_FILE="${TARGET_DIR}/lib/libpdfium.so"
elif [ "$PLATFORM" = "mac" ]; then
    LIB_FILE="${TARGET_DIR}/lib/libpdfium.dylib"
else
    LIB_FILE="${TARGET_DIR}/bin/pdfium.dll"
fi

if [ -f "$LIB_FILE" ]; then
    echo ""
    echo "✅ PDFium downloaded successfully!"
    echo "Library location: ${LIB_FILE}"
    
    # 创建符号链接到项目根目录
    if [ "$PLATFORM" = "linux" ]; then
        ln -sf "${TARGET_DIR}/lib/libpdfium.so" "${SCRIPT_DIR}/../libpdfium.so"
        echo ""
        echo "Symlink created: ${SCRIPT_DIR}/../libpdfium.so"
        echo ""
        echo "To use PDFium, add to your environment:"
        echo "  export LD_LIBRARY_PATH=${TARGET_DIR}/lib:\$LD_LIBRARY_PATH"
        echo ""
        echo "Or run with:"
        echo "  LD_LIBRARY_PATH=${TARGET_DIR}/lib node test.mjs"
    elif [ "$PLATFORM" = "mac" ]; then
        ln -sf "${TARGET_DIR}/lib/libpdfium.dylib" "${SCRIPT_DIR}/../libpdfium.dylib"
        echo ""
        echo "Symlink created: ${SCRIPT_DIR}/../libpdfium.dylib"
        echo ""
        echo "To use PDFium, add to your environment:"
        echo "  export DYLD_LIBRARY_PATH=${TARGET_DIR}/lib:\$DYLD_LIBRARY_PATH"
    fi
else
    echo "❌ Error: Library file not found at ${LIB_FILE}"
    echo "Contents of ${TARGET_DIR}:"
    ls -laR "$TARGET_DIR"
    exit 1
fi
