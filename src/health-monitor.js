/**
 * 健康监控模块
 * 用于检测系统 CPU 和内存负载，支持高负载丢弃
 */

import os from 'os';

// 配置阈值
const HEALTH_CONFIG = {
  // CPU 使用率阈值（百分比）
  CPU_THRESHOLD: Number(process.env.CPU_THRESHOLD) || 85,
  
  // 内存使用率阈值（百分比）
  MEMORY_THRESHOLD: Number(process.env.MEMORY_THRESHOLD) || 85,
};

// 存储上一次 CPU 使用情况
let lastCpuUsage = null;
let lastCheckTime = null;

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
 * 检查系统健康状态
 * @returns {Promise<Object>} 健康状态信息
 */
export async function checkHealth() {
  const cpuUsage = await getCpuUsage();
  const memoryUsage = getMemoryUsage();
  
  // 判断是否健康
  const isCpuHealthy = cpuUsage < HEALTH_CONFIG.CPU_THRESHOLD;
  const isMemoryHealthy = memoryUsage.usagePercent < HEALTH_CONFIG.MEMORY_THRESHOLD;
  const isHealthy = isCpuHealthy && isMemoryHealthy;
  
  // 收集不健康的原因
  const unhealthyReasons = [];
  if (!isCpuHealthy) {
    unhealthyReasons.push(`CPU过载: ${cpuUsage.toFixed(2)}% (阈值: ${HEALTH_CONFIG.CPU_THRESHOLD}%)`);
  }
  if (!isMemoryHealthy) {
    unhealthyReasons.push(`内存过载: ${memoryUsage.usagePercent.toFixed(2)}% (阈值: ${HEALTH_CONFIG.MEMORY_THRESHOLD}%)`);
  }
  
  return {
    healthy: isHealthy,
    status: isHealthy ? 'healthy' : 'overloaded',
    reasons: unhealthyReasons,
    metrics: {
      cpu: {
        usage: cpuUsage.toFixed(2),
        threshold: HEALTH_CONFIG.CPU_THRESHOLD,
        healthy: isCpuHealthy,
      },
      memory: {
        usage: memoryUsage.usagePercent.toFixed(2),
        usedMB: memoryUsage.usedMB,
        totalMB: memoryUsage.totalMB,
        threshold: HEALTH_CONFIG.MEMORY_THRESHOLD,
        healthy: isMemoryHealthy,
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
