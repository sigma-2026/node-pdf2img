import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { IS_DEV } from './env.js';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @typedef {Object} CaptureOptions
 * @property {string} pdfPath - PDF文件路径
 * @property {number[]|'all'|null} pages - 页码数组或'all', 默认前6页
 */

/**
 * @typedef {Object} BufferInfo
 * @property {number} pageNum - 页码
 * @property {Buffer} buffer - 图片buffer
 * @property {number} width - 图片宽度
 * @property {number} height - 图片高度
 */

/**
 * PDF转图片基类
 */
class BaseExportImage {
    pdfSize = 0;
    pdfPath = '';
    globalPadId = '';
    
    constructor({ globalPadId }) {
        this.globalPadId = globalPadId;
    }

    /**
     * pdf 转图片
     * @param {CaptureOptions} options - 截图选项
     * @returns {Promise<Array>} 返回图片信息数组
     */
    async pdfToImage({ pdfPath, pages }) {
        this.pdfPath = pdfPath;
        
        // 1. 初始化配置
        const config = this.getConfig();
        
        // 2. 获取初始数据
        const initialData = await this.getInitialData();
        
        // 3. 加载PDF文档
        const pdfDocument = await this.loadPdfDocument(config, initialData);
        
        try {
            // 4. 处理PDF截图
            return await this.processPdfCapture(pdfDocument, pages);
        } finally {
            // 5. 清理资源
            await this.cleanupPdfDocument(pdfDocument);
        }
    }
    
    /**
     * 获取PDF.js配置
     */
    getConfig() {
        const CMAP_URL = path.join(__dirname, 'node_modules/pdfjs-dist/cmaps/');
        const STANDARD_FONT_DATA_URL = path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts/');
        
        return {
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            rangeChunkSize: EACH_CHUNK_SIZE,
            disableAutoFetch: true,
            verbosity: IS_DEV ? 5 : undefined,
        };
    }
    
    /**
     * 获取初始数据
     */
    async getInitialData() {
        try {
            return await this.generateInitDataPromise();
        } catch (error) {
            throw new Error(`获取初始数据失败: ${error}`);
        }
    }
    
    /**
     * 加载PDF文档
     */
    async loadPdfDocument(config, initialData) {
        const rangeLoader = new RangeLoader(this.pdfSize, initialData, this.pdfPath, EACH_CHUNK_SIZE);
        const loadingTask = getDocument({
            ...config,
            range: rangeLoader,
        });
        
        try {
            const pdfDocument = await loadingTask.promise;
            console.log(`PDF 加载成功，共 ${pdfDocument.numPages} 页`);
            return pdfDocument;
        } catch (reason) {
            throw new Error(`PDF文档加载失败: ${reason}`);
        }
    }
    
    /**
     * 处理PDF截图
     */
    async processPdfCapture(pdfDocument, pages) {
        const numPages = pdfDocument.numPages;
        const result = await this.captureByPages({ pages, numPages, pdfDocument });
        return await this.processCapturedImages(result);
    }
    
    /**
     * 清理PDF文档资源
     */
    async cleanupPdfDocument(pdfDocument) {
        if (!pdfDocument) return;
        
        try {
            await pdfDocument.destroy();
        } catch (e) {
            console.warn('PDF文档清理失败:', e.message);
        }
    }

    /**
     * 根据页码截图
     */
    async captureByPages({ pages, numPages, pdfDocument }) {
        const data = [];
        const bufferArr = [];
        
        // 1. 规范化页码数组
        const normalizedPages = this.normalizePages(pages, numPages);
        
        // 2. 逐页处理
        for (let i = 0; i < normalizedPages.length; i++) {
            const pageNum = normalizedPages[i];
            
            // 跳过超出范围的页码
            if (pageNum > numPages) {
                console.log("pageNum > numPages, 跳过", { pageNum, numPages });
                continue;
            }

            // 处理单个页面
            const bufferInfo = await this.processSinglePage(pageNum, pdfDocument, i);
            
            data.push(bufferInfo);
            bufferArr.push(bufferInfo);
            
            // 内存管理
            await this.manageMemory(pageNum);
        }
        
        return { bufferArr, data };
    }
    
    /**
     * 规范化页码数组
     */
    normalizePages(pages, numPages) {
        if (pages === 'all') {
            console.log("全量截图");
            return Array.from({ length: numPages }, (_, i) => i + 1);
        } else if (!pages) {
            console.log("前6页截图");
            return Array.from({ length: 6 }, (_, i) => i + 1);
        } else {
            console.log("部分截图 pages:", pages);
            return [...new Set(pages)]; // 去重
        }
    }
    
    /**
     * 处理单个页面
     */
    async processSinglePage(pageNum, pdfDocument, index) {
        console.log("正在截图pageNum", pageNum);
        
        const page = await pdfDocument.getPage(pageNum);
        const bufferInfo = await this.renderAndSavePage(page, pageNum, pdfDocument);
        
        // 记录首张截图耗时
        if (index === 0) {
            console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
        }
        
        return bufferInfo;
    }
    
    /**
     * 内存管理
     */
    async manageMemory(pageNum) {
        // 每处理3页检查内存并触发GC（防内存泄漏）
        if (pageNum % 3 === 0) {
            const usage = process.memoryUsage();
            const heapUsedMB = usage.heapUsed / 1024 / 1024;
            
            if (heapUsedMB > 800 && global.gc) {
                console.log(`内存使用 ${heapUsedMB.toFixed(2)}MB，触发 GC`);
                global.gc();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }

    /**
     * 渲染并保存单个PDF页面（抽象方法，由子类实现）
     */
    async renderAndSavePage(page, pageNum, pdfDocument) {
        throw new Error('renderAndSavePage method must be implemented by subclass');
    }

    /**
     * 处理捕获的图片（抽象方法，由子类实现）
     */
    async processCapturedImages(result) {
        throw new Error('processCapturedImages method must be implemented by subclass');
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

    /**
     * 手动销毁实例，清理所有资源
     */
    async destroy() {
        console.log(`[${this.globalPadId}] 清理ExportImage实例资源`);
    }
}

/**
 * 开发环境：本地文件保存
 */
class DevExportImage extends BaseExportImage {
    /** dev 环境的输出目录 */
    outputDir = process.env.OUTPUT_DIR || '/tmp/pdf2img';

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
            
            const filePrefix = `${this.outputDir}/${this.globalPadId}`;
            if (!fs.existsSync(filePrefix)) {
                fs.mkdirSync(filePrefix, { recursive: true });
            }
            
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

/**
 * 工厂函数：根据环境返回对应的ExportImage实例
 * @param {Object} options - 配置选项
 * @param {string} options.globalPadId - 全局Pad ID
 * @returns {Promise<BaseExportImage>} ExportImage实例
 */
export async function createExportImage(options) {
    if (IS_DEV) {
        const { DevExportImage } = await import('./dev-export-image.js');
        return new DevExportImage(options);
    } else {
        const { ProdExportImage } = await import('./prod-export-image.js');
        return new ProdExportImage(options);
    }
}

// 导出工厂函数作为默认导出
export default { createExportImage };
