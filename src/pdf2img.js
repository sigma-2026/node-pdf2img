import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { IS_DEV } from './env.js';
import { uploadFiles } from './upload-file.js';
import { RangeLoader, EACH_CHUNK_SIZE, EACH_SMALL_CHUNK_SIZE, INITIAL_DATA_LENGTH } from './range-loader.js';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ExportImage {
    pdfSize = 0;
    pdfPath = '';
    globalPadId = '';
    constructor({ globalPadId }) {
        this.globalPadId = globalPadId;
    }

    /**
     * pdf 转图片
     * @param pdfPath pdf路径
     * @param outputDir 输出目录(仅本地调试需要)
     * @param pages 需要截图的页码, 不传则全量截图
     */
    async pdfToImage({
        pdfPath,
        outputDir,
        pages,
        screen,
    }) {
        // 运行在本地时候返回路径, 运行在服务器时候返回cos地址
        let data = [];
        console.log("pdfToImage");
        this.pdfPath = pdfPath;
        const CMAP_URL = path.join(
            __dirname,
            'node_modules/pdfjs-dist/cmaps/'
        );

        const STANDARD_FONT_DATA_URL =
            path.join(
                __dirname,
                'node_modules/pdfjs-dist/standard_fonts/'
            );
        // 先拿首片数据 10KB
        let initialData;
        try {
            initialData = await this.generateInitDataPromise();
        } catch (error) {
            throw new Error(error);
        }

        const rangeLoader = new RangeLoader(this.pdfSize, initialData, this.pdfPath, EACH_CHUNK_SIZE);
        // 再分页加载
        const loadingTask = getDocument({
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            rangeChunkSize: EACH_CHUNK_SIZE, // 分片大小 1MB
            disableAutoFetch: true, // 关闭自动全量下载
            range: rangeLoader,
            verbosity: 5, // 日志等级
        });
        console.log("getDocument");
        try {
            const pdfDocument = await loadingTask.promise;
            console.log("PDF document loaded.");
            const numPages = pdfDocument.numPages;
            console.log(`PDF 加载成功，共 ${numPages} 页`);
            let bufferArr;
            // 传递了 screen, 则自动分析截图几页
            if (screen) {
                ({ bufferArr, data } = await this.captureByScreen({ screen, numPages, pdfDocument, outputDir }));
            } else {
                // 不传 screen, 则用传递的 pages 参数来截图
                ({ bufferArr, data } = await this.captureByPages({ pages, numPages, pdfDocument, outputDir }));
            }

            // 上传
            if (!IS_DEV) {
                console.log('开始上传cos', bufferArr.length, '个文件');
                const response = await uploadFiles({ globalPadId: this.globalPadId, bufferArr });
                console.log('response.files', response.files);
                response.files.forEach((file, index) => {
                    data.push({
                        cosKey: '/' + file.options.Key,
                        width: bufferArr[index].width,
                        height: bufferArr[index].height,
                    });
                });
                console.log('🚀全部截图+上次cos完成耗时', Date.now() - global.begin + 'ms');
            } else {
                console.log('🚀本地全部截图完成耗时', Date.now() - global.begin + 'ms');
            }
        } catch (reason) {
            throw new Error("截图处理失败:", reason);
        }

        return data;
    }

    /**
     * 根据页码截图
     */
    async captureByPages({ pages, numPages, pdfDocument, outputDir }) {
        const data = [];

        if (pages === 'all') {
            pages = Array.from({ length: numPages }, (_, i) => i + 1);
            console.log("全量截图");
        } else if (!pages) {
            pages = Array.from({ length: Math.min(numPages, 3) }, (_, i) => i + 1);
            console.log("前3页截图");
        } else {
            //  去重
            pages = [...new Set(pages)];
            console.log("部分截图 pages:", pages);
        }

        // 逐页渲染为图片
        const bufferArr = [];
        for (let i = 0; i < pages.length; i++) {
            const pageNum = pages[i];
            console.log("正在截图pageNum", pageNum);
            if (pageNum > numPages) {
                console.log("pageNum > numPages, 跳过", { pageNum, numPages });
                continue;
            }

            const page = await pdfDocument.getPage(pageNum);
            const bufferInfo = await this.renderAndSavePage(page, pageNum, outputDir, pdfDocument);
            if (IS_DEV) {
                data.push(bufferInfo);
            } else {
                bufferArr.push(bufferInfo);
            }

            if (i === 0) {
                console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
            }
            // 每处理3页强制GC（防内存泄漏）
            if (pageNum % 3 === 0 && global.gc) {
                global.gc();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        return { bufferArr, data };
    }

    /**
     * 根据视口截图
     */
    async captureByScreen({ screen, numPages, pdfDocument, outputDir }) {
        const data = [];
        console.log("screen分析截图", screen);
        // 遍历分析
        const bufferArr = [];
        let totalHeight = 0;
        const screenHeight = screen.height;
        const screenWidth = screen.width;
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log("正在截图pageNum", pageNum);
            console.log("当前totalHeight", totalHeight);
            if (totalHeight >= screenHeight) {
                break;
            }
            const page = await pdfDocument.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.0 });
            const pageHeight = viewport.height / viewport.width * screenWidth;
            console.log("pageHeight", pageHeight);

            const bufferInfo = await this.renderAndSavePage(page, pageNum, outputDir, pdfDocument);
            if (IS_DEV) {
                data.push(bufferInfo);
            } else {
                bufferArr.push(bufferInfo);
            }

            if (totalHeight === 0) {
                console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
            }
            totalHeight += pageHeight;
            console.log("----------分割线------------");
            // 每处理3页强制GC（防内存泄漏）
            if (pageNum % 3 === 0 && global.gc) {
                global.gc();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        return { bufferArr, data };
    }

    // 渲染并保存单个PDF页面
    async renderAndSavePage(page, pageNum, outputDir, pdfDocument) {
        let canvasAndContext;
        // 远程环境
        let bufferInfo = {};
        // 本地开发
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

            if (IS_DEV) {
                // 本地环境确保输出目录存在
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir);
                }
                outputPath = `${outputDir}/page_${pageNum}.webp`;
                const image = canvasAndContext.canvas.toBuffer("image/webp");
                fs.writeFileSync(outputPath, image);
                console.log(`✅ 页面 ${pageNum} 已保存至: ${outputPath}`);
            } else {
                const image = canvasAndContext.canvas.toBuffer("image/webp");
                bufferInfo = {
                    pageNum,
                    buffer: image,
                    width: viewport.width,
                    height: viewport.height,
                };
            }
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

        if (IS_DEV) {
            return outputPath;
        }

        return bufferInfo;
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
                if (response.status !== 206 && response.status !== 200) {
                    throw new Error(`请求初始数据失败: ${response.status} ${response.statusText}`);
                }
                this.pdfSize = this.getDocumentSize(response);
                console.log('pdfSize', this.pdfSize);
                return response.arrayBuffer();
            });
    };
}

export { ExportImage };
