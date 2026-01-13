/**
 * PDF2IMG 性能测试
 *
 * 运行方式：
 *   node test/performance.test.js
 *
 * 此测试用于评估不同大小 PDF 的转换性能
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-perf');

// 测试文件列表
const TEST_FILES = [
    { name: '1M.pdf', description: '小文件 (~1MB)' },
    { name: '10M.pdf', description: '中等文件 (~10MB)' },
    { name: '发票.pdf', description: '发票文件' },
    { name: 'DJI_Osmo_Action_5_Pro_User_Manual_v1.0_chs.pdf', description: 'DJI 用户手册' },
];

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};

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

async function runPerformanceTest() {
    console.log(`${colors.bold}=== PDF2IMG 性能测试 ===${colors.reset}\n`);

    // 动态导入模块
    const { convert, getPageCount, isAvailable, getVersion } = await import('../src/index.js');

    // 检查渲染器
    if (!isAvailable()) {
        console.error(`${colors.red}错误：原生渲染器不可用${colors.reset}`);
        process.exit(1);
    }

    console.log(`原生渲染器版本: ${getVersion()}\n`);

    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const results = [];

    for (const testFile of TEST_FILES) {
        const pdfPath = path.join(STATIC_DIR, testFile.name);

        if (!fs.existsSync(pdfPath)) {
            console.log(`${colors.yellow}跳过: ${testFile.name} (文件不存在)${colors.reset}`);
            continue;
        }

        const stat = fs.statSync(pdfPath);
        const pageCount = await getPageCount(pdfPath);

        console.log(`${colors.cyan}测试: ${testFile.description}${colors.reset}`);
        console.log(`  文件: ${testFile.name}`);
        console.log(`  大小: ${formatBytes(stat.size)}`);
        console.log(`  页数: ${pageCount}`);

        const startTime = Date.now();

        try {
            const result = await convert(pdfPath, {
                outputType: 'file',
                outputDir: OUTPUT_DIR,
                prefix: testFile.name.replace('.pdf', ''),
            });

            const duration = Date.now() - startTime;
            const totalSize = result.pages.reduce((sum, p) => sum + (p.size || 0), 0);

            console.log(`  ${colors.green}成功${colors.reset}: ${result.renderedPages}/${result.numPages} 页`);
            console.log(`  耗时: ${formatDuration(duration)}`);
            console.log(`  平均每页: ${formatDuration(duration / result.renderedPages)}`);
            console.log(`  输出大小: ${formatBytes(totalSize)}`);
            console.log(`  原生渲染耗时: ${formatDuration(result.timing.render)}`);
            console.log('');

            results.push({
                file: testFile.name,
                description: testFile.description,
                inputSize: stat.size,
                pageCount,
                renderedPages: result.renderedPages,
                duration,
                avgPerPage: duration / result.renderedPages,
                outputSize: totalSize,
                nativeTime: result.timing.render,
                success: true,
            });

        } catch (err) {
            console.log(`  ${colors.red}失败${colors.reset}: ${err.message}`);
            console.log('');

            results.push({
                file: testFile.name,
                description: testFile.description,
                inputSize: stat.size,
                pageCount,
                success: false,
                error: err.message,
            });
        }
    }

    // 输出汇总
    console.log(`${colors.bold}=== 性能测试汇总 ===${colors.reset}\n`);
    console.log('| 文件 | 大小 | 页数 | 耗时 | 平均每页 | 输出大小 |');
    console.log('|------|------|------|------|----------|----------|');

    for (const r of results) {
        if (r.success) {
            console.log(`| ${r.file} | ${formatBytes(r.inputSize)} | ${r.pageCount} | ${formatDuration(r.duration)} | ${formatDuration(r.avgPerPage)} | ${formatBytes(r.outputSize)} |`);
        } else {
            console.log(`| ${r.file} | ${formatBytes(r.inputSize)} | ${r.pageCount} | 失败 | - | - |`);
        }
    }

    // 清理输出目录
    console.log(`\n${colors.dim}清理输出目录...${colors.reset}`);
    const files = fs.readdirSync(OUTPUT_DIR);
    for (const file of files) {
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
    }
    fs.rmdirSync(OUTPUT_DIR);

    console.log(`\n${colors.green}性能测试完成！${colors.reset}`);
}

runPerformanceTest().catch(err => {
    console.error(`${colors.red}测试失败: ${err.message}${colors.reset}`);
    console.error(err.stack);
    process.exit(1);
});
