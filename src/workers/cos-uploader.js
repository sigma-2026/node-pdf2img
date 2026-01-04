/**
 * COS Uploader - 腾讯云 COS 上传服务 (V7 优化版)
 * 
 * 提供文件上传到 COS 的功能，支持：
 * - 单文件上传
 * - 批量并行上传（带并发控制）
 * - 凭证自动刷新
 * - 带指数退避的重试机制
 * - HTTP Keep-Alive 连接复用
 * 
 * V7 优化：
 * - 启用 Keep-Alive，复用 TCP/TLS 连接，减少握手开销
 * - 添加并发控制器，避免网络拥塞
 * - 配置 HTTP Agent 参数，优化连接池
 */

import COS from 'cos-nodejs-sdk-v5';
import http from 'http';
import https from 'https';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('COS');

// ==================== 配置 ====================

const COS_CONFIG = {
    Bucket: process.env.COS_BUCKET || 'tencent-docs-1251316161',
    Region: process.env.COS_REGION || 'ap-guangzhou',
    Path: process.env.COS_PATH || 'pdf2img',
};

// 重试配置
const COS_RETRY_CONFIG = {
    MAX_RETRIES: parseInt(process.env.COS_MAX_RETRIES) || 3,
    RETRY_DELAY: parseInt(process.env.COS_RETRY_DELAY) || 500, // ms
};

// 上传并发配置
const UPLOAD_CONCURRENCY = parseInt(process.env.COS_UPLOAD_CONCURRENCY) || 6;

// ==================== HTTP Agent 配置（Keep-Alive）====================

/**
 * 创建支持 Keep-Alive 的 HTTP/HTTPS Agent
 * 
 * 优化点：
 * - keepAlive: true - 复用连接，避免重复 TCP/TLS 握手
 * - maxSockets: 10 - 限制最大并发连接数，避免资源耗尽
 * - keepAliveMsecs: 30000 - 保持连接活跃 30 秒
 * - timeout: 60000 - 连接超时 60 秒
 */
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    keepAliveMsecs: 30000,
    timeout: 60000,
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    keepAliveMsecs: 30000,
    timeout: 60000,
});

// ==================== COS 实例管理 ====================

let cosInstance = null;
let cosInitPromise = null;

/**
 * 判断是否为可重试的错误
 * 
 * @param {Error} err - 错误对象
 * @returns {boolean} 是否可重试
 */
function isRetryableError(err) {
    if (!err) return false;
    
    // 网络错误
    if (err.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(err.code)) {
        return true;
    }
    
    // COS 服务端错误 (5xx)
    if (err.statusCode && err.statusCode >= 500) {
        return true;
    }
    
    // 请求超时
    if (err.message && (err.message.includes('timeout') || err.message.includes('Timeout'))) {
        return true;
    }
    
    return false;
}

/**
 * 获取 COS 实例（单例模式，支持复用）
 * 
 * V7 优化：启用 Keep-Alive，配置 HTTP Agent
 * 
 * @returns {Promise<COS|null>} COS 实例，初始化失败返回 null
 */
export async function getCosInstance() {
    if (cosInstance) return cosInstance;
    if (cosInitPromise) return cosInitPromise;
    
    cosInitPromise = (async () => {
        const tagName = process.env.COS_SECRET_TAG;
        try {
            const { rotated_credential: rotatedCredential } = await import('@tencent/ssm-sdk-nodejs');
            const profile = await rotatedCredential.LoadAccessKeyProfile();
            const cred = await profile.GetCredential(tagName);
            
            // V7 优化：启用 Keep-Alive 和配置 Agent
            cosInstance = new COS({ 
                Credentials: cred,
                // 启用 Keep-Alive 连接复用
                KeepAlive: true,
                // 配置 HTTP/HTTPS Agent
                HttpAgent: httpAgent,
                HttpsAgent: httpsAgent,
                // 超时配置
                Timeout: 60000, // 60 秒
            });
            
            logger.info('COS 实例初始化成功 (Keep-Alive 已启用)');
            return cosInstance;
        } catch (error) {
            logger.error(`初始化失败: ${error.message}`);
            return null;
        }
    })();
    
    return cosInitPromise;
}

// ==================== 上传函数 ====================

/**
 * 并发控制器：限制同时执行的异步任务数量
 * 
 * @param {Array<() => Promise>} tasks - 任务函数数组
 * @param {number} limit - 最大并发数
 * @returns {Promise<Array>} 所有任务的结果
 */
