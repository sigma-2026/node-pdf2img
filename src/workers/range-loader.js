/**
 * Range Loader - PDF 分片加载器
 * 
 * 实现 PDFDataRangeTransport 接口，支持按需加载 PDF 数据
 * 只下载 PDF.js 实际需要的数据范围，而非整个文件
 */

import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

// ==================== 配置 ====================

const RANGE_CHUNK_SIZE = parseInt(process.env.RANGE_CHUNK_SIZE) || 2 * 1024 * 1024; // 2MB
const RANGE_CONCURRENCY = parseInt(process.env.RANGE_CONCURRENCY) || 4;
const RANGE_TIMEOUT = parseInt(process.env.RANGE_TIMEOUT) || 30000; // 30s
const RANGE_MAX_RETRIES = parseInt(process.env.RANGE_MAX_RETRIES) || 3;
const RANGE_RETRY_DELAY = parseInt(process.env.RANGE_RETRY_DELAY) || 500; // ms

// 导出配置供外部使用
export const RANGE_CONFIG = {
    CHUNK_SIZE: RANGE_CHUNK_SIZE,
    CONCURRENCY: RANGE_CONCURRENCY,
    TIMEOUT: RANGE_TIMEOUT,
    MAX_RETRIES: RANGE_MAX_RETRIES,
    RETRY_DELAY: RANGE_RETRY_DELAY,
};

// ==================== RangeLoader 类 ====================

/**
 * PDF 分片加载器
 * 
 * 继承 PDFDataRangeTransport，实现按需加载：
 * - PDF.js 通过 requestDataRange 请求数据
 * - 加载器拆分成多个小请求并行下载
 * - 支持并发控制和超时处理
 */
export class RangeLoader extends PDFDataRangeTransport {
    /**
     * @param {number} length - PDF 文件总大小
     * @param {ArrayBuffer} initialData - 初始数据（64KB）
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
        
        // 并发控制
        this.inflight = 0;
        this.queue = [];
        
        // 统计信息
        this.stats = {
            totalRequests: 0,
            totalBytes: 0,
            requestTimes: [],
        };
    }

    /**
     * 并发控制：限制同时进行的请求数
     * @private
     */
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

    /**
     * PDF.js 调用此方法请求数据范围
     * @param {number} start - 起始字节
     * @param {number} end - 结束字节（不包含）
     */
    async requestDataRange(start, end) {
        const realEnd = end - 1;
        
        // 拆分成多个小请求
        const groups = this.splitIntoChunks(start, realEnd, this.chunkSize);
        
        const startTime = Date.now();
        const datas = await Promise.all(
            groups.map(([chunkStart, chunkEnd]) => {
                return this.runWithLimit(() => this.fetchRange(chunkStart, chunkEnd));
            })
        );
        
        // 合并数据
        const byteLength = datas.reduce((total, data) => total + data.byteLength, 0);
        const byteData = new Uint8Array(byteLength);
        let offset = 0;
        for (const data of datas) {
            byteData.set(new Uint8Array(data), offset);
            offset += data.byteLength;
        }
        
        this.stats.requestTimes.push(Date.now() - startTime);
        
        // 通知 PDF.js 数据已就绪
        this.onDataProgress(byteData.byteLength, this.pdfSize);
        this.onDataRange(start, byteData);
    }

    /**
     * 将大范围拆分成多个小块
     * @private
     */
    splitIntoChunks(start, end, chunkSize) {
        const count = Math.ceil((end - start) / chunkSize);
        return new Array(count).fill(0).map((_, index) => {
            const chunkStart = index * chunkSize + start;
            const chunkEnd = Math.min(chunkStart + chunkSize - 1, end);
            return [chunkStart, chunkEnd];
        });
    }

    /**
     * 执行单个 Range 请求（带重试）
     * @private
     */
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
            
            // 判断是否可重试的错误
            const isRetryable = error.name === 'AbortError' || 
                error.cause?.code === 'ECONNRESET' ||
                error.cause?.code === 'ECONNREFUSED' ||
                error.cause?.code === 'UND_ERR_SOCKET' ||
                error.message?.includes('fetch failed');
            
            if (isRetryable && retries > 0) {
                // 指数退避重试
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

    /**
     * 获取加载统计信息
     */
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

// ==================== 工具函数 ====================

/**
 * 获取 PDF 文件信息（大小和初始数据）
 * 
 * 优化：单次 Range 请求同时获取文件大小和初始数据
 * - 请求前 256KB 数据（覆盖大部分 PDF 的元数据区域）
 * - 从 Content-Range 响应头获取文件总大小
 * - 减少一次 HTTP 请求
 * - 支持重试机制
 * 
 * 优化说明：
 * - 从 64KB 增大到 256KB，可有效覆盖复杂 PDF 的文件头和 xref 表
 * - 避免 pdf.js 解析初始数据后立即发起第二次分片请求
 * - 对现代网络几乎无感，但可减少几十到上百毫秒的延迟
 * 
 * @param {string} pdfUrl - PDF 文件 URL
 * @returns {Promise<{pdfSize: number, initialData: ArrayBuffer}>}
 */
export async function getPdfInfo(pdfUrl, retries = RANGE_MAX_RETRIES) {
    // 单次 Range 请求：获取前 256KB + 文件总大小
    // 优化：从 64KB 增大到 256KB，覆盖更多元数据
    const INITIAL_SIZE = parseInt(process.env.INITIAL_DATA_SIZE) || 262143; // 256KB - 1（Range 是闭区间）
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RANGE_TIMEOUT);
        
        const response = await fetch(pdfUrl, {
            headers: { Range: `bytes=0-${INITIAL_SIZE}` },
            signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok && response.status !== 206) {
            throw new Error(`获取文件信息失败: ${response.status}`);
        }
        
        // 从 Content-Range 获取文件总大小
        // 格式: "bytes 0-65535/1234567"
        const contentRange = response.headers.get('Content-Range');
        let pdfSize = 0;
        
        if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) {
                pdfSize = parseInt(match[1], 10);
            }
        }
        
        // 如果没有 Content-Range（服务器不支持 Range），尝试从 Content-Length 获取
        if (!pdfSize) {
            pdfSize = parseInt(response.headers.get('Content-Length') || '0', 10);
        }
        
        if (!pdfSize) {
            throw new Error('无法获取文件大小，服务器可能不支持 Range 请求');
        }
        
        const initialData = await response.arrayBuffer();
        
        return { pdfSize, initialData };
    } catch (error) {
        // 判断是否可重试的错误
        const isRetryable = error.name === 'AbortError' || 
            error.cause?.code === 'ECONNRESET' ||
            error.cause?.code === 'ECONNREFUSED' ||
            error.cause?.code === 'UND_ERR_SOCKET' ||
            error.message?.includes('fetch failed');
        
        if (isRetryable && retries > 0) {
            // 指数退避重试
            const delay = RANGE_RETRY_DELAY * (RANGE_MAX_RETRIES - retries + 1);
            await new Promise(resolve => setTimeout(resolve, delay));
            return getPdfInfo(pdfUrl, retries - 1);
        }
        
        throw error;
    }
}
