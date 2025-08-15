import { config } from 'dotenv';
import apiRouter from './router.js';
import express from 'express';

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