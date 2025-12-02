import { getCosInstance } from './cos.js';

const cosConfig = {
    Bucket: process.env.COS_BUCKET || 'tencent-docs-1251316161',
    Region: process.env.COS_REGION || 'ap-guangzhou',
    path: process.env.COS_PATH || 'pdf2img',
};

/**
 * 批量上传文件到 cos
 */
export const uploadFiles = async ({ globalPadId, bufferArr }) => {
    try {
        const cos = await getCosInstance();
        const filePrefix = `${cosConfig.path}/${globalPadId}`;
        const response = await cos.uploadFiles({
            files: bufferArr.map((one) => {
                const { buffer, pageNum } = one;
                return {
                    Region: cosConfig.Region,
                    Bucket: cosConfig.Bucket,
                    Key: `${filePrefix}_${pageNum}.webp`,
                    Body: buffer,
                    ContentType: 'image/webp',
                }
            }),
        });
        const error = response.files.find(file => !!file.error);
        if (error) {
            console.error('[uploadFiles] exist anyone fail', error);
            throw error;
        }
        console.info('[uploadFiles] success');
        return response;
    } catch (err) {
        console.error('[uploadFiles] error', err);
        return undefined;
    }
};