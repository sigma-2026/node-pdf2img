import { config } from 'dotenv';
import apiRouter from './routes/api.js';
import express from 'express';
import serveStatic from 'serve-static';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// 设置静态资源目录（包含 pdf.worker.js）
app.use(
  '/static', // 自定义访问路径前缀
  serveStatic(path.join(__dirname, 'node_modules/pdfjs-dist/build'), {
    index: false, // 禁止目录索引
    setHeaders: (res, filePath) => {
      // 为 .mjs 文件设置正确的 MIME 类型
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
    }
  })
);

// Routes

app.use('/api', apiRouter);

app.get('/', (req, res) => {
  res.status(404).send('404 Not Found');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Server Error');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});