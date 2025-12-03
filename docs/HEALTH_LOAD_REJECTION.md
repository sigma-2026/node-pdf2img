# 健康检查高负载丢弃功能

## 概述

`/api/health` 接口已增强为支持**高负载丢弃**功能。当系统 CPU 或内存负载过高时，接口会返回 **503 Service Unavailable** 状态码，触发北极星自动摘除该实例，避免将请求分配到过载的服务器。

## 功能特性

### ✅ 多维度负载检测

- **CPU 使用率检测** - 实时监控 CPU 负载
- **系统内存检测** - 监控物理内存使用情况
- **堆内存检测** - 监控 Node.js 堆内存使用

### ✅ 自动实例摘除

- 负载过高时返回 **503** 状态码
- 北极星自动摘除过载实例
- 避免雪崩效应

### ✅ 详细指标报告

- 实时 CPU、内存、堆内存使用率
- 健康状态和不健康原因
- 运行时间和时间戳

## 配置说明

### 默认阈值

| 指标 | 阈值 | 环境变量 |
|------|------|---------|
| CPU 使用率 | 85% | `CPU_THRESHOLD` |
| 系统内存使用率 | 85% | `MEMORY_THRESHOLD` |
| 堆内存使用率 | 80% | `HEAP_THRESHOLD` |

### 修改阈值

#### 方式1：环境变量（推荐）

```bash
# 启动时设置
export CPU_THRESHOLD=90
export MEMORY_THRESHOLD=90
export HEAP_THRESHOLD=85

npm run prod
```

#### 方式2：修改代码

编辑 [`src/health-monitor.js`](../src/health-monitor.js)：

```javascript
const HEALTH_CONFIG = {
  CPU_THRESHOLD: 90,      // 修改为 90%
  MEMORY_THRESHOLD: 90,   // 修改为 90%
  HEAP_THRESHOLD: 85,     // 修改为 85%
};
```

## 接口响应

### 正常状态（200 OK）

当所有指标都在阈值范围内时：

```json
{
  "code": 200,
  "data": {
    "healthy": true,
    "status": "healthy",
    "reasons": [],
    "metrics": {
      "cpu": {
        "usage": "45.23",
        "threshold": 85,
        "healthy": true
      },
      "memory": {
        "usage": "60.50",
        "usedMB": "4800.00",
        "totalMB": "8000.00",
        "threshold": 85,
        "healthy": true
      },
      "heap": {
        "usage": "55.30",
        "usedMB": "128.50",
        "totalMB": "232.00",
        "threshold": 80,
        "healthy": true
      }
    },
    "uptime": 86400,
    "timestamp": "2024-12-03T09:30:00.000Z"
  },
  "message": "Service is healthy"
}
```

### 过载状态（503 Service Unavailable）

当任一指标超过阈值时：

```json
{
  "code": 503,
  "data": {
    "healthy": false,
    "status": "overloaded",
    "reasons": [
      "CPU过载: 92.50% (阈值: 85%)",
      "内存过载: 88.30% (阈值: 85%)"
    ],
    "metrics": {
      "cpu": {
        "usage": "92.50",
        "threshold": 85,
        "healthy": false
      },
      "memory": {
        "usage": "88.30",
        "usedMB": "7064.00",
        "totalMB": "8000.00",
        "threshold": 85,
        "healthy": false
      },
      "heap": {
        "usage": "75.20",
        "usedMB": "174.50",
        "totalMB": "232.00",
        "threshold": 80,
        "healthy": true
      }
    },
    "uptime": 86400,
    "timestamp": "2024-12-03T09:30:00.000Z"
  },
  "message": "Service is overloaded"
}
```

### 检查失败（503 Service Unavailable）

当健康检查本身失败时：

```json
{
  "code": 503,
  "data": {
    "healthy": false,
    "status": "error",
    "error": "Health check error message"
  },
  "message": "Health check failed"
}
```

## 工作原理

