# PDF2IMG Go 版本

基于 Go + pdfium 的 PDF 转图片服务，支持 HTTP Range 分片加载，与 Node.js 版本 API 完全兼容。

## 特性

- **分片加载**：通过 HTTP Range 请求按需加载 PDF 数据，支持大文件处理
- **并发分片**：将大请求拆分为多个 256KB 子请求并发执行
- **数据缓存**：内置 50MB LRU 缓存，减少重复请求
- **高性能**：原生 Go 实现，渲染性能优于 Node.js 版本
- **低内存**：无 V8 堆开销，内存占用更低
- **API 兼容**：接口与 Node.js 版本完全兼容，可无缝替换

## 目录结构

```
go-src/
├── cmd/server/main.go           # 服务入口
├── internal/
│   ├── handler/handler.go       # HTTP 处理器
│   ├── middleware/
│   │   ├── timeout.go           # 超时中间件 (40s)
│   │   └── loadprotection.go    # 负载保护中间件
│   └── cos/uploader.go          # 腾讯云 COS 上传
├── pkg/
│   ├── rangeloader/loader.go    # HTTP Range 分片加载器（核心）
│   └── pdfrender/
│       ├── render.go            # WASM 版本渲染器
│       └── render_cgo.go        # CGO 版本渲染器
├── test/render_test.go          # 测试文件
├── scripts/
│   ├── build.sh                 # 构建脚本
│   └── docker-push.sh           # 镜像推送脚本
├── Dockerfile                   # WASM 版本镜像
├── Dockerfile.cgo               # CGO 版本镜像（更快）
├── Makefile
├── go.mod
└── go.sum
```

## 快速开始

### 环境要求

- Go 1.21+
- Docker (可选)

### 安装依赖

```bash
cd go-src
go mod download
go mod tidy
```

### 本地运行

```bash
# 开发模式
make run

# 或直接运行
go run ./cmd/server -port 3000 -mode debug
```

### 构建

```bash
# 构建 WASM 版本（无 CGO 依赖，跨平台）
make build

# 构建 CGO 版本（需要 pdfium 库，性能更好）
make build-cgo

# 构建产物在 bin/ 目录
ls bin/
```

## API 接口

### 健康检查

```bash
curl http://localhost:3000/api/health
```

响应示例：
```json
{
  "code": 200,
  "message": "Service is healthy",
  "data": {
    "healthy": true,
    "status": "healthy",
    "metrics": {
      "heap": { "usage": "45.23", "threshold": 80, "healthy": true },
      "goroutines": 10
    }
  }
}
```

### PDF 转图片

```bash
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/document.pdf",
    "globalPadId": "doc-123",
    "pages": "all",
    "dpi": 150
  }'
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | PDF 文件 URL |
| globalPadId | string | 是 | 文档唯一标识 |
| pages | string | 否 | 页码，支持 `"all"`、`"1"`、`"[1,2,3]"`，默认 all |
| dpi | int | 否 | 渲染 DPI，默认 150 |
| scale | float | 否 | 缩放比例，默认 1.0 |

**响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "totalPages": 10,
    "pages": [
      {
        "pageIndex": 0,
        "width": 1240,
        "height": 1754,
        "data": "iVBORw0KGgoAAAANSUhEUgAA..."
      }
    ],
    "stats": {
      "loadTimeMs": 234,
      "renderTimeMs": 567,
      "totalTimeMs": 801
    }
  }
}
```

## 测试

### 运行所有测试

```bash
make test

# 或
go test -v ./...
```

### 运行基准测试

```bash
make bench

# 或
go test -bench=. -benchmem ./...
```

### 测试覆盖的功能

- ✅ RangeLoader 分片加载
- ✅ 分片并发请求
- ✅ PDF 渲染
- ✅ 多页渲染
- ✅ 图片编码

## Docker

### 构建镜像

```bash
# WASM 版本（推荐，无外部依赖）
make docker

# CGO 版本（性能更好，需要 pdfium）
make docker-cgo
```

### 运行容器

```bash
# 启动
docker run -d --name pdf2img-go -p 3000:3000 pdf2img-go:latest

# 查看日志
docker logs -f pdf2img-go

# 停止
docker stop pdf2img-go && docker rm pdf2img-go
```

### 推送镜像

```bash
# 推送到 mirrors.tencent.com
make push

# 或使用脚本（包含测试验证）
./scripts/docker-push.sh v1.0.0
```

## 分片加载原理

Go 版本的分片加载实现与 Node.js 版本等价：

```
┌─────────────────────────────────────────────────────────────┐
│                    分片加载流程                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 获取文件大小                                             │
│     HEAD 请求或 Range: bytes=0-10239                        │
│     从 Content-Range 解析总大小                              │
│                                                             │
│  2. 创建 RangeLoader                                        │
│     实现 io.ReaderAt 接口                                   │
│     供 pdfium 按需读取数据                                   │
│                                                             │
│  3. pdfium 请求数据                                         │
│     调用 ReadAt(buf, offset)                                │
│     RangeLoader 发送 Range 请求                             │
│                                                             │
│  4. 并发分片优化                                             │
│     大请求 (>256KB) 拆分为多个子请求                         │
│     goroutine 并发执行                                      │
│     合并结果返回                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 分片参数

| 参数 | 值 | 说明 |
|------|-----|------|
| ChunkSize | 1MB | 主分片大小 |
| SmallChunkSize | 256KB | 子分片大小（并发单位） |
| InitialDataLength | 10KB | 初始数据长度 |
| CacheSize | 50MB | 缓存大小限制 |

## 与 Node.js 版本对比

| 特性 | Node.js | Go |
|------|---------|-----|
| 分片加载 | ✅ PDFDataRangeTransport | ✅ io.ReaderAt |
| 并发分片 | ✅ Promise.all | ✅ goroutine |
| 渲染引擎 | pdf.js | pdfium |
| 渲染性能 | 基准 | 3-5x 更快 |
| 内存占用 | 较高 (V8) | 较低 |
| 并发模型 | 单线程 + Worker | 多线程 |
| 镜像大小 | ~500MB | ~100MB |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| GIN_MODE | release | Gin 模式 (debug/release) |
| CPU_THRESHOLD | 85 | CPU 过载阈值 (%) |
| HEAP_THRESHOLD | 80 | 堆内存过载阈值 (%) |
| COS_SECRET_ID | - | 腾讯云 COS SecretId |
| COS_SECRET_KEY | - | 腾讯云 COS SecretKey |
| COS_REGION | - | COS 区域 |
| COS_BUCKET | - | COS 桶名 |

## 常用命令

```bash
# 查看所有可用命令
make help

# 代码格式化
make fmt

# 代码检查
make lint

# 清理构建产物
make clean
```

## 故障排查

### 1. pdfium 初始化失败

WASM 版本需要较新的 Go 版本 (1.21+)，确保版本正确：
```bash
go version
```

### 2. 内存不足

调整 `HEAP_THRESHOLD` 环境变量，或增加容器内存限制：
```bash
docker run -m 2g --name pdf2img-go ...
```

### 3. 渲染超时

默认超时 40 秒，可通过修改 `internal/middleware/timeout.go` 调整：
```go
Timeout: 60 * time.Second,
```

## License

MIT
