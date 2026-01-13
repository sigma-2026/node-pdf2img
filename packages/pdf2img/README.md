# node-pdf2img

高性能 PDF 转图片工具，基于 PDFium 原生渲染器 + Sharp 图像编码。

[![npm version](https://badge.fury.io/js/node-pdf2img.svg)](https://badge.fury.io/js/node-pdf2img)

## 特性

- **高性能**：使用 PDFium 原生渲染，多线程并行处理
- **多种格式**：支持 WebP、PNG、JPG 输出
- **多种输入**：支持本地文件、URL、Buffer
- **多种输出**：支持本地文件、Buffer、腾讯云 COS
- **CLI + API**：命令行工具和 Node.js 模块双模式

## 安装

```bash
# 作为项目依赖安装（API 使用）
npm install node-pdf2img

# 全局安装（CLI 使用）
npm install -g node-pdf2img
```

## 系统要求

- Node.js >= 18.0.0
- 支持平台：Linux x64/arm64、macOS x64/arm64、Windows x64

## CLI 使用

```bash
# 基本用法 - 转换所有页面
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

# 上传到腾讯云 COS
pdf2img document.pdf --cos --cos-prefix images/doc-123
```

### CLI 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-o, --output <dir>` | 输出目录 | `./output` |
| `-p, --pages <pages>` | 页码（逗号分隔） | 全部页面 |
| `-w, --width <width>` | 渲染宽度（像素） | `1920` |
| `-q, --quality <quality>` | 图片质量（0-100） | `100` |
| `-f, --format <format>` | 输出格式：webp, png, jpg | `webp` |
| `--prefix <prefix>` | 文件名前缀 | `page` |
| `--info` | 仅显示 PDF 信息 | |
| `-v, --verbose` | 详细输出 | |
| `--cos` | 上传到腾讯云 COS | |
| `--cos-prefix <prefix>` | COS key 前缀 | |

### COS 上传配置

```bash
# 设置环境变量
export COS_SECRET_ID=your-secret-id
export COS_SECRET_KEY=your-secret-key
export COS_BUCKET=your-bucket-name
export COS_REGION=ap-guangzhou

# 使用 --cos 选项上传
pdf2img document.pdf --cos --cos-prefix images/doc-123
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
// PNG 格式
await convert('./document.pdf', {
    format: 'png',
    outputType: 'file',
    outputDir: './output',
});

// JPG 格式，指定质量
await convert('./document.pdf', {
    format: 'jpg',
    jpeg: { quality: 85 },
    outputType: 'file',
    outputDir: './output',
});

// WebP 格式，指定质量
await convert('./document.pdf', {
    format: 'webp',
    webp: { quality: 80 },
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

### 自定义渲染宽度

```javascript
const result = await convert('./document.pdf', {
    targetWidth: 2560,
    outputType: 'file',
    outputDir: './output',
});
```

### 从 URL 转换

```javascript
const result = await convert('https://example.com/document.pdf', {
    outputType: 'file',
    outputDir: './output',
});
```

### 上传到腾讯云 COS

```javascript
const result = await convert('./document.pdf', {
    outputType: 'cos',
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
const pageCount = await getPageCount('./document.pdf');
console.log(`PDF 共 ${pageCount} 页`);
```

### 线程池管理

```javascript
import { getThreadPoolStats, destroyThreadPool } from 'node-pdf2img';

// 获取线程池统计
const stats = getThreadPoolStats();
console.log(`工作线程: ${stats.workers}`);

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
  - `outputType` ('file' | 'buffer' | 'cos')：输出类型，默认 'buffer'
  - `outputDir` (string)：输出目录（'file' 类型时必需）
  - `prefix` (string)：文件名前缀，默认 'page'
  - `format` ('webp' | 'png' | 'jpg')：输出格式，默认 'webp'
  - `targetWidth` (number)：渲染宽度，默认 1280
  - `webp` (object)：WebP 编码选项
    - `quality` (number)：质量 0-100，默认 80
  - `jpeg` (object)：JPEG 编码选项
    - `quality` (number)：质量 0-100，默认 85
  - `png` (object)：PNG 编码选项
    - `compressionLevel` (number)：压缩级别 0-9，默认 6
  - `cos` (object)：COS 配置（'cos' 类型时必需）
  - `cosKeyPrefix` (string)：COS key 前缀

**返回：** Promise\<ConvertResult\>

### `getPageCount(input)`

获取 PDF 页数。

**参数：**
- `input` (string | Buffer)：PDF 文件路径或 Buffer

**返回：** Promise\<number\>

### `isAvailable()`

检查原生渲染器是否可用。

**返回：** boolean

### `getVersion()`

获取原生渲染器版本信息。

**返回：** string

### `destroyThreadPool()`

销毁线程池，释放资源。

**返回：** Promise\<void\>

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PDF2IMG_THREAD_COUNT` | 工作线程数 | CPU 核心数 |
| `PDF2IMG_DEBUG` | 启用调试日志 | `false` |

## 许可证

MIT
