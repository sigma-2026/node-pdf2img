/**
 * @tencent/pdf2img - 高性能 PDF 转图片工具
 */

export interface RenderOptions {
    /** 目标渲染宽度（像素），默认：1280 */
    targetWidth?: number;
    /** 图片密集型页面的目标宽度（像素），默认：1024 */
    imageHeavyWidth?: number;
    /** 最大渲染缩放比例，默认：4.0 */
    maxScale?: number;
    /** WebP 质量 0-100，默认：70 */
    webpQuality?: number;
    /** 启用扫描件检测，默认：true */
    detectScan?: boolean;
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
    /** COS 配置（outputType 为 'cos' 时必需） */
    cos?: CosConfig;
    /** COS key 前缀 */
    cosKeyPrefix?: string;
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
}

export interface ConvertResult {
    /** 是否成功 */
    success: boolean;
    /** PDF 总页数 */
    numPages: number;
    /** 成功渲染的页数 */
    renderedPages: number;
    /** 页面结果数组 */
    pages: PageResult[];
    /** 耗时信息 */
    timing: {
        /** 总耗时（毫秒） */
        total: number;
        /** 原生渲染器耗时（毫秒） */
        native: number;
    };
}

/**
 * PDF 转图片
 *
 * @param input - PDF 文件路径、URL 或 Buffer
 * @param options - 转换选项
 * @returns 转换结果
 */
export function convert(input: string | Buffer, options?: ConvertOptions): Promise<ConvertResult>;

/**
 * 获取 PDF 页数
 *
 * @param input - PDF 文件路径或 Buffer
 * @returns 页数
 */
export function getPageCount(input: string | Buffer): number;

/**
 * 检查原生渲染器是否可用
 */
export function isAvailable(): boolean;

/**
 * 获取版本信息
 */
export function getVersion(): string;

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
    WEBP_QUALITY: number;
    NATIVE_STREAM_THRESHOLD: number;
};

/** 超时配置 */
export const TIMEOUT_CONFIG: {
    RANGE_REQUEST_TIMEOUT: number;
    DOWNLOAD_TIMEOUT: number;
};

/** 检查原生渲染器是否可用 */
export function isNativeAvailable(): boolean;

/** 从 Buffer 渲染 PDF */
export function renderFromBuffer(
    pdfBuffer: Buffer,
    pages?: number[],
    options?: RenderOptions
): Promise<{
    success: boolean;
    numPages: number;
    pages: Array<{
        pageNum: number;
        width: number;
        height: number;
        buffer?: Buffer;
        success: boolean;
        error?: string;
        renderTime: number;
        encodeTime: number;
    }>;
    totalTime: number;
    nativeTime: number;
}>;

/** 从流渲染 PDF（用于远程 URL） */
export function renderFromStream(
    pdfUrl: string,
    pdfSize: number,
    pages?: number[],
    options?: RenderOptions
): Promise<{
    success: boolean;
    numPages: number;
    pages: Array<{
        pageNum: number;
        width: number;
        height: number;
        buffer?: Buffer;
        success: boolean;
        error?: string;
        renderTime: number;
        encodeTime: number;
    }>;
    totalTime: number;
    nativeTime: number;
    streamStats?: object;
}>;
