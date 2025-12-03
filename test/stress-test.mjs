/**
 * 简单的并发压测脚本
 * 用于触发高负载，测试负载丢弃功能
 */

import http from 'http';

const CONCURRENT_REQUESTS = 20; // 并发请求数
const TOTAL_REQUESTS = 50; // 总请求数

let completedRequests = 0;
let successCount = 0;
let overloadCount = 0;
let errorCount = 0;

/**
 * 发送单个请求
 */
function sendRequest(index) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      url: 'http://localhost:3000/test.pdf',
      globalPadId: `stress-test-${index}-${Date.now()}`,
      pages: [1],
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/pdf2img',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    
    const startTime = Date.now();
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const duration = Date.now() - startTime;
        completedRequests++;
        
        if (res.statusCode === 503) {
          overloadCount++;
          console.log(`[${completedRequests}/${TOTAL_REQUESTS}] ⚠️  请求 #${index} 被拒绝 (503) - ${duration}ms`);
        } else if (res.statusCode === 200) {
          successCount++;
          console.log(`[${completedRequests}/${TOTAL_REQUESTS}] ✅ 请求 #${index} 成功 (200) - ${duration}ms`);
        } else {
          errorCount++;
          console.log(`[${completedRequests}/${TOTAL_REQUESTS}] ❌ 请求 #${index} 失败 (${res.statusCode}) - ${duration}ms`);
        }
        
        resolve({ statusCode: res.statusCode, duration });
      });
    });
    
    req.on('error', (error) => {
      completedRequests++;
      errorCount++;
      console.log(`[${completedRequests}/${TOTAL_REQUESTS}] ❌ 请求 #${index} 错误: ${error.message}`);
      resolve({ statusCode: 0, duration: Date.now() - startTime });
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * 主函数
 */
async function main() {
  console.log('='.repeat(80));
  console.log('🚀 PDF2IMG 接口压力测试');
  console.log('='.repeat(80));
  console.log(`并发数: ${CONCURRENT_REQUESTS}`);
  console.log(`总请求数: ${TOTAL_REQUESTS}`);
  console.log('='.repeat(80));
  console.log();
  
  const startTime = Date.now();
  
  // 分批发送请求
  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENT_REQUESTS) {
    const batch = [];
    const batchSize = Math.min(CONCURRENT_REQUESTS, TOTAL_REQUESTS - i);
    
    console.log(`\n📦 发送批次 ${Math.floor(i / CONCURRENT_REQUESTS) + 1}（${batchSize} 个请求）...`);
    
    for (let j = 0; j < batchSize; j++) {
      batch.push(sendRequest(i + j + 1));
    }
    
    await Promise.all(batch);
    
    // 批次间稍微等待
    if (i + CONCURRENT_REQUESTS < TOTAL_REQUESTS) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  const totalDuration = Date.now() - startTime;
  
  console.log();
  console.log('='.repeat(80));
  console.log('📊 测试结果统计');
  console.log('='.repeat(80));
  console.log(`总请求数: ${TOTAL_REQUESTS}`);
  console.log(`成功 (200): ${successCount} (${(successCount / TOTAL_REQUESTS * 100).toFixed(1)}%)`);
  console.log(`过载拒绝 (503): ${overloadCount} (${(overloadCount / TOTAL_REQUESTS * 100).toFixed(1)}%)`);
  console.log(`其他错误: ${errorCount} (${(errorCount / TOTAL_REQUESTS * 100).toFixed(1)}%)`);
  console.log(`总耗时: ${(totalDuration / 1000).toFixed(2)}秒`);
  console.log(`平均 QPS: ${(TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)}`);
  console.log('='.repeat(80));
  
  if (overloadCount > 0) {
    console.log('\n✅ 高负载丢弃功能正常工作！');
  } else {
    console.log('\n⚠️  未触发高负载丢弃，可能需要：');
    console.log('   1. 降低阈值（如 HEAP_THRESHOLD=60）');
    console.log('   2. 增加并发数');
    console.log('   3. 使用真实的 PDF URL');
  }
}

main().catch(console.error);