### 检测流程

```
1. 接收健康检查请求
   ↓
2. 采集系统指标
   - CPU 使用率（100ms 采样）
   - 系统内存使用率
   - 堆内存使用率
   ↓
3. 对比阈值
   - CPU < 85%？
   - 内存 < 85%？
   - 堆内存 < 80%？
   ↓
4. 返回结果
   - 全部正常 → 200 OK
   - 任一过载 → 503 Service Unavailable
```

### CPU 使用率计算

```javascript
// 采样两次 CPU 时间（间隔 100ms）
const cpuUsage = 100 - (100 * idleDiff / totalDiff);
```

### 内存使用率计算

```javascript
// 系统内存
const memoryUsage = (usedMemory / totalMemory) * 100;

// 堆内存
const heapUsage = (heapUsed / heapTotal) * 100;
```

## 与北极星集成

### 北极星配置

```yaml
# polaris.yaml
provider:
  healthCheck:
    enable: true
    protocol: http
    path: /api/health
    interval: 5s          # 每 5 秒检查一次
    timeout: 3s           # 3 秒超时
    unhealthyThreshold: 2 # 连续 2 次失败才摘除
    healthyThreshold: 2   # 连续 2 次成功才恢复
```

### 摘除与恢复流程

```
正常状态（200）
   ↓
负载升高
   ↓
第 1 次检查失败（503）
   ↓
第 2 次检查失败（503）
   ↓
北极星摘除实例 ❌
   ↓
负载降低
   ↓
第 1 次检查成功（200）
   ↓
第 2 次检查成功（200）
   ↓
北极星恢复实例 ✅
```

## 使用场景

### 场景1：正常运行

```bash
# 系统负载正常
CPU: 45%, 内存: 60%, 堆内存: 55%

# 健康检查返回 200
curl http://localhost:3000/api/health
# → 200 OK

# 北极星：实例正常，继续分配流量
```

### 场景2：高负载保护

```bash
# 系统负载过高
CPU: 92%, 内存: 88%, 堆内存: 75%

# 健康检查返回 503
curl http://localhost:3000/api/health
# → 503 Service Unavailable

# 北极星：摘除实例，停止分配流量
```

### 场景3：自动恢复

```bash
# 负载降低
CPU: 50%, 内存: 65%, 堆内存: 60%

# 健康检查返回 200
curl http://localhost:3000/api/health
# → 200 OK

# 北极星：恢复实例，重新分配流量
```

## 测试验证

### 运行测试

```bash
# 运行健康检查高负载测试
npm run test:health-load
```

### 测试输出示例

```
======================================================================
健康检查高负载测试
======================================================================

功能说明:
  - 测试 /api/health 接口的高负载丢弃功能
  - 检测 CPU、内存、堆内存使用率
  - 当负载过高时，接口返回 503 状态码
  - 北极星会自动摘除返回 503 的实例

======================================================================
测试健康检查接口
======================================================================

发送健康检查请求...

响应状态码: 200
响应时间: 125ms

健康状态:
  状态: healthy
  健康: ✅ 是

CPU 指标:
  使用率: 45.23%
  阈值: 85%
  状态: ✅ 正常

系统内存指标:
  使用率: 60.50%
  已用: 4800.00MB
  总量: 8000.00MB
  阈值: 85%
  状态: ✅ 正常

堆内存指标:
  使用率: 55.30%
  已用: 128.50MB
  总量: 232.00MB
  阈值: 80%
  状态: ✅ 正常

运行时间: 86400秒
时间戳: 2024-12-03T09:30:00.000Z

✅ 测试通过：系统健康，返回 200
```

### 手动测试

```bash
# 1. 启动服务
npm run dev

# 2. 测试健康检查
curl http://localhost:3000/api/health

# 3. 模拟高负载（降低阈值）
CPU_THRESHOLD=10 MEMORY_THRESHOLD=10 npm run dev

# 4. 再次测试（应返回 503）
curl http://localhost:3000/api/health
```

