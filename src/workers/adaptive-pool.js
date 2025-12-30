/**
 * Worker 线程池管理器
 * 
 * 基于 Piscina 的简单封装，提供：
 * 1. 单例管理 - 全局复用线程池
 * 2. 统计监控 - 任务数、执行时间
 * 3. 状态查询 - 用于监控接口
 * 4. 资源隔离 - Worker 级别内存限制，防止"毒丸"PDF 拖垮进程
 */

import os from 'os';
import { Piscina } from 'piscina';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('WorkerPool');

// ==================== 配置 ====================
// 线程池策略：
// - MIN_THREADS = CPU核心数：保证基础并行能力
// - MAX_THREADS = CPU核心数 * 2：允许I/O密集型任务与CPU密集型任务重叠执行
// - 额外的Worker主要用于处理网络I/O（下载PDF），不会占用CPU
const POOL_CONFIG = {
    CPU_CORES: os.cpus().length,
    MIN_THREADS: parseInt(process.env.MIN_WORKER_THREADS) || os.cpus().length,
    MAX_THREADS: parseInt(process.env.MAX_WORKER_THREADS) || os.cpus().length * 2,
    IDLE_TIMEOUT: parseInt(process.env.WORKER_IDLE_TIMEOUT) || 30000,  // 30 秒空闲后回收
    // Worker 内存限制（MB）- 防止单个"毒丸"PDF 拖垮整个进程
    MAX_OLD_GENERATION_SIZE_MB: parseInt(process.env.WORKER_MAX_MEM_MB) || 700,
};

/**
 * Worker 池包装器
 */
class WorkerPool {
    constructor(options = {}) {
        this.workerFile = options.workerFile || path.join(__dirname, 'pdf-worker.js');
        this.name = options.name || 'default';
        
        // 创建 Piscina 实例，配置资源限制
        this.pool = new Piscina({
            filename: this.workerFile,
            minThreads: POOL_CONFIG.MIN_THREADS,
            maxThreads: POOL_CONFIG.MAX_THREADS,
            idleTimeout: POOL_CONFIG.IDLE_TIMEOUT,
            // 资源隔离：限制每个 Worker 的堆内存大小
            // 防止格式错误或恶意 PDF 导致内存溢出，拖垮整个进程
            resourceLimits: {
                maxOldGenerationSizeMb: POOL_CONFIG.MAX_OLD_GENERATION_SIZE_MB,
            },
        });
        
        // 统计数据
        this.stats = {
            totalTasks: 0,
            completedTasks: 0,
            failedTasks: 0,
            avgExecutionTime: 0,
        };
        
        this.isDestroyed = false;
        
        logger.info(`[${this.name}] 初始化，CPU核心: ${POOL_CONFIG.CPU_CORES}, 线程范围: ${POOL_CONFIG.MIN_THREADS}-${POOL_CONFIG.MAX_THREADS}, 单Worker内存限制: ${POOL_CONFIG.MAX_OLD_GENERATION_SIZE_MB}MB`);
    }
    
    /**
     * 运行任务
     */
    async run(taskData, options = {}) {
        if (this.isDestroyed) {
            throw new Error('Worker pool has been destroyed');
        }
        
        const startTime = Date.now();
        this.stats.totalTasks++;
        
        try {
            const result = await this.pool.run(taskData, options);
            
            this.stats.completedTasks++;
            const execTime = Date.now() - startTime;
            
            // 更新平均执行时间（滑动平均）
            this.stats.avgExecutionTime = this.stats.avgExecutionTime * 0.9 + execTime * 0.1;
            
            return result;
        } catch (error) {
            this.stats.failedTasks++;
            throw error;
        }
    }
    
    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            name: this.name,
            config: {
                minThreads: POOL_CONFIG.MIN_THREADS,
                maxThreads: POOL_CONFIG.MAX_THREADS,
                cpuCores: POOL_CONFIG.CPU_CORES,
            },
            stats: { ...this.stats },
            metrics: {
                queueSize: this.pool.queueSize,
                utilization: this.pool.utilization,
                completed: this.pool.completed,
                duration: this.pool.duration,
            },
        };
    }
    
    /**
     * 销毁线程池
     */
    async destroy() {
        if (this.isDestroyed) return;
        
        this.isDestroyed = true;
        await this.pool.destroy();
        
        logger.info(`[${this.name}] 已销毁`);
    }
}

// ==================== 单例管理 ====================
const pools = new Map();

// Worker 文件路径（统一使用 pdf-worker.js）
const PDF_WORKER_FILE = path.join(__dirname, 'pdf-worker.js');

/**
 * 获取 Worker 池（单例）
 * 
 * @param {string} name - 池名称（默认 'pdf'）
 * @returns {WorkerPool} Worker 池实例
 */
export function getWorkerPool(name = 'pdf') {
    if (!pools.has(name)) {
        pools.set(name, new WorkerPool({ name, workerFile: PDF_WORKER_FILE }));
    }
    return pools.get(name);
}

/**
 * 获取所有池的状态
 */
export function getAllPoolsStatus() {
    const status = {};
    for (const [name, pool] of pools) {
        status[name] = pool.getStatus();
    }
    return status;
}

/**
 * 销毁所有池
 */
export async function destroyAllPools() {
    for (const pool of pools.values()) {
        await pool.destroy();
    }
    pools.clear();
}

export { WorkerPool, POOL_CONFIG };
