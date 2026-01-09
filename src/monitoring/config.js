/**
 * PDF2IMG 配置中心
 * 
 * 所有可调参数集中管理，支持环境变量覆盖
 */

import { createLogger, IS_DEV } from '../utils/logger.js';

const logger = createLogger('Config');

// ==================== 分片加载配置 ====================
// V10: 生产环境优化 - 更大的分片，更少的请求
export const CHUNK_SIZE_CONFIG = {
  // 小文件（<5MB）使用较大分片
  SMALL_FILE_THRESHOLD: parseInt(process.env.SMALL_FILE_THRESHOLD) || 5 * 1024 * 1024,
  SMALL_FILE_CHUNK_SIZE: parseInt(process.env.SMALL_FILE_CHUNK_SIZE) || 2 * 1024 * 1024, // 2MB (1MB -> 2MB)
  
  // 中等文件（5-50MB）
  MEDIUM_FILE_THRESHOLD: parseInt(process.env.MEDIUM_FILE_THRESHOLD) || 50 * 1024 * 1024,
  MEDIUM_FILE_CHUNK_SIZE: parseInt(process.env.MEDIUM_FILE_CHUNK_SIZE) || 5 * 1024 * 1024, // 5MB (2MB -> 5MB)
  
  // 大文件（>50MB）
  LARGE_FILE_CHUNK_SIZE: parseInt(process.env.LARGE_FILE_CHUNK_SIZE) || 8 * 1024 * 1024, // 8MB (4MB -> 8MB)
};

// 分片并发与请求控制
export const RANGE_CONFIG = {
  // 最大并发 Range 请求数（避免 socket hang up / 过载）
  // V10: 8 -> 6，减少并发避免服务端压力
  MAX_CONCURRENCY: parseInt(process.env.RANGE_MAX_CONCURRENCY) || 6,
};

// 初始数据长度（首片，用于获取元数据+首页）
export const INITIAL_DATA_LENGTH = parseInt(process.env.INITIAL_DATA_LENGTH) || 64 * 1024; // 64KB

// ==================== 超时配置 ====================
export const TIMEOUT_CONFIG = {
  // 基础超时（毫秒）
  BASE_TIMEOUT: parseInt(process.env.BASE_TIMEOUT) || 60000, // 60s（增加基础超时）
  
  // 每页额外超时
  PER_PAGE_TIMEOUT: parseInt(process.env.PER_PAGE_TIMEOUT) || 8000, // 8s/页（大页面渲染需要更多时间）
  
  // 每 MB 额外超时
  PER_MB_TIMEOUT: parseInt(process.env.PER_MB_TIMEOUT) || 500, // 0.5s/MB
  
  // 最大超时
  MAX_TIMEOUT: parseInt(process.env.MAX_TIMEOUT) || 300000, // 5分钟
  
  // 分片请求超时
  // V10: 15s -> 25s，更容忍网络抖动
  RANGE_REQUEST_TIMEOUT: parseInt(process.env.RANGE_REQUEST_TIMEOUT) || 25000, // 25s
};

// ==================== 重试配置 ====================
export const RETRY_CONFIG = {
  // 分片加载重试次数
  RANGE_LOADER_RETRIES: parseInt(process.env.RANGE_LOADER_RETRIES) || 3,
  
  // 重试基础延迟（毫秒）
  RETRY_DELAY_BASE: parseInt(process.env.RETRY_DELAY_BASE) || 200,
  
  // 最大重试延迟
  MAX_RETRY_DELAY: parseInt(process.env.MAX_RETRY_DELAY) || 5000,
};

