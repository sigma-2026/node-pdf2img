#!/usr/bin/env node
/**
 * node-pdf2img 基础使用示例
 * 
 * 演示如何使用 node-pdf2img 将 PDF 转换为图片
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    convert,
    isAvailable,
    isPdfjsAvailable,
    getVersion,
    getPdfjsVersion,
    getPageCount,
    destroyThreadPool,
} from 'node-pdf2img';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

// 测试 PDF URL（可替换为本地文件路径或其他 URL）
const TEST_PDF_URL = 'https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-22/882d094d-4936-4411-becc-1781e6955d28.pdf';

async function main() {
    console.log('='.repeat(50));
    console.log('node-pdf2img 使用示例');
    console.log('='.repeat(50));
    console.log();

    // 1. 检查渲染器可用性
    console.log('🔧 检查渲染器状态...');
    const pdfiumAvailable = isAvailable();
    const pdfjsAvailable = isPdfjsAvailable();
    
    console.log(`   PDFium: ${pdfiumAvailable ? `✓ 可用 (${getVersion()})` : '✗ 不可用'}`);
    console.log(`   PDF.js: ${pdfjsAvailable ? `✓ 可用 (${getPdfjsVersion()})` : '✗ 不可用'}`);
    console.log();

    if (!pdfiumAvailable && !pdfjsAvailable) {
        console.error('❌ 没有可用的渲染器，请检查安装');
        process.exit(1);
    }

    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 2. 基础转换 - URL 输入，Buffer 输出
    console.log('📄 示例 1: URL 输入，Buffer 输出');
    try {
        const result = await convert(TEST_PDF_URL, {
            pages: [1],
            format: 'png',
            targetWidth: 1280,
            outputType: 'buffer',
        });

        console.log(`   ✓ 成功转换 ${result.renderedPages}/${result.numPages} 页`);
        console.log(`   渲染器: ${result.renderer}`);
        console.log(`   输出大小: ${(result.pages[0].size / 1024).toFixed(1)} KB`);
        
        // 保存到文件
        const outputPath = path.join(OUTPUT_DIR, 'example1.png');
        fs.writeFileSync(outputPath, result.pages[0].buffer);
        console.log(`   保存到: ${outputPath}`);
    } catch (err) {
        console.log(`   ❌ 失败: ${err.message}`);
    }
    console.log();

    // 3. 多页转换 - 指定页码范围
    console.log('📄 示例 2: 多页转换（前 3 页）');
    try {
        const result = await convert(TEST_PDF_URL, {
            pages: [1, 2, 3],
            format: 'webp',
            quality: 85,
            targetWidth: 1024,
            outputType: 'buffer',
        });

        console.log(`   ✓ 成功转换 ${result.renderedPages} 页`);
        for (let i = 0; i < result.pages.length; i++) {
            const page = result.pages[i];
            const pageNum = page.page || page.pageNumber || (i + 1);
            const outputPath = path.join(OUTPUT_DIR, `example2_page${pageNum}.webp`);
            fs.writeFileSync(outputPath, page.buffer);
            console.log(`   保存第 ${pageNum} 页: ${(page.size / 1024).toFixed(1)} KB`);
        }
    } catch (err) {
        console.log(`   ❌ 失败: ${err.message}`);
    }
    console.log();

    // 4. 直接输出到文件
    console.log('📄 示例 3: 直接输出到文件');
    try {
        const result = await convert(TEST_PDF_URL, {
            pages: [1],
            format: 'jpg',
            quality: 90,
            outputType: 'file',
            outputDir: OUTPUT_DIR,
            filenamePrefix: 'example3',
        });

        console.log(`   ✓ 成功转换 ${result.renderedPages} 页`);
        console.log(`   输出文件: ${result.pages[0].outputPath}`);
    } catch (err) {
        console.log(`   ❌ 失败: ${err.message}`);
    }
    console.log();

    // 5. 获取 PDF 页数
    console.log('📄 示例 4: 获取 PDF 信息');
    try {
        const pageCount = await getPageCount(TEST_PDF_URL);
        console.log(`   ✓ PDF 总页数: ${pageCount}`);
    } catch (err) {
        console.log(`   ❌ 失败: ${err.message}`);
    }
    console.log();

    // 6. 使用不同渲染器
    if (pdfiumAvailable && pdfjsAvailable) {
        console.log('📄 示例 5: 对比不同渲染器');
        
        for (const renderer of ['pdfium', 'pdfjs']) {
            try {
                const start = performance.now();
                const result = await convert(TEST_PDF_URL, {
                    pages: [1],
                    format: 'png',
                    renderer,
                    outputType: 'buffer',
                });
                const time = performance.now() - start;
                
                console.log(`   ${renderer}: ${time.toFixed(0)}ms, ${(result.pages[0].size / 1024).toFixed(1)} KB`);
            } catch (err) {
                console.log(`   ${renderer}: ❌ ${err.message}`);
            }
        }
    }
    console.log();

    // 清理
    await destroyThreadPool();
    
    console.log('✅ 示例运行完成');
    console.log(`   输出目录: ${OUTPUT_DIR}`);
}

main().catch(err => {
    console.error('运行失败:', err);
    process.exit(1);
});
