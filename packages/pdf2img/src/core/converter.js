/**
 * PDF2IMG 核心转换器
 *
 * 提供统一的 API 用于 PDF 转图片
 * 
 * 架构：主线程协调 + 工作线程池处理
 * - 主线程：负责 I/O、任务分发、结果收集
 * - 工作线程池：负责 CPU 密集型任务（PDFium 渲染 + Sharp 编码）
 * 
 * 性能优化：
 * - 使用 piscina 线程池，充分利用多核 CPU
 * - 异步文件 I/O，不阻塞事件循环
 * - 原生模块直接读取文件路径，避免 Node.js 堆内存占用
 * - 流式下载，减少内存峰值
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import Piscina from 'piscina';
import { createLogger } from '../utils/logger.js';
import { RENDER_CONFIG, TIMEOUT_CONFIG, SUPPORTED_FORMATS, getExtension, getMimeType } from './config.js';
import * as nativeRenderer from '../renderers/native.js';

const logger = createLogger('Converter');

// ==================== 线程池初始化 ====================

// 获取 worker.js 的路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, '../worker.js');

// 创建全局线程池实例
// 线程数默认为 CPU 核心数，可通过环境变量调整
const threadCount = parseInt(process.env.PDF2IMG_THREAD_COUNT, 10) || os.cpus().length;

let piscina = null;

/**
 * 获取或创建线程池实例（懒加载）
 */
function getThreadPool() {
    if (!piscina) {
        piscina = new Piscina({
            filename: workerPath,
            maxThreads: threadCount,
            idleTimeout: 30000, // 空闲 30 秒后销毁线程
        });
        logger.info(`Thread pool initialized with ${threadCount} workers`);
    }
    return piscina;
}

/**
 * 默认并发限制
 */
const DEFAULT_CONCURRENCY = {
    FILE_IO: 10,      // 文件写入并发数
    COS_UPLOAD: 8,    // COS 上传并发数
};

/**
 * 输入类型枚举
 */
export const InputType = {
    FILE: 'file',
    URL: 'url',
    BUFFER: 'buffer',
};

/**
 * 输出类型枚举
 */
export const OutputType = {
    FILE: 'file',      // 保存到本地文件
    BUFFER: 'buffer',  // 返回 Buffer 数组
    COS: 'cos',        // 上传到腾讯云 COS
};

/**
 * 检测输入类型
 */
function detectInputType(input) {
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
 * 从 URL 获取文件大小
 */
async function getRemoteFileSize(url) {
    const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(TIMEOUT_CONFIG.DOWNLOAD_TIMEOUT),
    });

    if (!response.ok) {
        throw new Error(`Failed to get file size: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
        throw new Error('Server did not return Content-Length header');
    }

    return parseInt(contentLength, 10);
}

/**
 * 流式下载远程文件到临时文件
 */
async function downloadToTempFile(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_CONFIG.DOWNLOAD_TIMEOUT),
    });

    if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }

    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `pdf2img_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    
    const fileStream = fs.createWriteStream(tempFile);
    
    try {
        await pipeline(response.body, fileStream);
        return tempFile;
    } catch (err) {
        try {
            await fs.promises.unlink(tempFile);
        } catch {}
        throw err;
    }
}

/**
 * 保存单个页面到文件
 */
async function savePageToFile(page, outputDir, prefix, ext) {
    if (!page.success || !page.buffer) {
        return { ...page, outputPath: null };
    }

    try {
        const filename = `${prefix}_${page.pageNum}.${ext}`;
        const outputPath = path.join(outputDir, filename);
        await fs.promises.writeFile(outputPath, page.buffer);

        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: true,
            outputPath,
            size: page.buffer.length,
        };
    } catch (err) {
        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: false,
            error: `File save failed: ${err.message}`,
            outputPath: null,
        };
    }
}

/**
 * 保存渲染结果到文件
 */
async function saveToFiles(pages, outputDir, prefix = 'page', format = 'webp', concurrency = DEFAULT_CONCURRENCY.FILE_IO) {
    await fs.promises.mkdir(outputDir, { recursive: true });

    const ext = getExtension(format);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
        pages.map(page => limit(() => savePageToFile(page, outputDir, prefix, ext)))
    );

    return results.sort((a, b) => a.pageNum - b.pageNum);
}

/**
 * 上传单个页面到 COS
 */
async function uploadPageToCos(page, cos, cosConfig, keyPrefix, ext, mimeType) {
    if (!page.success || !page.buffer) {
        return { ...page, cosKey: null };
    }

    try {
        const key = `${keyPrefix}/page_${page.pageNum}.${ext}`;

        await new Promise((resolve, reject) => {
            cos.putObject({
                Bucket: cosConfig.bucket,
                Region: cosConfig.region,
                Key: key,
                Body: page.buffer,
                ContentType: mimeType,
            }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: true,
            cosKey: key,
            size: page.buffer.length,
        };
    } catch (err) {
        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: false,
            error: `Upload failed: ${err.message}`,
            cosKey: null,
        };
    }
}

/**
 * 上传渲染结果到 COS
 */
async function uploadToCos(pages, cosConfig, keyPrefix, format = 'webp', concurrency = DEFAULT_CONCURRENCY.COS_UPLOAD) {
    const COS = (await import('cos-nodejs-sdk-v5')).default;

    const cos = new COS({
        SecretId: cosConfig.secretId,
        SecretKey: cosConfig.secretKey,
    });

    const ext = getExtension(format);
    const mimeType = getMimeType(format);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
        pages.map(page => limit(() => uploadPageToCos(page, cos, cosConfig, keyPrefix, ext, mimeType)))
    );

    return results.sort((a, b) => a.pageNum - b.pageNum);
}

