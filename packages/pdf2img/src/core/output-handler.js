/**
 * 输出处理模块
 * 
 * 负责将渲染结果保存到文件或上传到 COS
 */

import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { createLogger } from '../utils/logger.js';
import { getExtension, getMimeType } from './config.js';

const logger = createLogger('OutputHandler');

/**
 * 默认并发限制
 */
export const DEFAULT_CONCURRENCY = {
    FILE_IO: 10,      // 文件写入并发数
    COS_UPLOAD: 4,    // COS 上传并发数（降低以减少 EPIPE 错误）
};

/**
 * 延迟函数
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 保存单个页面到文件
 */
async function savePageToFile(page, outputDir, prefix, ext) {
    if (!page.success || !page.buffer) {
        return { ...page, outputPath: null };
    }

    try {
        const filename = `${prefix}_${page.pageNum}.${ext}`;
        const outputPath = path.join(outputDir, filename);
        await fs.promises.writeFile(outputPath, page.buffer);

        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: true,
            outputPath,
            size: page.buffer.length,
        };
    } catch (err) {
        return {
            pageNum: page.pageNum,
            width: page.width,
            height: page.height,
            success: false,
            error: `File save failed: ${err.message}`,
            outputPath: null,
        };
    }
}

/**
 * 保存渲染结果到文件
 * 
 * @param {Array} pages - 渲染结果数组
 * @param {string} outputDir - 输出目录
 * @param {string} prefix - 文件名前缀
 * @param {string} format - 输出格式
 * @param {number} concurrency - 并发数
 * @returns {Promise<Array>} 保存结果
 */
export async function saveToFiles(pages, outputDir, prefix = 'page', format = 'webp', concurrency = DEFAULT_CONCURRENCY.FILE_IO) {
    await fs.promises.mkdir(outputDir, { recursive: true });

    const ext = getExtension(format);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
        pages.map(page => limit(() => savePageToFile(page, outputDir, prefix, ext)))
    );

    return results.sort((a, b) => a.pageNum - b.pageNum);
}

/**
 * 上传单个页面到 COS（带重试）
 */
async function uploadPageToCos(page, cos, cosConfig, keyPrefix, ext, mimeType, maxRetries = 3) {
    if (!page.success || !page.buffer) {
        return { ...page, cosKey: null };
    }

    const key = `${keyPrefix}/page_${page.pageNum}.${ext}`;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                cos.putObject({
                    Bucket: cosConfig.bucket,
                    Region: cosConfig.region,
                    Key: key,
                    Body: page.buffer,
                    ContentType: mimeType,
                }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            return {
                pageNum: page.pageNum,
                width: page.width,
                height: page.height,
                success: true,
                cosKey: key,
                size: page.buffer.length,
            };
        } catch (err) {
            lastError = err;
            const isRetryable = err.code === 'EPIPE' || 
                               err.code === 'ECONNRESET' || 
                               err.code === 'ETIMEDOUT' ||
                               err.code === 'ECONNREFUSED' ||
                               (err.statusCode && err.statusCode >= 500);
            
            if (isRetryable && attempt < maxRetries) {
                // 指数退避：1s, 2s, 4s...
                const delay = Math.pow(2, attempt - 1) * 1000;
                logger.debug(`Page ${page.pageNum} upload failed (${err.code || err.message}), retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await sleep(delay);
            } else if (!isRetryable) {
                break;
            }
        }
    }

    return {
        pageNum: page.pageNum,
        width: page.width,
        height: page.height,
        success: false,
        error: `Upload failed after ${maxRetries} attempts: ${lastError.message}`,
        cosKey: null,
    };
}

/**
 * 上传渲染结果到 COS
 * 
 * @param {Array} pages - 渲染结果数组
 * @param {Object} cosConfig - COS 配置
 * @param {string} keyPrefix - COS key 前缀
 * @param {string} format - 输出格式
 * @param {number} concurrency - 并发数
 * @returns {Promise<Array>} 上传结果
 */
export async function uploadToCos(pages, cosConfig, keyPrefix, format = 'webp', concurrency = DEFAULT_CONCURRENCY.COS_UPLOAD) {
    const COS = (await import('cos-nodejs-sdk-v5')).default;

    const cos = new COS({
        SecretId: cosConfig.secretId,
        SecretKey: cosConfig.secretKey,
        Protocol: cosConfig.protocol || 'https:',
        ServiceDomain: cosConfig.serviceDomain,
        Domain: cosConfig.domain,
    });

    const ext = getExtension(format);
    const mimeType = getMimeType(format);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
        pages.map(page => limit(() => uploadPageToCos(page, cos, cosConfig, keyPrefix, ext, mimeType)))
    );

    return results.sort((a, b) => a.pageNum - b.pageNum);
}
