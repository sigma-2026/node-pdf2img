# PDF 生图服务

## Prerequisites
- Node.js 20+
- Docker (optional)

## Installation
```bash
pnpm i
```

## Running the App

### Without Docker
```bash
npm start
```

### Using PM2 for Monitoring
```bash
npm install pm2 -g
npm run pm2
```

# 请求示例：

<img src='./static/demo.png'>

# docker 镜像(devcloud)

## 自动打镜像脚本
```
npm run docker:push
```

## 镜像发布前需要确认的事情(TODO: 自动化脚本)

1、✅集成测试全部通过
```
npm run test:integration

2、✅本地生图验证
```
rm -rf ./output
npm run dev
curl 'http://localhost:3000/test-local'
ls ./output
```

3、✅镜像验证
```


# 特性

* 支持数据分片，拆4个子片，并发请求
* 接入cos桶
* 自动资源管理，避免内存泄漏
* **接口超时保护**：默认 **40秒** 超时，防止长时间运行的请求占用资源
* **健康检查高负载丢弃**：CPU/内存过载时返回 503，北极星自动摘除实例
* **PM2 Cluster 模式**：多进程部署，充分利用多核 CPU

## 接口超时配置

项目已配置 **40秒** 的接口超时处理：

- **超时时间**: 40秒
- **超时响应**: HTTP 408 Request Timeout
- **豁免端点**: 健康检查端点不受超时限制

### 超时响应示例

```json
{
  "code": 408,
  "message": "Request timeout after 40000ms",
  "data": null
}
```

### 修改超时时间

编辑 [`src/timeout-middleware.js`](./src/timeout-middleware.js)：

```javascript
// 修改为60秒
const DEFAULT_TIMEOUT = 60000;
```

### 详细文档

查看 [TIMEOUT_CONFIG.md](./docs/TIMEOUT_CONFIG.md) 了解：
- 超时配置详细说明
- 工作原理和流程
- 最佳实践建议
- 故障排查指南

### 测试超时功能

```bash
# 运行超时测试
npm run test:timeout
```

## 高负载丢弃功能

项目实现了**双重高负载保护机制**，确保服务在高负载下的稳定性：

### 1. /api/pdf2img 接口负载保护（请求入口保护）

`/api/pdf2img` 接口在处理请求前会先检查系统负载，过载时立即返回 503，避免资源浪费。

**特点**：
- ⚡ **快速失败**：过载时 <10ms 返回 503
- 🛡️ **保护稳定**：防止系统崩溃和雪崩
- 🔄 **自动恢复**：配合北极星实现优雅降级

**过载响应示例（503）**：
```json
{
  "code": 503,
  "message": "Service is overloaded, please try again later",
  "data": {
    "reasons": [
      "CPU过载: 92.35% (阈值: 85%)",
      "堆内存过载: 87.21% (阈值: 80%)"
    ],
    "retryAfter": 5
  }
}
```

### 2. /api/health 健康检查（实例级保护）

`/api/health` 接口支持**高负载丢弃**功能，当系统负载过高时自动返回 503 状态码，触发北极星摘除实例。

### 负载检测指标

- **CPU 使用率阈值**: 85%（可配置）
- **系统内存阈值**: 85%（可配置）
- **堆内存阈值**: 80%（可配置）

### 响应示例

**正常状态（200）**：
```json
{
  "code": 200,
  "data": {
    "healthy": true,
    "status": "healthy",
    "metrics": {
      "cpu": { "usage": "45.23", "threshold": 85, "healthy": true },
      "memory": { "usage": "60.50", "threshold": 85, "healthy": true },
      "heap": { "usage": "55.30", "threshold": 80, "healthy": true }
    }
  },
  "message": "Service is healthy"
}
```

**过载状态（503）**：
```json
{
  "code": 503,
  "data": {
    "healthy": false,
    "status": "overloaded",
    "reasons": [
      "CPU过载: 92.50% (阈值: 85%)",
      "内存过载: 88.30% (阈值: 85%)"
    ]
  },
  "message": "Service is overloaded"
}
```

### 配置阈值

通过环境变量配置：

```bash
export CPU_THRESHOLD=90
export MEMORY_THRESHOLD=90
export HEAP_THRESHOLD=85

npm run prod
```

### 双重保护机制

| 保护层 | 端点 | 作用 | 响应时间 | 触发条件 |
|--------|------|------|----------|----------|
| **第一层** | `/api/pdf2img` | 请求入口保护 | <10ms | 每次请求检查 |
| **第二层** | `/api/health` | 实例级保护 | 5秒间隔 | 北极星定期检查 |

### 测试功能

