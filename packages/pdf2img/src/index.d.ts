/**
 * @tencent/pdf2img - 高性能 PDF 转图片工具
 * 
 * 支持两种渲染器：
 * - pdfium: PDFium 原生渲染器（默认，高性能）
 * - pdfjs: PDF.js 渲染器（纯 JavaScript，无需原生依赖）
 */

/** 渲染器类型常量 */
export const RendererType: {
    /** PDFium 原生渲染器（默认，高性能） */
    PDFIUM: 'pdfium';
    /** PDF.js 渲染器（纯 JavaScript，无需原生依赖） */
    PDFJS: 'pdfjs';
};

/** 渲染器类型 */
export type RendererTypeValue = 'pdfium' | 'pdfjs';

export interface RenderOptions {
    /** 目标渲染宽度（像素），默认：1280 */
    targetWidth?: number;
    /** 图片密集型页面的目标宽度（像素），默认：1024 */
    imageHeavyWidth?: number;
    /** 最大渲染缩放比例，默认：4.0 */
    maxScale?: number;
    /** WebP 质量 0-100，默认：80 */
    webpQuality?: number;
    /** 启用扫描件检测，默认：true */
    detectScan?: boolean;
    /** 渲染器：'pdfium'（默认）或 'pdfjs' */
    renderer?: RendererTypeValue;
}

export interface WebpOptions {
    /** WebP 质量 0-100，默认：80 */
    quality?: number;
    /** WebP 编码方法 0-6，默认：4，0最快6最慢 */
    method?: number;
}

export interface JpegOptions {
    /** JPEG 质量 0-100，默认：85 */
    quality?: number;
}

export interface PngOptions {
    /** PNG 压缩级别 0-9，默认：6 */
    compressionLevel?: number;
}

export interface CosConfig {
    /** 腾讯云 SecretId */
    secretId: string;
    /** 腾讯云 SecretKey */
    secretKey: string;
    /** COS 存储桶名称 */
    bucket: string;
    /** COS 地域 */
    region: string;
    /** 协议，默认：'https:' */
    protocol?: string;
    /** 服务域名 */
    serviceDomain?: string;
    /** 自定义域名 */
    domain?: string;
}

export interface ConvertOptions extends RenderOptions {
    /** 要转换的页码（1-based），空数组表示全部页面 */
    pages?: number[];
    /** 输出类型：'file'、'buffer' 或 'cos' */
    outputType?: 'file' | 'buffer' | 'cos';
    /** 输出目录（outputType 为 'file' 时必需） */
    outputDir?: string;
    /** 输出文件名前缀，默认：'page' */
    prefix?: string;
    /** 输出格式：'webp'、'png'、'jpg'，默认：'webp' */
    format?: 'webp' | 'png' | 'jpg' | 'jpeg';
    /** 图片质量 0-100（用于 webp 和 jpg） */
    quality?: number;
    /** WebP 编码配置 */
    webp?: WebpOptions;
    /** JPEG 编码配置 */
    jpeg?: JpegOptions;
    /** PNG 编码配置 */
    png?: PngOptions;
    /** COS 配置（outputType 为 'cos' 时必需） */
    cos?: CosConfig;
    /** COS key 前缀 */
    cosKeyPrefix?: string;
    /** 文件/上传并发数 */
    concurrency?: number;
}

export interface PageResult {
    /** 页码（1-based） */
    pageNum: number;
    /** 图片宽度（像素） */
    width: number;
    /** 图片高度（像素） */
    height: number;
    /** 是否成功渲染 */
    success: boolean;
    /** 图片 Buffer（outputType 为 'buffer' 时） */
    buffer?: Buffer;
    /** 输出文件路径（outputType 为 'file' 时） */
    outputPath?: string;
    /** COS key（outputType 为 'cos' 时） */
    cosKey?: string;
    /** 图片大小（字节） */
    size?: number;
    /** 错误信息（失败时） */
    error?: string;
    /** 渲染耗时（毫秒） */
    renderTime?: number;
    /** 编码耗时（毫秒） */
    encodeTime?: number;
}

export interface StreamStats {
    /** 请求次数 */
    requestCount?: number;
    /** 总请求次数 */
    totalRequests?: number;
    /** 总下载字节数 */
    totalBytes?: number;
    /** 总下载大小（MB） */
    totalBytesMB?: string;
    /** 平均请求耗时（毫秒） */
    avgRequestTime?: number;
    /** 加载模式 */
    mode?: string;
}

