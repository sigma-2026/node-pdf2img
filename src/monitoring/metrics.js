/**
 * 性能监控模块 - 可通过环境变量开关
 * 
 * 环境变量:
 *   METRICS_ENABLED=true|false  - 是否启用指标收集（默认 true）
 *   METRICS_LOG_LEVEL=debug|info|warn|error - 日志级别（默认 info）
 *   METRICS_SAMPLE_RATE=0.0-1.0 - 采样率（默认 1.0，即全量）
 */

const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
const METRICS_LOG_LEVEL = process.env.METRICS_LOG_LEVEL || 'info';
const METRICS_SAMPLE_RATE = parseFloat(process.env.METRICS_SAMPLE_RATE) || 1.0;

// 日志级别优先级
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[METRICS_LOG_LEVEL] || 1;

// 全局指标存储
const globalMetrics = {
  // 请求级别统计
  requests: {
    total: 0,
    success: 0,
    failed: 0,
    timeout: 0,
    overload: 0,  // 因过载拒绝的请求
  },
  
  // 响应时间分布（毫秒）
  responseTimes: [],
  
  // 渲染统计
  render: {
    totalPages: 0,
    successPages: 0,
    failedPages: 0,
    totalRenderTime: 0,
    pageRenderTimes: [],  // 每页渲染时间
  },
  
  // 分片加载统计
  rangeLoader: {
    totalRequests: 0,
    totalBytes: 0,
    failedRequests: 0,
    requestTimes: [],  // 每次请求耗时
  },
  
  // Worker 线程统计
  worker: {
    totalTasks: 0,
    successTasks: 0,
    failedTasks: 0,
    queueWaitTimes: [],  // 任务排队等待时间
    executionTimes: [],  // 任务执行时间
  },
  
  // COS 上传统计
  upload: {
    totalFiles: 0,
    successFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    uploadTimes: [],
  },
  
  // 并发统计
  concurrency: {
    current: 0,
    peak: 0,
    history: [],  // 时间序列 { timestamp, concurrent }
  },

  // 请求排队等待（进程级渲染配额）
  queue: {
    waitTimes: [],
  },
  
  // 系统资源快照
  system: {
    snapshots: [],  // { timestamp, cpu, memory, heap }
  },
};

// 当前活跃请求追踪
const activeRequests = new Map();

/**
 * 判断是否应该采样
 */
function shouldSample() {
  return METRICS_ENABLED && Math.random() < METRICS_SAMPLE_RATE;
}

/**
 * 日志输出（带级别控制）
 */
function log(level, ...args) {
  if (!METRICS_ENABLED) return;
  if (LOG_LEVELS[level] < currentLogLevel) return;
  
  const prefix = `[Metrics:${level.toUpperCase()}]`;
  const timestamp = new Date().toISOString();
  
  switch (level) {
    case 'debug':
      console.debug(prefix, timestamp, ...args);
      break;
    case 'info':
      console.log(prefix, timestamp, ...args);
      break;
    case 'warn':
      console.warn(prefix, timestamp, ...args);
      break;
    case 'error':
      console.error(prefix, timestamp, ...args);
      break;
  }
}

/**
 * 请求追踪器 - 追踪单个请求的完整生命周期
 */
class RequestTracker {
  constructor(requestId, metadata = {}) {
    this.requestId = requestId;
    this.metadata = metadata;
    this.startTime = Date.now();
    this.phases = {};
    this.events = [];
    this.pageMetrics = [];
    this.rangeLoaderMetrics = {
      requests: 0,
      bytes: 0,
      times: [],
    };
    this.workerMetrics = {
      tasks: 0,
      times: [],
    };

    // 进程级渲染配额排队等待（ms）
    this.queueWaitMs = 0;
    
    // 记录并发
    globalMetrics.concurrency.current++;
    if (globalMetrics.concurrency.current > globalMetrics.concurrency.peak) {
      globalMetrics.concurrency.peak = globalMetrics.concurrency.current;
    }
    globalMetrics.concurrency.history.push({
      timestamp: Date.now(),
      concurrent: globalMetrics.concurrency.current,
    });
    
    // 限制历史记录数量
    if (globalMetrics.concurrency.history.length > 1000) {
      globalMetrics.concurrency.history = globalMetrics.concurrency.history.slice(-500);
    }
    
    activeRequests.set(requestId, this);
    globalMetrics.requests.total++;
    
    log('debug', `[${requestId}] 请求开始`, metadata);
  }
  
