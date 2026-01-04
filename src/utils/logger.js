/**
 * 统一日志模块
 * 
 * 环境策略：
 * - IS_DEV (本地开发)：输出所有日志 (debug/info/warn/error/prod)
 * - IS_TEST (测试环境)：输出关键日志 (info/warn/error/prod) + 性能数据
 * - 正式环境：输出 prod/error 级别（基础请求信息 + 错误）
 * 
 * 日志级别：
 * - debug: 调试信息（仅开发环境）
 * - info: 详细流程信息（开发+测试环境）
 * - perf: 性能数据（开发+测试环境，用于上报）
 * - warn: 警告信息（开发+测试环境）
 * - prod: 生产环境基础信息（所有环境）- 请求收到/成功/失败/耗时
 * - error: 错误信息（所有环境）
 * 
 * 使用方式：
 * import { logger, createLogger } from '../utils/logger.js';
 * 
 * // 全局 logger
 * logger.info('详细流程信息');
 * logger.prod('请求完成', { duration: 1500, pages: 5, success: true });
 * 
 * // 带前缀的 logger
 * const log = createLogger('Router');
 * log.prod('请求开始', { globalPadId: 'xxx' });
 */

// 环境判断
const IS_DEV = process.env.NODE_ENV === 'dev';
const IS_TEST = process.env.NODE_ENV === 'test';
const IS_PROD = !IS_DEV && !IS_TEST;

// 日志级别定义
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    perf: 1,  // perf 与 info 同级，但语义不同
    warn: 2,
    prod: 3,  // 生产环境基础信息，所有环境都输出
    error: 4,
};

// 根据环境确定最低日志级别
function getMinLogLevel() {
    if (IS_DEV) return LOG_LEVELS.debug;   // 开发环境：输出所有
    if (IS_TEST) return LOG_LEVELS.debug;  // 测试环境：也输出 debug
    return LOG_LEVELS.prod;                // 正式环境：输出 prod + error
}

const MIN_LOG_LEVEL = getMinLogLevel();

// 环境标识（可用于日志前缀，当前未使用）
// const ENV_TAG = IS_DEV ? '[DEV]' : IS_TEST ? '[TEST]' : '[PROD]';

/**
 * 格式化时间戳
 */
function formatTimestamp() {
    return new Date().toISOString();
}

/**
 * 格式化日志数据
 */
function formatData(data) {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

/**
 * 核心日志输出函数
 */
function logOutput(level, prefix, message, data) {
    // 级别过滤
    if (LOG_LEVELS[level] < MIN_LOG_LEVEL) return;
    
    const timestamp = formatTimestamp();
    const levelTag = `[${level.toUpperCase()}]`;
    const prefixTag = prefix ? `[${prefix}]` : '';
    const dataStr = formatData(data);
    
    const logLine = dataStr 
        ? `${timestamp} ${levelTag}${prefixTag} ${message} ${dataStr}`
        : `${timestamp} ${levelTag}${prefixTag} ${message}`;
    
    switch (level) {
        case 'debug':
            console.debug(logLine);
            break;
        case 'info':
        case 'perf':
        case 'prod':
            console.log(logLine);
            break;
        case 'warn':
            console.warn(logLine);
            break;
        case 'error':
            console.error(logLine);
            break;
    }
}

/**
 * 创建带前缀的 Logger 实例
 * 
 * @param {string} prefix - 日志前缀（如 'Worker', 'COS', 'Router'）
 * @returns {Object} Logger 实例
 */
function createLogger(prefix = '') {
    return {
        /**
         * 调试日志（仅开发环境）
         */
        debug(message, data) {
            logOutput('debug', prefix, message, data);
        },
        
        /**
         * 信息日志（开发+测试环境）
         */
        info(message, data) {
            logOutput('info', prefix, message, data);
        },
        
        /**
         * 性能数据日志（开发+测试环境，用于上报）
         * 
         * @param {string} action - 操作名称
         * @param {Object} metrics - 性能指标
         */
        perf(action, metrics) {
            logOutput('perf', prefix, `[PERF] ${action}`, metrics);
        },
        
        /**
         * 警告日志（开发+测试环境）
         */
        warn(message, data) {
            logOutput('warn', prefix, message, data);
        },
        
        /**
         * 生产环境基础日志（所有环境）
         * 用于记录请求收到、成功/失败、耗时等必要信息
         * 
         * @param {string} message - 日志消息
         * @param {Object} data - 附加数据
         */
        prod(message, data) {
            logOutput('prod', prefix, message, data);
        },
        
        /**
         * 错误日志（所有环境）
         */
        error(message, data) {
            logOutput('error', prefix, message, data);
        },
        
        /**
         * 判断当前环境是否输出指定级别日志
         */
        isEnabled(level) {
            return LOG_LEVELS[level] >= MIN_LOG_LEVEL;
        },
    };
}

// 全局 logger 实例
const logger = createLogger();

// 导出环境变量供其他模块使用
export {
    logger,
    createLogger,
    IS_DEV,
    IS_TEST,
    IS_PROD,
    LOG_LEVELS,
    MIN_LOG_LEVEL,
};
