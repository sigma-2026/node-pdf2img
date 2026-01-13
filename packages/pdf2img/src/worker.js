/**
 * PDF2IMG Worker Thread
 * 
 * 在工作线程中执行 CPU 密集型任务：
 * 1. PDFium 渲染 PDF 页面到原始位图
 * 2. Sharp 编码位图到目标格式
 * 
 * 主线程负责协调和 I/O，工作线程负责计算密集型转换
 */

import sharp from 'sharp';

// ==================== Native Renderer 懒加载 ====================

let nativeRenderer = null;
let nativeAvailable = false;
let initPromise = null;

/**
 * 初始化原生渲染器（懒加载）
 */
async function initNativeRenderer() {
    if (initPromise) {
        return initPromise;
    }
    
    initPromise = (async () => {
        try {
            nativeRenderer = await import('node-pdf2img-native');
            
            if (nativeRenderer.isPdfiumAvailable()) {
                nativeAvailable = true;
                
                try {
                    nativeRenderer.warmup();
                } catch (warmupErr) {
                    // 忽略 warmup 错误
                }
            }
        } catch (e) {
            nativeRenderer = {};
            nativeAvailable = false;
        }
    })();
    
    return initPromise;
}

/**
 * 合并配置
 */
function mergeConfig(options = {}) {
    return {
        targetWidth: options.targetWidth ?? 1280,
        detectScan: options.detectScan ?? false,
    };
}

/**
 * 使用 Sharp 编码原始位图
 *
 * @param {Buffer} rawBitmap - 原始 RGBA 像素数据
 * @param {number} width - 图像宽度
 * @param {number} height - 图像高度
 * @param {string} format - 输出格式
 * @param {Object} options - 编码选项
 * @returns {Promise<Buffer>} 编码后的图像数据
 */
async function encodeWithSharp(rawBitmap, width, height, format, options = {}) {
    let sharpInstance = sharp(rawBitmap, {
        raw: {
            width,
            height,
            channels: 4, // RGBA
        }
    });

    let buffer;

    if (format === 'webp') {
        buffer = await sharpInstance.webp({
            quality: options.webpQuality || options.quality || 80,
            effort: options.webpMethod ?? (options.fast ? 0 : 4),
        }).toBuffer();
    } else if (format === 'png') {
        buffer = await sharpInstance.png({
            compressionLevel: options.pngCompression ?? (options.fast ? 1 : 6),
            adaptiveFiltering: !options.fast,
        }).toBuffer();
    } else if (format === 'jpeg' || format === 'jpg') {
        // 移除 alpha 通道，与白色背景混合
        sharpInstance = sharpInstance.flatten({ background: { r: 255, g: 255, b: 255 } });
        buffer = await sharpInstance.jpeg({
            quality: options.jpegQuality || options.quality || 85,
            mozjpeg: !options.fast,
        }).toBuffer();
    } else {
        throw new Error(`Unsupported format: ${format}`);
    }

    // 确保返回的是 Buffer
    // Sharp 的 toBuffer() 可能返回 Uint8Array 或其他类型
    if (!buffer || buffer.length === 0) {
        throw new Error(`${format} encoding failed: empty buffer`);
    }

    // 如果不是 Buffer，尝试转换
    if (!Buffer.isBuffer(buffer)) {
        console.error(`[Worker] ${format} buffer type: ${typeof buffer}, constructor: ${buffer?.constructor?.name}`);
        console.error(`[Worker] Converting to Buffer from type: ${typeof buffer}`);

        if (buffer.buffer && typeof buffer.buffer === 'object') {
            // Uint8Array 或 TypedArray
            return Buffer.from(buffer);
        }

        if (Array.isArray(buffer)) {
            return Buffer.from(buffer);
        }

        // 最后的手段：直接尝试 from
        try {
            return Buffer.from(buffer);
        } catch (e) {
            throw new Error(`${format} encoding failed: cannot convert buffer to Buffer. Type: ${typeof buffer}`);
        }
    }

    return buffer;
}

/**
 * 处理单个页面任务
 * 
 * 这是在工作线程中执行的主函数
 * 
 * @param {Object} task - 任务对象
 * @param {string} [task.filePath] - PDF 文件路径（文件输入时）
 * @param {Buffer} [task.pdfBuffer] - PDF Buffer（Buffer 输入时）
 * @param {number} task.pageNum - 要处理的页码（1-based）
 * @param {Object} task.options - 转换选项
 * @returns {Promise<Object>} 处理结果
 */
export default async function processPage(task) {
    const { filePath, pdfBuffer, pageNum, options = {} } = task;
    
    // 确保原生渲染器已初始化
    await initNativeRenderer();
    
    if (!nativeAvailable) {
        return {
            pageNum,
            success: false,
            error: 'Native renderer not available in worker thread',
            width: 0,
            height: 0,
            buffer: null,
            renderTime: 0,
            encodeTime: 0,
        };
    }
    
    const config = mergeConfig(options);
    
    try {
        // 步骤 1: PDFium 渲染原始位图
        let rawResult;
        
        if (filePath) {
            rawResult = nativeRenderer.renderPageToRawBitmap(filePath, pageNum, config);
        } else if (pdfBuffer) {
            const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
            rawResult = nativeRenderer.renderPageToRawBitmapFromBuffer(buffer, pageNum, config);
        } else {
            return {
                pageNum,
                success: false,
                error: 'No input provided: filePath or pdfBuffer required',
                width: 0,
                height: 0,
                buffer: null,
                renderTime: 0,
                encodeTime: 0,
            };
        }
        
        if (!rawResult.success) {
            return {
                pageNum,
                success: false,
                error: rawResult.error || 'Render failed',
                width: 0,
                height: 0,
                buffer: null,
                renderTime: rawResult.renderTime || 0,
                encodeTime: 0,
            };
        }
        
        const renderTime = rawResult.renderTime || 0;
        const encodeStart = Date.now();
        
        // 步骤 2: Sharp 编码
        const format = options.format || 'webp';
        const encodedBuffer = await encodeWithSharp(
            rawResult.buffer,
            rawResult.width,
            rawResult.height,
            format,
            options
        );
        
        const encodeTime = Date.now() - encodeStart;
        
        return {
            pageNum,
            success: true,
            width: rawResult.width,
            height: rawResult.height,
            buffer: encodedBuffer,
            size: encodedBuffer.length,
            renderTime,
            encodeTime,
        };
    } catch (err) {
        return {
            pageNum,
            success: false,
            error: err.message || 'Unknown error',
            width: 0,
            height: 0,
            buffer: null,
            renderTime: 0,
            encodeTime: 0,
        };
    }
}