/**
 * 使用线程池渲染 PDF 页面
 * 
 * 主线程负责协调，工作线程负责 CPU 密集型任务
 * 
 * @param {string|Buffer} input - 输入
 * @param {string} inputType - 输入类型
 * @param {number[]} pages - 页码数组
 * @param {Object} options - 选项
 * @returns {Promise<Object>} 渲染结果
 */
async function renderPages(input, inputType, pages, options) {
    const startTime = Date.now();
    let filePath = null;
    let pdfBuffer = null;
    let tempFile = null;
    let numPages;

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
    } else if (inputType === InputType.URL) {
        const fileSize = await getRemoteFileSize(input);
        logger.debug(`Remote file size: ${(fileSize / 1024 / 1024).toFixed(2)}MB, downloading...`);
        tempFile = await downloadToTempFile(input);
        filePath = tempFile;
        numPages = nativeRenderer.getPageCountFromFile(filePath);
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

    try {
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
        };
    } finally {
        // 清理临时文件
        if (tempFile) {
            try {
                await fs.promises.unlink(tempFile);
            } catch {}
        }
    }
}

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

    // 检查渲染器可用性
    if (!nativeRenderer.isNativeAvailable()) {
        throw new Error('Native renderer is not available. Please ensure PDFium library is installed.');
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
    };

    // 使用线程池渲染页面
    const result = await renderPages(input, inputType, pages, encodeOptions);

    // 处理输出
    let outputResult;

    if (outputType === OutputType.FILE) {
        if (!outputDir) {
            throw new Error('outputDir is required when outputType is "file"');
        }
        outputResult = await saveToFiles(result.pages, outputDir, prefix, normalizedFormat, concurrency);

    } else if (outputType === OutputType.COS) {
        if (!cosConfig) {
            throw new Error('cos config is required when outputType is "cos"');
        }
        outputResult = await uploadToCos(result.pages, cosConfig, cosKeyPrefix, normalizedFormat, concurrency);

    } else {
        // 返回 Buffer
        outputResult = result.pages.map(page => {
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

            // 确保 buffer 是 Buffer 类型
            // Piscina 跨线程传递时 Buffer 可能被序列化为普通对象
            let buffer = page.buffer;
            if (!Buffer.isBuffer(buffer)) {
                // 尝试从序列化的对象恢复 Buffer
                try {
                    if (buffer && typeof buffer === 'object') {
                        // 可能是 { type: 'Buffer', data: [...] } 格式
                        if (buffer.type === 'Buffer' && Array.isArray(buffer.data)) {
                            buffer = Buffer.from(buffer.data);
                        } else if (buffer.data && ArrayBuffer.isView(buffer.data)) {
                            buffer = Buffer.from(buffer.data);
                        } else if (ArrayBuffer.isView(buffer)) {
                            // Uint8Array 等 TypedArray
                            buffer = Buffer.from(buffer);
                        } else {
                            // 最后尝试直接转换
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
        }).sort((a, b) => a.pageNum - b.pageNum);
    }

    return {
        success: true,
        numPages: result.numPages,
        renderedPages: outputResult.filter(p => p.success).length,
        format: normalizedFormat,
        pages: outputResult,
        timing: {
            total: Date.now() - startTime,
            render: result.renderTime,
            encode: result.encodeTime,
        },
        threadPool: {
            workers: threadCount,
        },
    };
}

/**
 * 获取 PDF 页数（异步版本）
 *
 * @param {string|Buffer} input - PDF 输入（文件路径或 Buffer）
 * @returns {Promise<number>} 页数
 */
export async function getPageCount(input) {
    if (!nativeRenderer.isNativeAvailable()) {
        throw new Error('Native renderer is not available');
    }

    if (Buffer.isBuffer(input)) {
        return nativeRenderer.getPageCount(input);
    }
    
    if (typeof input === 'string') {
        try {
            await fs.promises.access(input, fs.constants.R_OK);
        } catch {
            throw new Error(`File not found or not readable: ${input}`);
        }
        return nativeRenderer.getPageCountFromFile(input);
    }
    
    throw new Error('Invalid input: must be a file path or Buffer');
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
 */
export function isAvailable() {
    return nativeRenderer.isNativeAvailable();
}

/**
 * 获取版本信息
 */
export function getVersion() {
    return nativeRenderer.getVersion();
}

/**
 * 获取线程池统计信息
 */
export function getThreadPoolStats() {
    if (!piscina) {
        return {
            initialized: false,
            workers: threadCount,
        };
    }
    return {
        initialized: true,
        workers: threadCount,
        completed: piscina.completed,
        waitTime: piscina.waitTime,
        runTime: piscina.runTime,
        utilization: piscina.utilization,
    };
}

/**
 * 销毁线程池
 * 
 * 在应用关闭时调用，释放工作线程资源
 */
export async function destroyThreadPool() {
    if (piscina) {
        await piscina.destroy();
        piscina = null;
        logger.info('Thread pool destroyed');
    }
}
