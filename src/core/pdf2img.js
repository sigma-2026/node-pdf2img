/**
 * PDF 转图片核心模块
 * 
 * 架构（混合式智能批处理 v2 - Hybrid Smart-Batching）：
 * 1. 首批渲染与元信息获取合并，避免重复初始化
 * 2. 第一个 Worker 负责：获取元信息 + 渲染首批页面（默认前6页）
 * 3. 根据返回的 PDF 特性决定是否需要启动更多 Worker 处理剩余页面
 * 4. 每个 Worker 独立使用 RangeLoader 分片加载
 * 
 * 核心优化：
 * - 小文件（<2MB）：单 Worker 完成所有工作，只初始化 1 次
 * - 中/大文件：首批完成后，根据 PDF 大小智能分配剩余 Worker
 * - 消除了"先获取元信息，再渲染"的重复初始化问题
 * 
 * 流程示例（请求前6页）：
 * - 小文件：Worker1 渲染 [1-6] → 完成
 * - 大文件：Worker1 渲染 [1-6] → 无剩余 → 完成
 * 
 * 流程示例（pages='all'，100页 PDF）：
 * - 小文件：Worker1 渲染 [1-6] → Worker1 渲染 [7-100]
 * - 大文件：Worker1 渲染 [1-6] → Worker2-N 并行渲染 [7-100]
 * 
 * dev/prod 环境共用代码，区别仅在于是否上传 COS
 */