export interface ConvertResult {
    /** 是否成功 */
    success: boolean;
    /** PDF 总页数 */
    numPages: number;
    /** 成功渲染的页数 */
    renderedPages: number;
    /** 输出格式 */
    format: string;
    /** 使用的渲染器 */
    renderer: RendererTypeValue;
    /** 页面结果数组 */
    pages: PageResult[];
    /** 耗时信息 */
    timing: {
        /** 总耗时（毫秒） */
        total: number;
        /** 渲染耗时（毫秒） */
        render: number;
        /** 编码耗时（毫秒） */
        encode: number;
    };
    /** 线程池信息 */
    threadPool: {
        /** 工作线程数 */
        workers: number;
    };
    /** 流式渲染统计（仅 URL 输入时存在） */
    streamStats?: StreamStats;
}

export interface GetPageCountOptions {
    /** 渲染器：'pdfium'（默认）或 'pdfjs' */
    renderer?: RendererTypeValue;
}

/**
 * PDF 转图片
 *
 * @param input - PDF 文件路径、URL 或 Buffer
 * @param options - 转换选项
 * @returns 转换结果
 * 
 * @example
 * ```javascript
 * // 使用默认 pdfium 渲染器
 * const result = await convert('./document.pdf');
 * 
 * // 使用 PDF.js 渲染器
 * const result = await convert('./document.pdf', { renderer: 'pdfjs' });
 * ```
 */
export function convert(input: string | Buffer, options?: ConvertOptions): Promise<ConvertResult>;

/**
 * 获取 PDF 页数
 *
 * @param input - PDF 文件路径、URL 或 Buffer
 * @param options - 选项（可指定渲染器）
 * @returns 页数
 */
export function getPageCount(input: string | Buffer, options?: GetPageCountOptions): Promise<number>;

/**
 * 获取 PDF 页数（同步版本）
 * 
 * @deprecated 使用 getPageCount 的异步版本以获得更好的性能
 * @param input - PDF 文件路径或 Buffer
 * @returns 页数
 */
export function getPageCountSync(input: string | Buffer): number;

/**
 * 检查渲染器是否可用
 * 
 * @param renderer - 渲染器类型（可选）。不传则检查是否有任何可用渲染器
 * @returns 是否可用
 */
export function isAvailable(renderer?: RendererTypeValue): boolean;

/**
 * 获取版本信息
 * 
 * @param renderer - 渲染器类型（可选）
 * @returns 版本信息
 */
export function getVersion(renderer?: RendererTypeValue): string;

/**
 * 获取线程池统计信息
 */
export function getThreadPoolStats(): object | null;

/**
 * 销毁线程池
 */
export function destroyThreadPool(): Promise<void>;

/** 输入类型常量 */
export const InputType: {
    FILE: 'file';
    URL: 'url';
    BUFFER: 'buffer';
};

/** 输出类型常量 */
export const OutputType: {
    FILE: 'file';
    BUFFER: 'buffer';
    COS: 'cos';
};

/** 渲染配置 */
export const RENDER_CONFIG: {
    TARGET_RENDER_WIDTH: number;
    IMAGE_HEAVY_TARGET_WIDTH: number;
    MAX_RENDER_SCALE: number;
    OUTPUT_FORMAT: string;
    NATIVE_STREAM_THRESHOLD: number;
};

/** 超时配置 */
export const TIMEOUT_CONFIG: {
    RANGE_REQUEST_TIMEOUT: number;
    DOWNLOAD_TIMEOUT: number;
};

/** 默认渲染器 */
export const DEFAULT_RENDERER: RendererTypeValue;

// ==================== 原生渲染器导出 ====================

/** 检查原生渲染器是否可用 */
export function isNativeAvailable(): boolean;

/** 获取 PDF 页数（原生渲染器） */
export function getPageCountNative(pdfBuffer: Buffer): number;

/** 获取 PDF 页数（从文件路径，原生渲染器） */
export function getPageCountFromFile(filePath: string): number;

/** 渲染单页到原始位图 */
export function renderPageToRawBitmap(
    filePath: string,
    pageNum: number,
    options?: RenderOptions
): {
    success: boolean;
    buffer?: Buffer;
    width?: number;
    height?: number;
    channels?: number;
    renderTime?: number;
    error?: string;
};

/** 从 Buffer 渲染单页到原始位图 */
export function renderPageToRawBitmapFromBuffer(
    pdfBuffer: Buffer,
    pageNum: number,
    options?: RenderOptions
): {
    success: boolean;
    buffer?: Buffer;
    width?: number;
    height?: number;
    channels?: number;
    renderTime?: number;
    error?: string;
};

// ==================== PDF.js 渲染器导出 ====================

/** 检查 PDF.js 渲染器是否可用 */
export function isPdfjsAvailable(): boolean;

/** 获取 PDF.js 版本信息 */
export function getPdfjsVersion(): string;

/** 获取 PDF 页数（PDF.js 渲染器） */
export function getPageCountPdfjs(pdfBuffer: Buffer): Promise<number>;

/** 获取 PDF 页数（从文件路径，PDF.js 渲染器） */
export function getPageCountFromFilePdfjs(filePath: string): Promise<number>;
