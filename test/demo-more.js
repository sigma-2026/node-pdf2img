// 支持多页
import fs from "fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Some PDFs need external cmaps.
const CMAP_URL = "./node_modules/pdfjs-dist/cmaps/";
const CMAP_PACKED = true;

// Where the standard fonts are located.
const STANDARD_FONT_DATA_URL =
    "./node_modules/pdfjs-dist/standard_fonts/";

// Loading file from file system into typed array.
const pdfPath = "./test.pdf";
const data = new Uint8Array(fs.readFileSync(pdfPath));
const outputDir = './output';

// Load the PDF file.
const loadingTask = getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
});

try {
    const pdfDocument = await loadingTask.promise;
    console.log("# PDF document loaded.");
    const numPages = pdfDocument.numPages
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDocument.getPage(pageNum);
        const canvasFactory = pdfDocument.canvasFactory;
        const viewport = page.getViewport({ scale: 1.0 });
        const canvasAndContext = canvasFactory.create(
            viewport.width,
            viewport.height
        );

        // 渲染 PDF 页面到 Canvas
        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport,
        };

        try {
            // 修改渲染部分代码
            const renderTask = page.render(renderContext);
            await renderTask.promise; // 确保完全等待渲染完成
        } catch (error) {
            console.error(`❌ 渲染页面 ${pageNum} 失败:`, error);
            continue; // 跳过当前页
        }

        // 确保输出目录存在
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        // const base64 = canvas.toDataURL();
        // console.log(`base64: ${base64}`);
        // 保存为 PNG 文件
        const outputPath = `${outputDir}/page_${pageNum}.png`;
        // Convert the canvas to an image buffer.
        const image = canvasAndContext.canvas.toBuffer("image/png");
        console.log(`buffer: ${image.length}`);
        fs.writeFileSync(outputPath, image);
        // Release page resources.
        page.cleanup();
        console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);

        // 每处理5页强制GC（防内存泄漏）
        if (pageNum % 5 === 0 && global.gc) {
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
} catch (reason) {
    console.log(reason);
}