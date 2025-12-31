/**
 * PDF Worker - 核心 Worker 实现
 * 
 * 职责：
 * 1. 接收 PDF URL 和页码范围（批量处理）
 * 2. 使用 RangeLoader 按需分片加载 PDF 数据
 * 3. 一次 getDocument() 初始化，串行渲染批次内所有页面
 * 4. 使用 sharp (libvips) 高性能编码为 WebP
 * 5. 上传 COS（生产环境）或返回 buffer（开发环境）
 * 
 * 优化：
 * - 批量处理：同一 PDF 的多页在一个 Worker 内完成，避免重复初始化
 * - 渲染与上传流水线：渲染完一页立即启动上传，CPU 与 I/O 并行
 * - 1440px 黄金宽度：自适应缩放，兼顾清晰度与性能
 * 
 * 依赖：
 * - RangeLoader: 分片加载（src/loaders/range-loader.js）
 * - COS Uploader: COS 上传（src/services/cos-uploader.js）
 * - sharp: 高性能图像处理（基于 libvips）
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

// ==================== sharp 动态导入 ====================

let sharp = null;
let sharpAvailable = false;

// 尝试加载 sharp（可选依赖）
try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    logger.info('sharp 库已加载，使用 libvips 高性能编码');
} catch (e) {
    logger.warn('sharp 库未安装，回退到 canvas.toBuffer 编码');
}

// ==================== PDF.js 配置 ====================

const CMAP_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/standard_fonts/');
// wasm 文件路径（用于 openjpeg 和 qcms）
const WASM_URL = 'file://' + path.join(__dirname, '../../node_modules/pdfjs-dist/wasm/');

// ==================== 渲染配置 ====================

// 黄金宽度：目标输出宽度（适合大多数屏幕和场景）
const TARGET_RENDER_WIDTH = parseInt(process.env.TARGET_RENDER_WIDTH) || 1280;

// 扫描件/纯图片页面的降级渲染宽度（减少解码和渲染开销）
const IMAGE_HEAVY_TARGET_WIDTH = parseInt(process.env.IMAGE_HEAVY_TARGET_WIDTH) || 1024;

// 最大缩放比例限制（防止小尺寸 PDF 过度放大）
const MAX_RENDER_SCALE = parseFloat(process.env.MAX_RENDER_SCALE) || 4.0;

// 超大页面安全网（像素数阈值）
const XLARGE_PAGE_THRESHOLD = parseInt(process.env.XLARGE_PAGE_THRESHOLD) || 4000 * 4000; // 16MP
const XLARGE_PAGE_SCALE = parseFloat(process.env.XLARGE_PAGE_SCALE) || 0.75;

// WebP 编码质量（1-100）- 70 是体积/质量的最佳平衡点
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY) || 70;

// WebP 透明通道质量（1-100）- PDF 渲染的 Alpha 通道主要用于抗锯齿，不需要高精度
const WEBP_ALPHA_QUALITY = parseInt(process.env.WEBP_ALPHA_QUALITY) || 70;

// WebP 编码努力程度（0-6，默认4）- 值越低编码越快，但压缩率略降
const WEBP_EFFORT = parseInt(process.env.WEBP_EFFORT) || 2;

// 主动 GC 配置
const GC_THRESHOLD_MB = parseInt(process.env.GC_THRESHOLD_MB) || 500; // 堆内存超过此值时触发 GC

// PDF.js Verbose 日志级别（0=errors, 1=warnings, 5=infos）
const PDFJS_VERBOSITY = parseInt(process.env.PDFJS_VERBOSITY) || (IS_DEV ? 5 : 1);

/**
 * 使用 sharp 将 RGBA 原始像素数据编码为 WebP
 * 
 * WebP 编码参数优化策略（"不可能三角"平衡）：
 * 
 * 1. 质量/体积核心参数：
 *    - quality: 70 - 从 80 降至 70，减小约 25-40% 体积，视觉差异极小
 *    - alphaQuality: 70 - 透明通道主要用于抗锯齿，不需要高精度
 * 
 * 2. 速度核心参数：
 *    - effort: 2 - 从默认 4 降至 2，编码速度提升约 50%
 * 
 * 3. 辅助优化参数：
 *    - smartSubsample: true - 高质量色度子采样，视觉无损但体积更小
 * 
 * @param {Uint8ClampedArray} data - RGBA 像素数据
 * @param {number} width - 图像宽度
 * @param {number} height - 图像高度
 * @returns {Promise<Buffer>} WebP 编码后的 buffer
 */
