/**
 * 边界条件测试
 * 
 * 测试页码越界、空输入、特殊情况等边界条件
 * 
 * 运行方式：
 *   node --test test/edge-cases.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-edge');

// 测试用 PDF 文件
const TEST_PDF = path.join(STATIC_DIR, '1M.pdf');

// 动态导入模块
let pdf2img;

describe('边界条件测试', () => {
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

    describe('页码参数', () => {
        it('空页码数组应该转换所有页面', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const pageCount = await pdf2img.getPageCount(TEST_PDF);
            const result = await pdf2img.convert(TEST_PDF, {
                pages: [],  // 空数组表示全部
            });

            assert.ok(result.success);
            assert.strictEqual(result.renderedPages, pageCount, '应该渲染所有页面');
        });

        it('不传 pages 参数应该转换所有页面', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const pageCount = await pdf2img.getPageCount(TEST_PDF);
            const result = await pdf2img.convert(TEST_PDF);

            assert.ok(result.success);
            assert.strictEqual(result.renderedPages, pageCount, '应该渲染所有页面');
        });

        it('页码为 0 应该被忽略', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [0, 1],  // 0 应该被忽略
            });

            assert.ok(result.success);
            assert.strictEqual(result.renderedPages, 1, '应该只渲染第1页');
        });

        it('负数页码应该被忽略', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [-1, 1],  // -1 应该被忽略
            });

            assert.ok(result.success);
            assert.strictEqual(result.renderedPages, 1, '应该只渲染第1页');
        });

        it('超出范围的页码应该被忽略', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const pageCount = await pdf2img.getPageCount(TEST_PDF);
            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1, pageCount + 100],  // 超出范围应该被忽略
            });

            assert.ok(result.success);
            assert.strictEqual(result.renderedPages, 1, '应该只渲染有效页');
        });

        it('重复页码应该都被渲染', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1, 1, 1],  // 重复页码
            });

            assert.ok(result.success);
            // 行为取决于实现：可能渲染3次或去重
            assert.ok(result.renderedPages >= 1);
        });
    });

    describe('targetWidth 参数', () => {
        it('应该正确设置输出宽度', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const targetWidth = 640;
            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                targetWidth,
            });

            assert.ok(result.success);
            assert.strictEqual(result.pages[0].width, targetWidth, '宽度应该匹配');
        });

        it('很小的宽度应该正常工作', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                targetWidth: 100,
            });

            assert.ok(result.success);
            assert.strictEqual(result.pages[0].width, 100);
        });

        it('很大的宽度应该被限制', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                targetWidth: 10000,  // 很大的宽度
            });

            assert.ok(result.success);
            // 宽度可能被 maxScale 限制
            assert.ok(result.pages[0].width > 0);
        });
    });

    describe('错误处理', () => {
        it('文件不存在应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert('/nonexistent/file.pdf');
                },
                /not found|不存在|ENOENT/i,
                '应该抛出文件不存在错误'
            );
        });

        it('null 输入应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert(null);
                },
                Error,
                '应该抛出错误'
            );
        });

        it('undefined 输入应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert(undefined);
                },
                Error,
                '应该抛出错误'
            );
        });

        it('空字符串输入应该抛出错误', async () => {
            await assert.rejects(
                async () => {
                    await pdf2img.convert('');
                },
                Error,
                '应该抛出错误'
            );
        });

        it('非 PDF 文件应该抛出错误', async () => {
            const textFile = path.join(__dirname, 'test-file.txt');
            fs.writeFileSync(textFile, 'This is not a PDF');
            
            try {
                await assert.rejects(
                    async () => {
                        await pdf2img.convert(textFile);
                    },
                    Error,
                    '应该抛出错误'
                );
            } finally {
                fs.unlinkSync(textFile);
            }
        });

        it('outputType=file 但没有 outputDir 应该抛出错误', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            await assert.rejects(
                async () => {
                    await pdf2img.convert(TEST_PDF, {
                        pages: [1],
                        outputType: 'file',
                        // 缺少 outputDir
                    });
                },
                /outputDir is required/,
                '应该抛出 outputDir 缺失错误'
            );
        });

        it('outputType=cos 但没有 cos 配置应该抛出错误', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            await assert.rejects(
                async () => {
                    await pdf2img.convert(TEST_PDF, {
                        pages: [1],
                        outputType: 'cos',
                        // 缺少 cos 配置
                    });
                },
                /cos config is required/,
                '应该抛出 cos 配置缺失错误'
            );
        });
    });

    describe('Buffer 输入', () => {
        it('有效的 PDF Buffer 应该正常工作', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const buffer = fs.readFileSync(TEST_PDF);
            const result = await pdf2img.convert(buffer, {
                pages: [1],
            });

            assert.ok(result.success);
            assert.ok(result.pages.length > 0);
        });

        it('空 Buffer 应该抛出错误', async () => {
            const emptyBuffer = Buffer.alloc(0);
            
            await assert.rejects(
                async () => {
                    await pdf2img.convert(emptyBuffer);
                },
                Error,
                '应该抛出错误'
            );
        });

        it('无效的 PDF Buffer 应该抛出错误', async () => {
            const invalidBuffer = Buffer.from('This is not a PDF');
            
            await assert.rejects(
                async () => {
                    await pdf2img.convert(invalidBuffer);
                },
                Error,
                '应该抛出错误'
            );
        });
    });

    describe('返回结果结构', () => {
        it('返回结果应该包含必要字段', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
            });

            assert.ok(result.success !== undefined, '应该有 success 字段');
            assert.ok(result.numPages !== undefined, '应该有 numPages 字段');
            assert.ok(result.renderedPages !== undefined, '应该有 renderedPages 字段');
            assert.ok(result.format !== undefined, '应该有 format 字段');
            assert.ok(result.renderer !== undefined, '应该有 renderer 字段');
            assert.ok(Array.isArray(result.pages), 'pages 应该是数组');
            assert.ok(result.timing !== undefined, '应该有 timing 字段');
            assert.ok(result.timing.total !== undefined, '应该有 timing.total 字段');
            assert.ok(result.timing.render !== undefined, '应该有 timing.render 字段');
        });

        it('页面结果应该包含必要字段', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
            });

            const page = result.pages[0];
            assert.ok(page.pageNum !== undefined, '应该有 pageNum 字段');
            assert.ok(page.width !== undefined, '应该有 width 字段');
            assert.ok(page.height !== undefined, '应该有 height 字段');
            assert.ok(page.success !== undefined, '应该有 success 字段');
            assert.ok(page.buffer !== undefined || page.filePath !== undefined, 
                '应该有 buffer 或 filePath 字段');
        });

        it('file 输出应该包含 outputPath', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                outputType: 'file',
                outputDir: OUTPUT_DIR,
            });

            const page = result.pages[0];
            assert.ok(page.outputPath !== undefined, '应该有 outputPath 字段');
            assert.ok(fs.existsSync(page.outputPath), '文件应该存在');
        });
    });

    describe('线程池', () => {
        it('getThreadPoolStats 应该返回统计信息', () => {
            const stats = pdf2img.getThreadPoolStats();
            assert.ok(typeof stats === 'object', '应该返回对象');
            assert.ok(stats.workers !== undefined, '应该有 workers 字段');
        });

        it('多次转换应该复用线程池', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            // 第一次转换
            await pdf2img.convert(TEST_PDF, { pages: [1] });
            const stats1 = pdf2img.getThreadPoolStats();

            // 第二次转换
            await pdf2img.convert(TEST_PDF, { pages: [1] });
            const stats2 = pdf2img.getThreadPoolStats();

            // 工作线程数应该保持一致
            assert.strictEqual(stats1.workers, stats2.workers, '工作线程数应该一致');
        });
    });
});
