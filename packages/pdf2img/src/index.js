/**
 * @tencent/pdf2img - 高性能 PDF 转图片工具
 *
 * 使用 PDFium 原生渲染器实现最佳性能。
 *
 * @example
 * ```javascript
 * import { convert, getPageCount, isAvailable } from '@tencent/pdf2img';
 *
 * // 转换 PDF 为图片（返回 Buffer）
 * const result = await convert('./document.pdf');
 * console.log(`转换了 ${result.renderedPages} 页`);
 *
 * // 保存到文件
 * const result = await convert('./document.pdf', {
 *     outputType: 'file',
 *     outputDir: './output',
 * });
 *
 * // 转换指定页面
 * const result = await convert('./document.pdf', {
 *     pages: [1, 2, 3],
 *     targetWidth: 1920,
 *     webpQuality: 80,
 * });
 *
 * // 从 URL 转换（大文件自动使用流式加载）
 * const result = await convert('https://example.com/document.pdf', {
 *     outputType: 'file',
 *     outputDir: './output',
 * });
 * ```
 *
 * @module @tencent/pdf2img
 */

export {
    convert,
    getPageCount,
    getPageCountSync,
    isAvailable,
    getVersion,
    getThreadPoolStats,
    destroyThreadPool,
    InputType,
    OutputType,
} from './core/converter.js';

export { RENDER_CONFIG, TIMEOUT_CONFIG } from './core/config.js';

// 导出原生渲染器工具供高级用法
export {
    isNativeAvailable,
    getPageCount as getPageCountNative,
    getPageCountFromFile,
    renderPageToRawBitmap,
    renderPageToRawBitmapFromBuffer,
} from './renderers/native.js';
