import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nativeRenderer = await import(path.join(__dirname, '../native-renderer/index.js'));

console.log('Testing with real PDF...');

// 使用本地 PDF 文件
const pdfPath = path.join(__dirname, '../static/股权转让协议书 (2).pdf');
const pdfBuffer = fs.readFileSync(pdfPath);
const pdfSize = pdfBuffer.length;

console.log('PDF size:', pdfSize);

// 模拟 fetcher - 从本地文件读取
const fetcher = (_unused, offset, size, requestId) => {
  console.log('Fetcher:', offset, size, requestId);
  
  setTimeout(() => {
    const buffer = pdfBuffer.slice(offset, offset + size);
    nativeRenderer.completeStreamRequest(requestId, buffer, null);
    console.log('Data sent:', requestId, buffer.length);
  }, 10);
};

try {
  const result = await nativeRenderer.renderPagesFromStream(pdfSize, [1], null, fetcher);
  console.log('Result:', result.success, result.numPages, result.error);
  if (result.pages && result.pages.length > 0) {
    console.log('First page:', result.pages[0].width, 'x', result.pages[0].height);
  }
  console.log('Stream stats:', result.streamStats);
} catch (e) {
  console.error('Error:', e.message);
}
