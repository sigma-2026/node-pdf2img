import { config } from 'dotenv';
import apiRouter from './router.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全局捕获异常（添加到入口文件顶部）
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// 关键配置：静态资源服务支持 Range 请求
app.use('/static', express.static(path.join(__dirname, 'static'), {
  setHeaders: (res) => {
    console.log('静态资源服务res', res);
    res.setHeader('Accept-Ranges', 'bytes'); // 启用分片请求
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
  }
}));

// Routes
app.use('/api', apiRouter);

app.get('/', (req, res) => {
  console.log('未授权页面');
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