  /**
   * 开始一个阶段计时
   */
  startPhase(phaseName) {
    this.phases[phaseName] = {
      start: Date.now(),
      end: null,
      duration: null,
    };
    log('debug', `[${this.requestId}] 阶段开始: ${phaseName}`);
  }
  
  /**
   * 结束一个阶段计时
   */
  endPhase(phaseName, extra = {}) {
    if (this.phases[phaseName]) {
      this.phases[phaseName].end = Date.now();
      this.phases[phaseName].duration = this.phases[phaseName].end - this.phases[phaseName].start;
      this.phases[phaseName] = { ...this.phases[phaseName], ...extra };
      log('debug', `[${this.requestId}] 阶段结束: ${phaseName} (${this.phases[phaseName].duration}ms)`, extra);
    }
  }
  
  /**
   * 记录事件
   */
  event(eventName, data = {}) {
    this.events.push({
      timestamp: Date.now(),
      elapsed: Date.now() - this.startTime,
      event: eventName,
      data,
    });
    log('debug', `[${this.requestId}] 事件: ${eventName}`, data);
  }

  /**
   * 记录渲染配额排队等待时间
   */
  recordQueueWait(waitMs) {
    this.queueWaitMs = waitMs;
    globalMetrics.queue.waitTimes.push(waitMs);

    // 限制数组大小
    if (globalMetrics.queue.waitTimes.length > 10000) {
      globalMetrics.queue.waitTimes = globalMetrics.queue.waitTimes.slice(-5000);
    }

    log('debug', `[${this.requestId}] 排队等待: ${waitMs}ms`);
  }
  
  /**
   * 记录页面渲染指标
   */
  recordPageRender(pageNum, duration, success = true, extra = {}) {
    const metric = {
      pageNum,
      duration,
      success,
      timestamp: Date.now(),
      ...extra,
    };
    this.pageMetrics.push(metric);
    
    globalMetrics.render.totalPages++;
    if (success) {
      globalMetrics.render.successPages++;
    } else {
      globalMetrics.render.failedPages++;
    }
    globalMetrics.render.totalRenderTime += duration;
    globalMetrics.render.pageRenderTimes.push(duration);
    
    // 限制数组大小
    if (globalMetrics.render.pageRenderTimes.length > 10000) {
      globalMetrics.render.pageRenderTimes = globalMetrics.render.pageRenderTimes.slice(-5000);
    }
    
    log('debug', `[${this.requestId}] 页面渲染: 第${pageNum}页 ${duration}ms ${success ? '成功' : '失败'}`, extra);
  }
  
  /**
   * 记录分片加载指标
   */
  recordRangeLoad(start, end, duration, success = true) {
    const bytes = end - start + 1;
    this.rangeLoaderMetrics.requests++;
    this.rangeLoaderMetrics.bytes += bytes;
    this.rangeLoaderMetrics.times.push(duration);
    
    globalMetrics.rangeLoader.totalRequests++;
    globalMetrics.rangeLoader.totalBytes += bytes;
    globalMetrics.rangeLoader.requestTimes.push(duration);
    if (!success) {
      globalMetrics.rangeLoader.failedRequests++;
    }
    
    // 限制数组大小
    if (globalMetrics.rangeLoader.requestTimes.length > 10000) {
      globalMetrics.rangeLoader.requestTimes = globalMetrics.rangeLoader.requestTimes.slice(-5000);
    }
    
    log('debug', `[${this.requestId}] 分片加载: ${start}-${end} (${(bytes/1024).toFixed(1)}KB) ${duration}ms`);
  }
  