// ==================== 渲染配置 ====================
export const RENDER_CONFIG = {
  // ==================== 目标尺寸配置 ====================
  // 目标渲染宽度（像素）
  TARGET_RENDER_WIDTH: parseInt(process.env.TARGET_RENDER_WIDTH) || 1280,
  
  // 图片密集型页面的目标宽度（像素）
  IMAGE_HEAVY_TARGET_WIDTH: parseInt(process.env.IMAGE_HEAVY_TARGET_WIDTH) || 1024,
  
  // 最大渲染缩放比例
  MAX_RENDER_SCALE: parseFloat(process.env.MAX_RENDER_SCALE) || 4.0,
  
  // 渲染缩放比例（兼容旧配置）
  RENDER_SCALE: parseFloat(process.env.RENDER_SCALE) || 1.5,
  
  // ==================== 页面尺寸限制 ====================
  // 大页面降级阈值（像素）
  LARGE_PAGE_THRESHOLD: parseInt(process.env.LARGE_PAGE_THRESHOLD) || 2000 * 2000, // 4MP
  
  // 大页面降级缩放比例
  LARGE_PAGE_SCALE: parseFloat(process.env.LARGE_PAGE_SCALE) || 1.0,
  
  // 超大页面阈值（像素）
  XLARGE_PAGE_THRESHOLD: parseInt(process.env.XLARGE_PAGE_THRESHOLD) || 4000 * 4000, // 16MP
  
  // 超大页面缩放比例
  XLARGE_PAGE_SCALE: parseFloat(process.env.XLARGE_PAGE_SCALE) || 0.75,
  
  // ==================== WebP 编码配置 ====================
  // WebP 质量（0-100）
  WEBP_QUALITY: parseInt(process.env.WEBP_QUALITY) || 70,
  
  // WebP Alpha 通道质量（0-100）
  WEBP_ALPHA_QUALITY: parseInt(process.env.WEBP_ALPHA_QUALITY) || 70,
  
  // WebP 编码努力程度（0-6，越高越慢但压缩率越好）
  WEBP_EFFORT: parseInt(process.env.WEBP_EFFORT) || 2,
  
  /**
   * WebP 格式限制
   * MUST be kept in sync with WEBP_MAX_DIMENSION in native-renderer/src/renderer.rs
   */
  WEBP_MAX_DIMENSION: 16383,
  WEBP_MAX_PIXELS: 16383 * 16383,
  
  // ==================== Worker 配置 ====================
  // 是否启用并行渲染（Worker 模式）
  PARALLEL_RENDER: process.env.PARALLEL_RENDER !== 'false',

  // Range 加载并发数
  RANGE_CONCURRENCY: parseInt(process.env.RANGE_CONCURRENCY) || 4,
  
  // 每个 Worker 处理的页数
  PAGES_PER_WORKER: parseInt(process.env.PAGES_PER_WORKER) || 6,
  
  // Worker 线程数
  WORKER_THREADS: parseInt(process.env.WORKER_THREADS) || 4,
  
  // 以下配置保留用于回退模式兼容
  PARALLEL_PDF_MAX_MB: parseInt(process.env.PARALLEL_PDF_MAX_MB) || 10,
  PARALLEL_MIN_PAGES: parseInt(process.env.PARALLEL_MIN_PAGES) || 6,
  BATCH_PAGES_PER_WORKER: parseInt(process.env.BATCH_PAGES_PER_WORKER) || 6,
  
  // ==================== Native Renderer 配置 ====================
  // V10: 生产环境最优配置 - 让 Stream 模式更早介入
  
  // Native renderer 文件大小阈值（字节）
  // V10: 12MB -> 8MB，让 Stream 模式更早介入
  NATIVE_RENDERER_THRESHOLD: parseInt(process.env.NATIVE_RENDERER_THRESHOLD) || 8 * 1024 * 1024, // 8MB
  
  // Native renderer 文件大小上限（字节）
  NATIVE_RENDERER_MAX_SIZE: parseInt(process.env.NATIVE_RENDERER_MAX_SIZE) || 30 * 1024 * 1024, // 30MB
  
  // Native Stream 阈值（字节）
  // V10: 12MB -> 8MB，让大于 8MB 的文件立即享受 native-stream 的亚秒级性能
  NATIVE_STREAM_THRESHOLD: parseInt(process.env.NATIVE_STREAM_THRESHOLD) || 8 * 1024 * 1024, // 8MB
  
  // 是否启用 native-stream 模式
  NATIVE_STREAM_ENABLED: process.env.NATIVE_STREAM_ENABLED !== 'false',
  
  // 扫描件判定阈值：字节/页
  SCAN_BPP_THRESHOLD: parseInt(process.env.SCAN_BPP_THRESHOLD) || 250 * 1024, // 250KB/页
  
  // 复杂页面判定阈值：字节/页
  COMPLEX_PAGE_BPP_THRESHOLD: parseInt(process.env.COMPLEX_PAGE_BPP_THRESHOLD) || 500 * 1024, // 500KB/页
  
  // 是否启用 native renderer
  NATIVE_RENDERER_ENABLED: process.env.NATIVE_RENDERER_ENABLED !== 'false',
};

