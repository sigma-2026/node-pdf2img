# PDF2IMG Monorepo

高性能 PDF 转图片工具的 Monorepo 仓库。

## 项目结构

```
pdf2img/
├── packages/
│   ├── pdf2img/              # 主包 - CLI 和 Node.js API
│   │   ├── bin/              # CLI 入口
│   │   ├── src/              # 源代码
│   │   │   ├── core/         # 核心转换逻辑
│   │   │   ├── renderers/    # 渲染器适配层
│   │   │   └── utils/        # 工具函数
│   │   └── test/             # 测试文件
│   └── native-renderer/      # 原生渲染器 - Rust + PDFium
│       ├── src/              # Rust 源代码
│       └── pdfium/           # PDFium 库文件
├── static/                   # 测试用 PDF 文件
├── .github/workflows/        # CI/CD 配置
└── package.json              # Monorepo 根配置
```

## 开发环境设置

### 前置要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Rust（用于编译原生渲染器）

### 安装依赖

```bash
pnpm install
```

### 构建原生渲染器

```bash
cd packages/native-renderer
pnpm build
```

## 开发命令

```bash
# 运行所有测试
pnpm test

# 运行 CLI
pnpm test:cli -- document.pdf -o ./output

# 运行性能测试
pnpm benchmark
```

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

## 多平台构建

### 支持的平台

| 平台 | 架构 | 构建方式 |
|------|------|----------|
| Linux | x64 | GitHub Actions |
| Linux | arm64 | GitHub Actions (交叉编译) |
| macOS | x64 | GitHub Actions (macos-15-intel) |
| macOS | arm64 | GitHub Actions (macos-latest) |
| Windows | x64 | GitHub Actions |

### 自动构建流程

推送到以下分支会自动触发 GitHub Actions 构建：
- `master` / `main`: 正式版本，发布到 latest 标签
- `beta/*`: 测试版本，发布到 beta 标签
- `next`: 大版本预览，发布到 next 标签
- 标签 `v*`: 正式发布版本

GitHub Actions 会：
1. 为所有 5 个平台编译原生模块
2. 将编译产物合并到 `node-pdf2img-native` 包
3. 发布两个 npm 包：
   - `node-pdf2img-native`: 原生渲染器包
   - `node-pdf2img`: 主包

### 手动构建

**Linux x64**:
```bash
cd packages/native-renderer
pnpm install
pnpm run build
# 产物：pdf-renderer.linux-x64-gnu.node, libpdfium.so
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

## 性能测试数据

测试环境：Linux x64，32 核 CPU，渲染宽度 1280px

| 文件 | 大小 | 页数 | 耗时 | 平均每页 |
|------|------|------|------|----------|
| 发票.pdf | 76.8 KB | 1 | 111 ms | 111 ms |
| 1M.pdf | 992.5 KB | 14 | 909 ms | 65 ms |
| 10M.pdf | 8.8 MB | 58 | 3.9 s | 67 ms |
| DJI 用户手册.pdf | 2.8 MB | 35 | 1.7 s | 49 ms |

## 发布流程

### 版本升级规则

版本号根据 commit message 自动升级：

| Commit 类型 | 版本变化 | 示例 |
|-------------|----------|------|
| `feat` | patch | `1.0.0` → `1.0.1` |
| `fix` | patch | `1.0.0` → `1.0.1` |
| `perf` | patch | `1.0.0` → `1.0.1` |

### 提交规范

遵循约定式提交规范：

```bash
# 功能新增
git commit -m "feat(converter): add support for TIFF format"

# Bug 修复
git commit -m "fix(cli): fix output path handling on Windows"

# 性能优化
git commit -m "perf(worker): reduce memory usage"
```

## 许可证

MIT
