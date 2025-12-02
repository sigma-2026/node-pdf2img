/**
 * 压测脚本 - 使用 autocannon 进行性能测试
 * 
 * 使用方法:
 *   npm run benchmark              # 运行所有压测
 *   npm run benchmark:health       # 只测试 health 接口
 *   npm run benchmark:pdf2img      # 只测试 pdf2img 接口
 *
 * 环境变量:
 *   BASE_URL          - 目标服务器地址，默认 http://localhost:3000
 *   DURATION          - 压测持续时间(秒)，默认 30
 *   CONNECTIONS       - 并发连接数，默认 10
 *   PIPELINING        - 管道请求数，默认 1
 *   PDF_URL           - 用于测试的 PDF 文件 URL
 */
// 自定义参数
// DURATION=30 CONNECTIONS=4 npm run benchmark:pdf2img

import autocannon from 'autocannon';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

// 获取当前目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置参数
const config = {
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  duration: parseInt(process.env.DURATION) || 30,           // 持续时间(秒)
  connections: parseInt(process.env.CONNECTIONS) || 20,     // 并发连接数
  pipelining: parseInt(process.env.PIPELINING) || 1,        // HTTP 管道请求数
  timeout: parseInt(process.env.TIMEOUT) || 40,             // 请求超时时间(秒)
  // 用于 pdf2img 测试的 PDF 文件 URL
  pdfUrl: process.env.PDF_URL || 'http://localhost:3000/static/1M.pdf',
};

// 报告输出目录
const reportDir = path.join(__dirname, '../reports');

// 确保报告目录存在
if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true });
}

/**
 * 生成时间戳字符串
 */
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 格式化数字，保留两位小数
 */
function formatNumber(num) {
  return typeof num === 'number' ? num.toFixed(2) : num;
}

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 系统资源监控类
 */
class ResourceMonitor {
  constructor(interval = 1000) {
    this.interval = interval;
    this.samples = [];
    this.timer = null;
    this.previousCpuInfo = null;
  }

  /**
   * 获取 CPU 使用率
   */
  getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;

    if (this.previousCpuInfo) {
      const idleDiff = idle - this.previousCpuInfo.idle;
      const totalDiff = total - this.previousCpuInfo.total;
      const usage = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100) : 0;
      this.previousCpuInfo = { idle, total };
      return Math.max(0, Math.min(100, usage));
    }

    this.previousCpuInfo = { idle, total };
    return 0;
  }

  /**
   * 获取内存使用情况
   */
  getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percentage: (usedMem / totalMem) * 100,
    };
  }

  /**
   * 获取进程内存使用
   */
  getProcessMemory() {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,           // 常驻内存
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
    };
  }

  /**
   * 采集一次样本
   */
  sample() {
    const timestamp = Date.now();
    const cpuUsage = this.getCpuUsage();
    const memoryUsage = this.getMemoryUsage();
    const processMemory = this.getProcessMemory();

    this.samples.push({
      timestamp,
      cpu: cpuUsage,
      memory: memoryUsage,
      processMemory,
    });
  }

  /**
   * 开始监控
   */
  start() {
    this.samples = [];
    this.previousCpuInfo = null;
    // 先采集一次以初始化 CPU 基准
    this.sample();
    this.timer = setInterval(() => this.sample(), this.interval);
    console.log('📊 资源监控已启动...');
  }

  /**
   * 停止监控
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('📊 资源监控已停止');
  }

  /**
   * 获取统计摘要
   */
  getSummary() {
    if (this.samples.length === 0) {
      return null;
    }

    const cpuValues = this.samples.map(s => s.cpu).filter(v => v > 0);
    const memValues = this.samples.map(s => s.memory.percentage);
    const memUsedValues = this.samples.map(s => s.memory.used);

    const calcStats = (values) => {
      if (values.length === 0) return { avg: 0, min: 0, max: 0 };
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        avg: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      };
    };

    return {
      cpu: calcStats(cpuValues),
      memoryPercentage: calcStats(memValues),
      memoryUsed: calcStats(memUsedValues),
      totalMemory: os.totalmem(),
      samples: this.samples,
      sampleCount: this.samples.length,
    };
  }
}

