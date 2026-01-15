/**
 * PDF2IMG 配置
 */

// ==================== 渲染器类型 ====================
export const RendererType = {
    PDFIUM: 'pdfium',  // PDFium 原生渲染器（默认，高性能）
    PDFJS: 'pdfjs',    // PDF.js 渲染器（纯 JavaScript，无需原生依赖）
};

// 默认渲染器
export const DEFAULT_RENDERER = process.env.PDF2IMG_RENDERER || RendererType.PDFIUM;

// ==================== 渲染配置 ====================
export const RENDER_CONFIG = {
    // 目标渲染宽度（像素）
    TARGET_RENDER_WIDTH: parseInt(process.env.TARGET_RENDER_WIDTH) || 1280,

    // 图片密集型页面的目标宽度（像素）
    IMAGE_HEAVY_TARGET_WIDTH: parseInt(process.env.IMAGE_HEAVY_TARGET_WIDTH) || 1024,

    // 最大渲染缩放比例
    MAX_RENDER_SCALE: parseFloat(process.env.MAX_RENDER_SCALE) || 4.0,

    // 默认输出格式：webp, png, jpg
    OUTPUT_FORMAT: process.env.OUTPUT_FORMAT || 'webp',

    // Native Stream 阈值（字节）- 大于此值使用流式加载
    NATIVE_STREAM_THRESHOLD: parseInt(process.env.NATIVE_STREAM_THRESHOLD) || 5 * 1024 * 1024, // 5MB
};

// ==================== 编码器配置 ====================
export const ENCODER_CONFIG = {
    // WebP 编码质量（0-100）
    WEBP_QUALITY: parseInt(process.env.WEBP_QUALITY) || 80,
    
    // WebP 编码方法/速度（0-6，0最快，6最慢但压缩最好）
    // 默认值 4 是速度和压缩率的最佳平衡点
    WEBP_METHOD: parseInt(process.env.WEBP_METHOD) || 4,
    
    // JPEG 编码质量（0-100）
    JPEG_QUALITY: parseInt(process.env.JPEG_QUALITY) || 85,
    
    // PNG 压缩级别（0-9，0不压缩，9最大压缩）
    PNG_COMPRESSION: parseInt(process.env.PNG_COMPRESSION) || 6,
};

// ==================== 超时配置 ====================
export const TIMEOUT_CONFIG = {
    // 分片请求超时
    RANGE_REQUEST_TIMEOUT: parseInt(process.env.RANGE_REQUEST_TIMEOUT) || 25000, // 25s

    // 下载超时
    DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT) || 60000, // 60s
};

// ==================== 支持的输出格式 ====================
export const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

/**
 * 合并用户配置与默认配置
 * @param {Object} userConfig - 用户配置
 * @returns {Object} 合并后的配置（用于原生渲染器）
 */
export function mergeConfig(userConfig = {}) {
    const format = userConfig.format ?? RENDER_CONFIG.OUTPUT_FORMAT;
    
    return {
        targetWidth: userConfig.targetWidth ?? RENDER_CONFIG.TARGET_RENDER_WIDTH,
        imageHeavyWidth: userConfig.imageHeavyWidth ?? RENDER_CONFIG.IMAGE_HEAVY_TARGET_WIDTH,
        maxScale: userConfig.maxScale ?? RENDER_CONFIG.MAX_RENDER_SCALE,
        detectScan: userConfig.detectScan ?? true,
        format,
        
        // WebP 编码配置
        webpQuality: userConfig.webp?.quality ?? userConfig.quality ?? ENCODER_CONFIG.WEBP_QUALITY,
        webpMethod: userConfig.webp?.method ?? ENCODER_CONFIG.WEBP_METHOD,
        
        // JPEG 编码配置
        jpegQuality: userConfig.jpeg?.quality ?? userConfig.quality ?? ENCODER_CONFIG.JPEG_QUALITY,
        
        // PNG 编码配置
        pngCompression: userConfig.png?.compressionLevel ?? ENCODER_CONFIG.PNG_COMPRESSION,
    };
}

/**
 * 获取文件扩展名
 * @param {string} format - 格式名称
 * @returns {string} 文件扩展名
 */
export function getExtension(format) {
    if (format === 'jpeg') return 'jpg';
    return format;
}

/**
 * 获取 MIME 类型
 * @param {string} format - 格式名称
 * @returns {string} MIME 类型
 */
export function getMimeType(format) {
    const mimeTypes = {
        webp: 'image/webp',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
    };
    return mimeTypes[format] || 'image/webp';
}
