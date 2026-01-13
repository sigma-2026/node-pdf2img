# 推送到 GitHub 仓库指南

## 前提条件

1. **安装 GitHub CLI** (推荐)
   ```bash
   # macOS
   brew install gh

   # Linux
   sudo apt install gh

   # Windows
   scoop install gh
   ```

2. **创建 GitHub Personal Access Token**
   - 访问 https://github.com/settings/tokens
   - 点击 "Generate new token" → "Generate new token (classic)"
   - 选择以下权限：
     - `repo` - 完全控制私有仓库
     - `workflow` - 更新 GitHub Actions 工作流
   - 点击 "Generate token"
   - **复制 token**（只显示一次）

## 推送步骤

### 方法 1：使用 GitHub CLI（推荐）

```bash
# 1. 登录 GitHub
gh auth login

# 选择：
# - HTTPS
# - Paste an authentication token
# - 粘贴你的 Personal Access Token

# 2. 推送代码
cd /data/code/pdf2img
git push -u github beta/cli_20260112

# 3. 推送所有分支（可选）
git push github --all

# 4. 推送标签（如果有）
git push github --tags
```

### 方法 2：使用 HTTPS + Token

```bash
# 1. 删除现有的 GitHub 远程
cd /data/code/pdf2img
git remote remove github

# 2. 重新添加远程，使用 token 认证
git remote add github https://YOUR_TOKEN@github.com/sigma-2026/node-pdf2img.git

# 3. 推送代码
git push -u github beta/cli_20260112

# 4. 推送所有分支（可选）
git push github --all
```

将 `YOUR_TOKEN` 替换为你的 Personal Access Token。

### 方法 3：使用 SSH

如果你已经配置了 SSH 密钥：

```bash
# 1. 删除现有的 GitHub 远程
cd /data/code/pdf2img
git remote remove github

# 2. 使用 SSH URL 添加远程
git remote add github git@github.com:sigma-2026/node-pdf2img.git

# 3. 推送代码
git push -u github beta/cli_20260112
```

## 验证推送

```bash
# 查看远程分支
git ls-remote --heads github

# 应该显示：
# From https://github.com/sigma-2026/node-pdf2img.git
#   refs/heads/beta/cli_20260112
```

## GitHub Actions 自动触发

推送成功后，GitHub Actions 会自动开始构建：

1. 访问 https://github.com/sigma-2026/node-pdf2img/actions
2. 查看 "Build and Release" 工作流
3. 等待所有平台构建完成（Linux/macOS/Windows）

## 配置 NPM_TOKEN

在 GitHub 仓库设置中添加 NPM Token：

1. 访问 https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. 创建新的 Automation token
3. 在 GitHub 仓库设置中：
   - Settings → Secrets and variables → Actions
   - 点击 "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: 粘贴你的 npm token

这样 GitHub Actions 就能自动发布到 npm 了。
