/**
 * 渲染器性能对比测试
 * 
 * 测试三种渲染模式的性能差异：
 * 1. Native 完全下载渲染 - 下载完整 PDF 后用 PDFium 渲染
 * 2. Native Stream 分片渲染 - 流式加载 + PDFium 渲染（V8 新增，暂不可用）
 * 3. PDF.js 分片渲染 - 分片加载 + PDF.js 渲染
 * 
 * 关键指标：
 * - 首字节时间 (TTFB)
 * - 首张图片时间 (TTFF)
 * - 总渲染时间
 * - 网络请求数
 * - 总下载字节数
 * - 内存使用
 * 
 * 注意：Native Stream 模式目前存在技术问题：
 * - Rust 的 `call_with_return_value` 不能直接处理 JS 的 async/Promise
 * - PDFium 的 `load_pdf_from_reader` 需要同步的 Read+Seek trait
 * - 需要实现 sync/async 桥接机制（如使用 tokio::task::block_in_place）
 * 
 * 运行方式：
 *   node test/renderer-comparison.test.mjs
 */

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================

const STATIC_PORT = 3099;
const STATIC_URL = `http://localhost:${STATIC_PORT}`;

// 模拟网络延迟：每 256KB 数据延迟 60ms
const CHUNK_SIZE_FOR_DELAY = 256 * 1024;  // 256KB
const DELAY_PER_CHUNK_MS = 60;            // 60ms

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

function sleep(ms) {
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
    this.startTime = Date.now();
  }

  addRequest(start, end, bytes, duration) {
    this.requests.push({ 
      start, 
      end, 
      bytes, 
      duration,
      timestamp: Date.now() - this.startTime 
    });
    this.totalBytes += bytes;
  }

  getStats() {
    const durations = this.requests.map(r => r.duration);
    return {
      requestCount: this.requests.length,
      totalBytes: this.totalBytes,
      fileSize: this.fileSize,
      percentage: this.fileSize > 0 ? ((this.totalBytes / this.fileSize) * 100).toFixed(2) : 0,
      avgRequestTime: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      requests: this.requests,
    };
  }
}

// ==================== 带延迟的静态文件服务器 ====================

function createDelayedStaticServer(tracker) {
  return http.createServer(async (req, res) => {
    const staticDir = path.join(__dirname, '..', 'static');
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

    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 处理 HEAD 请求（不计入下载量统计，不延迟）
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }

    const requestStart = Date.now();

    if (range) {
      // Range 请求
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      // 计算延迟：每 256KB 延迟 60ms
      const delayChunks = Math.ceil(chunkSize / CHUNK_SIZE_FOR_DELAY);
      const delay = delayChunks * DELAY_PER_CHUNK_MS;
      
      // 应用延迟
      if (delay > 0) {
        await sleep(delay);
      }

      const duration = Date.now() - requestStart;
      
      // 记录请求
      tracker.addRequest(start, end, chunkSize, duration);

      const buffer = Buffer.alloc(chunkSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, chunkSize, start);
      fs.closeSync(fd);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/pdf',
      });
      res.end(buffer);
    } else {
      // 完整文件请求
      const chunkSize = fileSize;
      
      // 计算延迟
      const delayChunks = Math.ceil(chunkSize / CHUNK_SIZE_FOR_DELAY);
      const delay = delayChunks * DELAY_PER_CHUNK_MS;
      
      // 应用延迟
      if (delay > 0) {
        await sleep(delay);
      }

      const duration = Date.now() - requestStart;
      
      // 记录请求
      tracker.addRequest(0, fileSize - 1, fileSize, duration);
      
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ==================== Native Renderer 测试 ====================

async function testNativeRenderer(pdfPath, pdfUrl, pageNums, tracker) {
  const nativeRendererPath = path.join(__dirname, '../native-renderer/index.js');
  const nativeRenderer = await import(nativeRendererPath);
  
  if (!nativeRenderer.isPdfiumAvailable()) {
    throw new Error('PDFium 不可用');
  }
  
  const metrics = {
    mode: 'native',
    downloadTime: 0,
    renderTime: 0,
    totalTime: 0,
    pageResults: [],
  };
  
  const totalStart = Date.now();
  tracker.reset(fs.statSync(pdfPath).size);
  
  // 下载完整 PDF
  const downloadStart = Date.now();
  const response = await fetch(pdfUrl);
  const arrayBuffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);
  metrics.downloadTime = Date.now() - downloadStart;
  
  // 渲染
  const renderStart = Date.now();
  const result = nativeRenderer.renderPages(pdfBuffer, pageNums, {
    targetWidth: 1280,
    imageHeavyWidth: 1024,
    maxScale: 4.0,
    webpQuality: 70,
    detectScan: true,
  });
  metrics.renderTime = Date.now() - renderStart;
  
  metrics.totalTime = Date.now() - totalStart;
  metrics.success = result.success;
  metrics.error = result.error;
  metrics.numPages = result.numPages;
  metrics.nativeRenderTime = result.totalTime;
  
  if (result.pages) {
    metrics.pageResults = result.pages.map(p => ({
      pageNum: p.pageNum,
      width: p.width,
      height: p.height,
      success: p.success,
      renderTime: p.renderTime,
      encodeTime: p.encodeTime,
      bufferSize: p.buffer?.length || 0,
    }));
  }
  
  metrics.rangeStats = tracker.getStats();
  
  return metrics;
}