  /**
   * 记录 Worker 任务指标
   */
  recordWorkerTask(pageNum, queueTime, execTime, success = true) {
    this.workerMetrics.tasks++;
    this.workerMetrics.times.push({ pageNum, queueTime, execTime, success });
    
    globalMetrics.worker.totalTasks++;
    if (success) {
      globalMetrics.worker.successTasks++;
    } else {
      globalMetrics.worker.failedTasks++;
    }
    globalMetrics.worker.queueWaitTimes.push(queueTime);
    globalMetrics.worker.executionTimes.push(execTime);
    
    // 限制数组大小
    if (globalMetrics.worker.queueWaitTimes.length > 10000) {
      globalMetrics.worker.queueWaitTimes = globalMetrics.worker.queueWaitTimes.slice(-5000);
      globalMetrics.worker.executionTimes = globalMetrics.worker.executionTimes.slice(-5000);
    }
    
    log('debug', `[${this.requestId}] Worker任务: 第${pageNum}页 排队${queueTime}ms 执行${execTime}ms ${success ? '成功' : '失败'}`);
  }
  
  /**
   * 记录上传指标
   */
  recordUpload(fileCount, totalBytes, duration, success = true) {
    globalMetrics.upload.totalFiles += fileCount;
    if (success) {
      globalMetrics.upload.successFiles += fileCount;
    } else {
      globalMetrics.upload.failedFiles += fileCount;
    }
    globalMetrics.upload.totalBytes += totalBytes;
    globalMetrics.upload.uploadTimes.push(duration);
    
    // 限制数组大小
    if (globalMetrics.upload.uploadTimes.length > 10000) {
      globalMetrics.upload.uploadTimes = globalMetrics.upload.uploadTimes.slice(-5000);
    }
    
    log('debug', `[${this.requestId}] 上传: ${fileCount}个文件 ${(totalBytes/1024).toFixed(1)}KB ${duration}ms ${success ? '成功' : '失败'}`);
  }
  
  /**
   * 完成请求追踪
   */
  finish(success = true, error = null) {
    const totalDuration = Date.now() - this.startTime;
    
    globalMetrics.concurrency.current--;
    
    if (success) {
      globalMetrics.requests.success++;
    } else {
      globalMetrics.requests.failed++;
      if (error && error.message && error.message.includes('timeout')) {
        globalMetrics.requests.timeout++;
      }
    }
    
    globalMetrics.responseTimes.push(totalDuration);
    
    // 限制数组大小
    if (globalMetrics.responseTimes.length > 10000) {
      globalMetrics.responseTimes = globalMetrics.responseTimes.slice(-5000);
    }
    
    activeRequests.delete(this.requestId);
    
    // 生成请求摘要
    const summary = this.getSummary(success, error, totalDuration);
    
    log('info', `[${this.requestId}] 请求完成`, summary);
    
    return summary;
  }
  
  /**
   * 获取请求摘要
   */
  getSummary(success, error, totalDuration) {
    const phaseDurations = {};
    for (const [name, phase] of Object.entries(this.phases)) {
      phaseDurations[name] = phase.duration;
    }
    
    const pageStats = this.pageMetrics.length > 0 ? {
      count: this.pageMetrics.length,
      success: this.pageMetrics.filter(p => p.success).length,
      failed: this.pageMetrics.filter(p => !p.success).length,
      avgRenderTime: Math.round(this.pageMetrics.reduce((sum, p) => sum + p.duration, 0) / this.pageMetrics.length),
      minRenderTime: Math.min(...this.pageMetrics.map(p => p.duration)),
      maxRenderTime: Math.max(...this.pageMetrics.map(p => p.duration)),
    } : null;
    
    return {
      requestId: this.requestId,
      success,
      error: error ? error.message : null,
      totalDuration,
      metadata: this.metadata,
      phases: phaseDurations,
      queue: {
        waitMs: this.queueWaitMs,
      },
      pageStats,
      rangeLoader: {
        requests: this.rangeLoaderMetrics.requests,
        bytes: this.rangeLoaderMetrics.bytes,
        avgTime: this.rangeLoaderMetrics.times.length > 0 
          ? Math.round(this.rangeLoaderMetrics.times.reduce((a, b) => a + b, 0) / this.rangeLoaderMetrics.times.length)
          : 0,
      },
      worker: {
        tasks: this.workerMetrics.tasks,
        avgExecTime: this.workerMetrics.times.length > 0
          ? Math.round(this.workerMetrics.times.reduce((sum, t) => sum + t.execTime, 0) / this.workerMetrics.times.length)
          : 0,
      },
    };
  }
}

