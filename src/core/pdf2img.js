/**
 * PDF 转图片核心模块 - 终极架构 V6
 * 
 * 架构（PDF.js 侦察 + PDFium 主力 + 智能决策引擎）：
 * 
 * 1. 主线程侦察阶段：
 *    - 通过 getPdfInfo() 发起一次小的 Range 请求，获取 pdfSize 和 initialData
 *    - 利用 pdf.js 和 initialData，快速解析出 numPages（几乎瞬时）
 * 
 * 2. 主线程决策阶段（V6 智能决策引擎）：
 *    - 规则 1: 单页文件规则 - 单页文件用 native 总是更快
 *    - 规则 2: 小文件规则 - 文件 <= 3MB，无条件 native
 *    - 规则 3: 大文件规则 - 文件 > 20MB，强制 pdfjs
 *    - 规则 4: 复杂页面规则 - 高 BPP (>500KB/页)，判定为复杂页面，使用 native
 *    - 规则 5: 默认 - 中型普通文档使用 pdfjs 分片加载
 * 
 * 3. 主线程准备与分发：
 *    - native 路径：下载完整 PDF Buffer，通过 Transferable Object 高效传递给 Worker
 *    - pdfjs 路径：将 pdfUrl 和 initialData 分发给 Worker，Worker 内部分片加载
 * 
 * 4. Worker 执行阶段：
 *    - 原生模式：接收 pdfData，直接调用 native-renderer
 *    - pdf.js 模式：接收 pdfUrl，执行分片加载和渲染
 * 
 * 优势：
 * - 决策快：主线程用最小成本获取全局最优决策所需信息
 * - 路径最优：扫描件、单页文件、复杂页面使用 native 渲染
 * - 安全回退：超大文件自动回退到稳定的 pdfjs 方案
 * - 职责清晰：主线程负责 I/O 和决策，Worker 负责执行
 */

import fs from 'fs';
import path from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getWorkerPool } from '../workers/adaptive-pool.js';
import { createLogger, IS_DEV, IS_TEST } from '../utils/logger.js';
import { getPdfInfo, downloadFullPdf } from '../workers/range-loader.js';
import { RENDER_CONFIG } from '../monitoring/config.js';

// 配置
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

// ==================== 智能决策函数 V6 ====================

/**
 * [V6 最终版] 智能决策函数：根据 PDF 特性选择最优渲染引擎
 * 
 * 决策规则（按优先级）：
 * 1. 单页文件规则：只要文件不超过上限，单页文件用 native 总是更快
 * 2. 小文件规则：文件 <= 阈值 (3MB)，无条件使用 native
 * 3. 大文件规则：文件 > 上限 (20MB)，强制 pdfjs（稳定性保证）
 * 4. 复杂页面规则：机会窗口内 (3-20MB)，高 BPP (>500KB/页) 判定为复杂页面，使用 native
 * 5. 默认：中型普通文档使用 pdfjs 分片加载
 * 
 * @param {number} pdfSize - PDF 文件大小（字节）
 * @param {number} numPages - PDF 页数（0 表示未知）
 * @returns {{engine: 'native'|'pdfjs', reason: string}}
 */
