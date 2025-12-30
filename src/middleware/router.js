import express from 'express';
import os from 'os';
import { createExportImage, IS_DEV } from '../core/pdf2img.js';
import { parseJsonParam, isValidUrl } from '../utils/utils.js';
import { checkHealth, incrementActiveRequests, decrementActiveRequests } from '../monitoring/health-monitor.js';
import { createRequestTracker, getMetricsSummary, resetMetrics, recordOverloadReject, METRICS_ENABLED } from '../monitoring/metrics.js';
import { getAllPoolsStatus } from '../workers/adaptive-pool.js';

const router = express.Router();

// 请求计数器（用于生成唯一请求 ID）
let requestCounter = 0;

// ==================== 进程级并发控制（渲染配额 + 排队） ====================
// 说明：把"PDF渲染"作为稀缺资源做硬限制，避免高并发下尾延迟雪崩
// 优化：根据 CPU 核心数动态调整并发配额，让 CPU 利用率更高
const CPU_CORES = os.cpus().length;
const PDF2IMG_MAX_INFLIGHT = parseInt(process.env.PDF2IMG_MAX_INFLIGHT) || Math.max(4, CPU_CORES);
const PDF2IMG_QUEUE_LIMIT = parseInt(process.env.PDF2IMG_QUEUE_LIMIT) || 100;

class AsyncSemaphore {
  constructor(max, queueLimit) {
    this.max = max;
    this.queueLimit = queueLimit;
    this.inflight = 0;
    this.queue = [];
  }

  getStatus() {
    return { max: this.max, inflight: this.inflight, queue: this.queue.length, queueLimit: this.queueLimit };
  }

  async acquire({ signal } = {}) {
    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    if (this.inflight < this.max) {
      this.inflight++;
      return {
        waitMs: 0,
        release: () => {
          this.inflight = Math.max(0, this.inflight - 1);
          const next = this.queue.shift();
          if (next) next();
        },
      };
    }

    if (this.queue.length >= this.queueLimit) {
      const err = new Error('Render queue is full');
      err.code = 'QUEUE_FULL';
      throw err;
    }

    const enqueuedAt = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        // 从队列里移除当前等待者（尽量）
        const idx = this.queue.indexOf(onGrant);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error('Request aborted'));
      };

      const onGrant = () => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);

        this.inflight++;
        const waitMs = Date.now() - enqueuedAt;
        resolve({
          waitMs,
          release: () => {
            this.inflight = Math.max(0, this.inflight - 1);
            const next = this.queue.shift();
            if (next) next();
          },
        });
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(onGrant);
    });
  }
}

const renderSemaphore = new AsyncSemaphore(PDF2IMG_MAX_INFLIGHT, PDF2IMG_QUEUE_LIMIT);
console.log(`[Router] PDF2IMG 并发配额: inflight=${PDF2IMG_MAX_INFLIGHT} (CPU核心: ${CPU_CORES}), queueLimit=${PDF2IMG_QUEUE_LIMIT}`);

/**
 * PDF转图片接口
 * 
 * @param {Object} req - 请求对象
 * @param {Object} req.body - 请求体参数
 * @param {string} req.body.url - PDF文件的URL地址（必需）
 * @param {string} req.body.globalPadId - 全局标识符，用于文件上传和日志追踪（必需）
 * @param {string|number[]} [req.body.pages] - 要转换的页码，支持以下格式：
 *   - "all": 转换所有页面
 *   - [1, 3, 5]: 转换指定页码数组
 *   - 不传或null: 默认转换前6页
 * 
 * @param {Object} res - 响应对象
 * @returns {Object} 响应数据
 * @property {number} code - 状态码（200=成功，400=参数错误，500=服务器错误，502=网络错误）
 * @property {Object[]|null} data - 转换结果数据
 * @property {string} data[].cosKey - COS存储的文件路径（生产环境）
 * @property {string} data[].outputPath - 本地文件路径（开发环境）
 * @property {number} data[].width - 图片宽度
 * @property {number} data[].height - 图片高度
 * @property {number} data[].pageNum - 页码
 * @property {string} message - 响应消息
 * 
 * @example
 * // 请求示例
 * {
 *   "url": "https://example.com/document.pdf",
 *   "globalPadId": "doc-123456",
 *   "pages": "all"
 * }
 * 
 * @example
 * // 成功响应示例（生产环境）
 * {
 *   "code": 200,
 *   "data": [
 *     {
 *       "cosKey": "/doc-123456/page_1.webp",
 *       "width": 1584,
 *       "height": 2244,
 *       "pageNum": 1
 *     }
 *   ],
 *   "message": "ok"
 * }
 * 
 * @example
 * // 成功响应示例（开发环境）
 * {
 *   "code": 200,
 *   "data": [
 *     {
 *       "outputPath": "/tmp/pdf2img/doc-123456/page_1.webp",
 *       "width": 1584,
 *       "height": 2244,
 *       "pageNum": 1
 *     }
 *   ],
 *   "message": "ok"
 * }
 */
