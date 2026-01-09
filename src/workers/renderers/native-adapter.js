/**
 * Native Renderer Adapter - Native 渲染器适配层
 * 
 * 封装 Rust + PDFium 原生渲染器的调用逻辑，包括：
 * - Native Renderer（直接加载 PDF Buffer）
 * - Native Stream（流式加载 PDF）
 * 
 * @module renderers/native-adapter
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { processUploads } from '../upload-manager.js';
import { createLogger, IS_DEV, IS_TEST } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('NativeAdapter');

// ==================== 渲染配置 ====================

const TARGET_RENDER_WIDTH = parseInt(process.env.TARGET_RENDER_WIDTH) || 1280;
const IMAGE_HEAVY_TARGET_WIDTH = parseInt(process.env.IMAGE_HEAVY_TARGET_WIDTH) || 1024;
const MAX_RENDER_SCALE = parseFloat(process.env.MAX_RENDER_SCALE) || 4.0;
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY) || 70;

// ==================== Native Renderer 动态导入 ====================

let nativeRenderer = null;
let nativeAvailable = false;

// 使用 top-level await 确保模块加载时完成初始化
try {
    const nativeRendererPath = path.join(__dirname, '../../../native-renderer/index.js');
    nativeRenderer = await import(nativeRendererPath);
    
    if (nativeRenderer.isPdfiumAvailable()) {
        nativeAvailable = true;
        
        // 预热 PDFium
        try {
            const warmupTime = nativeRenderer.warmup();
            logger.info(`Native renderer 已加载并预热: ${nativeRenderer.getVersion()}, 耗时: ${warmupTime}ms`);
        } catch (warmupErr) {
            logger.warn(`Native renderer 预热失败: ${warmupErr.message}`);
            logger.info(`Native renderer 已加载: ${nativeRenderer.getVersion()}`);
        }
    } else {
        logger.warn('Native renderer 加载成功，但 PDFium 库不可用');
    }
} catch (e) {
    logger.warn(`Native renderer 不可用: ${e.message}`);
    nativeRenderer = {};
    nativeAvailable = false;
}

/**
 * 检查 Native Renderer 是否可用
 * 
 * @returns {boolean} 是否可用
 */
export function isNativeAvailable() {
    return nativeAvailable;
}

/**
 * 获取 PDF 页数（使用 Native Renderer）
 * 
 * @param {Buffer} pdfBuffer - PDF 文件数据
 * @returns {number} 页数
 */
export function getPageCount(pdfBuffer) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }
    return nativeRenderer.getPageCount(pdfBuffer);
}

/**
 * 获取渲染配置对象
 * 
 * @returns {Object} 渲染配置
 */
function getRenderOptions() {
    return {
        targetWidth: TARGET_RENDER_WIDTH,
        imageHeavyWidth: IMAGE_HEAVY_TARGET_WIDTH,
        maxScale: MAX_RENDER_SCALE,
        webpQuality: WEBP_QUALITY,
        detectScan: true,
    };
}

/**
 * 转换 Native 渲染结果为统一格式
 * 
 * @param {Object} page - Native 渲染结果页
 * @param {Array} pageMetrics - 指标收集数组
 * @returns {Object} 统一格式的渲染结果
 */
function convertNativeResult(page, pageMetrics) {
    const timing = {
        render: page.renderTime,
        encode: page.encodeTime,
        total: page.renderTime + page.encodeTime,
    };
    
    pageMetrics.push({
        pageNum: page.pageNum,
        width: page.width,
        height: page.height,
        scale: 1.0,
        timing,
        success: page.success,
    });
    
    return {
        pageNum: page.pageNum,
        width: page.width,
        height: page.height,
        buffer: page.success ? page.buffer : undefined,
        success: page.success,
        error: page.error,
        timing,
    };
}

/**
 * 使用 Native Renderer (Rust + PDFium) 处理 PDF
 * 
 * 特点：
 * - 直接使用 PDFium C++ 库渲染
 * - 内置 WebP 编码
 * - 单次调用完成所有页面渲染
 * - 性能最优
 * 
 * @param {Object} params - 处理参数
 * @param {Buffer} params.pdfData - PDF 文件数据
 * @param {number[]|null} params.pageNums - 要渲染的页码数组
 * @param {string|number[]|null} [params.pagesParam] - 原始 pages 参数
 * @param {string} params.globalPadId - 全局 ID
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @param {number} [params.pdfSize] - PDF 文件大小
 * @param {number} [params.numPages] - PDF 页数
 * @returns {Promise<Object>} 处理结果
 */