/**
 * 记录系统资源快照
 */
function recordSystemSnapshot() {
  if (!METRICS_ENABLED) return;
  
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  globalMetrics.system.snapshots.push({
    timestamp: Date.now(),
    heap: {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
    },
    cpu: cpuUsage,
    activeRequests: activeRequests.size,
  });
  
  // 限制快照数量
  if (globalMetrics.system.snapshots.length > 1000) {
    globalMetrics.system.snapshots = globalMetrics.system.snapshots.slice(-500);
  }
}

/**
 * 计算百分位数
 */
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * 获取全局指标摘要
 */
function getMetricsSummary() {
  const responseTimes = globalMetrics.responseTimes;
  const pageRenderTimes = globalMetrics.render.pageRenderTimes;
  const rangeRequestTimes = globalMetrics.rangeLoader.requestTimes;
  const workerExecTimes = globalMetrics.worker.executionTimes;
  const uploadTimes = globalMetrics.upload.uploadTimes;
  
  return {
    enabled: METRICS_ENABLED,
    logLevel: METRICS_LOG_LEVEL,
    sampleRate: METRICS_SAMPLE_RATE,
    
    requests: {
      ...globalMetrics.requests,
      successRate: globalMetrics.requests.total > 0 
        ? ((globalMetrics.requests.success / globalMetrics.requests.total) * 100).toFixed(2) + '%'
        : 'N/A',
    },
    
    responseTime: responseTimes.length > 0 ? {
      avg: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
      min: Math.min(...responseTimes),
      max: Math.max(...responseTimes),
      p50: percentile(responseTimes, 50),
      p90: percentile(responseTimes, 90),
      p99: percentile(responseTimes, 99),
      samples: responseTimes.length,
    } : null,
    
    render: {
      totalPages: globalMetrics.render.totalPages,
      successPages: globalMetrics.render.successPages,
      failedPages: globalMetrics.render.failedPages,
      successRate: globalMetrics.render.totalPages > 0
        ? ((globalMetrics.render.successPages / globalMetrics.render.totalPages) * 100).toFixed(2) + '%'
        : 'N/A',
      avgRenderTime: pageRenderTimes.length > 0
        ? Math.round(pageRenderTimes.reduce((a, b) => a + b, 0) / pageRenderTimes.length)
        : 0,
      p50RenderTime: percentile(pageRenderTimes, 50),
      p90RenderTime: percentile(pageRenderTimes, 90),
      p99RenderTime: percentile(pageRenderTimes, 99),
    },
    
    rangeLoader: {
      totalRequests: globalMetrics.rangeLoader.totalRequests,
      totalBytes: globalMetrics.rangeLoader.totalBytes,
      totalBytesMB: (globalMetrics.rangeLoader.totalBytes / 1024 / 1024).toFixed(2),
      failedRequests: globalMetrics.rangeLoader.failedRequests,
      avgRequestTime: rangeRequestTimes.length > 0
        ? Math.round(rangeRequestTimes.reduce((a, b) => a + b, 0) / rangeRequestTimes.length)
        : 0,
      p90RequestTime: percentile(rangeRequestTimes, 90),
    },
    
    worker: {
      totalTasks: globalMetrics.worker.totalTasks,
      successTasks: globalMetrics.worker.successTasks,
      failedTasks: globalMetrics.worker.failedTasks,
      avgExecTime: workerExecTimes.length > 0
        ? Math.round(workerExecTimes.reduce((a, b) => a + b, 0) / workerExecTimes.length)
        : 0,
      p90ExecTime: percentile(workerExecTimes, 90),
    },
    
    upload: {
      totalFiles: globalMetrics.upload.totalFiles,
      successFiles: globalMetrics.upload.successFiles,
      failedFiles: globalMetrics.upload.failedFiles,
      totalBytesMB: (globalMetrics.upload.totalBytes / 1024 / 1024).toFixed(2),
      avgUploadTime: uploadTimes.length > 0
        ? Math.round(uploadTimes.reduce((a, b) => a + b, 0) / uploadTimes.length)
        : 0,
    },
    
    concurrency: {
      current: globalMetrics.concurrency.current,
      peak: globalMetrics.concurrency.peak,
    },

    queue: {
      avgWaitMs: globalMetrics.queue.waitTimes.length > 0
        ? Math.round(globalMetrics.queue.waitTimes.reduce((a, b) => a + b, 0) / globalMetrics.queue.waitTimes.length)
        : 0,
      p90WaitMs: percentile(globalMetrics.queue.waitTimes, 90),
      samples: globalMetrics.queue.waitTimes.length,
    },
    
    activeRequests: Array.from(activeRequests.entries()).map(([id, tracker]) => ({
      requestId: id,
      elapsed: Date.now() - tracker.startTime,
      metadata: tracker.metadata,
    })),
  };
}