router.post('/pdf2img', async (req, res) => {
  // 生成请求 ID
  const requestId = `req-${++requestCounter}-${Date.now()}`;
  const url = req.body.url;
  const globalPadId = req.body.globalPadId;

  // 创建请求追踪器
  const tracker = createRequestTracker(requestId, {
    globalPadId,
    url: url ? url.substring(0, 100) : null,
    pages: req.body.pages,
    semaphore: renderSemaphore.getStatus(),
  });

  // 取消信号（超时/客户端断开连接）
  const abortController = new AbortController();
  req.abortController = abortController;

  // 客户端断开连接时，主动中止后续下载/渲染
  res.on('close', () => {
    if (!res.writableEnded && !abortController.signal.aborted) {
      abortController.abort(new Error('Client disconnected'));
    }
  });

  // 1) 参数校验（不占用渲染配额）
  tracker.startPhase('validation');

  if (!url) {
    console.warn(`[${requestId}] 无 url 拦截`);
    tracker.endPhase('validation', { error: 'missing url' });
    tracker.finish(false, new Error('URL is required'));
    return res.status(400).send({ code: 400, message: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    console.warn(`[${requestId}] URL 格式不正确`);
    tracker.endPhase('validation', { error: 'invalid url' });
    tracker.finish(false, new Error('Invalid URL format'));
    return res.status(400).send({ code: 400, message: 'Invalid URL format' });
  }

  if (!globalPadId) {
    console.warn(`[${requestId}] 无 globalPadId 拦截`);
    tracker.endPhase('validation', { error: 'missing globalPadId' });
    tracker.finish(false, new Error('globalPadId is required'));
    return res.status(400).send({ code: 400, message: 'globalPadId is required' });
  }

  const pages = parseJsonParam(req.body.pages);
  if (pages && pages !== 'all' && !Array.isArray(pages)) {
    tracker.endPhase('validation', { error: 'invalid pages format' });
    tracker.finish(false, new Error('Invalid pages format'));
    return res.status(400).send({
      code: 400,
      message: 'pages must be an Array or String as "all"',
    });
  }

  tracker.endPhase('validation');
  console.log(`[${requestId}] 触发接口:/api/pdf2img globalPadId: ${globalPadId}`);

  // 2) 健康检查（快速拒绝，避免进入排队）
  try {
    tracker.startPhase('healthCheck');
    const healthStatus = await checkHealth();
    tracker.endPhase('healthCheck', { healthy: healthStatus.healthy });

    if (!healthStatus.healthy) {
      console.warn(`[${requestId}] ⚠️ 服务过载，拒绝新请求:`, healthStatus.reasons);
      recordOverloadReject();
      tracker.event('overloadReject', { reasons: healthStatus.reasons });
      tracker.finish(false, new Error('Service overloaded'));

      return res.status(503).send({
        code: 503,
        message: 'Service is overloaded, please try again later',
        data: {
          reasons: healthStatus.reasons,
          metrics: healthStatus.metrics,
          retryAfter: 5,
        },
      });
    }
  } catch (error) {
    console.error(`[${requestId}] 负载检查失败:`, error.message);
    // 健康检查失败不阻塞请求，继续处理
  }

  // 3) 获取渲染配额（进程级硬限制 + 排队）
  let permit = null;
  let exportImage;

  try {
    tracker.startPhase('queue');
    permit = await renderSemaphore.acquire({ signal: abortController.signal });
    tracker.endPhase('queue', { waitMs: permit.waitMs, semaphore: renderSemaphore.getStatus() });
    tracker.recordQueueWait?.(permit.waitMs);
    tracker.event('queueAcquired', { waitMs: permit.waitMs, semaphore: renderSemaphore.getStatus() });

    // 从这里开始计入活跃请求（真正占用CPU/内存）
    incrementActiveRequests();

    tracker.startPhase('createExportImage');
    exportImage = await createExportImage({ globalPadId, requestTracker: tracker, abortSignal: abortController.signal });
    tracker.endPhase('createExportImage');

    tracker.event('startPdfToImage', { pages: Array.isArray(pages) ? pages.length : pages });

    const data = await exportImage.pdfToImage({ pdfPath: url, pages });

    const summary = tracker.finish(true);
    console.log(`[${requestId}] 请求成功完成`, {
      totalDuration: summary.totalDuration,
      pageCount: data.length,
    });

    return res.send({
      code: 200,
      data,
      message: 'ok',
      ...(IS_DEV && METRICS_ENABLED ? { _metrics: summary } : {}),
    });
  } catch (error) {
    // 队列满：明确 503 + Retry-After
    if (error?.code === 'QUEUE_FULL') {
      recordOverloadReject();
      tracker.event('queueFull', { semaphore: renderSemaphore.getStatus() });
      tracker.finish(false, error);

      return res.status(503).send({
        code: 503,
        message: 'Service is busy, please try again later',
        data: { retryAfter: 2, semaphore: renderSemaphore.getStatus() },
      });
    }

    console.error(`[${requestId}] 错误异常:`, error.message);
    tracker.event('error', { message: error.message, stack: error.stack?.substring(0, 500) });
    tracker.finish(false, error);

    const statusCode = error.message.includes('请求初始数据失败') ? 502 : 500;
    return res.status(statusCode).send({ code: statusCode, data: null, message: error.message });
  } finally {
    // 释放渲染配额
    try {
      permit?.release?.();
    } catch (_) {}

    // 减少活跃请求计数
    decrementActiveRequests();

    // 清理 ExportImage 实例
    if (exportImage) {
      try {
        await exportImage.destroy();
        exportImage = null;
      } catch (destroyError) {
        console.warn(`[${requestId}] ExportImage实例清理失败:`, destroyError.message);
      }
    }
  }
});

/**
 * 健康检查端点（支持高负载丢弃）
 * 
 * 当系统负载过高时，返回 503 状态码，触发北极星自动摘除实例
 * 
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @returns {Object} 健康状态信息
 * @property {number} code - 状态码（200=正常，503=过载）
 * @property {Object} data - 健康数据
 * @property {string} data.status - 服务状态（"healthy"=正常，"overloaded"=过载）
 * @property {boolean} data.healthy - 是否健康
 * @property {string[]} data.reasons - 不健康的原因（仅在过载时）
 * @property {Object} data.metrics - 详细指标
 * @property {Object} data.metrics.cpu - CPU 使用情况
 * @property {Object} data.metrics.memory - 系统内存使用情况
 * @property {Object} data.metrics.heap - 堆内存使用情况
 * @property {number} data.uptime - 服务运行时间（秒）
 * @property {string} message - 响应消息
 * 
 * @example
 * // 正常响应示例（200）
 * {
 *   "code": 200,
 *   "data": {
 *     "healthy": true,
 *     "status": "healthy",
 *     "reasons": [],
 *     "metrics": {
 *       "cpu": { "usage": "45.23", "threshold": 85, "healthy": true },
 *       "memory": { "usage": "60.50", "usedMB": "4800.00", "totalMB": "8000.00", "threshold": 85, "healthy": true },
 *       "heap": { "usage": "55.30", "usedMB": "128.50", "totalMB": "232.00", "threshold": 80, "healthy": true }
 *     },
 *     "uptime": 86400,
 *     "timestamp": "2024-12-03T09:30:00.000Z"
 *   },
 *   "message": "Service is healthy"
 * }
 * 
 * @example
 * // 过载响应示例（503）
 * {
 *   "code": 503,
 *   "data": {
 *     "healthy": false,
 *     "status": "overloaded",
 *     "reasons": [
 *       "CPU过载: 92.50% (阈值: 85%)",
 *       "内存过载: 88.30% (阈值: 85%)"
 *     ],
 *     "metrics": {
 *       "cpu": { "usage": "92.50", "threshold": 85, "healthy": false },
 *       "memory": { "usage": "88.30", "usedMB": "7064.00", "totalMB": "8000.00", "threshold": 85, "healthy": false },
 *       "heap": { "usage": "75.20", "usedMB": "174.50", "totalMB": "232.00", "threshold": 80, "healthy": true }
 *     },
 *     "uptime": 86400,
 *     "timestamp": "2024-12-03T09:30:00.000Z"
 *   },
 *   "message": "Service is overloaded"
 * }
 */
router.get('/health', async (req, res) => {
  try {
    // 检查系统健康状态
    const healthStatus = await checkHealth();
    
    // 如果系统过载，返回 503 状态码
    if (!healthStatus.healthy) {
      console.warn('[Health Check] 系统过载，返回 503:', healthStatus.reasons.join(', '));
      return res.status(503).send({
        code: 503,
        data: healthStatus,
        message: 'Service is overloaded',
      });
    }
    
    // 系统正常，返回 200
    res.send({
      code: 200,
      data: healthStatus,
      message: 'Service is healthy',
    });
  } catch (error) {
    console.error('[Health Check] 健康检查失败:', error.message);
    // 健康检查失败也返回 503，避免将故障实例加入负载均衡
    res.status(503).send({
      code: 503,
      data: {
        healthy: false,
        status: 'error',
        error: error.message,
      },
      message: 'Health check failed',
    });
  }
});

/**
 * 性能指标端点
 * 
 * 返回服务的详细性能指标，包括：
 * - 请求统计（总数、成功、失败、超时、过载拒绝）
 * - 响应时间分布（平均、P50、P90、P99）
 * - 渲染统计（页面数、成功率、渲染时间）
 * - 分片加载统计（请求数、下载量、失败数）
 * - Worker 线程统计
 * - 上传统计
 * - 并发统计
 */
router.get('/metrics', async (req, res) => {
  try {
    const metrics = getMetricsSummary();
    res.send({
      code: 200,
      data: metrics,
      message: 'ok',
    });
  } catch (error) {
    console.error('[Metrics] 获取指标失败:', error.message);
    res.status(500).send({
      code: 500,
      data: null,
      message: error.message,
    });
  }
});

/**
 * 重置性能指标
 */
router.post('/metrics/reset', async (req, res) => {
  try {
    resetMetrics();
    res.send({
      code: 200,
      data: null,
      message: 'Metrics reset successfully',
    });
  } catch (error) {
    console.error('[Metrics] 重置指标失败:', error.message);
    res.status(500).send({
      code: 500,
      data: null,
      message: error.message,
    });
  }
});

/**
 * Worker 池状态端点
 * 
 * 返回自适应 Worker 池的详细状态，包括：
 * - 当前线程数
 * - 配置范围（最小/最大线程数）
 * - 任务统计
 * - 系统指标（CPU、内存、队列）
 * - 最近调整历史
 */
router.get('/workers', async (req, res) => {
  try {
    const status = getAllPoolsStatus();
    res.send({
      code: 200,
      data: status,
      message: 'ok',
    });
  } catch (error) {
    console.error('[Workers] 获取状态失败:', error.message);
    res.status(500).send({
      code: 500,
      data: null,
      message: error.message,
    });
  }
});

export default router;