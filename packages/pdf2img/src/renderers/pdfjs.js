/**
 * PDF.js Renderer - PDF.js 渲染器模块
 * 
 * 使用 PDF.js + RangeLoader 进行 PDF 渲染，特点：
 * - 分片加载，只下载需要的数据
 * - 适合大文件
 * - 稳定可靠
 * - 纯 JavaScript 实现，无需原生依赖
 * 
 * 渲染策略：串行渲染避免资源争抢
 * 
 * @module renderers/pdfjs
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createLogger, IS_DEV } from '../utils/logger.js';
import { RENDER_CONFIG, ENCODER_CONFIG, TIMEOUT_CONFIG } from '../core/config.js';
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('PdfjsRenderer');

// PDF.js 操作符映射（用于内容分析）
const pdfjsLib = { OPS };

// ==================== PDF.js 配置 ====================

const CMAP_URL = path.join(__dirname, '../../../node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(__dirname, '../../../node_modules/pdfjs-dist/standard_fonts/');

// ==================== 渲染配置 ====================

const TARGET_RENDER_WIDTH = RENDER_CONFIG.TARGET_RENDER_WIDTH;
const IMAGE_HEAVY_TARGET_WIDTH = RENDER_CONFIG.IMAGE_HEAVY_TARGET_WIDTH;
const MAX_RENDER_SCALE = RENDER_CONFIG.MAX_RENDER_SCALE;
const WEBP_QUALITY = ENCODER_CONFIG.WEBP_QUALITY;
const WEBP_METHOD = ENCODER_CONFIG.WEBP_METHOD;
const JPEG_QUALITY = ENCODER_CONFIG.JPEG_QUALITY;
const PNG_COMPRESSION = ENCODER_CONFIG.PNG_COMPRESSION;
// PDF.js 日志级别: 0=关闭, 1=error, 2=warn, 3=info, 4=debug, 5=verbose
const PDFJS_VERBOSITY = IS_DEV ? 1 : 0;

// WebP 格式限制
const WEBP_MAX_DIMENSION = 16383;
const WEBP_MAX_PIXELS = 16383 * 16383;

// ==================== Range Loader 配置 ====================

const RANGE_CHUNK_SIZE = parseInt(process.env.RANGE_CHUNK_SIZE) || 2 * 1024 * 1024; // 2MB
const RANGE_CONCURRENCY = parseInt(process.env.RANGE_CONCURRENCY) || 4;
const RANGE_TIMEOUT = TIMEOUT_CONFIG.RANGE_REQUEST_TIMEOUT;
const RANGE_MAX_RETRIES = parseInt(process.env.RANGE_MAX_RETRIES) || 3;
const RANGE_RETRY_DELAY = parseInt(process.env.RANGE_RETRY_DELAY) || 500;

// 小文件阈值：小于此值直接全量下载
const SMALL_FILE_THRESHOLD = parseInt(process.env.SMALL_FILE_THRESHOLD) || 2 * 1024 * 1024; // 2MB

// 探测请求大小
const PROBE_SIZE = parseInt(process.env.PROBE_SIZE) || 20 * 1024 - 1;

// ==================== sharp 动态导入 ====================

let sharp = null;
let sharpAvailable = false;

try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    logger.info('sharp 库已加载');
} catch (e) {
    logger.warn('sharp 库未安装，回退到 canvas.toBuffer 编码');
    sharp = null;
    sharpAvailable = false;
}

// ==================== PDFDataRangeTransport 动态导入 ====================

let PDFDataRangeTransport = null;

try {
    const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
    PDFDataRangeTransport = pdfModule.PDFDataRangeTransport;
} catch (e) {
    logger.warn(`PDFDataRangeTransport 不可用: ${e.message}`);
}

// ==================== RangeLoader 类 ====================

/**
 * PDF 分片加载器
 * 
 * 实现 PDFDataRangeTransport 接口，支持按需加载 PDF 数据
 */