async function runWithConcurrencyLimit(tasks, limit) {
    const results = [];
    const executing = new Set();
    
    for (const [index, task] of tasks.entries()) {
        const promise = Promise.resolve().then(() => task()).then(
            result => ({ index, result, success: true }),
            error => ({ index, error, success: false })
        );
        
        results.push(promise);
        executing.add(promise);
        
        promise.finally(() => executing.delete(promise));
        
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    
    const settled = await Promise.all(results);
    
    // 按原始顺序返回结果
    return settled.sort((a, b) => a.index - b.index).map(item => {
        if (item.success) return item.result;
        throw item.error;
    });
}

/**
 * 上传单个文件到 COS（带重试机制）
 * 
 * 优化：增加指数退避重试，提升网络不稳定环境下的上传成功率
 * 
 * @param {COS} cos - COS 实例
 * @param {Buffer} buffer - 文件内容
 * @param {string} key - COS 对象键（路径）
 * @param {string} contentType - 文件 MIME 类型
 * @param {number} retries - 剩余重试次数
 * @param {number} delay - 当前重试延迟（毫秒）
 * @returns {Promise<Object>} COS 响应
 */
export async function uploadFile(cos, buffer, key, contentType = 'image/webp', retries = COS_RETRY_CONFIG.MAX_RETRIES, delay = COS_RETRY_CONFIG.RETRY_DELAY) {
    return new Promise((resolve, reject) => {
        const attempt = (currentAttempt) => {
            cos.putObject({
                Bucket: COS_CONFIG.Bucket,
                Region: COS_CONFIG.Region,
                Key: key,
                Body: buffer,
                ContentType: contentType,
            }, (err, data) => {
                if (err) {
                    // 判断是否可重试
                    if (currentAttempt < retries && isRetryableError(err)) {
                        const retryDelay = delay * Math.pow(2, currentAttempt - 1); // 指数退避
                        logger.warn(`上传失败 ${key}, 尝试 ${currentAttempt}/${retries}. ${retryDelay}ms 后重试... ${err.code || err.message}`);
                        setTimeout(() => attempt(currentAttempt + 1), retryDelay);
                    } else {
                        reject(err);
                    }
                } else {
                    resolve(data);
                }
            });
        };
        attempt(1);
    });
}

/**
 * 批量上传文件到 COS（带并发控制）
 * 
 * V7 优化：使用并发控制器，避免网络拥塞
 * 
 * @param {Array<{buffer: Buffer, key: string, contentType?: string}>} files - 文件列表
 * @param {number} concurrency - 并发数，默认使用配置值
 * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>} 上传结果
 */
export async function uploadFiles(files, concurrency = UPLOAD_CONCURRENCY) {
    const cos = await getCosInstance();
    if (!cos) {
        return files.map(f => ({
            key: f.key,
            success: false,
            error: 'COS 实例不可用',
        }));
    }
    
    // 创建上传任务
    const tasks = files.map(({ buffer, key, contentType }) => async () => {
        try {
            await uploadFile(cos, buffer, key, contentType);
            return { key, success: true };
        } catch (error) {
            logger.error(`上传失败 ${key}: ${error.message}`);
            return { key, success: false, error: error.message };
        }
    });
    
    // 使用并发控制执行
    try {
        return await runWithConcurrencyLimit(tasks, concurrency);
    } catch (error) {
        // runWithConcurrencyLimit 内部已处理错误，这里是兜底
        logger.error(`批量上传异常: ${error.message}`);
        return files.map(f => ({
            key: f.key,
            success: false,
            error: error.message,
        }));
    }
}

/**
 * 上传渲染结果到 COS（带并发控制）
 * 
 * V7 优化：使用并发控制器，避免网络拥塞
 * 
 * @param {Array<{pageNum: number, buffer: Buffer, width: number, height: number}>} pages - 渲染结果
 * @param {string} globalPadId - 全局 ID
 * @param {number} concurrency - 并发数，默认使用配置值
 * @returns {Promise<Array<{pageNum: number, cosKey?: string, success: boolean, error?: string}>>}
 */
export async function uploadRenderedPages(pages, globalPadId, concurrency = UPLOAD_CONCURRENCY) {
    const cos = await getCosInstance();
    if (!cos) {
        return pages.map(p => ({
            pageNum: p.pageNum,
            width: p.width,
            height: p.height,
            success: false,
            error: 'COS 实例不可用',
        }));
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    
    // 创建上传任务
    const tasks = pages.map((page) => async () => {
        const key = `${filePrefix}_${page.pageNum}.webp`;
        try {
            await uploadFile(cos, page.buffer, key);
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                cosKey: '/' + key,
                success: true,
            };
        } catch (error) {
            logger.error(`上传页面 ${page.pageNum} 失败: ${error.message}`);
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                success: false,
                error: error.message,
            };
        }
    });
    
    // 使用并发控制执行
    try {
        return await runWithConcurrencyLimit(tasks, concurrency);
    } catch (error) {
        logger.error(`批量上传页面异常: ${error.message}`);
        return pages.map(p => ({
            pageNum: p.pageNum,
            width: p.width,
            height: p.height,
            success: false,
            error: error.message,
        }));
    }
}

// 导出配置和工具函数供外部使用
export { COS_CONFIG, UPLOAD_CONCURRENCY, runWithConcurrencyLimit };
