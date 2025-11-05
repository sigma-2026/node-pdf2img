import { parentPort, workerData } from 'worker_threads';
import { ExportImage } from './pdf2img.js';

// 此函数在新的工作线程中执行
const run = async () => {
    // global.begin 是在主线程设置的， worker 线程需要重新记录自己的开始时间
    // 但为了和原始逻辑一致，我们直接从 workerData 传入
    global.begin = workerData.begin;
    console.log(`[工作线程 ${process.pid}] 开始处理: ${workerData.globalPadId}`);

    try {
        const exportImage = new ExportImage({ globalPadId: workerData.globalPadId });
        const data = await exportImage.pdfToImage({
            pdfPath: workerData.url,
            outputDir: workerData.outputDir,
            pages: workerData.pages,
            screen: workerData.screen,
        });
        // 任务成功，通过 postMessage 将结果返回给主线程
        parentPort.postMessage({ status: 'done', data });
    } catch (error) {
        // 任务失败，将错误信息返回给主线程
        console.error(`[工作线程 ${process.pid}] 发生错误`, error);
        parentPort.postMessage({ status: 'error', error: error.message });
    }
};

run();
