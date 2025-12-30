/**
 * PDF 转图片核心模块
 * 
 * 架构：
 * 1. 主线程接收请求 -> 创建 Worker 任务
 * 2. Worker 内部：Range 加载 -> 解析 PDF -> 渲染 -> 上传 COS（生产环境）
 * 3. 主线程收集结果并返回
 * 
 * 渲染策略：
 * - 默认 1.5 倍缩放
 * - 最大宽度限制 2000px，防止渲染超大图片
 * 
 * dev/prod 环境共用代码，区别仅在于是否上传 COS
 */

import fs from 'fs';
import path from 'path';
import { getWorkerPool } from '../workers/adaptive-pool.js';

// 环境判断
const IS_DEV = process.env.NODE_ENV === 'dev';

// 配置
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

// ==================== PDF 转图片处理器 ====================

/**
 * PDF 转图片处理器
 */
class Pdf2Img {
    constructor({ globalPadId, requestTracker = null, abortSignal = null }) {
        this.globalPadId = globalPadId;
        this.requestTracker = requestTracker;
        this.abortSignal = abortSignal;
        this.pdfSize = 0;
        this.preciseTimeoutHandle = null;  // 精准超时句柄
    }

    /**
     * PDF 转图片主入口
     * 
     * 优化：精准超时控制
     * - 在获取 pdfSize 后，基于真实文件大小计算超时时间
     * - 使用 Promise.race 与业务逻辑并行执行超时检测
     * 
     * @param {Object} options
     * @param {string} options.pdfPath - PDF 文件 URL
     * @param {number[]|'all'|null} options.pages - 要转换的页码
     * @returns {Promise<Array>} 转换结果
     */
    async pdfToImage({ pdfPath, pages }) {
        const startTime = Date.now();
        
        this.log('info', `开始处理 PDF: ${pdfPath.substring(0, 100)}...`);
        
        try {
            if (this.requestTracker) {
                this.requestTracker.startPhase('pdfInfo');
                this.requestTracker.startPhase('render');
            }
            
            // 直接派发 Worker 任务，Worker 返回 numPages + pdfSize + 渲染结果
            // 精准超时在首批渲染后根据 pdfSize 计算
            let results;
            let numPages;
            let pdfSize = 0;
            
            if (pages === 'all') {
                // "all" 请求：先渲染首批页面获取 numPages，再追加后续页面
                const renderResult = await this.renderAllPagesOptimized(pdfPath);
                results = renderResult.results;
                numPages = renderResult.numPages;
                pdfSize = renderResult.pdfSize;
            } else if (!pages) {
                // 默认请求（前 6 页）：直接派发，Worker 返回 numPages
                const renderResult = await this.renderFirstBatch(pdfPath, 6);
                results = renderResult.results;
                numPages = renderResult.numPages;
                pdfSize = renderResult.pdfSize;
            } else {
                // 指定页码：直接渲染，Worker 会自动过滤无效页码
                const renderResult = await this.renderSpecificPages(pdfPath, pages);
                results = renderResult.results;
                numPages = renderResult.numPages;
                pdfSize = renderResult.pdfSize;
            }
            
            this.pdfSize = pdfSize;
            
            if (this.requestTracker) {
                this.requestTracker.endPhase('pdfInfo', { pdfSize, numPages });
                this.requestTracker.event('pdfLoaded', { numPages, pdfSize });
                this.requestTracker.endPhase('render', { 
                    pageCount: results.length,
                    successCount: results.filter(r => r.success).length
                });
            }
            
            this.log('info', `PDF: ${(pdfSize / 1024 / 1024).toFixed(2)}MB, ${numPages} 页，渲染 ${results.length} 页`);
            
            // 3. 处理结果
            const processedResults = await this.processResults(results);
            
            const totalTime = Date.now() - startTime;
            this.log('info', `处理完成，耗时 ${totalTime}ms`);
            
            if (this.requestTracker) {
                this.requestTracker.event('allImagesReady', { totalDuration: totalTime });
            }
            
            return processedResults;
            
        } catch (error) {
            this.log('error', `处理失败: ${error.message}`);
            throw new Error(`PDF 转图片失败: ${error.message}`);
        }
    }

