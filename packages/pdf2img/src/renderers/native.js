/**
 * Native Renderer - PDFium 原生渲染器
 *
 * 支持两种模式：
 * - Native: 直接加载 PDF Buffer 渲染
 * - Native Stream: 流式加载 PDF 渲染（适合大文件）
 */

import { createLogger } from '../utils/logger.js';
import { mergeConfig, TIMEOUT_CONFIG } from '../core/config.js';

const logger = createLogger('NativeRenderer');

// ==================== Native Renderer 动态导入 ====================

let nativeRenderer = null;
let nativeAvailable = false;

try {
    // 从 workspace 的 native-renderer 包导入
    nativeRenderer = await import('@tencent/pdf2img-native');

    if (nativeRenderer.isPdfiumAvailable()) {
        nativeAvailable = true;

        try {
            const warmupTime = nativeRenderer.warmup();
            logger.info(`Native renderer loaded: ${nativeRenderer.getVersion()}, warmup: ${warmupTime}ms`);
        } catch (warmupErr) {
            logger.warn(`Native renderer warmup failed: ${warmupErr.message}`);
        }
    } else {
        logger.warn('Native renderer loaded but PDFium library not available');
    }
} catch (e) {
    logger.warn(`Native renderer not available: ${e.message}`);
    nativeRenderer = {};
    nativeAvailable = false;
}

/**
 * 检查 Native Renderer 是否可用
 */
export function isNativeAvailable() {
    return nativeAvailable;
}

/**
 * 获取 PDF 页数（从 Buffer）
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
 * 获取 PDF 页数（从文件路径）
 * 
 * 直接从文件读取，避免在 Node.js 堆中创建大 Buffer
 * 
 * @param {string} filePath - PDF 文件路径
 * @returns {number} 页数
 */
export function getPageCountFromFile(filePath) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }
    return nativeRenderer.getPageCountFromFile(filePath);
}

/**
 * 渲染单页到原始位图（不编码）
 * 
 * 只进行 PDFium 渲染，跳过图像编码步骤，返回原始 RGBA 像素数据。
 * 编码工作可以交给 Sharp 等更高效的库处理。
 * 
 * @param {string} filePath - PDF 文件路径
 * @param {number} pageNum - 页码（从 1 开始）
 * @param {Object} options - 渲染选项
 * @returns {Object} { success, buffer, width, height, channels, renderTime, error }
 */
export function renderPageToRawBitmap(filePath, pageNum, options = {}) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }
    const config = mergeConfig(options);
    return nativeRenderer.renderPageToRawBitmap(filePath, pageNum, config);
}

/**
 * 从 Buffer 渲染单页到原始位图（不编码）
 * 
 * @param {Buffer} pdfBuffer - PDF 文件数据
 * @param {number} pageNum - 页码（从 1 开始）
 * @param {Object} options - 渲染选项
 * @returns {Object} { success, buffer, width, height, channels, renderTime, error }
 */
export function renderPageToRawBitmapFromBuffer(pdfBuffer, pageNum, options = {}) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }
    const config = mergeConfig(options);
    const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    return nativeRenderer.renderPageToRawBitmapFromBuffer(buffer, pageNum, config);
}

/**
 * 获取版本信息
 */
export function getVersion() {
    if (!nativeAvailable) {
        return 'Native renderer not available';
    }
    return nativeRenderer.getVersion();
}

