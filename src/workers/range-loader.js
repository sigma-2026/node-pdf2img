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

// 小文件阈值：小于此值直接全量下载
const SMALL_FILE_THRESHOLD = parseInt(process.env.SMALL_FILE_THRESHOLD) || 2 * 1024 * 1024; // 2MB

// 探测请求大小：用于获取文件大小，同时作为大文件的 initialData
const PROBE_SIZE = parseInt(process.env.PROBE_SIZE) || 20 * 1024 - 1; // 20KB - 1（Range 是闭区间）

/**
 * 智能获取 PDF 文件（根据文件大小选择最优策略）
 * 
 * 优化策略：
 * 1. 发送一个小的 Range 请求（20KB），从 Content-Range 获取文件总大小
 * 2. 如果文件 <= 2MB（小文件），直接全量下载
 * 3. 如果文件 > 2MB（大文件），这 20KB 数据作为 initialData 给 RangeLoader
 * 
 * 这样：
 * - 小文件：20KB Range + 全量下载 = 2 次请求，第一次开销很小
 * - 大文件：20KB Range（作为 initialData）+ 后续分片 = 比 HEAD + Range 少 1 次请求
 * 
 * @param {string} pdfUrl - PDF 文件 URL
 * @returns {Promise<{pdfSize: number, initialData: ArrayBuffer, fullData: ArrayBuffer|null, isSmallFile: boolean}>}
 */
export async function getPdfInfo(pdfUrl, retries = RANGE_MAX_RETRIES) {
    try {
        // 1. 发送小的 Range 请求探测文件大小
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
        
        // 从 Content-Range 获取文件总大小
        // 格式: "bytes 0-20479/1234567"
        const contentRange = probeResponse.headers.get('Content-Range');
        let pdfSize = 0;
        
        if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) {
                pdfSize = parseInt(match[1], 10);
            }
        }
        
        // 如果没有 Content-Range（服务器返回了完整文件），从 Content-Length 获取
        if (!pdfSize) {
            pdfSize = parseInt(probeResponse.headers.get('Content-Length') || '0', 10);
        }
        
        if (!pdfSize) {
            throw new Error('无法获取文件大小，服务器可能不支持 Range 请求');
        }
        
        const probeData = await probeResponse.arrayBuffer();
        
        // 2. 根据文件大小选择策略
        const isSmallFile = pdfSize <= SMALL_FILE_THRESHOLD;
        
        // 检查探测数据是否已包含完整文件
        const isComplete = probeData.byteLength >= pdfSize;
        
        if (isComplete) {
            // 文件 <= 20KB，探测请求已包含完整文件
            return {
                pdfSize,
                initialData: probeData,
                fullData: probeData,
                isSmallFile: true,
            };
        } else if (isSmallFile) {
            // 小文件（20KB < size <= 2MB）：下载完整文件
            const fullData = await downloadFullPdf(pdfUrl);
            return {
                pdfSize,
                initialData: probeData,  // 保留探测数据（虽然不会用到）
                fullData,
                isSmallFile: true,
            };
        } else {
            // 大文件：探测数据作为 initialData
            return {
                pdfSize,
                initialData: probeData,
                fullData: null,
                isSmallFile: false,
            };
        }
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

/**
 * 下载完整 PDF 文件（用于小文件优化）
 * 
 * @param {string} pdfUrl - PDF 文件 URL
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadFullPdf(pdfUrl, retries = RANGE_MAX_RETRIES) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RANGE_TIMEOUT);
        
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
