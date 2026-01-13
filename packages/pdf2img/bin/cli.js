#!/usr/bin/env node

/**
 * pdf2img CLI - 命令行 PDF 转图片工具
 *
 * 用法：
 *   pdf2img <input> [options]
 *
 * 示例：
 *   pdf2img document.pdf -o ./output
 *   pdf2img https://example.com/doc.pdf -o ./output
 *   pdf2img document.pdf -p 1,2,3 -o ./output
 *   pdf2img document.pdf --quality 90 --width 1920 -o ./output
 *   pdf2img document.pdf --format png -o ./output  # 输出 PNG 格式
 *   pdf2img document.pdf --cos --cos-prefix images/doc  # 上传到 COS
 *
 * COS 环境变量：
 *   COS_SECRET_ID     - 腾讯云 SecretId
 *   COS_SECRET_KEY    - 腾讯云 SecretKey
 *   COS_BUCKET        - COS 存储桶名称
 *   COS_REGION        - COS 地域（如 ap-guangzhou）
 */

import { program } from 'commander';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

// 动态导入 ora（ESM 模块）
let ora;
try {
    ora = (await import('ora')).default;
} catch {
    // 如果 ora 不可用，提供一个简单的替代
    ora = (text) => ({
        start: () => ({ text, succeed: () => {}, fail: () => {}, stop: () => {} }),
    });
}

// 处理 --version-info 选项（在解析前检查）
if (process.argv.includes('--version-info')) {
    const { isAvailable, getVersion } = await import('../src/index.js');
    console.log(`pdf2img v${pkg.version}`);
    console.log(`原生渲染器: ${getVersion()}`);
    console.log(`可用: ${isAvailable() ? '是' : '否'}`);
    process.exit(0);
}