/**
 * 使用 Native Renderer 渲染 PDF Buffer
 *
 * @param {Buffer} pdfBuffer - PDF 文件数据
 * @param {number[]} pages - 要渲染的页码数组（1-based），空数组表示全部页面
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromBuffer(pdfBuffer, pages = [], options = {}) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }

    const config = mergeConfig(options);
    const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    const numPages = nativeRenderer.getPageCount(buffer);

    // 确定目标页码
    let targetPages;
    if (pages.length === 0) {
        targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
    } else {
        targetPages = pages.filter(p => p >= 1 && p <= numPages);
    }

    logger.debug(`Rendering ${targetPages.length} pages from buffer (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);

    const startTime = Date.now();
    const result = nativeRenderer.renderPages(buffer, targetPages, config);

    if (!result.success) {
        throw new Error(result.error || 'Native renderer failed');
    }

    return {
        success: true,
        numPages,
        pages: result.pages.map(page => ({
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            buffer: page.success ? page.buffer : undefined,
            success: page.success,
            error: page.error,
            renderTime: page.renderTime,
            encodeTime: page.encodeTime,
        })),
        totalTime: Date.now() - startTime,
        nativeTime: result.totalTime,
    };
}

/**
 * 使用 Native Renderer 渲染 PDF 文件
 * 
 * 直接从文件路径读取，避免在 Node.js 堆中创建大 Buffer。
 * 这是处理本地文件的最高效方式。
 *
 * @param {string} filePath - PDF 文件路径
 * @param {number[]} pages - 要渲染的页码数组（1-based），空数组表示全部页面
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromFile(filePath, pages = [], options = {}) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }

    const config = mergeConfig(options);
    const numPages = nativeRenderer.getPageCountFromFile(filePath);

    // 确定目标页码
    let targetPages;
    if (pages.length === 0) {
        targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
    } else {
        targetPages = pages.filter(p => p >= 1 && p <= numPages);
    }

    logger.debug(`Rendering ${targetPages.length} pages from file: ${filePath}`);

    const startTime = Date.now();
    const result = nativeRenderer.renderPagesFromFile(filePath, targetPages, config);

    if (!result.success) {
        throw new Error(result.error || 'Native renderer failed');
    }

    return {
        success: true,
        numPages,
        pages: result.pages.map(page => ({
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            buffer: page.success ? page.buffer : undefined,
            success: page.success,
            error: page.error,
            renderTime: page.renderTime,
            encodeTime: page.encodeTime,
        })),
        totalTime: Date.now() - startTime,
        nativeTime: result.totalTime,
    };
}

/**
 * 使用 Native Stream 渲染远程 PDF
 *
 * 通过回调按需获取 PDF 数据，避免一次性下载整个文件
 *
 * @param {string} pdfUrl - PDF 文件 URL
 * @param {number} pdfSize - PDF 文件大小
 * @param {number[]} pages - 要渲染的页码数组（1-based），空数组表示全部页面
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromStream(pdfUrl, pdfSize, pages = [], options = {}) {
    if (!nativeAvailable) {
        throw new Error('Native renderer not available');
    }

    if (!pdfUrl || !pdfSize) {
        throw new Error('pdfUrl and pdfSize are required for stream mode');
    }

    const config = mergeConfig(options);

    logger.debug(`Stream rendering from ${pdfUrl} (${(pdfSize / 1024 / 1024).toFixed(2)}MB)`);

    /**
     * fetcher 回调函数 - 被 Rust 通过 ThreadsafeFunction 调用
     */
    const fetcher = (error, req) => {
        if (error) {
            logger.error(`Fetcher received error: ${error.message}`);
            return;
        }

        const { offset, size, requestId } = req;
        const start = Number(offset);
        const end = start + size - 1;

        fetch(pdfUrl, {
            headers: { 'Range': `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(TIMEOUT_CONFIG.RANGE_REQUEST_TIMEOUT),
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
                logger.error(`Fetcher failed (offset=${start}, size=${size}): ${err.message}`);
                nativeRenderer.completeStreamRequest(requestId, null, err.message);
            });
    };

    const startTime = Date.now();

    // 首次调用获取页数
    let result = await nativeRenderer.renderPagesFromStream(
        pdfSize,
        pages,
        config,
        fetcher
    );

    if (!result.success) {
        throw new Error(result.error || 'Native stream renderer failed');
    }

    const numPages = result.numPages;

    // 如果需要渲染所有页面但之前不知道页数
    if (pages.length === 0 && numPages > 0 && result.pages.length === 0) {
        const allPages = Array.from({ length: numPages }, (_, i) => i + 1);
        result = await nativeRenderer.renderPagesFromStream(
            pdfSize,
            allPages,
            config,
            fetcher
        );

        if (!result.success) {
            throw new Error(result.error || 'Native stream renderer failed');
        }
    }

    return {
        success: true,
        numPages,
        pages: result.pages.map(page => ({
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            buffer: page.success ? page.buffer : undefined,
            success: page.success,
            error: page.error,
            renderTime: page.renderTime,
            encodeTime: page.encodeTime,
        })),
        totalTime: Date.now() - startTime,
        nativeTime: result.totalTime,
        streamStats: result.streamStats,
    };
}
