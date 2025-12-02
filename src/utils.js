/**
 * 解析JSON参数
 * @param {string|Object} param - 要解析的参数
 * @returns {any} 解析后的值
 */
export function parseJsonParam(param) {
    if (param === 'all') {
        return 'all';
    }

    if (typeof param === 'string') {
        try {
            return JSON.parse(param);
        } catch (e) {
            return param; // 如果解析失败，返回原字符串
        }
    }
    return param;
}

/**
 * 验证URL格式
 * @param {string} url - 要验证的URL
 * @returns {boolean} 是否为有效的URL
 */
export function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

// 导出默认对象
export default { parseJsonParam, isValidUrl };