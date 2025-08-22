import express from 'express';
import { ExportImage } from './pdf2img.js';

const router = express.Router();

router.post('/pdf2img', async (req, res) => {
  global.begin = Date.now();
  console.log('触发接口:/api/pdf2img');
  const url = req.body.url;
  if (!url) {
    console.log('无 url 拦截');
    return res.status(400).send({
      code: 400,
      message: 'URL is required',
    });
  }

  try {
    const globalPadId = req.body.globalPadId;
    const exportImage = new ExportImage({ globalPadId });
    const pages = req.body.pages
      ? (typeof req.body.pages === 'string' ? JSON.parse(req.body.pages) : req.body.pages)
      : [1];
    const data = await exportImage.pdfToImage({
      pdfPath: url,
      outputDir: process.env.OUTPUT_DIR,
      pages: pages,
    });
    res.send({
      code: 200,
      data: data,
      message: 'ok',
    });
  } catch (error) {
    console.error('错误异常', error);
    res.send({
      code: 500,
      data: null,
      message: error.message,
    });
  }
});

export default router;