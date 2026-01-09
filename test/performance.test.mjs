/**
 * PDF2IMG 性能测试脚本
 * 
 * 测试内容：
 * - 分片请求数量和总加载数据量
 * - 每张图片渲染耗时
 * - 总生成图片耗时
 * - 并发请求性能
 * - 内存使用情况
 */

import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试配置
const TEST_PORT = 3098;
const STATIC_PORT = 3097;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const STATIC_URL = `http://localhost:${STATIC_PORT}`;

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

// 格式化字节数
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化时间
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// HTTP Range 请求统计器
class RangeRequestTracker {
  constructor() {
    this.requests = [];
    this.totalBytes = 0;
    this.fileSize = 0;
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

// 创建静态文件服务器（带 Range 请求统计）
function createStaticServer(tracker) {
  return http.createServer((req, res) => {
    const staticDir = path.join(__dirname, '..', 'static');
    // 解码 URL 以支持中文文件名
    const decodedUrl = decodeURIComponent(req.url);
    const filePath = path.join(staticDir, decodedUrl);
    
    // 安全检查
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // 检查文件是否存在
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // 设置 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

    // 处理 HEAD 请求（不计入下载量统计）
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }

    if (range) {
      // Range 请求
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      // 记录请求
      tracker.addRequest(start, end, chunkSize);

      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/pdf',
      });
      stream.pipe(res);
    } else {
      // 完整文件请求
      tracker.addRequest(0, fileSize - 1, fileSize);
      
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// 启动测试服务器
async function startTestServer() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.blue}启动 PDF2IMG 测试服务器...${colors.reset}`);
    
    const server = spawn('node', ['app.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: TEST_PORT, NODE_ENV: 'dev' },
      stdio: 'pipe',
    });
    
    let started = false;
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes(`Server is running on port ${TEST_PORT}`) && !started) {
        started = true;
        console.log(`${colors.green}✓ PDF2IMG 服务器已启动 (端口: ${TEST_PORT})${colors.reset}`);
        resolve(server);
      }
    });
    
    server.stderr.on('data', (data) => {
      // 忽略一些常见的警告
      const msg = data.toString();
      if (!msg.includes('ExperimentalWarning') && !msg.includes('DeprecationWarning')) {
        // console.error(`${colors.dim}[服务器] ${msg}${colors.reset}`);
      }
    });
    
    server.on('error', reject);
    
    setTimeout(() => {
      if (!started) reject(new Error('服务器启动超时'));
    }, 30000);
  });
}

// 发送 PDF2IMG 请求
async function sendPdf2ImgRequest(pdfUrl, pages = [1]) {
  const startTime = Date.now();
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: pdfUrl,
      globalPadId: `perf-test-${Date.now()}`,
      pages,
    }),
  });
  
  const endTime = Date.now();
  const data = await response.json();
  
  return {
    success: response.status === 200,
    status: response.status,
    duration: endTime - startTime,
    data: data.data,
    renderer: data.renderer || 'unknown',  // 获取渲染器信息
    error: data.message,
    pagesRequested: pages,
    pagesRendered: data.data?.length || 0,
  };
}

// 测试单个 PDF 文件
async function testPdfFile(filename, tracker, pages = 'all') {
  const pdfPath = path.join(__dirname, '..', 'static', filename);
  
  if (!fs.existsSync(pdfPath)) {
    console.log(`${colors.yellow}⚠ 跳过 ${filename} (文件不存在)${colors.reset}`);
    return null;
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  // URL 编码文件名以支持中文
  const pdfUrl = `${STATIC_URL}/${encodeURIComponent(filename)}`;
  
  console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}测试文件: ${filename}${colors.reset}`);
  console.log(`${colors.dim}文件大小: ${formatBytes(fileSize)}${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  
  // 重置统计
  tracker.reset(fileSize);
  
  // 记录内存使用
  const memBefore = process.memoryUsage();
  
  // 发送请求
  const startTime = Date.now();
  const result = await sendPdf2ImgRequest(pdfUrl, pages);
  const totalDuration = Date.now() - startTime;
  
  // 获取统计数据
  const stats = tracker.getStats();
  
  // 记录内存使用
  const memAfter = process.memoryUsage();
  
  if (!result.success) {
    console.log(`${colors.red}✗ 请求失败: ${result.error}${colors.reset}`);
    return null;
  }
  
  // 输出结果
  console.log(`\n${colors.green}✓ 转换成功${colors.reset} ${colors.magenta}[${result.renderer.toUpperCase()}]${colors.reset}`);
  console.log(`\n${colors.yellow}【分片加载统计】${colors.reset}`);
  console.log(`  HTTP 请求数: ${colors.bold}${stats.requestCount}${colors.reset} 次`);
  console.log(`  总下载量: ${colors.bold}${formatBytes(stats.totalBytes)}${colors.reset}`);
  console.log(`  文件大小: ${formatBytes(stats.fileSize)}`);
  console.log(`  下载占比: ${colors.bold}${stats.percentage}%${colors.reset}`);
  
  // 分片详情
  if (stats.requests.length > 0 && stats.requests.length <= 20) {
    console.log(`\n${colors.dim}  分片详情:${colors.reset}`);
    stats.requests.forEach((req, i) => {
      console.log(`${colors.dim}    [${i + 1}] ${req.start}-${req.end} (${formatBytes(req.bytes)})${colors.reset}`);
    });
  } else if (stats.requests.length > 20) {
    console.log(`${colors.dim}  (共 ${stats.requests.length} 个分片请求，省略详情)${colors.reset}`);
  }
  
  console.log(`\n${colors.yellow}【渲染性能】${colors.reset}`);
  console.log(`  总耗时: ${colors.bold}${formatDuration(totalDuration)}${colors.reset}`);
  console.log(`  渲染页数: ${result.pagesRendered} 页`);
  
  if (result.data && result.data.length > 0) {
    const avgPerPage = totalDuration / result.data.length;
    console.log(`  平均每页: ${formatDuration(avgPerPage)}`);
    
    console.log(`\n${colors.dim}  页面详情:${colors.reset}`);
    result.data.forEach((page, i) => {
      console.log(`${colors.dim}    第 ${page.pageNum} 页: ${page.width}x${page.height}${colors.reset}`);
    });
  }
  
  console.log(`\n${colors.yellow}【内存使用】${colors.reset}`);
  console.log(`  堆内存变化: ${formatBytes(memAfter.heapUsed - memBefore.heapUsed)}`);
  console.log(`  当前堆内存: ${formatBytes(memAfter.heapUsed)}`);
  
  return {
    filename,
    fileSize,
    renderer: result.renderer,  // 添加渲染器信息
    ...stats,
    totalDuration,
    pagesRendered: result.pagesRendered,
    avgPerPage: result.data?.length > 0 ? totalDuration / result.data.length : 0,
    memoryDelta: memAfter.heapUsed - memBefore.heapUsed,
  };
}

// 真实场景并发测试 - 随机文件、随机请求
async function testRealisticConcurrency(tracker, totalRequests = 20, maxConcurrency = 5) {
  const staticDir = path.join(__dirname, '..', 'static');
  
  // 获取所有可用的 PDF 文件（覆盖不同大小范围）
  const availableFiles = [
    // 小文件
    '股权转让协议书 (2).pdf',
    '1M.pdf',
    '固收专题分析报告：城投非标手册西南篇（2019版）-20191008-国金证券-24页.pdf',
    // 中等文件
    'DJI_Osmo_Action_5_Pro_User_Manual_v1.0_chs.pdf',
    '10M.pdf',
    '流动性风险-精讲阶段讲义（上）_1.pdf',
    // 大文件
    'ISO_32000-2_sponsored-ec2.pdf',
    '四年级数学.pdf',
    'Rust语言圣经(Rust Course)-25.3.10.pdf',
    '50M.pdf',
    '80M.pdf',
  ].filter(f => fs.existsSync(path.join(staticDir, f)));
  
  if (availableFiles.length === 0) {
    console.log(`${colors.yellow}⚠ 没有可用的测试文件${colors.reset}`);
    return null;
  }
  
  console.log(`\n${colors.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}真实场景并发测试${colors.reset}`);
  console.log(`${colors.dim}  总请求数: ${totalRequests}, 最大并发: ${maxConcurrency}${colors.reset}`);
  console.log(`${colors.dim}  可用文件: ${availableFiles.join(', ')}${colors.reset}`);
  console.log(`${colors.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  
  // 重置统计（不设置单个文件大小，因为是多文件）
  tracker.reset(0);
  
  // 生成随机请求队列
  const PAGES_TO_RENDER = [1, 2, 3, 4, 5, 6];
  const requestQueue = Array(totalRequests).fill(null).map((_, i) => {
    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    return {
      id: i + 1,
      file: randomFile,
      // URL 编码文件名以支持中文
      url: `${STATIC_URL}/${encodeURIComponent(randomFile)}`,
      pages: PAGES_TO_RENDER,
    };
  });
  
  // 统计每个文件的请求数
  const fileRequestCounts = {};
  requestQueue.forEach(req => {
    fileRequestCounts[req.file] = (fileRequestCounts[req.file] || 0) + 1;
  });
  
  console.log(`\n${colors.dim}  请求分布:${colors.reset}`);
  Object.entries(fileRequestCounts).forEach(([file, count]) => {
    console.log(`${colors.dim}    ${file}: ${count} 次${colors.reset}`);
  });
  
  const results = [];
  const startTime = Date.now();
  let completedCount = 0;
  let runningCount = 0;
  let queueIndex = 0;
  
  // 使用信号量控制并发
  const executeRequest = async (request) => {
    const reqStartTime = Date.now();
    try {
      const result = await sendPdf2ImgRequest(request.url, request.pages);
      return {
        ...result,
        requestId: request.id,
        file: request.file,
        duration: Date.now() - reqStartTime,
      };
    } catch (error) {
      return {
        success: false,
        requestId: request.id,
        file: request.file,
        duration: Date.now() - reqStartTime,
        error: error.message,
      };
    }
  };
  
  // 并发执行
  const runWithConcurrency = async () => {
    const executing = new Set();
    
    while (queueIndex < requestQueue.length || executing.size > 0) {
      // 填充到最大并发数
      while (queueIndex < requestQueue.length && executing.size < maxConcurrency) {
        const request = requestQueue[queueIndex++];
        const promise = executeRequest(request).then(result => {
          executing.delete(promise);
          completedCount++;
          results.push(result);
          
          // 进度输出
          const progress = Math.floor((completedCount / totalRequests) * 100);
          process.stdout.write(`\r${colors.dim}  进度: ${completedCount}/${totalRequests} (${progress}%)${colors.reset}    `);
          
          return result;
        });
        executing.add(promise);
      }
      
      // 等待任意一个完成
      if (executing.size > 0) {
        await Promise.race(executing);
      }
    }
  };
  
  await runWithConcurrency();
  
  const totalDuration = Date.now() - startTime;
  const stats = tracker.getStats();
  
  console.log('\n'); // 换行
  
  // 统计结果
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const durations = results.map(r => r.duration);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  
  // 按文件分组统计
  const fileStats = {};
  results.forEach(r => {
    if (!fileStats[r.file]) {
      fileStats[r.file] = { success: 0, fail: 0, durations: [], renderers: {} };
    }
    if (r.success) {
      fileStats[r.file].success++;
      // 统计渲染器使用情况
      const renderer = r.renderer || 'unknown';
      fileStats[r.file].renderers[renderer] = (fileStats[r.file].renderers[renderer] || 0) + 1;
    } else {
      fileStats[r.file].fail++;
    }
    fileStats[r.file].durations.push(r.duration);
  });
  
  // 按渲染器分组统计
  const rendererStats = {};
  results.filter(r => r.success).forEach(r => {
    const renderer = r.renderer || 'unknown';
    if (!rendererStats[renderer]) {
      rendererStats[renderer] = { count: 0, durations: [] };
    }
    rendererStats[renderer].count++;
    rendererStats[renderer].durations.push(r.duration);
  });
  
  // 计算 P50, P90, P99
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p50 = sortedDurations[Math.floor(sortedDurations.length * 0.5)];
  const p90 = sortedDurations[Math.floor(sortedDurations.length * 0.9)];
  const p99 = sortedDurations[Math.floor(sortedDurations.length * 0.99)];
  
  console.log(`${colors.green}✓ 并发测试完成${colors.reset}`);
  
  console.log(`\n${colors.yellow}【总体统计】${colors.reset}`);
  console.log(`  总请求数: ${totalRequests}`);
  console.log(`  最大并发: ${maxConcurrency}`);
  console.log(`  成功: ${colors.green}${successCount}${colors.reset} / 失败: ${colors.red}${failCount}${colors.reset}`);
  console.log(`  成功率: ${colors.bold}${((successCount / totalRequests) * 100).toFixed(1)}%${colors.reset}`);
  console.log(`  总耗时: ${colors.bold}${formatDuration(totalDuration)}${colors.reset}`);
  console.log(`  吞吐量: ${colors.bold}${(successCount / (totalDuration / 1000)).toFixed(2)}${colors.reset} req/s`);
  
  console.log(`\n${colors.yellow}【响应时间分布】${colors.reset}`);
  console.log(`  平均: ${formatDuration(avgDuration)}`);
  console.log(`  最小: ${formatDuration(minDuration)}`);
  console.log(`  最大: ${formatDuration(maxDuration)}`);
  console.log(`  P50:  ${formatDuration(p50)}`);
  console.log(`  P90:  ${formatDuration(p90)}`);
  console.log(`  P99:  ${formatDuration(p99)}`);
  
  console.log(`\n${colors.yellow}【按文件统计】${colors.reset}`);
  Object.entries(fileStats).forEach(([file, stat]) => {
    const avgFileDuration = stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length;
    const successRate = ((stat.success / (stat.success + stat.fail)) * 100).toFixed(0);
    const rendererInfo = Object.entries(stat.renderers).map(([r, c]) => `${r}:${c}`).join(', ');
    console.log(`  ${file}: ${stat.success}/${stat.success + stat.fail} 成功 (${successRate}%), 平均 ${formatDuration(avgFileDuration)} [${rendererInfo}]`);
  });
  
  console.log(`\n${colors.yellow}【按渲染器统计】${colors.reset}`);
  Object.entries(rendererStats).forEach(([renderer, stat]) => {
    const avgDur = stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length;
    const color = renderer === 'native' ? colors.green : renderer === 'native-stream' ? colors.cyan : colors.yellow;
    console.log(`  ${color}${renderer.toUpperCase()}${colors.reset}: ${stat.count} 次, 平均 ${formatDuration(avgDur)}`);
  });
  
  console.log(`\n${colors.yellow}【分片加载统计】${colors.reset}`);
  console.log(`  总 HTTP 请求数: ${colors.bold}${stats.requestCount}${colors.reset} 次`);
  console.log(`  总下载量: ${colors.bold}${formatBytes(stats.totalBytes)}${colors.reset}`);
  
  // 显示失败的请求
  const failedRequests = results.filter(r => !r.success);
  if (failedRequests.length > 0) {
    console.log(`\n${colors.red}【失败请求详情】${colors.reset}`);
    failedRequests.forEach(r => {
      console.log(`${colors.red}  #${r.requestId} ${r.file}: ${r.error}${colors.reset}`);
    });
  }
  
  return {
    totalRequests,
    maxConcurrency,
    successCount,
    failCount,
    successRate: (successCount / totalRequests) * 100,
    totalDuration,
    avgDuration,
    minDuration,
    maxDuration,
    p50,
    p90,
    p99,
    throughput: successCount / (totalDuration / 1000),
    totalHttpRequests: stats.requestCount,
    totalBytes: stats.totalBytes,
    fileStats,
  };
}

// 主测试函数
async function runPerformanceTests() {
  let testServer = null;
  let staticServer = null;
  const tracker = new RangeRequestTracker();
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${colors.bold}${colors.cyan}  PDF2IMG 性能测试${colors.reset}`);
  console.log(`${'═'.repeat(70)}\n`);
  
  try {
    // 启动静态文件服务器
    staticServer = createStaticServer(tracker);
    await new Promise((resolve, reject) => {
      staticServer.listen(STATIC_PORT, () => {
        console.log(`${colors.green}✓ 静态文件服务器已启动 (端口: ${STATIC_PORT})${colors.reset}`);
        resolve();
      });
      staticServer.on('error', reject);
    });
    
    // 启动 PDF2IMG 服务器
    testServer = await startTestServer();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const results = [];
    
    // 测试文件列表
    // 固定生成 6 页
    const PAGES_TO_RENDER = [1, 2, 3, 4, 5, 6];
    
    const testFiles = [
      // 小文件 (<2MB) - 应使用单 Worker
      { file: '股权转让协议书 (2).pdf', pages: PAGES_TO_RENDER },  // 593KB
      { file: '1M.pdf', pages: PAGES_TO_RENDER },                   // 992KB
      { file: '固收专题分析报告：城投非标手册西南篇（2019版）-20191008-国金证券-24页.pdf', pages: PAGES_TO_RENDER },  // 1.75MB
      
      // 中等文件 (2-10MB) - 应适度并行
      { file: 'DJI_Osmo_Action_5_Pro_User_Manual_v1.0_chs.pdf', pages: PAGES_TO_RENDER },  // 2.78MB
      { file: '10M.pdf', pages: PAGES_TO_RENDER },                   // 8.76MB
      { file: '流动性风险-精讲阶段讲义（上）_1.pdf', pages: PAGES_TO_RENDER },  // 9.71MB
      
      // 大文件 (>10MB) - 应充分并行
      { file: 'ISO_32000-2_sponsored-ec2.pdf', pages: PAGES_TO_RENDER },  // 16.53MB
      { file: '四年级数学.pdf', pages: PAGES_TO_RENDER },           // 20.89MB
      { file: 'Rust语言圣经(Rust Course)-25.3.10.pdf', pages: PAGES_TO_RENDER },  // 34.72MB
      { file: '50M.pdf', pages: PAGES_TO_RENDER },                   // 55.31MB
      { file: '80M.pdf', pages: PAGES_TO_RENDER },                   // 77.86MB
    ];
    
    // 单文件测试
    console.log(`\n${colors.bold}【单文件性能测试】${colors.reset}`);
    
    for (const { file, pages } of testFiles) {
      const result = await testPdfFile(file, tracker, pages);
      if (result) results.push(result);
      
      // 等待一下让系统稳定
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // 真实场景并发测试
    console.log(`\n\n${colors.bold}【真实场景并发测试】${colors.reset}`);
    
    const concurrencyResults = [];
    
    // 测试不同并发级别
    const concurrencyTests = [
      { totalRequests: 10, maxConcurrency: 3 },   // 轻度负载
      { totalRequests: 20, maxConcurrency: 5 },   // 中度负载
      { totalRequests: 30, maxConcurrency: 10 },  // 高负载
    ];
    
    for (const { totalRequests, maxConcurrency } of concurrencyTests) {
      const result = await testRealisticConcurrency(tracker, totalRequests, maxConcurrency);
      if (result) concurrencyResults.push(result);
      await new Promise(resolve => setTimeout(resolve, 3000)); // 等待系统恢复
    }
    
    // 汇总报告
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log(`${colors.bold}${colors.cyan}  测试汇总报告${colors.reset}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    console.log(`${colors.yellow}【单文件测试汇总】${colors.reset}\n`);
    console.log('┌─────────────┬──────────────┬───────────────┬───────────┬──────────────┬──────────┬────────────┐');
    console.log('│ 文件        │ 文件大小     │ 渲染器        │ HTTP请求  │ 下载量       │ 下载占比 │ 总耗时     │');
    console.log('├─────────────┼──────────────┼───────────────┼───────────┼──────────────┼──────────┼────────────┤');
    
    for (const r of results) {
      const filename = r.filename.substring(0, 11).padEnd(11);
      const fileSize = formatBytes(r.fileSize).padStart(10);
      const renderer = (r.renderer || 'unknown').toUpperCase().padEnd(13);
      const requests = String(r.requestCount).padStart(7);
      const downloaded = formatBytes(r.totalBytes).padStart(10);
      const percentage = `${r.percentage}%`.padStart(6);
      const duration = formatDuration(r.totalDuration).padStart(8);
      
      console.log(`│ ${filename} │ ${fileSize} │ ${renderer} │ ${requests} │ ${downloaded} │ ${percentage} │ ${duration} │`);
    }
    
    console.log('└─────────────┴──────────────┴───────────────┴───────────┴──────────────┴──────────┴────────────┘');
    
    if (concurrencyResults.length > 0) {
      console.log(`\n${colors.yellow}【并发测试汇总】${colors.reset}\n`);
      console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬────────────┐');
      console.log('│ 请求数   │ 并发数   │ 成功率   │ 平均响应 │ P90      │ P99      │ 吞吐量     │');
      console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼────────────┤');
      
      for (const r of concurrencyResults) {
        const totalReqs = String(r.totalRequests).padStart(6);
        const maxConc = String(r.maxConcurrency).padStart(6);
        const successRate = `${r.successRate.toFixed(0)}%`.padStart(6);
        const avgDuration = formatDuration(r.avgDuration).padStart(6);
        const p90 = formatDuration(r.p90).padStart(6);
        const p99 = formatDuration(r.p99).padStart(6);
        const throughput = `${r.throughput.toFixed(2)} req/s`.padStart(8);
        
        console.log(`│ ${totalReqs} │ ${maxConc} │ ${successRate} │ ${avgDuration} │ ${p90} │ ${p99} │ ${throughput} │`);
      }
      
      console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴────────────┘');
    }
    
    // 获取服务端性能指标
    console.log(`\n${colors.yellow}【服务端性能指标】${colors.reset}\n`);
    try {
      const metricsResponse = await fetch(`${BASE_URL}/api/metrics`);
      const metricsData = await metricsResponse.json();
      
      if (metricsData.code === 200 && metricsData.data) {
        const m = metricsData.data;
        
        console.log(`${colors.cyan}请求统计:${colors.reset}`);
        console.log(`  总请求: ${m.requests.total}, 成功: ${m.requests.success}, 失败: ${m.requests.failed}`);
        console.log(`  超时: ${m.requests.timeout}, 过载拒绝: ${m.requests.overload}`);
        console.log(`  成功率: ${m.requests.successRate}`);
        
        if (m.responseTime) {
          console.log(`\n${colors.cyan}响应时间分布:${colors.reset}`);
          console.log(`  平均: ${m.responseTime.avg}ms, 最小: ${m.responseTime.min}ms, 最大: ${m.responseTime.max}ms`);
          console.log(`  P50: ${m.responseTime.p50}ms, P90: ${m.responseTime.p90}ms, P99: ${m.responseTime.p99}ms`);
        }
        
        console.log(`\n${colors.cyan}渲染统计:${colors.reset}`);
        console.log(`  总页数: ${m.render.totalPages}, 成功: ${m.render.successPages}, 失败: ${m.render.failedPages}`);
        console.log(`  成功率: ${m.render.successRate}`);
        console.log(`  平均渲染时间: ${m.render.avgRenderTime}ms`);
        console.log(`  P50: ${m.render.p50RenderTime}ms, P90: ${m.render.p90RenderTime}ms, P99: ${m.render.p99RenderTime}ms`);
        
        console.log(`\n${colors.cyan}分片加载统计:${colors.reset}`);
        console.log(`  总请求数: ${m.rangeLoader.totalRequests}, 失败: ${m.rangeLoader.failedRequests}`);
        console.log(`  总下载量: ${m.rangeLoader.totalBytesMB} MB`);
        console.log(`  平均请求时间: ${m.rangeLoader.avgRequestTime}ms, P90: ${m.rangeLoader.p90RequestTime}ms`);
        
        console.log(`\n${colors.cyan}Worker 统计:${colors.reset}`);
        console.log(`  总任务: ${m.worker.totalTasks}, 成功: ${m.worker.successTasks}, 失败: ${m.worker.failedTasks}`);
        console.log(`  平均执行时间: ${m.worker.avgExecTime}ms, P90: ${m.worker.p90ExecTime}ms`);
        
        console.log(`\n${colors.cyan}并发统计:${colors.reset}`);
        console.log(`  当前并发: ${m.concurrency.current}, 峰值并发: ${m.concurrency.peak}`);
        
        if (m.activeRequests && m.activeRequests.length > 0) {
          console.log(`\n${colors.yellow}活跃请求:${colors.reset}`);
          m.activeRequests.forEach(r => {
            console.log(`  ${r.requestId}: 已运行 ${r.elapsed}ms`);
          });
        }
      }
    } catch (error) {
      console.log(`${colors.red}获取服务端指标失败: ${error.message}${colors.reset}`);
    }
    
    console.log(`\n${colors.green}✓ 所有测试完成${colors.reset}\n`);
    
  } catch (error) {
    console.error(`${colors.red}测试执行错误: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    // 清理
    if (testServer) {
      testServer.kill();
      console.log(`${colors.dim}PDF2IMG 服务器已停止${colors.reset}`);
    }
    if (staticServer) {
      staticServer.close();
      console.log(`${colors.dim}静态文件服务器已停止${colors.reset}`);
    }
    
    process.exit(0);
  }
}

// 运行测试
runPerformanceTests();
