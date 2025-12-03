/**
 * /pdf2img 接口高负载丢弃功能测试
 * 
 * 测试场景：
 * 1. 正常负载下请求成功
 * 2. 高负载下请求被拒绝（503）
 * 3. 验证响应格式和内容
 */

import http from 'http';

const BASE_URL = 'http://localhost:3000';

/**
 * 发送 HTTP 请求
 */
function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        }
      });
    });
    
    req.on('error', reject);
    
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * 测试 /pdf2img 接口
 */
async function testPdf2imgEndpoint(testData) {
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/pdf2img',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  };
  
  const postData = JSON.stringify(testData);
  
  try {
    const response = await request(options, postData);
    return response;
  } catch (error) {
    console.error('请求失败:', error.message);
    throw error;
  }
}

/**
 * 获取健康状态
 */
async function getHealthStatus() {
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/health',
    method: 'GET',
  };
  
  try {
    const response = await request(options);
    return response;
  } catch (error) {
    console.error('健康检查失败:', error.message);
    throw error;
  }
}

/**
 * 主测试函数
 */
async function runTests() {
  console.log('='.repeat(80));
  console.log('📋 /pdf2img 接口高负载丢弃功能测试');
  console.log('='.repeat(80));
  console.log();
  
  // 测试数据
  const testData = {
    url: 'https://example.com/test.pdf',
    globalPadId: 'test-load-protection-' + Date.now(),
    pages: [1],
  };
  
  // 1. 先检查当前健康状态
  console.log('📊 步骤 1: 检查当前系统健康状态');
  console.log('-'.repeat(80));
  
  try {
    const healthResponse = await getHealthStatus();
    console.log(`状态码: ${healthResponse.statusCode}`);
    console.log(`健康状态: ${healthResponse.body.data.healthy ? '✅ 健康' : '❌ 过载'}`);
    
    if (healthResponse.body.data.metrics) {
      const metrics = healthResponse.body.data.metrics;
      console.log(`CPU 使用率: ${metrics.cpu.usage}% (阈值: ${metrics.cpu.threshold}%)`);
      console.log(`内存使用率: ${metrics.memory.usage}% (阈值: ${metrics.memory.threshold}%)`);
      console.log(`堆内存使用率: ${metrics.heap.usage}% (阈值: ${metrics.heap.threshold}%)`);
    }
    
    if (!healthResponse.body.data.healthy) {
      console.log(`\n⚠️  不健康原因:`);
      healthResponse.body.data.reasons.forEach(reason => {
        console.log(`   - ${reason}`);
      });
    }
    console.log();
  } catch (error) {
    console.error('❌ 健康检查失败:', error.message);
    console.log();
  }
  
  // 2. 测试 /pdf2img 接口
  console.log('📊 步骤 2: 测试 /pdf2img 接口负载保护');
  console.log('-'.repeat(80));
  
  try {
    const startTime = Date.now();
    const response = await testPdf2imgEndpoint(testData);
    const duration = Date.now() - startTime;
    
    console.log(`状态码: ${response.statusCode}`);
    console.log(`响应时间: ${duration}ms`);
    console.log(`响应码: ${response.body.code}`);
    console.log(`响应消息: ${response.body.message}`);
    
    if (response.statusCode === 503) {
      console.log('\n✅ 高负载丢弃功能正常工作！');
      console.log('📋 过载详情:');
      
      if (response.body.data && response.body.data.reasons) {
        response.body.data.reasons.forEach(reason => {
          console.log(`   - ${reason}`);
        });
      }
      
      if (response.body.data && response.body.data.retryAfter) {
        console.log(`\n⏰ 建议重试时间: ${response.body.data.retryAfter}秒后`);
      }
      
      if (response.body.data && response.body.data.metrics) {
        console.log('\n📊 当前指标:');
        const metrics = response.body.data.metrics;
        console.log(`   CPU: ${metrics.cpu.usage}% (阈值: ${metrics.cpu.threshold}%)`);
        console.log(`   内存: ${metrics.memory.usage}% (阈值: ${metrics.memory.threshold}%)`);
        console.log(`   堆内存: ${metrics.heap.usage}% (阈值: ${metrics.heap.threshold}%)`);
      }
    } else if (response.statusCode === 200) {
      console.log('\n✅ 系统负载正常，请求被接受');
      console.log('📋 响应数据:', JSON.stringify(response.body.data, null, 2));
    } else if (response.statusCode === 400) {
      console.log('\n⚠️  参数验证失败（这是正常的，因为使用的是测试 URL）');
      console.log('📋 错误信息:', response.body.message);
    } else {
      console.log('\n❓ 未预期的响应状态码');
      console.log('📋 完整响应:', JSON.stringify(response.body, null, 2));
    }
    
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
  }
  
  console.log();
  console.log('='.repeat(80));
  console.log('✅ 测试完成');
  console.log('='.repeat(80));
  console.log();
  
  // 3. 输出测试说明
  console.log('📖 测试说明:');
  console.log('-'.repeat(80));
  console.log('1. 如果返回 503: 说明系统过载，高负载丢弃功能正常工作');
  console.log('2. 如果返回 400: 说明负载正常，但 URL 参数验证失败（测试 URL 无效）');
  console.log('3. 如果返回 200: 说明负载正常，且请求成功处理');
  console.log();
  console.log('💡 如何触发高负载丢弃:');
  console.log('   - 方式1: 降低阈值环境变量（如 CPU_THRESHOLD=50）');
  console.log('   - 方式2: 并发发送大量请求增加系统负载');
  console.log('   - 方式3: 使用压测工具（如 ab、wrk）');
  console.log();
}

// 运行测试
runTests().catch(console.error);
