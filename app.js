import { config } from 'dotenv';
import apiRouter from './router.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
// import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch'

const interceptor = new FetchInterceptor();

// Enable the interception of requests.
interceptor.apply()
// 存储请求开始时间的映射表（以 requestId 为键）
const requestTimers = new Map();
// Listen to any "http.ClientRequest" being dispatched,
// and log its method and full URL.
interceptor.on('request', ({ request, requestId }) => {
  requestTimers.set(requestId, Date.now()); // 记录请求开始时间戳
  console.log('监听 request', {
    method: request.method,
    url: request.url,
    requestId,
  });
})

// Listen to any responses sent to "http.ClientRequest".
// Note that this listener is read-only and cannot affect responses.
interceptor.on(
  'response',
  ({ response, isMockedResponse, request, requestId }) => {
    const startTime = requestTimers.get(requestId);

    if (startTime) {
      const cost = Date.now() - startTime; // 计算耗时（毫秒）
      requestTimers.delete(requestId); // 清理计时器

      console.log('监听 response', {
        url: request.url,
        status: response.status,
        // range: response.headers,
        size: response.headers.get('content-length') / 1024 / 1024 + 'MB', // 打印接口返回大小
        cost: `${cost}ms` // 打印接口耗时
      });
    }
  }
)

// 3. 激活拦截器
interceptor.apply();

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
app.use('/static', (req, res, next) => {
  // 打印访问路径
  console.log({
    method: req.method,
    url: req.originalUrl,
    range: req.headers.range,
    contentLength: req.headers['content-length']
  });
  // 显式调用静态资源中间件
  express.static(path.join(__dirname, 'static'), {
    setHeaders: (res, filePath, stat) => {
      // 启用分片请求支持
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
    }
  })(req, res, next);
});

// app.use('/static', express.static(path.join(__dirname, 'static'), {
//   setHeaders: (res) => {
//     console.log('访问静态资源服务');
//     res.setHeader('Accept-Ranges', 'bytes'); // 启用分片请求
//     res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
//   }
// }));

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