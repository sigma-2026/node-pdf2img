import fs from 'fs';
import { BaseExportImage } from './base-export-image.js';

/**
 * 开发环境：本地文件保存
 */
class DevExportImage extends BaseExportImage {
    /** dev 环境的输出目录 */
    outputDir = process.env.OUTPUT_DIR || './output';

    /**
     * 渲染并保存单个PDF页面到本地文件
     */
    async renderAndSavePage(page, pageNum, pdfDocument) {
        let canvasAndContext;
        let outputPath = '';
        
        try {
            const viewport = page.getViewport({ scale: 2.0 });
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

            // 确保输出目录存在
            if (!fs.existsSync(this.outputDir)) {
                fs.mkdirSync(this.outputDir, { recursive: true });
            }
            
            const filePrefix = `${this.outputDir}`;
            if (!fs.existsSync(filePrefix)) {
                fs.mkdirSync(filePrefix, { recursive: true });
            }
            console.log('🔨目录', fs.existsSync(filePrefix));
            outputPath = `${filePrefix}/page_${pageNum}.webp`;
            const image = canvasAndContext.canvas.toBuffer("image/webp");
            fs.writeFileSync(outputPath, image);
            console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);
            
            return {
                outputPath,
                width: viewport.width,
                height: viewport.height,
                pageNum,
            };
        } catch (error) {
            console.error(`❌处理页面 ${pageNum} 失败:`, error);
            throw error;
        } finally {
            // 确保资源释放
            if (page) {
                await page.cleanup();
            }
            if (canvasAndContext) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        }
    }

    /**
     * 处理捕获的图片（开发环境直接返回本地路径）
     */
    async processCapturedImages(result) {
        console.log('🚀本地全部截图完成耗时', Date.now() - global.begin + 'ms');
        return result.data;
    }
}

export { DevExportImage };