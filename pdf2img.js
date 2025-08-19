import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
// import fetch from 'node-fetch';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 渲染并保存单个PDF页面
async function renderAndSavePage(page, pageNum, outputDir, pdfDocument) {
    let canvasAndContext;
    try {
        const viewport = page.getViewport({ scale: 1.0 });
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
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }

        const outputPath = `${outputDir}/page_${pageNum}.png`;
        const image = canvasAndContext.canvas.toBuffer("image/png");
        fs.writeFileSync(outputPath, image);
        console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);

    } catch (error) {
        console.error(`❌ 处理页面 ${pageNum} 失败:`, error);
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

// 动态导入 PDF.js ES 模块
async function pdfToImage(pdfPath, outputDir) {
    console.log("pdfToImage");
    // let pdfData;
    // if (pdfPath.startsWith('http://') || pdfPath.startsWith('https://')) {
    //     // 远程URL：使用fetch下载文件
    //     const response = await fetch(pdfPath);
    //     console.log("response", response.status);
    //     if (response.status !== 200) {
    //         throw new Error(`Failed to fetch PDF: ${response.statusText}`);
    //     }
    //     const arrayBuffer = await response.arrayBuffer();
    //     pdfData = new Uint8Array(arrayBuffer);
    // } else {
    //     // 本地路径：使用fs读取文件
    //     pdfData = new Uint8Array(fs.readFileSync(pdfPath));
    // }

    
    const CMAP_URL = path.join(
        __dirname,
        'node_modules/pdfjs-dist/build/cmaps/'
    );
    const CMAP_PACKED = true;

    const STANDARD_FONT_DATA_URL =
        path.join(
            __dirname,
            'node_modules/pdfjs-dist/standard_fonts/'
        );
    console.log("pdfPath", pdfPath);
    const loadingTask = getDocument({
        url: pdfPath,
        cMapUrl: CMAP_URL,
        cMapPacked: CMAP_PACKED,
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        rangeChunkSize: 150 * 1024, // 分片大小
        disableAutoFetch: true, // 关闭自动全量下载
    });
    console.log("getDocument");
    try {
        const pdfDocument = await loadingTask.promise;
        console.log("PDF document loaded.");
        const numPages = pdfDocument.numPages;
        console.log(`PDF 加载成功，共 ${numPages} 页`);

        // 逐页渲染为图片
        for (let pageNum = 1; pageNum <= 1; pageNum++) {
            const page = await pdfDocument.getPage(pageNum);
            await renderAndSavePage(page, pageNum, outputDir, pdfDocument);
            if (pageNum === 1) {
                console.log('🚀首页截图完成', Date.now() - global.begin + 'ms');
            }
            // 每处理3页强制GC（防内存泄漏）
            if (pageNum % 3 === 0 && global.gc) {
                global.gc();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    } catch (reason) {
        console.error("PDF 处理失败:", reason);
    }
}

export { pdfToImage };