/**
 * 重置所有指标
 */
function resetMetrics() {
  globalMetrics.requests = { total: 0, success: 0, failed: 0, timeout: 0, overload: 0 };
  globalMetrics.responseTimes = [];
  globalMetrics.render = { totalPages: 0, successPages: 0, failedPages: 0, totalRenderTime: 0, pageRenderTimes: [] };
  globalMetrics.rangeLoader = { totalRequests: 0, totalBytes: 0, failedRequests: 0, requestTimes: [] };
  globalMetrics.worker = { totalTasks: 0, successTasks: 0, failedTasks: 0, queueWaitTimes: [], executionTimes: [] };
  globalMetrics.upload = { totalFiles: 0, successFiles: 0, failedFiles: 0, totalBytes: 0, uploadTimes: [] };
  globalMetrics.concurrency = { current: activeRequests.size, peak: activeRequests.size, history: [] };
  globalMetrics.queue = { waitTimes: [] };
  globalMetrics.system = { snapshots: [] };
  
  log('info', '指标已重置');
}

/**
 * 创建请求追踪器
 */
function createRequestTracker(requestId, metadata = {}) {
  if (!METRICS_ENABLED) {
    // 返回一个空操作的追踪器
    return {
      startPhase: () => {},
      endPhase: () => {},
      event: () => {},
      recordPageRender: () => {},
      recordRangeLoad: () => {},
      recordWorkerTask: () => {},
      recordUpload: () => {},
      finish: () => ({}),
      getSummary: () => ({}),
    };
  }
  return new RequestTracker(requestId, metadata);
}

/**
 * 记录过载拒绝
 */
function recordOverloadReject() {
  if (METRICS_ENABLED) {
    globalMetrics.requests.total++;
    globalMetrics.requests.overload++;
    log('warn', '请求因过载被拒绝');
  }
}

// 定期记录系统快照（每 5 秒）
let snapshotInterval = null;
if (METRICS_ENABLED) {
  snapshotInterval = setInterval(recordSystemSnapshot, 5000);
  // 不阻止进程退出
  snapshotInterval.unref();
}

export {
  METRICS_ENABLED,
  METRICS_LOG_LEVEL,
  METRICS_SAMPLE_RATE,
  createRequestTracker,
  getMetricsSummary,
  resetMetrics,
  recordOverloadReject,
  recordSystemSnapshot,
  log as metricsLog,
  globalMetrics,
};
