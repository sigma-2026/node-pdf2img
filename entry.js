import { spawn, execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// PM2 命令路径（使用 npx 确保在 Docker 中也能找到）
const pm2Bin = 'npx pm2';
const pm2RuntimeBin = 'npx pm2-runtime';

const baseCommand = [
  `${pm2Bin} delete all || true`,
  `${pm2Bin} set pm2-logrotate:max_size 200M`,
  `${pm2Bin} set pm2-logrotate:retain ${LOG_RETAIN_COUNT}`,     // 每个日志文件保留的轮转版本数
  `${pm2Bin} set pm2-logrotate:compress true`,
  `${pm2Bin} set pm2-logrotate:workerInterval 120`,
  `${pm2Bin} set pm2-logrotate:dateFormat YYYY-MM-DD`,
  `${pm2Bin} set pm2-logrotate:rotateInterval 0 0 * * *`,       // 每天凌晨轮转
  `${pm2Bin} set pm2-logrotate:TZ Asia/Shanghai`,
].join(' && ');

// 注入额外环境变量
EnvBuilder.injectExtraEnv();
// 获取环境变量字符串
const extraEnvStr = EnvBuilder.getExtraEnvStr();

// 设置 native-renderer 的动态库路径（libpdfium.so）
const nativeRendererPath = path.join(__dirname, 'native-renderer');
const ldLibraryPath = process.env.LD_LIBRARY_PATH 
  ? `${nativeRendererPath}:${process.env.LD_LIBRARY_PATH}`
  : nativeRendererPath;
const ldLibraryPathEnv = `LD_LIBRARY_PATH=${ldLibraryPath}`;

// PM2 Cluster 模式配置
// 注意：使用 -i <instances> 参数时，PM2 会自动启用 cluster 模式
// 某些高级配置（如 merge_logs, listen_timeout, kill_timeout）需要通过配置文件设置，命令行不支持
const name = `--name "prod-pdf2img-server"`;             // 进程命名
const instances = `-i 3`;                  // cluster 模式：使用3个实例
const memmory = `--max-memory-restart 1G`;               // 内存超1GB自动重启
// 移除定时重启：在 K8s 环境中，由 K8s 管理 Pod 重启策略，避免所有 Pod 同时重启
// const cron = `--cron "0 4 * * *"`;                    // 已移除：防止 120 个 Pod 同时重启
const outLog = `--output /usr/src/app/pm2/logs/pdf2img.log`;  // 标准输出日志
const errLog = `--error /usr/src/app/pm2/logs/pdf2img.log`;  // 错误输出日志

// 组合稳定运行参数（cluster 模式）
const stableStr = `${name} ${instances} ${memmory} ${outLog} ${errLog}`;

// 注意：LD_LIBRARY_PATH 需要在命令前设置，确保 native-renderer 能找到 libpdfium.so
const localCommand = `${baseCommand} && ${ldLibraryPathEnv} ${extraEnvStr} ${pm2Bin} start app.js ${stableStr}`;
const dockerCommand = `${baseCommand} && ${ldLibraryPathEnv} ${extraEnvStr} ${pm2RuntimeBin} start app.js ${stableStr}`;

// 检测是否在 Docker/容器环境中运行
// 方法：检查 /.dockerenv 文件或 /proc/1/cgroup 包含 docker/kubepods
function isRunningInDocker() {
  try {
    // 方法1：检查 /.dockerenv 文件
    if (existsSync('/.dockerenv')) return true;
    // 方法2：检查 cgroup（适用于 K8s）
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('kubepods')) return true;
  } catch {
    // 忽略错误
  }
  return false;
}

const isDocker = isRunningInDocker();
const command = isDocker ? dockerCommand : localCommand;
console.log(`[run-pm2] 运行环境: ${isDocker ? 'Docker/K8s' : '本地'}`);
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