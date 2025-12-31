#!/usr/bin/env node
/**
 * 本地 PDF 转图片脚本
 * 
 * 用法:
 *   node test/local-pdf2img.mjs <pdf路径>
 *   node test/local-pdf2img.mjs static/test.pdf
 *   node test/local-pdf2img.mjs /absolute/path/to/file.pdf
 * 
 * 功能:
 *   - 读取本地 PDF 文件
 *   - 渲染所有页面为 WebP 图片
 *   - 输出到 output 目录（运行前自动清空）
 *   - 打印详细日志
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// ==================== 配置 ====================

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const CMAP_URL = path.join(PROJECT_ROOT, 'node_modules/pdfjs-dist/cmaps/');
const STANDARD_FONT_DATA_URL = path.join(PROJECT_ROOT, 'node_modules/pdfjs-dist/standard_fonts/');
// wasm 文件路径（用于 openjpeg 和 qcms）
const WASM_URL = 'file://' + path.join(PROJECT_ROOT, 'node_modules/pdfjs-dist/wasm/');

// 渲染配置
const TARGET_RENDER_WIDTH = parseInt(process.env.TARGET_RENDER_WIDTH) || 1280;
const MAX_RENDER_SCALE = parseFloat(process.env.MAX_RENDER_SCALE) || 4.0;
const XLARGE_PAGE_THRESHOLD = parseInt(process.env.XLARGE_PAGE_THRESHOLD) || 4000 * 4000;
const XLARGE_PAGE_SCALE = parseFloat(process.env.XLARGE_PAGE_SCALE) || 0.75;
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY) || 80;

// ==================== 日志工具 ====================

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelColors = {
        INFO: colors.green,
        WARN: colors.yellow,
        ERROR: colors.red,
        DEBUG: colors.dim,
        PERF: colors.cyan,
    };
    const color = levelColors[level] || colors.reset;
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`${timestamp} ${color}[${level}]${colors.reset} ${message}${dataStr}`);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

// ==================== Sharp 加载 ====================

let sharp = null;
let sharpAvailable = false;

try {
    sharp = (await import('sharp')).default;
    sharpAvailable = true;
    log('INFO', 'sharp 库已加载，使用 libvips 高性能编码');
} catch (e) {
    log('WARN', 'sharp 库未安装，回退到 canvas.toBuffer 编码');
}

// ==================== 编码函数 ====================

async function encodeWithSharp(data, width, height) {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    
    return sharp(buffer, {
        raw: {
            width: Math.round(width),
            height: Math.round(height),
            channels: 4,
        },
    })
    .webp({ 
        quality: WEBP_QUALITY,
        alphaQuality: 85,
        smartSubsample: true,
    })
    .toBuffer();
}

// ==================== 渲染函数 ====================

async function renderPage(pdfDocument, pageNum) {
    let page;
    let canvasAndContext;
    const pageStartTime = Date.now();
    const timing = {
        getPage: 0,
        render: 0,
        encode: 0,
        total: 0,
    };
    
    try {
        // 1. 获取页面
        const getPageStart = Date.now();
        page = await pdfDocument.getPage(pageNum);
        timing.getPage = Date.now() - getPageStart;
        
        // 2. 获取原始页面尺寸
        const originalViewport = page.getViewport({ scale: 1.0 });
        const originalWidth = originalViewport.width;
        const originalHeight = originalViewport.height;
        
        log('DEBUG', `Page ${pageNum} 原始尺寸: ${Math.round(originalWidth)}x${Math.round(originalHeight)}`);
        
        // 3. 计算缩放比例
        let scale = TARGET_RENDER_WIDTH / originalWidth;
        scale = Math.min(scale, MAX_RENDER_SCALE);
        
        let viewport = page.getViewport({ scale });
        
        // 4. 超大页面安全网
        if (viewport.width * viewport.height > XLARGE_PAGE_THRESHOLD) {
            log('WARN', `Page ${pageNum} 尺寸异常 (${Math.round(viewport.width)}x${Math.round(viewport.height)})，强制应用安全降级缩放`);
            viewport = page.getViewport({ scale: scale * XLARGE_PAGE_SCALE });
        }
        
        const width = Math.round(viewport.width);
        const height = Math.round(viewport.height);
        
        log('DEBUG', `Page ${pageNum} 渲染尺寸: ${width}x${height}, scale=${scale.toFixed(3)}`);
        
        // 5. 创建 canvas 并渲染
        canvasAndContext = pdfDocument.canvasFactory.create(width, height);
        
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
        };
        
        const renderStart = Date.now();
        const renderTask = page.render(renderContext);
        await renderTask.promise;
        timing.render = Date.now() - renderStart;
        
        // 6. 编码为 WebP
        const encodeStart = Date.now();
        let buffer;
        
        if (sharpAvailable) {
            const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
            buffer = await encodeWithSharp(imageData.data, width, height);
        } else {
            buffer = canvasAndContext.canvas.toBuffer("image/webp");
        }
        timing.encode = Date.now() - encodeStart;
        timing.total = Date.now() - pageStartTime;
        
        log('PERF', `Page ${pageNum} 渲染完成`, {
            size: `${width}x${height}`,
            scale: scale.toFixed(3),
            timing: `getPage=${timing.getPage}ms, render=${timing.render}ms, encode=${timing.encode}ms, total=${timing.total}ms`,
            bufferSize: formatBytes(buffer.length),
        });
        
        return {
            pageNum,
            buffer,
            width,
            height,
            scale: parseFloat(scale.toFixed(3)),
            success: true,
            timing,
        };
    } catch (error) {
        timing.total = Date.now() - pageStartTime;
        log('ERROR', `渲染页面 ${pageNum} 失败: ${error.message}`);
        return {
            pageNum,
            success: false,
            error: error.message,
            timing,
        };
    } finally {
        try {
            if (page) page.cleanup();
        } catch (e) { /* 忽略 */ }
        
        try {
            if (canvasAndContext && pdfDocument) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        } catch (e) { /* 忽略 */ }
    }
}

