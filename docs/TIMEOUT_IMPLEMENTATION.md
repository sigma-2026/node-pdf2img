# 40秒接口超时配置 - 实施总结

## 配置完成 ✅

已成功为 `/api/pdf2img` 接口配置 **40秒** 超时处理。

## 实施内容

### 1. 核心文件

#### [`src/timeout-middleware.js`](../src/timeout-middleware.js)
- 超时中间件实现
- 默认超时时间：40秒 (40000ms)
- 超时时返回 HTTP 408 状态码
- 健康检查端点豁免超时

#### [`app.js`](../app.js)
- 集成超时中间件
- 启动时打印超时配置信息
- 中间件顺序：超时中间件 → 基础中间件 → 路由

### 2. 测试文件

#### [`test/timeout.test.mjs`](../test/timeout.test.mjs)
- 超时功能测试脚本
- 测试正常请求和超时请求
- 运行命令：`pnpm run test:timeout`

### 3. 文档文件

#### [`docs/TIMEOUT_CONFIG.md`](../docs/TIMEOUT_CONFIG.md)
- 完整的超时配置文档
- 包含工作原理、使用示例、最佳实践
- 故障排查指南

#### [`README.md`](../README.md)
- 更新特性说明
- 添加超时配置快速指南

### 4. 配置文件

#### [`package.json`](../package.json)
- 添加测试脚本：`pnpm run test:timeout`

## 功能特性

### ✅ 超时保护
- **超时时间**: 40秒
- **适用范围**: 所有 API 接口
- **豁免端点**: `/api/health`, `/api/polaris-health`, `/api/stats`

### ✅ 超时响应
```json
{
  "code": 408,
  "message": "Request timeout after 40000ms",
  "data": null
}
```

### ✅ 日志记录
```
[Timeout] 请求超时 (40000ms): POST /api/pdf2img
[Timeout] 客户端断开连接: POST /api/pdf2img
```

### ✅ 启动提示
```
========== 接口超时配置 ==========
超时时间: 40秒 (40000ms)
===================================
```

## 使用方法

### 启动服务

```bash
# 开发环境
pnpm run dev

# 生产环境（PM2）
pnpm run prod
```

启动时会显示超时配置信息。

### 测试超时功能

```bash
# 运行超时测试
pnpm run test:timeout
```

### 修改超时时间

如需修改超时时间，编辑 `src/timeout-middleware.js`：

```javascript
// 修改为60秒
const DEFAULT_TIMEOUT = 60000;
```

然后重启服务：

```bash
pm2 restart all
```

## 验证结果

### 1. 服务启动验证 ✅

```bash
$ node app.js
========== 接口超时配置 ==========
超时时间: 40秒 (40000ms)
===================================
Server is running on port 3000
```

### 2. 正常请求验证

```bash
# 发送正常请求（40秒内完成）
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/small.pdf",
    "globalPadId": "test-123",
    "pages": [1]
  }'
```

**预期结果**: 正常返回转换结果

### 3. 超时请求验证

```bash
# 发送超时请求（超过40秒）
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://httpbin.org/delay/50",
    "globalPadId": "test-timeout",
    "pages": [1]
  }'
```

**预期结果**: 40秒后返回 408 超时错误

## 与其他功能的集成

### 1. 北极星健康检查

超时中间件与北极星健康检查配合：

- **请求超时** → 返回 408
- **服务过载** → 健康检查返回 503 → 北极星摘除实例
- **正常请求** → 返回 200

### 2. PM2 Cluster 模式

超时配置在所有 PM2 worker 进程中生效：

```javascript
// entry.js
const instances = `-i ${cpuCount - 1}`;  // 多进程模式
```

每个进程独立处理超时。

### 3. 并发限制

超时与并发限制配合使用：

- 并发限制：最多 5 个并发请求
- 超时保护：每个请求最多 40 秒

## 性能影响

### 资源占用

- **CPU**: 几乎无影响（仅定时器）
- **内存**: 每个请求增加 ~1KB（定时器对象）
- **响应时间**: 无影响（异步处理）

### 吞吐量

- **正常请求**: 无影响
- **超时请求**: 40秒后自动释放资源

## 最佳实践

### 1. 超时时间设置

根据 PDF 大小调整超时时间：

| PDF 大小 | 页数 | 推荐超时 |
|---------|------|---------|
| 小 | <10页 | 30秒 |
| 中 | 10-50页 | **40秒** ⭐ |
| 大 | 50-100页 | 60秒 |
| 超大 | >100页 | 120秒 |

### 2. 客户端配置

客户端超时应比服务器超时稍长：

```javascript
// 服务器：40秒
// 客户端：45秒（留5秒缓冲）
fetch(url, { timeout: 45000 })
```

### 3. 错误处理

```javascript
if (response.status === 408) {
  // 超时：重试或提示用户
  console.error('请求超时，请稍后重试');
}
```

### 4. 监控告警

监控以下指标：

- 超时请求数量
- 超时请求占比
- 平均响应时间

## 故障排查

### 问题：请求总是超时

**检查清单**：
1. PDF 文件是否过大？
2. 网络连接是否正常？
3. 服务器资源是否充足？
4. 是否需要增加超时时间？

**解决方案**：
```javascript
// 增加超时时间到60秒
const DEFAULT_TIMEOUT = 60000;
```

### 问题：超时时间不生效

**检查清单**：
1. 是否重启了服务？
2. 代码是否正确部署？
3. PM2 是否重新加载？

**解决方案**：
```bash
# 重启 PM2
pm2 restart all

# 或重新部署
pnpm run prod
```

## 相关文档

- [TIMEOUT_CONFIG.md](./TIMEOUT_CONFIG.md) - 完整超时配置文档
- [POLARIS_HEALTH_CHECK.md](./POLARIS_HEALTH_CHECK.md) - 北极星健康检查文档
- [README.md](../README.md) - 项目主文档

## 更新日志

### v1.2.0 (2024-12-03)

- ✅ 实现40秒接口超时处理
- ✅ 超时时返回 HTTP 408 状态码
- ✅ 健康检查端点豁免超时
- ✅ 启动时显示超时配置
- ✅ 完善日志记录
- ✅ 添加超时测试脚本
- ✅ 完善文档

## 下一步计划

### 可选优化

1. **环境变量配置**
   ```bash
   export REQUEST_TIMEOUT=60000  # 通过环境变量配置
   ```

2. **动态超时**
   根据 PDF 页数动态调整超时时间

3. **超时重试**
   客户端自动重试超时请求

4. **超时监控**
   集成 Prometheus 监控超时指标

---

## 技术支持

如有问题，请联系开发团队。
