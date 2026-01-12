#!/usr/bin/env node

/**
 * 手动测试脚本
 *
 * 用法：
 *   node test/manual-test.js [pdf文件路径]
 *
 * 示例：
 *   node test/manual-test.js                    # 使用默认测试文件
 *   node test/manual-test.js static/发票.pdf    # 指定文件
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

// 动态导入主模块
const { convert, getPageCount, isAvailable, getVersion } = await import('../packages/pdf2img/src/index.js');

// 获取输入文件
const inputFile = process.argv[2] || path.join(PROJECT_ROOT, 'static/发票.pdf');

console.log('='.repeat(50));
console.log('PDF2IMG 手动测试');
console.log('='.repeat(50));
console.log();

// 检查渲染器
console.log(`渲染器版本: ${getVersion()}`);
console.log(`渲染器可用: ${isAvailable() ? '是' : '否'}`);
console.log();

// 检查输入文件
if (!fs.existsSync(inputFile)) {
    console.error(`错误：文件不存在 - ${inputFile}`);
    process.exit(1);
}

const stat = fs.statSync(inputFile);
const pageCount = getPageCount(inputFile);

console.log(`输入文件: ${inputFile}`);
console.log(`文件大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`页数: ${pageCount}`);
console.log();

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log(`输出目录: ${OUTPUT_DIR}`);
console.log();

// 开始转换
console.log('开始转换...');
const startTime = Date.now();

try {
    const result = await convert(inputFile, {
        outputType: 'file',
        outputDir: OUTPUT_DIR,
        prefix: path.basename(inputFile, '.pdf'),
        targetWidth: 1280,
        webpQuality: 80,
    });

    const duration = Date.now() - startTime;

    console.log();
    console.log(`转换完成！耗时 ${duration}ms`);
    console.log();
    console.log('生成的文件:');

    let totalSize = 0;
    for (const page of result.pages) {
        if (page.success) {
            totalSize += page.size;
            console.log(`  ${path.basename(page.outputPath)} - ${page.width}x${page.height} (${(page.size / 1024).toFixed(1)} KB)`);
        } else {
            console.log(`  第 ${page.pageNum} 页 - 失败: ${page.error}`);
        }
    }

    console.log();
    console.log(`总大小: ${(totalSize / 1024).toFixed(1)} KB`);
    console.log(`平均每页: ${Math.round(duration / result.renderedPages)}ms`);

} catch (err) {
    console.error(`转换失败: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
}