// ==================== Native Stream 测试 ====================

async function testNativeStream(pdfPath, pdfUrl, pageNums, tracker) {
  const nativeRendererPath = path.join(__dirname, '../native-renderer/index.js');
  const nativeRenderer = await import(nativeRendererPath);
  
  if (!nativeRenderer.isPdfiumAvailable()) {
    throw new Error('PDFium 不可用');
  }
  
  if (typeof nativeRenderer.renderPagesFromStream !== 'function') {
    throw new Error('renderPagesFromStream 不可用');
  }
  
  if (typeof nativeRenderer.completeStreamRequest !== 'function') {
    throw new Error('completeStreamRequest 不可用');
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  
  const metrics = {
    mode: 'native-stream',
    downloadTime: 0,  // 流式模式没有单独的下载阶段
    renderTime: 0,
    totalTime: 0,
    pageResults: [],
    fetcherCalls: 0,
  };
  
  const totalStart = Date.now();
  tracker.reset(fileSize);
  
  // 定义 fetcher 回调
  // 注意：NAPI-RS ThreadsafeFunction 会在参数前添加一个额外的参数（通常是 null）
  // 所以实际参数是从第二个开始的
  const fetcher = (_unused, offset, size, requestId) => {
    metrics.fetcherCalls++;
    const start = Math.floor(offset);
    const end = start + size - 1;
    
    // 异步获取数据
    fetch(pdfUrl, {
      headers: { 'Range': `bytes=${start}-${end}` },
    })
      .then(async (response) => {
        if (!response.ok && response.status !== 206) {
          throw new Error(`Range 请求失败: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        // 发送数据给 Rust
        nativeRenderer.completeStreamRequest(requestId, buffer, null);
      })
      .catch((error) => {
        // 发送错误给 Rust
        nativeRenderer.completeStreamRequest(requestId, null, error.message);
      });
  };
  
  // 渲染（现在返回 Promise）
  const renderStart = Date.now();
  const result = await nativeRenderer.renderPagesFromStream(
    fileSize,
    pageNums,
    {
      targetWidth: 1280,
      imageHeavyWidth: 1024,
      maxScale: 4.0,
      webpQuality: 70,
      detectScan: true,
    },
    fetcher
  );
  metrics.renderTime = Date.now() - renderStart;
  
  metrics.totalTime = Date.now() - totalStart;
  metrics.success = result.success;
  metrics.error = result.error;
  metrics.numPages = result.numPages;
  metrics.nativeRenderTime = result.totalTime;
  metrics.streamStats = result.streamStats;
  
  if (result.pages) {
    metrics.pageResults = result.pages.map(p => ({
      pageNum: p.pageNum,
      width: p.width,
      height: p.height,
      success: p.success,
      renderTime: p.renderTime,
      encodeTime: p.encodeTime,
      bufferSize: p.buffer?.length || 0,
    }));
  }
  
  metrics.rangeStats = tracker.getStats();
  
  return metrics;
}

// ==================== PDF.js 测试 ====================

async function testPdfjs(pdfPath, pdfUrl, pageNums, tracker) {
  // 动态导入 PDF.js 和相关模块
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { default: sharp } = await import('sharp');
  
  const fileSize = fs.statSync(pdfPath).size;
  
  const metrics = {
    mode: 'pdfjs',
    downloadTime: 0,
    parseTime: 0,
    renderTime: 0,
    totalTime: 0,
    pageResults: [],
  };
  
  const totalStart = Date.now();
  tracker.reset(fileSize);
  
  // 获取初始数据
  const initialResponse = await fetch(pdfUrl, {
    headers: { 'Range': 'bytes=0-65535' },  // 64KB 初始数据
  });
  const initialData = await initialResponse.arrayBuffer();
  
  // 创建符合 PDF.js PDFDataRangeTransport 接口的加载器
  class RangeTransport {
    constructor(length, initialData, url) {
      this.length = length;
      this.initialData = new Uint8Array(initialData);
      this.url = url;
      this._progressListeners = [];
      this._progressiveReadListeners = [];
      this._readyCapability = { promise: Promise.resolve() };
    }
    
    get contentLength() {
      return this.length;
    }
    
    addRangeListener(listener) {
      // PDF.js 会调用这个来注册 range 数据接收回调
    }
    
    addProgressListener(listener) {
      this._progressListeners.push(listener);
    }
    
    addProgressiveReadListener(listener) {
      this._progressiveReadListeners.push(listener);
    }
    
    async requestDataRange(begin, end) {
      try {
        const response = await fetch(this.url, {
          headers: { 'Range': `bytes=${begin}-${end - 1}` },
        });
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (error) {
        console.error(`Range request failed: ${begin}-${end}`, error);
        throw error;
      }
    }
    
    // 实现 read 方法供 PDF.js 使用
    async read(begin, end) {
      // 如果请求的范围在初始数据内
      if (begin < this.initialData.length && end <= this.initialData.length) {
        return new Uint8Array(this.initialData.buffer, begin, end - begin);
      }
      
      // 否则发起 Range 请求
      return this.requestDataRange(begin, end);
    }
    
    abort() {}
  }
  
  const rangeLoader = new RangeTransport(fileSize, initialData, pdfUrl);
  
  // 加载 PDF - 使用 data 方式加载初始数据，然后按需加载其他部分
  // 对于测试目的，我们直接下载完整文件来简化
  const parseStart = Date.now();
  
  // 简化测试：直接下载完整文件
  const fullResponse = await fetch(pdfUrl);
  const fullData = await fullResponse.arrayBuffer();
  
  const loadingTask = getDocument({
    data: new Uint8Array(fullData),
    useSystemFonts: true,
  });
  const pdfDocument = await loadingTask.promise;
  metrics.parseTime = Date.now() - parseStart;
  metrics.numPages = pdfDocument.numPages;
  
  // 渲染每一页
  const renderStart = Date.now();
  
  for (const pageNum of pageNums) {
    if (pageNum > pdfDocument.numPages) continue;
    
    const pageStart = Date.now();
    const page = await pdfDocument.getPage(pageNum);
    
    // 计算缩放
    const viewport = page.getViewport({ scale: 1.0 });
    const targetWidth = 1280;
    const scale = Math.min(targetWidth / viewport.width, 4.0);
    const scaledViewport = page.getViewport({ scale });
    
    const width = Math.round(scaledViewport.width);
    const height = Math.round(scaledViewport.height);
    
    // 渲染到 canvas
    const canvasAndContext = pdfDocument.canvasFactory.create(width, height);
    await page.render({
      canvasContext: canvasAndContext.context,
      viewport: scaledViewport,
    }).promise;
    
    // 编码为 WebP
    const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
    const webpBuffer = await sharp(Buffer.from(imageData.data.buffer), {
      raw: { width, height, channels: 4 },
    }).webp({ quality: 70 }).toBuffer();
    
    const pageTime = Date.now() - pageStart;
    
    metrics.pageResults.push({
      pageNum,
      width,
      height,
      success: true,
      renderTime: pageTime,
      bufferSize: webpBuffer.length,
    });
    
    // 清理
    page.cleanup();
    pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
  }
  
  metrics.renderTime = Date.now() - renderStart;
  metrics.totalTime = Date.now() - totalStart;
  metrics.success = true;
  
  // 清理
  await pdfDocument.destroy();
  
  metrics.rangeStats = tracker.getStats();
  
  return metrics;
}

// ==================== 测试单个文件 ====================

async function testFile(filename, pageNums, tracker, staticServer) {
  const pdfPath = path.join(__dirname, '..', 'static', filename);
  
  if (!fs.existsSync(pdfPath)) {
    console.log(`${colors.yellow}⚠ 跳过 ${filename} (文件不存在)${colors.reset}`);
    return null;
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  const pdfUrl = `${STATIC_URL}/${encodeURIComponent(filename)}`;
  
  console.log(`\n${colors.cyan}${'━'.repeat(70)}${colors.reset}`);
  console.log(`${colors.bold}测试文件: ${filename}${colors.reset}`);
  console.log(`${colors.dim}文件大小: ${formatBytes(fileSize)}, 测试页码: [${pageNums.join(', ')}]${colors.reset}`);
  console.log(`${colors.dim}网络延迟模拟: ${DELAY_PER_CHUNK_MS}ms / ${formatBytes(CHUNK_SIZE_FOR_DELAY)}${colors.reset}`);
  console.log(`${colors.cyan}${'━'.repeat(70)}${colors.reset}`);
  
  const results = {};
  
  // 测试 Native 完全下载
  console.log(`\n${colors.blue}[1/3] Native 完全下载渲染...${colors.reset}`);
  try {
    results.native = await testNativeRenderer(pdfPath, pdfUrl, pageNums, tracker);
    console.log(`${colors.green}✓ 完成${colors.reset} - 总耗时: ${formatDuration(results.native.totalTime)}`);
  } catch (error) {
    console.log(`${colors.red}✗ 失败: ${error.message}${colors.reset}`);
    results.native = { mode: 'native', success: false, error: error.message };
  }
  
  // 等待一下
  await sleep(500);
  
  // 测试 Native Stream
  console.log(`\n${colors.blue}[2/3] Native Stream 分片渲染...${colors.reset}`);
  try {
    results.nativeStream = await testNativeStream(pdfPath, pdfUrl, pageNums, tracker);
    console.log(`${colors.green}✓ 完成${colors.reset} - 总耗时: ${formatDuration(results.nativeStream.totalTime)}`);
  } catch (error) {
    console.log(`${colors.red}✗ 失败: ${error.message}${colors.reset}`);
    results.nativeStream = { mode: 'native-stream', success: false, error: error.message };
  }
  
  // 等待一下
  await sleep(500);
  
  // 测试 PDF.js
  console.log(`\n${colors.blue}[3/3] PDF.js 分片渲染...${colors.reset}`);
  try {
    results.pdfjs = await testPdfjs(pdfPath, pdfUrl, pageNums, tracker);
    console.log(`${colors.green}✓ 完成${colors.reset} - 总耗时: ${formatDuration(results.pdfjs.totalTime)}`);
  } catch (error) {
    console.log(`${colors.red}✗ 失败: ${error.message}${colors.reset}`);
    results.pdfjs = { mode: 'pdfjs', success: false, error: error.message };
  }
  
  // 输出对比结果
  console.log(`\n${colors.yellow}【性能对比】${colors.reset}`);
  console.log('┌────────────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐');
  console.log('│ 渲染模式           │ 总耗时     │ 下载耗时   │ 渲染耗时   │ 请求次数   │ 下载量     │');
  console.log('├────────────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤');
  
  const modes = [
    { key: 'native', name: 'Native 完全下载' },
    { key: 'nativeStream', name: 'Native Stream' },
    { key: 'pdfjs', name: 'PDF.js 分片' },
  ];
  
  for (const { key, name } of modes) {
    const r = results[key];
    if (!r || !r.success) {
      console.log(`│ ${name.padEnd(18)} │ ${colors.red}失败${colors.reset}       │            │            │            │            │`);
      continue;
    }
    
    const totalTime = formatDuration(r.totalTime).padStart(10);
    const downloadTime = formatDuration(r.downloadTime || 0).padStart(10);
    const renderTime = formatDuration(r.renderTime).padStart(10);
    const requestCount = String(r.rangeStats?.requestCount || 0).padStart(10);
    const totalBytes = formatBytes(r.rangeStats?.totalBytes || 0).padStart(10);
    
    console.log(`│ ${name.padEnd(18)} │ ${totalTime} │ ${downloadTime} │ ${renderTime} │ ${requestCount} │ ${totalBytes} │`);
  }
  
  console.log('└────────────────────┴────────────┴────────────┴────────────┴────────────┴────────────┘');
  
  // 计算效率提升
  if (results.native?.success && results.nativeStream?.success) {
    const improvement = ((results.native.totalTime - results.nativeStream.totalTime) / results.native.totalTime * 100).toFixed(1);
    const byteSaving = ((results.native.rangeStats.totalBytes - results.nativeStream.rangeStats.totalBytes) / results.native.rangeStats.totalBytes * 100).toFixed(1);
    
    console.log(`\n${colors.cyan}Native Stream vs Native 完全下载:${colors.reset}`);
    console.log(`  时间节省: ${improvement > 0 ? colors.green : colors.red}${improvement}%${colors.reset}`);
    console.log(`  流量节省: ${byteSaving > 0 ? colors.green : colors.red}${byteSaving}%${colors.reset}`);
  }
  
  if (results.pdfjs?.success && results.nativeStream?.success) {
    const improvement = ((results.pdfjs.totalTime - results.nativeStream.totalTime) / results.pdfjs.totalTime * 100).toFixed(1);
    
    console.log(`\n${colors.cyan}Native Stream vs PDF.js:${colors.reset}`);
    console.log(`  时间节省: ${improvement > 0 ? colors.green : colors.red}${improvement}%${colors.reset}`);
  }
  
  // 输出详细的每页渲染时间
  console.log(`\n${colors.yellow}【每页渲染详情】${colors.reset}`);
  
  for (const { key, name } of modes) {
    const r = results[key];
    if (!r?.success || !r.pageResults?.length) continue;
    
    console.log(`\n${colors.dim}${name}:${colors.reset}`);
    for (const page of r.pageResults) {
      const info = `  第 ${page.pageNum} 页: ${page.width}x${page.height}, 渲染 ${page.renderTime}ms`;
      const extra = page.encodeTime ? `, 编码 ${page.encodeTime}ms` : '';
      const size = page.bufferSize ? `, 输出 ${formatBytes(page.bufferSize)}` : '';
      console.log(`${colors.dim}${info}${extra}${size}${colors.reset}`);
    }
  }
  
  return {
    filename,
    fileSize,
    pageNums,
    results,
  };
}

// ==================== 主测试函数 ====================

async function runComparisonTests() {
  let staticServer = null;
  const tracker = new RangeRequestTracker();
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${colors.bold}${colors.cyan}  渲染器性能对比测试${colors.reset}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`${colors.dim}  网络延迟模拟: 每 ${formatBytes(CHUNK_SIZE_FOR_DELAY)} 延迟 ${DELAY_PER_CHUNK_MS}ms${colors.reset}`);
  console.log(`${'═'.repeat(70)}\n`);
  
  try {
    // 启动静态文件服务器
    staticServer = createDelayedStaticServer(tracker);
    await new Promise((resolve, reject) => {
      staticServer.listen(STATIC_PORT, () => {
        console.log(`${colors.green}✓ 静态文件服务器已启动 (端口: ${STATIC_PORT})${colors.reset}`);
        resolve();
      });
      staticServer.on('error', reject);
    });
    
    const allResults = [];
    
    // 测试文件列表（按大小分类）
    const testFiles = [
      // 小文件 (<3MB) - Native 应该最快
      { file: '股权转让协议书 (2).pdf', pages: [1, 2, 3] },
      
      // 中等文件 (3-20MB) - 测试分片效果
      { file: 'DJI_Osmo_Action_5_Pro_User_Manual_v1.0_chs.pdf', pages: [1, 2, 3, 4, 5, 6] },
      { file: '10M.pdf', pages: [1, 2, 3, 4, 5, 6] },
      
      // 大文件 (>20MB) - Native Stream 应该优于完全下载
      { file: 'ISO_32000-2_sponsored-ec2.pdf', pages: [1, 2, 3, 4, 5, 6] },
      { file: '四年级数学.pdf', pages: [1, 2, 3, 4, 5, 6] },
      { file: 'Rust语言圣经(Rust Course)-25.3.10.pdf', pages: [1, 2, 3, 4, 5, 6] },
    ];
    
    for (const { file, pages } of testFiles) {
      const result = await testFile(file, pages, tracker, staticServer);
      if (result) {
        allResults.push(result);
      }
      
      // 等待系统稳定
      await sleep(1000);
    }
    
    // 汇总报告
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log(`${colors.bold}${colors.cyan}  汇总报告${colors.reset}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    console.log(`${colors.yellow}【总体性能对比】${colors.reset}\n`);
    console.log('┌──────────────────────────────┬────────────┬────────────┬────────────┬────────────┐');
    console.log('│ 文件                         │ Native     │ NativeStrm │ PDF.js     │ 最快       │');
    console.log('├──────────────────────────────┼────────────┼────────────┼────────────┼────────────┤');
    
    for (const r of allResults) {
      const filename = r.filename.length > 28 ? r.filename.substring(0, 25) + '...' : r.filename;
      const nativeTime = r.results.native?.success ? formatDuration(r.results.native.totalTime) : 'N/A';
      const streamTime = r.results.nativeStream?.success ? formatDuration(r.results.nativeStream.totalTime) : 'N/A';
      const pdfjsTime = r.results.pdfjs?.success ? formatDuration(r.results.pdfjs.totalTime) : 'N/A';
      
      // 找出最快的
      const times = [
        { name: 'Native', time: r.results.native?.totalTime || Infinity },
        { name: 'NativeStrm', time: r.results.nativeStream?.totalTime || Infinity },
        { name: 'PDF.js', time: r.results.pdfjs?.totalTime || Infinity },
      ].filter(t => t.time !== Infinity);
      
      const fastest = times.length > 0 ? times.reduce((a, b) => a.time < b.time ? a : b).name : 'N/A';
      
      console.log(`│ ${filename.padEnd(28)} │ ${nativeTime.padStart(10)} │ ${streamTime.padStart(10)} │ ${pdfjsTime.padStart(10)} │ ${fastest.padStart(10)} │`);
    }
    
    console.log('└──────────────────────────────┴────────────┴────────────┴────────────┴────────────┘');
    
    // 流量对比
    console.log(`\n${colors.yellow}【流量消耗对比】${colors.reset}\n`);
    console.log('┌──────────────────────────────┬────────────┬────────────┬────────────┬────────────┐');
    console.log('│ 文件                         │ 文件大小   │ Native     │ NativeStrm │ PDF.js     │');
    console.log('├──────────────────────────────┼────────────┼────────────┼────────────┼────────────┤');
    
    for (const r of allResults) {
      const filename = r.filename.length > 28 ? r.filename.substring(0, 25) + '...' : r.filename;
      const fileSize = formatBytes(r.fileSize);
      const nativeBytes = r.results.native?.rangeStats ? formatBytes(r.results.native.rangeStats.totalBytes) : 'N/A';
      const streamBytes = r.results.nativeStream?.rangeStats ? formatBytes(r.results.nativeStream.rangeStats.totalBytes) : 'N/A';
      const pdfjsBytes = r.results.pdfjs?.rangeStats ? formatBytes(r.results.pdfjs.rangeStats.totalBytes) : 'N/A';
      
      console.log(`│ ${filename.padEnd(28)} │ ${fileSize.padStart(10)} │ ${nativeBytes.padStart(10)} │ ${streamBytes.padStart(10)} │ ${pdfjsBytes.padStart(10)} │`);
    }
    
    console.log('└──────────────────────────────┴────────────┴────────────┴────────────┴────────────┘');
    
    // 结论
    console.log(`\n${colors.yellow}【结论】${colors.reset}`);
    
    let nativeWins = 0, streamWins = 0, pdfjsWins = 0;
    
    for (const r of allResults) {
      const times = [
        { name: 'native', time: r.results.native?.totalTime || Infinity },
        { name: 'stream', time: r.results.nativeStream?.totalTime || Infinity },
        { name: 'pdfjs', time: r.results.pdfjs?.totalTime || Infinity },
      ].filter(t => t.time !== Infinity);
      
      if (times.length > 0) {
        const fastest = times.reduce((a, b) => a.time < b.time ? a : b);
        if (fastest.name === 'native') nativeWins++;
        else if (fastest.name === 'stream') streamWins++;
        else pdfjsWins++;
      }
    }
    
    console.log(`  Native 完全下载最快: ${nativeWins} 次`);
    console.log(`  Native Stream 最快: ${streamWins} 次`);
    console.log(`  PDF.js 最快: ${pdfjsWins} 次`);
    
    console.log(`\n${colors.green}✓ 所有测试完成${colors.reset}\n`);
    
  } catch (error) {
    console.error(`${colors.red}测试执行错误: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    if (staticServer) {
      staticServer.close();
      console.log(`${colors.dim}静态文件服务器已停止${colors.reset}`);
    }
    
    process.exit(0);
  }
}

// 运行测试
runComparisonTests();
