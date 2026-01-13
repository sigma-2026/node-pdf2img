/**
 * PDF Renderer 测试脚本
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 动态导入原生模块
let renderer;
try {
    renderer = await import('./index.js');
} catch (e) {
    console.error('Failed to load native module:', e.message);
    console.log('\nMake sure you have:');
    console.log('1. Built the native module: pnpm build');
    console.log('2. Downloaded PDFium: ./scripts/download-pdfium.sh');
    process.exit(1);
}

const { renderPages, getPageCount, isPdfiumAvailable, getVersion } = renderer;

console.log('=== PDF Renderer Test ===\n');

// 检查版本
console.log('Version:', getVersion());
console.log('PDFium available:', isPdfiumAvailable());

if (!isPdfiumAvailable()) {
    console.error('\nPDFium library not found!');
    console.log('Please run: ./scripts/download-pdfium.sh');
    process.exit(1);
}

// 查找 static 目录和测试 PDF
function findTestPdf() {
    // 从当前目录开始向上查找 static 目录
    let currentDir = __dirname;
    const maxLevels = 5; // 最多向上查找 5 层
    
    for (let i = 0; i < maxLevels; i++) {
        const staticDir = join(currentDir, 'static');
        const testPdf = join(staticDir, '1M.pdf');
        
        console.log(`Checking: ${staticDir}`);
        if (existsSync(testPdf)) {
            console.log(`Found test PDF: ${testPdf}`);
            return testPdf;
        }
        
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) {
            break; // 已到根目录
        }
        currentDir = parentDir;
    }
    
    // 如果找不到，使用绝对路径
    const fallbackPath = resolve(__dirname, '../../../static/1M.pdf');
    console.log(`Trying fallback path: ${fallbackPath}`);
    return fallbackPath;
}

const testPdfPath = findTestPdf();

if (!existsSync(testPdfPath)) {
    console.error('\nTest PDF not found!');
    console.log('Searched path:', testPdfPath);
    console.log('Current working directory:', process.cwd());
    console.log('Test script directory:', __dirname);
    process.exit(1);
}

try {
    console.log('\nLoading test PDF:', testPdfPath);
    const pdfBuffer = readFileSync(testPdfPath);
    console.log('PDF size:', (pdfBuffer.length / 1024).toFixed(2), 'KB');

    // 获取页数
    const pageCount = getPageCount(pdfBuffer);
    console.log('Page count:', pageCount);

    // 渲染第一页
    console.log('\nRendering page 1...');
    const startTime = Date.now();
    
    const result = renderPages(pdfBuffer, [1], {
        targetWidth: 1280,
        webpQuality: 70,
    });

    const totalTime = Date.now() - startTime;

    console.log('\n=== Render Result ===');
    console.log('Success:', result.success);
    console.log('Total time:', result.totalTime, 'ms');
    
    if (result.success && result.pages.length > 0) {
        const page = result.pages[0];
        console.log('\nPage 1:');
        console.log('  Size:', page.width, 'x', page.height);
        console.log('  Buffer size:', (page.buffer.length / 1024).toFixed(2), 'KB');
        console.log('  Render time:', page.renderTime, 'ms');
        console.log('  Encode time:', page.encodeTime, 'ms');
        console.log('  Success:', page.success);
    } else if (result.error) {
        console.error('Error:', result.error);
    }

    // 批量渲染测试
    if (pageCount > 1) {
        console.log('\n=== Batch Render Test ===');
        const pagesToRender = Array.from({ length: Math.min(pageCount, 5) }, (_, i) => i + 1);
        console.log('Rendering pages:', pagesToRender.join(', '));
        
        const batchStart = Date.now();
        const batchResult = renderPages(pdfBuffer, pagesToRender);
        const batchTime = Date.now() - batchStart;
        
        console.log('Batch success:', batchResult.success);
        console.log('Batch total time:', batchResult.totalTime, 'ms');
        console.log('Pages rendered:', batchResult.pages.filter(p => p.success).length);
        
        // 计算平均时间
        const successPages = batchResult.pages.filter(p => p.success);
        if (successPages.length > 0) {
            const avgRenderTime = successPages.reduce((sum, p) => sum + p.renderTime, 0) / successPages.length;
            const avgEncodeTime = successPages.reduce((sum, p) => sum + p.encodeTime, 0) / successPages.length;
            console.log('Avg render time:', avgRenderTime.toFixed(2), 'ms');
            console.log('Avg encode time:', avgEncodeTime.toFixed(2), 'ms');
        }
    }

    console.log('\n=== Test Complete ===');

} catch (e) {
    console.error('Test failed:', e.message);
    console.error(e.stack);
    process.exit(1);
}
