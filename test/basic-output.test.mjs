/**
 * 基础功能测试 - 输出图片到本地文件夹
 * 
 * 用途：测试 PDF 转图片的基本功能，并将生成的图片保存到本地以便检查质量
 * 
 * 使用方法：
 *   node test/basic-output.test.mjs
 * 
 * 输出目录：output/test-images/
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 测试配置
const TEST_PORT = 3096;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output', 'test-images');

// 测试用 PDF 文件
const TEST_FILES = [
    { name: '1M.pdf', path: `http://localhost:${TEST_PORT}/static/1M.pdf` },
];

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

// 日志函数
const log = {
    info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
    success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
    error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`),
    warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
};

// 确保输出目录存在
function ensureOutputDir() {
    if (fs.existsSync(OUTPUT_DIR)) {
        // 清空目录
        const files = fs.readdirSync(OUTPUT_DIR);
        for (const file of files) {
            fs.unlinkSync(path.join(OUTPUT_DIR, file));
        }
        log.info(`已清空输出目录: ${OUTPUT_DIR}`);
    } else {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        log.info(`已创建输出目录: ${OUTPUT_DIR}`);
    }
}

// 启动测试服务器
async function startTestServer() {
    return new Promise((resolve, reject) => {
        log.info(`启动测试服务器 (端口: ${TEST_PORT})...`);
        
        const server = spawn('node', ['app.js'], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, PORT: TEST_PORT, NODE_ENV: 'dev' },
            stdio: 'pipe',
        });
        
        let resolved = false;
        
        server.stdout.on('data', (data) => {
            const output = data.toString();
            if (!resolved && output.includes(`Server is running on port ${TEST_PORT}`)) {
                resolved = true;
                log.success(`测试服务器已启动`);
                resolve(server);
            }
        });
        
        server.stderr.on('data', (data) => {
            // 忽略 stderr，可能是 sharp 的警告
        });
        
        server.on('error', (error) => {
            if (!resolved) {
                reject(error);
            }
        });
        
        // 超时处理
        setTimeout(() => {
            if (!resolved) {
                server.kill();
                reject(new Error('服务器启动超时'));
            }
        }, 15000);
    });
}

// 停止测试服务器
function stopTestServer(server) {
    if (server) {
        server.kill();
        log.info('测试服务器已停止');
    }
}

// 保存图片到本地
function saveImage(buffer, filename) {
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

// 测试健康检查接口
async function testHealthEndpoint() {
    log.info('测试健康检查接口...');
    
    const response = await fetch(`${BASE_URL}/api/health`);
    const data = await response.json();
    
    if (response.ok && data.code === 200) {
        log.success(`健康检查通过: ${data.message}`);
        return true;
    } else {
        log.error(`健康检查失败: ${JSON.stringify(data)}`);
        return false;
    }
}

// 测试 PDF 转图片
async function testPdf2Img(testFile) {
    log.info(`测试 PDF 转图片: ${testFile.name}`);
    
    const startTime = Date.now();
    
    try {
        const response = await fetch(`${BASE_URL}/api/pdf2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: testFile.path,
                globalPadId: `test-${Date.now()}`,
                pages: 'all',
            }),
        });
        
        const data = await response.json();
        const elapsed = Date.now() - startTime;
        
        if (data.code !== 200) {
            log.error(`转换失败: ${data.message}`);
            return { success: false, error: data.message };
        }
        
        // 保存图片（dev 模式返回 outputPath，需要复制文件）
        const savedFiles = [];
        for (const item of data.data) {
            if (item.outputPath && fs.existsSync(item.outputPath)) {
                // dev 模式：从 outputPath 复制文件
                const filename = `${testFile.name.replace('.pdf', '')}_page${item.pageNum}.webp`;
                const destPath = path.join(OUTPUT_DIR, filename);
                fs.copyFileSync(item.outputPath, destPath);
                const stats = fs.statSync(destPath);
                savedFiles.push({
                    filename,
                    path: destPath,
                    size: stats.size,
                    width: item.width,
                    height: item.height,
                    pageNum: item.pageNum,
                });
            } else if (item.buffer) {
                // 兼容 base64 buffer 格式
                const buffer = Buffer.from(item.buffer, 'base64');
                const filename = `${testFile.name.replace('.pdf', '')}_page${item.pageNum}.webp`;
                const filePath = saveImage(buffer, filename);
                savedFiles.push({
                    filename,
                    path: filePath,
                    size: buffer.length,
                    width: item.width,
                    height: item.height,
                    pageNum: item.pageNum,
                });
            }
        }
        
        log.success(`转换成功: ${savedFiles.length} 页, 耗时 ${elapsed}ms`);
        
        // 打印每页信息
        for (const file of savedFiles) {
            const sizeKB = (file.size / 1024).toFixed(2);
            console.log(`  ${colors.cyan}→${colors.reset} ${file.filename}: ${file.width}x${file.height}, ${sizeKB} KB`);
        }
        
        return { success: true, files: savedFiles, elapsed };
    } catch (error) {
        log.error(`请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// 测试指定页码
async function testSpecificPages(testFile, pages) {
    log.info(`测试指定页码: ${testFile.name}, pages=${JSON.stringify(pages)}`);
    
    const startTime = Date.now();
    
    try {
        const response = await fetch(`${BASE_URL}/api/pdf2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: testFile.path,
                globalPadId: `test-pages-${Date.now()}`,
                pages: pages,
            }),
        });
        
        const data = await response.json();
        const elapsed = Date.now() - startTime;
        
        if (data.code !== 200) {
            log.error(`转换失败: ${data.message}`);
            return { success: false, error: data.message };
        }
        
        // 保存图片
        const savedFiles = [];
        for (const item of data.data) {
            if (item.outputPath && fs.existsSync(item.outputPath)) {
                // dev 模式：从 outputPath 复制文件
                const filename = `${testFile.name.replace('.pdf', '')}_specific_page${item.pageNum}.webp`;
                const destPath = path.join(OUTPUT_DIR, filename);
                fs.copyFileSync(item.outputPath, destPath);
                const stats = fs.statSync(destPath);
                savedFiles.push({
                    filename,
                    path: destPath,
                    size: stats.size,
                    width: item.width,
                    height: item.height,
                    pageNum: item.pageNum,
                });
            } else if (item.buffer) {
                const buffer = Buffer.from(item.buffer, 'base64');
                const filename = `${testFile.name.replace('.pdf', '')}_specific_page${item.pageNum}.webp`;
                const filePath = saveImage(buffer, filename);
                savedFiles.push({
                    filename,
                    path: filePath,
                    size: buffer.length,
                    width: item.width,
                    height: item.height,
                    pageNum: item.pageNum,
                });
            }
        }
        
        log.success(`转换成功: ${savedFiles.length} 页, 耗时 ${elapsed}ms`);
        
        // 验证页码
        const returnedPages = savedFiles.map(f => f.pageNum).sort((a, b) => a - b);
        const expectedPages = pages.sort((a, b) => a - b);
        const pagesMatch = JSON.stringify(returnedPages) === JSON.stringify(expectedPages);
        
        if (pagesMatch) {
            log.success(`页码验证通过: ${returnedPages.join(', ')}`);
        } else {
            log.warn(`页码不匹配: 期望 ${expectedPages.join(', ')}, 实际 ${returnedPages.join(', ')}`);
        }
        
        return { success: true, files: savedFiles, elapsed, pagesMatch };
    } catch (error) {
        log.error(`请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// 测试错误处理
async function testErrorHandling() {
    log.info('测试错误处理...');
    
    // 测试缺少 URL 参数
    const response1 = await fetch(`${BASE_URL}/api/pdf2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ globalPadId: 'test' }),
    });
    const data1 = await response1.json();
    
    if (data1.code === 400) {
        log.success('缺少 URL 参数: 正确返回 400');
    } else {
        log.error(`缺少 URL 参数: 期望 400, 实际 ${data1.code}`);
    }
    
    // 测试缺少 globalPadId 参数
    const response2 = await fetch(`${BASE_URL}/api/pdf2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://example.com/test.pdf' }),
    });
    const data2 = await response2.json();
    
    if (data2.code === 400) {
        log.success('缺少 globalPadId 参数: 正确返回 400');
    } else {
        log.error(`缺少 globalPadId 参数: 期望 400, 实际 ${data2.code}`);
    }
    
    // 测试无效 URL
    const response3 = await fetch(`${BASE_URL}/api/pdf2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            url: 'http://localhost:9999/nonexistent.pdf',
            globalPadId: 'test',
        }),
    });
    const data3 = await response3.json();
    
    if (data3.code === 502 || data3.code === 500) {
        log.success(`无效 URL: 正确返回错误码 ${data3.code}`);
    } else {
        log.warn(`无效 URL: 返回 ${data3.code}`);
    }
}

// 主函数
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.cyan}PDF2IMG 基础功能测试${colors.reset}`);
    console.log('='.repeat(60) + '\n');
    
    let server;
    
    try {
        // 准备输出目录
        ensureOutputDir();
        console.log('');
        
        // 启动服务器
        server = await startTestServer();
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待服务器完全就绪
        console.log('');
        
        // 运行测试
        const results = {
            health: false,
            pdf2img: [],
            specificPages: null,
            errorHandling: false,
        };
        
        // 1. 健康检查
        results.health = await testHealthEndpoint();
        console.log('');
        
        // 2. PDF 转图片（全部页）
        for (const testFile of TEST_FILES) {
            const result = await testPdf2Img(testFile);
            results.pdf2img.push({ file: testFile.name, ...result });
            console.log('');
        }
        
        // 3. 指定页码测试
        results.specificPages = await testSpecificPages(TEST_FILES[0], [1]);
        console.log('');
        
        // 4. 错误处理测试
        await testErrorHandling();
        console.log('');
        
        // 打印结果摘要
        console.log('='.repeat(60));
        console.log(`${colors.cyan}测试结果摘要${colors.reset}`);
        console.log('='.repeat(60));
        console.log(`健康检查: ${results.health ? colors.green + '通过' : colors.red + '失败'}${colors.reset}`);
        
        for (const r of results.pdf2img) {
            console.log(`PDF转图片 (${r.file}): ${r.success ? colors.green + '通过' : colors.red + '失败'}${colors.reset}`);
        }
        
        console.log(`指定页码: ${results.specificPages?.success ? colors.green + '通过' : colors.red + '失败'}${colors.reset}`);
        console.log('');
        console.log(`${colors.cyan}图片输出目录:${colors.reset} ${OUTPUT_DIR}`);
        console.log('');
        
    } catch (error) {
        log.error(`测试执行失败: ${error.message}`);
        console.error(error);
    } finally {
        stopTestServer(server);
    }
}

main();
