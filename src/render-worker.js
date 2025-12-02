import { parentPort, workerData } from 'worker_threads';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker 线程：渲染单个 PDF 页面
 * @param {Object} params
 * @param {string} params.pdfBase64 - PDF 数据(base64编码)
 * @param {number} params.pageNum - 页码
 * @param {number} params.scale - 渲染缩放比例
 * @returns {Promise<Object>} 渲染结果
 */
export default async function renderPage({ pdfBase64, pageNum, scale = 1.5 }) {
    const CMAP_URL = path.join(__dirname, 'node_modules/pdfjs-dist/cmaps/');
    const STANDARD_FONT_DATA_URL = path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts/');

    let pdfDocument;
    let page;
    let canvasAndContext;

    try {
        // 从base64解码PDF数据
        const pdfData = new Uint8Array(Buffer.from(pdfBase64, 'base64'));
        
        // 加载 PDF 文档
        const loadingTask = getDocument({
            data: pdfData,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
        });

        pdfDocument = await loadingTask.promise;
        page = await pdfDocument.getPage(pageNum);

        const viewport = page.getViewport({ scale });
        canvasAndContext = pdfDocument.canvasFactory.create(
            viewport.width,
            viewport.height
        );

        // 渲染 PDF 页面到 Canvas
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
        };

        const renderTask = page.render(renderContext);
        await renderTask.promise;

        // 转换为 WebP 图片
        const image = canvasAndContext.canvas.toBuffer("image/webp");

        return {
            pageNum,
            buffer: image,
            width: viewport.width,
            height: viewport.height,
        };
    } catch (error) {
        console.error(`[Worker] 渲染页面 ${pageNum} 失败:`, error.message);
        throw error;
    } finally {
        // 清理资源
        try {
            if (page) {
                page.cleanup();
            }
        } catch (e) { /* 忽略清理错误 */ }
        
        try {
            if (canvasAndContext && pdfDocument) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        } catch (e) { /* 忽略清理错误 */ }
        
        try {
            if (pdfDocument) {
                await pdfDocument.destroy();
            }
        } catch (e) { /* 忽略清理错误 */ }
    }
}
