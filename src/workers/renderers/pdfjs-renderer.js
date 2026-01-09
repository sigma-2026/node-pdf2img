/**
 * PDF.js Renderer - PDF.js 渲染器模块
 * 
 * 使用 PDF.js + RangeLoader 进行 PDF 渲染，特点：
 * - 分片加载，只下载需要的数据
 * - 适合大文件
 * - 稳定可靠
 * 
 * V7 优化：串行渲染，并行上传，避免资源争抢
 * 
 * @module renderers/pdfjs-renderer
 */

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from 'path';
import { fileURLToPath } from 'url';
import { RangeLoader, getPdfInfo, RANGE_CONFIG } from '../range-loader.js';
import { createUploadTask } from '../upload-manager.js';
import { createLogger, IS_DEV, IS_TEST } from '../../utils/logger.js';

// PDF.js 操作符映射（用于内容分析）
const pdfjsLib = { OPS };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('PdfjsRenderer');

// ==================== PDF.js 配置 ====================

const CMAP_URL = path.join(__dirname, '../../../node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(__dirname, '../../../node_modules/pdfjs-dist/standard_fonts/');
const WASM_URL = path.join(__dirname, '../../../node_modules/pdfjs-dist/wasm/');

// ==================== 渲染配置 ====================

const TARGET_RENDER_WIDTH = parseInt(process.env.TARGET_RENDER_WIDTH) || 1280;
const IMAGE_HEAVY_TARGET_WIDTH = parseInt(process.env.IMAGE_HEAVY_TARGET_WIDTH) || 1024;
const MAX_RENDER_SCALE = parseFloat(process.env.MAX_RENDER_SCALE) || 4.0;
const XLARGE_PAGE_THRESHOLD = parseInt(process.env.XLARGE_PAGE_THRESHOLD) || 4000 * 4000;
const XLARGE_PAGE_SCALE = parseFloat(process.env.XLARGE_PAGE_SCALE) || 0.75;
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY) || 70;
const WEBP_ALPHA_QUALITY = parseInt(process.env.WEBP_ALPHA_QUALITY) || 70;
const WEBP_EFFORT = parseInt(process.env.WEBP_EFFORT) || 2;
const GC_THRESHOLD_MB = parseInt(process.env.GC_THRESHOLD_MB) || 500;
const PDFJS_VERBOSITY = parseInt(process.env.PDFJS_VERBOSITY) || (IS_DEV ? 5 : 1);

// WebP 格式限制
const WEBP_MAX_DIMENSION = 16383;
const WEBP_MAX_PIXELS = 16383 * 16383;

// ==================== sharp 动态导入 ====================

let sharp = null;
let sharpAvailable = false;

// 使用 top-level await 确保模块加载时完成初始化
try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    logger.info('sharp 库已加载');
} catch (e) {
    logger.warn('sharp 库未安装，回退到 canvas.toBuffer 编码');
    sharp = null;
    sharpAvailable = false;
}

// ==================== 编码函数 ====================

/**
 * 使用 sharp 将 RGBA 原始像素数据编码为 WebP
 * 
 * @param {Uint8ClampedArray} data - RGBA 像素数据
 * @param {number} width - 图片宽度
 * @param {number} height - 图片高度
 * @returns {Promise<Buffer>} WebP 图片数据
 */
async function encodeWithSharp(data, width, height) {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    
    return sharp(buffer, {
        raw: {
            width: Math.round(width),
            height: Math.round(height),
            channels: 4,
        },
    })
    .webp({ 
        quality: WEBP_QUALITY,
        alphaQuality: WEBP_ALPHA_QUALITY,
        effort: WEBP_EFFORT,
        smartSubsample: true,
    })
    .toBuffer();
}

// ==================== 渲染函数 ====================

/**
 * 渲染单个 PDF 页面为 WebP 图片
 * 
 * 该函数处理视口计算、缩放、内容分析和编码。
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF.js 文档实例
 * @param {number} pageNum - 页码（从 1 开始）
 * @returns {Promise<Object>} 渲染结果
 * @property {number} pageNum - 页码
 * @property {Buffer} [buffer] - WebP 图片数据（成功时）
 * @property {boolean} success - 是否成功
 * @property {string} [error] - 错误信息（失败时）
 * @property {number} width - 图片宽度
 * @property {number} height - 图片高度
 * @property {Object} timing - 各阶段耗时
 * @property {Object} contentStats - 页面内容统计
 */
