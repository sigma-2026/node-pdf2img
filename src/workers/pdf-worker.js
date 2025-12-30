/**
 * PDF Worker - 核心 Worker 实现
 * 
 * 职责：
 * 1. 接收 PDF URL 和页码范围
 * 2. 使用 RangeLoader 按需分片加载 PDF 数据
 * 3. 解析 PDF 文档并渲染指定页面
 * 4. 使用 sharp (libvips) 高性能编码为 WebP
 * 5. 上传 COS（生产环境）或返回 buffer（开发环境）
 * 
 * 优化：渲染与上传流水线
 * - 渲染完一页后立即启动上传，不等待
 * - CPU 渲染和网络 I/O 并行执行
 * - 提升单 Worker 任务的吞吐量
 * 
 * 依赖：
 * - RangeLoader: 分片加载（src/loaders/range-loader.js）
 * - COS Uploader: COS 上传（src/services/cos-uploader.js）
 * - sharp: 高性能图像处理（基于 libvips）
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from 'path';
import { fileURLToPath } from 'url';
import { RangeLoader, getPdfInfo, RANGE_CONFIG } from './range-loader.js';
import { getCosInstance, uploadFile, COS_CONFIG } from './cos-uploader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== sharp 动态导入 ====================

let sharp = null;
let sharpAvailable = false;

// 尝试加载 sharp（可选依赖）
try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    console.log('[Worker] sharp 库已加载，使用 libvips 高性能编码');
} catch (e) {
    console.warn('[Worker] sharp 库未安装，回退到 canvas.toBuffer 编码');
}

// ==================== PDF.js 配置 ====================

const CMAP_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(__dirname, '../../node_modules/pdfjs-dist/standard_fonts/');

// ==================== 渲染配置 ====================

// 默认渲染缩放比例（1.5 倍，适合大多数场景）
const RENDER_SCALE = parseFloat(process.env.RENDER_SCALE) || 1.5;

// 最大输出宽度限制（防止渲染超大图片）
// 当 scale 后的宽度超过此值时，自动降低 scale 以保证宽度不超限
const MAX_OUTPUT_WIDTH = parseInt(process.env.MAX_OUTPUT_WIDTH) || 2000;

// 超大页面安全网（像素数阈值）
const XLARGE_PAGE_THRESHOLD = parseInt(process.env.XLARGE_PAGE_THRESHOLD) || 4000 * 4000; // 16MP
const XLARGE_PAGE_SCALE = parseFloat(process.env.XLARGE_PAGE_SCALE) || 0.75;

// WebP 编码质量（1-100）
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY) || 80;

// 主动 GC 配置
const GC_THRESHOLD_MB = parseInt(process.env.GC_THRESHOLD_MB) || 500; // 堆内存超过此值时触发 GC

/**
 * 使用 sharp 将 RGBA 原始像素数据编码为 WebP
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
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

/**
 * 渲染单个页面
 * 
 * 渲染策略：
 * 1. 使用默认 1.5 倍缩放
 * 2. 如果缩放后宽度超过 MAX_OUTPUT_WIDTH (2000px)，自动降低缩放比例
 * 3. 超大页面（像素数超阈值）额外降级
 * 
 * @private
 */
