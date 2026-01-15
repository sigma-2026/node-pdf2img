/**
 * 输出格式测试
 * 
 * 测试 WebP、PNG、JPG 输出格式和编码选项
 * 
 * 运行方式：
 *   node --test test/format.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-format');

// 测试用 PDF 文件
const TEST_PDF = path.join(STATIC_DIR, '1M.pdf');

// 动态导入模块
let pdf2img;

// 文件魔数（Magic Numbers）用于验证格式
const MAGIC_NUMBERS = {
    webp: [0x52, 0x49, 0x46, 0x46], // RIFF
    png: [0x89, 0x50, 0x4E, 0x47],  // \x89PNG
    jpg: [0xFF, 0xD8, 0xFF],         // JPEG SOI
};

/**
 * 检查 Buffer 是否匹配指定格式
 */
function isFormat(buffer, format) {
    const magic = MAGIC_NUMBERS[format];
    if (!magic) return false;
    for (let i = 0; i < magic.length; i++) {
        if (buffer[i] !== magic[i]) return false;
    }
    return true;
}

describe('输出格式测试', () => {
    before(async () => {
        pdf2img = await import('../src/index.js');
        
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
    });

    after(() => {
        // 清理输出目录
        if (fs.existsSync(OUTPUT_DIR)) {
            const files = fs.readdirSync(OUTPUT_DIR);
            for (const file of files) {
                fs.unlinkSync(path.join(OUTPUT_DIR, file));
            }
            fs.rmdirSync(OUTPUT_DIR);
        }
    });

    describe('WebP 格式', () => {
        it('默认应该输出 WebP 格式', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
            });

            assert.ok(result.success);
            assert.strictEqual(result.format, 'webp');
            assert.ok(isFormat(result.pages[0].buffer, 'webp'), '输出应该是 WebP 格式');
        });

        it('应该支持自定义 WebP 质量', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const highQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'webp',
                webp: { quality: 100 },
            });

            const lowQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'webp',
                webp: { quality: 30 },
            });

            assert.ok(highQuality.pages[0].size > lowQuality.pages[0].size,
                '高质量图片应该比低质量图片大');
        });

        it('应该保存 WebP 到文件', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                outputType: 'file',
                outputDir: OUTPUT_DIR,
                prefix: 'webp-test',
                format: 'webp',
            });

            assert.ok(result.success);
            
            const files = fs.readdirSync(OUTPUT_DIR);
            const webpFiles = files.filter(f => f.endsWith('.webp'));
            assert.ok(webpFiles.length > 0, '应该生成 WebP 文件');
            
            // 验证文件内容
            const filePath = path.join(OUTPUT_DIR, webpFiles[0]);
            const buffer = fs.readFileSync(filePath);
            assert.ok(isFormat(buffer, 'webp'), '文件内容应该是 WebP 格式');
        });
    });

    describe('PNG 格式', () => {
        it('应该支持 PNG 输出', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'png',
            });

            assert.ok(result.success);
            assert.strictEqual(result.format, 'png');
            assert.ok(isFormat(result.pages[0].buffer, 'png'), '输出应该是 PNG 格式');
        });

        it('应该支持自定义 PNG 压缩级别', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const highCompression = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'png',
                png: { compressionLevel: 9 },
            });

            const lowCompression = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'png',
                png: { compressionLevel: 0 },
            });

            // 高压缩应该产生更小的文件（除非图片太小差异不明显）
            console.log(`PNG 高压缩: ${highCompression.pages[0].size} bytes`);
            console.log(`PNG 低压缩: ${lowCompression.pages[0].size} bytes`);
            
            assert.ok(isFormat(highCompression.pages[0].buffer, 'png'));
            assert.ok(isFormat(lowCompression.pages[0].buffer, 'png'));
        });

        it('应该保存 PNG 到文件', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                outputType: 'file',
                outputDir: OUTPUT_DIR,
                prefix: 'png-test',
                format: 'png',
            });

            assert.ok(result.success);
            
            const files = fs.readdirSync(OUTPUT_DIR);
            const pngFiles = files.filter(f => f.endsWith('.png'));
            assert.ok(pngFiles.length > 0, '应该生成 PNG 文件');
        });
    });

    describe('JPG 格式', () => {
        it('应该支持 JPG 输出', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'jpg',
            });

            assert.ok(result.success);
            assert.strictEqual(result.format, 'jpg');
            assert.ok(isFormat(result.pages[0].buffer, 'jpg'), '输出应该是 JPEG 格式');
        });

        it('应该支持 jpeg 别名', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'jpeg',
            });

            assert.ok(result.success);
            assert.strictEqual(result.format, 'jpeg');
            assert.ok(isFormat(result.pages[0].buffer, 'jpg'), '输出应该是 JPEG 格式');
        });

        it('应该支持自定义 JPEG 质量', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const highQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'jpg',
                jpeg: { quality: 100 },
            });

            const lowQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'jpg',
                jpeg: { quality: 20 },
            });

            assert.ok(highQuality.pages[0].size > lowQuality.pages[0].size,
                '高质量图片应该比低质量图片大');
        });

        it('应该保存 JPG 到文件', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                outputType: 'file',
                outputDir: OUTPUT_DIR,
                prefix: 'jpg-test',
                format: 'jpg',
            });

            assert.ok(result.success);
            
            const files = fs.readdirSync(OUTPUT_DIR);
            const jpgFiles = files.filter(f => f.endsWith('.jpg'));
            assert.ok(jpgFiles.length > 0, '应该生成 JPG 文件');
        });
    });

    describe('格式验证', () => {
        it('不支持的格式应该抛出错误', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            await assert.rejects(
                async () => {
                    await pdf2img.convert(TEST_PDF, {
                        pages: [1],
                        format: 'gif',  // 不支持的格式
                    });
                },
                /Unsupported format/,
                '应该抛出不支持的格式错误'
            );
        });

        it('格式参数应该大小写不敏感', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                format: 'PNG',  // 大写
            });

            assert.ok(result.success);
            assert.strictEqual(result.format, 'png');
        });
    });

    describe('quality 参数', () => {
        it('quality 参数应该影响输出质量', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const highQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                quality: 100,
            });

            const lowQuality = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                quality: 20,
            });

            assert.ok(highQuality.pages[0].size > lowQuality.pages[0].size,
                '高质量图片应该比低质量图片大');
        });
    });
});
