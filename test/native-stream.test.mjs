/**
 * Native Stream 模式专项测试
 * 
 * 测试内容：
 * - 功能正确性：确保渲染结果正确
 * - 稳定性：连续多次调用
 * - 性能：与完全下载模式对比，收集分析性能数据
 * - 流量节省：验证分片加载的效果
 * 
 * 注意：当前 Native Stream 不支持真正的并发调用（全局状态限制），
 * 因此稳定性测试使用串行方式执行。
 * 
 * 运行方式：
 *   node test/native-stream.test.mjs
 */

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================

const STATIC_PORT = 3096;
const STATIC_URL = `http://localhost:${STATIC_PORT}`;

// 网络延迟模拟配置（模拟真实服务器环境）
const NETWORK_LATENCY = {
  enabled: true,
  // 基础延迟（模拟网络往返时间 RTT）
  baseLatencyMs: 50,
  // 每 MB 数据的传输延迟（模拟带宽限制，10Mbps ≈ 80ms/MB）
  latencyPerMB: 80,
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// ==================== 工具函数 ====================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 计算模拟延迟时间
 * @param {number} bytes - 传输字节数
 * @returns {number} 延迟毫秒数
 */
function calculateLatency(bytes) {
  if (!NETWORK_LATENCY.enabled) return 0;
  const mbSize = bytes / (1024 * 1024);
  return NETWORK_LATENCY.baseLatencyMs + Math.round(mbSize * NETWORK_LATENCY.latencyPerMB);
}

/**
 * 延迟函数
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== Range 请求追踪器 ====================

class RangeRequestTracker {
  constructor() {
    this.reset();
  }

  reset(fileSize = 0) {
    this.requests = [];
    this.totalBytes = 0;
    this.fileSize = fileSize;
  }

  addRequest(start, end, bytes) {
    this.requests.push({ start, end, bytes, timestamp: Date.now() });
    this.totalBytes += bytes;
  }

  getStats() {
    return {
      requestCount: this.requests.length,
      totalBytes: this.totalBytes,
      fileSize: this.fileSize,
      percentage: this.fileSize > 0 ? ((this.totalBytes / this.fileSize) * 100).toFixed(2) : 0,
      requests: this.requests,
    };
  }
}

// ==================== 静态文件服务器（带延迟模拟） ====================

function createStaticServer(tracker) {
  return http.createServer(async (req, res) => {
    const staticDir = path.join(__dirname, '..', 'static');
    const decodedUrl = decodeURIComponent(req.url);
    const filePath = path.join(staticDir, decodedUrl);
    
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      // HEAD 请求只有基础延迟
      await delay(calculateLatency(0));
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      tracker.addRequest(start, end, chunkSize);

      // 模拟网络延迟：基础延迟 + 传输延迟
      await delay(calculateLatency(chunkSize));

      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/pdf',
      });
      stream.pipe(res);
    } else {
      tracker.addRequest(0, fileSize - 1, fileSize);
      
      // 模拟网络延迟：基础延迟 + 完整文件传输延迟
      await delay(calculateLatency(fileSize));

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ==================== Native Renderer ====================

let nativeRenderer = null;

async function loadNativeRenderer() {
  const nativeRendererPath = path.join(__dirname, '../native-renderer/index.js');
  nativeRenderer = await import(nativeRendererPath);
  return nativeRenderer;
}

// ==================== 渲染函数 ====================

/**
 * 使用 Native Stream 模式渲染 PDF
 */
async function renderWithStream(pdfUrl, fileSize, pageNums, options = {}) {
  const stats = {
    fetcherCalls: 0,
    totalBytes: 0,
  };
  
  // NAPI-RS ThreadsafeFunction 会在参数前添加一个额外的参数
  const fetcher = (_unused, offset, size, requestId) => {
    stats.fetcherCalls++;
    const start = Math.floor(offset);
    const end = start + size - 1;
    
    fetch(pdfUrl, {
      headers: { 'Range': `bytes=${start}-${end}` },
    })
      .then(async (response) => {
        if (!response.ok && response.status !== 206) {
          throw new Error(`Range 请求失败: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        stats.totalBytes += buffer.length;
        nativeRenderer.completeStreamRequest(requestId, buffer, null);
      })
      .catch((error) => {
        nativeRenderer.completeStreamRequest(requestId, null, error.message);
      });
  };
  
  const startTime = Date.now();
  const result = await nativeRenderer.renderPagesFromStream(
    fileSize,
    pageNums,
    {
      targetWidth: 1280,
      imageHeavyWidth: 1024,
      maxScale: 4.0,
      webpQuality: 70,
      detectScan: true,
      ...options,
    },
    fetcher
  );
  const duration = Date.now() - startTime;
  
  return { result, stats, duration };
}

/**
 * 使用 Native 完全下载模式渲染 PDF
 */
async function renderWithFullDownload(pdfUrl, pageNums, options = {}) {
  const startTime = Date.now();
  
  const response = await fetch(pdfUrl);
  const arrayBuffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);
  const downloadTime = Date.now() - startTime;
  
  const renderStart = Date.now();
  const result = nativeRenderer.renderPages(pdfBuffer, pageNums, {
    targetWidth: 1280,
    imageHeavyWidth: 1024,
    maxScale: 4.0,
    webpQuality: 70,
    detectScan: true,
    ...options,
  });
  const renderTime = Date.now() - renderStart;
  
  return { 
    result, 
    downloadedBytes: pdfBuffer.length,
    duration: Date.now() - startTime,
    downloadTime,
    renderTime,
  };
}

// ==================== 测试用例 ====================

/**
 * 测试单个 PDF 文件
 */
async function testPdfFile(filename, tracker, pages = [1, 2, 3, 4, 5, 6]) {
  const pdfPath = path.join(__dirname, '..', 'static', filename);
  
  if (!fs.existsSync(pdfPath)) {
    console.log(`${colors.yellow}⚠ 跳过 ${filename} (文件不存在)${colors.reset}`);
    return null;
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  const pdfUrl = `${STATIC_URL}/${encodeURIComponent(filename)}`;
  
  console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}测试文件: ${filename}${colors.reset}`);
  console.log(`${colors.dim}文件大小: ${formatBytes(fileSize)}, 测试页码: [${pages.join(', ')}]${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  
  const testResult = {
    filename,
    fileSize,
    pages,
    stream: null,
    full: null,
    passed: true,
    errors: [],
  };
  
  // ========== 1. Native Stream 测试 ==========
  console.log(`\n${colors.blue}[1/2] Native Stream 渲染...${colors.reset}`);
  tracker.reset(fileSize);
  
  try {
    const { result, stats, duration } = await renderWithStream(pdfUrl, fileSize, pages);
    const rangeStats = tracker.getStats();
    
    if (!result.success) {
      throw new Error(result.error || '渲染失败');
    }
    
    const successPages = result.pages.filter(p => p.success);
    if (successPages.length === 0) {
      throw new Error('没有成功渲染的页面');
    }
    
    testResult.stream = {
      success: true,
      duration,
      numPages: result.numPages,
      renderedPages: successPages.length,
      fetcherCalls: stats.fetcherCalls,
      totalBytes: rangeStats.totalBytes,
      percentage: rangeStats.percentage,
      requestCount: rangeStats.requestCount,
      pages: result.pages.map(p => ({
        pageNum: p.pageNum,
        width: p.width,
        height: p.height,
        success: p.success,
        bufferSize: p.buffer?.length || 0,
        renderTime: p.renderTime,
        encodeTime: p.encodeTime,
      })),
    };
    
    console.log(`${colors.green}✓ 完成${colors.reset} - 耗时: ${formatDuration(duration)}`);
    console.log(`${colors.dim}  渲染页数: ${successPages.length}/${pages.length}${colors.reset}`);
    console.log(`${colors.dim}  HTTP 请求: ${rangeStats.requestCount} 次${colors.reset}`);
    console.log(`${colors.dim}  下载量: ${formatBytes(rangeStats.totalBytes)} (${rangeStats.percentage}%)${colors.reset}`);
    
  } catch (error) {
    testResult.stream = { success: false, error: error.message };
    testResult.passed = false;
    testResult.errors.push(`Stream: ${error.message}`);
    console.log(`${colors.red}✗ 失败: ${error.message}${colors.reset}`);
  }
  
  // ========== 2. Native Full Download 测试 ==========
  console.log(`\n${colors.blue}[2/2] Native 完全下载渲染...${colors.reset}`);
  tracker.reset(fileSize);
  
  try {
    const { result, downloadedBytes, duration, downloadTime, renderTime } = await renderWithFullDownload(pdfUrl, pages);
    
    if (!result.success) {
      throw new Error(result.error || '渲染失败');
    }
    
    const successPages = result.pages.filter(p => p.success);
    
    testResult.full = {
      success: true,
      duration,
      downloadTime,
      renderTime,
      numPages: result.numPages,
      renderedPages: successPages.length,
      downloadedBytes,
      pages: result.pages.map(p => ({
        pageNum: p.pageNum,
        width: p.width,
        height: p.height,
        success: p.success,
        bufferSize: p.buffer?.length || 0,
        renderTime: p.renderTime,
        encodeTime: p.encodeTime,
      })),
    };
    
    console.log(`${colors.green}✓ 完成${colors.reset} - 耗时: ${formatDuration(duration)}`);
    console.log(`${colors.dim}  下载: ${formatDuration(downloadTime)}, 渲染: ${formatDuration(renderTime)}${colors.reset}`);
    
  } catch (error) {
    testResult.full = { success: false, error: error.message };
    testResult.passed = false;
    testResult.errors.push(`Full: ${error.message}`);
    console.log(`${colors.red}✗ 失败: ${error.message}${colors.reset}`);
  }
  
  // ========== 3. 结果对比 ==========
  if (testResult.stream?.success && testResult.full?.success) {
    console.log(`\n${colors.yellow}【对比分析】${colors.reset}`);
    
    // 时间对比
    const timeSaved = testResult.full.duration - testResult.stream.duration;
    const timePercent = ((timeSaved / testResult.full.duration) * 100).toFixed(1);
    console.log(`  时间: Stream ${formatDuration(testResult.stream.duration)} vs Full ${formatDuration(testResult.full.duration)}`);
    console.log(`  ${timeSaved > 0 ? colors.green : colors.red}${timeSaved > 0 ? '节省' : '多耗'}: ${formatDuration(Math.abs(timeSaved))} (${Math.abs(timePercent)}%)${colors.reset}`);
    
    // 流量对比
    const bytesSaved = testResult.full.downloadedBytes - testResult.stream.totalBytes;
    const bytesPercent = ((bytesSaved / testResult.full.downloadedBytes) * 100).toFixed(1);
    console.log(`  流量: Stream ${formatBytes(testResult.stream.totalBytes)} vs Full ${formatBytes(testResult.full.downloadedBytes)}`);
    console.log(`  ${bytesSaved > 0 ? colors.green : colors.red}${bytesSaved > 0 ? '节省' : '多用'}: ${formatBytes(Math.abs(bytesSaved))} (${Math.abs(bytesPercent)}%)${colors.reset}`);
    
    // 一致性检查
    const streamPages = testResult.stream.pages.filter(p => p.success);
    const fullPages = testResult.full.pages.filter(p => p.success);
    
    let consistent = true;
    for (let i = 0; i < Math.min(streamPages.length, fullPages.length); i++) {
      if (streamPages[i].width !== fullPages[i].width || 
          streamPages[i].height !== fullPages[i].height) {
        consistent = false;
        testResult.errors.push(`第 ${streamPages[i].pageNum} 页尺寸不一致`);
      }
    }
    
    if (consistent) {
      console.log(`  ${colors.green}✓ 输出尺寸一致${colors.reset}`);
    } else {
      console.log(`  ${colors.red}✗ 输出尺寸不一致${colors.reset}`);
      testResult.passed = false;
    }
  }
  
  return testResult;
}

/**
 * 连续调用稳定性测试（串行执行）
 */
async function testSequentialStability(tracker, iterations = 10) {
  const filename = '股权转让协议书 (2).pdf';
  const pdfPath = path.join(__dirname, '..', 'static', filename);
  
  if (!fs.existsSync(pdfPath)) {
    console.log(`${colors.yellow}⚠ 跳过稳定性测试 (测试文件不存在)${colors.reset}`);
    return null;
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  const pdfUrl = `${STATIC_URL}/${encodeURIComponent(filename)}`;
  
  console.log(`\n${colors.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}连续调用稳定性测试${colors.reset}`);
  console.log(`${colors.dim}连续调用次数: ${iterations}${colors.reset}`);
  console.log(`${colors.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  
  const results = [];
  const startTime = Date.now();
  
  for (let i = 0; i < iterations; i++) {
    process.stdout.write(`\r${colors.dim}  进度: ${i + 1}/${iterations}${colors.reset}    `);
    
    try {
      const { result, stats, duration } = await renderWithStream(pdfUrl, fileSize, [1, 2, 3]);
      results.push({
        iteration: i + 1,
        success: result.success,
        duration,
        totalBytes: stats.totalBytes,
        error: result.error,
      });
    } catch (error) {
      results.push({
        iteration: i + 1,
        success: false,
        error: error.message,
      });
    }
  }
  
  const totalDuration = Date.now() - startTime;
  console.log('\n');
  
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const durations = results.filter(r => r.success && r.duration).map(r => r.duration);
  
  const stats = {
    total: iterations,
    success: successCount,
    failed: failCount,
    successRate: ((successCount / iterations) * 100).toFixed(1),
    totalDuration,
    throughput: (successCount / (totalDuration / 1000)).toFixed(2),
    passed: failCount === 0,
  };
  
  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b);
    stats.avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    stats.minDuration = sorted[0];
    stats.maxDuration = sorted[sorted.length - 1];
    stats.p50 = sorted[Math.floor(sorted.length * 0.5)];
    stats.p90 = sorted[Math.floor(sorted.length * 0.9)];
  }
  
  console.log(`${successCount === iterations ? colors.green : colors.red}${successCount === iterations ? '✓' : '✗'} 稳定性测试${successCount === iterations ? '通过' : '失败'}${colors.reset}`);
  console.log(`\n${colors.yellow}【统计结果】${colors.reset}`);
  console.log(`  总请求: ${stats.total}, 成功: ${colors.green}${stats.success}${colors.reset}, 失败: ${colors.red}${stats.failed}${colors.reset}`);
  console.log(`  成功率: ${colors.bold}${stats.successRate}%${colors.reset}`);
  console.log(`  总耗时: ${formatDuration(stats.totalDuration)}`);
  console.log(`  吞吐量: ${colors.bold}${stats.throughput}${colors.reset} req/s`);
  
  if (durations.length > 0) {
    console.log(`\n${colors.yellow}【响应时间分布】${colors.reset}`);
    console.log(`  平均: ${formatDuration(stats.avgDuration)}`);
    console.log(`  最小: ${formatDuration(stats.minDuration)}`);
    console.log(`  最大: ${formatDuration(stats.maxDuration)}`);
    console.log(`  P50:  ${formatDuration(stats.p50)}`);
    console.log(`  P90:  ${formatDuration(stats.p90)}`);
  }
  
  if (failCount > 0) {
    console.log(`\n${colors.red}【失败详情】${colors.reset}`);
    results.filter(r => !r.success).forEach(r => {
      console.log(`  ${colors.red}第 ${r.iteration} 次: ${r.error}${colors.reset}`);
    });
  }
  
  return stats;
}

// ==================== 主测试函数 ====================

async function runNativeStreamTests() {
  let staticServer = null;
  const tracker = new RangeRequestTracker();
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${colors.bold}${colors.cyan}  Native Stream 模式专项测试${colors.reset}`);
  console.log(`${'═'.repeat(70)}\n`);
  
  const allResults = {
    files: [],
    stability: null,
    summary: {
      totalTests: 0,
      passed: 0,
      failed: 0,
    },
  };
  
  try {
    // 加载 Native Renderer
    console.log(`${colors.blue}加载 Native Renderer...${colors.reset}`);
    await loadNativeRenderer();
    
    if (!nativeRenderer.isPdfiumAvailable()) {
      throw new Error('PDFium 不可用');
    }
    
    if (typeof nativeRenderer.renderPagesFromStream !== 'function') {
      throw new Error('renderPagesFromStream 不可用');
    }
    
    if (typeof nativeRenderer.completeStreamRequest !== 'function') {
      throw new Error('completeStreamRequest 不可用');
    }
    
    console.log(`${colors.green}✓ Native Renderer 加载成功${colors.reset}`);
    console.log(`${colors.dim}  版本: ${nativeRenderer.getVersion()}${colors.reset}`);
    
    // 启动静态文件服务器
    console.log(`\n${colors.blue}启动静态文件服务器...${colors.reset}`);
    staticServer = createStaticServer(tracker);
    await new Promise((resolve, reject) => {
      staticServer.listen(STATIC_PORT, () => {
        console.log(`${colors.green}✓ 静态文件服务器已启动 (端口: ${STATIC_PORT})${colors.reset}`);
    if (NETWORK_LATENCY.enabled) {
      console.log(`${colors.yellow}  网络延迟模拟已启用:${colors.reset}`);
      console.log(`${colors.dim}    基础延迟 (RTT): ${NETWORK_LATENCY.baseLatencyMs}ms${colors.reset}`);
      console.log(`${colors.dim}    传输延迟: ${NETWORK_LATENCY.latencyPerMB}ms/MB (≈${(8 / (NETWORK_LATENCY.latencyPerMB / 1000)).toFixed(0)} Mbps)${colors.reset}`);
    }
    resolve();
      });
      staticServer.on('error', reject);
    });
    
    // ========== 单文件测试 ==========
    console.log(`\n\n${colors.bold}【单文件性能测试】${colors.reset}`);
    
    const PAGES_TO_RENDER = [1, 2, 3, 4, 5, 6];
    
    const testFiles = [
      // 小文件
      { file: '股权转让协议书 (2).pdf', pages: PAGES_TO_RENDER },
      { file: '1M.pdf', pages: PAGES_TO_RENDER },
      // 中等文件
      { file: 'DJI_Osmo_Action_5_Pro_User_Manual_v1.0_chs.pdf', pages: PAGES_TO_RENDER },
      { file: '10M.pdf', pages: PAGES_TO_RENDER },
      // 大文件
      { file: 'ISO_32000-2_sponsored-ec2.pdf', pages: PAGES_TO_RENDER },
      { file: '四年级数学.pdf', pages: PAGES_TO_RENDER },
      { file: 'Rust语言圣经(Rust Course)-25.3.10.pdf', pages: PAGES_TO_RENDER },
    ];
    
    for (const { file, pages } of testFiles) {
      const result = await testPdfFile(file, tracker, pages);
      if (result) {
        allResults.files.push(result);
        allResults.summary.totalTests++;
        if (result.passed) {
          allResults.summary.passed++;
        } else {
          allResults.summary.failed++;
        }
      }
      
      // 等待系统稳定
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // ========== 稳定性测试 ==========
    console.log(`\n\n${colors.bold}【稳定性测试】${colors.reset}`);
    
    allResults.stability = await testSequentialStability(tracker, 10);
    if (allResults.stability) {
      allResults.summary.totalTests++;
      if (allResults.stability.passed) {
        allResults.summary.passed++;
      } else {
        allResults.summary.failed++;
      }
    }
    
    // ========== 汇总报告 ==========
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log(`${colors.bold}${colors.cyan}  测试汇总报告${colors.reset}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    // 文件测试汇总
    console.log(`${colors.yellow}【单文件测试汇总】${colors.reset}\n`);
    console.log('┌──────────────────────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐');
    console.log('│ 文件                         │ Stream耗时 │ Full耗时   │ 时间节省   │ 流量节省   │ 状态       │');
    console.log('├──────────────────────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤');
    
    for (const r of allResults.files) {
      const filename = r.filename.length > 28 ? r.filename.substring(0, 25) + '...' : r.filename;
      const streamTime = r.stream?.success ? formatDuration(r.stream.duration) : 'N/A';
      const fullTime = r.full?.success ? formatDuration(r.full.duration) : 'N/A';
      
      let timeSaved = 'N/A';
      let bytesSaved = 'N/A';
      
      if (r.stream?.success && r.full?.success) {
        const tSaved = ((r.full.duration - r.stream.duration) / r.full.duration * 100).toFixed(0);
        timeSaved = `${tSaved > 0 ? '+' : ''}${tSaved}%`;
        
        const bSaved = ((r.full.downloadedBytes - r.stream.totalBytes) / r.full.downloadedBytes * 100).toFixed(0);
        bytesSaved = `${bSaved > 0 ? '+' : ''}${bSaved}%`;
      }
      
      const status = r.passed ? `${colors.green}PASS${colors.reset}` : `${colors.red}FAIL${colors.reset}`;
      
      console.log(`│ ${filename.padEnd(28)} │ ${streamTime.padStart(10)} │ ${fullTime.padStart(10)} │ ${timeSaved.padStart(10)} │ ${bytesSaved.padStart(10)} │ ${status}       │`);
    }
    
    console.log('└──────────────────────────────┴────────────┴────────────┴────────────┴────────────┴────────────┘');
    
    // 稳定性测试汇总
    if (allResults.stability) {
      console.log(`\n${colors.yellow}【稳定性测试汇总】${colors.reset}`);
      const stab = allResults.stability;
      console.log(`  连续调用: ${stab.passed ? colors.green + 'PASS' : colors.red + 'FAIL'}${colors.reset} (${stab.success}/${stab.total} 成功, ${stab.successRate}% 成功率)`);
      console.log(`  吞吐量: ${stab.throughput} req/s`);
      if (stab.avgDuration) {
        console.log(`  平均响应: ${formatDuration(stab.avgDuration)}, P90: ${formatDuration(stab.p90)}`);
      }
    }
    
    // 性能分析
    console.log(`\n${colors.yellow}【性能分析】${colors.reset}`);
    
    const streamBetter = allResults.files.filter(r => 
      r.stream?.success && r.full?.success && r.stream.duration < r.full.duration
    );
    const fullBetter = allResults.files.filter(r => 
      r.stream?.success && r.full?.success && r.stream.duration >= r.full.duration
    );
    
    console.log(`  Stream 更快的文件: ${streamBetter.length}/${allResults.files.length}`);
    console.log(`  Full 更快的文件: ${fullBetter.length}/${allResults.files.length}`);
    
    // 流量节省分析
    let totalStreamBytes = 0;
    let totalFullBytes = 0;
    for (const r of allResults.files) {
      if (r.stream?.success && r.full?.success) {
        totalStreamBytes += r.stream.totalBytes;
        totalFullBytes += r.full.downloadedBytes;
      }
    }
    
    if (totalFullBytes > 0) {
      const totalSaved = ((totalFullBytes - totalStreamBytes) / totalFullBytes * 100).toFixed(1);
      console.log(`  总流量节省: ${formatBytes(totalFullBytes - totalStreamBytes)} (${totalSaved}%)`);
    }
    
    // 总结
    console.log(`\n${colors.yellow}【总结】${colors.reset}`);
    console.log(`  总测试: ${allResults.summary.totalTests}`);
    console.log(`  通过: ${colors.green}${allResults.summary.passed}${colors.reset}`);
    console.log(`  失败: ${colors.red}${allResults.summary.failed}${colors.reset}`);
    
    if (allResults.summary.failed === 0) {
      console.log(`\n${colors.green}${colors.bold}✓ 所有测试通过！Native Stream 模式可用且稳定。${colors.reset}\n`);
    } else {
      console.log(`\n${colors.red}${colors.bold}✗ 有 ${allResults.summary.failed} 个测试失败，请检查问题。${colors.reset}\n`);
    }
    
    return allResults.summary.failed === 0;
    
  } catch (error) {
    console.error(`\n${colors.red}测试执行错误: ${error.message}${colors.reset}`);
    console.error(error.stack);
    return false;
  } finally {
    if (staticServer) {
      staticServer.close();
      console.log(`${colors.dim}静态文件服务器已停止${colors.reset}`);
    }
    
    process.exit(allResults.summary.failed === 0 ? 0 : 1);
  }
}

// 运行测试
runNativeStreamTests();
