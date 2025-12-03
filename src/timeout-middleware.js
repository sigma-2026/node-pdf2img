/**
 * 请求超时中间件
 * 为每个请求设置超时时间，防止长时间运行的请求占用资源
 */

// 默认超时时间：40秒
const DEFAULT_TIMEOUT = 40000;

/**
 * 创建超时中间件
 * @param {number} timeout - 超时时间（毫秒），默认 40000ms (40秒)
 */
export function timeoutMiddleware(timeout = DEFAULT_TIMEOUT) {
  return (req, res, next) => {
    // 跳过健康检查端点
    if (req.path === '/api/health' || req.path === '/api/polaris-health' || req.path === '/api/stats') {
      return next();
    }

    // 标记请求是否已超时
    let isTimeout = false;

    // 设置请求超时定时器
    const timeoutId = setTimeout(() => {
      isTimeout = true;
      
      console.error(`[Timeout] 请求超时 (${timeout}ms): ${req.method} ${req.originalUrl}`);
      
      if (!res.headersSent) {
        res.status(408).json({
          code: 408,
          message: `Request timeout after ${timeout}ms`,
          data: null,
        });
      }
    }, timeout);

    // 监听响应完成事件，清除定时器
    res.on('finish', () => {
      clearTimeout(timeoutId);
    });

    // 监听响应关闭事件（客户端断开连接）
    res.on('close', () => {
      clearTimeout(timeoutId);
      if (!res.finished && !isTimeout) {
        console.warn(`[Timeout] 客户端断开连接: ${req.method} ${req.originalUrl}`);
      }
    });

    next();
  };
}

/**
 * 获取当前配置的超时时间
 */
export function getTimeoutConfig() {
  return {
    timeout: DEFAULT_TIMEOUT,
    timeoutSeconds: DEFAULT_TIMEOUT / 1000,
  };
}
