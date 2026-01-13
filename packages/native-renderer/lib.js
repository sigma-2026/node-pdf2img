/**
 * PDF Renderer 包装模块
 * 
 * 在加载原生模块之前设置 PDFIUM_MODULE_DIR 环境变量，
 * 确保 Rust 代码能找到正确架构的 PDFium 动态库。
 */

const path = require('path');

// 设置模块目录环境变量，供 Rust 代码使用
process.env.PDFIUM_MODULE_DIR = __dirname;

// 加载原生模块
module.exports = require('./index.js');