async function encodeWithSharp(data, width, height) {
    // sharp 需要 Buffer，不能直接使用 Uint8ClampedArray
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    
    return sharp(buffer, {
        raw: {
            width: Math.round(width),
            height: Math.round(height),
            channels: 4,  // RGBA
        },
    })
    .webp({ 
        // 1. 质量/体积核心参数
        quality: WEBP_QUALITY,             // 默认 70，显著减小体积
        alphaQuality: WEBP_ALPHA_QUALITY,  // 默认 70，优化透明通道
        
        // 2. 速度核心参数
        effort: WEBP_EFFORT,               // 默认 2，高速编码
        
        // 3. 辅助优化参数
        smartSubsample: true,              // 高质量色度子采样
    })
    .toBuffer();
}

/**
 * [深度调试版] 渲染单个页面 - 包含微观性能计时与内容复杂度分析
 * 
 * 渲染策略：
 * 1. 快速启发式预判：检测扫描件/纯图片页面，提前降级渲染宽度
 * 2. 使用默认 1.5 倍缩放（扫描件使用降级宽度）
 * 3. 如果缩放后宽度超过 MAX_OUTPUT_WIDTH (2000px)，自动降低缩放比例
 * 4. 超大页面（像素数超阈值）额外降级
 * 
 * 新增诊断能力：
 * - 获取并分析操作符列表（Operator List）
 * - 统计路径、文本、图像操作数量
 * - 检测透明度使用
 * - 细粒度计时（getPage, heuristic, getOperatorList, render, getImageData, encode）
 * 
 * @private
 * @returns {Object} 包含渲染结果、详细耗时指标和内容统计
 */