async function renderPage(pdfDocument, pageNum) {
    let page;
    let canvasAndContext;
    
    try {
        page = await pdfDocument.getPage(pageNum);
        
        // 1. 获取原始页面尺寸 (在 72 DPI 下)
        const originalViewport = page.getViewport({ scale: 1.0 });
        const originalWidth = originalViewport.width;
        
        // 2. 计算缩放比例：默认 1.5，但不超过最大宽度限制
        let scale = RENDER_SCALE;
        const scaledWidth = originalWidth * scale;
        
        if (scaledWidth > MAX_OUTPUT_WIDTH) {
            // 宽度超限，降低 scale 以保证宽度不超过 MAX_OUTPUT_WIDTH
            scale = MAX_OUTPUT_WIDTH / originalWidth;
        }
        
        let viewport = page.getViewport({ scale });
        
        // 3. 超大页面安全网（像素数超阈值时额外降级）
        if (viewport.width * viewport.height > XLARGE_PAGE_THRESHOLD) {
            console.warn(`[Worker] Page ${pageNum} 尺寸异常 (${Math.round(viewport.width)}x${Math.round(viewport.height)})，强制应用安全降级缩放`);
            viewport = page.getViewport({ scale: scale * XLARGE_PAGE_SCALE });
        }
        
        const width = Math.round(viewport.width);
        const height = Math.round(viewport.height);
        
        // 创建 canvas
        canvasAndContext = pdfDocument.canvasFactory.create(width, height);
        
        // 渲染 PDF 页面到 Canvas
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
        };
        
        const renderTask = page.render(renderContext);
        await renderTask.promise;
        
        // 编码为 WebP
        let buffer;
        
        if (sharpAvailable) {
            // 使用 sharp 高性能编码
            const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
            buffer = await encodeWithSharp(imageData.data, width, height);
        } else {
            // 回退到 canvas.toBuffer
            buffer = canvasAndContext.canvas.toBuffer("image/webp");
        }
        
        return {
            pageNum,
            buffer,
            width,
            height,
            success: true,
        };
    } catch (error) {
        console.error(`[Worker] 渲染页面 ${pageNum} 失败:`, error.message);
        return {
            pageNum,
            success: false,
            error: error.message,
        };
    } finally {
        // 清理资源
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
 * 优化：渲染与上传流水线
 * - 渲染完一页后立即启动上传任务（不等待）
 * - CPU 继续渲染下一页，与上传 I/O 并行
 * - 所有渲染完成后，等待所有上传任务完成
 * 
 * 渲染策略：
 * - 默认 1.5 倍缩放
 * - 最大宽度限制 2000px，超过时自动降低缩放
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
    };
    
    try {
        // 1. 获取 PDF 信息和初始数据
        const infoStart = Date.now();
        const { pdfSize, initialData } = await getPdfInfo(pdfUrl);
        metrics.infoTime = Date.now() - infoStart;
        metrics.pdfSize = pdfSize;
        
        // 2. 创建 RangeLoader 并解析 PDF（流式加载）
        const parseStart = Date.now();
        rangeLoader = new RangeLoader(pdfSize, initialData, pdfUrl);
        
        const loadingTask = getDocument({
            range: rangeLoader,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            rangeChunkSize: RANGE_CONFIG.CHUNK_SIZE,
            disableAutoFetch: true, // 禁用自动预取，按需加载
        });
        
        pdfDocument = await loadingTask.promise;
        metrics.parseTime = Date.now() - parseStart;
        
        const numPages = pdfDocument.numPages;
        
        // 如果没有指定页码，只返回页数信息
        if (!pageNums || pageNums.length === 0) {
            metrics.totalTime = Date.now() - startTime;
            metrics.rangeStats = rangeLoader.getStats();
            
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
        
        // ✨ 预测性预取：主动触发后续页面的数据加载
        // 在渲染第 1 页时，后台并行预取 page 2-6 的数据
        // 将网络延迟与 CPU 渲染时间重叠，显著降低 TTI
        if (validPageNums.length > 1) {
            const pagesToPrefetch = validPageNums.slice(1, 6); // 预取 page 2-6
            
            // 使用 getOperatorList() 轻量触发数据请求
            // 不等待完成，让它在后台运行
            pagesToPrefetch.forEach(pageNum => {
                pdfDocument.getPage(pageNum)
                    .then(page => page.getOperatorList())
                    .catch(() => { /* 忽略预取错误，这是尽力而为 */ });
            });
        }

        // 3. 渲染与上传流水线
        const renderStart = Date.now();
        let results;
        
        if (shouldUpload && globalPadId) {
            // 生产环境：渲染与上传流水线并行
            results = await renderAndUploadPipeline(pdfDocument, validPageNums, globalPadId);
        } else {
            // 开发环境：只渲染，返回 buffer
            results = await renderOnly(pdfDocument, validPageNums);
        }
        
        metrics.renderTime = Date.now() - renderStart;
        metrics.totalTime = Date.now() - startTime;
        metrics.rangeStats = rangeLoader.getStats();
        
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
        console.error('[Worker] 处理失败:', error.message);
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
        // 清理 PDF 文档
        if (pdfDocument) {
            try {
                await pdfDocument.destroy();
            } catch (e) { /* 忽略 */ }
        }
        
        // 主动内存管理：任务完成后检查堆内存，超过阈值时触发 GC
        // 注意：需要 Node.js 启动时带 --expose-gc 参数
        try {
            const heapUsed = process.memoryUsage().heapUsed;
            const heapUsedMB = heapUsed / 1024 / 1024;
            
            if (global.gc && heapUsedMB > GC_THRESHOLD_MB) {
                global.gc();
                const afterGcMB = process.memoryUsage().heapUsed / 1024 / 1024;
                console.log(`[Worker] 主动 GC: ${heapUsedMB.toFixed(1)}MB -> ${afterGcMB.toFixed(1)}MB`);
            }
        } catch (e) { /* 忽略 GC 错误 */ }
    }
}

