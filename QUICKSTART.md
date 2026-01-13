# 🚀 快速启动 GitHub Actions 构建

## 立即触发构建

### 方法 1：推送代码触发（已自动触发）

刚刚推送的代码会自动触发 GitHub Actions 构建。

**查看构建状态：**

访问 https://github.com/sigma-2026/node-pdf2img/actions

### 方法 2：手动触发（推荐）

如果自动构建未触发或你想手动控制：

1. **访问 Actions 页面**
   ```
   https://github.com/sigma-2026/node-pdf2img/actions
   ```

2. **点击 "Run workflow"**
   - 在左侧选择 "Build and Release"
   - 点击右上角的 "Run workflow" 按钮
   - Branch: `beta/cli_20260112`
   - 勾选 "Publish to npm"
   - 点击 "Run workflow"

3. **查看实时日志**
   - 点击正在运行的工作流
   - 查看每个平台的构建日志
   - 构建时间：约 10-15 分钟

## 配置 NPM_TOKEN（仅第一次需要）

### 步骤 1：创建 npm Token

```bash
# 登录 npm 账户
npm login

# 或者访问 https://www.npmjs.com/settings/sigma-2026/tokens
# 创建 "Automation" token
```

### 步骤 2：添加到 GitHub Secrets

1. 访问 https://github.com/sigma-2026/node-pdf2img/settings/secrets/actions
2. 点击 "New repository secret"
3. 填写：
   - **Name**: `NPM_TOKEN`
   - **Value**: 粘贴你的 npm token
4. 点击 "Add secret"

## 预期结果

### 构建成功后，你会看到：

✅ **5 个平台构建完成**
- Linux x64 (pdf-renderer.linux-x64-gnu.node + libpdfium.so)
- Linux arm64 (pdf-renderer.linux-arm64-gnu.node)
- macOS x64 (pdf-renderer.darwin-x64.node + libpdfium.dylib)
- macOS arm64 (pdf-renderer.darwin-arm64.node)
- Windows x64 (pdf-renderer.win32-x64-msvc.node + pdfium.dll)

✅ **npm 发布成功**
```
npm view node-pdf2img version
# 输出: 0.1.0 或更高版本
```

✅ **可以使用**
```bash
npm install -g node-pdf2img
pdf2img document.pdf -o ./output
```

## 查看日志

如果构建失败，查看日志：

1. 访问 Actions 页面
2. 点击失败的工作流
3. 点击失败的任务（如 "build-native-linux-x64"）
4. 查看步骤日志，找出错误原因

## 常见错误

### ❌ 错误："No such file or directory: scripts/copy-pdfium.js"

**解决**: 文件已存在，应该是路径问题，查看完整日志。

### ❌ 错误："NPM_TOKEN not found"

**解决**: 按照上面的步骤配置 NPM_TOKEN。

### ❌ 错误："npm publish failed"

**可能原因**:
- 包名 `node-pdf2img` 已被占用
- npm token 权限不足
- 版本号已存在

**解决**: 
- 检查 https://www.npmjs.com/package/node-pdf2img
- 如果已被占用，修改 `packages/pdf2img/package.json` 中的 `name` 字段

## 需要帮助？

查看完整文档：
- [TRIGGER_BUILD.md](./TRIGGER_BUILD.md) - 详细构建指南
- [PUSH_TO_GITHUB.md](./PUSH_TO_GITHUB.md) - GitHub 配置指南

## 下一步

1. ✅ 配置 NPM_TOKEN（必需）
2. 🔄 等待构建完成
3. 🎉 开始使用 node-pdf2img
4. 📦 发布正式版到 npm
5. 🌟 在 GitHub 上给个 star

---

**构建状态**: ⏳ 等待中...
**npm 包**: https://www.npmjs.com/package/node-pdf2img
**GitHub 仓库**: https://github.com/sigma-2026/node-pdf2img