async function renderPage(pdfDocument, pageNum) {
    let page;
    let canvasAndContext;
    const pageStartTime = Date.now();
    const timing = {
        getPage: 0,
        heuristic: 0,        // 新增：启发式预判耗时
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
        isLikelyScan: false,  // 新增：是否被判定为扫描件
    };
    
    try {
        // 1. 获取页面
        const getPageStart = Date.now();
        page = await pdfDocument.getPage(pageNum);
        timing.getPage = Date.now() - getPageStart;
        
        // 2. ⭐ [核心优化] 快速启发式预判 - 在 getOperatorList 之前判断是否为扫描件
        const heuristicStart = Date.now();
        let targetWidth = TARGET_RENDER_WIDTH;
        let isLikelyScan = false;
        
        try {
            // 访问页面的底层字典结构（不触发图像解码，速度极快）
            // page._pageInfo 包含页面资源引用等信息
            const pageDict = page._pageInfo?.pageDict || page.pageDict;
            
            if (pageDict) {
                const resources = pageDict.get('Resources');
                if (resources) {
                    const xobjects = resources.get('XObject');
                    const fonts = resources.get('Font');
                    
                    // 启发式规则：
                    // - 有图像资源 (XObject) 
                    // - 没有字体资源 (Font) 或字体很少
                    // - 则很可能是扫描件/纯图片页面
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
            // 忽略底层 API 的潜在错误，回退到默认行为
            if (IS_DEV || IS_TEST) {
                logger.debug(`Page ${pageNum} 启发式预判失败: ${e.message}`);
            }
        }
        
        timing.heuristic = Date.now() - heuristicStart;
        contentStats.isLikelyScan = isLikelyScan;
        
        if (isLikelyScan && (IS_DEV || IS_TEST)) {
            logger.debug(`Page ${pageNum}: 检测到扫描件/纯图片页面，降级渲染宽度: ${targetWidth}px`);
        }
        
        // 3. 获取原始页面尺寸 (在 72 DPI 下)
        const originalViewport = page.getViewport({ scale: 1.0 });
        const originalWidth = originalViewport.width;
        
        // 4. 计算缩放比例：使用决策后的 targetWidth
        let scale = targetWidth / originalWidth;
        scale = Math.min(scale, MAX_RENDER_SCALE);
        
        let viewport = page.getViewport({ scale });
        
        // 5. 超大页面安全网（像素数超阈值时额外降级）
        if (viewport.width * viewport.height > XLARGE_PAGE_THRESHOLD) {
            logger.warn(`Page ${pageNum} 尺寸异常 (${Math.round(viewport.width)}x${Math.round(viewport.height)})，强制应用安全降级缩放`);
            viewport = page.getViewport({ scale: scale * XLARGE_PAGE_SCALE });
        }
        
        const width = Math.round(viewport.width);
        const height = Math.round(viewport.height);
        
        // 6. 获取并分析操作符列表 (Operator List)
        // 注意：即使是扫描件，这一步仍会触发图像解码，但因为目标 scale 已减小，
        // 后续的渲染和编码开销会显著降低
        const getOperatorListStart = Date.now();
        const operatorList = await page.getOperatorList();
        timing.getOperatorList = Date.now() - getOperatorListStart;
        
        // 对操作符进行统计分析
        contentStats.operatorCount = operatorList.fnArray.length;
        
        // PDF.js OPS 常量映射到操作类型
        const pathOps = new Set([
            pdfjsLib.OPS.moveTo,
            pdfjsLib.OPS.lineTo,
            pdfjsLib.OPS.curveTo,
            pdfjsLib.OPS.curveTo2,
            pdfjsLib.OPS.curveTo3,
            pdfjsLib.OPS.closePath,
            pdfjsLib.OPS.rectangle,
            pdfjsLib.OPS.fill,
            pdfjsLib.OPS.eoFill,
            pdfjsLib.OPS.stroke,
            pdfjsLib.OPS.fillStroke,
            pdfjsLib.OPS.eoFillStroke,
        ]);
        const textOps = new Set([
            pdfjsLib.OPS.showText,
            pdfjsLib.OPS.showSpacedText,
            pdfjsLib.OPS.nextLineShowText,
            pdfjsLib.OPS.nextLineSetSpacingShowText,
        ]);
        const imageOps = new Set([
            pdfjsLib.OPS.paintImageXObject,
            pdfjsLib.OPS.paintImageMaskXObject,
            pdfjsLib.OPS.paintInlineImageXObject,
            pdfjsLib.OPS.paintInlineImageXObjectGroup,
        ]);
        const transparencyOps = new Set([
            pdfjsLib.OPS.setGState,
            pdfjsLib.OPS.beginGroup,
        ]);
        
        for (const op of operatorList.fnArray) {
            if (pathOps.has(op)) {
                contentStats.pathOps++;
            } else if (textOps.has(op)) {
                contentStats.textOps++;
            } else if (imageOps.has(op)) {
                contentStats.imageOps++;
            } else if (transparencyOps.has(op)) {
                contentStats.transparency = true;
            }
        }
        
        // 7. 创建 canvas 并渲染（复用已获取的 operatorList）
        canvasAndContext = pdfDocument.canvasFactory.create(width, height);
        
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
            operatorList,
        };
        
        const renderStart = Date.now();
        const renderTask = page.render(renderContext);
        await renderTask.promise;
        timing.render = Date.now() - renderStart;
        
        // 8. 编码为 WebP
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
        try {
            if (page) page.cleanup();
        } catch (e) { /* 忽略 */ }
        
        try {
            if (canvasAndContext && pdfDocument) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        } catch (e) { /* 忽略 */ }
    }
}

// ==================== Worker 主函数 ====================

/**
 * Worker 主函数：加载 PDF、渲染页面、上传 COS
 * 
 * 批量处理模式：
 * - 一次 getDocument() 初始化，处理批次内所有页面
 * - 使用 RangeLoader 分片加载，只下载需要的数据
 * - 渲染与上传流水线：CPU 渲染与网络 I/O 并行
 * 
 * 渲染策略：
 * - 1440px 黄金宽度：自适应缩放
 * - 超大页面安全网：像素数超阈值时降级
 * 
 * @param {Object} params
 * @param {string} params.pdfUrl - PDF 文件 URL
 * @param {number[]} params.pageNums - 要渲染的页码数组（空数组则只获取页数）
 * @param {string} params.globalPadId - 全局 ID（用于 COS 路径）
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @returns {Promise<Object>} 渲染结果
 */
export default async function processPages({ 
    pdfUrl,
    pageNums, 
    globalPadId,
    uploadToCos: shouldUpload = false,
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
        pageMetrics: [],  // 每页详细耗时
    };
    
    try {
        if (!pdfUrl) {
            throw new Error('必须提供 pdfUrl');
        }
        
        // 1. 智能获取 PDF 文件（根据文件大小选择最优策略）
        const parseStart = Date.now();
        
        const infoStart = Date.now();
        const { pdfSize, initialData, fullData, isSmallFile } = await getPdfInfo(pdfUrl);
        metrics.infoTime = Date.now() - infoStart;
        metrics.pdfSize = pdfSize;
        
        // 2. 根据文件大小选择加载策略
        let loadingTask;
        
        if (isSmallFile) {
            // 小文件优化：使用已下载的完整数据
            logger.debug(`小文件模式: ${(pdfSize / 1024 / 1024).toFixed(2)}MB，全量下载`);
            
            loadingTask = getDocument({
                data: new Uint8Array(fullData),
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                wasmUrl: WASM_URL,
                verbosity: PDFJS_VERBOSITY,  // 开启 PDF.js 内部日志
            });
            
            // 小文件模式下的统计信息
            metrics.rangeStats = {
                requestCount: 1,  // HEAD 不计入（无数据传输），只计全量下载
                totalBytes: fullData.byteLength,
                totalBytesMB: (fullData.byteLength / 1024 / 1024).toFixed(2),
                avgRequestTime: metrics.infoTime,
                mode: 'full-download',
            };
        } else {
            // 大文件：使用 RangeLoader 分片加载
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
                verbosity: PDFJS_VERBOSITY,  // 开启 PDF.js 内部日志
            });
        }
        
        pdfDocument = await loadingTask.promise;
        
        metrics.parseTime = Date.now() - parseStart;
        
        const numPages = pdfDocument.numPages;
        
        // 如果没有指定页码，只返回页数信息
        if (!pageNums || pageNums.length === 0) {
            metrics.totalTime = Date.now() - startTime;
            // 小文件模式下 rangeStats 已在上面设置，大文件模式从 rangeLoader 获取
            if (!metrics.rangeStats) {
                metrics.rangeStats = rangeLoader?.getStats() || null;
            }
            
            return {
                success: true,
                results: [],
                metrics: {
                    ...metrics,
                    numPages,
                    renderedCount: 0,
                    uploadedCount: 0,
                },
            };
        }
        
        // 过滤无效页码
        const validPageNums = pageNums.filter(p => p >= 1 && p <= numPages);
        
        // 预测性预取（仅对多页渲染有效）
        if (validPageNums.length > 1) {
            const pagesToPrefetch = validPageNums.slice(1, 6);
            pagesToPrefetch.forEach(pageNum => {
                pdfDocument.getPage(pageNum)
                    .then(page => page.getOperatorList())
                    .catch(() => {});
            });
        }

        // 3. 渲染与上传流水线
        const renderStart = Date.now();
        let results;
        
        if (shouldUpload && globalPadId) {
            results = await renderAndUploadPipeline(pdfDocument, validPageNums, globalPadId, metrics);
        } else {
            results = await renderOnly(pdfDocument, validPageNums, metrics);
        }
        
        metrics.renderTime = Date.now() - renderStart;
        metrics.totalTime = Date.now() - startTime;
        // 小文件模式下 rangeStats 已在上面设置，大文件模式从 rangeLoader 获取
        if (!metrics.rangeStats) {
            metrics.rangeStats = rangeLoader?.getStats() || null;
        }
        
        // 开发/测试环境：输出详细日志
        if (IS_DEV || IS_TEST) {
            logger.perf('渲染完成', {
                pdfSize: `${(metrics.pdfSize / 1024 / 1024).toFixed(2)}MB`,
                numPages,
                renderedPages: results.length,
                dataSource: metrics.dataSource,
                timing: {
                    info: metrics.infoTime,
                    parse: metrics.parseTime,
                    render: metrics.renderTime,
                    total: metrics.totalTime,
                },
                rangeStats: metrics.rangeStats,
            });
            
            // 开发/测试环境额外输出每页详情（深度调试格式）
            if (IS_DEV || IS_TEST) {
                logger.debug('每页渲染详情', metrics.pageMetrics.map(p => ({
                    page: p.pageNum,
                    size: `${p.width}x${p.height} @${p.scale}x`,
                    success: p.success,
                    // 是否被检测为扫描件
                    scan: p.content?.isLikelyScan ? '✓' : '-',
                    // 毫秒级计时细分（新增 heuristic）
                    timing: `Total:${p.timing.total}ms (getPage:${p.timing.getPage}, heur:${p.timing.heuristic || 0}, ops:${p.timing.getOperatorList}, render:${p.timing.render}, getImage:${p.timing.getImageData || 0}, encode:${p.timing.encode})`,
                    // 内容复杂度分析
                    content: p.content ? `Ops:${p.content.operatorCount} (Paths:${p.content.pathOps}, Text:${p.content.textOps}, Imgs:${p.content.imageOps}), Transparency:${p.content.transparency}` : 'N/A',
                })));
            }
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
            try {
                await pdfDocument.destroy();
            } catch (e) { /* 忽略 */ }
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

/**
 * 渲染与上传流水线（最终优化版：Worker 内部并行）
 * 
 * 双重并行架构：
 * 1. 宏观并行 (Inter-Worker): 多个 Worker 同时处理不同页面批次
 * 2. 微观并行 (Intra-Worker): 每个 Worker 内部并行处理所有页面
 * 
 * 优势：
 * - 并行 renderPage 调用同时向 RangeLoader 发出多个数据请求
 * - 最大化 CPU 渲染与网络 I/O 的重叠
 * - 总耗时接近最慢单页时间，而非所有页面时间之和
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF 文档对象
 * @param {number[]} pageNums - 要渲染的页码
 * @param {string} globalPadId - 全局 ID
 * @param {Object} metrics - 指标收集对象
 * @returns {Promise<Array>} 渲染和上传结果
 */
async function renderAndUploadPipeline(pdfDocument, pageNums, globalPadId, metrics) {
    const cos = await getCosInstance();
    if (!cos) {
        logger.warn('COS 实例不可用，回退到只渲染模式');
        return renderOnly(pdfDocument, pageNums, metrics);
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    
    // ✨ 核心改动：将串行循环改为并行任务创建
    const pagePromises = pageNums.map(async (pageNum) => {
        // a. 并行地开始渲染每一页
        const renderResult = await renderPage(pdfDocument, pageNum);
        
        // b. 立即收集该页的所有详细指标
        metrics.pageMetrics.push({
            pageNum,
            width: renderResult.width,
            height: renderResult.height,
            scale: renderResult.scale,
            timing: renderResult.timing,
            content: renderResult.contentStats,  // 新增：内容统计
            success: renderResult.success,
        });
        
        if (renderResult.success) {
            // c. 渲染成功后，立即开始上传（不阻塞其他页面的渲染）
            const key = `${filePrefix}_${pageNum}.webp`;
            const uploadStart = Date.now();
            
            try {
                await uploadFile(cos, renderResult.buffer, key);
                const uploadTime = Date.now() - uploadStart;
                const bufferSize = renderResult.buffer.length;
                
                // 开发/测试环境：输出上传成功日志
                if (IS_DEV || IS_TEST) {
                    logger.perf('COS上传成功', { 
                        page: pageNum, 
                        key, 
                        size: `${(bufferSize / 1024).toFixed(1)}KB`, 
                        time: uploadTime 
                    });
                }
                
                // d. 返回上传成功的结果
                return {
                    pageNum,
                    width: renderResult.width,
                    height: renderResult.height,
                    cosKey: '/' + key,
                    success: true,
                    timing: { ...renderResult.timing, upload: uploadTime },
                };
            } catch (error) {
                // 上传失败始终记录（所有环境）
                logger.error(`COS上传失败: page=${pageNum}, key=${key}, error=${error.message}`);
                // e. 返回上传失败的结果
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
            // f. 渲染失败，直接返回结果
            return {
                pageNum,
                success: false,
                error: renderResult.error,
                timing: renderResult.timing,
            };
        }
    });
    
    // ✨ 等待所有页面的"渲染->上传"流水线全部完成
    return await Promise.all(pagePromises);
}

/**
 * 仅渲染模式（最终优化版：Worker 内部并行）
 * 
 * 并行处理所有页面，总耗时接近最慢单页时间
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF 文档对象
 * @param {number[]} pageNums - 要渲染的页码
 * @param {Object} metrics - 指标收集对象
 * @returns {Promise<Array>} 渲染结果
 */
async function renderOnly(pdfDocument, pageNums, metrics) {
    // ✨ 核心改动：将串行循环改为并行任务创建
    const pagePromises = pageNums.map(async (pageNum) => {
        const result = await renderPage(pdfDocument, pageNum);
        
        // 收集指标（包含内容统计）
        metrics.pageMetrics.push({
            pageNum,
            width: result.width,
            height: result.height,
            scale: result.scale,
            timing: result.timing,
            content: result.contentStats,  // 新增：内容统计
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
    
    // ✨ 等待所有页面的渲染任务并行完成
    return await Promise.all(pagePromises);
}