// ==================== 并发控制配置 ====================
export const CONCURRENCY_CONFIG = {
  // 最大并发请求数 - 提高限制
  MAX_CONCURRENT_REQUESTS: parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 20,
  
  // 请求队列大小
  REQUEST_QUEUE_SIZE: parseInt(process.env.REQUEST_QUEUE_SIZE) || 100,
  
  // 单请求最大页数
  MAX_PAGES_PER_REQUEST: parseInt(process.env.MAX_PAGES_PER_REQUEST) || 50,
};

// ==================== 内存管理配置 ====================
export const MEMORY_CONFIG = {
  // GC 触发阈值（MB）
  GC_THRESHOLD_MB: parseInt(process.env.GC_THRESHOLD_MB) || 800,
  
  // 每多少页检查一次内存
  GC_CHECK_INTERVAL: parseInt(process.env.GC_CHECK_INTERVAL) || 3,
};

/**
 * 根据文件大小获取动态分片大小
 */
export function getDynamicChunkSize(fileSize) {
  if (fileSize < CHUNK_SIZE_CONFIG.SMALL_FILE_THRESHOLD) {
    return Math.max(CHUNK_SIZE_CONFIG.SMALL_FILE_CHUNK_SIZE, fileSize); // 小文件单片搞定，避免重复请求
  }
  if (fileSize < CHUNK_SIZE_CONFIG.MEDIUM_FILE_THRESHOLD) {
    return CHUNK_SIZE_CONFIG.MEDIUM_FILE_CHUNK_SIZE;
  }
  return CHUNK_SIZE_CONFIG.LARGE_FILE_CHUNK_SIZE;
}

/**
 * 根据文件大小和页数计算动态超时
 */
export function calculateDynamicTimeout(fileSizeMB, pageCount) {
  const { BASE_TIMEOUT, PER_PAGE_TIMEOUT, PER_MB_TIMEOUT, MAX_TIMEOUT } = TIMEOUT_CONFIG;
  
  const timeout = BASE_TIMEOUT + 
    (pageCount * PER_PAGE_TIMEOUT) + 
    (fileSizeMB * PER_MB_TIMEOUT);
  
  return Math.min(timeout, MAX_TIMEOUT);
}

/**
 * 根据页面尺寸获取渲染缩放比例
 * 支持多级降级：正常 -> 大页面 -> 超大页面
 */
export function getRenderScale(width, height) {
  const pixels = width * height;
  
  // 超大页面（如 3840x2160 = 8.3MP）使用最低缩放
  if (pixels > RENDER_CONFIG.XLARGE_PAGE_THRESHOLD) {
    return RENDER_CONFIG.XLARGE_PAGE_SCALE;
  }
  
  // 大页面使用中等缩放
  if (pixels > RENDER_CONFIG.LARGE_PAGE_THRESHOLD) {
    return RENDER_CONFIG.LARGE_PAGE_SCALE;
  }
  
  return RENDER_CONFIG.RENDER_SCALE;
}

/**
 * 打印当前配置（仅开发环境）
 */
export function printConfig() {
  if (!IS_DEV) return;
  
  logger.debug('=== PDF2IMG 配置 ===');
  logger.debug('分片配置:', CHUNK_SIZE_CONFIG);
  logger.debug('Range并发配置:', RANGE_CONFIG);
  logger.debug('超时配置:', TIMEOUT_CONFIG);
  logger.debug('重试配置:', RETRY_CONFIG);
  logger.debug('渲染配置:', RENDER_CONFIG);
  logger.debug('Native Renderer阈值:', `${RENDER_CONFIG.NATIVE_RENDERER_THRESHOLD / 1024 / 1024}MB`);
  logger.debug('并发配置:', CONCURRENCY_CONFIG);
  logger.debug('内存配置:', MEMORY_CONFIG);
  logger.debug('==================');
}
