import COS from 'cos-nodejs-sdk-v5';

/**
 * 获取 cos 实例
 */
export const getCosInstance = async () => {
    // 子账号和tag的信息
    const tagName = process.env.COS_SECRET_TAG;
    console.log('tagName', tagName);
    try {
        const { rotated_credential: rotatedCredential } = await import('@tencent/ssm-sdk-nodejs');
        const profile = await rotatedCredential.LoadAccessKeyProfile();
        const cred = await profile.GetCredential(tagName);
        return new COS({ Credentials: cred });
    } catch (error) {
        console.error('getCosInstance error', error);
        return null;
    }
};
