// 测试环境全局设置
import { config } from 'dotenv';

// 加载环境变量
config({ path: '.env.test' });

// 设置测试环境变量
process.env.NODE_ENV = 'test';

// 全局测试超时设置
jest.setTimeout(30000);

// 全局测试钩子
beforeAll(() => {
  console.log('测试环境初始化完成');
});

afterAll(() => {
  console.log('所有测试执行完成');
});

// 全局模拟console方法，避免测试输出干扰
const originalConsole = { ...console };

beforeEach(() => {
  // 可以在这里模拟console方法
  // console.log = jest.fn();
  // console.error = jest.fn();
});

afterEach(() => {
  // 恢复原始console方法
  // console.log = originalConsole.log;
  // console.error = originalConsole.error;
});