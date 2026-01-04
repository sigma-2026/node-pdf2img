#!/usr/bin/env node

/**
 * 健康检查高负载测试脚本
 * 测试 /api/health 接口的高负载丢弃功能
 */

import fetch from 'node-fetch';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  log(title, 'cyan');
  console.log('='.repeat(70));
}

/**
 * 测试健康检查接口
 */
async function testHealthCheck() {
  logSection('测试健康检查接口');
  
  try {
    log('\n发送健康检查请求...', 'blue');
    const startTime = Date.now();
    
    const response = await fetch(`${BASE_URL}/api/health`);
    const duration = Date.now() - startTime;
    
    const data = await response.json();
    
    log(`\n响应状态码: ${response.status}`, response.status === 200 ? 'green' : 'yellow');
    log(`响应时间: ${duration}ms`, 'yellow');
    
    // 显示健康状态
    log(`\n健康状态:`, 'blue');
    log(`  状态: ${data.data.status}`, data.data.healthy ? 'green' : 'red');
    log(`  健康: ${data.data.healthy ? '✅ 是' : '❌ 否'}`, data.data.healthy ? 'green' : 'red');
    
    // 显示指标
    log(`\nCPU 指标:`, 'blue');
    log(`  使用率: ${data.data.metrics.cpu.usage}%`, data.data.metrics.cpu.healthy ? 'green' : 'red');
    log(`  阈值: ${data.data.metrics.cpu.threshold}%`, 'yellow');
    log(`  状态: ${data.data.metrics.cpu.healthy ? '✅ 正常' : '❌ 过载'}`, data.data.metrics.cpu.healthy ? 'green' : 'red');
    
    log(`\n系统内存指标:`, 'blue');
    log(`  使用率: ${data.data.metrics.memory.usage}%`, data.data.metrics.memory.healthy ? 'green' : 'red');
    log(`  已用: ${data.data.metrics.memory.usedMB}MB`, 'yellow');
    log(`  总量: ${data.data.metrics.memory.totalMB}MB`, 'yellow');
    log(`  阈值: ${data.data.metrics.memory.threshold}%`, 'yellow');
    log(`  状态: ${data.data.metrics.memory.healthy ? '✅ 正常' : '❌ 过载'}`, data.data.metrics.memory.healthy ? 'green' : 'red');
    
    log(`\n堆内存指标:`, 'blue');
    log(`  使用率: ${data.data.metrics.heap.usage}%`, data.data.metrics.heap.healthy ? 'green' : 'red');
    log(`  已用: ${data.data.metrics.heap.usedMB}MB`, 'yellow');
    log(`  总量: ${data.data.metrics.heap.totalMB}MB`, 'yellow');
    log(`  阈值: ${data.data.metrics.heap.threshold}%`, 'yellow');
    log(`  状态: ${data.data.metrics.heap.healthy ? '✅ 正常' : '❌ 过载'}`, data.data.metrics.heap.healthy ? 'green' : 'red');
    
    log(`\n运行时间: ${Math.floor(data.data.uptime)}秒`, 'yellow');
    log(`时间戳: ${data.data.timestamp}`, 'yellow');
    
    // 显示不健康原因
    if (!data.data.healthy && data.data.reasons && data.data.reasons.length > 0) {
      log(`\n⚠️  不健康原因:`, 'red');
      data.data.reasons.forEach(reason => {
        log(`  - ${reason}`, 'red');
      });
    }
    
    // 判断测试结果
    if (response.status === 200 && data.data.healthy) {
      log('\n✅ 测试通过：系统健康，返回 200', 'green');
      return { passed: true, status: 'healthy' };
    } else if (response.status === 503 && !data.data.healthy) {
      log('\n✅ 测试通过：系统过载，正确返回 503', 'green');
      return { passed: true, status: 'overloaded' };
    } else {
      log('\n⚠️  状态异常：状态码与健康状态不匹配', 'yellow');
      return { passed: false, status: 'inconsistent' };
    }
    
  } catch (error) {
    log(`\n❌ 测试失败: ${error.message}`, 'red');
    console.error(error);
    return { passed: false, status: 'error' };
  }
}

