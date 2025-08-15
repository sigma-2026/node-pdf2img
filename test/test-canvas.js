import fs from 'fs';
import { createCanvas } from 'canvas';

/**
 * 此脚本仅用于测试 Canvas 基础功能完整性
 */
async function testCanvas(outputDir = './output') {
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 200, 200);
    // 若无报错，说明 Canvas 基础功能正常
    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    // const base64 = canvas.toDataURL();
    // console.log(`base64: ${base64}`);
    // 保存为 PNG 文件
    const outputPath = `${outputDir}/test.png`;
    const buffer = canvas.toBuffer('image/png', {
        compressionLevel: 6,
        filters: canvas.PNG_FILTER_NONE
    });
    console.log(`buffer: ${buffer.length}`);
    fs.writeFileSync(outputPath, buffer);
}

export {
    testCanvas
}