// ==================== 主函数 ====================

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
${colors.bold}本地 PDF 转图片脚本${colors.reset}

${colors.cyan}用法:${colors.reset}
  node test/local-pdf2img.mjs <pdf路径>

${colors.cyan}示例:${colors.reset}
  node test/local-pdf2img.mjs static/test.pdf
  node test/local-pdf2img.mjs /absolute/path/to/file.pdf
  node test/local-pdf2img.mjs "static/大图内存性能素材.pdf"

${colors.cyan}输出:${colors.reset}
  图片将保存到 output/ 目录（运行前自动清空）
`);
        process.exit(1);
    }
    
    const inputPath = args[0];
    
    // 解析 PDF 路径
    let pdfPath;
    if (path.isAbsolute(inputPath)) {
        pdfPath = inputPath;
    } else {
        pdfPath = path.join(PROJECT_ROOT, inputPath);
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(pdfPath)) {
        log('ERROR', `PDF 文件不存在: ${pdfPath}`);
        process.exit(1);
    }
    
    const pdfFileName = path.basename(pdfPath, '.pdf');
    const pdfSize = fs.statSync(pdfPath).size;
    
    log('INFO', `开始处理 PDF: ${pdfPath}`);
    log('INFO', `文件大小: ${formatBytes(pdfSize)}`);
    
    // 清空并创建 output 目录
    if (fs.existsSync(OUTPUT_DIR)) {
        log('INFO', `清空 output 目录: ${OUTPUT_DIR}`);
        const files = fs.readdirSync(OUTPUT_DIR);
        for (const file of files) {
            const filePath = path.join(OUTPUT_DIR, file);
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
            }
        }
    } else {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    const totalStartTime = Date.now();
    
    try {
        // 读取 PDF 文件
        log('INFO', '读取 PDF 文件...');
        const pdfData = new Uint8Array(fs.readFileSync(pdfPath));
        
        // 加载 PDF 文档
        log('INFO', '加载 PDF 文档...');
        const loadingTask = getDocument({
            data: pdfData,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            wasmUrl: WASM_URL,
        });
        
        const pdfDocument = await loadingTask.promise;
        const numPages = pdfDocument.numPages;
        
        log('INFO', `PDF 加载完成，共 ${numPages} 页`);
        
        // 渲染所有页面
        const results = [];
        let successCount = 0;
        let totalBufferSize = 0;
        
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            log('INFO', `渲染页面 ${pageNum}/${numPages}...`);
            
            const result = await renderPage(pdfDocument, pageNum);
            results.push(result);
            
            if (result.success) {
                // 保存图片
                const outputFileName = `${pdfFileName}_page_${pageNum}.webp`;
                const outputPath = path.join(OUTPUT_DIR, outputFileName);
                fs.writeFileSync(outputPath, result.buffer);
                
                log('INFO', `已保存: ${outputFileName} (${formatBytes(result.buffer.length)})`);
                
                successCount++;
                totalBufferSize += result.buffer.length;
            }
        }
        
        // 销毁 PDF 文档
        await pdfDocument.destroy();
        
        const totalTime = Date.now() - totalStartTime;
        
        // 输出统计信息
        console.log('\n' + '='.repeat(60));
        log('INFO', `${colors.bold}处理完成${colors.reset}`);
        console.log('='.repeat(60));
        console.log(`  PDF 文件:     ${pdfPath}`);
        console.log(`  PDF 大小:     ${formatBytes(pdfSize)}`);
        console.log(`  总页数:       ${numPages}`);
        console.log(`  成功渲染:     ${successCount}/${numPages}`);
        console.log(`  输出目录:     ${OUTPUT_DIR}`);
        console.log(`  图片总大小:   ${formatBytes(totalBufferSize)}`);
        console.log(`  总耗时:       ${formatDuration(totalTime)}`);
        console.log(`  平均每页:     ${formatDuration(totalTime / numPages)}`);
        console.log('='.repeat(60));
        
        // 输出每页详情
        console.log('\n页面详情:');
        console.log('-'.repeat(60));
        for (const result of results) {
            if (result.success) {
                console.log(`  Page ${result.pageNum}: ${result.width}x${result.height}, ` +
                    `render=${result.timing.render}ms, encode=${result.timing.encode}ms, ` +
                    `total=${result.timing.total}ms`);
            } else {
                console.log(`  Page ${result.pageNum}: ${colors.red}失败${colors.reset} - ${result.error}`);
            }
        }
        console.log('-'.repeat(60));
        
    } catch (error) {
        log('ERROR', `处理失败: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

main().catch(error => {
    log('ERROR', `未捕获的错误: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
});