program
    .name('pdf2img')
    .description('高性能 PDF 转图片工具，基于 PDFium')
    .version(pkg.version)
    .argument('<input>', 'PDF 文件路径或 URL')
    .option('-o, --output <dir>', '输出目录（本地模式）', './output')
    .option('-p, --pages <pages>', '要转换的页码（逗号分隔，如 1,2,3）')
    .option('-w, --width <width>', '目标渲染宽度（像素）', '1920')
    .option('-q, --quality <quality>', '图片质量（0-100，用于 webp/jpg）', '100')
    .option('-f, --format <format>', '输出格式：webp, png, jpg', 'webp')
    .option('--fast', '快速模式（牺牲压缩率换取速度）')
    .option('--prefix <prefix>', '输出文件名前缀', 'page')
    .option('--info', '仅显示 PDF 信息（页数）')
    .option('--version-info', '显示原生渲染器版本')
    .option('-v, --verbose', '详细输出')
    // COS 相关选项
    .option('--cos', '上传到腾讯云 COS（需配置环境变量）')
    .option('--cos-prefix <prefix>', 'COS key 前缀（如 images/doc-123）')
    .option('--cos-secret-id <id>', 'COS SecretId（优先使用环境变量 COS_SECRET_ID）')
    .option('--cos-secret-key <key>', 'COS SecretKey（优先使用环境变量 COS_SECRET_KEY）')
    .option('--cos-bucket <bucket>', 'COS 存储桶（优先使用环境变量 COS_BUCKET）')
    .option('--cos-region <region>', 'COS 地域（优先使用环境变量 COS_REGION）')
    .action(async (input, options) => {
        // 设置调试模式
        if (options.verbose) {
            process.env.PDF2IMG_DEBUG = 'true';
        }

        // 动态导入主模块
        const { convert, getPageCount, isAvailable, getVersion } = await import('../src/index.js');

        // 显示版本信息
        if (options.versionInfo) {
            console.log(`pdf2img v${pkg.version}`);
            console.log(`原生渲染器: ${getVersion()}`);
            console.log(`可用: ${isAvailable() ? '是' : '否'}`);
            return;
        }

        // 检查 native renderer
        if (!isAvailable()) {
            console.error('错误：原生渲染器不可用。');
            console.error('请确保 PDFium 库已正确安装。');
            process.exit(1);
        }

        // 验证格式
        const supportedFormats = ['webp', 'png', 'jpg', 'jpeg'];
        const format = options.format.toLowerCase();
        if (!supportedFormats.includes(format)) {
            console.error(`错误：不支持的格式 "${options.format}"。支持的格式：webp, png, jpg`);
            process.exit(1);
        }

        // 检查输入
        const isUrl = input.startsWith('http://') || input.startsWith('https://');
        if (!isUrl && !fs.existsSync(input)) {
            console.error(`错误：文件不存在: ${input}`);
            process.exit(1);
        }

        // 仅显示 PDF 信息
        if (options.info) {
            if (isUrl) {
                console.error('错误：--info 选项仅支持本地文件');
                process.exit(1);
            }

            try {
                const pageCount = getPageCount(input);
                const stat = fs.statSync(input);
                console.log(`文件: ${path.basename(input)}`);
                console.log(`大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
                console.log(`页数: ${pageCount}`);
            } catch (err) {
                console.error(`错误: ${err.message}`);
                process.exit(1);
            }
            return;
        }

        // 解析页码
        let pages = [];
        if (options.pages) {
            pages = options.pages.split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
        }

        // 确定输出类型和配置
        let outputType = 'file';
        let convertOptions = {
            pages,
            prefix: options.prefix,
            targetWidth: parseInt(options.width, 10),
            quality: parseInt(options.quality, 10),
            format: format,
            fast: options.fast || false,
        };

        // COS 模式
        if (options.cos) {
            outputType = 'cos';

            // 从环境变量或命令行参数获取 COS 配置
            const cosConfig = {
                secretId: options.cosSecretId || process.env.COS_SECRET_ID,
                secretKey: options.cosSecretKey || process.env.COS_SECRET_KEY,
                bucket: options.cosBucket || process.env.COS_BUCKET,
                region: options.cosRegion || process.env.COS_REGION,
            };

            // 验证 COS 配置
            const missingFields = [];
            if (!cosConfig.secretId) missingFields.push('COS_SECRET_ID');
            if (!cosConfig.secretKey) missingFields.push('COS_SECRET_KEY');
            if (!cosConfig.bucket) missingFields.push('COS_BUCKET');
            if (!cosConfig.region) missingFields.push('COS_REGION');

            if (missingFields.length > 0) {
                console.error('错误：COS 配置不完整，缺少以下环境变量或参数：');
                console.error(`  ${missingFields.join(', ')}`);
                console.error('\n请设置环境变量或使用命令行参数：');
                console.error('  export COS_SECRET_ID=xxx');
                console.error('  export COS_SECRET_KEY=xxx');
                console.error('  export COS_BUCKET=xxx');
                console.error('  export COS_REGION=ap-guangzhou');
                process.exit(1);
            }

            convertOptions.cos = cosConfig;
            convertOptions.cosKeyPrefix = options.cosPrefix || '';
        } else {
            // 本地文件模式
            convertOptions.outputDir = options.output;
        }

        convertOptions.outputType = outputType;

        // 开始转换
        const modeText = options.cos ? '转换并上传' : '转换';
        const spinner = ora(`正在${modeText} ${path.basename(input)}...`).start();

        try {
            const startTime = Date.now();

            const result = await convert(input, convertOptions);

            const duration = Date.now() - startTime;

            spinner.succeed(`${modeText}完成 ${result.renderedPages}/${result.numPages} 页，格式: ${result.format.toUpperCase()}，耗时 ${duration}ms`);

            // 显示结果
            if (options.cos) {
                console.log('\n已上传到 COS:');
                for (const page of result.pages) {
                    if (page.success) {
                        console.log(`  第 ${page.pageNum} 页: ${page.width}x${page.height} -> ${page.cosKey} (${formatBytes(page.size)})`);
                    } else {
                        console.log(`  第 ${page.pageNum} 页: 失败 - ${page.error}`);
                    }
                }
            } else {
                console.log(`\n输出目录: ${path.resolve(options.output)}`);
                console.log('\n页面详情:');
                for (const page of result.pages) {
                    if (page.success) {
                        console.log(`  第 ${page.pageNum} 页: ${page.width}x${page.height} -> ${path.basename(page.outputPath)} (${formatBytes(page.size)})`);
                    } else {
                        console.log(`  第 ${page.pageNum} 页: 失败 - ${page.error}`);
                    }
                }
            }

            // 统计
            const totalSize = result.pages.reduce((sum, p) => sum + (p.size || 0), 0);
            console.log(`\n总输出大小: ${formatBytes(totalSize)}`);
            console.log(`平均每页耗时: ${Math.round(duration / result.renderedPages)}ms`);

        } catch (err) {
            spinner.fail(`${modeText}失败: ${err.message}`);
            if (options.verbose) {
                console.error(err.stack);
            }
            process.exit(1);
        }
    });

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

program.parse();