export async function processWithNative({
    pdfData,
    pageNums,
    pagesParam,
    globalPadId,
    uploadToCos: shouldUpload,
    pdfSize,
    numPages: providedNumPages,
}) {
    const startTime = Date.now();
    
    const metrics = {
        infoTime: 0,
        parseTime: 0,
        renderTime: 0,
        uploadTime: 0,
        totalTime: 0,
        pdfSize: pdfSize || (pdfData ? pdfData.length : 0),
        rangeStats: null,
        pageMetrics: [],
        renderer: 'native',
    };
    
    try {
        if (!nativeAvailable) {
            throw new Error('Native renderer not available');
        }
        
        // 转换为 Buffer（如果是 ArrayBuffer）
        const pdfBuffer = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
        metrics.pdfSize = pdfBuffer.length;
        
        logger.debug(`Native Renderer 模式: ${(metrics.pdfSize / 1024 / 1024).toFixed(2)}MB`);
        
        // 获取页数
        let numPages = providedNumPages;
        if (!numPages || numPages <= 0) {
            numPages = nativeRenderer.getPageCount(pdfBuffer);
            logger.debug(`Worker 获取页数: ${numPages}`);
        }
        
        // 确定目标页码
        let validPageNums;
        if (pageNums === null || pageNums === undefined) {
            if (pagesParam === 'all') {
                validPageNums = Array.from({ length: numPages }, (_, i) => i + 1);
            } else if (Array.isArray(pagesParam)) {
                validPageNums = [...new Set(pagesParam)]
                    .filter(p => p >= 1 && p <= numPages)
                    .sort((a, b) => a - b);
            } else {
                validPageNums = Array.from({ length: Math.min(6, numPages) }, (_, i) => i + 1);
            }
            logger.debug(`Worker 计算目标页码: [${validPageNums.join(',')}] (共 ${numPages} 页)`);
        } else if (pageNums.length === 0) {
            metrics.totalTime = Date.now() - startTime;
            metrics.rangeStats = {
                mode: 'native-renderer',
                totalBytes: metrics.pdfSize,
                totalBytesMB: (metrics.pdfSize / 1024 / 1024).toFixed(2),
            };
            
            return {
                success: true,
                results: [],
                metrics: { ...metrics, numPages, renderedCount: 0, uploadedCount: 0 },
            };
        } else {
            validPageNums = pageNums.filter(p => p >= 1 && p <= numPages);
        }
        
        // 调用 native renderer 渲染
        const renderStart = Date.now();
        const nativeResult = nativeRenderer.renderPages(pdfBuffer, validPageNums, getRenderOptions());
        metrics.renderTime = Date.now() - renderStart;
        
        if (!nativeResult.success) {
            throw new Error(nativeResult.error || 'Native renderer 渲染失败');
        }
        
        // 转换结果格式
        const renderResults = nativeResult.pages.map(page => convertNativeResult(page, metrics.pageMetrics));
        
        // 使用统一的上传管理器
        const results = await processUploads(renderResults, globalPadId, shouldUpload, 'Native');
        
        metrics.totalTime = Date.now() - startTime;
        metrics.rangeStats = {
            mode: 'native-renderer',
            totalBytes: metrics.pdfSize,
            totalBytesMB: (metrics.pdfSize / 1024 / 1024).toFixed(2),
            nativeRenderTime: nativeResult.totalTime,
        };
        
        if (IS_DEV || IS_TEST) {
            logger.perf('Native渲染完成', {
                pdfSize: `${(metrics.pdfSize / 1024 / 1024).toFixed(2)}MB`,
                numPages,
                renderedPages: results.length,
                renderer: 'native',
                timing: { render: metrics.renderTime, total: metrics.totalTime },
            });
        }
        
        return {
            success: true,
            results,
            metrics: {
                ...metrics,
                numPages,
                renderedCount: results.filter(r => r.success || r.buffer).length,
                uploadedCount: results.filter(r => r.success && r.cosKey).length,
            },
        };
    } catch (error) {
        logger.error(`Native renderer 处理失败: ${error.message}`);
        return {
            success: false,
            error: `Native renderer 失败: ${error.message}`,
            results: [],
            metrics: { ...metrics, totalTime: Date.now() - startTime },
        };
    }
}

/**
 * 使用 Native Renderer + 流式加载处理 PDF
 * 
 * 特点：
 * - 通过回调按需获取 PDF 数据，避免一次性下载整个文件
 * - 结合了 PDFium 原生渲染的性能和分片加载的网络效率
 * - 适用于大文件，内存占用极低
 * - Rust 端会缓存已获取的数据块，减少重复请求
 * 
 * @param {Object} params - 处理参数
 * @param {string} params.pdfUrl - PDF 文件 URL
 * @param {number[]|null} params.pageNums - 要渲染的页码数组
 * @param {string|number[]|null} [params.pagesParam] - 原始 pages 参数
 * @param {string} params.globalPadId - 全局 ID
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @param {number} params.pdfSize - PDF 文件大小
 * @param {number} [params.numPages] - PDF 页数
 * @returns {Promise<Object>} 处理结果
 */