// 全局资源监控实例
const resourceMonitor = new ResourceMonitor(1000);

/**
 * 生成 HTML 报告
 */
function generateHtmlReport(result, testName, resourceStats = null) {
  const timestamp = getTimestamp();
  
  // 资源监控部分的 HTML
  const resourceHtml = resourceStats ? `
      <div class="card">
        <h3>🖥️ CPU 使用率</h3>
        <div class="metric">
          <span class="metric-label">平均 CPU</span>
          <span class="metric-value">${formatNumber(resourceStats.cpu.avg)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">最小 CPU</span>
          <span class="metric-value">${formatNumber(resourceStats.cpu.min)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">最大 CPU</span>
          <span class="metric-value ${resourceStats.cpu.max > 80 ? 'warning' : ''}">${formatNumber(resourceStats.cpu.max)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">CPU 核心数</span>
          <span class="metric-value">${os.cpus().length}</span>
        </div>
      </div>

      <div class="card">
        <h3>💾 内存使用</h3>
        <div class="metric">
          <span class="metric-label">总内存</span>
          <span class="metric-value">${formatBytes(resourceStats.totalMemory)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">平均使用</span>
          <span class="metric-value">${formatNumber(resourceStats.memoryPercentage.avg)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">最大使用</span>
          <span class="metric-value ${resourceStats.memoryPercentage.max > 80 ? 'warning' : ''}">${formatNumber(resourceStats.memoryPercentage.max)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">平均使用量</span>
          <span class="metric-value">${formatBytes(resourceStats.memoryUsed.avg)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">采样次数</span>
          <span class="metric-value">${resourceStats.sampleCount}</span>
        </div>
      </div>
  ` : '';
  
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>压测报告 - ${testName} - ${timestamp}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      background: white;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header h1 { color: #333; margin-bottom: 10px; }
    .header .meta { color: #666; font-size: 14px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .card h3 { color: #333; margin-bottom: 16px; font-size: 16px; border-bottom: 2px solid #667eea; padding-bottom: 8px; }
    .metric { display: flex; justify-content: space-between; margin-bottom: 12px; }
    .metric-label { color: #666; }
    .metric-value { font-weight: 600; color: #333; }
    .metric-value.success { color: #10b981; }
    .metric-value.error { color: #ef4444; }
    .metric-value.warning { color: #f59e0b; }
    .summary-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .summary-card h3 { color: white; border-bottom-color: rgba(255,255,255,0.3); }
    .summary-card .metric-label { color: rgba(255,255,255,0.8); }
    .summary-card .metric-value { color: white; }
    .big-number { font-size: 48px; font-weight: 700; text-align: center; margin: 20px 0; }
    .latency-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .latency-table th, .latency-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
    .latency-table th { background: #f8f9fa; color: #333; font-weight: 600; }
    .section-title { 
      background: white; 
      border-radius: 12px; 
      padding: 16px 24px; 
      margin: 20px 0; 
      font-size: 18px; 
      font-weight: 600;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .footer { text-align: center; color: white; padding: 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 PDF2IMG 压测报告</h1>
      <div class="meta">
        <p><strong>测试名称:</strong> ${testName}</p>
        <p><strong>目标 URL:</strong> ${result.url}</p>
        <p><strong>测试时间:</strong> ${timestamp}</p>
        <p><strong>测试配置:</strong> 持续 ${result.duration}秒 | ${result.connections} 并发连接 | ${result.pipelining} 管道</p>
      </div>
    </div>

    <div class="cards">
      <div class="card summary-card">
        <h3>📊 核心指标</h3>
        <div class="big-number">${formatNumber(result.requests.average)}</div>
        <p style="text-align: center; margin-bottom: 20px;">平均 RPS (每秒请求数)</p>
        <div class="metric">
          <span class="metric-label">总请求数</span>
          <span class="metric-value">${result.requests.total.toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">总数据量</span>
          <span class="metric-value">${(result.throughput.total / 1024 / 1024).toFixed(2)} MB</span>
        </div>
      </div>

      <div class="card">
        <h3>⏱️ 延迟统计 (ms)</h3>
        <table class="latency-table">
          <tr><th>指标</th><th>值</th></tr>
          <tr><td>平均延迟</td><td>${formatNumber(result.latency.average)} ms</td></tr>
          <tr><td>最小延迟</td><td>${formatNumber(result.latency.min)} ms</td></tr>
          <tr><td>最大延迟</td><td>${formatNumber(result.latency.max)} ms</td></tr>
          <tr><td>标准差</td><td>${formatNumber(result.latency.stddev)} ms</td></tr>
          <tr><td>P50</td><td>${formatNumber(result.latency.p50)} ms</td></tr>
          <tr><td>P90</td><td>${formatNumber(result.latency.p90)} ms</td></tr>
          <tr><td>P99</td><td>${formatNumber(result.latency.p99)} ms</td></tr>
        </table>
      </div>

      <div class="card">
        <h3>📈 吞吐量</h3>
        <div class="metric">
          <span class="metric-label">平均吞吐量</span>
          <span class="metric-value">${(result.throughput.average / 1024).toFixed(2)} KB/s</span>
        </div>
        <div class="metric">
          <span class="metric-label">最大吞吐量</span>
          <span class="metric-value">${(result.throughput.max / 1024).toFixed(2)} KB/s</span>
        </div>
        <div class="metric">
          <span class="metric-label">最小吞吐量</span>
          <span class="metric-value">${(result.throughput.min / 1024).toFixed(2)} KB/s</span>
        </div>
      </div>

      <div class="card">
        <h3>✅ 请求状态</h3>
        <div class="metric">
          <span class="metric-label">成功请求 (2xx)</span>
          <span class="metric-value success">${(result['2xx'] || 0).toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">客户端错误 (4xx)</span>
          <span class="metric-value ${result['4xx'] > 0 ? 'warning' : ''}">${(result['4xx'] || 0).toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">服务端错误 (5xx)</span>
          <span class="metric-value ${result['5xx'] > 0 ? 'error' : ''}">${(result['5xx'] || 0).toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">超时/连接错误</span>
          <span class="metric-value ${result.errors > 0 ? 'error' : ''}">${(result.errors || 0).toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">超时数</span>
          <span class="metric-value ${result.timeouts > 0 ? 'error' : ''}">${(result.timeouts || 0).toLocaleString()}</span>
        </div>
      </div>
    </div>

    ${resourceStats ? '<div class="section-title">🖥️ 系统资源监控</div>' : ''}
    <div class="cards">
      ${resourceHtml}
    </div>

    <div class="footer">
      <p>由 autocannon 生成 | PDF2IMG 性能测试</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 运行单个压测
 */
async function runBenchmark(options) {
  const { name, url, method = 'GET', body = null, headers = {} } = options;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 开始压测: ${name}`);
  console.log(`📍 目标 URL: ${url}`);
  console.log(`⏱️  持续时间: ${config.duration}秒`);
  console.log(`🔗 并发连接: ${config.connections}`);
  console.log(`${'='.repeat(60)}\n`);

  const autocannonOptions = {
    url,
    method,
    connections: config.connections,
    duration: config.duration,
    pipelining: config.pipelining,
    timeout: config.timeout,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body) {
    autocannonOptions.body = JSON.stringify(body);
  }

  // 启动资源监控
  resourceMonitor.start();

  return new Promise((resolve, reject) => {
    const instance = autocannon(autocannonOptions, (err, result) => {
      // 停止资源监控
      resourceMonitor.stop();
      
      if (err) {
        reject(err);
        return;
      }
      
      // 将资源统计附加到结果中
      result.resourceStats = resourceMonitor.getSummary();
      resolve(result);
    });

    // 实时显示进度
    autocannon.track(instance, { renderProgressBar: true });
  });
}

/**
 * 保存报告
 */
function saveReport(result, testName) {
  const timestamp = getTimestamp();
  const safeName = testName.replace(/[^a-zA-Z0-9-_]/g, '_');
  
  // 保存 JSON 报告
  const jsonPath = path.join(reportDir, `${safeName}-${timestamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`📄 JSON 报告已保存: ${jsonPath}`);
  
  // 保存 HTML 报告（包含资源统计）
  const htmlPath = path.join(reportDir, `${safeName}-${timestamp}.html`);
  writeFileSync(htmlPath, generateHtmlReport(result, testName, result.resourceStats));
  console.log(`📊 HTML 报告已保存: ${htmlPath}`);
  
  return { jsonPath, htmlPath };
}

/**
 * 打印结果摘要
 */
function printSummary(result, testName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 ${testName} 压测结果摘要`);
  console.log(`${'='.repeat(60)}`);
  console.log(`请求总数:     ${result.requests.total.toLocaleString()}`);
  console.log(`平均 RPS:     ${formatNumber(result.requests.average)}`);
  console.log(`平均延迟:     ${formatNumber(result.latency.average)} ms`);
  console.log(`P99 延迟:     ${formatNumber(result.latency.p99)} ms`);
  console.log(`吞吐量:       ${(result.throughput.average / 1024).toFixed(2)} KB/s`);
  console.log(`成功 (2xx):   ${(result['2xx'] || 0).toLocaleString()}`);
  console.log(`错误:         ${(result.errors || 0).toLocaleString()}`);
  
  // 打印资源使用情况
  if (result.resourceStats) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`📊 系统资源使用`);
    console.log(`平均 CPU:     ${formatNumber(result.resourceStats.cpu.avg)}%`);
    console.log(`最大 CPU:     ${formatNumber(result.resourceStats.cpu.max)}%`);
    console.log(`平均内存:     ${formatNumber(result.resourceStats.memoryPercentage.avg)}% (${formatBytes(result.resourceStats.memoryUsed.avg)})`);
    console.log(`最大内存:     ${formatNumber(result.resourceStats.memoryPercentage.max)}%`);
  }
  
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * 测试 health 接口
 */
async function benchmarkHealth() {
  const result = await runBenchmark({
    name: 'Health Check API',
    url: `${config.baseUrl}/api/health`,
    method: 'GET',
  });
  
  printSummary(result, 'Health Check');
  saveReport(result, 'health-check');
  
  return result;
}

/**
 * 测试 pdf2img 接口
 */
async function benchmarkPdf2img() {
  const result = await runBenchmark({
    name: 'PDF to Image API',
    url: `${config.baseUrl}/api/pdf2img`,
    method: 'POST',
    body: {
      url: config.pdfUrl,
      globalPadId: `benchmark-${Date.now()}`,
      pages: [1, 2, 3, 4, 5],  // 多页渲染测试并行效果
    },
  });
  
  printSummary(result, 'PDF to Image');
  saveReport(result, 'pdf2img');
  
  return result;
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const testType = args[0] || 'all';
  
  console.log('\n🎯 PDF2IMG 性能压测工具');
  console.log(`📡 目标服务: ${config.baseUrl}`);
  console.log(`⚙️  配置: ${config.duration}s / ${config.connections} 连接 / ${config.pipelining} 管道\n`);

  const results = {};

  try {
    switch (testType) {
      case 'health':
        results.health = await benchmarkHealth();
        break;
      case 'pdf2img':
        results.pdf2img = await benchmarkPdf2img();
        break;
      case 'all':
      default:
        // 依次运行所有测试
        console.log('🔄 运行所有压测...\n');
        results.health = await benchmarkHealth();
        
        // 在测试之间休息几秒，让服务器恢复
        console.log('\n⏳ 等待 5 秒后继续下一个测试...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        results.pdf2img = await benchmarkPdf2img();
        break;
    }

    // 生成汇总报告
    const timestamp = getTimestamp();
    const summaryPath = path.join(reportDir, `summary-${timestamp}.json`);
    writeFileSync(summaryPath, JSON.stringify({
      timestamp,
      config,
      results,
    }, null, 2));
    
    console.log(`\n✅ 所有压测完成！`);
    console.log(`📁 报告目录: ${reportDir}`);
    console.log(`📋 汇总报告: ${summaryPath}\n`);

  } catch (error) {
    console.error('\n❌ 压测失败:', error.message);
    process.exit(1);
  }
}

// 运行主函数
main();
