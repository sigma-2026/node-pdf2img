#!/usr/bin/env node
/**
 * 流式加载性能测试脚本
 * 
 * 创建本地支持 Range 请求的服务器，测试从 URL 下载 PDF 渲染性能
 * 动态测试 static 目录下所有 PDF 文件（前 10 页）
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { convert, getPageCount, isAvailable, getVersion, getThreadPoolStats, destroyThreadPool, RENDER_CONFIG } from '../packages/pdf2img/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '../static');
const OUTPUT_DIR = path.join(__dirname, '../output/stream-benchmark');

// 服务器端口
const SERVER_PORT = 18765;

// 每个文件最多渲染的页数
const MAX_PAGES_TO_RENDER = 10;

/**
 * 动态获取 static 目录下所有 PDF 文件
 */
function getPdfFiles() {
    const files = fs.readdirSync(STATIC_DIR);
    return files
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .map(name => {
            const filePath = path.join(STATIC_DIR, name);
            const stat = fs.statSync(filePath);
            return {
                name,
                path: filePath,
                size: stat.size,
            };
        })
        .sort((a, b) => a.size - b.size); // 按文件大小排序
}

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
 * 创建支持 Range 请求的静态文件服务器
 */
function createRangeServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url);
            const filePath = path.join(STATIC_DIR, urlPath);

            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const stat = fs.statSync(filePath);
            const fileSize = stat.size;

            if (req.method === 'HEAD') {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Accept-Ranges': 'bytes',
                    'Content-Type': 'application/pdf',
                });
                res.end();
                return;
            }

            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;

                const fileStream = fs.createReadStream(filePath, { start, end });

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': 'application/pdf',
                });

                fileStream.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Accept-Ranges': 'bytes',
                    'Content-Type': 'application/pdf',
                });
                fs.createReadStream(filePath).pipe(res);
            }
        });

        server.listen(SERVER_PORT, () => {
            resolve(server);
        });

        server.on('error', reject);
    });
}

async function runBenchmark() {
    console.log('='.repeat(70));
    console.log('PDF URL 下载渲染性能测试 (PDFium + Sharp)');
    console.log('='.repeat(70));

    // 检查渲染器
    if (!isAvailable()) {
        console.error('❌ 原生渲染器不可用');
        process.exit(1);
    }
    console.log(`渲染器版本: ${getVersion()}`);
    console.log(`最大渲染页数: ${MAX_PAGES_TO_RENDER}`);
    console.log();

    // 启动服务器
    console.log('🚀 启动本地文件服务器...');
    const server = await createRangeServer();
    console.log(`   服务器地址: http://localhost:${SERVER_PORT}`);
    console.log();

    // 动态获取 PDF 文件列表
    const pdfFiles = getPdfFiles();
    console.log(`📁 发现 ${pdfFiles.length} 个 PDF 文件`);
    console.log();

    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const results = [];

    try {
        for (const pdfFile of pdfFiles) {
            const url = `http://localhost:${SERVER_PORT}/${encodeURIComponent(pdfFile.name)}`;
            
            const pageCount = await getPageCount(pdfFile.path);
            const pagesToRender = Math.min(MAX_PAGES_TO_RENDER, pageCount);

            console.log(`📄 ${pdfFile.name}`);
            console.log(`   URL: ${url}`);
            console.log(`   大小: ${formatSize(pdfFile.size)}`);
            console.log(`   总页数: ${pageCount}, 渲染: 前 ${pagesToRender} 页`);
            console.log();

            const formats = ['webp', 'png', 'jpg'];
            const fileResults = { 
                file: pdfFile.name, 
                fileSize: pdfFile.size, 
                pageCount,
                renderedPages: pagesToRender,
                formats: {} 
            };

            for (const format of formats) {
                const outputDir = path.join(OUTPUT_DIR, pdfFile.name.replace('.pdf', ''), format);
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }

                const pages = Array.from({ length: pagesToRender }, (_, i) => i + 1);

                const startTime = performance.now();
                const result = await convert(url, {
                    pages,
                    outputType: 'file',
                    outputDir,
                    format,
                    targetWidth: 1280,
                    webp: { quality: 80, method: 4 },
                    jpeg: { quality: 85 },
                    png: { compressionLevel: 6 },
                });
                const endTime = performance.now();

                const totalTime = endTime - startTime;
                const avgTimePerPage = totalTime / result.renderedPages;

                const outputFiles = fs.readdirSync(outputDir);
                const totalOutputSize = outputFiles.reduce((sum, f) => {
                    return sum + fs.statSync(path.join(outputDir, f)).size;
                }, 0);

                fileResults.formats[format] = {
                    totalTime,
                    avgTimePerPage,
                    outputSize: totalOutputSize,
                    pages: result.renderedPages,
                };

                console.log(`   ${format.toUpperCase().padEnd(4)}: ${formatTime(totalTime).padStart(8)} (${formatTime(avgTimePerPage).padStart(6)}/页), 输出 ${formatSize(totalOutputSize).padStart(8)}`);
            }

            results.push(fileResults);
            console.log();
        }

        // 输出汇总
        console.log('='.repeat(70));
        console.log(`性能汇总 (前 ${MAX_PAGES_TO_RENDER} 页)`);
        console.log('='.repeat(70));
        console.log();
        console.log('| 文件 | 大小 | 渲染页 | WebP | PNG | JPG |');
        console.log('|------|------|--------|------|-----|-----|');

        for (const r of results) {
            const fileName = r.file.length > 20 ? r.file.slice(0, 17) + '...' : r.file;
            const webp = r.formats.webp ? formatTime(r.formats.webp.totalTime) : '-';
            const png = r.formats.png ? formatTime(r.formats.png.totalTime) : '-';
            const jpg = r.formats.jpg ? formatTime(r.formats.jpg.totalTime) : '-';
            console.log(`| ${fileName.padEnd(20)} | ${formatSize(r.fileSize).padEnd(8)} | ${String(r.renderedPages).padEnd(6)} | ${webp.padEnd(8)} | ${png.padEnd(8)} | ${jpg.padEnd(8)} |`);
        }

        // 获取线程池统计
        const poolStats = getThreadPoolStats();

        console.log();
        console.log('📝 说明:');
        console.log('   架构: PDFium 渲染 + Sharp 编码 (piscina 线程池)');
        console.log(`   工作线程: ${poolStats.workers} 个`);
        console.log('   下载: 流式下载到临时文件后渲染');
        if (poolStats.initialized) {
            console.log(`   已完成任务: ${poolStats.completed}`);
            console.log(`   线程利用率: ${(poolStats.utilization * 100).toFixed(1)}%`);
        }
        console.log();
        console.log('✅ URL 下载渲染性能测试完成');
        console.log(`   输出目录: ${OUTPUT_DIR}`);

        // 销毁线程池
        await destroyThreadPool();

    } finally {
        server.close();
        console.log('\n🛑 服务器已关闭');
    }

    return results;
}

// 运行测试
runBenchmark().catch(console.error);
