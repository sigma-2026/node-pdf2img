import { spawn } from 'child_process';
import fetch from 'node-fetch';

// 测试配置
const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_PDF_URL = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

// 测试统计
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

// 测试辅助函数
function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`${colors.green}✓${colors.reset} ${message}`);
  } else {
    failedTests++;
    console.log(`${colors.red}✗${colors.reset} ${message}`);
    throw new Error(`断言失败: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (期望: ${expected}, 实际: ${actual})`);
}

function assertGreaterThan(actual, expected, message) {
  assert(actual > expected, `${message} (期望 > ${expected}, 实际: ${actual})`);
}

function assertDefined(value, message) {
  assert(value !== undefined && value !== null, `${message} (值应该被定义)`);
}

// 启动测试服务器
async function startTestServer() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.blue}启动测试服务器...${colors.reset}`);
    
    const server = spawn('node', ['app.js'], {
      env: { ...process.env, PORT: TEST_PORT, NODE_ENV: 'dev' },
      stdio: 'pipe',
    });
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes(`Server is running on port ${TEST_PORT}`)) {
        console.log(`${colors.green}✓ 测试服务器已启动 (端口: ${TEST_PORT})${colors.reset}\n`);
        resolve(server);
      }
    });
    
    server.stderr.on('data', (data) => {
      console.error(`服务器错误: ${data}`);
    });
    
    server.on('error', (error) => {
      reject(error);
    });
    
    // 超时处理
    const timeout = setTimeout(() => {
      reject(new Error('服务器启动超时'));
    }, 10000);
  });
}

// 停止测试服务器
function stopTestServer(server) {
  if (server) {
    server.kill();
    console.log(`\n${colors.blue}测试服务器已停止${colors.reset}`);
  }
}

// 测试套件
async function runTests() {
  let server;
  
  try {
    // 启动服务器
    server = await startTestServer();
    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待服务器完全启动
    
    // 运行测试
    await testHealthEndpoint();
    await testMissingUrlParameter();
    await testMissingGlobalPadIdParameter();
    await testInvalidUrlFormat();
    await testInvalidPagesFormat();
    await testSuccessWithDefaultPages();
    await testSuccessWithAllPages();
    await testSuccessWithSpecificPages();
    await testPerformance();
    
  } catch (error) {
    console.error(`${colors.red}测试执行错误: ${error.message}${colors.reset}`);
    failedTests++;
  } finally {
    // 停止服务器
    stopTestServer(server);
    
    // 输出测试结果
    console.log(`\n${'='.repeat(60)}`);
    console.log(`测试结果汇总:`);
    console.log(`总计: ${totalTests} 个测试`);
    console.log(`${colors.green}通过: ${passedTests}${colors.reset}`);
    console.log(`${colors.red}失败: ${failedTests}${colors.reset}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // 退出码
    process.exit(failedTests > 0 ? 1 : 0);
  }
}

// 测试用例
async function testHealthEndpoint() {
  console.log(`${colors.yellow}测试: 健康检查接口${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/health`);
  const data = await response.json();
  
  assertEqual(response.status, 200, '状态码应该是200');
  assertEqual(data.code, 200, '响应code应该是200');
  assert(data.data.status === 'ok' || data.data.status === 'healthy', '健康状态应该是ok或healthy');
  assertEqual(data.data.healthy, true, 'healthy应该为true');
  assertDefined(data.data.metrics, 'metrics应该被定义');
  
  console.log('');
}

