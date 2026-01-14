/**
 * 线程池管理模块
 * 
 * 使用 Piscina 管理工作线程池，用于 CPU 密集型任务
 */

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Piscina from 'piscina';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ThreadPool');

// 获取 worker.js 的路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, '../worker.js');

// 线程数默认为 CPU 核心数，可通过环境变量调整
const threadCount = parseInt(process.env.PDF2IMG_THREAD_COUNT, 10) || os.cpus().length;

let piscina = null;

/**
 * 获取或创建线程池实例（懒加载）
 */
export function getThreadPool() {
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
 * 获取线程数
 */
export function getThreadCount() {
    return threadCount;
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
