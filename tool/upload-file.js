import { getCosInstance } from './cos.js';

const cosConfig = {
    Bucket: 'tencent-docs-1251316161',
    Region: 'ap-guangzhou',
    path: 'pdf2img',
};

/**
 * 批量上传文件到 cos
 */
export const uploadFiles = async ({ globalPadId, bufferArr }) => {
    console.log('uploadFiles', globalPadId);
    // console.log('bufferArr', bufferArr);
    const cos = await getCosInstance();
    const filePrefix = `${cosConfig.path}/${globalPadId}`;
    console.log('filePrefix', filePrefix);
    try {
        const response = await cos.uploadFiles({
            files: bufferArr.map((one) => {
                // console.log('one', one);
                const { buffer, pageNum } = one;
                // console.log('buffer', buffer);
                // console.log('pageNum', pageNum);
                return {
                    Region: cosConfig.Region,
                    Bucket: cosConfig.Bucket,
                    Key: `${filePrefix}_${pageNum}.png`,
                    Body: buffer,
                    ContentType: 'image/png',
                }
            }),
        });
        const error = response.files.find(file => !!file.error);
        if (error) {
            console.error?.('[uploadSvgFileTask] exist anyone fail', error);
            throw error;
        }
        console.info?.('[uploadSvgFileTask] success');
        return response;
    } catch (err) {
        console.error?.('[uploadSvgFileTask] error', err);
        return undefined;
    }
};