class RangeLoader extends PDFDataRangeTransport {
    /**
     * @param {number} length - PDF 文件总大小
     * @param {ArrayBuffer} initialData - 初始数据
     * @param {string} pdfUrl - PDF 文件 URL
     * @param {Object} options - 配置选项
     */
    constructor(length, initialData, pdfUrl, options = {}) {
        super(length, initialData);
        this.pdfUrl = pdfUrl;
        this.pdfSize = length;
        this.chunkSize = options.chunkSize || RANGE_CHUNK_SIZE;
        this.maxConcurrency = options.concurrency || RANGE_CONCURRENCY;
        this.timeout = options.timeout || RANGE_TIMEOUT;
        
        this.inflight = 0;
        this.queue = [];
        
        this.stats = {
            totalRequests: 0,
            totalBytes: 0,
            requestTimes: [],
        };
    }

    async runWithLimit(fn) {
        if (this.inflight >= this.maxConcurrency) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.inflight++;
        try {
            return await fn();
        } finally {
            this.inflight--;
            const next = this.queue.shift();
            if (next) next();
        }
    }

    async requestDataRange(start, end) {
        const realEnd = end - 1;
        const groups = this.splitIntoChunks(start, realEnd, this.chunkSize);
        
        const startTime = Date.now();
        const datas = await Promise.all(
            groups.map(([chunkStart, chunkEnd]) => {
                return this.runWithLimit(() => this.fetchRange(chunkStart, chunkEnd));
            })
        );
        
        const byteLength = datas.reduce((total, data) => total + data.byteLength, 0);
        const byteData = new Uint8Array(byteLength);
        let offset = 0;
        for (const data of datas) {
            byteData.set(new Uint8Array(data), offset);
            offset += data.byteLength;
        }
        
        this.stats.requestTimes.push(Date.now() - startTime);
        
        this.onDataProgress(byteData.byteLength, this.pdfSize);
        this.onDataRange(start, byteData);
    }

    splitIntoChunks(start, end, chunkSize) {
        const count = Math.ceil((end - start) / chunkSize);
        return new Array(count).fill(0).map((_, index) => {
            const chunkStart = index * chunkSize + start;
            const chunkEnd = Math.min(chunkStart + chunkSize - 1, end);
            return [chunkStart, chunkEnd];
        });
    }

    async fetchRange(start, end, retries = RANGE_MAX_RETRIES) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        try {
            const response = await fetch(this.pdfUrl, {
                headers: { Range: `bytes=${start}-${end}` },
                signal: controller.signal,
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok && response.status !== 206) {
                throw new Error(`Range 请求失败: ${response.status}`);
            }
            
            const data = await response.arrayBuffer();
            
            this.stats.totalRequests++;
            this.stats.totalBytes += data.byteLength;
            
            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            
            const isRetryable = error.name === 'AbortError' || 
                error.cause?.code === 'ECONNRESET' ||
                error.cause?.code === 'ECONNREFUSED' ||
                error.cause?.code === 'UND_ERR_SOCKET' ||
                error.message?.includes('fetch failed');
            
            if (isRetryable && retries > 0) {
                const delay = RANGE_RETRY_DELAY * (RANGE_MAX_RETRIES - retries + 1);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.fetchRange(start, end, retries - 1);
            }
            
            if (error.name === 'AbortError') {
                throw new Error(`请求超时 (${this.timeout}ms)`);
            }
            throw error;
        }
    }

    getStats() {
        const avgTime = this.stats.requestTimes.length > 0
            ? this.stats.requestTimes.reduce((a, b) => a + b, 0) / this.stats.requestTimes.length
            : 0;
        return {
            ...this.stats,
            avgRequestTime: Math.round(avgTime),
            totalBytesMB: (this.stats.totalBytes / 1024 / 1024).toFixed(2),
        };
    }
}

// ==================== PDF 信息获取 ====================

/**
 * 智能获取 PDF 文件信息
 */