/**
 * 连续测试多次
 */
async function testMultipleTimes(count = 5) {
  logSection(`连续测试 ${count} 次`);
  
  const results = [];
  
  for (let i = 1; i <= count; i++) {
    log(`\n第 ${i}/${count} 次测试`, 'magenta');
    const result = await testHealthCheck();
    results.push(result);
    
    // 等待 1 秒
    if (i < count) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // 统计结果
  logSection('测试统计');
  
  const passedCount = results.filter(r => r.passed).length;
  const healthyCount = results.filter(r => r.status === 'healthy').length;
  const overloadedCount = results.filter(r => r.status === 'overloaded').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  
  log(`\n总测试次数: ${count}`, 'blue');
  log(`通过: ${passedCount}`, passedCount === count ? 'green' : 'yellow');
  log(`失败: ${count - passedCount}`, count - passedCount === 0 ? 'green' : 'red');
  
  log(`\n状态分布:`, 'blue');
  log(`  健康: ${healthyCount}`, 'green');
  log(`  过载: ${overloadedCount}`, overloadedCount > 0 ? 'red' : 'green');
  log(`  错误: ${errorCount}`, errorCount > 0 ? 'red' : 'green');
  
  const successRate = ((passedCount / count) * 100).toFixed(2);
  log(`\n成功率: ${successRate}%`, successRate === '100.00' ? 'green' : 'yellow');
  
  return results;
}

/**
 * 显示使用说明
 */
function showUsage() {
  logSection('健康检查高负载测试');
  
  log('\n功能说明:', 'blue');
  log('  - 测试 /api/health 接口的高负载丢弃功能');
  log('  - 检测 CPU、内存、堆内存使用率');
  log('  - 当负载过高时，接口返回 503 状态码');
  log('  - 北极星会自动摘除返回 503 的实例');
  
  log('\n阈值配置:', 'blue');
  log('  - CPU 使用率阈值: 85%');
  log('  - 系统内存使用率阈值: 85%');
  log('  - 堆内存使用率阈值: 80%');
  
  log('\n环境变量:', 'blue');
  log('  TEST_URL - 测试目标 URL（默认: http://localhost:3000）');
  log('  CPU_THRESHOLD - CPU 阈值（默认: 85）');
  log('  MEMORY_THRESHOLD - 内存阈值（默认: 85）');
  log('  HEAP_THRESHOLD - 堆内存阈值（默认: 80）');
  
  log('\n使用方法:', 'blue');
  log('  pnpm run test:health-load', 'green');
  log('  或', 'yellow');
  log('  node test/health-load.test.mjs', 'green');
  
  log('\n自定义测试:', 'blue');
  log('  TEST_URL=http://your-server:3000 pnpm run test:health-load', 'green');
}

/**
 * 主函数
 */
async function main() {
  showUsage();
  
  log('\n开始测试...', 'cyan');
  log(`测试目标: ${BASE_URL}`, 'yellow');
  
  // 单次测试
  await testHealthCheck();
  
  // 连续测试
  await testMultipleTimes(5);
  
  logSection('测试完成');
  log('\n如需模拟高负载场景，可以：', 'yellow');
  log('  1. 运行压力测试工具（如 ab, wrk）', 'yellow');
  log('  2. 同时处理多个大 PDF 文件', 'yellow');
  log('  3. 降低阈值配置（如 CPU_THRESHOLD=50）', 'yellow');
  
  log('\n查看详细文档:', 'blue');
  log('  docs/HEALTH_LOAD_REJECTION.md', 'green');
}

// 运行测试
main().catch(error => {
  log(`\n❌ 测试运行失败: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
