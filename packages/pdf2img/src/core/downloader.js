/**
 * 远程文件下载模块
 * 
 * 提供流式下载和文件大小获取功能
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { createLogger } from '../utils/logger.js';
import { TIMEOUT_CONFIG } from './config.js';

const logger = createLogger('Downloader');

/**
 * 延迟函数
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从 URL 获取文件大小
 * 
 * @param {string} url - 远程文件 URL
 * @returns {Promise<number>} 文件大小（字节）
 */
export async function getRemoteFileSize(url) {
    const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(TIMEOUT_CONFIG.DOWNLOAD_TIMEOUT),
    });

    if (!response.ok) {
        throw new Error(`Failed to get file size: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
        throw new Error('Server did not return Content-Length header');
    }

    return parseInt(contentLength, 10);
}

/**
 * 流式下载远程文件到临时文件（带重试）
 * 
 * @param {string} url - 远程文件 URL
 * @param {number} maxRetries - 最大重试次数
 * @returns {Promise<string>} 临时文件路径
 */
export async function downloadToTempFile(url, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const tempFile = path.join(os.tmpdir(), `pdf2img_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
        
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(TIMEOUT_CONFIG.DOWNLOAD_TIMEOUT),
            });

            if (!response.ok) {
                throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
            }

            const fileStream = fs.createWriteStream(tempFile);
            await pipeline(response.body, fileStream);
            return tempFile;
        } catch (err) {
            lastError = err;
            
            // 清理临时文件
            try {
                await fs.promises.unlink(tempFile);
            } catch {}

            const isRetryable = err.code === 'EPIPE' || 
                               err.code === 'ECONNRESET' || 
                               err.code === 'ETIMEDOUT' ||
                               err.code === 'ECONNREFUSED' ||
                               err.code === 'UND_ERR_SOCKET' ||
                               err.name === 'AbortError';
            
            if (isRetryable && attempt < maxRetries) {
                const delay = Math.pow(2, attempt - 1) * 1000;
                logger.debug(`Download failed (${err.code || err.message}), retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await sleep(delay);
            } else if (!isRetryable) {
                break;
            }
        }
    }

    throw new Error(`Download failed after ${maxRetries} attempts: ${lastError.message}`);
}
