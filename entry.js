import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import os from 'os';

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

// 获取 CPU 核心数，用于 cluster 模式
const cpuCount = os.cpus().length;
console.log(`[run-pm2] 检测到 ${cpuCount} 个 CPU 核心`);

// 日志保留配置说明：
// - retain: 每个日志文件保留的轮转版本数量
// - rotateInterval: 每天凌晨执行轮转
// - 结合 retain 7 + 每天轮转 = 约保留 7 天日志
const LOG_RETAIN_COUNT = 7;  // 保留最近7个轮转版本（配合每天轮转，约等于7天日志）

const baseCommand = [
  'pm2 delete all || true',
  'pm2 set pm2-logrotate:max_size 200M',
  `pm2 set pm2-logrotate:retain ${LOG_RETAIN_COUNT}`,     // 每个日志文件保留的轮转版本数
  'pm2 set pm2-logrotate:compress true',
  'pm2 set pm2-logrotate:workerInterval 120',
  'pm2 set pm2-logrotate:dateFormat YYYY-MM-DD',
  'pm2 set pm2-logrotate:rotateInterval 0 0 * * *',       // 每天凌晨轮转
  'pm2 set pm2-logrotate:TZ Asia/Shanghai',
].join(' && ');

// 注入额外环境变量
EnvBuilder.injectExtraEnv();
// 获取环境变量字符串
const extraEnvStr = EnvBuilder.getExtraEnvStr();

// PM2 Cluster 模式配置
// 注意：使用 -i <instances> 参数时，PM2 会自动启用 cluster 模式
// 某些高级配置（如 merge_logs, listen_timeout, kill_timeout）需要通过配置文件设置，命令行不支持
const name = `--name "prod-pdf2img-server"`;             // 进程命名
const instances = `-i max`;                              // cluster 模式：使用所有 CPU 核心（也可指定数字如 -i 4）
const memmory = `--max-memory-restart 1G`;               // 内存超1GB自动重启
const cron = `--cron "0 4 * * *"`;                       // 每日UTC 04:00定时重启
const outLog = `-o /usr/src/app/pm2/logs/pdf2img.log`;  // 标准输出日志
const errLog = `-e /usr/src/app/pm2/logs/pdf2img.log`;  // 错误输出日志

// 组合稳定运行参数（cluster 模式）
const stableStr = `${name} ${instances} ${memmory} ${cron} ${outLog} ${errLog}`;

const localCommand = `${baseCommand} && ${extraEnvStr} pm2 start app.js ${stableStr}`;
const dockerCommand = `${baseCommand} && ${extraEnvStr} pm2-runtime start app.js ${stableStr}`;

const command = process.env.NODE_ENV ? localCommand : dockerCommand;
console.log('[run-pm2] 启动模式: PM2 Cluster');
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