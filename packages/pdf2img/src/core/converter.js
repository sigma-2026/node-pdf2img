/**
 * PDF2IMG 核心转换器
 *
 * 提供统一的 API 用于 PDF 转图片
 * 
 * 架构：主线程协调 + 工作线程池处理
 * - 主线程：负责 I/O、任务分发、结果收集
 * - 工作线程池：负责 CPU 密集型任务（PDFium 渲染 + Sharp 编码）
 * 
 * 渲染器支持：
 * - pdfium: PDFium 原生渲染器（默认，高性能）
 * - pdfjs: PDF.js 渲染器（纯 JavaScript，无需原生依赖）
 * 
 * 性能优化：
 * - 使用 piscina 线程池，充分利用多核 CPU
 * - 异步文件 I/O，不阻塞事件循环
 * - 原生模块直接读取文件路径，避免 Node.js 堆内存占用
 * - 流式下载，减少内存峰值
 */

import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import { RENDER_CONFIG, SUPPORTED_FORMATS, RendererType, DEFAULT_RENDERER } from './config.js';
import * as nativeRenderer from '../renderers/native.js';
import * as pdfjsRenderer from '../renderers/pdfjs.js';
import { getThreadCount, getThreadPoolStats, destroyThreadPool } from './thread-pool.js';
import { downloadToTempFile } from './downloader.js';
import { saveToFiles, uploadToCos, DEFAULT_CONCURRENCY } from './output-handler.js';
import { InputType, detectInputType, renderPages, getRendererType } from './renderer.js';

const logger = createLogger('Converter');

/**
 * 输出类型枚举
 */
export const OutputType = {
    FILE: 'file',      // 保存到本地文件
    BUFFER: 'buffer',  // 返回 Buffer 数组
    COS: 'cos',        // 上传到腾讯云 COS
};

// 重新导出 InputType
export { InputType };

/**
 * PDF 转图片
 *
 * @param {string|Buffer} input - PDF 输入（文件路径、URL 或 Buffer）
 * @param {Object} options - 转换选项
 * @param {number[]} [options.pages] - 要转换的页码（1-based），空数组表示全部
 * @param {string} [options.outputType='buffer'] - 输出类型：'file'、'buffer'、'cos'
 * @param {string} [options.outputDir] - 输出目录（outputType='file' 时必需）
 * @param {string} [options.prefix='page'] - 输出文件名前缀
 * @param {string} [options.format='webp'] - 输出格式：'webp'、'png'、'jpg'
 * @param {number} [options.quality] - 图片质量（0-100，用于 webp 和 jpg）
 * @param {string} [options.renderer='pdfium'] - 渲染器：'pdfium'（默认）或 'pdfjs'
 * @param {Object} [options.webp] - WebP 编码配置
 * @param {number} [options.webp.quality] - WebP 质量（0-100，默认 80）
 * @param {number} [options.webp.method] - WebP 编码方法（0-6，默认 4，0最快6最慢）
 * @param {Object} [options.jpeg] - JPEG 编码配置
 * @param {number} [options.jpeg.quality] - JPEG 质量（0-100，默认 85）
 * @param {Object} [options.png] - PNG 编码配置
 * @param {number} [options.png.compressionLevel] - PNG 压缩级别（0-9，默认 6）
 * @param {Object} [options.cos] - COS 配置（outputType='cos' 时必需）
 * @param {string} [options.cosKeyPrefix] - COS key 前缀
 * @param {number} [options.targetWidth] - 目标渲染宽度（默认 1280）
 * @param {number} [options.concurrency] - 文件/上传并发数
 * @returns {Promise<Object>} 转换结果
 */
