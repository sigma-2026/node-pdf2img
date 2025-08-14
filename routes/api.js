import express from 'express';
import { pdfToImage } from '../pdf2img.js';

const router = express.Router();

router.get('/pdf2img', (req, res) => {
  console.log('!!!pdf2img');
  // 调用示例
  pdfToImage('https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf', './output-images')
    .then(() => {
      res.send({
        code: 200,
        message: 'ok',
      });
    })
    .catch((error) => {
      res.send({
        code: 500,
        message: error.message,
      });
    });
});

export default router;