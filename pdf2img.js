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
    async pdfToImage(pdfPath, outputDir) {
        console.log("pdfToImage");
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
        this.pdfPath = "https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/b73b10644b264b8fbe85862e2bd6dcc8?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1755605131;1755606931&q-key-time=1755605131;1755606931&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=be24bca9a9683dcaf0f394e07a807f06314da513&response-content-disposition=attachment%3Bfilename%3D1M.pdf%3Bfilename%2A%3Dutf-8%27%271M.pdf&response-expires=1800"
        // this.pdfPath = "https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/1e1f1b81b55f43acb33293e6ec627937?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1755605014;1755606814&q-key-time=1755605014;1755606814&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=62422233c873ff10a1ee68caeb581e7e51a90178&response-content-disposition=attachment%3Bfilename%3D5M.pdf%3Bfilename%2A%3Dutf-8%27%275M.pdf&response-expires=1800"
        // this.pdfPath = "https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/87fba482af7248aca30a57b84b217b1e?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1755604905;1755606705&q-key-time=1755604905;1755606705&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=dafc0aa921279f8587edb363ff8e1d0f50b0a2e9&response-content-disposition=attachment%3Bfilename%3D10M.pdf%3Bfilename%2A%3Dutf-8%27%2710M.pdf&response-expires=1800";
        // this.pdfPath = "https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/f36db534038d41ff9f5ad33f3905b0fd?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1755604746;1755606546&q-key-time=1755604746;1755606546&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=d2d88e840c205780b1fe231b72347f84e5263fc7&response-content-disposition=attachment%3Bfilename%3D80M.pdf%3Bfilename%2A%3Dutf-8%27%2780M.pdf&response-expires=1800"
        // this.pdfPath = "https://tencent-docs-1251316161.cos.ap-guangzhou.myqcloud.com/5645031f214049458ca1489fbab1c2f5?q-sign-algorithm=sha1&q-ak=AKIDOaU77sym0yh8BzgXnmnvnPcq66qIKEOH&q-sign-time=1755603219;1755605019&q-key-time=1755603219;1755605019&q-header-list=&q-url-param-list=response-content-disposition;response-expires&q-signature=7c5328fcc5f632f8632001e0bb46425d21b76e40&response-content-disposition=attachment%3Bfilename%3D500M.pdf%3Bfilename%2A%3Dutf-8%27%27500M.pdf&response-expires=1800";
        console.log("pdfPath", this.pdfPath);
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

            // 逐页渲染为图片
            for (let pageNum = 1; pageNum <= 1; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);
                await this.renderAndSavePage(page, pageNum, outputDir, pdfDocument);
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

    // 渲染并保存单个PDF页面
    async renderAndSavePage(page, pageNum, outputDir, pdfDocument) {
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
        console.log('datas', datas);
        const byteLength = datas.reduce((total, data) => total + data.byteLength, 0);
        console.log('byteLength', byteLength);
        const byteData = new Uint8Array(byteLength);
        let offset = 0;
        for (const data of datas) {
            byteData.set(new Uint8Array(data), offset);
            offset += data.byteLength;
        }
        console.log('byteData', byteData);
        this.onDataProgress(byteData.byteLength, this.pdfSize);
        this.onDataRange(start, byteData);
        return byteData;
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
