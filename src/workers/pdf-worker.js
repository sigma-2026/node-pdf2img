/**
 * PDF Worker - 终极架构 V5 执行中心
 * 
 * 职责：
 * 根据主线程的决策，执行两种渲染路径之一：
 * 
 * 1. Native 路径 (useNativeRenderer: true)
 *    - 接收 pdfData (Buffer)，直接调用 native-renderer
 *    - 适用于小文件和扫描件
 *    - 性能最优
 * 
 * 2. PDF.js 路径 (useNativeRenderer: false)
 *    - 接收 pdfUrl，使用 RangeLoader 分片加载
 *    - 适用于大文件和文本密集型 PDF
 *    - 稳定可靠
 * 
 * 优化：
 * - 批量处理：同一 PDF 的多页在一个 Worker 内完成
 * - 渲染与上传流水线：CPU 渲染与网络 I/O 并行
 * - 1280px 黄金宽度：自适应缩放，兼顾清晰度与性能
 */

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from 'path';
import { fileURLToPath } from 'url';
import { RangeLoader, getPdfInfo, RANGE_CONFIG } from './range-loader.js';
import { getCosInstance, uploadFile, COS_CONFIG } from './cos-uploader.js';
import { createLogger, IS_DEV, IS_TEST } from '../utils/logger.js';

// PDF.js 操作符映射（用于内容分析）
const pdfjsLib = { OPS };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker 日志
const logger = createLogger('Worker');

// ==================== Native Renderer 动态导入 ====================

let nativeRenderer = null;
let nativeAvailable = false;

// 尝试加载 native-renderer
try {
    const nativeRendererPath = path.join(__dirname, '../../native-renderer/index.js');
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
}

// ==================== sharp 动态导入 ====================

let sharp = null;
let sharpAvailable = false;

try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    logger.info('sharp 库已加载');
} catch (e) {
    logger.warn('sharp 库未安装，回退到 canvas.toBuffer 编码');
}

// ==================== PDF.js 配置 ====================

const CMAP_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/standard_fonts/');
const WASM_URL = 'file://' + path.join(__dirname, '../../node_modules/pdfjs-dist/wasm/');

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

// ==================== Worker 主入口 ====================

/**
 * Worker 主入口：根据主线程的决策调度渲染器
 * 
 * @param {Object} params
 * @param {Buffer} [params.pdfData] - PDF 文件数据（Native 路径）
 * @param {string} [params.pdfUrl] - PDF 文件 URL（PDF.js 路径）
 * @param {number[]} params.pageNums - 要渲染的页码数组
 * @param {string} params.globalPadId - 全局 ID
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @param {boolean} params.useNativeRenderer - 是否使用 Native Renderer
 * @param {number} [params.pdfSize] - PDF 文件大小
 * @param {number} [params.numPages] - PDF 页数
 */
export default async function processPages(params) {
    const { useNativeRenderer, pdfData, pdfUrl } = params;
    
    // 主线程已经做出了决策
    if (useNativeRenderer && nativeAvailable && pdfData) {
        return await processWithNativeRenderer(params);
    } else if (pdfUrl) {
        return await processWithPdfjs(params);
    } else {
        throw new Error('无效的任务参数：需要 pdfData 或 pdfUrl');
    }
}

// ==================== Native Renderer 路径 ====================

/**
 * 使用 Native Renderer (Rust + PDFium) 处理 PDF
 * 
 * 特点：
 * - 直接使用 PDFium C++ 库渲染
 * - 内置 WebP 编码
 * - 单次调用完成所有页面渲染
 * - 性能最优
 */
