# /pdf2img 接口高负载丢弃功能

## 📋 功能概述

为 `/pdf2img` 接口添加了高负载丢弃（Load Shedding）功能，当系统负载过高时，自动拒绝新请求，保护服务稳定性。

## 🎯 设计目标

1. **快速失败**：在请求入口处检查负载，过载时立即返回 503，避免资源浪费
2. **保护稳定性**：防止系统在高负载下崩溃或所有请求超时
3. **配合北极星**：通过 503 状态码触发北极星自动摘除过载实例
4. **提升体验**：快速返回错误（<10ms），而不是等待超时（40秒）

## 🔧 工作原理

### 请求处理流程

```
用户请求 → /pdf2img 接口
              ↓
         检查系统负载
         (CPU/内存/堆内存)
              ↓
    ┌─────────┴─────────┐
    ↓                   ↓
负载正常              负载过高
    ↓                   ↓
处理请求          返回 503 (快速失败)
    ↓                   ↓
返回结果          建议重试时间
```

### 负载检测指标

| 指标 | 默认阈值 | 说明 |
|------|---------|------|
| **CPU 使用率** | 85% | 系统 CPU 使用率 |
| **内存使用率** | 85% | 系统内存使用率 |
| **堆内存使用率** | 80% | Node.js 堆内存使用率 |

**判断逻辑**：任一指标超过阈值，即判定为过载

## 📊 响应格式

### 正常响应（200）

```json
{
  "code": 200,
  "data": [
    {
      "cosKey": "/doc-123456/page_1.webp",
      "width": 1584,
      "height": 2244,
      "pageNum": 1
    }
  ],
  "message": "ok"
}
```

### 过载响应（503）

```json
{
  "code": 503,
  "message": "Service is overloaded, please try again later",
  "data": {
    "reasons": [
      "CPU过载: 92.35% (阈值: 85%)",
      "堆内存过载: 87.21% (阈值: 80%)"
    ],
    "metrics": {
      "cpu": {
        "usage": "92.35",
        "threshold": 85,
        "healthy": false
      },
      "memory": {
        "usage": "78.45",
        "threshold": 85,
        "healthy": true
      },
      "heap": {
        "usage": "87.21",
        "threshold": 80,
        "healthy": false
      }
    },
    "retryAfter": 5
  }
}
```

## 🔄 与北极星的配合

### 双重保护机制

| 保护层 | 端点 | 作用 | 响应时间 | 触发条件 |
|--------|------|------|----------|----------|
| **第一层** | `/pdf2img` | 请求入口保护 | <10ms | 每次请求检查 |
| **第二层** | `/api/health` | 实例级保护 | 5秒间隔 | 北极星定期检查 |

### 工作流程

```
1. 用户请求 → 北极星 → Go服务 → Node.js /pdf2img
                                        ↓
2. /pdf2img 检查负载（CPU/内存/堆内存）
                                        ↓
3a. 负载正常 → 处理请求 → 返回结果 ✅
                                        ↓
3b. 负载过高 → 立即返回 503 ❌
                                        ↓
4. 北极星健康检查 → /api/health 返回 503
                                        ↓
5. 北极星摘除实例（连续2次失败）
                                        ↓
6. 负载降低 → /api/health 返回 200
                                        ↓
7. 北极星恢复实例（连续2次成功）
```

### 优势

- ✅ **快速拒绝**：/pdf2img 在 <10ms 内拒绝新请求
- ✅ **自动摘除**：/api/health 触发北极星在 5-10 秒内摘除实例
- ✅ **双重保护**：即使健康检查延迟，请求入口也能保护
- ✅ **优雅恢复**：负载降低后自动恢复服务

## 🛠️ 配置说明

### 环境变量

```bash
# CPU 使用率阈值（百分比）
CPU_THRESHOLD=85

# 内存使用率阈值（百分比）
MEMORY_THRESHOLD=85

# 堆内存使用率阈值（百分比）
HEAP_THRESHOLD=80
```

### 推荐配置（4核8G机器）

```bash
# 生产环境（保守）
CPU_THRESHOLD=85
MEMORY_THRESHOLD=85
HEAP_THRESHOLD=80

# 高负载环境（激进）
CPU_THRESHOLD=90
MEMORY_THRESHOLD=90
HEAP_THRESHOLD=85

# 测试环境（敏感）
CPU_THRESHOLD=70
MEMORY_THRESHOLD=70
HEAP_THRESHOLD=70
```

## 🧪 测试方法

### 1. 运行测试脚本

```bash
# 启动服务
pnpm run dev

# 在另一个终端运行测试
node test/pdf2img-load-protection.test.mjs
```

