/**
 * 配置模块测试
 * 
 * 测试配置合并、格式处理、输入类型检测等
 * 
 * 运行方式：
 *   node --test test/config.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 动态导入模块
let config;
let renderer;

describe('配置模块测试', async () => {
    // 导入配置模块
    config = await import('../src/core/config.js');
    renderer = await import('../src/core/renderer.js');

    describe('RendererType 枚举', () => {
        it('应该包含 PDFIUM 和 PDFJS', () => {
            assert.strictEqual(config.RendererType.PDFIUM, 'pdfium');
            assert.strictEqual(config.RendererType.PDFJS, 'pdfjs');
        });
    });

    describe('DEFAULT_RENDERER', () => {
        it('默认渲染器应该是 pdfium 或环境变量指定值', () => {
            const expected = process.env.PDF2IMG_RENDERER || 'pdfium';
            assert.strictEqual(config.DEFAULT_RENDERER, expected);
        });
    });

    describe('RENDER_CONFIG', () => {
        it('应该包含 TARGET_RENDER_WIDTH', () => {
            assert.ok(typeof config.RENDER_CONFIG.TARGET_RENDER_WIDTH === 'number');
            assert.ok(config.RENDER_CONFIG.TARGET_RENDER_WIDTH > 0);
        });

        it('应该包含 OUTPUT_FORMAT', () => {
            assert.ok(['webp', 'png', 'jpg', 'jpeg'].includes(config.RENDER_CONFIG.OUTPUT_FORMAT));
        });

        it('应该包含 NATIVE_STREAM_THRESHOLD', () => {
            assert.ok(typeof config.RENDER_CONFIG.NATIVE_STREAM_THRESHOLD === 'number');
            assert.ok(config.RENDER_CONFIG.NATIVE_STREAM_THRESHOLD > 0);
        });
    });

    describe('ENCODER_CONFIG', () => {
        it('WEBP_QUALITY 应该在 0-100 范围内', () => {
            assert.ok(config.ENCODER_CONFIG.WEBP_QUALITY >= 0);
            assert.ok(config.ENCODER_CONFIG.WEBP_QUALITY <= 100);
        });

        it('JPEG_QUALITY 应该在 0-100 范围内', () => {
            assert.ok(config.ENCODER_CONFIG.JPEG_QUALITY >= 0);
            assert.ok(config.ENCODER_CONFIG.JPEG_QUALITY <= 100);
        });

        it('PNG_COMPRESSION 应该在 0-9 范围内', () => {
            assert.ok(config.ENCODER_CONFIG.PNG_COMPRESSION >= 0);
            assert.ok(config.ENCODER_CONFIG.PNG_COMPRESSION <= 9);
        });

        it('WEBP_METHOD 应该在 0-6 范围内', () => {
            assert.ok(config.ENCODER_CONFIG.WEBP_METHOD >= 0);
            assert.ok(config.ENCODER_CONFIG.WEBP_METHOD <= 6);
        });
    });

    describe('SUPPORTED_FORMATS', () => {
        it('应该包含 webp, png, jpg, jpeg', () => {
            assert.ok(config.SUPPORTED_FORMATS.includes('webp'));
            assert.ok(config.SUPPORTED_FORMATS.includes('png'));
            assert.ok(config.SUPPORTED_FORMATS.includes('jpg'));
            assert.ok(config.SUPPORTED_FORMATS.includes('jpeg'));
        });
    });

    describe('mergeConfig()', () => {
        it('无参数时应该返回默认配置', () => {
            const result = config.mergeConfig();
            assert.ok(result.targetWidth > 0);
            assert.ok(result.webpQuality > 0);
            assert.ok(result.jpegQuality > 0);
        });

        it('应该正确合并用户配置', () => {
            const result = config.mergeConfig({
                targetWidth: 1920,
                format: 'png',
            });
            assert.strictEqual(result.targetWidth, 1920);
            assert.strictEqual(result.format, 'png');
        });

        it('应该支持嵌套的 webp 配置', () => {
            const result = config.mergeConfig({
                webp: { quality: 90, method: 6 },
            });
            assert.strictEqual(result.webpQuality, 90);
            assert.strictEqual(result.webpMethod, 6);
        });

        it('应该支持嵌套的 jpeg 配置', () => {
            const result = config.mergeConfig({
                jpeg: { quality: 75 },
            });
            assert.strictEqual(result.jpegQuality, 75);
        });

        it('应该支持嵌套的 png 配置', () => {
            const result = config.mergeConfig({
                png: { compressionLevel: 9 },
            });
            assert.strictEqual(result.pngCompression, 9);
        });

        it('quality 参数应该覆盖 webp 和 jpeg 质量', () => {
            const result = config.mergeConfig({
                quality: 50,
            });
            assert.strictEqual(result.webpQuality, 50);
            assert.strictEqual(result.jpegQuality, 50);
        });
    });

    describe('getExtension()', () => {
        it('webp 应该返回 webp', () => {
            assert.strictEqual(config.getExtension('webp'), 'webp');
        });

        it('png 应该返回 png', () => {
            assert.strictEqual(config.getExtension('png'), 'png');
        });

        it('jpg 应该返回 jpg', () => {
            assert.strictEqual(config.getExtension('jpg'), 'jpg');
        });

        it('jpeg 应该返回 jpg', () => {
            assert.strictEqual(config.getExtension('jpeg'), 'jpg');
        });
    });

    describe('getMimeType()', () => {
        it('webp 应该返回 image/webp', () => {
            assert.strictEqual(config.getMimeType('webp'), 'image/webp');
        });

        it('png 应该返回 image/png', () => {
            assert.strictEqual(config.getMimeType('png'), 'image/png');
        });

        it('jpg 应该返回 image/jpeg', () => {
            assert.strictEqual(config.getMimeType('jpg'), 'image/jpeg');
        });

        it('jpeg 应该返回 image/jpeg', () => {
            assert.strictEqual(config.getMimeType('jpeg'), 'image/jpeg');
        });
    });

    describe('InputType 枚举', () => {
        it('应该包含 FILE, URL, BUFFER', () => {
            assert.strictEqual(renderer.InputType.FILE, 'file');
            assert.strictEqual(renderer.InputType.URL, 'url');
            assert.strictEqual(renderer.InputType.BUFFER, 'buffer');
        });
    });

    describe('detectInputType()', () => {
        it('Buffer 应该返回 buffer', () => {
            const buf = Buffer.from('test');
            assert.strictEqual(renderer.detectInputType(buf), 'buffer');
        });

        it('HTTP URL 应该返回 url', () => {
            assert.strictEqual(renderer.detectInputType('http://example.com/test.pdf'), 'url');
        });

        it('HTTPS URL 应该返回 url', () => {
            assert.strictEqual(renderer.detectInputType('https://example.com/test.pdf'), 'url');
        });

        it('本地路径应该返回 file', () => {
            assert.strictEqual(renderer.detectInputType('/path/to/file.pdf'), 'file');
            assert.strictEqual(renderer.detectInputType('./file.pdf'), 'file');
            assert.strictEqual(renderer.detectInputType('file.pdf'), 'file');
        });

        it('无效输入应该抛出错误', () => {
            assert.throws(() => renderer.detectInputType(null), /Invalid input/);
            assert.throws(() => renderer.detectInputType(undefined), /Invalid input/);
            assert.throws(() => renderer.detectInputType(123), /Invalid input/);
        });
    });

    describe('getRendererType()', () => {
        it('指定 pdfjs 应该返回 pdfjs', () => {
            const type = renderer.getRendererType({ renderer: 'pdfjs' });
            assert.strictEqual(type, 'pdfjs');
        });

        it('指定 pdfium 应该返回 pdfium 或回退到 pdfjs', () => {
            const type = renderer.getRendererType({ renderer: 'pdfium' });
            assert.ok(['pdfium', 'pdfjs'].includes(type));
        });

        it('无参数应该返回默认渲染器或回退', () => {
            const type = renderer.getRendererType({});
            assert.ok(['pdfium', 'pdfjs'].includes(type));
        });
    });
});
