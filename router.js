import express from 'express';
import { ExportImage } from './pdf2img.js';

const router = express.Router();

router.get('/pdf2img', async (req, res) => {
  global.begin = Date.now();
  console.log('触发接口:/api/pdf2img');
  const url = req.query.url;
  if (!url) {
    console.log('无 url 拦截');
    return res.status(400).send({
      code: 400,
      message: 'URL is required',
    });
  }

  try {
    const exportImage = new ExportImage();
    await exportImage.pdfToImage(url, process.env.OUTPUT_DIR);
    // console.log('🚀全部截图完成', Date.now() - global.begin + 'ms');
    res.send({
      code: 200,
      message: 'ok',
    });
  } catch (error) {
    console.error('错误异常', error);
    res.send({
      code: 500,
      message: error.message,
    });
  }
});

export default router;