/**
 * 渲染与上传流水线（生产环境）
 * 
 * 实现 CPU 渲染与网络 I/O 的高度重叠：
 * 1. 渲染完一页后，立即启动该页的上传任务
 * 2. 不等待上传完成，继续渲染下一页
 * 3. 所有渲染完成后，等待所有上传任务完成
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF 文档对象
 * @param {number[]} pageNums - 要渲染的页码
 * @param {string} globalPadId - 全局 ID
 * @returns {Promise<Array>} 渲染和上传结果
 */
async function renderAndUploadPipeline(pdfDocument, pageNums, globalPadId) {
    // 预先获取 COS 实例
    const cos = await getCosInstance();
    if (!cos) {
        // COS 不可用，回退到只渲染模式
        console.warn('[Worker] COS 实例不可用，回退到只渲染模式');
        return renderOnly(pdfDocument, pageNums);
    }
    
    const filePrefix = `${COS_CONFIG.Path}/${globalPadId}`;
    const uploadPromises = [];  // 存储上传 Promise
    const resultMap = new Map(); // pageNum -> result
    
    // 流水线：渲染一页 -> 立即启动上传 -> 继续渲染下一页
    for (const pageNum of pageNums) {
        // 渲染当前页（同步等待渲染完成）
        const renderResult = await renderPage(pdfDocument, pageNum);
        
        if (renderResult.success) {
            // 渲染成功，立即启动上传任务（不等待）
            const key = `${filePrefix}_${pageNum}.webp`;
            
            const uploadPromise = uploadFile(cos, renderResult.buffer, key)
                .then(() => {
                    // 上传成功
                    resultMap.set(pageNum, {
                        pageNum,
                        width: renderResult.width,
                        height: renderResult.height,
                        cosKey: '/' + key,
                        success: true,
                    });
                })
                .catch((error) => {
                    // 上传失败
                    console.error(`[Worker] 上传页面 ${pageNum} 失败:`, error.message);
                    resultMap.set(pageNum, {
                        pageNum,
                        width: renderResult.width,
                        height: renderResult.height,
                        success: false,
                        error: error.message,
                    });
                });
            
            uploadPromises.push(uploadPromise);
        } else {
            // 渲染失败，直接记录结果
            resultMap.set(pageNum, {
                pageNum,
                success: false,
                error: renderResult.error,
            });
        }
    }
    
    // 等待所有上传任务完成
    await Promise.all(uploadPromises);
    
    // 按页码顺序返回结果
    return pageNums.map(pageNum => resultMap.get(pageNum));
}

/**
 * 仅渲染模式（开发环境）
 * 
 * @param {PDFDocumentProxy} pdfDocument - PDF 文档对象
 * @param {number[]} pageNums - 要渲染的页码
 * @returns {Promise<Array>} 渲染结果
 */
async function renderOnly(pdfDocument, pageNums) {
    const results = [];
    
    for (const pageNum of pageNums) {
        const result = await renderPage(pdfDocument, pageNum);
        results.push({
            pageNum: result.pageNum,
            width: result.width,
            height: result.height,
            buffer: result.success ? result.buffer : undefined,
            success: result.success,
            error: result.error,
        });
    }
    
    return results;
}
