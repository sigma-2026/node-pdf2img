import { BaseExportImage } from './base-export-image.js';
import { uploadFiles } from './upload-file.js';

/**
 * 生产环境：COS上传
 */
class ProdExportImage extends BaseExportImage {
    /**
     * 渲染并保存单个PDF页面到内存buffer
     */
    async renderAndSavePage(page, pageNum, pdfDocument) {
        let canvasAndContext;
        
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

            const image = canvasAndContext.canvas.toBuffer("image/webp");
            
            return {
                pageNum,
                buffer: image,
                width: viewport.width,
                height: viewport.height,
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
     * 处理捕获的图片（生产环境上传到COS）
     */
    async processCapturedImages(result) {
        console.log('上传文件到 cos', result.bufferArr.length, '个文件');
        const response = await uploadFiles({ 
            globalPadId: this.globalPadId, 
            bufferArr: result.bufferArr 
        });
        
        const data = [];
        response.files.forEach((file, index) => {
            data.push({
                cosKey: '/' + file.options.Key,
                width: result.bufferArr[index].width,
                height: result.bufferArr[index].height,
                pageNum: result.bufferArr[index].pageNum,
            });
        });
        
        console.log('🚀全部截图+上传cos完成耗时', Date.now() - global.begin + 'ms');
        return data;
    }
}

export { ProdExportImage };