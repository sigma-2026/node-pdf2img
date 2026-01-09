/**
 * Upload Manager - 统一上传管理器
 * 
 * 负责处理渲染结果的 COS 上传，解决代码重复问题。
 * 所有渲染路径（Native、Native Stream、PDF.js）统一调用此模块。
 * 
 * 功能：
 * - 统一的上传接口
 * - 并发控制
 * - 错误处理和重试
 * - 日志记录
 * 
 * @module upload-manager
 */

import { getCosInstance, uploadFile, COS_CONFIG } from './cos-uploader.js';
import { createLogger, IS_DEV, IS_TEST } from '../utils/logger.js';

const logger = createLogger('UploadManager');

// 上传并发配置
const UPLOAD_CONCURRENCY = parseInt(process.env.COS_UPLOAD_CONCURRENCY) || 6;

/**
 * 并发执行异步任务（带并发限制）
 * 
 * @param {Array<() => Promise<T>>} tasks - 任务函数数组
 * @param {number} concurrency - 最大并发数
 * @returns {Promise<T[]>} 所有任务的结果
 * @template T
 */
async function runConcurrentTasks(tasks, concurrency) {
    const results = [];
    const executing = new Set();
    
    for (const task of tasks) {
        const promise = task().then(result => {
            executing.delete(promise);
            return result;
        });
        
        executing.add(promise);
        results.push(promise);
        
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    
    return Promise.all(results);
}

/**
 * @typedef {Object} RenderResult
 * @property {number} pageNum - 页码
 * @property {boolean} success - 是否渲染成功
 * @property {Buffer} [buffer] - 图片数据（渲染成功时）
 * @property {number} [width] - 图片宽度
 * @property {number} [height] - 图片高度
 * @property {string} [error] - 错误信息（失败时）
 * @property {Object} [timing] - 耗时统计
 */

/**
 * @typedef {Object} UploadResult
 * @property {number} pageNum - 页码
 * @property {boolean} success - 是否成功
 * @property {string} [cosKey] - COS 对象键（上传成功时）
 * @property {number} [width] - 图片宽度
 * @property {number} [height] - 图片高度
 * @property {string} [error] - 错误信息（失败时）
 * @property {Object} [timing] - 耗时统计（包含 upload 字段）
 */

/**
 * 统一处理渲染结果的上传任务
 * 
 * 该函数接收渲染结果数组，根据 shouldUpload 参数决定是否上传到 COS。
 * 上传成功后会移除 buffer 字段，添加 cosKey 字段。
 * 
 * @param {RenderResult[]} results - 渲染结果数组
 * @param {string} globalPadId - 用于构造 COS Key 的全局 ID
 * @param {boolean} shouldUpload - 是否执行上传
 * @param {string} [rendererName=''] - 渲染器名称（用于日志）
 * @returns {Promise<UploadResult[]>} 处理后的结果数组
 * 
 * @example
 * const results = await processUploads(renderResults, 'pad123', true, 'Native');
 * // 返回: [{ pageNum: 1, success: true, cosKey: '/pdf2img/pad123_1.webp', ... }]
 */
export async function processUploads(results, globalPadId, shouldUpload, rendererName = '') {
    // 分离成功和失败的渲染结果
    const successResults = results.filter(r => r.success && r.buffer);
    const failedRenderResults = results.filter(r => !r.success || !r.buffer);
    
    // 如果不需要上传，直接返回原始结果（保留 buffer）
    if (!shouldUpload || !globalPadId) {
        return results.map(r => {
            if (r.success && r.buffer) {
                return {
                    pageNum: r.pageNum,
                    width: r.width,
                    height: r.height,
                    buffer: r.buffer,
                    success: true,
                    timing: r.timing,
                };
            }
            return {
                pageNum: r.pageNum,
                success: false,
                error: r.error || 'Render failed',
                timing: r.timing,
            };
        });
    }
    
    // 获取 COS 实例
    const cos = await getCosInstance();
    if (!cos) {
        logger.warn('COS instance not available. Returning results with buffer.');
        // COS 不可用，返回带 buffer 的结果
        return results.map(r => {
            if (r.success && r.buffer) {
                return {
                    pageNum: r.pageNum,
                    width: r.width,
                    height: r.height,
                    buffer: r.buffer,
                    success: true,
                    timing: r.timing,
                    warning: 'COS not available',
                };
            }
            return {
                pageNum: r.pageNum,
                success: false,
                error: r.error || 'Render failed',
                timing: r.timing,
            };
        });
    }
    
    // 没有成功的渲染结果需要上传
    if (successResults.length === 0) {
        return failedRenderResults.map(r => ({
            pageNum: r.pageNum,
            success: false,
            error: r.error || 'Render failed',
            timing: r.timing,
        }));
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    const logPrefix = rendererName ? `COS上传成功(${rendererName})` : 'COS上传成功';
    const logErrorPrefix = rendererName ? `COS上传失败(${rendererName})` : 'COS上传失败';
    
    // 创建上传任务
    const uploadTasks = successResults.map((page) => async () => {
        const key = `${filePrefix}_${page.pageNum}.webp`;
        const uploadStart = Date.now();
        
        try {
            await uploadFile(cos, page.buffer, key);
            const uploadTime = Date.now() - uploadStart;
            
            if (IS_DEV || IS_TEST) {
                logger.perf(logPrefix, {
                    page: page.pageNum,
                    key,
                    size: `${(page.buffer.length / 1024).toFixed(1)}KB`,
                    time: uploadTime,
                });
            }
            
            // 上传成功，返回不带 buffer 的结果
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                cosKey: '/' + key,
                success: true,
                timing: { ...page.timing, upload: uploadTime },
            };
        } catch (error) {
            logger.error(`${logErrorPrefix}: page=${page.pageNum}, error=${error.message}`);
            // 上传失败，返回错误信息
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                success: false,
                error: `Upload failed: ${error.message}`,
                timing: page.timing,
            };
        }
    });
    
    // 并发控制上传
    const uploadedResults = await runConcurrentTasks(uploadTasks, UPLOAD_CONCURRENCY);
    
    // 合并渲染失败的结果和上传结果
    const failedMapped = failedRenderResults.map(r => ({
        pageNum: r.pageNum,
        success: false,
        error: r.error || 'Render failed',
        timing: r.timing,
    }));
    
    return [...failedMapped, ...uploadedResults].sort((a, b) => a.pageNum - b.pageNum);
}

