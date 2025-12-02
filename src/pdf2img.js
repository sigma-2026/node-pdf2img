import { fileURLToPath } from 'url';
import path from 'path';
import { IS_DEV } from './env.js';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PAGE_NUM = 6;

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