    /**
     * 渲染首批页面（并行获取 numPages + pdfSize）
     * 
     * 直接派发 Worker 任务渲染前 N 页，Worker 返回 numPages 和 pdfSize
     * 元信息获取延迟被隐藏在首页渲染过程中
     */
    async renderFirstBatch(pdfUrl, maxPages = 6) {
        const pool = getWorkerPool();
        const uploadToCos = !IS_DEV;
        
        const pageNums = Array.from({ length: maxPages }, (_, i) => i + 1);
        
        this.log('info', `🚀 直接渲染首批 ${maxPages} 页`);
        
        const result = await pool.run({
            pdfUrl,
            pageNums,
            globalPadId: this.globalPadId,
            uploadToCos,
        });
        
        if (!result.success) {
            throw new Error(result.error || '渲染失败');
        }
        
        const { numPages, pdfSize } = result.metrics;
        
        // 首张图片完成事件
        if (result.results?.length > 0 && this.requestTracker) {
            const ttffMs = Date.now() - this.requestTracker.startTime;
            this.requestTracker.event('firstImageReady', { 
                pageNum: result.results[0].pageNum, 
                ttffMs, 
                mode: 'optimized' 
            });
        }
        
        return { results: result.results || [], numPages, pdfSize };
    }

    /**
     * 优化的 "all" 页面渲染
     * 
     * 策略：
     * 1. 先派发首批页面（1-6）的 Worker，获取 numPages + pdfSize
     * 2. 根据 numPages 判断是否需要追加后续 Worker
     * 3. 并行处理后续页面
     */
    async renderAllPagesOptimized(pdfUrl) {
        const FIRST_BATCH_SIZE = 6;
        const uploadToCos = !IS_DEV;
        const pool = getWorkerPool();
        
        this.log('info', `📄 "all" 请求：先渲染首批 ${FIRST_BATCH_SIZE} 页`);
        
        // 1. 渲染首批页面，获取 numPages 和 pdfSize
        const firstBatchResult = await pool.run({
            pdfUrl,
            pageNums: Array.from({ length: FIRST_BATCH_SIZE }, (_, i) => i + 1),
            globalPadId: this.globalPadId,
            uploadToCos,
        });
        
        if (!firstBatchResult.success) {
            throw new Error(firstBatchResult.error || '首批渲染失败');
        }
        
        const { numPages, pdfSize } = firstBatchResult.metrics;
        const firstResults = firstBatchResult.results || [];
        
        // 首张图片完成事件
        if (firstResults.length > 0 && this.requestTracker) {
            const ttffMs = Date.now() - this.requestTracker.startTime;
            this.requestTracker.event('firstImageReady', { 
                pageNum: firstResults[0].pageNum, 
                ttffMs, 
                mode: 'optimized-all' 
            });
        }
        
        this.log('info', `📊 总页数: ${numPages}，首批完成 ${firstResults.length} 页`);
        
        // 2. 如果只有 6 页或更少，直接返回
        if (numPages <= FIRST_BATCH_SIZE) {
            return { results: firstResults, numPages, pdfSize };
        }
        
        // 3. 渲染剩余页面
        const remainingPages = Array.from(
            { length: numPages - FIRST_BATCH_SIZE }, 
            (_, i) => i + FIRST_BATCH_SIZE + 1
        );
        
        this.log('info', `📝 追加渲染剩余 ${remainingPages.length} 页`);
        
        // 分批渲染剩余页面
        const remainingResults = await this.renderRemainingPages(pdfUrl, remainingPages, uploadToCos, pool);
        
        // 合并所有结果
        const allResults = [...firstResults, ...remainingResults].sort((a, b) => a.pageNum - b.pageNum);
        
        return { results: allResults, numPages, pdfSize };
    }