async function testMissingUrlParameter() {
  console.log(`${colors.yellow}测试: 缺少URL参数${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      globalPadId: 'test-integration',
      pages: 'all',
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 400, '状态码应该是400');
  assertEqual(data.code, 400, '响应code应该是400');
  assertEqual(data.message, 'URL is required', '错误消息应该正确');
  
  console.log('');
}

async function testMissingGlobalPadIdParameter() {
  console.log(`${colors.yellow}测试: 缺少globalPadId参数${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      pages: 'all',
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 400, '状态码应该是400');
  assertEqual(data.code, 400, '响应code应该是400');
  assertEqual(data.message, 'globalPadId is required', '错误消息应该正确');
  
  console.log('');
}

async function testInvalidUrlFormat() {
  console.log(`${colors.yellow}测试: 无效的URL格式${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'not-a-valid-url',
      globalPadId: 'test-integration',
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 400, '状态码应该是400');
  assertEqual(data.code, 400, '响应code应该是400');
  assertEqual(data.message, 'Invalid URL format', '错误消息应该正确');
  
  console.log('');
}

async function testInvalidPagesFormat() {
  console.log(`${colors.yellow}测试: 无效的pages参数格式${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      globalPadId: 'test-integration',
      pages: 'invalid-format',
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 400, '状态码应该是400');
  assertEqual(data.code, 400, '响应code应该是400');
  assert(data.message.includes('pages must be an Array or String as "all"'), '错误消息应该包含正确的提示');
  
  console.log('');
}

async function testSuccessWithDefaultPages() {
  console.log(`${colors.yellow}测试: 成功转换PDF - 使用默认页码${colors.reset}`);
  
  const startTime = Date.now();
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      globalPadId: 'test-integration',
    }),
  });
  const data = await response.json();
  const duration = (Date.now() - startTime) / 1000;
  
  assertEqual(response.status, 200, '状态码应该是200');
  assertEqual(data.code, 200, '响应code应该是200');
  assertEqual(data.message, 'ok', '响应消息应该是ok');
  assert(Array.isArray(data.data), 'data应该是数组');
  assertGreaterThan(data.data.length, 0, '应该至少有一页');
  
  // 验证第一页数据结构
  const firstPage = data.data[0];
  assertDefined(firstPage.pageNum, 'pageNum应该被定义');
  assertDefined(firstPage.width, 'width应该被定义');
  assertDefined(firstPage.height, 'height应该被定义');
  assert(firstPage.outputPath || firstPage.cosKey, '应该有输出路径');
  assertGreaterThan(firstPage.width, 0, '宽度应该大于0');
  assertGreaterThan(firstPage.height, 0, '高度应该大于0');
  
  console.log(`  耗时: ${duration.toFixed(2)}秒`);
  console.log(`  转换页数: ${data.data.length}`);
  console.log('');
}

async function testSuccessWithAllPages() {
  console.log(`${colors.yellow}测试: 成功转换PDF - 使用"all"参数${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      globalPadId: 'test-integration',
      pages: 'all',
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 200, '状态码应该是200');
  assertEqual(data.code, 200, '响应code应该是200');
  assert(Array.isArray(data.data), 'data应该是数组');
  assertGreaterThan(data.data.length, 0, '应该至少有一页');
  
  // 验证页码连续性
  data.data.forEach((page, index) => {
    assertEqual(page.pageNum, index + 1, `第${index + 1}页的pageNum应该正确`);
  });
  
  console.log(`  转换页数: ${data.data.length}`);
  console.log('');
}

async function testSuccessWithSpecificPages() {
  console.log(`${colors.yellow}测试: 成功转换PDF - 使用页码数组${colors.reset}`);
  
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      globalPadId: 'test-integration',
      pages: [1],
    }),
  });
  const data = await response.json();
  
  assertEqual(response.status, 200, '状态码应该是200');
  assertEqual(data.code, 200, '响应code应该是200');
  assertEqual(data.data.length, 1, '应该只有一页');
  assertEqual(data.data[0].pageNum, 1, '页码应该是1');
  
  console.log('data.data', data.data);
}

async function testPerformance() {
  console.log(`${colors.yellow}测试: 性能测试 - 单页转换${colors.reset}`);
  
  const startTime = Date.now();
  const response = await fetch(`${BASE_URL}/api/pdf2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: TEST_PDF_URL,
      globalPadId: 'test-integration',
      pages: [1],
    }),
  });
  const data = await response.json();
  const duration = (Date.now() - startTime) / 1000;
  
  assertEqual(response.status, 200, '状态码应该是200');
  assert(duration < 30, `转换时间应该在30秒内 (实际: ${duration.toFixed(2)}秒)`);
  
  console.log(`  单页转换耗时: ${duration.toFixed(2)}秒`);
  console.log('');
}

// 运行测试
console.log(`\n${'='.repeat(60)}`);
console.log(`${colors.blue}PDF2IMG API 集成测试${colors.reset}`);
console.log(`${'='.repeat(60)}\n`);

runTests();