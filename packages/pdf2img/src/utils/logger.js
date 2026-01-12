/**
 * 简化日志模块
 */

const IS_DEBUG = process.env.DEBUG === 'true' || process.env.PDF2IMG_DEBUG === 'true';

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

/**
 * 创建日志实例
 * @param {string} module - 模块名称
 */
export function createLogger(module) {
    const prefix = `[${module}]`;

    return {
        info: (msg, data) => {
            if (IS_DEBUG) {
                const dataStr = data ? ` ${JSON.stringify(data)}` : '';
                console.log(`${colors.green}${prefix}${colors.reset} ${msg}${dataStr}`);
            }
        },

        warn: (msg, data) => {
            const dataStr = data ? ` ${JSON.stringify(data)}` : '';
            console.warn(`${colors.yellow}${prefix}${colors.reset} ${msg}${dataStr}`);
        },

        error: (msg, data) => {
            const dataStr = data ? ` ${JSON.stringify(data)}` : '';
            console.error(`${colors.red}${prefix}${colors.reset} ${msg}${dataStr}`);
        },

        debug: (msg, data) => {
            if (IS_DEBUG) {
                const dataStr = data ? ` ${JSON.stringify(data)}` : '';
                console.log(`${colors.dim}${prefix}${colors.reset} ${msg}${dataStr}`);
            }
        },

        perf: (msg, data) => {
            if (IS_DEBUG) {
                const dataStr = data ? ` ${JSON.stringify(data)}` : '';
                console.log(`${colors.cyan}${prefix}${colors.reset} ${msg}${dataStr}`);
            }
        },
    };
}

export const IS_DEV = process.env.NODE_ENV !== 'production';
export const IS_TEST = process.env.NODE_ENV === 'test';