export async function convert(input, options = {}) {
    const startTime = Date.now();

    const {
        pages = [],
        outputType = OutputType.BUFFER,
        outputDir,
        prefix = 'page',
        format = RENDER_CONFIG.OUTPUT_FORMAT,
        renderer = DEFAULT_RENDERER,
        cos: cosConfig,
        cosKeyPrefix = `pdf2img/${Date.now()}`,
        concurrency,
        ...renderOptions
    } = options;

    // 验证格式
    const normalizedFormat = format.toLowerCase();
    if (!SUPPORTED_FORMATS.includes(normalizedFormat)) {
        throw new Error(`Unsupported format: ${format}. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    // 获取实际使用的渲染器
    const actualRenderer = getRendererType({ renderer });
    logger.debug(`Renderer: ${actualRenderer}`);

    // 检查渲染器可用性
    if (actualRenderer === RendererType.PDFIUM && !nativeRenderer.isNativeAvailable()) {
        throw new Error('Native renderer is not available. Please ensure PDFium library is installed or use renderer: "pdfjs".');
    }

    // 检测输入类型
    const inputType = detectInputType(input);
    logger.debug(`Input type: ${inputType}`);

    // 构建编码选项
    const encodeOptions = {
        format: normalizedFormat,
        quality: renderOptions.quality,
        webpQuality: renderOptions.webp?.quality,
        webpMethod: renderOptions.webp?.method,
        jpegQuality: renderOptions.jpeg?.quality,
        pngCompression: renderOptions.png?.compressionLevel,
        targetWidth: renderOptions.targetWidth,
        detectScan: renderOptions.detectScan,
        renderer: actualRenderer,
    };

    // 使用线程池渲染页面
    const result = await renderPages(input, inputType, pages, encodeOptions);

    // 恢复 Buffer 类型
    // Piscina 跨线程传递时 Buffer 可能被序列化为普通对象 { type: 'Buffer', data: [...] }
    const normalizedPages = result.pages.map(page => {
        if (!page.success || !page.buffer) {
            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                success: false,
                buffer: null,
                error: page.error || 'Render failed',
            };
        }

        let buffer = page.buffer;
        if (!Buffer.isBuffer(buffer)) {
            try {
                if (buffer && typeof buffer === 'object') {
                    if (buffer.type === 'Buffer' && Array.isArray(buffer.data)) {
                        buffer = Buffer.from(buffer.data);
                    } else if (buffer.data && ArrayBuffer.isView(buffer.data)) {
                        buffer = Buffer.from(buffer.data);
                    } else if (ArrayBuffer.isView(buffer)) {
                        buffer = Buffer.from(buffer);
                    } else {
                        buffer = Buffer.from(buffer);
                    }
                } else {
                    throw new Error(`Cannot convert ${typeof buffer} to Buffer`);
                }
            } catch (e) {
                logger.error(`Buffer type mismatch: ${typeof page.buffer}, conversion failed: ${e.message}`);
                return {
                    pageNum: page.pageNum,
                    width: page.width,
                    height: page.height,
                    success: false,
                    buffer: null,
                    error: `Invalid buffer type returned from worker: ${e.message}`,
                };
            }
        }

        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: true,
            buffer,
            size: buffer.length,
        };
    });

    // 处理输出
    let outputResult;

    if (outputType === OutputType.FILE) {
        if (!outputDir) {
            throw new Error('outputDir is required when outputType is "file"');
        }
        outputResult = await saveToFiles(normalizedPages, outputDir, prefix, normalizedFormat, concurrency);

    } else if (outputType === OutputType.COS) {
        if (!cosConfig) {
            throw new Error('cos config is required when outputType is "cos"');
        }
        outputResult = await uploadToCos(normalizedPages, cosConfig, cosKeyPrefix, normalizedFormat, concurrency);

    } else {
        // 返回 Buffer
        outputResult = normalizedPages.sort((a, b) => a.pageNum - b.pageNum);
    }

    const threadCount = getThreadCount();

    return {
        success: true,
        numPages: result.numPages,
        renderedPages: outputResult.filter(p => p.success).length,
        format: normalizedFormat,
        renderer: result.renderer || actualRenderer,
        pages: outputResult,
        timing: {
            total: Date.now() - startTime,
            render: result.renderTime,
            encode: result.encodeTime,
        },
        threadPool: {
            workers: threadCount,
        },
        // 流式渲染统计（仅 URL 输入时存在）
        ...(result.streamStats && { streamStats: result.streamStats }),
    };
}

/**
 * 获取 PDF 页数（异步版本）
 *
 * @param {string|Buffer} input - PDF 输入（文件路径、URL 或 Buffer）
 * @param {Object} [options] - 选项
 * @param {string} [options.renderer] - 渲染器：'pdfium' 或 'pdfjs'
 * @returns {Promise<number>} 页数
 */
export async function getPageCount(input, options = {}) {
    const rendererType = getRendererType(options);
    
    // 使用 PDF.js 渲染器
    if (rendererType === RendererType.PDFJS) {
        if (Buffer.isBuffer(input)) {
            return pdfjsRenderer.getPageCount(input);
        }
        if (typeof input === 'string') {
            if (input.startsWith('http://') || input.startsWith('https://')) {
                // URL 输入需要下载
                const tempFile = await downloadToTempFile(input);
                try {
                    return pdfjsRenderer.getPageCountFromFile(tempFile);
                } finally {
                    try { await fs.promises.unlink(tempFile); } catch {}
                }
            }
            return pdfjsRenderer.getPageCountFromFile(input);
        }
        throw new Error('Invalid input: must be a file path, URL, or Buffer');
    }
    
    // 使用 PDFium 渲染器
    if (!nativeRenderer.isNativeAvailable()) {
        throw new Error('Native renderer is not available');
    }

    if (Buffer.isBuffer(input)) {
        return nativeRenderer.getPageCount(input);
    }
    
    if (typeof input === 'string') {
        if (input.startsWith('http://') || input.startsWith('https://')) {
            const tempFile = await downloadToTempFile(input);
            try {
                return nativeRenderer.getPageCountFromFile(tempFile);
            } finally {
                try { await fs.promises.unlink(tempFile); } catch {}
            }
        }
        
        try {
            await fs.promises.access(input, fs.constants.R_OK);
        } catch {
            throw new Error(`File not found or not readable: ${input}`);
        }
        return nativeRenderer.getPageCountFromFile(input);
    }
    
    throw new Error('Invalid input: must be a file path, URL, or Buffer');
}

/**
 * 获取 PDF 页数（同步版本，保持向后兼容）
 * 
 * @deprecated 使用 getPageCount 的异步版本以获得更好的性能
 */
export function getPageCountSync(input) {
    if (!nativeRenderer.isNativeAvailable()) {
        throw new Error('Native renderer is not available');
    }

    let buffer;
    if (Buffer.isBuffer(input)) {
        buffer = input;
    } else if (typeof input === 'string' && fs.existsSync(input)) {
        buffer = fs.readFileSync(input);
    } else {
        throw new Error('Invalid input: must be a file path or Buffer');
    }

    return nativeRenderer.getPageCount(buffer);
}

/**
 * 检查渲染器是否可用
 * 
 * @param {string} [renderer] - 渲染器类型：'pdfium' 或 'pdfjs'
 * @returns {boolean} 是否可用
 */
export function isAvailable(renderer) {
    if (renderer === RendererType.PDFJS) {
        return pdfjsRenderer.isPdfjsAvailable();
    }
    if (renderer === RendererType.PDFIUM) {
        return nativeRenderer.isNativeAvailable();
    }
    // 默认检查 pdfium，如果不可用则检查 pdfjs
    return nativeRenderer.isNativeAvailable() || pdfjsRenderer.isPdfjsAvailable();
}

/**
 * 获取版本信息
 * 
 * @param {string} [renderer] - 渲染器类型
 * @returns {string} 版本信息
 */
export function getVersion(renderer) {
    if (renderer === RendererType.PDFJS) {
        return pdfjsRenderer.getPdfjsVersion();
    }
    if (nativeRenderer.isNativeAvailable()) {
        return nativeRenderer.getVersion();
    }
    return pdfjsRenderer.getPdfjsVersion();
}

// 重新导出渲染器类型和线程池相关函数
export { RendererType };
export { getThreadPoolStats, destroyThreadPool };
