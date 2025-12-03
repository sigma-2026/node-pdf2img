# 接口超时配置文档

## 概述

项目已配置 **40秒** 的接口超时处理，防止长时间运行的请求占用服务器资源。

## 超时配置

### 默认超时时间

- **超时时间**: 40秒 (40000毫秒)
- **适用范围**: 所有 API 接口（除健康检查端点外）
- **超时响应**: HTTP 408 Request Timeout

### 配置文件

超时配置位于 [`src/timeout-middleware.js`](/data/home/johnsomwu/pdf2img/src/timeout-middleware.js)

```javascript
// 默认超时时间：40秒
const DEFAULT_TIMEOUT = 40000;
```

### 修改超时时间

如需修改超时时间，有两种方式：

#### 方式1：修改配置文件（推荐）

编辑 `src/timeout-middleware.js`：

```javascript
// 修改为60秒
const DEFAULT_TIMEOUT = 60000;
```

#### 方式2：通过环境变量（未来支持）

```bash
export REQUEST_TIMEOUT=60000  # 60秒
```

## 工作原理

### 超时处理流程

```
1. 请求到达 → 启动超时定时器（40秒）
2. 正常情况：
   - 请求在40秒内完成 → 清除定时器 → 返回正常响应
3. 超时情况：
   - 请求超过40秒 → 触发超时 → 返回408错误
4. 客户端断开：
   - 客户端主动断开 → 清除定时器 → 记录日志
```

### 超时响应格式

当请求超时时，服务器返回：

```json
{
  "code": 408,
  "message": "Request timeout after 40000ms",
  "data": null
}
```

### 日志记录

超时时会记录以下日志：

```
[Timeout] 请求超时 (40000ms): POST /api/pdf2img
[Timeout] 客户端断开连接: POST /api/pdf2img
```

## 豁免端点

以下端点不受超时限制：

- `/api/health` - 简单健康检查
- `/api/polaris-health` - 北极星健康检查
- `/api/stats` - 服务统计信息

## 使用示例

### 正常请求（40秒内完成）

```bash
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/document.pdf",
    "globalPadId": "test-123",
    "pages": [1, 2, 3]
  }'
```

**响应**：正常返回转换结果

### 超时请求（超过40秒）

```bash
# 使用一个需要长时间处理的大PDF
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/large-document.pdf",
    "globalPadId": "test-timeout",
    "pages": "all"
  }'
```

**响应**：40秒后返回超时错误

```json
{
  "code": 408,
  "message": "Request timeout after 40000ms",
  "data": null
}
```

## 测试验证

### 运行超时测试

```bash
# 运行超时功能测试
npm run test:timeout
```

### 手动测试

```bash
# 1. 启动服务
npm run dev

# 2. 在另一个终端发送测试请求
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://httpbin.org/delay/50",
    "globalPadId": "test-timeout",
    "pages": [1]
  }'

# 3. 观察40秒后返回408超时错误
```

## 与北极星集成

### 超时与健康检查

超时中间件与北极星健康检查配合使用：

1. **请求超时** → 返回 408
2. **服务过载** → 健康检查返回 503 → 北极星摘除实例
3. **正常请求** → 返回 200

### 北极星配置建议

```yaml
# polaris.yaml
provider:
  healthCheck:
    timeout: 3s              # 健康检查超时（短）
    
consumer:
  timeout: 45s               # 业务请求超时（比服务器40秒稍长）
```

## 最佳实践

### 1. 超时时间设置

根据业务场景设置合理的超时时间：

| 场景 | 推荐超时 | 说明 |
|------|---------|------|
| 小PDF（<10页） | 30秒 | 快速处理 |
| 中等PDF（10-50页） | 40秒 | **当前配置** |
| 大PDF（50-100页） | 60秒 | 需要更长时间 |
| 超大PDF（>100页） | 120秒 | 考虑分批处理 |

### 2. 客户端配置

客户端超时应比服务器超时稍长：

```javascript
// 服务器超时：40秒
// 客户端超时：45秒（留5秒缓冲）
fetch(url, {
  timeout: 45000
})
```

### 3. 错误处理

客户端应正确处理超时错误：

```javascript
try {
  const response = await fetch('/api/pdf2img', options);
  if (response.status === 408) {
    // 处理超时：重试或提示用户
    console.error('请求超时，请稍后重试');
  }
} catch (error) {
  console.error('请求失败:', error);
}
```

### 4. 监控告警

建议监控超时指标：

- 超时请求数量
- 超时请求占比
- 平均响应时间

当超时率超过阈值时触发告警。

## 性能优化建议

如果频繁出现超时，考虑以下优化：

### 1. 增加超时时间

```javascript
// 修改为60秒
const DEFAULT_TIMEOUT = 60000;
```

### 2. 优化PDF处理

- 启用并发处理（已实现）
- 使用 Worker Threads（已实现）
- 优化图片压缩参数

### 3. 分批处理

对于大PDF，建议分批处理：

```javascript
// 不要一次处理所有页面
// pages: "all"  ❌

// 分批处理
// pages: [1, 2, 3, 4, 5]  ✅
```

### 4. 增加服务实例

使用 PM2 Cluster 模式增加实例数：

```javascript
// entry.js
const instances = `-i ${cpuCount}`;  // 使用所有核心
```

## 故障排查

### 问题1：请求总是超时

**可能原因**：
- PDF文件过大
- 网络下载慢
- 服务器资源不足

**解决方案**：
1. 检查PDF文件大小和页数
2. 检查网络连接
3. 增加超时时间
4. 优化服务器配置

### 问题2：超时时间不准确

**可能原因**：
- 代码缓存未更新
- PM2未重启

**解决方案**：
```bash
# 重启服务
pm2 restart all

# 或重新部署
npm run prod
```

### 问题3：健康检查也超时

**检查配置**：
健康检查端点应该被豁免：

```javascript
// src/timeout-middleware.js
if (req.path === '/api/health' || req.path === '/api/polaris-health') {
  return next();  // 跳过超时检查
}
```

## 相关文件

- [`src/timeout-middleware.js`](/data/home/johnsomwu/pdf2img/src/timeout-middleware.js) - 超时中间件实现
- [`app.js`](/data/home/johnsomwu/pdf2img/app.js) - 中间件集成
- [`test/timeout.test.mjs`](/data/home/johnsomwu/pdf2img/test/timeout.test.mjs) - 超时测试脚本

## 更新日志

### v1.2.0 (2024-12-03)

- ✅ 新增40秒接口超时处理
- ✅ 超时时返回408状态码
- ✅ 健康检查端点豁免超时
- ✅ 完善日志记录
- ✅ 添加超时测试脚本

---

## 技术支持

如有问题，请联系开发团队或查看项目文档。
