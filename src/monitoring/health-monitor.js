/**
 * 健康监控模块
 * 
 * 用于检测系统 CPU 和内存负载，支持高负载丢弃
 * 
 * 优化：
 * 1. 放宽阈值到 95%，避免瞬间高负载导致误判
 * 2. 增加抖动窗口：连续 3 次检查超过阈值才判定为不健康
 */

import os from 'os';
import { CONCURRENCY_CONFIG } from './config.js';  // 同目录下

// 配置阈值 - 放宽到 95%，避免瞬间毛刺导致误判
const HEALTH_CONFIG = {
  // CPU 使用率阈值（百分比）- 从 90% 放宽到 95%
  CPU_THRESHOLD: Number(process.env.CPU_THRESHOLD) || 95,
  
  // 内存使用率阈值（百分比）- 从 90% 放宽到 95%
  MEMORY_THRESHOLD: Number(process.env.MEMORY_THRESHOLD) || 95,
  
  // 堆内存使用率阈值（百分比）
  HEAP_THRESHOLD: Number(process.env.HEAP_THRESHOLD) || 95,
  
  // 连续失败次数阈值：连续 N 次检查超过阈值才判定为不健康
  CONSECUTIVE_FAILURE_THRESHOLD: Number(process.env.HEALTH_FAILURE_THRESHOLD) || 3,
};

// 并发请求计数器
let activeRequestCount = 0;
const MAX_CONCURRENT_REQUESTS = CONCURRENCY_CONFIG.MAX_CONCURRENT_REQUESTS;

// 存储上一次 CPU 使用情况
let lastCpuUsage = null;
let lastCheckTime = null;

// 抖动窗口：记录连续失败次数
const consecutiveFailures = {
  cpu: 0,
  memory: 0,
  heap: 0,
};

/**
 * 获取 CPU 使用率
 * @returns {Promise<number>} CPU 使用率（0-100）
 */
export async function getCpuUsage() {
  const cpus = os.cpus();
  
  // 计算当前 CPU 时间
  let totalIdle = 0;
  let totalTick = 0;
  
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  const currentUsage = {
    idle: totalIdle,
    total: totalTick,
    timestamp: Date.now(),
  };
  
  // 如果是第一次检查，等待一小段时间再计算
  if (!lastCpuUsage) {
    lastCpuUsage = currentUsage;
    lastCheckTime = currentUsage.timestamp;
    
    // 等待 100ms 后再次采样
    await new Promise(resolve => setTimeout(resolve, 100));
    return getCpuUsage();
  }
  
  // 计算 CPU 使用率
  const idleDiff = currentUsage.idle - lastCpuUsage.idle;
  const totalDiff = currentUsage.total - lastCpuUsage.total;
  const cpuUsage = 100 - (100 * idleDiff / totalDiff);
  
  // 更新上一次的值
  lastCpuUsage = currentUsage;
  lastCheckTime = currentUsage.timestamp;
  
  return Math.max(0, Math.min(100, cpuUsage));
}

/**
 * 获取内存使用率
 * @returns {Object} 内存使用信息
 */
export function getMemoryUsage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsagePercent = (usedMemory / totalMemory) * 100;
  
  return {
    total: totalMemory,
    used: usedMemory,
    free: freeMemory,
    usagePercent: memoryUsagePercent,
    totalMB: (totalMemory / 1024 / 1024).toFixed(2),
    usedMB: (usedMemory / 1024 / 1024).toFixed(2),
    freeMB: (freeMemory / 1024 / 1024).toFixed(2),
  };
}



/**
 * 获取堆内存使用情况
 */
export function getHeapUsage() {
  const heapUsed = process.memoryUsage().heapUsed;
  const heapTotal = process.memoryUsage().heapTotal;
  const usagePercent = (heapUsed / heapTotal) * 100;
  
  return {
    used: heapUsed,
    total: heapTotal,
    usagePercent,
    usedMB: (heapUsed / 1024 / 1024).toFixed(2),
    totalMB: (heapTotal / 1024 / 1024).toFixed(2),
  };
}

/**
 * 增加活跃请求计数
 */
export function incrementActiveRequests() {
  activeRequestCount++;
  return activeRequestCount;
}

/**
 * 减少活跃请求计数
 */
export function decrementActiveRequests() {
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  return activeRequestCount;
}

/**
 * 获取活跃请求数
 */
export function getActiveRequestCount() {
  return activeRequestCount;
}

/**
 * 检查是否可以接受新请求（并发限制）
 */
export function canAcceptRequest() {
  return activeRequestCount < MAX_CONCURRENT_REQUESTS;
}