```bash
# 测试健康检查端点
npm run test:health-load

# 测试 /pdf2img 接口负载保护
node test/pdf2img-load-protection.test.mjs

# 压力测试（触发高负载）
node test/stress-test.mjs
```

### 详细文档

- [/pdf2img 接口负载保护文档](./docs/PDF2IMG_LOAD_PROTECTION.md)
- [健康检查高负载丢弃文档](./docs/HEALTH_LOAD_REJECTION.md)
- [与北极星集成配置](./docs/POLARIS_HEALTH_CHECK.md)
- [监控告警建议](./docs/HEALTH_LOAD_SHEDDING.md)

# 资源管理

## 类架构设计

项目采用工厂模式，根据环境自动选择对应的实现类，每个类都位于独立的文件中：

### 文件结构
```
src/
├── base-export-image.js    # BaseExportImage基类
├── dev-export-image.js     # DevExportImage开发环境类
├── prod-export-image.js    # ProdExportImage生产环境类
├── pdf2img.js              # 工厂函数和导出入口
└── ...其他文件
```

### 基类：BaseExportImage (base-export-image.js)
- 包含PDF解析、分页、内存管理等核心逻辑
- 定义抽象方法供子类实现

### 开发环境：DevExportImage (dev-export-image.js)
- 将图片保存到本地文件系统
- 输出路径：`/tmp/pdf2img/{globalPadId}/`
- 返回本地文件路径信息

### 生产环境：ProdExportImage (prod-export-image.js)
- 将图片上传到腾讯云COS
- 返回COS文件路径信息

### 工厂函数：createExportImage() (pdf2img.js)
- 根据 `NODE_ENV` 环境变量自动选择实现类
- 开发环境：`NODE_ENV=dev` → DevExportImage
- 生产环境：其他值 → ProdExportImage

### 使用方式
```javascript
// 导入工厂函数
import { createExportImage } from './src/pdf2img.js';

// 创建实例（自动根据环境选择实现）
const exportImage = await createExportImage({ globalPadId: 'doc-123' });

// 使用统一的接口
const result = await exportImage.pdfToImage({
    pdfPath: 'https://example.com/document.pdf',
    pages: 'all'
});
```

### 新的文件结构
```
src/
├── base-export-image.js    # BaseExportImage基类
├── dev-export-image.js     # DevExportImage开发环境类
├── prod-export-image.js    # ProdExportImage生产环境类
├── pdf2img.js              # 工厂函数入口
├── utils.js                 # 工具函数
└── ...其他文件
```

### 特点
- **职责分离**：每个类有明确的职责，避免逻辑混淆
- **环境隔离**：开发环境和生产环境的实现完全分离
- **易于扩展**：可以轻松添加新的环境实现
- **异步工厂**：使用动态导入避免循环依赖问题

## 类生命周期管理

每个实例在请求时创建，接口返回后自动清理资源：

### 自动清理的资源
- ✅ PDF 文档对象 (`pdfDocument.destroy()`)
- ✅ Canvas 资源 (`canvasFactory.reset()`)
- ✅ PDF 页面资源 (`page.cleanup()`)
- ✅ 内存监控和GC触发

### 手动清理（可选）
通过调用 `exportImage.destroy()` 可以手动清理实例资源，但这不是必需的，因为：
- 主接口 (`/api/pdf2img`) 已在 finally 块中自动清理
- 测试接口 (`/test-local`) 同样有自动清理机制

### 内存管理
- 每处理3页检查内存使用情况
- 内存超过800MB时自动触发GC
- 支持手动GC（通过 `global.gc`）

# 本地测试

## 测试接口说明
项目提供了 `/test-local` 接口用于本地开发测试，**该接口仅在开发环境可用，不会打包到生产环境**。

### 使用方法
1. 设置环境变量：
```bash
export NODE_ENV=dev
```

2. 启动服务：
```bash
npm start
```

3. 访问测试接口：
```bash
curl http://localhost:3000/test-local
```

### 注意事项
- 测试接口会自动使用 `static/1M.pdf` 作为测试文件
- 截图输出目录默认为 `output/`，可通过环境变量 `OUTPUT_DIR` 自定义
- **生产环境部署时，`src/test-local-route.js` 不会被打包（已在 `.dockerignore` 中排除）**


# 测试

## 运行所有测试
在发布镜像前，**必须**运行测试确保所有功能正常：

```bash
# 运行API集成测试（推荐）
npm test

# 运行单元测试
npm run test:unit

# 运行集成测试
npm run test:integration
```

## 单元测试
测试工具函数和独立模块：

```bash
npm run test:unit
```

