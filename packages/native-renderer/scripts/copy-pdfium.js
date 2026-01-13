#!/usr/bin/env node
/**
 * 构建后自动复制 PDFium 库到项目根目录
 * 
 * 使用带平台和架构后缀的文件名，避免不同架构的库互相覆盖：
 * - libpdfium-linux-x64.so
 * - libpdfium-linux-arm64.so
 * - libpdfium-darwin-x64.dylib
 * - libpdfium-darwin-arm64.dylib
 * - pdfium-win32-x64.dll
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

// 获取平台和架构
const platform = process.platform;
const arch = process.arch;

// 原始库文件名（构建产物中的名称）
const sourceLibNames = {
  linux: 'libpdfium.so',
  darwin: 'libpdfium.dylib',
  win32: 'pdfium.dll',
};

// 目标库文件名（带平台和架构后缀）
function getDestLibName() {
  const archName = arch === 'arm64' ? 'arm64' : 'x64';
  switch (platform) {
    case 'linux':
      return `libpdfium-linux-${archName}.so`;
    case 'darwin':
      return `libpdfium-darwin-${archName}.dylib`;
    case 'win32':
      return `pdfium-win32-${archName}.dll`;
    default:
      return null;
  }
}

const sourceLibName = sourceLibNames[platform];
const destLibName = getDestLibName();

if (!sourceLibName || !destLibName) {
  console.log('Unknown platform:', platform);
  process.exit(0);
}

const destPath = path.join(projectRoot, destLibName);

// 如果目标已存在，跳过
if (fs.existsSync(destPath)) {
  console.log(`PDFium library already exists: ${destPath}`);
  process.exit(0);
}

// 在 target 目录中查找
const targetDir = path.join(projectRoot, 'target', 'release', 'build');
if (!fs.existsSync(targetDir)) {
  console.log('Build directory not found, PDFium may not have been downloaded');
  process.exit(0);
}

// 递归查找 libpdfium
function findFile(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

const sourcePath = findFile(targetDir, sourceLibName);
if (sourcePath) {
  fs.copyFileSync(sourcePath, destPath);
  console.log(`Copied PDFium library: ${sourcePath} -> ${destPath}`);
  console.log(`Platform: ${platform}, Arch: ${arch}`);
} else {
  console.log(`PDFium library not found in build directory`);
}