/**
 * 流水线式上传（串行渲染，并行上传）
 * 
 * 该函数在渲染完成一页后立即启动上传任务（不等待），
 * 最后统一等待所有上传完成。适用于 PDF.js 串行渲染场景。
 * 
 * @param {RenderResult} renderResult - 单页渲染结果
 * @param {string} globalPadId - 全局 ID
 * @param {string} [rendererName=''] - 渲染器名称
 * @returns {Promise<UploadResult>|null} 上传 Promise 或 null（不需要上传时）
 */
export function createUploadTask(renderResult, globalPadId, rendererName = '') {
    if (!renderResult.success || !renderResult.buffer || !globalPadId) {
        return null;
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    const key = `${filePrefix}_${renderResult.pageNum}.webp`;
    const bufferSize = renderResult.buffer.length;
    const uploadStartTime = Date.now();
    const logPrefix = rendererName ? `COS上传成功(${rendererName})` : 'COS上传成功';
    const logErrorPrefix = rendererName ? `COS上传失败(${rendererName})` : 'COS上传失败';
    
    return getCosInstance().then(cos => {
        if (!cos) {
            return {
                pageNum: renderResult.pageNum,
                width: renderResult.width,
                height: renderResult.height,
                buffer: renderResult.buffer,
                success: true,
                timing: renderResult.timing,
                warning: 'COS not available',
            };
        }
        
        return uploadFile(cos, renderResult.buffer, key)
            .then(() => {
                const uploadTime = Date.now() - uploadStartTime;
                if (IS_DEV || IS_TEST) {
                    logger.perf(logPrefix, {
                        page: renderResult.pageNum,
                        key,
                        size: `${(bufferSize / 1024).toFixed(1)}KB`,
                        time: uploadTime,
                    });
                }
                return {
                    pageNum: renderResult.pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    cosKey: '/' + key,
                    success: true,
                    timing: { ...renderResult.timing, upload: uploadTime },
                };
            })
            .catch(err => {
                logger.error(`${logErrorPrefix}: page=${renderResult.pageNum}, error=${err.message}`);
                return {
                    pageNum: renderResult.pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    success: false,
                    error: `Upload failed: ${err.message}`,
                    timing: renderResult.timing,
                };
            });
    });
}

// 导出配置供外部使用
export { UPLOAD_CONCURRENCY };
