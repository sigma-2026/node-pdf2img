import { BaseExportImage } from './base-export-image.js';
import { uploadFiles } from './upload-file.js';
import { Piscina } from 'piscina';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 渲染配置
const RENDER_SCALE = parseFloat(process.env.RENDER_SCALE) || 1.5; // 从2.0降为1.5，提升约40%性能
const PARALLEL_RENDER = process.env.PARALLEL_RENDER !== 'false'; // 默认启用并行渲染
const WORKER_THREADS = parseInt(process.env.WORKER_THREADS) || 2; // Worker线程数

// 创建 Worker 线程池（延迟初始化）
let workerPool = null;
function getWorkerPool() {
    if (!workerPool && PARALLEL_RENDER) {
        workerPool = new Piscina({
            filename: path.join(__dirname, 'render-worker.js'),
            maxThreads: WORKER_THREADS,
            minThreads: 1,
            idleTimeout: 30000, // 30秒空闲超时
        });
        console.log(`[Worker Pool] 初始化完成，最大Worker线程数: ${WORKER_THREADS}`);
    }
    return workerPool;
}

/**
 * 生产环境：COS上传
 */
class ProdExportImage extends BaseExportImage {
    // 存储PDF数据用于并行渲染
    pdfData = null;

    /**
     * 渲染并保存单个PDF页面到内存buffer（串行模式）
     */
    async renderAndSavePage(page, pageNum, pdfDocument) {
        let canvasAndContext;
        
        try {
            const viewport = page.getViewport({ scale: RENDER_SCALE });
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

            // 使用 sharp 进行 WebP 编码（比 canvas.toBuffer('image/webp') 更稳定）
            const pngBuffer = canvasAndContext.canvas.toBuffer("image/png");
            const image = await sharp(pngBuffer)
                .webp({ quality: 80 })
                .toBuffer();
            
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
     * 并行渲染多个页面（使用Worker线程池）
     */
    async renderPagesParallel(pages, pdfData) {
        const pool = getWorkerPool();
        if (!pool) {
            throw new Error('Worker线程池未初始化');
        }

        console.log(`[并行渲染] 开始渲染 ${pages.length} 个页面，线程数: ${WORKER_THREADS}`);
        const startTime = Date.now();

        // 将PDF数据转为base64字符串，避免ArrayBuffer被转移分离
        const pdfBase64 = Buffer.from(pdfData).toString('base64');

        // 并行提交所有渲染任务
        const renderPromises = pages.map(pageNum => {
            return pool.run({
                pdfBase64,  // 使用base64字符串，Worker端会解码
                pageNum,
                scale: RENDER_SCALE,
            }).catch(err => {
                console.error(`[并行渲染] 页面 ${pageNum} 失败:`, err.message);
                return null; // 返回null表示失败，不中断其他任务
            });
        });

        const results = await Promise.all(renderPromises);
        
        // 过滤掉失败的结果，转换buffer类型，并排序
        const validResults = results
            .filter(r => r !== null)
            .map(r => ({
                ...r,
                // Worker返回的buffer会被序列化，需要转回Buffer
                buffer: Buffer.from(r.buffer),
            }))
            .sort((a, b) => a.pageNum - b.pageNum);

        console.log(`[并行渲染] 完成，成功 ${validResults.length}/${pages.length} 页，耗时 ${Date.now() - startTime}ms`);
        
        return validResults;
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

export { ProdExportImage, RENDER_SCALE, PARALLEL_RENDER, WORKER_THREADS };