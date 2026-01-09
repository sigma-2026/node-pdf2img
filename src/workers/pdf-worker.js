/**
 * PDF Worker - 终极架构 V7 执行中心（重构版）
 * 
 * 职责：
 * 作为调度器，根据主线程的决策，调用相应的渲染器模块。
 * 
 * 渲染路径：
 * 1. Native 路径 (useNativeRenderer: true)
 *    - 接收 pdfData (Buffer)，直接调用 native-renderer
 *    - 适用于小文件和扫描件
 *    - 性能最优，亚秒级响应
 * 
 * 2. Native Stream 路径 (useNativeStream: true) [V8 新增]
 *    - 接收 pdfUrl 和 pdfSize，通过回调按需获取数据
 *    - 适用于大文件，避免一次性下载整个 PDF
 *    - 结合了 Native 渲染性能和分片加载的网络效率
 * 
 * 3. PDF.js 路径 (useNativeRenderer: false)
 *    - 接收 pdfUrl，使用 RangeLoader 分片加载
 *    - 适用于大文件和文本密集型 PDF
 *    - [V7优化] 串行渲染，并行上传，避免资源争抢
 * 
 * 重构说明：
 * - 渲染逻辑已拆分到 renderers/ 目录下的独立模块
 * - 上传逻辑已统一到 upload-manager.js
 * - 本文件仅作为调度入口，职责单一
 * 
 * @module pdf-worker
 */

import { processWithNative, processWithNativeStream, isNativeAvailable } from './renderers/native-adapter.js';
import { processWithPdfjs } from './renderers/pdfjs-renderer.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Worker');

/**
 * Worker 主入口：根据主线程的决策调度渲染器
 * 
 * 该函数是 Worker 的唯一入口点，根据参数决定使用哪个渲染路径。
 * 优先级：Native Stream > Native > PDF.js
 * 
 * @param {Object} params - 处理参数
 * @param {Buffer} [params.pdfData] - PDF 文件数据（Native 路径）
 * @param {string} [params.pdfUrl] - PDF 文件 URL（PDF.js 路径 / Native Stream 路径）
 * @param {number[]|null} params.pageNums - 要渲染的页码数组，null 表示让 Worker 自己计算
 * @param {string|number[]|null} [params.pagesParam] - 原始 pages 参数（当 pageNums 为 null 时使用）
 * @param {string} params.globalPadId - 全局 ID，用于构造 COS 路径
 * @param {boolean} params.uploadToCos - 是否上传到 COS
 * @param {boolean} params.useNativeRenderer - 是否使用 Native Renderer
 * @param {boolean} [params.useNativeStream] - 是否使用 Native Stream 模式
 * @param {number} [params.pdfSize] - PDF 文件大小（字节）
 * @param {number} [params.numPages] - PDF 页数（0 表示侦察失败）
 * @returns {Promise<Object>} 处理结果
 * @property {boolean} success - 是否成功
 * @property {Array} results - 渲染结果数组
 * @property {Object} metrics - 性能指标
 * @property {string} [error] - 错误信息（失败时）
 * 
 * @example
 * // Native 路径
 * const result = await processPages({
 *   pdfData: buffer,
 *   pageNums: [1, 2, 3],
 *   globalPadId: 'pad123',
 *   uploadToCos: true,
 *   useNativeRenderer: true,
 * });
 * 
 * @example
 * // PDF.js 路径
 * const result = await processPages({
 *   pdfUrl: 'https://example.com/doc.pdf',
 *   pageNums: [1, 2, 3],
 *   globalPadId: 'pad123',
 *   uploadToCos: true,
 *   useNativeRenderer: false,
 * });
 */
export default async function processPages(params) {
    const { useNativeRenderer, useNativeStream, pdfData, pdfUrl } = params;
    
    // 检查 Native Renderer 是否可用
    const nativeAvailable = isNativeAvailable();
    
    // 记录调度决策
    const engine = useNativeStream && nativeAvailable ? 'native-stream' 
        : useNativeRenderer && nativeAvailable ? 'native' 
        : 'pdfjs';
    
    logger.debug(`Dispatching task`, { 
        engine, 
        hasPdfData: !!pdfData, 
        hasPdfUrl: !!pdfUrl,
        nativeAvailable,
    });
    
    // 优先级：Native Stream > Native > PDF.js
    if (useNativeStream && nativeAvailable && pdfUrl) {
        return await processWithNativeStream(params);
    } else if (useNativeRenderer && nativeAvailable && pdfData) {
        return await processWithNative(params);
    } else if (pdfUrl) {
        return await processWithPdfjs(params);
    } else {
        throw new Error('无效的任务参数：需要 pdfData 或 pdfUrl');
    }
}

// 导出渲染器可用性检查函数
export { isNativeAvailable };
