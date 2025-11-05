import express from 'express';
import { ExportImage } from './pdf2img.js';

const router = express.Router();

router.post('/pdf2img', async (req, res) => {
  global.begin = Date.now();
  console.log('触发接口:/api/pdf2img');
  const url = req.body.url;
  const globalPadId = req.body.globalPadId;
  if (!url) {
    console.log('无 url 拦截');
    return res.status(400).send({
      code: 400,
      message: 'URL is required',
    });
  }
  console.log('url:', url);

  if (!globalPadId) {
    console.log('无 globalPadId 拦截');
    return res.status(400).send({
      code: 400,
      message: 'globalPadId is required',
    });
  }
  console.log('globalPadId:', globalPadId);

  try {
    const exportImage = new ExportImage({ globalPadId });
    const pages = req.body.pages
      ? (typeof req.body.pages === 'string' ? JSON.parse(req.body.pages) : req.body.pages)
      : null;
    const screen = req.body.screen
      ? (typeof req.body.screen === 'string' ? JSON.parse(req.body.screen) : req.body.screen)
      : null;
    const data = await exportImage.pdfToImage({
      pdfPath: url,
      outputDir: process.env.OUTPUT_DIR,
      pages,
      screen,
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