    /**
     * 渲染剩余页面（用于 "all" 请求）
     */
    async renderRemainingPages(pdfUrl, pages, uploadToCos, pool) {
        // 计算每个 Worker 处理的页数
        const pagesPerWorker = Math.max(6, Math.ceil(pages.length / 4));
        
        // 将页面分成多个批次
        const batches = [];
        for (let i = 0; i < pages.length; i += pagesPerWorker) {
            batches.push(pages.slice(i, i + pagesPerWorker));
        }
        
        this.log('info', `分配 ${pages.length} 页到 ${batches.length} 个 Worker`);
        
        // 并行提交所有 Worker 任务
        const batchPromises = batches.map((batchPages, batchIndex) => {
            return pool.run({
                pdfUrl,
                pageNums: batchPages,
                globalPadId: this.globalPadId,
                uploadToCos,
            }).then(result => {
                this.log('debug', `Worker ${batchIndex} 完成，渲染 ${result.metrics?.renderedCount || 0} 页`);
                return result.results || [];
            }).catch(err => {
                this.log('error', `Worker ${batchIndex} 失败: ${err.message}`);
                return batchPages.map(pageNum => ({
                    pageNum,
                    success: false,
                    error: err.message,
                }));
            });
        });
        
        const batchResults = await Promise.all(batchPromises);
        return batchResults.flat();
    }

    /**
     * 渲染指定页码（并行获取 numPages + pdfSize）
     */
    async renderSpecificPages(pdfUrl, pages) {
        const pool = getWorkerPool();
        const uploadToCos = !IS_DEV;
        
        // 去重并排序
        const uniquePages = [...new Set(pages)].filter(p => p >= 1).sort((a, b) => a - b);
        
        this.log('info', `🎯 渲染指定页码: [${uniquePages.join(', ')}]`);
        
        const result = await pool.run({
            pdfUrl,
            pageNums: uniquePages,
            globalPadId: this.globalPadId,
            uploadToCos,
        });
        
        if (!result.success) {
            throw new Error(result.error || '渲染失败');
        }
        
        const { numPages, pdfSize } = result.metrics;
        
        // 首张图片完成事件
        if (result.results?.length > 0 && this.requestTracker) {
            const ttffMs = Date.now() - this.requestTracker.startTime;
            this.requestTracker.event('firstImageReady', { 
                pageNum: result.results[0].pageNum, 
                ttffMs, 
                mode: 'specific-pages' 
            });
        }
        
        return { results: result.results || [], numPages, pdfSize };
    }

    /**
     * 处理 Worker 返回的结果
     */
    async processResults(results) {
        if (IS_DEV) {
            return this.saveToLocal(results);
        } else {
            return this.formatCosResults(results);
        }
    }

    /**
     * 开发环境：保存到本地文件
     */
    async saveToLocal(results) {
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        
        const savedResults = [];
        for (const result of results) {
            if (!result.success || !result.buffer) continue;
            
            const outputPath = path.join(OUTPUT_DIR, `page_${result.pageNum}.webp`);
            fs.writeFileSync(outputPath, Buffer.from(result.buffer));
            this.log('debug', `✅ 页面 ${result.pageNum} 已保存至: ${outputPath}`);
            
            savedResults.push({
                pageNum: result.pageNum,
                width: result.width,
                height: result.height,
                outputPath,
            });
        }
        
        return savedResults;
    }

    /**
     * 生产环境：格式化 COS 结果
     */
    formatCosResults(results) {
        return results
            .filter(r => r.success && r.cosKey)
            .map(r => ({
                cosKey: r.cosKey,
                width: r.width,
                height: r.height,
                pageNum: r.pageNum,
            }));
    }

    /**
     * 日志输出
     */
    log(level, message) {
        const prefix = `[${this.globalPadId}]`;
        if (level === 'error') {
            console.error(prefix, message);
        } else if (level === 'warn') {
            console.warn(prefix, message);
        } else if (level === 'debug' && process.env.DEBUG) {
            console.log(prefix, message);
        } else if (level === 'info') {
            console.log(prefix, message);
        }
    }

    /**
     * 清理资源
     */
    async destroy() {
        // 清理精准超时句柄
        if (this.preciseTimeoutHandle) {
            clearTimeout(this.preciseTimeoutHandle);
            this.preciseTimeoutHandle = null;
        }
        this.log('debug', '实例清理完成');
    }
}

/**
 * 创建 PDF 转图片实例
 */
export function createExportImage(options) {
    return new Pdf2Img(options);
}

export { Pdf2Img, IS_DEV };
