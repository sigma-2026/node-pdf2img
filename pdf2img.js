import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createCanvas } from 'canvas';
import fetch from 'node-fetch';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 动态导入 PDF.js ES 模块
async function pdfToImage(pdfPath, outputDir) {
    let pdfData;
    if (pdfPath.startsWith('http://') || pdfPath.startsWith('https://')) {
        // 远程URL：使用fetch下载文件
        const response = await fetch(pdfPath);
        const arrayBuffer = await response.arrayBuffer();
        pdfData = new Uint8Array(arrayBuffer);
    } else {
        // 本地路径：使用fs读取文件
        pdfData = new Uint8Array(fs.readFileSync(pdfPath));
    }

    // 配置 PDF.js（需设置 worker 路径）
    pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
        __dirname,
        'node_modules/pdfjs-dist/build/pdf.worker.mjs'
    );

    // 加载 PDF 文档
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const numPages = pdf.numPages;

    // 逐页渲染为图片
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });

        // 创建 Canvas
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');

        // 渲染 PDF 页面到 Canvas
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        await page.render(renderContext).promise;

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        // 保存为 PNG 文件
        const outputPath = `${outputDir}/page_${pageNum}.png`;
        const buffer = canvas.toBuffer('image/png');
        console.log(`buffer: ${buffer.length}`);
        fs.writeFileSync(outputPath, buffer);
        console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);
    }
}

export { pdfToImage };
