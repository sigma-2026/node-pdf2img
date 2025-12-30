/**
 * COS Uploader - 腾讯云 COS 上传服务
 * 
 * 提供文件上传到 COS 的功能，支持：
 * - 单文件上传
 * - 批量并行上传
 * - 凭证自动刷新
 * - 带指数退避的重试机制
 */

import COS from 'cos-nodejs-sdk-v5';

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
            cosInstance = new COS({ Credentials: cred });
            return cosInstance;
        } catch (error) {
            console.error('[COS] 初始化失败:', error.message);
            return null;
        }
    })();
    
    return cosInitPromise;
}

// ==================== 上传函数 ====================

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
                        console.warn(`[COS] 上传失败 ${key}, 尝试 ${currentAttempt}/${retries}. ${retryDelay}ms 后重试...`, err.code || err.message);
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
 * 批量上传文件到 COS
 * 
 * @param {Array<{buffer: Buffer, key: string, contentType?: string}>} files - 文件列表
 * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>} 上传结果
 */
export async function uploadFiles(files) {
    const cos = await getCosInstance();
    if (!cos) {
        return files.map(f => ({
            key: f.key,
            success: false,
            error: 'COS 实例不可用',
        }));
    }
    
    const results = await Promise.all(
        files.map(async ({ buffer, key, contentType }) => {
            try {
                await uploadFile(cos, buffer, key, contentType);
                return { key, success: true };
            } catch (error) {
                console.error(`[COS] 上传失败 ${key}:`, error.message);
                return { key, success: false, error: error.message };
            }
        })
    );
    
    return results;
}

/**
 * 上传渲染结果到 COS
 * 
 * @param {Array<{pageNum: number, buffer: Buffer, width: number, height: number}>} pages - 渲染结果
 * @param {string} globalPadId - 全局 ID
 * @returns {Promise<Array<{pageNum: number, cosKey?: string, success: boolean, error?: string}>>}
 */
export async function uploadRenderedPages(pages, globalPadId) {
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
    
    const results = await Promise.all(
        pages.map(async (page) => {
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
                console.error(`[COS] 上传页面 ${page.pageNum} 失败:`, error.message);
                return {
                    pageNum: page.pageNum,
                    width: page.width,
                    height: page.height,
                    success: false,
                    error: error.message,
                };
            }
        })
    );
    
    return results;
}

// 导出配置供外部使用
export { COS_CONFIG };
