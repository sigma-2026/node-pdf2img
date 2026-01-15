/**
 * PDF 渲染模块
 * 
 * 负责 PDF 页面的渲染逻辑，支持本地文件、Buffer 和 URL 输入
 * 支持两种渲染器：
 * - pdfium: PDFium 原生渲染器（默认，高性能）
 * - pdfjs: PDF.js 渲染器（纯 JavaScript，无需原生依赖）
 */

import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import { RendererType, DEFAULT_RENDERER } from './config.js';
import * as nativeRenderer from '../renderers/native.js';
import * as pdfjsRenderer from '../renderers/pdfjs.js';
import { getThreadPool, getThreadCount } from './thread-pool.js';
import { getRemoteFileSize, downloadToTempFile } from './downloader.js';

const logger = createLogger('Renderer');

/**
 * 输入类型枚举
 */
export const InputType = {
    FILE: 'file',
    URL: 'url',
    BUFFER: 'buffer',
};

/**
 * 流式渲染阈值（小于此值使用下载模式）
 */
const STREAM_THRESHOLD = 2 * 1024 * 1024; // 2MB

/**
 * 检测输入类型
 * 
 * @param {string|Buffer} input - 输入
 * @returns {string} 输入类型
 */
export function detectInputType(input) {
    if (Buffer.isBuffer(input)) {
        return InputType.BUFFER;
    }
    if (typeof input === 'string') {
        if (input.startsWith('http://') || input.startsWith('https://')) {
            return InputType.URL;
        }
        return InputType.FILE;
    }
    throw new Error('Invalid input: must be a file path, URL, or Buffer');
}

/**
 * 获取当前使用的渲染器类型
 * 
 * @param {Object} options - 选项
 * @returns {string} 渲染器类型
 */
export function getRendererType(options = {}) {
    const renderer = options.renderer || DEFAULT_RENDERER;
    
    // 验证渲染器类型
    if (renderer === RendererType.PDFJS) {
        return RendererType.PDFJS;
    }
    
    // 默认使用 pdfium，如果不可用则回退到 pdfjs
    if (!nativeRenderer.isNativeAvailable()) {
        logger.warn('PDFium 渲染器不可用，回退到 PDF.js');
        return RendererType.PDFJS;
    }
    
    return RendererType.PDFIUM;
}

/**
 * 使用指定渲染器渲染 PDF 页面
 * 
 * @param {string|Buffer} input - 输入
 * @param {string} inputType - 输入类型
 * @param {number[]} pages - 页码数组
 * @param {Object} options - 选项
 * @returns {Promise<Object>} 渲染结果
 */
export async function renderPages(input, inputType, pages, options) {
    const startTime = Date.now();
    const rendererType = getRendererType(options);
    
    logger.debug(`Using renderer: ${rendererType}`);
    
    if (rendererType === RendererType.PDFJS) {
        return renderPagesWithPdfjs(input, inputType, pages, options, startTime);
    }
    
    // 使用 pdfium 渲染器
    if (inputType === InputType.URL) {
        return renderPagesFromUrl(input, pages, options, startTime);
    }
    
    return renderPagesFromLocal(input, inputType, pages, options, startTime);
}

/**
 * 使用 PDF.js 渲染器渲染 PDF 页面
 */
async function renderPagesWithPdfjs(input, inputType, pages, options, startTime) {
    let result;
    
    if (inputType === InputType.URL) {
        result = await pdfjsRenderer.renderFromUrl(input, pages, options);
    } else if (inputType === InputType.BUFFER) {
        result = await pdfjsRenderer.renderFromBuffer(input, pages, options);
    } else {
        result = await pdfjsRenderer.renderFromFile(input, pages, options);
    }
    
    if (!result.success) {
        throw new Error(result.error || 'PDF.js 渲染失败');
    }
    
    return {
        success: true,
        numPages: result.numPages,
        pages: result.pages,
        totalTime: Date.now() - startTime,
        renderTime: result.renderTime || result.pages.reduce((sum, p) => sum + (p.renderTime || 0), 0),
        encodeTime: result.pages.reduce((sum, p) => sum + (p.encodeTime || 0), 0),
        renderer: RendererType.PDFJS,
        streamStats: result.streamStats,
    };
}

/**
 * 从 URL 渲染 PDF 页面（流式）
 * 
 * 使用 HTTP Range 请求按需获取数据，避免完整下载
 */
