import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * 环境变量生成
 */
class EnvBuilder {
  static extraEnv = {};

  static getExtraEnvStr() {
    return Object.keys(this.extraEnv).map((key) => `${key}=${this.extraEnv[key]}`).join(' ');
  }
  /**
   * 注入服务启动所需的额外环境变量
   */
  static injectExtraEnv() {
    this.injectCosSsm();
    this.appendSsmEnv();
  }

  /**
   * 注入 cos ssm 密钥托管文件
   */
  static injectCosSsm() {
    const moveFileCommand = `
  PROFILE_FILE="./ssm/profile.json"
  WHITEBOX_FILE="./ssm/whitebox.txt"
  # 拷贝AKSK依赖文件
  if [ -f "$PROFILE_FILE" ] && [ -f "$WHITEBOX_FILE" ]; then
    mkdir -p /usr/local/aksk
    chmod o+w /usr/local/aksk
    base64 -d "$WHITEBOX_FILE" > /usr/local/aksk/whitebox.bin
    cp -f "$PROFILE_FILE" /usr/local/aksk/profile.json
    echo "[INFO] copy whitebox.bin and profile.json to /usr/local/aksk"
  fi
  `;
    try {
      execSync(moveFileCommand);
      console.log('[run-pm2] [injectCosSsmSuccess]');
    } catch (err) {
      console.error(`[run-pm2] [injectCosSsmError] ${err.message}`);
    }
  }

  /**
   * 添加 ssm 相关的环境变量
   */
  static appendSsmEnv() {
    // 获取 cos 的环境变量
    const cosEnvFile = './ssm/env.json';
    try {
      const data = readFileSync(cosEnvFile, 'utf8');
      // 解析 JSON 数据
      const json = JSON.parse(data);
      this.extraEnv = { ...this.extraEnv, ...json };
    } catch (err) {
      if (err) {
        console.error(`[run-pm2] 读取文件时出错: ${err}`);
        return;
      }
    };
  }
}

const baseCommand = [
  'pm2 delete all || true',
  'pm2 set pm2-logrotate:max_size 100M',
  'pm2 set pm2-logrotate:retain 5',
  'pm2 set pm2-logrotate:compress true',
  'pm2 set pm2-logrotate:workerInterval 120',
  'pm2 set pm2-logrotate:rotateInterval 0 0 * * *',
  'pm2 set pm2-logrotate:TZ Asia/Shanghai',
].join(' && ');

// 注入额外环境变量
EnvBuilder.injectExtraEnv();
// 获取环境变量字符串
const extraEnvStr = EnvBuilder.getExtraEnvStr();

const localCommand = `${baseCommand} && ${extraEnvStr} pm2 start app.js`;
const dockerCommand = `${baseCommand} && ${extraEnvStr} pm2-runtime start app.js`;

const command = process.env.NODE_ENV ? localCommand : dockerCommand;
console.log('[run-pm2] exec command:', command);

const child = spawn(command, {
  shell: true, // 需要在 shell 中执行命令
  env: process.env,
  stdio: 'inherit' // 直接继承父进程的 stdio
});

child.on('error', (error) => {
  console.error(`[run-pm2] Error executing command: ${error.message}`);
});

child.on('exit', (code, signal) => {
  if (code !== null) {
    console.log(`[run-pm2] Process exited with code ${code}`);
  } else {
    console.log(`[run-pm2] Process killed with signal ${signal}`);
  }
});