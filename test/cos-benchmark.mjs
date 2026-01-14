#!/usr/bin/env node
/**
 * COS 流式渲染性能测试脚本
 * 
 * 测试从腾讯云 COS 通过 HTTP Range 请求流式渲染 PDF
 * 对比流式渲染 vs 完整下载渲染的性能
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { convert, isAvailable, getVersion, getThreadPoolStats, destroyThreadPool } from '../packages/pdf2img/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '../output/cos-benchmark');

// 每个文件最多渲染的页数
const MAX_PAGES_TO_RENDER = 5;

// COS 测试文件列表
const COS_FILES = [
    {
        name: "通行费电子发票-1.pdf",
        fileId: "6ae95a47-d175-4e5b-8ecc-fee020d8a78c",
        fileSize: 40087,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6ae95a47-d175-4e5b-8ecc-fee020d8a78c.pdf"
    },
    {
        name: "发票.pdf",
        fileId: "5f2e998d-8254-4c0d-be87-4fc750a73e2f",
        fileSize: 78679,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/5f2e998d-8254-4c0d-be87-4fc750a73e2f.pdf"
    },
    {
        name: "股权转让协议书 (2).pdf",
        fileId: "bb63569f-e37c-43ff-aca2-cfb38ee44774",
        fileSize: 607415,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/bb63569f-e37c-43ff-aca2-cfb38ee44774.pdf"
    },
    {
        name: "31_导入_发票PDF.pdf",
        fileId: "711ab3df-4ab3-446a-8c71-717b04f2a1e1",
        fileSize: 942642,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/711ab3df-4ab3-446a-8c71-717b04f2a1e1.pdf"
    },
    {
        name: "1M.pdf",
        fileId: "6fb045a5-ac06-4f93-9661-ff324d4a839b",
        fileSize: 1016315,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6fb045a5-ac06-4f93-9661-ff324d4a839b.pdf"
    },
    {
        name: "【JS】2047__JS的这些新特性，你都用过么？.pdf",
        fileId: "4ed0b144-b7c4-471a-8e50-f7bcc2ba4d5b",
        fileSize: 1081950,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/4ed0b144-b7c4-471a-8e50-f7bcc2ba4d5b.pdf"
    },
    {
        name: "固收专题分析报告：城投非标手册西南篇（2019版）-20191008-国金证券-24页.pdf",
        fileId: "a9b18079-f51f-4ef6-8679-3ef4bbcbcfe4",
        fileSize: 1832872,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/a9b18079-f51f-4ef6-8679-3ef4bbcbcfe4.pdf"
    },
    {
        name: "大图内存性能素材.pdf",
        fileId: "d9c94e1f-7264-4813-8257-359cdab2b879",
        fileSize: 7969986,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/d9c94e1f-7264-4813-8257-359cdab2b879.pdf"
    },
    {
        name: "10M.pdf",
        fileId: "6a92ea4a-4609-4b61-8488-4f28aeba58c0",
        fileSize: 9181613,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/6a92ea4a-4609-4b61-8488-4f28aeba58c0.pdf"
    },
    {
        name: "流动性风险-精讲阶段讲义（上）_1.pdf",
        fileId: "dd97721c-78d5-4e22-bef2-5018d85ea7a8",
        fileSize: 10183570,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/dd97721c-78d5-4e22-bef2-5018d85ea7a8.pdf"
    },
    {
        name: "四年级数学.pdf",
        fileId: "2de93b91-cf7a-4776-b2b5-85d47973b546",
        fileSize: 21904847,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/2de93b91-cf7a-4776-b2b5-85d47973b546.pdf"
    },
    {
        name: "50M.pdf",
        fileId: "f4af89fb-5d54-46b2-9f00-e14804dd577c",
        fileSize: 57999100,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/f4af89fb-5d54-46b2-9f00-e14804dd577c.pdf"
    },
    {
        name: "80M.pdf",
        fileId: "d8283662-e165-416f-a443-ea38919014a7",
        fileSize: 81641018,
        publicUrl: "https://tdocs-cos-1257943044.cos-internal.ap-guangzhou.tencentcos.cn/uploads/pdf/2026-01-13/d8283662-e165-416f-a443-ea38919014a7.pdf"
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

/**
 * 测试 COS Range 请求支持
 */
async function testRangeSupport(url) {
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(10000),
        });
        
        const acceptRanges = response.headers.get('accept-ranges');
        return acceptRanges === 'bytes';
    } catch (err) {
        console.error(`   ⚠️  HEAD 请求失败: ${err.message}`);
        return false;
    }
}