async function getPdfInfo(pdfUrl, retries = RANGE_MAX_RETRIES) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RANGE_TIMEOUT);
        
        const probeResponse = await fetch(pdfUrl, {
            headers: { Range: `bytes=0-${PROBE_SIZE}` },
            signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!probeResponse.ok && probeResponse.status !== 206) {
            throw new Error(`获取文件信息失败: ${probeResponse.status}`);
        }
        
        const contentRange = probeResponse.headers.get('Content-Range');
        let pdfSize = 0;
        
        if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) {
                pdfSize = parseInt(match[1], 10);
            }
        }
        
        if (!pdfSize) {
            pdfSize = parseInt(probeResponse.headers.get('Content-Length') || '0', 10);
        }
        
        if (!pdfSize) {
            throw new Error('无法获取文件大小，服务器可能不支持 Range 请求');
        }
        
        const probeData = await probeResponse.arrayBuffer();
        const isSmallFile = pdfSize <= SMALL_FILE_THRESHOLD;
        const isComplete = probeData.byteLength >= pdfSize;
        
        if (isComplete) {
            return {
                pdfSize,
                initialData: probeData,
                fullData: probeData,
                isSmallFile: true,
            };
        } else if (isSmallFile) {
            const fullData = await downloadFullPdf(pdfUrl);
            return {
                pdfSize,
                initialData: probeData,
                fullData,
                isSmallFile: true,
            };
        } else {
            return {
                pdfSize,
                initialData: probeData,
                fullData: null,
                isSmallFile: false,
            };
        }
    } catch (error) {
        const isRetryable = error.name === 'AbortError' || 
            error.cause?.code === 'ECONNRESET' ||
            error.cause?.code === 'ECONNREFUSED' ||
            error.cause?.code === 'UND_ERR_SOCKET' ||
            error.message?.includes('fetch failed');
        
        if (isRetryable && retries > 0) {
            const delay = RANGE_RETRY_DELAY * (RANGE_MAX_RETRIES - retries + 1);
            await new Promise(resolve => setTimeout(resolve, delay));
            return getPdfInfo(pdfUrl, retries - 1);
        }
        
        throw error;
    }
}

/**
 * 下载完整 PDF 文件
 */
async function downloadFullPdf(pdfUrl, retries = RANGE_MAX_RETRIES) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_CONFIG.DOWNLOAD_TIMEOUT);
        
        const response = await fetch(pdfUrl, {
            signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`下载 PDF 失败: ${response.status}`);
        }
        
        return await response.arrayBuffer();
    } catch (error) {
        const isRetryable = error.name === 'AbortError' || 
            error.cause?.code === 'ECONNRESET' ||
            error.cause?.code === 'ECONNREFUSED' ||
            error.cause?.code === 'UND_ERR_SOCKET' ||
            error.message?.includes('fetch failed');
        
        if (isRetryable && retries > 0) {
            const delay = RANGE_RETRY_DELAY * (RANGE_MAX_RETRIES - retries + 1);
            await new Promise(resolve => setTimeout(resolve, delay));
            return downloadFullPdf(pdfUrl, retries - 1);
        }
        
        throw error;
    }
}

// ==================== 编码函数 ====================

/**
 * 使用 sharp 编码图片
 */
async function encodeWithSharp(data, width, height, format, options = {}) {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    
    let sharpInstance = sharp(buffer, {
        raw: {
            width: Math.round(width),
            height: Math.round(height),
            channels: 4,
        },
    });
    
    switch (format) {
        case 'webp':
            return sharpInstance.webp({ 
                quality: options.webpQuality || WEBP_QUALITY,
                effort: options.webpMethod || WEBP_METHOD,
                smartSubsample: true,
            }).toBuffer();
        case 'png':
            return sharpInstance.png({ 
                compressionLevel: options.pngCompression || PNG_COMPRESSION,
            }).toBuffer();
        case 'jpg':
        case 'jpeg':
            return sharpInstance.jpeg({ 
                quality: options.jpegQuality || JPEG_QUALITY,
            }).toBuffer();
        default:
            return sharpInstance.webp({ 
                quality: options.webpQuality || WEBP_QUALITY,
                effort: options.webpMethod || WEBP_METHOD,
            }).toBuffer();
    }
}

// ==================== 渲染函数 ====================

/**
 * 渲染单个 PDF 页面
 */
