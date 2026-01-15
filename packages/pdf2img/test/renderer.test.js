/**
 * 渲染器测试
 * 
 * 测试 PDFium 和 PDF.js 两个渲染器的功能
 * 
 * 运行方式：
 *   node --test test/renderer.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-renderer');

// 测试用 PDF 文件
const TEST_PDF = path.join(STATIC_DIR, '1M.pdf');
const TEST_INVOICE = path.join(STATIC_DIR, '发票.pdf');

// CI 环境检测
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

// 动态导入模块
let pdf2img;

describe('渲染器测试', () => {
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

    describe('渲染器可用性', () => {
        it('RendererType 应该导出正确', () => {
            assert.ok(pdf2img.RendererType, 'RendererType 应该存在');
            assert.strictEqual(pdf2img.RendererType.PDFIUM, 'pdfium');
            assert.strictEqual(pdf2img.RendererType.PDFJS, 'pdfjs');
        });

        it('isAvailable() 无参数应返回布尔值', () => {
            const available = pdf2img.isAvailable();
            assert.ok(typeof available === 'boolean');
        });

        it('isAvailable(pdfium) 应返回布尔值', () => {
            const available = pdf2img.isAvailable('pdfium');
            assert.ok(typeof available === 'boolean');
        });

        it('isAvailable(pdfjs) 应返回布尔值', () => {
            const available = pdf2img.isAvailable('pdfjs');
            assert.ok(typeof available === 'boolean');
        });

        it('isPdfjsAvailable 应该存在并返回布尔值', () => {
            assert.ok(typeof pdf2img.isPdfjsAvailable === 'function');
            const available = pdf2img.isPdfjsAvailable();
            assert.ok(typeof available === 'boolean');
        });

        it('getPdfjsVersion 应该返回版本信息', () => {
            if (!pdf2img.isPdfjsAvailable()) {
                console.log('跳过: PDF.js 不可用');
                return;
            }
            const version = pdf2img.getPdfjsVersion();
            assert.ok(typeof version === 'string');
            assert.ok(version.length > 0);
        });

        it('isNativeAvailable 应该存在并返回布尔值', () => {
            assert.ok(typeof pdf2img.isNativeAvailable === 'function');
            const available = pdf2img.isNativeAvailable();
            assert.ok(typeof available === 'boolean');
        });
    });

    describe('PDFium 渲染器', () => {
        before(() => {
            if (IS_CI || !pdf2img.isNativeAvailable()) {
                console.log('跳过 PDFium 测试: 渲染器不可用');
            }
        });

        it('PDFium 应该成功转换 PDF', async () => {
            if (!pdf2img.isNativeAvailable()) {
                console.log('跳过: PDFium 不可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                renderer: 'pdfium',
            });

            assert.ok(result.success);
            assert.ok(result.pages.length > 0);
            assert.ok(Buffer.isBuffer(result.pages[0].buffer));
            assert.strictEqual(result.renderer, 'pdfium');
        });

        it('PDFium 应该返回正确的页数', async () => {
            if (!pdf2img.isNativeAvailable()) {
                console.log('跳过: PDFium 不可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const count = await pdf2img.getPageCount(TEST_PDF, { renderer: 'pdfium' });
            assert.ok(typeof count === 'number');
            assert.ok(count > 0);
        });

        it('getVersion() 应该返回版本信息', () => {
            if (!pdf2img.isNativeAvailable()) {
                console.log('跳过: PDFium 不可用');
                return;
            }
            const version = pdf2img.getVersion('pdfium');
            assert.ok(typeof version === 'string');
            assert.ok(version.length > 0);
        });
    });

    describe('PDF.js 渲染器', () => {
        it('PDF.js 应该成功转换 PDF', async () => {
            if (!pdf2img.isPdfjsAvailable()) {
                console.log('跳过: PDF.js 不可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const result = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                renderer: 'pdfjs',
            });

            assert.ok(result.success);
            assert.ok(result.pages.length > 0);
            assert.ok(Buffer.isBuffer(result.pages[0].buffer));
            assert.strictEqual(result.renderer, 'pdfjs');
        });

        it('PDF.js 应该返回正确的页数', async () => {
            if (!pdf2img.isPdfjsAvailable()) {
                console.log('跳过: PDF.js 不可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const count = await pdf2img.getPageCount(TEST_PDF, { renderer: 'pdfjs' });
            assert.ok(typeof count === 'number');
            assert.ok(count > 0);
        });

        it('PDF.js 应该支持 Buffer 输入', async () => {
            if (!pdf2img.isPdfjsAvailable()) {
                console.log('跳过: PDF.js 不可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const buffer = fs.readFileSync(TEST_PDF);
            const result = await pdf2img.convert(buffer, {
                pages: [1],
                renderer: 'pdfjs',
            });

            assert.ok(result.success);
            assert.ok(result.pages.length > 0);
        });

        it('getPdfjsVersion() 应该返回版本信息', () => {
            if (!pdf2img.isPdfjsAvailable()) {
                console.log('跳过: PDF.js 不可用');
                return;
            }
            const version = pdf2img.getPdfjsVersion();
            assert.ok(typeof version === 'string');
        });
    });

    describe('渲染器一致性', () => {
        it('两个渲染器应该返回相同的页数', async () => {
            if (!pdf2img.isNativeAvailable() || !pdf2img.isPdfjsAvailable()) {
                console.log('跳过: 需要两个渲染器都可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const pdfiumCount = await pdf2img.getPageCount(TEST_PDF, { renderer: 'pdfium' });
            const pdfjsCount = await pdf2img.getPageCount(TEST_PDF, { renderer: 'pdfjs' });

            assert.strictEqual(pdfiumCount, pdfjsCount, '两个渲染器应该返回相同的页数');
        });

        it('两个渲染器输出图片尺寸应该一致', async () => {
            if (!pdf2img.isNativeAvailable() || !pdf2img.isPdfjsAvailable()) {
                console.log('跳过: 需要两个渲染器都可用');
                return;
            }
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过: 测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const targetWidth = 800;
            
            const pdfiumResult = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                renderer: 'pdfium',
                targetWidth,
            });

            const pdfjsResult = await pdf2img.convert(TEST_PDF, {
                pages: [1],
                renderer: 'pdfjs',
                targetWidth,
            });

            assert.strictEqual(pdfiumResult.pages[0].width, pdfjsResult.pages[0].width, '宽度应该一致');
            // 高度可能因为渲染方式不同有微小差异，允许 1px 误差
            const heightDiff = Math.abs(pdfiumResult.pages[0].height - pdfjsResult.pages[0].height);
            assert.ok(heightDiff <= 1, `高度差异应该 <= 1px, 实际: ${heightDiff}`);
        });
    });

    describe('渲染器回退机制', () => {
        it('getVersion() 无参数应该返回可用渲染器的版本', () => {
            const version = pdf2img.getVersion();
            assert.ok(typeof version === 'string');
            assert.ok(version.length > 0);
        });
    });
});
