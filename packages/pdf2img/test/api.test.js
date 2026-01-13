/**
 * PDF2IMG API 测试
 *
 * 运行方式：
 *   node --test test/api.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-api');

// CI 环境检测 - 在 CI 中跳过 native renderer 可用性测试
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

// 测试用 PDF 文件
const TEST_PDF = path.join(STATIC_DIR, '发票.pdf');
const TEST_PDF_1M = path.join(STATIC_DIR, '1M.pdf');

// 动态导入模块
let pdf2img;

describe('PDF2IMG API 测试', () => {
    before(async () => {
        // 导入模块
        pdf2img = await import('../src/index.js');

        // 确保输出目录存在
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

    describe('模块导出', () => {
        it('应该导出 convert 函数', () => {
            assert.ok(typeof pdf2img.convert === 'function', 'convert 应该是函数');
        });

        it('应该导出 getPageCount 函数', () => {
            assert.ok(typeof pdf2img.getPageCount === 'function', 'getPageCount 应该是函数');
        });

        it('应该导出 isAvailable 函数', () => {
            assert.ok(typeof pdf2img.isAvailable === 'function', 'isAvailable 应该是函数');
        });
    });

    describe('渲染器可用性', () => {
        it('isAvailable 应该返回布尔值', async () => {
            const available = await pdf2img.isAvailable();
            assert.ok(typeof available === 'boolean', '应该返回布尔值');
        });

        it('原生渲染器应该可用', async () => {
            // 在 CI 环境中跳过此测试
            if (IS_CI) {
                console.log('Skipping test in CI environment');
                return;
            }
            
            const available = await pdf2img.isAvailable();
            assert.ok(available === true, '原生渲染器应该可用');
        });
    });

    describe('getPageCount', () => {
        it('应该返回 PDF 页数', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const count = await pdf2img.getPageCount(TEST_PDF);
            assert.ok(typeof count === 'number', '应该返回数字');
            assert.ok(count > 0, '页数应该大于 0');
        });

        it('应该支持 Buffer 输入', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const buffer = fs.readFileSync(TEST_PDF);
            const count = await pdf2img.getPageCount(buffer);
            assert.ok(typeof count === 'number', '应该返回数字');
            assert.ok(count > 0, '页数应该大于 0');
        });
    });

    describe('convert', () => {
        it('应该转换 PDF 为 Buffer 数组', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
            });

            assert.ok(result, '应该返回结果');
            assert.ok(result.pages, '应该包含 pages');
            assert.ok(result.pages.length > 0, '应该有页面数据');
            assert.ok(Buffer.isBuffer(result.pages[0].buffer), '页面数据应该是 Buffer');
        });

        it('应该转换 PDF 为文件', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                outputType: 'file',
                outputDir: OUTPUT_DIR,
            });

            assert.ok(result, '应该返回结果');
            assert.ok(result.pages, '应该包含 pages');
            assert.ok(result.pages.length > 0, '应该有页面数据');

            // 检查文件是否生成
            const files = fs.readdirSync(OUTPUT_DIR);
            assert.ok(files.some(f => f.endsWith('.webp')), '应该生成 WebP 文件');
        });

        it('应该支持自定义宽度', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                targetWidth: 800,
            });

            assert.ok(result, '应该返回结果');
            assert.ok(result.pages[0].width === 800, '宽度应该是 800');
        });

        it('应该支持 Buffer 输入', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const buffer = fs.readFileSync(TEST_PDF);
            const result = await pdf2img.convert(buffer, {
                pages: [1],
            });

            assert.ok(result, '应该返回结果');
            assert.ok(result.pages.length > 0, '应该有页面数据');
        });
    });

    describe('错误处理', () => {
        it('文件不存在时应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert('/nonexistent/file.pdf');
                },
                /不存在|not found|ENOENT/i,
                '应该抛出文件不存在错误'
            );
        });

        it('无效输入应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert(null);
                },
                Error,
                '应该抛出错误'
            );
        });
    });
});