## 监控与告警

### 推荐监控指标

1. **健康检查成功率**
   - 指标：`health_check_success_rate`
   - 告警：< 95%

2. **503 响应数量**
   - 指标：`health_check_503_count`
   - 告警：> 10 次/分钟

3. **实例摘除次数**
   - 指标：`polaris_instance_removed_count`
   - 告警：> 5 次/小时

4. **平均负载**
   - CPU 使用率
   - 内存使用率
   - 堆内存使用率

### 日志监控

```bash
# 查看过载日志
grep "系统过载" logs/app.log

# 示例输出
[Health Check] 系统过载，返回 503: CPU过载: 92.50% (阈值: 85%), 内存过载: 88.30% (阈值: 85%)
```

## 最佳实践

### 1. 阈值设置

根据机器配置和业务特点调整阈值：

| 机器配置 | CPU 阈值 | 内存阈值 | 堆内存阈值 |
|---------|---------|---------|-----------|
| 2核4G | 80% | 80% | 75% |
| 4核8G | **85%** | **85%** | **80%** |
| 8核16G | 90% | 90% | 85% |

### 2. 北极星配置

```yaml
# 推荐配置
healthCheck:
  interval: 5s              # 检查间隔
  timeout: 3s               # 超时时间
  unhealthyThreshold: 2     # 摘除阈值
  healthyThreshold: 2       # 恢复阈值
```

### 3. 实例数量

确保有足够的实例数量：

```
最小实例数 = 预期峰值 QPS / 单实例处理能力 * 1.5
```

### 4. 优雅降级

```javascript
// 客户端处理 503
if (response.status === 503) {
  // 重试其他实例
  await retryWithBackoff();
}
```

## 故障排查

### 问题1：频繁返回 503

**可能原因**：
- 阈值设置过低
- 实例数量不足
- 单个请求消耗资源过多

**解决方案**：
1. 提高阈值配置
2. 增加实例数量
3. 优化代码性能

### 问题2：过载但仍返回 200

**可能原因**：
- 健康检查代码未生效
- 阈值设置过高

**解决方案**：
```bash
# 检查代码是否正确部署
curl http://localhost:3000/api/health | jq .

# 降低阈值测试
CPU_THRESHOLD=50 npm run prod
```

### 问题3：北极星未摘除实例

**可能原因**：
- 北极星配置错误
- unhealthyThreshold 设置过高

**解决方案**：
```yaml
# 调整北极星配置
healthCheck:
  unhealthyThreshold: 1  # 降低为 1 次失败即摘除
```

## 性能影响

### 资源消耗

- **CPU**: ~5ms（采样计算）
- **内存**: ~1KB（临时变量）
- **响应时间**: +100-150ms（CPU 采样时间）

### 优化建议

如果健康检查响应时间过长，可以：

1. **减少 CPU 采样时间**
   ```javascript
   // health-monitor.js
   await new Promise(resolve => setTimeout(resolve, 50)); // 改为 50ms
   ```

2. **缓存检查结果**
   ```javascript
   // 缓存 1 秒
   const cachedResult = cache.get('health');
   if (cachedResult) return cachedResult;
   ```

## 相关文件

- [`src/health-monitor.js`](../src/health-monitor.js) - 健康监控模块
- [`src/router.js`](../src/router.js) - 健康检查接口
- [`test/health-load.test.mjs`](../test/health-load.test.mjs) - 测试脚本

## 更新日志

### v1.3.0 (2024-12-03)

- ✅ 新增高负载丢弃功能
- ✅ 支持 CPU、内存、堆内存多维度检测
- ✅ 过载时返回 503 状态码
- ✅ 详细的指标报告和不健康原因
- ✅ 支持环境变量配置阈值
- ✅ 完善测试脚本和文档

---

## 技术支持

如有问题，请联系开发团队或查看项目文档。