单元测试覆盖：
- ✅ URL验证函数 (isValidUrl)
- ✅ JSON参数解析函数 (parseJsonParam)
- ✅ 边界情况和异常处理

测试结果示例：
```
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

## API集成测试
真实的API接口测试：

```bash
npm test
# 或
npm run test:integration
```

集成测试包括：
- ✅ 参数验证测试（缺少参数、无效格式等）
- ✅ 成功场景测试（默认页码、all参数、页码数组）
- ✅ 响应格式验证
- ✅ 性能测试（单页转换 < 30秒）

测试结果示例：
```
============================================================
PDF2IMG API 集成测试
============================================================

测试结果汇总:
总计: 39 个测试
通过: 39
失败: 0
============================================================
```

### 详细测试文档
查看 [TEST_GUIDE.md](./TEST_GUIDE.md) 了解更多测试细节。

## 发布前检查清单
```bash
# 1. 运行单元测试
npm run test:unit

# 2. 运行集成测试
npm test

# 3. 确保所有测试通过
# 4. 构建并推送镜像
npm run docker:push
```

## mirrors.tencent.com
[仓库地址](https://mirrors.tencent.com/#/private/docker/detail?project_name=tdocs-pdf&repo_name=pdf2img)

```
1、打镜像
docker build -t pdf2img:v1.0.0 ./ 

2、查看镜像
docker images 

3、打tag
docker tag 486ff26017ff mirrors.tencent.com/tdocs-pdf/pdf2img:v2

4、推送
docker push mirrors.tencent.com/tdocs-pdf/pdf2img:v2

5、登陆
docker login --username johnsomwu --password [token] mirrors.tencent.com
```

## csighub.tencentyun.com
[仓库地址](https://csighub.woa.com/tencenthub/repo/detail/pdf-developer/pdf2img/images)
```
0、登陆
sudo docker login csighub.tencentyun.com

1、打镜像
sudo docker build -t pdf2img:[tag] ./

2、查看镜像[imageid], 关联下面的 tag
sudo docker images

3、打tag
sudo docker tag [imageid] csighub.tencentyun.com/pdf-developer/pdf2img:[tag]

4、push
sudo docker push csighub.tencentyun.com/pdf-developer/pdf2img:[tag]
```

# 镜像调试

```
// 运行
sudo docker run -d --name my-container -p 3000:3000 pdf2img:202508272112
// 停止
sudo docker stop my-container
// 移除
sudo docker remove my-container
// 查看docker内存占用
sudo docker stats my-container
// 查看docker日志
sudo docker logs my-container
// 查看运行在容器内的日记
sudo docker exec -it my-container /bin/sh
cd pm2/logs
```

# 压测
```bash
autocannon "http://localhost:3000/api/pdf2img" \
  -m POST \                              # 指定 POST 方法
  -H "Content-Type: application/json" \  # 设置 JSON 请求头
  -b '{"url":"https://example.com/doc.pdf", "globalPadId":"12345"}' \  # 必需参数
  -c 50 \                                # 50 个并发连接
  -p 5 \                                 # 每个连接管道化 5 个请求（提升吞吐）
  -d 30 \                                # 持续测试 30 秒
  -l \                                   # 输出完整延迟分布
  -t 20                                  # 超时20s
  -j > report.json                       # 生成 JSON 格式报告

// demo
autocannon "http://localhost:3000/api/pdf2img" -m POST -H "Content-Type: application/json" -b '{"url":"https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/fcf2e1c0bb8749b98d3b7cc39a3de266?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1756348774;1756350574&q-key-time=1756348774;1756350574&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=01ad2adea3816a629203c01c982577108bca420d&response-content-disposition=attachment%3Bfilename%3D%25E9%2587%2591%25E5%25B1%25B1-%25E9%2599%2588%25E6%25B5%25A9%25E8%258D%25A3%2520%25281%2529%2520%25283%2529.pdf%3Bfilename%2A%3Dutf-8%27%27%25E9%2587%2591%25E5%25B1%25B1-%25E9%2599%2588%25E6%25B5%25A9%25E8%258D%25A3%2520%25281%2529%2520%25283%2529.pdf&response-expires=1800", "globalPadId":"300000000$BMhIpcSEKpOt"}' -t 20 -c 5 -p 5 -d 30 -l -j > report.json                       
```

机器：
https://kubernetes.woa.com/v4/projects/prj5vxpx/workloads/cls-5vzjheeo/ns-prj5vxpx-5273103-production/StatefulSetPlus/pdf2img

报表： https://galileo.woa.com/service/client?module_name=weboffice.pdfloader&platform=STKE&moduleId=2084357&q=f816a6fe9b76be3ea1b8996b