async function renderPage(pdfDocument, pageNum, options = {}) {
    let page;
    let canvasAndContext;
    const pageStartTime = Date.now();
    const timing = {
        getPage: 0,
        heuristic: 0,
        getOperatorList: 0,
        render: 0,
        getImageData: 0,
        encode: 0,
        total: 0,
    };
    
    const format = options.format || 'webp';
    const targetWidth = options.targetWidth || TARGET_RENDER_WIDTH;
    
    try {
        const getPageStart = Date.now();
        page = await pdfDocument.getPage(pageNum);
        timing.getPage = Date.now() - getPageStart;
        
        // 启发式预判
        const heuristicStart = Date.now();
        let effectiveTargetWidth = targetWidth;
        let isLikelyScan = false;
        
        try {
            const pageDict = page._pageInfo?.pageDict || page.pageDict;
            
            if (pageDict) {
                const resources = pageDict.get('Resources');
                if (resources) {
                    const xobjects = resources.get('XObject');
                    const fonts = resources.get('Font');
                    
                    const hasImages = xobjects && (
                        typeof xobjects.getKeys === 'function' 
                            ? xobjects.getKeys().length > 0 
                            : Object.keys(xobjects).length > 0
                    );
                    const hasFonts = fonts && (
                        typeof fonts.getKeys === 'function'
                            ? fonts.getKeys().length > 0
                            : Object.keys(fonts).length > 0
                    );
                    
                    if (hasImages && !hasFonts && options.detectScan !== false) {
                        isLikelyScan = true;
                        effectiveTargetWidth = options.imageHeavyWidth || IMAGE_HEAVY_TARGET_WIDTH;
                    }
                }
            }
        } catch (e) {
            if (IS_DEV) {
                logger.debug(`Page ${pageNum} 启发式预判失败: ${e.message}`);
            }
        }
        
        timing.heuristic = Date.now() - heuristicStart;
        
        // 计算缩放比例
        const originalViewport = page.getViewport({ scale: 1.0 });
        const originalWidth = originalViewport.width;
        
        let scale = effectiveTargetWidth / originalWidth;
        scale = Math.min(scale, options.maxScale || MAX_RENDER_SCALE);
        
        let viewport = page.getViewport({ scale });
        let width = Math.round(viewport.width);
        let height = Math.round(viewport.height);
        
        // WebP 尺寸限制检查
        if (format === 'webp') {
            if (width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION) {
                const widthFactor = width > WEBP_MAX_DIMENSION ? WEBP_MAX_DIMENSION / width : 1;
                const heightFactor = height > WEBP_MAX_DIMENSION ? WEBP_MAX_DIMENSION / height : 1;
                const limitFactor = Math.min(widthFactor, heightFactor);
                
                logger.warn(`Page ${pageNum} 尺寸超过 WebP 限制 (${width}x${height})，缩放至 ${(limitFactor * 100).toFixed(1)}%`);
                
                scale = scale * limitFactor;
                viewport = page.getViewport({ scale });
                width = Math.round(viewport.width);
                height = Math.round(viewport.height);
            }
            
            if (width * height > WEBP_MAX_PIXELS) {
                const pixelFactor = Math.sqrt(WEBP_MAX_PIXELS / (width * height));
                logger.warn(`Page ${pageNum} 像素数超过 WebP 限制，进一步缩放至 ${(pixelFactor * 100).toFixed(1)}%`);
                
                scale = scale * pixelFactor;
                viewport = page.getViewport({ scale });
                width = Math.round(viewport.width);
                height = Math.round(viewport.height);
            }
        }
        
        // 获取操作符列表
        const getOperatorListStart = Date.now();
        const operatorList = await page.getOperatorList();
        timing.getOperatorList = Date.now() - getOperatorListStart;
        
        // 渲染
        canvasAndContext = pdfDocument.canvasFactory.create(width, height);
        
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
            operatorList,
        };
        
        const renderStart = Date.now();
        await page.render(renderContext).promise;
        timing.render = Date.now() - renderStart;
        
        // 编码
        const encodeStart = Date.now();
        let buffer;
        
        if (sharpAvailable) {
            const getImageDataStart = Date.now();
            const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
            timing.getImageData = Date.now() - getImageDataStart;
            buffer = await encodeWithSharp(imageData.data, width, height, format, options);
        } else {
            // 回退到 canvas 原生编码
            const mimeType = format === 'png' ? 'image/png' : 
                            (format === 'jpg' || format === 'jpeg') ? 'image/jpeg' : 'image/webp';
            buffer = canvasAndContext.canvas.toBuffer(mimeType);
        }
        timing.encode = Date.now() - encodeStart;
        timing.total = Date.now() - pageStartTime;
        
        return {
            pageNum,
            buffer,
            width,
            height,
            scale: parseFloat(scale.toFixed(3)),
            success: true,
            renderTime: timing.render,
            encodeTime: timing.encode,
            timing,
        };
    } catch (error) {
        timing.total = Date.now() - pageStartTime;
        logger.error(`渲染页面 ${pageNum} 失败: ${error.message}`);
        return {
            pageNum,
            success: false,
            error: error.message,
            timing,
        };
    } finally {
        try { if (page) page.cleanup(); } catch (e) { /* 忽略 */ }
        try {
            if (canvasAndContext && pdfDocument) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        } catch (e) { /* 忽略 */ }
    }
}

