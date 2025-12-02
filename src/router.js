import express from 'express';
import { ExportImage } from './pdf2img.js';
import { parseJsonParam, isValidUrl } from './utils.js';

const router = express.Router();

/** PDF转图片接口 */
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
        exportImage = new ExportImage({ globalPadId });
        const pages = parseJsonParam(req.body.pages);

        // 验证 pages 参数
        if (pages && pages !== 'all' && !Array.isArray(pages)) {
            return res.status(400).send({
                code: 400,
                message: 'pages must be an array or "all"',
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

/** 健康检查端点 */
router.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.send({
    code: 200,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      memory: {
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
      },
    },
    message: 'Service is healthy',
  });
});

export default router;