async function renderPagesFromUrl(url, pages, options, startTime) {
    // 获取文件大小
    const fileSize = await getRemoteFileSize(url);
    
    // 小文件直接下载后渲染，避免多次 Range 请求开销
    if (fileSize < STREAM_THRESHOLD) {
        logger.debug(`Remote file size: ${(fileSize / 1024 / 1024).toFixed(2)}MB (< 2MB), using download mode`);
        return renderPagesWithDownload(url, pages, options, startTime);
    }

    logger.debug(`Remote file size: ${(fileSize / 1024 / 1024).toFixed(2)}MB, using stream rendering`);

    try {
        // 使用流式渲染
        const result = await nativeRenderer.renderFromStream(url, fileSize, pages, options);

        return {
            success: true,
            numPages: result.numPages,
            pages: result.pages,
            totalTime: Date.now() - startTime,
            renderTime: result.pages.reduce((sum, p) => sum + (p.renderTime || 0), 0),
            encodeTime: result.pages.reduce((sum, p) => sum + (p.encodeTime || 0), 0),
            streamStats: result.streamStats,
            renderer: RendererType.PDFIUM,
        };
    } catch (err) {
        // 流式渲染失败，回退到下载后渲染
        logger.warn(`Stream rendering failed: ${err.message}, falling back to download`);
        return renderPagesWithDownload(url, pages, options, startTime);
    }
}

/**
 * 下载后渲染（回退方案）
 */
async function renderPagesWithDownload(url, pages, options, startTime) {
    const tempFile = await downloadToTempFile(url);
    const threadCount = getThreadCount();
    
    try {
        const numPages = nativeRenderer.getPageCountFromFile(tempFile);
        
        // 确定目标页码
        let targetPages;
        if (pages.length === 0) {
            targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
        } else {
            targetPages = pages.filter(p => p >= 1 && p <= numPages);
        }

        logger.debug(`Rendering ${targetPages.length} pages using thread pool (${threadCount} workers)`);

        const pool = getThreadPool();
        
        const tasks = targetPages.map(pageNum => {
            return pool.run({
                pageNum,
                options,
                filePath: tempFile,
            });
        });

        const results = await Promise.all(tasks);
        results.sort((a, b) => a.pageNum - b.pageNum);

        return {
            success: true,
            numPages,
            pages: results,
            totalTime: Date.now() - startTime,
            renderTime: results.reduce((sum, p) => sum + (p.renderTime || 0), 0),
            encodeTime: results.reduce((sum, p) => sum + (p.encodeTime || 0), 0),
            renderer: RendererType.PDFIUM,
        };
    } finally {
        try {
            await fs.promises.unlink(tempFile);
        } catch {}
    }
}

/**
 * 从本地文件或 Buffer 渲染 PDF 页面
 */
async function renderPagesFromLocal(input, inputType, pages, options, startTime) {
    let filePath = null;
    let pdfBuffer = null;
    let numPages;
    const threadCount = getThreadCount();

    // 准备输入
    if (inputType === InputType.FILE) {
        try {
            await fs.promises.access(input, fs.constants.R_OK);
        } catch {
            throw new Error(`File not found or not readable: ${input}`);
        }
        filePath = input;
        numPages = nativeRenderer.getPageCountFromFile(filePath);
    } else if (inputType === InputType.BUFFER) {
        pdfBuffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
        numPages = nativeRenderer.getPageCount(pdfBuffer);
    }

    // 确定目标页码
    let targetPages;
    if (pages.length === 0) {
        targetPages = Array.from({ length: numPages }, (_, i) => i + 1);
    } else {
        targetPages = pages.filter(p => p >= 1 && p <= numPages);
    }

    logger.debug(`Rendering ${targetPages.length} pages using thread pool (${threadCount} workers)`);

    // 获取线程池
    const pool = getThreadPool();

    // 为每一页创建任务并提交到线程池
    const tasks = targetPages.map(pageNum => {
        const task = {
            pageNum,
            options,
        };
        
        if (filePath) {
            task.filePath = filePath;
        } else if (pdfBuffer) {
            // 注意：Buffer 会被序列化传递给工作线程
            // 对于大文件，建议先保存到临时文件再传递路径
            task.pdfBuffer = pdfBuffer;
        }
        
        // 提交任务到线程池
        return pool.run(task);
    });

    // 等待所有页面的并行处理完成
    const results = await Promise.all(tasks);

    results.sort((a, b) => a.pageNum - b.pageNum);

    return {
        success: true,
        numPages,
        pages: results,
        totalTime: Date.now() - startTime,
        renderTime: results.reduce((sum, p) => sum + (p.renderTime || 0), 0),
        encodeTime: results.reduce((sum, p) => sum + (p.encodeTime || 0), 0),
        renderer: RendererType.PDFIUM,
    };
}
