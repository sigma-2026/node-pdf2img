#!/usr/bin/env node
/**
 * node-pdf2img 性能基准测试
 * 
 * 测试从 COS 通过 HTTP Range 请求流式渲染 PDF
 * 对比 PDFium vs PDF.js 渲染器的性能
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
    getThreadPoolStats,
    destroyThreadPool,
} from 'node-pdf2img';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output/benchmark');

// 每个文件最多渲染的页数
const MAX_PAGES_TO_RENDER = 5;

// COS 测试文件列表
const TEST_FILES = [
    {
        name: "通行费电子发票-1.pdf",
        fileSize: 40087,
        url: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6ae95a47-d175-4e5b-8ecc-fee020d8a78c.pdf"
    },
    {
        name: "发票.pdf",
        fileSize: 78679,
        url: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/5f2e998d-8254-4c0d-be87-4fc750a73e2f.pdf"
    },
    {
        name: "股权转让协议书.pdf",
        fileSize: 607415,
        url: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/bb63569f-e37c-43ff-aca2-cfb38ee44774.pdf"
    },
    {
        name: "1M.pdf",
        fileSize: 1016315,
        url: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6fb045a5-ac06-4f93-9661-ff324d4a839b.pdf"
    },
    {
        name: "10M.pdf",
        fileSize: 9181613,
        url: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6a92ea4a-4609-4b61-8488-4f28aeba58c0.pdf"
    },
];

// 格式化文件大小
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 格式化时间
function formatTime(ms) {
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

async function runBenchmark() {
    console.log('='.repeat(70));
    console.log('node-pdf2img 性能基准测试');
    console.log('='.repeat(70));
    console.log();

    // 检查渲染器可用性
    const pdfiumAvailable = isAvailable();
    const pdfjsAvailable = isPdfjsAvailable();
    
    console.log('🔧 渲染器状态:');
    console.log(`   PDFium: ${pdfiumAvailable ? `✓ 可用 (${getVersion()})` : '✗ 不可用'}`);
    console.log(`   PDF.js: ${pdfjsAvailable ? `✓ 可用 (${getPdfjsVersion()})` : '✗ 不可用'}`);
    
    // 确定要测试的渲染器
    const renderersToTest = [];
    if (pdfiumAvailable) renderersToTest.push('pdfium');
    if (pdfjsAvailable) renderersToTest.push('pdfjs');
    
    if (renderersToTest.length === 0) {
        console.error('❌ 没有可用的渲染器');
        process.exit(1);
    }
    
    console.log(`   测试渲染器: ${renderersToTest.join(', ')}`);
    console.log(`   最大渲染页数: ${MAX_PAGES_TO_RENDER}`);
    console.log(`   测试文件数: ${TEST_FILES.length}`);
    console.log();

    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 存储所有测试结果
    const allResults = {};
    for (const renderer of renderersToTest) {
        allResults[renderer] = [];
    }

    // 对每个文件，使用所有可用的渲染器进行测试
    for (const pdfFile of TEST_FILES) {
        console.log(`📄 ${pdfFile.name}`);
        console.log(`   大小: ${formatSize(pdfFile.fileSize)}`);

        for (const renderer of renderersToTest) {
            const rendererIcon = renderer === 'pdfium' ? '🔷' : '🟠';
            const fileResult = { 
                file: pdfFile.name, 
                fileSize: pdfFile.fileSize,
                renderer,
                result: null,
            };

            try {
                const pages = Array.from({ length: MAX_PAGES_TO_RENDER }, (_, i) => i + 1);

                const startTime = performance.now();
                const result = await convert(pdfFile.url, {
                    pages,
                    outputType: 'buffer',
                    format: 'png',
                    targetWidth: 1280,
                    renderer,
                });
                const endTime = performance.now();

                const totalTime = endTime - startTime;
                const avgTimePerPage = totalTime / result.renderedPages;
                const totalOutputSize = result.pages.reduce((sum, p) => sum + (p.size || 0), 0);

                fileResult.result = {
                    success: true,
                    totalTime,
                    avgTimePerPage,
                    numPages: result.numPages,
                    renderedPages: result.renderedPages,
                    outputSize: totalOutputSize,
                    useStream: !!result.streamStats,
                };

                const streamIcon = result.streamStats ? '🌊' : '📥';
                console.log(`   ${rendererIcon} [${renderer.padEnd(6)}] ${streamIcon} 耗时: ${formatTime(totalTime).padEnd(10)} 平均: ${formatTime(avgTimePerPage)}/页  渲染: ${result.renderedPages}/${result.numPages}页`);

            } catch (err) {
                fileResult.result = {
                    success: false,
                    error: err.message,
                };
                console.log(`   ${rendererIcon} [${renderer.padEnd(6)}] ❌ 失败: ${err.message}`);
            }

            allResults[renderer].push(fileResult);
        }

        console.log();
    }

    // 输出汇总
    printSummary(allResults, renderersToTest);

    // 线程池统计
    const poolStats = getThreadPoolStats();
    console.log();
    console.log('🔧 线程池:');
    console.log(`   工作线程: ${poolStats.workers} 个`);
    if (poolStats.initialized) {
        console.log(`   已完成任务: ${poolStats.completed}`);
    }

    console.log();
    console.log('✅ 性能测试完成');

    // 销毁线程池
    await destroyThreadPool();

    return allResults;
}

function printSummary(allResults, renderers) {
    console.log('='.repeat(70));
    console.log('性能汇总');
    console.log('='.repeat(70));
    console.log();

    for (const renderer of renderers) {
        const results = allResults[renderer];
        const rendererIcon = renderer === 'pdfium' ? '🔷' : '🟠';
        console.log(`${rendererIcon} ${renderer.toUpperCase()} 渲染器:`);
        
        const successResults = results.filter(r => r.result?.success);
        
        if (successResults.length > 0) {
            const totalTime = successResults.reduce((sum, r) => sum + r.result.totalTime, 0);
            const totalPages = successResults.reduce((sum, r) => sum + r.result.renderedPages, 0);
            const streamResults = successResults.filter(r => r.result.useStream);
            
            console.log(`   成功: ${successResults.length}/${results.length}`);
            console.log(`   流式渲染: ${streamResults.length}/${successResults.length}`);
            console.log(`   总渲染页数: ${totalPages}`);
            console.log(`   总耗时: ${formatTime(totalTime)}`);
            console.log(`   平均每页: ${formatTime(totalTime / totalPages)}`);
        } else {
            console.log(`   成功: 0/${results.length}`);
        }
        console.log();
    }

    // 如果两个渲染器都有结果，输出对比
    if (renderers.length >= 2) {
        printComparison(allResults);
    }
}

function printComparison(allResults) {
    const pdfiumResults = allResults['pdfium'];
    const pdfjsResults = allResults['pdfjs'];
    
    if (!pdfiumResults || !pdfjsResults) return;

    console.log('='.repeat(70));
    console.log('🔷 PDFium vs 🟠 PDF.js 性能对比');
    console.log('='.repeat(70));
    console.log();

    let pdfiumWins = 0;
    let pdfjsWins = 0;
    let totalPdfiumTime = 0;
    let totalPdfjsTime = 0;
    let bothSuccess = 0;

    for (let i = 0; i < pdfiumResults.length; i++) {
        const pdfium = pdfiumResults[i];
        const pdfjs = pdfjsResults[i];

        if (pdfium.result?.success && pdfjs.result?.success) {
            bothSuccess++;
            totalPdfiumTime += pdfium.result.totalTime;
            totalPdfjsTime += pdfjs.result.totalTime;
            
            if (pdfium.result.totalTime <= pdfjs.result.totalTime) {
                pdfiumWins++;
            } else {
                pdfjsWins++;
            }
        }
    }

    console.log(`📊 对比总结:`);
    console.log(`   可对比文件: ${bothSuccess}/${pdfiumResults.length}`);
    console.log(`   PDFium 更快: ${pdfiumWins} 次`);
    console.log(`   PDF.js 更快: ${pdfjsWins} 次`);
    
    if (bothSuccess > 0) {
        console.log(`   PDFium 总耗时: ${formatTime(totalPdfiumTime)}`);
        console.log(`   PDF.js 总耗时: ${formatTime(totalPdfjsTime)}`);
        
        if (totalPdfiumTime < totalPdfjsTime) {
            const ratio = (totalPdfjsTime / totalPdfiumTime).toFixed(2);
            console.log(`   🏆 PDFium 整体快 ${ratio}x`);
        } else {
            const ratio = (totalPdfiumTime / totalPdfjsTime).toFixed(2);
            console.log(`   🏆 PDF.js 整体快 ${ratio}x`);
        }
    }
}

// 运行测试
runBenchmark().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
});
