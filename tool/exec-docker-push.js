import { spawn, exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTag() {
    const date = new Date(Date.now());
    // 提取时间组件
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // 月份从0开始需+1
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}`;
}

const tag = getTag();
console.log('tag', tag);
const shellPath = path.resolve(__dirname, './docker-auto.sh');
const command = `${shellPath} ${tag}`;
exec(`chmod +x ${shellPath}`, (error, stdout, stderr) => {
    if (error) {
        console.error(`Error executing chmod: ${error.message}`);
        return;
    }
    console.log(stdout);
})

const child = spawn(command, {
    shell: true, // 需要在 shell 中执行命令
    env: process.env,
    stdio: 'inherit' // 直接继承父进程的 stdio
});

child.on('error', (error) => {
    console.error(`[docker-auto-push] Error executing command: ${error.message}`);
});

child.on('exit', (code, signal) => {
    if (code !== null) {
        console.log(`[docker-auto-push] Process exited with code ${code}`);
    } else {
        console.log(`[docker-auto-push] Process killed with signal ${signal}`);
    }
});