/**
 * 串行渲染页面
 */
async function serialRenderPages(pdfDocument, pageNums, options = {}) {
    const results = [];

    for (const pageNum of pageNums) {
        const result = await renderPage(pdfDocument, pageNum, options);
        results.push(result);
    }

    return results;
}

// ==================== 主入口函数 ====================

/**
 * 检查 PDF.js 渲染器是否可用
 */
export function isPdfjsAvailable() {
    return PDFDataRangeTransport !== null;
}

/**
 * 获取 PDF.js 版本信息
 */
export function getPdfjsVersion() {
    return 'pdfjs-dist (legacy)';
}

/**
 * 从 URL 渲染 PDF（使用 Range Loader）
 * 
 * @param {string} pdfUrl - PDF 文件 URL
 * @param {number[]} pages - 要渲染的页码数组
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromUrl(pdfUrl, pages = [], options = {}) {
    const startTime = Date.now();
    let pdfDocument;
    let rangeLoader;
    
    try {
        // 获取 PDF 信息
        const { pdfSize, initialData, fullData, isSmallFile } = await getPdfInfo(pdfUrl);
        
        let loadingTask;
        let rangeStats = null;
        
        if (isSmallFile && fullData) {
            logger.debug(`小文件模式: ${(pdfSize / 1024 / 1024).toFixed(2)}MB`);
            
            loadingTask = getDocument({
                data: new Uint8Array(fullData),
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                verbosity: PDFJS_VERBOSITY,
            });
            
            rangeStats = {
                requestCount: 1,
                totalBytes: fullData.byteLength,
                totalBytesMB: (fullData.byteLength / 1024 / 1024).toFixed(2),
                mode: 'full-download',
            };
        } else {
            logger.debug(`分片加载模式: ${(pdfSize / 1024 / 1024).toFixed(2)}MB`);
            
            rangeLoader = new RangeLoader(pdfSize, initialData, pdfUrl);
            
            loadingTask = getDocument({
                range: rangeLoader,
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                rangeChunkSize: RANGE_CHUNK_SIZE,
                disableAutoFetch: true,
                verbosity: PDFJS_VERBOSITY,
            });
        }
        
        pdfDocument = await loadingTask.promise;
        const numPages = pdfDocument.numPages;
        
        // 确定目标页码
        let targetPages;
        if (pages.length === 0) {
            targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
        } else {
            targetPages = pages.filter(p => p >= 1 && p <= numPages);
        }
        
        // 串行渲染
        const renderStart = Date.now();
        const results = await serialRenderPages(pdfDocument, targetPages, options);
        const renderTime = Date.now() - renderStart;
        
        if (!rangeStats) {
            rangeStats = rangeLoader?.getStats() || null;
        }
        
        return {
            success: true,
            numPages,
            pages: results.map(r => ({
                pageNum: r.pageNum,
                width: r.width,
                height: r.height,
                buffer: r.success ? r.buffer : undefined,
                success: r.success,
                error: r.error,
                renderTime: r.renderTime,
                encodeTime: r.encodeTime,
            })),
            totalTime: Date.now() - startTime,
            renderTime,
            streamStats: rangeStats,
        };
    } catch (error) {
        logger.error(`PDF.js 处理失败: ${error.message}`);
        return {
            success: false,
            error: error.message,
            pages: [],
            totalTime: Date.now() - startTime,
        };
    } finally {
        if (pdfDocument) {
            try { await pdfDocument.destroy(); } catch (e) { /* 忽略 */ }
        }
    }
}

