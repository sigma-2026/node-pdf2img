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
└── package.json              # Monorepo 根配置
```

## 开发环境设置

### 前置要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Rust (用于编译原生渲染器)

### 安装依赖

```bash
# 安装所有依赖
pnpm install

# 或者只安装根目录依赖
pnpm install --ignore-workspace
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

# 运行单个包的测试
cd packages/pdf2img
pnpm test

# 运行性能测试
node packages/pdf2img/test/performance.test.js

# 清理所有 node_modules
pnpm clean
```

## 测试文件

`static/` 目录包含用于测试的 PDF 文件：

| 文件 | 说明 |
|------|------|
| `1M.pdf` | 小型测试文件 (~1MB) |
| `10M.pdf` | 中型测试文件 (~10MB) |
| `50M.pdf` | 大型测试文件 (~50MB) |
| `80M.pdf` | 超大型测试文件 (~80MB) |
| `发票.pdf` | 发票样本 |
| 其他 | 各种真实场景 PDF |

## 包说明

### @tencent/pdf2img

主包，提供 CLI 和 Node.js API。

- **CLI**：`pdf2img` 命令行工具（推荐全局安装）
  - 支持输出到本地文件或 COS
  - COS 上传通过环境变量配置（`COS_SECRET_ID`, `COS_SECRET_KEY`, `COS_BUCKET`, `COS_REGION`）
- **API**：`convert()`, `getPageCount()`, `isAvailable()` 等
  - 支持输出到本地文件、Buffer 或 COS

详见 [packages/pdf2img/README.md](packages/pdf2img/README.md)

### @tencent/pdf2img-native

原生渲染器，使用 Rust 和 PDFium 实现高性能 PDF 渲染。

- 基于 [napi-rs](https://napi.rs/) 构建 Node.js 原生模块
- 使用 PDFium 进行 PDF 解析和渲染
- 使用 libwebp 进行 WebP 编码

## 发布流程

```bash
# 1. 构建原生渲染器
cd packages/native-renderer
pnpm build

# 2. 运行测试
cd ../pdf2img
pnpm test

# 3. 发布
npm publish --access public
```

## 架构说明

```
用户输入 (文件/URL/Buffer)
         │
         ▼
    ┌─────────────┐
    │  converter  │  核心转换逻辑
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │   native    │  渲染器适配层
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │  pdf2img-   │  Rust + PDFium
    │   native    │  原生渲染
    └─────────────┘
         │
         ▼
    输出 (文件/Buffer/COS)
```

## 贡献指南

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -am 'Add xxx'`)
4. 推送分支 (`git push origin feature/xxx`)
5. 创建 Pull Request

## 许可证

MIT
