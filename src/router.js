import express from 'express';
import { createExportImage } from './pdf2img.js';
import { parseJsonParam, isValidUrl } from './utils.js';
import { checkHealth } from './health-monitor.js';

const router = express.Router();

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
  global.begin = Date.now();
  const url = req.body.url;
  const globalPadId = req.body.globalPadId;
  // 验证参数 url
  if (!url) {
    console.error('无 url 拦截');
    return res.status(400).send({
      code: 400,
      message: 'URL is required',
    });
  }


  // 验证 URL 格式
  if (!isValidUrl(url)) {
    console.error('URL 格式不正确');
    return res.status(400).send({
      code: 400,
      message: 'Invalid URL format',
    });
  }

  // 验证参数 globalPadId
  if (!globalPadId) {
    console.error('无 globalPadId 拦截');
    return res.status(400).send({
      code: 400,
      message: 'globalPadId is required',
    });
  }
  console.log('触发接口:/api/pdf2img 请求参数:', { url, globalPadId });

  let exportImage;
  try {
    exportImage = await createExportImage({ globalPadId });
    const pages = parseJsonParam(req.body.pages);
        // 验证传入的 pages 参数
        if (pages && pages !== 'all' && !Array.isArray(pages)) {
            return res.status(400).send({
                code: 400,
                message: 'pages must be an Array or String as "all"',
            });
        }
        const data = await exportImage.pdfToImage({
            pdfPath: url,
            pages,
        });
        res.send({
            code: 200,
            data: data,
            message: 'ok',
        });
    } catch (error) {
        console.error('错误异常', error);
        // 区分不同类型的错误
        const statusCode = error.message.includes('请求初始数据失败') ? 502 : 500;
        res.status(statusCode).send({
            code: statusCode,
            data: null,
            message: error.message,
        });
    } finally {
        // 确保 ExportImage 实例被清理
        if (exportImage) {
            try {
                await exportImage.destroy();
                exportImage = null;
            } catch (destroyError) {
                console.warn('ExportImage实例清理失败:', destroyError.message);
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
    console.error('[Health Check] 健康检查失败:', error);
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

export default router;