/**
 * 从 Buffer 渲染 PDF
 * 
 * @param {Buffer} pdfBuffer - PDF 文件数据
 * @param {number[]} pages - 要渲染的页码数组
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromBuffer(pdfBuffer, pages = [], options = {}) {
    const startTime = Date.now();
    let pdfDocument;
    
    try {
        const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
        
        const loadingTask = getDocument({
            data: new Uint8Array(buffer),
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            verbosity: PDFJS_VERBOSITY,
        });
        
        pdfDocument = await loadingTask.promise;
        const numPages = pdfDocument.numPages;
        
        // 确定目标页码
        let targetPages;
        if (pages.length === 0) {
            targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
        } else {
            targetPages = pages.filter(p => p >= 1 && p <= numPages);
        }
        
        logger.debug(`Rendering ${targetPages.length} pages from buffer (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);
        
        // 串行渲染
        const renderStart = Date.now();
        const results = await serialRenderPages(pdfDocument, targetPages, options);
        const renderTime = Date.now() - renderStart;
        
        return {
            success: true,
            numPages,
            pages: results.map(r => ({
                pageNum: r.pageNum,
                width: r.width,
                height: r.height,
                buffer: r.success ? r.buffer : undefined,
                success: r.success,
                error: r.error,
                renderTime: r.renderTime,
                encodeTime: r.encodeTime,
            })),
            totalTime: Date.now() - startTime,
            renderTime,
        };
    } catch (error) {
        logger.error(`PDF.js 处理失败: ${error.message}`);
        return {
            success: false,
            error: error.message,
            pages: [],
            totalTime: Date.now() - startTime,
        };
    } finally {
        if (pdfDocument) {
            try { await pdfDocument.destroy(); } catch (e) { /* 忽略 */ }
        }
    }
}

/**
 * 从文件路径渲染 PDF
 * 
 * @param {string} filePath - PDF 文件路径
 * @param {number[]} pages - 要渲染的页码数组
 * @param {Object} options - 渲染选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderFromFile(filePath, pages = [], options = {}) {
    const startTime = Date.now();
    let pdfDocument;
    
    try {
        const buffer = await fs.promises.readFile(filePath);
        
        const loadingTask = getDocument({
            data: new Uint8Array(buffer),
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            verbosity: PDFJS_VERBOSITY,
        });
        
        pdfDocument = await loadingTask.promise;
        const numPages = pdfDocument.numPages;
        
        // 确定目标页码
        let targetPages;
        if (pages.length === 0) {
            targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
        } else {
            targetPages = pages.filter(p => p >= 1 && p <= numPages);
        }
        
        logger.debug(`Rendering ${targetPages.length} pages from file: ${filePath}`);
        
        // 串行渲染
        const renderStart = Date.now();
        const results = await serialRenderPages(pdfDocument, targetPages, options);
        const renderTime = Date.now() - renderStart;
        
        return {
            success: true,
            numPages,
            pages: results.map(r => ({
                pageNum: r.pageNum,
                width: r.width,
                height: r.height,
                buffer: r.success ? r.buffer : undefined,
                success: r.success,
                error: r.error,
                renderTime: r.renderTime,
                encodeTime: r.encodeTime,
            })),
            totalTime: Date.now() - startTime,
            renderTime,
        };
    } catch (error) {
        logger.error(`PDF.js 处理失败: ${error.message}`);
        return {
            success: false,
            error: error.message,
            pages: [],
            totalTime: Date.now() - startTime,
        };
    } finally {
        if (pdfDocument) {
            try { await pdfDocument.destroy(); } catch (e) { /* 忽略 */ }
        }
    }
}

/**
 * 获取 PDF 页数（从 Buffer）
 * 
 * @param {Buffer} pdfBuffer - PDF 文件数据
 * @returns {Promise<number>} 页数
 */
export async function getPageCount(pdfBuffer) {
    const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    
    const loadingTask = getDocument({
        data: new Uint8Array(buffer),
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        verbosity: 0,
    });
    
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    await pdfDocument.destroy();
    
    return numPages;
}

/**
 * 获取 PDF 页数（从文件路径）
 * 
 * @param {string} filePath - PDF 文件路径
 * @returns {Promise<number>} 页数
 */
export async function getPageCountFromFile(filePath) {
    const buffer = await fs.promises.readFile(filePath);
    return getPageCount(buffer);
}