### 2. 手动测试

```bash
# 正常请求
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/test.pdf",
    "globalPadId": "test-123",
    "pages": [1]
  }'
```

### 3. 触发高负载丢弃

**方式1：降低阈值**
```bash
# 设置低阈值启动服务
CPU_THRESHOLD=50 HEAP_THRESHOLD=60 pnpm run dev

# 发送请求（很可能触发 503）
curl -X POST http://localhost:3000/api/pdf2img \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/test.pdf", "globalPadId": "test-123"}'
```

**方式2：并发压测**
```bash
# 使用 ab 工具压测
ab -n 100 -c 10 -p test-data.json -T application/json \
  http://localhost:3000/api/pdf2img

# 使用 wrk 工具压测
wrk -t4 -c20 -d30s --latency \
  -s post.lua http://localhost:3000/api/pdf2img
```

## 📈 性能影响

### 负载检查开销

- **CPU 检查**：~5ms（需要采样计算）
- **内存检查**：<1ms（直接读取）
- **堆内存检查**：<1ms（直接读取）
- **总开销**：~5-10ms

### 对比分析

| 场景 | 无保护 | 有保护 | 差异 |
|------|--------|--------|------|
| **正常请求** | 2000-4000ms | 2005-4010ms | +5-10ms |
| **过载请求** | 40000ms（超时） | 5-10ms（快速失败） | -99.98% |

**结论**：正常请求增加 <1% 延迟，过载请求减少 99.98% 延迟

## 🔍 监控建议

### 关键指标

1. **503 响应率**：过载拒绝请求的比例
2. **负载检查耗时**：checkHealth 函数执行时间
3. **系统指标**：CPU、内存、堆内存使用率
4. **请求成功率**：200 响应的比例

### 日志示例

```
[PDF2IMG] ⚠️ 服务过载，拒绝新请求: {
  reasons: [
    'CPU过载: 92.35% (阈值: 85%)',
    '堆内存过载: 87.21% (阈值: 80%)'
  ],
  metrics: {
    cpu: { usage: '92.35', threshold: 85, healthy: false },
    memory: { usage: '78.45', threshold: 85, healthy: true },
    heap: { usage: '87.21', threshold: 80, healthy: false }
  }
}
```

## 🚨 故障排查

### 问题1：频繁返回 503

**可能原因**：
- 阈值设置过低
- 系统负载确实过高
- 内存泄漏

**解决方案**：
```bash
# 1. 检查当前负载
curl http://localhost:3000/api/health

# 2. 调整阈值
CPU_THRESHOLD=90 MEMORY_THRESHOLD=90 pnpm run dev

# 3. 启用 PM2 集群模式
pnpm run pm2

# 4. 检查内存泄漏
node --inspect app.js
```

### 问题2：负载检查失败

**日志示例**：
```
[PDF2IMG] 负载检查失败: Error: ...
```

**影响**：负载检查失败不会阻塞请求，请求会继续处理

**解决方案**：
- 检查 health-monitor.js 模块是否正常
- 查看详细错误日志
- 重启服务

### 问题3：北极星未摘除实例

**可能原因**：
- 健康检查配置不正确
- 连续失败次数未达到阈值（默认2次）
- 健康检查间隔过长

**解决方案**：
```yaml
# 调整北极星配置
healthCheck:
  interval: 5s      # 检查间隔
  timeout: 3s       # 超时时间
  unhealthyThreshold: 2  # 连续失败次数
  healthyThreshold: 2    # 连续成功次数
```

## 📚 相关文档

- [健康检查文档](./HEALTH_LOAD_SHEDDING.md)
- [超时配置文档](./TIMEOUT_CONFIG.md)
- [性能优化文档](./PERFORMANCE_OPTIMIZATION.md)
- [北极星集成文档](./POLARIS_HEALTH_CHECK.md)

## 🎉 总结

### 核心优势

1. ✅ **快速失败**：过载时 <10ms 返回 503
2. ✅ **保护稳定**：防止系统崩溃和雪崩
3. ✅ **自动恢复**：配合北极星实现优雅降级
4. ✅ **低开销**：正常请求仅增加 5-10ms
5. ✅ **易配置**：通过环境变量灵活调整

### 适用场景

- ✅ 资源密集型接口（如 PDF 转图片）
- ✅ 高并发场景
- ✅ 需要保护服务稳定性
- ✅ 配合负载均衡使用

### 不适用场景

- ❌ 低负载、低并发场景
- ❌ 对延迟极其敏感的接口（<5ms）
- ❌ 不能容忍任何请求失败的场景
