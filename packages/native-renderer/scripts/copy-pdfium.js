#!/usr/bin/env node
/**
 * 构建后自动复制 PDFium 库到项目根目录
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');

// 平台对应的库文件名
const libNames = {
  linux: 'libpdfium.so',
  darwin: 'libpdfium.dylib',
  win32: 'pdfium.dll',
};

const libName = libNames[process.platform];
if (!libName) {
  console.log('Unknown platform:', process.platform);
  process.exit(0);
}

const destPath = path.join(projectRoot, libName);

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

const sourcePath = findFile(targetDir, libName);
if (sourcePath) {
  fs.copyFileSync(sourcePath, destPath);
  console.log(`Copied PDFium library: ${sourcePath} -> ${destPath}`);
} else {
  console.log(`PDFium library not found in build directory`);
}