async function renderPage(pdfDocument, pageNum) {
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
    const contentStats = {
        operatorCount: 0,
        pathOps: 0,
        textOps: 0,
        imageOps: 0,
        transparency: false,
        isLikelyScan: false,
    };
    
    try {
        // 获取页面
        const getPageStart = Date.now();
        page = await pdfDocument.getPage(pageNum);
        timing.getPage = Date.now() - getPageStart;
        
        // 快速启发式预判
        const heuristicStart = Date.now();
        let targetWidth = TARGET_RENDER_WIDTH;
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
                    
                    if (hasImages && !hasFonts) {
                        isLikelyScan = true;
                        targetWidth = IMAGE_HEAVY_TARGET_WIDTH;
                    }
                }
            }
        } catch (e) {
            if (IS_DEV || IS_TEST) {
                logger.debug(`Page ${pageNum} 启发式预判失败: ${e.message}`);
            }
        }
        
        timing.heuristic = Date.now() - heuristicStart;
        contentStats.isLikelyScan = isLikelyScan;
        
        // 计算缩放比例
        const originalViewport = page.getViewport({ scale: 1.0 });
        const originalWidth = originalViewport.width;
        
        let scale = targetWidth / originalWidth;
        scale = Math.min(scale, MAX_RENDER_SCALE);
        
        let viewport = page.getViewport({ scale });
        
        // 超大页面安全网
        if (viewport.width * viewport.height > XLARGE_PAGE_THRESHOLD) {
            logger.warn(`Page ${pageNum} 像素数异常 (${Math.round(viewport.width)}x${Math.round(viewport.height)})，强制降级`);
            scale = scale * XLARGE_PAGE_SCALE;
            viewport = page.getViewport({ scale });
        }
        
        // WebP 尺寸限制检查
        let width = Math.round(viewport.width);
        let height = Math.round(viewport.height);
        
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
        
        // 最终安全检查
        if (width * height > WEBP_MAX_PIXELS) {
            const pixelFactor = Math.sqrt(WEBP_MAX_PIXELS / (width * height));
            logger.warn(`Page ${pageNum} 像素数超过 WebP 限制，进一步缩放至 ${(pixelFactor * 100).toFixed(1)}%`);
            
            scale = scale * pixelFactor;
            viewport = page.getViewport({ scale });
            width = Math.round(viewport.width);
            height = Math.round(viewport.height);
        }
        
        // 获取操作符列表
        const getOperatorListStart = Date.now();
        const operatorList = await page.getOperatorList();
        timing.getOperatorList = Date.now() - getOperatorListStart;
        
        // 统计分析
        contentStats.operatorCount = operatorList.fnArray.length;
        
        const pathOps = new Set([
            pdfjsLib.OPS.moveTo, pdfjsLib.OPS.lineTo, pdfjsLib.OPS.curveTo,
            pdfjsLib.OPS.curveTo2, pdfjsLib.OPS.curveTo3, pdfjsLib.OPS.closePath,
            pdfjsLib.OPS.rectangle, pdfjsLib.OPS.fill, pdfjsLib.OPS.eoFill,
            pdfjsLib.OPS.stroke, pdfjsLib.OPS.fillStroke, pdfjsLib.OPS.eoFillStroke,
        ]);
        const textOps = new Set([
            pdfjsLib.OPS.showText, pdfjsLib.OPS.showSpacedText,
            pdfjsLib.OPS.nextLineShowText, pdfjsLib.OPS.nextLineSetSpacingShowText,
        ]);
        const imageOps = new Set([
            pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintImageMaskXObject,
            pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintInlineImageXObjectGroup,
        ]);
        const transparencyOps = new Set([pdfjsLib.OPS.setGState, pdfjsLib.OPS.beginGroup]);
        
        for (const op of operatorList.fnArray) {
            if (pathOps.has(op)) contentStats.pathOps++;
            else if (textOps.has(op)) contentStats.textOps++;
            else if (imageOps.has(op)) contentStats.imageOps++;
            else if (transparencyOps.has(op)) contentStats.transparency = true;
        }
        
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
        
        // 编码为 WebP
        const encodeStart = Date.now();
        let buffer;
        
        if (sharpAvailable) {
            const getImageDataStart = Date.now();
            const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
            timing.getImageData = Date.now() - getImageDataStart;
            buffer = await encodeWithSharp(imageData.data, width, height);
        } else {
            buffer = canvasAndContext.canvas.toBuffer("image/webp");
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
            timing,
            contentStats,
        };
    } catch (error) {
        timing.total = Date.now() - pageStartTime;
        logger.error(`渲染页面 ${pageNum} 失败: ${error.message}`);
        return {
            pageNum,
            success: false,
            error: error.message,
            timing,
            contentStats,
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
 * [V7优化] PDF.js 专用流水线：串行渲染，并行上传
 *
 * 该策略通过 for...of 循环确保一次只处理一个页面的 CPU 密集型任务，
 * 避免了资源争抢。上传任务被立即发起并推入数组，最后通过
 * Promise.all 实现并行上传。
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF.js 文档实例
 * @param {number[]} pageNums - 要渲染的页码数组
 * @param {string} globalPadId - 全局 ID
 * @param {Object} metrics - 指标收集对象
 * @param {boolean} shouldUpload - 是否上传到 COS
 * @returns {Promise<Array>} 渲染结果数组
 */
async function serialRenderPipeline(pdfDocument, pageNums, globalPadId, metrics, shouldUpload) {
    const uploadPromises = [];
    const finalResults = [];

    logger.debug(`[V7] 串行渲染流水线启动: ${pageNums.length} 页, 上传=${shouldUpload}`);

    // 使用 for...of 循环，保证页面渲染是串行的
    for (const pageNum of pageNums) {
        const renderResult = await renderPage(pdfDocument, pageNum);

        // 收集该页的指标
        metrics.pageMetrics.push({
            pageNum: renderResult.pageNum,
            width: renderResult.width,
            height: renderResult.height,
            scale: renderResult.scale,
            timing: renderResult.timing,
            content: renderResult.contentStats,
            success: renderResult.success,
        });

        if (renderResult.success) {
            if (!shouldUpload || !globalPadId) {
                // 不需要上传，保留 buffer
                finalResults.push({
                    pageNum: renderResult.pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    buffer: renderResult.buffer,
                    success: true,
                    timing: renderResult.timing,
                });
                continue;
            }
            
            // 渲染完成后立即启动上传任务（不等待）
            const uploadPromise = createUploadTask(renderResult, globalPadId, 'V7串行');
            if (uploadPromise) {
                uploadPromises.push(uploadPromise);
            }
        } else {
            // 渲染失败
            finalResults.push({
                pageNum: renderResult.pageNum,
                success: false,
                error: renderResult.error,
                timing: renderResult.timing,
            });
        }
    }
    
    // 等待所有上传任务完成
    const uploadedResults = await Promise.all(uploadPromises);

    logger.debug(`[V7] 串行渲染完成: 渲染失败/无需上传=${finalResults.length}, 上传完成=${uploadedResults.length}`);

    // 合并所有结果并按页码排序返回
    return [...finalResults, ...uploadedResults].sort((a, b) => a.pageNum - b.pageNum);
}

/**
 * 仅渲染模式（并行版本）
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF.js 文档实例
 * @param {number[]} pageNums - 要渲染的页码数组
 * @param {Object} metrics - 指标收集对象
 * @returns {Promise<Array>} 渲染结果数组
 */
async function renderOnly(pdfDocument, pageNums, metrics) {
    const pagePromises = pageNums.map(async (pageNum) => {
        const result = await renderPage(pdfDocument, pageNum);
        
        metrics.pageMetrics.push({
            pageNum,
            width: result.width,
            height: result.height,
            scale: result.scale,
            timing: result.timing,
            content: result.contentStats,
            success: result.success,
        });
        
        return {
            pageNum: result.pageNum,
            width: result.width,
            height: result.height,
            buffer: result.success ? result.buffer : undefined,
            success: result.success,
            error: result.error,
            timing: result.timing,
        };
    });
    
    return await Promise.all(pagePromises);
}

// ==================== 主入口 ====================

/**
 * 使用 PDF.js + RangeLoader 处理 PDF
 * 
 * @param {Object} params - 处理参数
 * @param {string} params.pdfUrl - PDF 文件 URL
 * @param {number[]|null} params.pageNums - 要渲染的页码数组
 * @param {string} params.globalPadId - 全局 ID
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @returns {Promise<Object>} 处理结果
 */
export async function processWithPdfjs({
    pdfUrl,
    pageNums,
    globalPadId,
    uploadToCos: shouldUpload,
}) {
    const startTime = Date.now();
    let pdfDocument;
    let rangeLoader;
    
    const metrics = {
        infoTime: 0,
        parseTime: 0,
        renderTime: 0,
        uploadTime: 0,
        totalTime: 0,
        pdfSize: 0,
        rangeStats: null,
        pageMetrics: [],
        renderer: 'pdfjs',
    };
    
    try {
        if (!pdfUrl) {
            throw new Error('必须提供 pdfUrl');
        }
        
        // 获取 PDF 信息
        const parseStart = Date.now();
        const infoStart = Date.now();
        const { pdfSize, initialData, fullData, isSmallFile } = await getPdfInfo(pdfUrl);
        metrics.infoTime = Date.now() - infoStart;
        metrics.pdfSize = pdfSize;
        
        // 根据文件大小选择加载策略
        let loadingTask;
        
        if (isSmallFile && fullData) {
            logger.debug(`小文件模式: ${(pdfSize / 1024 / 1024).toFixed(2)}MB，全量下载`);
            
            loadingTask = getDocument({
                data: new Uint8Array(fullData),
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                wasmUrl: WASM_URL,
                verbosity: PDFJS_VERBOSITY,
            });
            
            metrics.rangeStats = {
                requestCount: 1,
                totalBytes: fullData.byteLength,
                totalBytesMB: (fullData.byteLength / 1024 / 1024).toFixed(2),
                avgRequestTime: metrics.infoTime,
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
                wasmUrl: WASM_URL,
                rangeChunkSize: RANGE_CONFIG.CHUNK_SIZE,
                disableAutoFetch: true,
                verbosity: PDFJS_VERBOSITY,
            });
        }
        
        pdfDocument = await loadingTask.promise;
        metrics.parseTime = Date.now() - parseStart;
        
        const numPages = pdfDocument.numPages;
        
        // 如果没有指定页码，只返回页数信息
        if (!pageNums || pageNums.length === 0) {
            metrics.totalTime = Date.now() - startTime;
            if (!metrics.rangeStats) {
                metrics.rangeStats = rangeLoader?.getStats() || null;
            }
            
            return {
                success: true,
                results: [],
                metrics: { ...metrics, numPages, renderedCount: 0, uploadedCount: 0 },
            };
        }
        
        // 过滤无效页码
        const validPageNums = pageNums.filter(p => p >= 1 && p <= numPages);
        
        // 预测性预取
        if (validPageNums.length > 1) {
            const pagesToPrefetch = validPageNums.slice(1, 6);
            pagesToPrefetch.forEach(pageNum => {
                pdfDocument.getPage(pageNum)
                    .then(page => page.getOperatorList())
                    .catch(() => {});
            });
        }

        // 使用串行渲染流水线
        const renderStart = Date.now();
        const results = await serialRenderPipeline(
            pdfDocument, 
            validPageNums, 
            globalPadId, 
            metrics, 
            shouldUpload
        );
        metrics.renderTime = Date.now() - renderStart;
        metrics.totalTime = Date.now() - startTime;
        if (!metrics.rangeStats) {
            metrics.rangeStats = rangeLoader?.getStats() || null;
        }
        
        if (IS_DEV || IS_TEST) {
            logger.perf('渲染完成', {
                pdfSize: `${(metrics.pdfSize / 1024 / 1024).toFixed(2)}MB`,
                numPages,
                renderedPages: results.length,
                timing: {
                    info: metrics.infoTime,
                    parse: metrics.parseTime,
                    render: metrics.renderTime,
                    total: metrics.totalTime,
                },
                rangeStats: metrics.rangeStats,
            });
            
            logger.debug('每页渲染详情', metrics.pageMetrics.map(p => ({
                page: p.pageNum,
                size: `${p.width}x${p.height} @${p.scale}x`,
                success: p.success,
                scan: p.content?.isLikelyScan ? '✓' : '-',
                timing: `Total:${p.timing.total}ms (getPage:${p.timing.getPage}, heur:${p.timing.heuristic || 0}, ops:${p.timing.getOperatorList}, render:${p.timing.render}, getImage:${p.timing.getImageData || 0}, encode:${p.timing.encode})`,
                content: p.content ? `Ops:${p.content.operatorCount} (Paths:${p.content.pathOps}, Text:${p.content.textOps}, Imgs:${p.content.imageOps}), Transparency:${p.content.transparency}` : 'N/A',
            })));
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
        logger.error(`处理失败: ${error.message}`);
        return {
            success: false,
            error: error.message,
            results: [],
            metrics: {
                ...metrics,
                totalTime: Date.now() - startTime,
                rangeStats: rangeLoader?.getStats(),
            },
        };
    } finally {
        if (pdfDocument) {
            try { await pdfDocument.destroy(); } catch (e) { /* 忽略 */ }
        }
        
        try {
            const heapUsed = process.memoryUsage().heapUsed;
            const heapUsedMB = heapUsed / 1024 / 1024;
            
            if (global.gc && heapUsedMB > GC_THRESHOLD_MB) {
                global.gc();
                const afterGcMB = process.memoryUsage().heapUsed / 1024 / 1024;
                logger.debug(`主动 GC: ${heapUsedMB.toFixed(1)}MB -> ${afterGcMB.toFixed(1)}MB`);
            }
        } catch (e) { /* 忽略 GC 错误 */ }
    }
}

// 导出渲染函数供测试使用
export { renderPage, renderOnly };
