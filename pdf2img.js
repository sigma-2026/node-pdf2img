import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { getDocument, PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";
// 每片的请求大小 1 MB
const EACH_CHUNK_SIZE = 1024 * 1024;
// 拆分后最小chunk请求大小 256kb
const EACH_SMALL_CHUNK_SIZE = 256 * 1024;
// 初始数据长度
const INITIAL_DATA_LENGTH = 10 * 1024;
// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ExportImage {
    pdfSize = 0;
    pdfPath = '';

    // 动态导入 PDF.js ES 模块
    async pdfToImage({
        pdfPath,
        outputDir,
        pages = [1],
    }) {
        let data = [];
        console.log("pdfToImage");
        this.pdfPath = pdfPath;
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
        // 先拿首片数据 10KB
        const initialData = await this.generateInitDataPromise();
        const rangeLoader = new RangeLoader(this.pdfSize, initialData, this.pdfPath, EACH_CHUNK_SIZE);
        // 再分页加载
        const loadingTask = getDocument({
            // url: pdfPath,
            cMapUrl: CMAP_URL,
            cMapPacked: CMAP_PACKED,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            rangeChunkSize: EACH_CHUNK_SIZE, // 分片大小 1MB
            disableAutoFetch: true, // 关闭自动全量下载
            range: rangeLoader,
        });
        console.log("getDocument");
        try {
            const pdfDocument = await loadingTask.promise;
            console.log("PDF document loaded.");
            const numPages = pdfDocument.numPages;
            console.log(`PDF 加载成功，共 ${numPages} 页`);

            console.log("截图 pages", pages, typeof pages);
            // 逐页渲染为图片
            for (let i = 0; i < pages.length; i++) {
                const pageNum = pages[i];
                console.log("正在截图pageNum", pageNum);
                const page = await pdfDocument.getPage(pageNum);
                const outputPath = await this.renderAndSavePage(page, pageNum, outputDir, pdfDocument);
                data.push(outputPath);
                if (i === 0) {
                    console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
                }
                // 每处理3页强制GC（防内存泄漏）
                if (pageNum % 3 === 0 && global.gc) {
                    global.gc();
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            console.log('🚀全部截图完成耗时', Date.now() - global.begin + 'ms');
        } catch (reason) {
            throw new Error("截图处理失败:", reason);
        }

        return data;
    }

    // 渲染并保存单个PDF页面
    async renderAndSavePage(page, pageNum, outputDir, pdfDocument) {
        let canvasAndContext;
        let outputPath = '';
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

            outputPath = `${outputDir}/page_${pageNum}.png`;
            const image = canvasAndContext.canvas.toBuffer("image/png");
            fs.writeFileSync(outputPath, image);
            console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);
        } catch (error) {
            console.error(`❌处理页面 ${pageNum} 失败:`, error);
        } finally {
            // 确保资源释放
            if (page) {
                await page.cleanup();
            }
            if (canvasAndContext) {
                pdfDocument.canvasFactory.reset(canvasAndContext, 1, 1);
            }
        }
        return outputPath;
    }

    getDocumentSize(response) {
        const contentRange = response.headers.get('Content-Range');
        if (contentRange && /^bytes \d+-\d+\/\d+$/i.test(contentRange)) {
            return parseInt(contentRange.split('/').pop(), 10);
        }

        const contentLength = response.headers.get('Content-Length') || '0';
        return parseInt(contentLength, 10);
    }

    /**
     * 请求初始数据
     */
    generateInitDataPromise = async (dataLength = INITIAL_DATA_LENGTH) => {
        return await fetch(this.pdfPath,
            {
                headers: {
                    Range: `bytes=${0}-${dataLength}`,
                },
            })
            .then(response => {
                console.log('response', response.status);
                this.pdfSize = this.getDocumentSize(response);
                console.log('pdfSize', this.pdfSize);
                return response.arrayBuffer();
            });
    };
}


class RangeLoader extends PDFDataRangeTransport {
    constructor(length, initialData, pdfPath, eachChunkSize) {
        super(length, initialData);
        this.pdfPath = pdfPath;
        this.eachChunkSize = eachChunkSize;
    }

    async requestDataRange(start, end) {
        console.log(`[分片加载] [长度：${end - start}] ${start} - ${end}`);
        const groups = this.getBatchGroups(start, end, this.getDynamicChunkSize());
        const datas = await Promise.all(
            groups.map(([eachStart, eachEnd]) => {
                const result = this.getDataByRangeLimit({ start: eachStart, end: eachEnd });
                return result;
            }));
        // console.log('datas', datas);
        const byteLength = datas.reduce((total, data) => total + data.byteLength, 0);
        // console.log('byteLength', byteLength);
        const byteData = new Uint8Array(byteLength);
        let offset = 0;
        for (const data of datas) {
            byteData.set(new Uint8Array(data), offset);
            offset += data.byteLength;
        }
        // console.log('byteData', byteData);
        this.onDataProgress(byteData.byteLength, this.pdfSize);
        this.onDataRange(start, byteData);
    }

    getBatchGroups(start, end, limitLength) {
        const count = Math.ceil((end - start) / limitLength);
        console.log('并行片数', count);
        return (new Array(count).fill(0)
            .map((_, index) => {
                const eachStart = index * limitLength + start;
                const eachEnd = Math.min(eachStart + limitLength - 1, end);
                return [eachStart, eachEnd];
            }));
    }

    getDynamicChunkSize() {
        return EACH_SMALL_CHUNK_SIZE;
    }

    async getDataByRangeLimit({ start, end, }) {
        console.log(`[分片请求]${start} - ${end}`);
        return await fetch(this.pdfPath, {
            headers: {
                Range: `bytes=${start}-${end}`,
            },
        }).then(response => {
            return response.arrayBuffer();
        });
    }
}

export { ExportImage };
