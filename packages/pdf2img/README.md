# node-pdf2img

High-performance PDF to image converter using PDFium native renderer + Sharp image encoding.

[![npm version](https://badge.fury.io/js/node-pdf2img.svg)](https://badge.fury.io/js/node-pdf2img)
[![Build Status](https://github.com/sigma-2026/node-pdf2img/workflows/Build%20and%20Release/badge.svg)](https://github.com/sigma-2026/node-pdf2img/actions)

## 特性

- **原生性能**：使用 PDFium C++ 库通过 Rust 绑定实现高性能 PDF 渲染
- **Sharp 编码**：使用 libvips 的 Sharp 库进行高效图像编码
- **多线程处理**：使用 piscina 线程池，充分利用多核 CPU 并行处理
- **零拷贝文件读取**：原生模块直接读取文件路径，避免 Node.js 堆内存占用
- **异步 I/O**：主线程负责协调和 I/O，工作线程负责 CPU 密集型任务
- **并发控制**：文件写入和 COS 上传使用 p-limit 控制并发，避免资源耗尽
- **多种输入源**：支持本地文件、URL 或 Buffer
- **多种输出目标**：支持本地文件、Buffer 或腾讯云 COS
- **多种输出格式**：支持 WebP、PNG、JPG 格式
- **CLI 和 API**：支持命令行使用或作为 Node.js 模块引用

## Installation

```bash
# Install as project dependency (for API usage)
npm install node-pdf2img

# Install globally (for CLI usage)
npm install -g node-pdf2img
```

> 💡 **本地开发**: 如果你想直接使用预编译的 native 模块进行本地开发，请查看 [LOCAL_DEV.md](../../LOCAL_DEV.md) 了解更多。

## CLI 使用

```bash
# 基本用法 - 转换所有页面（默认 WebP 格式）
pdf2img document.pdf -o ./output

# 转换指定页面
pdf2img document.pdf -p 1,2,3 -o ./output

# 从 URL 转换
pdf2img https://example.com/document.pdf -o ./output

# 自定义质量和宽度
pdf2img document.pdf -q 90 -w 2560 -o ./output

# 输出 PNG 格式
pdf2img document.pdf -f png -o ./output

# 输出 JPG 格式
pdf2img document.pdf -f jpg -q 85 -o ./output

# 显示 PDF 信息
pdf2img document.pdf --info

# 详细输出
pdf2img document.pdf -o ./output -v

# 上传到腾讯云 COS（需先配置环境变量）
pdf2img document.pdf --cos --cos-prefix images/doc-123
```

### CLI 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-o, --output <dir>` | 输出目录（本地模式） | `./output` |
| `-p, --pages <pages>` | 页码（逗号分隔） | 全部页面 |
| `-w, --width <width>` | 目标渲染宽度（像素） | `1280` |
| `-q, --quality <quality>` | 图片质量（0-100，用于 webp/jpg） | `80` |
| `-f, --format <format>` | 输出格式：webp, png, jpg | `webp` |
| `--prefix <prefix>` | 输出文件名前缀 | `page` |
| `--info` | 仅显示 PDF 信息 | |
| `--version-info` | 显示渲染器版本 | |
| `-v, --verbose` | 详细输出 | |
| `--cos` | 上传到腾讯云 COS | |
| `--cos-prefix <prefix>` | COS key 前缀 | |

### COS 上传配置

CLI 支持通过环境变量配置 COS 上传参数：

```bash
# 设置环境变量
export COS_SECRET_ID=your-secret-id
export COS_SECRET_KEY=your-secret-key
export COS_BUCKET=your-bucket-name
export COS_REGION=ap-guangzhou

# 使用 --cos 选项上传
pdf2img document.pdf --cos --cos-prefix images/doc-123
```

也可以通过命令行参数指定（不推荐，敏感信息会暴露在命令行历史中）：

```bash
pdf2img document.pdf --cos \
    --cos-secret-id xxx \
    --cos-secret-key xxx \
    --cos-bucket xxx \
    --cos-region ap-guangzhou \
    --cos-prefix images/doc-123
```

## API 使用

### 基本用法

```javascript
import { convert, getPageCount, isAvailable } from 'node-pdf2img';

// 检查渲染器是否可用
if (!isAvailable()) {
    console.error('原生渲染器不可用');
    process.exit(1);
}

// 转换 PDF 为图片（返回 Buffer）
const result = await convert('./document.pdf');
console.log(`转换了 ${result.renderedPages} 页`);

for (const page of result.pages) {
    console.log(`第 ${page.pageNum} 页: ${page.width}x${page.height}`);
    // page.buffer 包含图片数据
}
```

### 保存到文件

```javascript
const result = await convert('./document.pdf', {
    outputType: 'file',
    outputDir: './output',
    prefix: 'doc',
});

for (const page of result.pages) {
    console.log(`已保存: ${page.outputPath}`);
}
```

### 指定输出格式

```javascript
// 输出 PNG 格式
const result = await convert('./document.pdf', {
    format: 'png',
    outputType: 'file',
    outputDir: './output',
});

// 输出 JPG 格式，指定质量
const result = await convert('./document.pdf', {
    format: 'jpg',
    jpeg: { quality: 85 },
    outputType: 'file',
    outputDir: './output',
});

// 输出 WebP 格式，指定质量和编码方法
const result = await convert('./document.pdf', {
    format: 'webp',
    webp: { quality: 80, method: 4 },
    outputType: 'file',
    outputDir: './output',
});
```

### 转换指定页面

```javascript
const result = await convert('./document.pdf', {
    pages: [1, 2, 3],
    outputType: 'file',
    outputDir: './output',
});
```

### 自定义渲染选项

```javascript
const result = await convert('./document.pdf', {
    targetWidth: 2560,
    format: 'webp',
    webp: { quality: 90, method: 6 },
    outputType: 'file',
    outputDir: './output',
});
```

### 从 URL 转换

```javascript
// 自动下载到临时文件后渲染
const result = await convert('https://example.com/document.pdf', {
    outputType: 'file',
    outputDir: './output',
});
```

### 上传到腾讯云 COS

```javascript
const result = await convert('./document.pdf', {
    outputType: 'cos',
    format: 'webp',
    cos: {
        secretId: 'your-secret-id',
        secretKey: 'your-secret-key',
        bucket: 'your-bucket',
        region: 'ap-guangzhou',
    },
    cosKeyPrefix: 'pdf-images/doc-123',
});

for (const page of result.pages) {
    console.log(`已上传: ${page.cosKey}`);
}
```

### 获取页数

```javascript
// 异步版本（推荐）
const pageCount = await getPageCount('./document.pdf');
console.log(`PDF 共 ${pageCount} 页`);

// 同步版本（已废弃，保持向后兼容）
import { getPageCountSync } from 'node-pdf2img';
const pageCount = getPageCountSync('./document.pdf');
```

### 线程池管理

```javascript
import { getThreadPoolStats, destroyThreadPool } from 'node-pdf2img';

// 获取线程池统计信息
const stats = getThreadPoolStats();
console.log(`工作线程: ${stats.workers}`);
console.log(`已完成任务: ${stats.completed}`);
console.log(`线程利用率: ${(stats.utilization * 100).toFixed(1)}%`);

// 应用关闭时销毁线程池
await destroyThreadPool();
```

## API 参考

### `convert(input, options?)`

PDF 转图片。

**参数：**
- `input` (string | Buffer)：PDF 文件路径、URL 或 Buffer
- `options` (object)：转换选项
    - `pages` (number[])：要转换的页码（1-based），空数组表示全部
    - `outputType` ('file' | 'buffer' | 'cos')：输出类型（默认：'buffer'）
    - `outputDir` (string)：输出目录（'file' 类型时必需）
    - `prefix` (string)：文件名前缀（默认：'page'）
    - `format` ('webp' | 'png' | 'jpg')：输出格式（默认：'webp'）
    - `webp` (object)：WebP 编码选项
        - `quality` (number)：质量 0-100（默认：80）
        - `method` (number)：编码方法 0-6（默认：4，0最快6最慢）
    - `jpeg` (object)：JPEG 编码选项
        - `quality` (number)：质量 0-100（默认：85）
    - `png` (object)：PNG 编码选项
        - `compressionLevel` (number)：压缩级别 0-9（默认：6）
    - `cos` (object)：COS 配置（'cos' 类型时必需）
    - `cosKeyPrefix` (string)：COS key 前缀
    - `targetWidth` (number)：目标渲染宽度（默认：1280）
    - `concurrency` (number)：文件/上传并发数

**返回：** Promise<ConvertResult>

### `getPageCount(input)`

获取 PDF 页数（异步）。

**参数：**
- `input` (string | Buffer)：PDF 文件路径或 Buffer

**返回：** Promise<number>

### `getPageCountSync(input)`

获取 PDF 页数（同步，已废弃）。

**参数：**
- `input` (string | Buffer)：PDF 文件路径或 Buffer

**返回：** number

### `isAvailable()`

检查原生渲染器是否可用。

**返回：** boolean

### `getVersion()`

获取原生渲染器版本信息。

**返回：** string

### `getThreadPoolStats()`

获取线程池统计信息。

**返回：** object
- `initialized` (boolean)：线程池是否已初始化
- `workers` (number)：工作线程数
- `completed` (number)：已完成任务数
- `utilization` (number)：线程利用率 (0-1)

### `destroyThreadPool()`

销毁线程池，释放工作线程资源。

**返回：** Promise<void>

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TARGET_RENDER_WIDTH` | 默认渲染宽度 | `1280` |
| `OUTPUT_FORMAT` | 默认输出格式 | `webp` |
| `NATIVE_STREAM_THRESHOLD` | 流式加载文件大小阈值 | `5MB` |
| `RANGE_REQUEST_TIMEOUT` | 分片请求超时 | `25000` |
| `DOWNLOAD_TIMEOUT` | 文件下载超时 | `60000` |
| `PDF2IMG_THREAD_COUNT` | 工作线程数 | CPU 核心数 |
| `PDF2IMG_DEBUG` | 启用调试日志 | `false` |

## 性能测试

测试环境：Linux x64，32 核 CPU，渲染宽度 1280px

### 本地文件渲染（前 10 页）

| 文件 | 大小 | 渲染页 | WebP | PNG | JPG |
|------|------|--------|------|-----|-----|
| 通行费电子发票-1.pdf | 39.1 KB | 1 | 123 ms | 101 ms | 177 ms |
| 发票.pdf | 76.8 KB | 1 | 111 ms | 107 ms | 165 ms |
| 股权转让协议书 (2).pdf | 593.2 KB | 3 | 294 ms | 275 ms | 350 ms |
| 1M.pdf | 992.5 KB | 10 | 698 ms | 532 ms | 1.31 s |
| DJI 用户手册.pdf | 2.8 MB | 10 | 541 ms | 529 ms | 616 ms |
| 大图内存性能素材.pdf | 7.6 MB | 10 | 2.05 s | 2.08 s | 2.13 s |
| 10M.pdf | 8.8 MB | 10 | 628 ms | 600 ms | 695 ms |
| ISO_32000-2.pdf | 16.5 MB | 10 | 677 ms | 620 ms | 946 ms |
| 四年级数学.pdf | 20.9 MB | 10 | 1.04 s | 1.09 s | 1.05 s |
| Rust语言圣经.pdf | 34.7 MB | 10 | 996 ms | 956 ms | 1.03 s |
| 50M.pdf | 55.3 MB | 10 | 1.57 s | 1.58 s | 1.59 s |
| 80M.pdf | 77.9 MB | 10 | 488 ms | 509 ms | 633 ms |

### URL 下载渲染（前 10 页）

| 文件 | 大小 | 渲染页 | WebP | PNG | JPG |
|------|------|--------|------|-----|-----|
| 发票.pdf | 76.8 KB | 1 | 122 ms | 106 ms | 172 ms |
| 1M.pdf | 992.5 KB | 10 | 770 ms | 577 ms | 1.36 s |
| DJI 用户手册.pdf | 2.8 MB | 10 | 607 ms | 576 ms | 687 ms |
| 10M.pdf | 8.8 MB | 10 | 666 ms | 678 ms | 720 ms |
| ISO_32000-2.pdf | 16.5 MB | 10 | 748 ms | 677 ms | 938 ms |
| Rust语言圣经.pdf | 34.7 MB | 10 | 1.08 s | 1.03 s | 1.17 s |
| 50M.pdf | 55.3 MB | 10 | 1.73 s | 1.89 s | 1.73 s |
| 80M.pdf | 77.9 MB | 10 | 699 ms | 792 ms | 889 ms |

**性能说明：**
- 架构：PDFium 渲染 + Sharp 编码（piscina 线程池）
- 线程数：自动使用 CPU 核心数（可通过 `PDF2IMG_THREAD_COUNT` 调整）
- PNG 格式通常最快（无损压缩，编码简单）
- WebP 格式文件最小（高压缩率）
- JPG 格式需要 RGBA→RGB 转换

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      主线程 (Main Thread)                    │
│  - 接收用户请求 convert(input, options)                      │
│  - 初始 I/O：读取文件信息、下载远程文件                         │
│  - 任务分发：为每一页创建任务并提交到线程池                      │
│  - 结果收集：等待所有工作线程完成                              │
│  - 最终 I/O：保存文件或上传 COS                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  piscina 线程池 (Worker Pool)                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ Worker  │ │ Worker  │ │ Worker  │ │ Worker  │ ...       │
│  │ Thread  │ │ Thread  │ │ Thread  │ │ Thread  │           │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘           │
│       │           │           │           │                 │
│       ▼           ▼           ▼           ▼                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           每个工作线程处理单页任务                      │   │
│  │  1. PDFium 渲染 PDF 页面 → 原始 RGBA 位图              │   │
│  │  2. Sharp 编码位图 → WebP/PNG/JPG                     │   │
│  │  3. 返回编码后的 Buffer                               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 系统要求

- Node.js >= 18.0.0
- 支持平台：
  - Linux x64 (glibc)
  - Linux arm64 (glibc)
  - macOS x64 (Intel)
  - macOS arm64 (Apple Silicon)
  - Windows x64

### 原生模块安装

`node-pdf2img` 依赖 `node-pdf2img-native` 原生模块。安装时会自动：
1. **优先**下载对应平台的预编译二进制文件
2. **降级**如果预编译文件不可用，则在本地编译（需要 Rust + C++ 编译工具链）

大多数情况下会使用预编译版本，安装快速。如果需要本地编译，请确保已安装：
- Rust 工具链
- C++ 编译器（GCC/Clang/MSVC）
- Make（Linux/macOS）或 Ninja（Windows）

## 多平台构建说明

本项目使用 Rust + NAPI-RS 构建原生模块，通过 GitHub Actions 自动构建和发布所有平台版本。

### 支持的平台

| 平台 | 架构 | 构建状态 |
|------|------|----------|
| Linux | x64 | ✅ GitHub Actions |
| Linux | arm64 | ✅ GitHub Actions (交叉编译) |
| macOS | x64 | ✅ GitHub Actions |
| macOS | arm64 | ✅ GitHub Actions |
| Windows | x64 | ✅ GitHub Actions |

### 自动构建流程

推送到以下分支会自动触发 GitHub Actions 构建：
- `master` / `main`: 正式版本，发布到 latest 标签
- `beta/*`: 测试版本，发布到 beta 标签
- `next`: 大版本预览，发布到 next 标签
- 标签 `v*`: 正式发布版本

GitHub Actions 会：
1. 为所有 5 个平台交叉编译原生模块
2. 将编译产物合并到 `node-pdf2img-native` 包
3. 发布两个 npm 包：
   - `node-pdf2img-native`: 原生渲染器包
   - `node-pdf2img`: 主包

### 手动构建（开发调试）

如需在本地构建特定平台的原生模块：

**Linux x64**:
```bash
cd packages/native-renderer
pnpm install
pnpm run build
# 产物：pdf-renderer.linux-x64-gnu.node, libpdfium.so
```

**macOS x64 (Intel)**:
```bash
cd packages/native-renderer
pnpm install
pnpm run build
# 产物：pdf-renderer.darwin-x64.node, libpdfium.dylib
```

**macOS arm64 (Apple Silicon)**:
```bash
cd packages/native-renderer
pnpm install
pnpm run build
# 产物：pdf-renderer.darwin-arm64.node, libpdfium.dylib
```

**Windows x64**:
```powershell
cd packages\native-renderer
pnpm install
pnpm run build
# 产物：pdf-renderer.win32-x64-msvc.node, pdfium.dll
```

### 项目结构

```
pdf2img/
├── packages/
│   ├── pdf2img/              # 主包
│   │   ├── src/
│   │   ├── bin/
│   │   └── package.json
│   └── native-renderer/      # 原生渲染器包
│       ├── src/              # Rust 源代码
│       ├── index.js          # JavaScript 绑定
│       ├── package.json
│       └── Cargo.toml
├── .github/workflows/
│   └── build-and-release.yml # CI/CD 配置
└── pnpm-workspace.yaml
```

### 发布流程

1. **开发分支提交**: 推送到 `beta/*` 或 `next` 分支
2. **自动构建**: GitHub Actions 为所有平台编译
3. **自动发布**: 发布到 npm 对应的 tag（beta/next）
4. **正式发布**: 合并到 `master` 或打 tag `v*`，发布到 latest

## 许可证

MIT
