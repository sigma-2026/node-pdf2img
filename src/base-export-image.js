import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { RangeLoader, EACH_CHUNK_SIZE, INITIAL_DATA_LENGTH } from './range-loader.js';

// 并行渲染配置
const PARALLEL_RENDER = process.env.PARALLEL_RENDER !== 'false'; // 默认启用

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @typedef {Object} CaptureOptions
 * @property {string} pdfPath - PDF文件路径
 * @property {number[]|'all'|null} pages - 页码数组或'all'
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
    pdfData = null; // 存储完整PDF数据用于并行渲染
    
    constructor({ globalPadId }) {
        this.globalPadId = globalPadId;
    }

    /**
     * pdf 转图片
     * @param {CaptureOptions} options - 截图选项
     * @returns {Promise<Array>} 返回图片信息数组
     */
    async pdfToImage({
        pdfPath,
        pages,
    }) {
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
        
        // 判断是否需要并行渲染（多页且子类支持）
        const needParallel = PARALLEL_RENDER && typeof this.renderPagesParallel === 'function';
        
        let loadingTask;
        if (needParallel) {
            // 并行模式：下载完整PDF数据
            console.log('[并行模式] 下载完整PDF数据');
            const response = await fetch(this.pdfPath);
            if (!response.ok) {
                throw new Error(`下载PDF失败: ${response.status} ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            // 使用Buffer存储，避免ArrayBuffer被分离
            this.pdfData = Buffer.from(arrayBuffer);
            this.pdfSize = this.pdfData.byteLength;
            console.log(`[并行模式] PDF下载完成，大小: ${(this.pdfSize / 1024).toFixed(2)}KB`);
            
            loadingTask = getDocument({
                data: new Uint8Array(this.pdfData),
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                verbosity: undefined,
            });
        } else {
            // 串行模式：分片加载
            // 先拿首片数据 10KB
            let initialData;
            try {
                initialData = await this.generateInitDataPromise();
            } catch (error) {
                throw new Error(error);
            }

            const rangeLoader = new RangeLoader(this.pdfSize, initialData, this.pdfPath, EACH_CHUNK_SIZE);
            // 再分页加载
            loadingTask = getDocument({
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
                rangeChunkSize: EACH_CHUNK_SIZE, // 分片大小 1MB
                disableAutoFetch: true, // 关闭自动全量下载
                range: rangeLoader,
                verbosity: undefined, // 日志等级由子类控制
            });
        }
        
        let pdfDocument;
        try {
            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;
            console.log(`PDF 加载成功，共 ${numPages} 页`);
            
            // 用传递的 pages 参数来截图
            const result = await this.captureByPages({ pages, numPages, pdfDocument });
            
            // 调用子类的具体处理逻辑
            const data = await this.processCapturedImages(result);
            
            return data;
        } catch (reason) {
            throw new Error(`截图处理失败: ${reason}`);
        } finally {
            // 确保 PDF 文档被清理
            try {
                if (pdfDocument) {
                    await pdfDocument.destroy();
                }
            } catch (e) {
                // 忽略清理错误
                console.warn('PDF文档清理失败:', e.message);
            }
        }
    }

    /**
     * 根据页码截图
     */
    async captureByPages({ pages, numPages, pdfDocument }) {
        const data = [];

        if (pages === 'all') {
            pages = Array.from({ length: numPages }, (_, i) => i + 1);
            console.log("全量截图");
        } else if (!pages) {
            pages = Array.from({ length: 6 }, (_, i) => i + 1);
            console.log("前6页截图");
        } else {
            //  去重
            pages = [...new Set(pages)];
            console.log("部分截图 pages:", pages);
        }

        // 过滤超出范围的页码
        const validPages = pages.filter(p => p <= numPages);
        if (validPages.length < pages.length) {
            console.log(`过滤掉 ${pages.length - validPages.length} 个超出范围的页码`);
        }

        // 判断是否使用并行渲染
        const useParallel = PARALLEL_RENDER && validPages.length > 1 && this.pdfData && typeof this.renderPagesParallel === 'function';
        
        let bufferArr;
        if (useParallel) {
            console.log(`[并行模式] 渲染 ${validPages.length} 个页面`);
            bufferArr = await this.renderPagesParallel(validPages, this.pdfData);
            if (bufferArr.length > 0) {
                console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
            }
        } else {
            console.log(`[串行模式] 渲染 ${validPages.length} 个页面`);
            bufferArr = [];
            // 逐页渲染为图片
            for (let i = 0; i < validPages.length; i++) {
                const pageNum = validPages[i];
                console.log("正在截图pageNum", pageNum);

                const page = await pdfDocument.getPage(pageNum);
                const bufferInfo = await this.renderAndSavePage(page, pageNum, pdfDocument);
                
                bufferArr.push(bufferInfo);

                if (i === 0) {
                    console.log('🚀首张截图完成耗时', Date.now() - global.begin + 'ms');
                }
                
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
        }
        
        return { bufferArr, data: bufferArr };
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

export { BaseExportImage };