function chooseRendererStrategy(pdfSize, numPages) {
    const pdfSizeMB = pdfSize / 1024 / 1024;
    const maxNativeSizeMB = RENDER_CONFIG.NATIVE_RENDERER_MAX_SIZE / 1024 / 1024;
    
    // ⭐ 规则 1: 单页文件规则
    // 只要文件不大到离谱，单页文件用原生总是更快（分片加载对单页无意义）
    if (numPages === 1 && pdfSize <= RENDER_CONFIG.NATIVE_RENDERER_MAX_SIZE) {
        return { 
            engine: 'native', 
            reason: `单页文件 (${pdfSizeMB.toFixed(1)}MB)，native 渲染效率最高` 
        };
    }
    
    // 规则 2: 小文件规则 - 文件非常小，无条件使用 native
    if (pdfSize <= RENDER_CONFIG.NATIVE_RENDERER_THRESHOLD) {
        return { 
            engine: 'native', 
            reason: `文件大小 (${pdfSizeMB.toFixed(1)}MB) <= 阈值 (${(RENDER_CONFIG.NATIVE_RENDERER_THRESHOLD / 1024 / 1024).toFixed(0)}MB)` 
        };
    }
    
    // 规则 3: 大文件规则 - 文件过大，强制 pdfjs 以保证稳定
    if (pdfSize > RENDER_CONFIG.NATIVE_RENDERER_MAX_SIZE) {
        return { 
            engine: 'pdfjs', 
            reason: `文件大小 (${pdfSizeMB.toFixed(1)}MB) > 上限 (${maxNativeSizeMB.toFixed(0)}MB)，优先考虑稳定性` 
        };
    }

    // ⭐ 规则 4: 复杂页面规则（超大页面规则）
    // 在机会窗口内 (3-20MB)，根据"字节/页"比率决策
    // 高 BPP 意味着页面内容复杂（扫描件/矢量图形密集），pdf.js 会很慢
    if (numPages > 0) {
        const bytesPerPage = pdfSize / numPages;
        const complexThreshold = RENDER_CONFIG.COMPLEX_PAGE_BPP_THRESHOLD || 500 * 1024;
        
        if (bytesPerPage > complexThreshold) {
            return { 
                engine: 'native', 
                reason: `高 Bytes/Page (${(bytesPerPage / 1024).toFixed(0)}KB/页 > ${(complexThreshold / 1024).toFixed(0)}KB)，判定为复杂页面/扫描件` 
            };
        }
    }
    
    // 规则 5: 默认 - 中型普通文档使用 pdfjs 分片加载
    return { 
        engine: 'pdfjs', 
        reason: `中型普通文档 (${pdfSizeMB.toFixed(1)}MB, ${numPages}页)，使用 pdfjs 分片加载` 
    };
}

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
     * PDF 转图片主入口（终极架构 V6）
     * 
     * 流程：
     * 1. 侦察：获取 pdfSize + 用 pdf.js 快速解析 numPages
     * 2. 决策：V6 智能决策引擎选择渲染引擎
     * 3. 分发：准备数据并分发给 Worker
     * 4. 执行：Worker 执行渲染
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
            // ========== 第一阶段：侦察（主线程） ==========
            this.requestTracker?.startPhase('scout');
            
            // 1.1 获取 PDF 基本信息（一次小的 Range 请求）
            const { pdfSize, initialData, fullData, isSmallFile } = await getPdfInfo(pdfPath);
            this.pdfSize = pdfSize;
            
            // 如果是小文件且有完整数据，先复制一份供后续使用（避免 ArrayBuffer detached）
            let fullDataCopy = null;
            if (fullData) {
                fullDataCopy = fullData.slice(0);  // 复制 ArrayBuffer
            }
            
            // 1.2 用 pdf.js 快速解析页数（使用 initialData，几乎瞬时）
            let numPages = 0;
            try {
                // 使用 initialData（小文件时就是 fullData）解析页数
                const dataForParsing = fullData || initialData;
                const doc = await getDocument({ 
                    data: new Uint8Array(dataForParsing), 
                    useSystemFonts: true,
                }).promise;
                numPages = doc.numPages;
                await doc.destroy();
            } catch (e) {
                this.log('warn', `从 initialData 获取页数失败: ${e.message}，决策将仅基于文件大小`);
            }
            
            const scoutTime = Date.now() - startTime;
            this.requestTracker?.endPhase('scout', { pdfSize, numPages, scoutTime });
            
            this.log('info', `PDF 特性: ${(pdfSize / 1024 / 1024).toFixed(2)}MB, ${numPages} 页 (侦察耗时: ${scoutTime}ms)`);
            
            // ========== 第二阶段：决策（主线程） ==========
            const strategy = chooseRendererStrategy(pdfSize, numPages);
            const useNative = strategy.engine === 'native' && RENDER_CONFIG.NATIVE_RENDERER_ENABLED;
            
            this.log('info', `🚀 渲染策略: ${strategy.engine.toUpperCase()} (${strategy.reason})`);
            
            // ========== 第三阶段：准备与分发 ==========
            let result;
            
            if (useNative) {
                // ----- Native 路径 -----
                result = await this.executeNativePath(pool, pdfPath, pages, numPages, pdfSize, uploadToCos, fullDataCopy, isSmallFile);
            } else {
                // ----- PDF.js 路径 -----
                result = await this.executePdfjsPath(pool, pdfPath, pages, numPages, pdfSize, uploadToCos);
            }
            
            if (!result || !result.success) {
                throw new Error(result?.error || 'Worker 任务执行失败');
            }
            
            // ========== 第四阶段：结果处理 ==========
            this.collectWorkerMetrics(result.metrics);
            const processedResults = await this.processResults(result.results || []);
            
            const totalTime = Date.now() - startTime;
            const successCount = processedResults.length;
            this.log('info', `处理完成，耗时 ${totalTime}ms，成功 ${successCount} 页`);
            this.requestTracker?.event('allImagesReady', { totalDuration: totalTime });
            
            return processedResults;
            
        } catch (error) {
            this.log('error', `处理失败: ${error.message}`);
            throw new Error(`PDF 转图片失败: ${error.message}`);
        }
    }

    /**
     * Native 渲染路径
     * 
     * 流程：
     * 1. 下载完整 PDF（如果还没下载）
     * 2. 通过 Transferable Object 传递给 Worker
     * 3. Worker 使用 native-renderer 渲染
     */
    async executeNativePath(pool, pdfPath, pages, numPages, pdfSize, uploadToCos, fullData, isSmallFile) {
        this.requestTracker?.startPhase('download');
        
        // 如果还没有完整数据，下载完整 PDF
        let pdfBuffer;
        if (fullData) {
            pdfBuffer = Buffer.from(fullData);
            this.log('debug', `使用已下载的完整数据: ${(pdfSize / 1024 / 1024).toFixed(2)}MB`);
        } else {
            this.log('debug', `下载完整 PDF: ${(pdfSize / 1024 / 1024).toFixed(2)}MB`);
            const downloadStart = Date.now();
            const arrayBuffer = await downloadFullPdf(pdfPath);
            pdfBuffer = Buffer.from(arrayBuffer);
            this.log('debug', `下载完成，耗时: ${Date.now() - downloadStart}ms`);
        }
        
        this.requestTracker?.endPhase('download');
        
        // 确定目标页码
        let targetPages = this.determineTargetPages(pages, numPages);
        
        // 构建任务数据
        const taskData = {
            pdfData: pdfBuffer,
            pageNums: targetPages,
            globalPadId: this.globalPadId,
            uploadToCos,
            pdfSize,
            numPages,
            useNativeRenderer: true,  // 明确指示使用 native renderer
        };
        
        // 使用 Transferable Object 高效传递 Buffer
        const transferList = [taskData.pdfData.buffer];
        
        this.requestTracker?.startPhase('render');
        const result = await pool.run(taskData, { signal: this.abortSignal, transferList });
        this.requestTracker?.endPhase('render');
        
        // 首张图片事件
        if (result.results?.length > 0) {
            const ttffMs = Date.now() - this.requestTracker?.phases?.scout?.start || 0;
            this.requestTracker?.event('firstImageReady', {
                pageNum: result.results[0].pageNum,
                ttffMs,
                mode: 'native',
            });
        }
        
        return result;
    }

    /**
     * PDF.js 渲染路径（保持原有 V2 架构）
     * 
     * 流程：
     * 1. 将 pdfUrl 传递给 Worker
     * 2. Worker 内部使用 RangeLoader 分片加载
     * 3. Worker 使用 pdfjs 渲染
     */
    async executePdfjsPath(pool, pdfPath, pages, numPages, pdfSize, uploadToCos) {
        // 确定初始目标页码
        let targetPages;
        let needAllPages = false;
        
        if (pages === 'all') {
            targetPages = [1, 2, 3, 4, 5, 6];
            needAllPages = true;
        } else if (Array.isArray(pages)) {
            targetPages = [...new Set(pages)].filter(p => p >= 1).sort((a, b) => a - b);
        } else {
            targetPages = [1, 2, 3, 4, 5, 6];
        }
        
        if (targetPages.length === 0) {
            return { success: true, results: [], metrics: { numPages, pdfSize } };
        }
        
        // 第一批渲染
        this.requestTracker?.startPhase('render');
        
        const firstBatchResult = await pool.run({
            pdfUrl: pdfPath,
            pageNums: targetPages,
            globalPadId: this.globalPadId,
            uploadToCos,
            useNativeRenderer: false,  // 明确指示使用 pdfjs
        });
        
        if (!firstBatchResult.success) {
            throw new Error(firstBatchResult.error || '首批渲染失败');
        }
        
        // 更新 numPages（从 Worker 返回的实际值）
        const actualNumPages = firstBatchResult.metrics?.numPages || numPages;
        this.collectWorkerMetrics(firstBatchResult.metrics);
        
        // 首张图片事件
        if (firstBatchResult.results?.length > 0) {
            this.requestTracker?.event('firstImageReady', {
                pageNum: firstBatchResult.results[0].pageNum,
                mode: 'pdfjs-first-batch',
            });
        }
        
        // 收集首批结果
        let allResults = [...(firstBatchResult.results || [])];
        const renderedPages = new Set(allResults.filter(r => r.success).map(r => r.pageNum));
        
        // 确定剩余页码
        let remainingPages = [];
        
        if (needAllPages) {
            remainingPages = Array.from({ length: actualNumPages }, (_, i) => i + 1)
                .filter(p => !renderedPages.has(p));
        } else if (Array.isArray(pages)) {
            remainingPages = targetPages.filter(p => p <= actualNumPages && !renderedPages.has(p));
        }
        
        // 处理剩余页面
        if (remainingPages.length > 0) {
            this.log('info', `剩余 ${remainingPages.length} 页待渲染`);
            
            const additionalResults = await this.renderRemainingPages(
                pdfPath, remainingPages, pool, uploadToCos, pdfSize, actualNumPages
            );
            allResults.push(...additionalResults);
        }
        
        // 按页码排序
        allResults.sort((a, b) => a.pageNum - b.pageNum);
        
        this.requestTracker?.endPhase('render', {
            pageCount: allResults.length,
            successCount: allResults.filter(r => r.success).length,
        });
        
        return {
            success: true,
            results: allResults,
            metrics: {
                ...firstBatchResult.metrics,
                numPages: actualNumPages,
                renderedCount: allResults.filter(r => r.success).length,
            },
        };
    }

    /**
     * 确定目标页码
     */
    determineTargetPages(pages, numPages) {
        if (pages === 'all') {
            return Array.from({ length: numPages }, (_, i) => i + 1);
        } else if (Array.isArray(pages)) {
            return [...new Set(pages)]
                .filter(p => p >= 1 && p <= numPages)
                .sort((a, b) => a - b);
        } else {
            // 默认前6页
            return Array.from({ length: Math.min(6, numPages) }, (_, i) => i + 1);
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
        
        // 基于 PDF 大小决定 Worker 数量
        let optimalWorkers;
        let strategyReason;
        
        if (pdfSizeMB < 2) {
            optimalWorkers = 1;
            strategyReason = '小文件(<2MB)，单Worker';
        } else if (pdfSizeMB < 10) {
            const pagesPerWorker = 3;
            optimalWorkers = Math.min(
                Math.ceil(remainingPages.length / pagesPerWorker),
                Math.ceil(cpuCores / 2),
                remainingPages.length
            );
            optimalWorkers = Math.max(1, optimalWorkers);
            strategyReason = `中等文件(${pdfSizeMB.toFixed(1)}MB)，适度并行`;
        } else {
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
                useNativeRenderer: false,
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
     * 日志输出
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
            if (stats.requestCount > 0 || stats.totalRequests > 0) {
                this.requestTracker.rangeLoaderMetrics = this.requestTracker.rangeLoaderMetrics || {
                    requests: 0,
                    bytes: 0,
                    times: [],
                };
                this.requestTracker.rangeLoaderMetrics.requests += stats.requestCount || stats.totalRequests || 0;
                this.requestTracker.rangeLoaderMetrics.bytes += stats.totalBytes || 0;
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
                renderer: workerMetrics.renderer || 'pdfjs',
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
