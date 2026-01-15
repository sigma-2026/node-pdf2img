/**
 * PDF2IMG CLI 测试
 *
 * 运行方式：
 *   node --test test/cli.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
const CLI_PATH = path.join(__dirname, '../bin/cli.js');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const OUTPUT_DIR = path.join(__dirname, '../output-cli');

// 测试用 PDF 文件
const TEST_PDF = path.join(STATIC_DIR, '1M.pdf');

/**
 * 执行 CLI 命令
 */
function runCli(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [CLI_PATH, ...args], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, NO_COLOR: '1' },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });

        proc.on('error', reject);
    });
}

describe('PDF2IMG CLI 测试', () => {
    before(() => {
        // 确保输出目录存在
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
    });

    after(() => {
        // 清理输出目录
        if (fs.existsSync(OUTPUT_DIR)) {
            const files = fs.readdirSync(OUTPUT_DIR);
            for (const file of files) {
                fs.unlinkSync(path.join(OUTPUT_DIR, file));
            }
            fs.rmdirSync(OUTPUT_DIR);
        }
    });

    describe('帮助和版本', () => {
        it('--help 应该显示帮助信息', async () => {
            const { code, stdout } = await runCli(['--help']);
            assert.strictEqual(code, 0, '退出码应该是 0');
            assert.ok(stdout.includes('pdf2img'), '应该包含命令名');
            assert.ok(stdout.includes('-o, --output'), '应该包含输出选项');
        });

        it('--version 应该显示版本号', async () => {
            const { code, stdout } = await runCli(['--version']);
            assert.strictEqual(code, 0, '退出码应该是 0');
            assert.ok(/\d+\.\d+\.\d+/.test(stdout), '应该包含版本号');
        });

        it('--version-info 应该显示渲染器信息', async () => {
            const { code, stdout } = await runCli(['--version-info']);
            assert.strictEqual(code, 0, '退出码应该是 0');
            assert.ok(stdout.includes('pdf2img'), '应该包含包名');
            assert.ok(stdout.includes('PDFium') || stdout.includes('PDF.js'), '应该包含渲染器信息');
        });
    });

    describe('PDF 信息', () => {
        it('--info 应该显示 PDF 信息', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const { code, stdout } = await runCli([TEST_PDF, '--info']);
            assert.strictEqual(code, 0, '退出码应该是 0');
            assert.ok(stdout.includes('页数') || stdout.includes('Pages'), '应该包含页数信息');
        });
    });

    describe('PDF 转换', () => {
        it('应该成功转换 PDF 到输出目录', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            // 只转换第一页以加快测试速度
            const { code, stdout } = await runCli([TEST_PDF, '-o', OUTPUT_DIR, '-p', '1']);
            assert.strictEqual(code, 0, '退出码应该是 0');
            // ora spinner 在非 TTY 环境下输出可能不完整，检查输出目录信息
            assert.ok(stdout.includes('输出目录') || stdout.includes('output'), '应该显示输出目录');

            // 检查输出文件
            const files = fs.readdirSync(OUTPUT_DIR);
            assert.ok(files.some(f => f.endsWith('.webp')), '应该生成 WebP 文件');
        });

        it('应该支持自定义前缀', async () => {
            if (!fs.existsSync(TEST_PDF)) {
                console.log(`跳过测试：测试文件不存在 ${TEST_PDF}`);
                return;
            }

            const { code } = await runCli([TEST_PDF, '-o', OUTPUT_DIR, '--prefix', 'custom']);
            assert.strictEqual(code, 0, '退出码应该是 0');

            const files = fs.readdirSync(OUTPUT_DIR);
            assert.ok(files.some(f => f.startsWith('custom_')), '应该使用自定义前缀');
        });
    });

    describe('错误处理', () => {
        it('文件不存在时应该报错', async () => {
            const { code, stderr } = await runCli(['/nonexistent/file.pdf', '-o', OUTPUT_DIR]);
            assert.notStrictEqual(code, 0, '退出码不应该是 0');
            assert.ok(stderr.includes('错误') || stderr.includes('Error'), '应该显示错误信息');
        });

        it('缺少输入参数时应该报错', async () => {
            const { code, stderr } = await runCli([]);
            assert.notStrictEqual(code, 0, '退出码不应该是 0');
        });
    });
});
