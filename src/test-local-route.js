import path from "path";
import fs from "fs";
import { createExportImage } from "./pdf2img.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 本地测试路由 - 仅用于开发环境
 * 生产环境构建时不应包含此文件
 */
export function registerTestLocalRoute(app, PORT) {
    /**
     * 本地测试接口 - 仅开发环境可用
     * 
     * @param {Object} req - 请求对象
     * @param {Object} res - 响应对象
     * @returns {Object} 测试结果
     * @property {number} code - 状态码（200=成功，500=失败）
     * @property {Object[]|null} data - 转换结果数据
     * @property {string} data[].outputPath - 本地文件路径
     * @property {number} data[].width - 图片宽度
     * @property {number} data[].height - 图片高度
     * @property {number} data[].pageNum - 页码
     * @property {string} message - 响应消息
     * 
     * @example
     * // 请求示例
     * GET http://localhost:3000/test-local
     * 
     * @example
     * // 成功响应示例
     * {
     *   "code": 200,
     *   "data": [
     *     {
     *       "outputPath": "/tmp/pdf2img/local-test-123456/page_1.webp",
     *       "width": 1584,
     *       "height": 2244,
     *       "pageNum": 1
     *     }
     *   ],
     *   "message": "✅ 本地测试成功！截图已保存至 '/tmp/pdf2img' 目录。"
     * }
     */
    app.get("/test-local", async (req, res) => {
        global.begin = Date.now();
        console.log("触发本地测试接口: /test-local");

        // 1. 定义测试参数
        // 您可以更改为 static 目录下的其他文件名，如 '10M.pdf', '50M.pdf' 等
        const pdfFileName = '1M.pdf'; 
        const globalPadId = `local-test-${Date.now()}`;
        // 从环境变量中读取截图输出目录
        const outputDir = path.join(__dirname, '..', process.env.OUTPUT_DIR || 'output'); 
        
        // 确保输出目录存在
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // 2. 构造PDF文件的访问URL
        // 这里的URL会指向我们服务自身的 /static 路由，从而实现一次完整的HTTP分片请求测试
        const pdfUrl = `http://localhost:${PORT}/static/${pdfFileName}`;
        console.log(`本地测试PDF路径 (将由服务自身处理): ${pdfUrl}`);
        console.log(`测试用的 globalPadId: ${globalPadId}`);
        console.log(`截图输出目录: ${outputDir}`);

    let exportImage;
    try {
        // 3. 实例化并调用核心服务
        exportImage = await createExportImage({ globalPadId });
        
        // 您可以在此自定义测试参数, pages: "all" 表示全量截图, 也可以是页码数组 [1, 3]
        const data = await exportImage.pdfToImage({
            pdfPath: pdfUrl,
            pages: "all",
        });

        const successMessage = `✅ 本地测试成功！截图已保存至 '${outputDir}' 目录。`;
        console.log(successMessage);
        res.send({
            code: 200,
            data: data,
            message: successMessage,
        });
    } catch (error) {
        console.error("❌ 本地测试时发生错误:", error);
        res.status(500).send({
            code: 500,
            data: null,
            message: error.message,
        });
    } finally {
        // 确保 ExportImage 实例被清理
        if (exportImage) {
            try {
                await exportImage.destroy();
            } catch (destroyError) {
                console.warn('ExportImage实例清理失败:', destroyError.message);
            }
        }
    }    });
}
