#!/usr/bin/env node

/**
 * 超时功能测试脚本
 * 测试40秒接口超时处理
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
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

async function testTimeout() {
  logSection('40秒超时测试');
  
  log('\n说明: 此测试将发送一个需要长时间处理的请求', 'yellow');
  log('预期: 请求应在40秒后超时，返回408状态码', 'yellow');
  
  try {
    log('\n发送测试请求...', 'blue');
    const startTime = Date.now();
    
    // 发送一个可能需要长时间处理的PDF请求
    // 注意：这里使用一个不存在的URL，服务器会尝试下载并超时
    const response = await fetch(`${BASE_URL}/api/pdf2img`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://httpbin.org/delay/50',  // 模拟50秒延迟
        globalPadId: 'test-timeout',
        pages: [1]
      }),
      // 设置客户端超时为45秒（比服务器40秒稍长）
      timeout: 45000
    });
    
    const duration = Date.now() - startTime;
    const durationSeconds = (duration / 1000).toFixed(2);
    
    log(`\n响应状态码: ${response.status}`, response.status === 408 ? 'green' : 'yellow');
    log(`响应时间: ${durationSeconds}秒 (${duration}ms)`, 'yellow');
    
    const data = await response.json();
    log(`响应数据:`, 'blue');
    console.log(JSON.stringify(data, null, 2));
    
    // 验证超时
    if (response.status === 408) {
      log('\n✅ 超时测试通过：服务器正确返回408超时状态', 'green');
      if (duration >= 39000 && duration <= 42000) {
        log(`✅ 超时时间正确：约40秒 (${durationSeconds}秒)`, 'green');
      } else {
        log(`⚠️  超时时间异常：预期40秒，实际${durationSeconds}秒`, 'yellow');
      }
      return true;
    } else {
      log(`⚠️  未触发超时：状态码${response.status}`, 'yellow');
      return false;
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    const durationSeconds = (duration / 1000).toFixed(2);
    
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      log(`\n⚠️  客户端超时 (${durationSeconds}秒): ${error.message}`, 'yellow');
      log('这可能意味着服务器超时时间超过了客户端设置', 'yellow');
      return false;
    } else {
      log(`\n❌ 测试失败: ${error.message}`, 'red');
      console.error(error);
      return false;
    }
  }
}

async function testNormalRequest() {
  logSection('正常请求测试');
  
  log('\n说明: 测试正常请求不受超时影响', 'yellow');
  
  try {
    log('\n发送健康检查请求...', 'blue');
    const startTime = Date.now();
    
    const response = await fetch(`${BASE_URL}/api/health`);
    const duration = Date.now() - startTime;
    
    log(`\n响应状态码: ${response.status}`, response.status === 200 ? 'green' : 'red');
    log(`响应时间: ${duration}ms`, 'yellow');
    
    const data = await response.json();
    log(`响应数据:`, 'blue');
    console.log(JSON.stringify(data, null, 2));
    
    if (response.status === 200) {
      log('\n✅ 正常请求测试通过', 'green');
      return true;
    } else {
      log('\n❌ 正常请求测试失败', 'red');
      return false;
    }
    
  } catch (error) {
    log(`\n❌ 测试失败: ${error.message}`, 'red');
    console.error(error);
    return false;
  }
}

async function runAllTests() {
  log('开始超时功能测试', 'cyan');
  log(`测试目标: ${BASE_URL}`, 'yellow');
  log(`配置超时: 40秒`, 'yellow');
  
  const results = {
    passed: 0,
    failed: 0,
  };
  
  try {
    // 1. 测试正常请求
    const normalTest = await testNormalRequest();
    if (normalTest) results.passed++; else results.failed++;
    
    // 2. 测试超时
    log('\n⏳ 准备测试超时功能（需要等待约40秒）...', 'yellow');
    log('提示: 如果没有合适的测试环境，可以按 Ctrl+C 跳过', 'yellow');
    
    // 等待3秒让用户有机会取消
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const timeoutTest = await testTimeout();
    if (timeoutTest) results.passed++; else results.failed++;
    
  } catch (error) {
    log(`\n❌ 测试过程中发生错误: ${error.message}`, 'red');
    console.error(error);
    results.failed++;
  }
  
  // 输出测试总结
  logSection('测试总结');
  log(`\n✅ 通过: ${results.passed}`, 'green');
  log(`❌ 失败: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  
  const totalTests = results.passed + results.failed;
  const successRate = ((results.passed / totalTests) * 100).toFixed(2);
  log(`\n成功率: ${successRate}%`, successRate === '100.00' ? 'green' : 'yellow');
  
  if (results.failed === 0) {
    log('\n🎉 所有测试通过！', 'green');
    process.exit(0);
  } else {
    log('\n⚠️  部分测试失败，请检查日志', 'red');
    process.exit(1);
  }
}

// 运行测试
runAllTests().catch(error => {
  log(`\n❌ 测试运行失败: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