/**
 * 检查系统健康状态
 * 
 * 优化：增加抖动窗口
 * - 不再只看瞬时值，而是检查连续失败次数
 * - 连续 N 次检查超过阈值才判定为不健康
 * - 有效防止因瞬间毛刺导致的误判
 * 
 * @returns {Promise<Object>} 健康状态信息
 */
export async function checkHealth() {
  const cpuUsage = await getCpuUsage();
  const memoryUsage = getMemoryUsage();
  const heapUsage = getHeapUsage();
  
  const FAILURE_THRESHOLD = HEALTH_CONFIG.CONSECUTIVE_FAILURE_THRESHOLD;
  
  // 更新连续失败计数
  if (cpuUsage >= HEALTH_CONFIG.CPU_THRESHOLD) {
    consecutiveFailures.cpu++;
  } else {
    consecutiveFailures.cpu = 0;
  }
  
  if (memoryUsage.usagePercent >= HEALTH_CONFIG.MEMORY_THRESHOLD) {
    consecutiveFailures.memory++;
  } else {
    consecutiveFailures.memory = 0;
  }
  
  if (heapUsage.usagePercent >= HEALTH_CONFIG.HEAP_THRESHOLD) {
    consecutiveFailures.heap++;
  } else {
    consecutiveFailures.heap = 0;
  }
  
  // 判断是否健康：连续 N 次超过阈值才判定为不健康
  const isCpuHealthy = consecutiveFailures.cpu < FAILURE_THRESHOLD;
  const isMemoryHealthy = consecutiveFailures.memory < FAILURE_THRESHOLD;
  const isHeapHealthy = consecutiveFailures.heap < FAILURE_THRESHOLD;
  const isHealthy = isCpuHealthy && isMemoryHealthy && isHeapHealthy;
  
  // 收集不健康的原因
  const unhealthyReasons = [];
  if (!isCpuHealthy) {
    unhealthyReasons.push(`CPU过载: ${cpuUsage.toFixed(2)}% (阈值: ${HEALTH_CONFIG.CPU_THRESHOLD}%, 连续${consecutiveFailures.cpu}次)`);
  }
  if (!isMemoryHealthy) {
    unhealthyReasons.push(`内存过载: ${memoryUsage.usagePercent.toFixed(2)}% (阈值: ${HEALTH_CONFIG.MEMORY_THRESHOLD}%, 连续${consecutiveFailures.memory}次)`);
  }
  if (!isHeapHealthy) {
    unhealthyReasons.push(`堆内存过载: ${heapUsage.usagePercent.toFixed(2)}% (阈值: ${HEALTH_CONFIG.HEAP_THRESHOLD}%, 连续${consecutiveFailures.heap}次)`);
  }
  
  return {
    healthy: isHealthy,
    status: isHealthy ? 'healthy' : 'overloaded',
    reasons: unhealthyReasons,
    metrics: {
      cpu: {
        usage: cpuUsage.toFixed(2),
        threshold: HEALTH_CONFIG.CPU_THRESHOLD,
        consecutiveFailures: consecutiveFailures.cpu,
        healthy: isCpuHealthy,
      },
      memory: {
        usage: memoryUsage.usagePercent.toFixed(2),
        usedMB: memoryUsage.usedMB,
        totalMB: memoryUsage.totalMB,
        threshold: HEALTH_CONFIG.MEMORY_THRESHOLD,
        consecutiveFailures: consecutiveFailures.memory,
        healthy: isMemoryHealthy,
      },
      heap: {
        usage: heapUsage.usagePercent.toFixed(2),
        usedMB: heapUsage.usedMB,
        totalMB: heapUsage.totalMB,
        threshold: HEALTH_CONFIG.HEAP_THRESHOLD,
        consecutiveFailures: consecutiveFailures.heap,
        healthy: isHeapHealthy,
      },
      concurrency: {
        current: activeRequestCount,
        max: MAX_CONCURRENT_REQUESTS,
        // 并发只作为参考指标，不影响健康状态
        healthy: true,
      },
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 获取健康配置
 */
export function getHealthConfig() {
  return { ...HEALTH_CONFIG };
}

/**
 * 更新健康配置（运行时动态调整）
 */
export function updateHealthConfig(config) {
  if (config.CPU_THRESHOLD !== undefined) {
    HEALTH_CONFIG.CPU_THRESHOLD = config.CPU_THRESHOLD;
  }
  if (config.MEMORY_THRESHOLD !== undefined) {
    HEALTH_CONFIG.MEMORY_THRESHOLD = config.MEMORY_THRESHOLD;
  }
  return getHealthConfig();
}