export async function processWithNativeStream({
    pdfUrl,
    pageNums,
    pagesParam,
    globalPadId,
    uploadToCos: shouldUpload,
    pdfSize,
    numPages: providedNumPages,
}) {
    const startTime = Date.now();
    
    const metrics = {
        infoTime: 0,
        parseTime: 0,
        renderTime: 0,
        uploadTime: 0,
        totalTime: 0,
        pdfSize: pdfSize || 0,
        rangeStats: null,
        pageMetrics: [],
        renderer: 'native-stream',
    };
    
    try {
        if (!nativeAvailable) {
            throw new Error('Native renderer not available');
        }
        
        if (!pdfUrl || !pdfSize) {
            throw new Error('Native Stream 模式需要 pdfUrl 和 pdfSize');
        }
        
        logger.debug(`Native Stream 模式: ${(pdfSize / 1024 / 1024).toFixed(2)}MB`);
        
        /**
         * fetcher 回调函数 - 被 Rust 通过 ThreadsafeFunction 调用
         * 
         * NAPI-RS 的 ThreadsafeFunction 传递 (error, req) 格式
         * 
         * @param {Error|null} error - 错误对象
         * @param {{offset: number, size: number, requestId: number}} req - 请求参数
         */
        const fetcher = (error, req) => {
            if (error) {
                logger.error(`[NativeStream] Fetcher received error: ${error.message}`);
                return;
            }
            
            const { offset, size, requestId } = req;
            const start = Number(offset);
            const end = start + size - 1;
            
            fetch(pdfUrl, {
                headers: { 'Range': `bytes=${start}-${end}` },
                signal: AbortSignal.timeout(15000),
            })
            .then(response => {
                if (!response.ok && response.status !== 206) {
                    throw new Error(`Range request failed with status ${response.status}`);
                }
                return response.arrayBuffer();
            })
            .then(data => {
                nativeRenderer.completeStreamRequest(requestId, Buffer.from(data), null);
            })
            .catch(err => {
                logger.error(`[NativeStream] Fetcher callback failed (offset=${start}, size=${size}): ${err.message}`);
                nativeRenderer.completeStreamRequest(requestId, null, err.message);
            });
        };
        
        // 确定目标页码
        let validPageNums;
        if (pageNums === null || pageNums === undefined) {
            validPageNums = pagesParam === 'all' 
                ? []
                : (Array.isArray(pagesParam) ? pagesParam : [1, 2, 3, 4, 5, 6]);
        } else if (pageNums.length === 0) {
            metrics.totalTime = Date.now() - startTime;
            return {
                success: true,
                results: [],
                metrics: { ...metrics, numPages: providedNumPages || 0, renderedCount: 0, uploadedCount: 0 },
            };
        } else {
            validPageNums = pageNums;
        }
        
        // 调用 Rust 的流式渲染接口
        const renderStart = Date.now();
        let nativeResult = await nativeRenderer.renderPagesFromStream(
            pdfSize,
            validPageNums,
            getRenderOptions(),
            fetcher
        );
        metrics.renderTime = Date.now() - renderStart;
        
        if (!nativeResult.success) {
            throw new Error(nativeResult.error || 'Native stream renderer 渲染失败');
        }
        
        const numPages = nativeResult.numPages;
        
        // 如果需要渲染所有页面但之前不知道页数
        if (pagesParam === 'all' && validPageNums.length === 0 && numPages > 0) {
            const allPageNums = Array.from({ length: numPages }, (_, i) => i + 1);
            const allPagesResult = await nativeRenderer.renderPagesFromStream(
                pdfSize,
                allPageNums,
                getRenderOptions(),
                fetcher
            );
            
            if (!allPagesResult.success) {
                throw new Error(allPagesResult.error || 'Native stream renderer 渲染所有页面失败');
            }
            
            nativeResult = allPagesResult;
            metrics.renderTime = Date.now() - renderStart;
        }
        
        // 转换结果格式
        const renderResults = nativeResult.pages.map(page => convertNativeResult(page, metrics.pageMetrics));
        
        // 使用统一的上传管理器
        const results = await processUploads(renderResults, globalPadId, shouldUpload, 'NativeStream');
        
        metrics.totalTime = Date.now() - startTime;
        metrics.rangeStats = {
            mode: 'native-stream',
            totalBytes: pdfSize,
            totalBytesMB: (pdfSize / 1024 / 1024).toFixed(2),
            nativeRenderTime: nativeResult.totalTime,
            streamStats: nativeResult.streamStats,
        };
        
        if (IS_DEV || IS_TEST) {
            logger.perf('Native Stream 渲染完成', {
                pdfSize: `${(pdfSize / 1024 / 1024).toFixed(2)}MB`,
                numPages,
                renderedPages: results.length,
                renderer: 'native-stream',
                timing: { render: metrics.renderTime, total: metrics.totalTime },
            });
        }
        
        return {
            success: true,
            results,
            metrics: {
                ...metrics,
                numPages,
                renderedCount: results.filter(r => r.success || r.buffer).length,
                uploadedCount: results.filter(r => r.success && r.cosKey).length,
            },
        };
    } catch (error) {
        logger.error(`Native stream renderer 处理失败: ${error.message}`);
        return {
            success: false,
            error: `Native stream renderer 失败: ${error.message}`,
            results: [],
            metrics: { ...metrics, totalTime: Date.now() - startTime },
        };
    }
}