async function runBenchmark() {
    console.log('='.repeat(70));
    console.log('COS 流式渲染性能测试 (PDFium + Sharp)');
    console.log('='.repeat(70));

    // 检查渲染器
    if (!isAvailable()) {
        console.error('❌ 原生渲染器不可用');
        process.exit(1);
    }
    console.log(`渲染器版本: ${getVersion()}`);
    console.log(`最大渲染页数: ${MAX_PAGES_TO_RENDER}`);
    console.log(`测试文件数: ${COS_FILES.length}`);
    console.log();

    // 测试第一个文件的 Range 支持
    console.log('🔍 检查 COS Range 请求支持...');
    const rangeSupported = await testRangeSupport(COS_FILES[0].publicUrl);
    console.log(`   Range 请求: ${rangeSupported ? '✓ 支持' : '✗ 不支持'}`);
    console.log();

    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const results = [];

    for (const pdfFile of COS_FILES) {
        console.log(`📄 ${pdfFile.name}`);
        console.log(`   大小: ${formatSize(pdfFile.fileSize)}`);
        console.log(`   FileID: ${pdfFile.fileId}`);

        const fileResults = { 
            file: pdfFile.name, 
            fileId: pdfFile.fileId,
            fileSize: pdfFile.fileSize, 
            results: {},
        };

        try {
            // 生成页码数组
            const pages = Array.from({ length: MAX_PAGES_TO_RENDER }, (_, i) => i + 1);

            const startTime = performance.now();
            const result = await convert(pdfFile.publicUrl, {
                pages,
                outputType: 'buffer',
                format: 'png',
                targetWidth: 1280,
            });
            const endTime = performance.now();

            const totalTime = endTime - startTime;
            const avgTimePerPage = totalTime / result.renderedPages;

            // 计算输出大小
            const totalOutputSize = result.pages.reduce((sum, p) => sum + (p.size || 0), 0);

            fileResults.results = {
                success: true,
                totalTime,
                avgTimePerPage,
                numPages: result.numPages,
                renderedPages: result.renderedPages,
                outputSize: totalOutputSize,
                useStream: !!result.streamStats,
                streamStats: result.streamStats,
            };

            const streamIcon = result.streamStats ? '🌊' : '📥';
            console.log(`   ${streamIcon} 总耗时: ${formatTime(totalTime)}, 平均: ${formatTime(avgTimePerPage)}/页`);
            console.log(`   📊 总页数: ${result.numPages}, 渲染: ${result.renderedPages} 页, 输出: ${formatSize(totalOutputSize)}`);
            
            if (result.streamStats) {
                console.log(`   🔗 流式渲染, 缓存命中: ${result.streamStats.cacheHits || 0}`);
            }

        } catch (err) {
            fileResults.results = {
                success: false,
                error: err.message,
            };
            console.log(`   ❌ 失败: ${err.message}`);
        }

        results.push(fileResults);
        console.log();
    }

    // 输出汇总表格
    console.log('='.repeat(70));
    console.log('性能汇总');
    console.log('='.repeat(70));
    console.log();

    // 表头
    console.log('| 文件名 | 大小 | 总页数 | 渲染页 | 耗时 | 平均/页 | 模式 |');
    console.log('|--------|------|--------|--------|------|---------|------|');

    for (const r of results) {
        const fileName = r.file.length > 25 ? r.file.slice(0, 22) + '...' : r.file;
        
        if (r.results.success) {
            const mode = r.results.useStream ? '流式' : '下载';
            console.log(`| ${fileName.padEnd(25)} | ${formatSize(r.fileSize).padEnd(8)} | ${String(r.results.numPages).padEnd(6)} | ${String(r.results.renderedPages).padEnd(6)} | ${formatTime(r.results.totalTime).padEnd(8)} | ${formatTime(r.results.avgTimePerPage).padEnd(8)} | ${mode} |`);
        } else {
            console.log(`| ${fileName.padEnd(25)} | ${formatSize(r.fileSize).padEnd(8)} | - | - | 失败 | - | - |`);
        }
    }

    // 统计
    const successResults = results.filter(r => r.results.success);
    const streamResults = successResults.filter(r => r.results.useStream);
    
    console.log();
    console.log('📊 统计:');
    console.log(`   成功: ${successResults.length}/${results.length}`);
    console.log(`   流式渲染: ${streamResults.length}/${successResults.length}`);
    
    if (successResults.length > 0) {
        const totalTime = successResults.reduce((sum, r) => sum + r.results.totalTime, 0);
        const totalPages = successResults.reduce((sum, r) => sum + r.results.renderedPages, 0);
        console.log(`   总渲染页数: ${totalPages}`);
        console.log(`   总耗时: ${formatTime(totalTime)}`);
        console.log(`   平均每页: ${formatTime(totalTime / totalPages)}`);
    }

    // 获取线程池统计
    const poolStats = getThreadPoolStats();
    console.log();
    console.log('🔧 线程池:');
    console.log(`   工作线程: ${poolStats.workers} 个`);
    if (poolStats.initialized) {
        console.log(`   已完成任务: ${poolStats.completed}`);
        console.log(`   利用率: ${(poolStats.utilization * 100).toFixed(1)}%`);
    }

    console.log();
    console.log('✅ COS 流式渲染性能测试完成');

    // 销毁线程池
    await destroyThreadPool();

    return results;
}

// 运行测试
runBenchmark().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
});