async function processWithNativeRenderer({
    pdfData,
    pageNums,
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
        pdfSize: pdfSize || pdfData.length,
        rangeStats: null,
        pageMetrics: [],
        renderer: 'native',
    };
    
    try {
        // 转换为 Buffer（如果是 ArrayBuffer）
        const pdfBuffer = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
        metrics.pdfSize = pdfBuffer.length;
        
        logger.debug(`Native Renderer 模式: ${(metrics.pdfSize / 1024 / 1024).toFixed(2)}MB`);
        
        // 获取页数
        const numPages = providedNumPages || nativeRenderer.getPageCount(pdfBuffer);
        
        // 如果没有指定页码，只返回页数信息
        if (!pageNums || pageNums.length === 0) {
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
        }
        
        // 过滤无效页码
        const validPageNums = pageNums.filter(p => p >= 1 && p <= numPages);
        
        // 渲染配置
        const renderOptions = {
            targetWidth: TARGET_RENDER_WIDTH,
            imageHeavyWidth: IMAGE_HEAVY_TARGET_WIDTH,
            maxScale: MAX_RENDER_SCALE,
            webpQuality: WEBP_QUALITY,
            detectScan: true,
        };
        
        // 调用 native renderer 渲染
        const renderStart = Date.now();
        const nativeResult = nativeRenderer.renderPages(pdfBuffer, validPageNums, renderOptions);
        metrics.renderTime = Date.now() - renderStart;
        
        if (!nativeResult.success) {
            throw new Error(nativeResult.error || 'Native renderer 渲染失败');
        }
        
        // 转换结果格式
        let results = nativeResult.pages.map(page => {
            metrics.pageMetrics.push({
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                scale: 1.0,
                timing: {
                    render: page.renderTime,
                    encode: page.encodeTime,
                    total: page.renderTime + page.encodeTime,
                },
                success: page.success,
            });
            
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                buffer: page.success ? page.buffer : undefined,
                success: page.success,
                error: page.error,
                timing: {
                    render: page.renderTime,
                    encode: page.encodeTime,
                    total: page.renderTime + page.encodeTime,
                },
            };
        });
        
        // 上传到 COS
        if (shouldUpload && globalPadId) {
            const cos = await getCosInstance();
            if (cos) {
                const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
                
                const uploadPromises = results.map(async (page) => {
                    if (!page.success || !page.buffer) return page;
                    
                    const key = `${filePrefix}_${page.pageNum}.webp`;
                    const uploadStart = Date.now();
                    
                    try {
                        await uploadFile(cos, page.buffer, key);
                        const uploadTime = Date.now() - uploadStart;
                        
                        if (IS_DEV || IS_TEST) {
                            logger.perf('COS上传成功(Native)', {
                                page: page.pageNum,
                                key,
                                size: `${(page.buffer.length / 1024).toFixed(1)}KB`,
                                time: uploadTime,
                            });
                        }
                        
                        return {
                            pageNum: page.pageNum,
                            width: page.width,
                            height: page.height,
                            cosKey: '/' + key,
                            success: true,
                            timing: { ...page.timing, upload: uploadTime },
                        };
                    } catch (error) {
                        logger.error(`COS上传失败(Native): page=${page.pageNum}, error=${error.message}`);
                        return { ...page, success: false, error: error.message };
                    }
                });
                
                results = await Promise.all(uploadPromises);
            }
        }
        
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

// ==================== PDF.js 路径 ====================

/**
 * 使用 PDF.js + RangeLoader 处理 PDF
 * 
 * 特点：
 * - 分片加载，只下载需要的数据
 * - 适合大文件
 * - 稳定可靠
 */
async function processWithPdfjs({
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

        // 渲染与上传
        const renderStart = Date.now();
        let results;
        
        if (shouldUpload && globalPadId) {
            results = await renderAndUploadPipeline(pdfDocument, validPageNums, globalPadId, metrics);
        } else {
            results = await renderOnly(pdfDocument, validPageNums, metrics);
        }
        
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

// ==================== 渲染函数 ====================

/**
 * 使用 sharp 将 RGBA 原始像素数据编码为 WebP
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

/**
 * 渲染单个页面
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
            logger.warn(`Page ${pageNum} 尺寸异常，强制降级`);
            viewport = page.getViewport({ scale: scale * XLARGE_PAGE_SCALE });
        }
        
        const width = Math.round(viewport.width);
        const height = Math.round(viewport.height);
        
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
 * 渲染与上传流水线
 */
async function renderAndUploadPipeline(pdfDocument, pageNums, globalPadId, metrics) {
    const cos = await getCosInstance();
    if (!cos) {
        logger.warn('COS 实例不可用，回退到只渲染模式');
        return renderOnly(pdfDocument, pageNums, metrics);
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    
    const pagePromises = pageNums.map(async (pageNum) => {
        const renderResult = await renderPage(pdfDocument, pageNum);
        
        metrics.pageMetrics.push({
            pageNum,
            width: renderResult.width,
            height: renderResult.height,
            scale: renderResult.scale,
            timing: renderResult.timing,
            content: renderResult.contentStats,
            success: renderResult.success,
        });
        
        if (renderResult.success) {
            const key = `${filePrefix}_${pageNum}.webp`;
            const uploadStart = Date.now();
            
            try {
                await uploadFile(cos, renderResult.buffer, key);
                const uploadTime = Date.now() - uploadStart;
                
                if (IS_DEV || IS_TEST) {
                    logger.perf('COS上传成功', { 
                        page: pageNum, 
                        key, 
                        size: `${(renderResult.buffer.length / 1024).toFixed(1)}KB`, 
                        time: uploadTime 
                    });
                }
                
                return {
                    pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    cosKey: '/' + key,
                    success: true,
                    timing: { ...renderResult.timing, upload: uploadTime },
                };
            } catch (error) {
                logger.error(`COS上传失败: page=${pageNum}, key=${key}, error=${error.message}`);
                return {
                    pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    success: false,
                    error: error.message,
                    timing: renderResult.timing,
                };
            }
        } else {
            return {
                pageNum,
                success: false,
                error: renderResult.error,
                timing: renderResult.timing,
            };
        }
    });
    
    return await Promise.all(pagePromises);
}

/**
 * 仅渲染模式
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
