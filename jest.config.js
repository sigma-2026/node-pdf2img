export default {
  // 测试环境
  testEnvironment: 'node',
  
  // 模块名称映射
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  
  // 转换配置 - 使用Babel支持ES模块
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  
  // 忽略转换的路径 - 允许转换node_modules中的ES模块
  transformIgnorePatterns: [
    'node_modules/(?!(node-fetch|data-uri-to-buffer|fetch-blob|formdata-polyfill)/)',
  ],
  
  // 测试文件匹配模式
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.spec.js',
  ],
  
  // 测试超时时间
  testTimeout: 30000,
  
  // 全局设置
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
};