/**
 * 请求超时中间件
 * 
 * 优化策略：
 * 1. 中间件层设置宽松的"守门"超时（MAX_TIMEOUT），防止请求无限期挂起
 * 2. 精准超时在 pdf2img.js 内部实现，基于真实文件大小计算
 * 
 * 这样设计的原因：
 * - 中间件层无法获取真实文件大小，只能估算
 * - 过短的超时会误杀正常请求，过长的超时浪费资源
 * - 精准超时需要在获取 pdfSize 后才能计算
 */

import { TIMEOUT_CONFIG } from '../monitoring/config.js';

// 守门超时：使用 MAX_TIMEOUT 作为最外层保护
// 精准超时在 pdf2img.js 内部实现
const GUARDRAIL_TIMEOUT = TIMEOUT_CONFIG.MAX_TIMEOUT;

/**
 * 创建超时中间件
 * @param {number} timeout - 基础超时时间（毫秒），默认使用 MAX_TIMEOUT 作为守门
 */
export function timeoutMiddleware(timeout = GUARDRAIL_TIMEOUT) {
  return (req, res, next) => {
    // 跳过健康检查和指标端点
    if (req.path === '/api/health' || 
        req.path === '/api/polaris-health' || 
        req.path === '/api/stats' ||
        req.path === '/api/metrics' ||
        req.path === '/api/metrics/reset') {
      return next();
    }

    // 使用守门超时（MAX_TIMEOUT），精准超时在业务层实现
    const guardrailTimeout = timeout;

    // 标记请求是否已超时
    let isTimeout = false;

    // 设置守门超时定时器（最外层保护）
    const timeoutId = setTimeout(() => {
      isTimeout = true;

      // 主动取消后续下载/渲染
      try {
        req.abortController?.abort(new Error(`Guardrail timeout after ${guardrailTimeout}ms`));
      } catch (_) {}
      
      console.error(`[Timeout] 守门超时 (${guardrailTimeout}ms): ${req.method} ${req.originalUrl}`);
      
      if (!res.headersSent) {
        res.status(408).json({
          code: 408,
          message: `Request timeout after ${guardrailTimeout}ms`,
          data: null,
        });
      }
    }, guardrailTimeout);

    // 将超时信息附加到请求对象，供后续使用
    req.timeoutMs = guardrailTimeout;
    req.guardrailTimeout = guardrailTimeout;

    // 监听响应完成事件，清除定时器
    res.on('finish', () => {
      clearTimeout(timeoutId);
    });

    // 监听响应关闭事件（客户端断开连接）
    res.on('close', () => {
      clearTimeout(timeoutId);
      if (!res.finished && !isTimeout) {
        // 客户端断开连接，取消后续下载/渲染
        try {
          req.abortController?.abort(new Error('Client disconnected'));
        } catch (_) {}

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
    guardrailTimeout: GUARDRAIL_TIMEOUT,
    guardrailTimeoutSeconds: GUARDRAIL_TIMEOUT / 1000,
    config: TIMEOUT_CONFIG,
  };
}