import fs from 'fs';
import path from 'path';
import { getWorkerPool } from '../workers/adaptive-pool.js';
import { createLogger, IS_DEV, IS_TEST } from '../utils/logger.js';

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
        this.logger = createLogger(globalPadId);
    }

    /**
     * PDF 转图片主入口（混合式智能批处理 v2）
     * 
     * 核心优化：合并元信息获取与首批渲染，避免重复初始化
     * - 第一个 Worker 负责获取元信息 + 渲染首批页面
     * - 根据返回的 PDF 特性决定是否需要启动更多 Worker
     * - 小文件：单 Worker 完成所有工作
     * - 大文件：首批完成后并行启动剩余 Worker
     * 
     * @param {Object} options
     * @param {string} options.pdfPath - PDF 文件 URL
     * @param {number[]|'all'|null} options.pages - 要转换的页码
     * @returns {Promise<Array>} 转换结果
     */
    async pdfToImage({ pdfPath, pages }) {
        const startTime = Date.now();
        this.log('info', `处理开始: ${pdfPath.substring(0, 100)}...`);

        const pool = getWorkerPool();
        const uploadToCos = !IS_DEV;

        try {
            // ========== 确定初始目标页码 ==========
            let targetPages;
            let needAllPages = false;
            
            if (pages === 'all') {
                // 需要所有页，但此时不知道总页数，先请求前6页
                targetPages = [1, 2, 3, 4, 5, 6];
                needAllPages = true;
            } else if (Array.isArray(pages)) {
                targetPages = [...new Set(pages)].filter(p => p >= 1).sort((a, b) => a - b);
            } else {
                // 默认前6页
                targetPages = [1, 2, 3, 4, 5, 6];
            }
            
            if (targetPages.length === 0) {
                return [];
            }
            
            // ========== 第一阶段：首批渲染（同时获取元信息）==========
            this.requestTracker?.startPhase('render');
            
            const firstBatchResult = await pool.run({
                pdfUrl: pdfPath,
                pageNums: targetPages,
                globalPadId: this.globalPadId,
                uploadToCos,
            });
            
            if (!firstBatchResult.success) {
                throw new Error(firstBatchResult.error || '首批渲染失败');
            }
            
            const { numPages, pdfSize } = firstBatchResult.metrics;
            this.pdfSize = pdfSize;
            this.collectWorkerMetrics(firstBatchResult.metrics);
            
            const pdfSizeMB = pdfSize / 1024 / 1024;
            this.log('info', `PDF 特性: ${pdfSizeMB.toFixed(2)}MB, ${numPages} 页`);
            
            // 首张图片事件
            if (firstBatchResult.results?.length > 0) {
                const ttffMs = Date.now() - startTime;
                this.requestTracker?.event('firstImageReady', {
                    pageNum: firstBatchResult.results[0].pageNum,
                    ttffMs,
                    mode: 'first-batch',
                });
            }
            
            // 过滤首批结果中有效的页面
            let allResults = [...(firstBatchResult.results || [])];
            const renderedPages = new Set(allResults.filter(r => r.success).map(r => r.pageNum));
            
            // ========== 第二阶段：确定剩余页码 ==========
            let remainingPages = [];
            
            if (needAllPages) {
                // pages === 'all'，需要渲染所有页
                remainingPages = Array.from({ length: numPages }, (_, i) => i + 1)
                    .filter(p => !renderedPages.has(p));
            } else if (Array.isArray(pages)) {
                // 指定页码，过滤掉已渲染的和超出范围的
                remainingPages = targetPages.filter(p => p <= numPages && !renderedPages.has(p));
            }
            // 默认前6页的情况，首批已经处理完毕，无需额外渲染
            
            // ========== 第三阶段：处理剩余页面 ==========
            if (remainingPages.length > 0) {
                this.log('info', `剩余 ${remainingPages.length} 页待渲染`);
                
                const additionalResults = await this.renderRemainingPages(
                    pdfPath, remainingPages, pool, uploadToCos, pdfSize, numPages
                );
                allResults.push(...additionalResults);
            }
            
            // 按页码排序
            allResults.sort((a, b) => a.pageNum - b.pageNum);
            
            this.requestTracker?.endPhase('render', {
                pageCount: allResults.length,
                successCount: allResults.filter(r => r.success).length,
            });

            const processedResults = await this.processResults(allResults);
            
            const totalTime = Date.now() - startTime;
            const successCount = processedResults.length;
            const totalRequested = needAllPages ? numPages : targetPages.length;
            this.log('info', `处理完成，耗时 ${totalTime}ms，成功 ${successCount}/${totalRequested} 页`);
            this.requestTracker?.event('allImagesReady', { totalDuration: totalTime });
            
            return processedResults;
            
        } catch (error) {
            this.log('error', `处理失败: ${error.message}`);
            throw new Error(`PDF 转图片失败: ${error.message}`);
        }
    }

    /**
     * 渲染剩余页面（智能分批）
     */
    async renderRemainingPages(pdfPath, remainingPages, pool, uploadToCos, pdfSize, numPages) {
        const poolStatus = pool.getStatus();
        const cpuCores = poolStatus.config.cpuCores;
        const maxThreads = poolStatus.config.maxThreads;
        const pdfSizeMB = pdfSize / 1024 / 1024;
        
        // ========== 基于 PDF 大小决定 Worker 数量 ==========
        let optimalWorkers;
        let strategyReason;
        
        if (pdfSizeMB < 2) {
            // 小文件：单 Worker（但首批已经处理了，这里是剩余页面）
            optimalWorkers = 1;
            strategyReason = '小文件(<2MB)，单Worker';
        } else if (pdfSizeMB < 10) {
            // 中等文件：适度并行
            const pagesPerWorker = 3;
            optimalWorkers = Math.min(
                Math.ceil(remainingPages.length / pagesPerWorker),
                Math.ceil(cpuCores / 2),
                remainingPages.length
            );
            optimalWorkers = Math.max(1, optimalWorkers);
            strategyReason = `中等文件(${pdfSizeMB.toFixed(1)}MB)，适度并行`;
        } else {
            // 大文件：充分并行
            optimalWorkers = Math.min(cpuCores, remainingPages.length, maxThreads);
            strategyReason = `大文件(${pdfSizeMB.toFixed(1)}MB)，充分并行`;
        }
        
        const numBatches = Math.max(1, optimalWorkers);
        
        this.log('info', `剩余页调度: ${strategyReason}`);
        this.log('info', `分配: ${remainingPages.length} 页 -> ${numBatches} 个 Worker`);
        
        // 发牌式分配
        const batches = Array.from({ length: numBatches }, () => []);
        remainingPages.forEach((pageNum, index) => {
            batches[index % numBatches].push(pageNum);
        });
        
        if (IS_DEV || IS_TEST) {
            this.log('debug', `批次详情: ${batches.map((b, i) => `W${i}:[${b.join(',')}]`).join(' ')}`);
        }
        
        // 并行执行
        const batchPromises = batches.map((batchPageNums, batchIndex) => {
            return pool.run({
                pdfUrl: pdfPath,
                pageNums: batchPageNums,
                globalPadId: this.globalPadId,
                uploadToCos,
            }).then(result => {
                this.log('debug', `剩余批次 ${batchIndex} 完成: ${result.metrics?.renderedCount || 0} 页`);
                this.collectWorkerMetrics(result.metrics);
                return result;
            }).catch(err => {
                this.log('error', `剩余批次 ${batchIndex} 失败: ${err.message}`);
                return {
                    success: false,
                    error: err.message,
                    results: batchPageNums.map(pageNum => ({
                        pageNum,
                        success: false,
                        error: err.message,
                    })),
                };
            });
        });

        const batchResults = await Promise.all(batchPromises);
        
        // 收集结果
        const results = [];
        for (const result of batchResults) {
            if (result.results?.length > 0) {
                results.push(...result.results);
            }
        }
        
        return results;
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
            this.log('debug', `页面 ${result.pageNum} 已保存至: ${outputPath}`);
            
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
     * 日志输出（使用统一日志模块）
     */
    log(level, message, data) {
        this.logger[level]?.(message, data);
    }

    /**
     * 收集 Worker 返回的指标到 requestTracker
     */
    collectWorkerMetrics(workerMetrics) {
        if (!this.requestTracker || !workerMetrics) return;
        
        // 收集分片加载指标
        if (workerMetrics.rangeStats) {
            const stats = workerMetrics.rangeStats;
            if (stats.requestCount > 0) {
                this.requestTracker.rangeLoaderMetrics = this.requestTracker.rangeLoaderMetrics || {
                    requests: 0,
                    bytes: 0,
                    times: [],
                };
                this.requestTracker.rangeLoaderMetrics.requests += stats.requestCount;
                this.requestTracker.rangeLoaderMetrics.bytes += stats.totalBytes;
                if (stats.avgRequestTime) {
                    this.requestTracker.rangeLoaderMetrics.times.push(stats.avgRequestTime);
                }
            }
        }
        
        // 收集每页渲染指标
        if (workerMetrics.pageMetrics && workerMetrics.pageMetrics.length > 0) {
            for (const page of workerMetrics.pageMetrics) {
                if (page.timing) {
                    this.requestTracker.recordPageRender(
                        page.pageNum,
                        page.timing.total,
                        page.success,
                        {
                            width: page.width,
                            height: page.height,
                            scale: page.scale,
                            getPage: page.timing.getPage,
                            render: page.timing.render,
                            encode: page.timing.encode,
                            upload: page.timing.upload,
                        }
                    );
                }
            }
        }
        
        // 记录 Worker 任务
        if (workerMetrics.renderedCount > 0) {
            this.requestTracker.recordWorkerTask(
                workerMetrics.renderedCount,
                0,
                workerMetrics.renderTime || 0,
                true
            );
        }
        
        // 测试/开发环境：输出详细 Worker 指标
        if (IS_DEV || IS_TEST) {
            this.logger.perf('Worker指标', {
                pdfSize: `${(workerMetrics.pdfSize / 1024 / 1024).toFixed(2)}MB`,
                numPages: workerMetrics.numPages,
                renderedCount: workerMetrics.renderedCount,
                timing: {
                    info: workerMetrics.infoTime,
                    parse: workerMetrics.parseTime,
                    render: workerMetrics.renderTime,
                    total: workerMetrics.totalTime,
                },
                rangeStats: workerMetrics.rangeStats,
            });
            
            if (IS_DEV && workerMetrics.pageMetrics?.length > 0) {
                this.logger.debug('每页渲染详情', workerMetrics.pageMetrics.map(p => ({
                    page: p.pageNum,
                    size: `${p.width}x${p.height}`,
                    scale: p.scale,
                    timing: p.timing,
                })));
            }
        }
    }

    /**
     * 清理资源
     */
    async destroy() {
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
