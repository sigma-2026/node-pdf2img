# GitHub Actions 构建和发布指南

## 触发多平台构建

### 自动触发

当代码推送到以下分支时，会自动触发构建：

- `master` 或 `main` - 正式版本
- `beta/*` - 测试版本 (如 `1.0.1-beta.xxx.1`)
- `next` - 预发布版本 (如 `2.0.0-next.1`)
- `v*` tags - 标签发布 + GitHub Release

### 手动触发

1. 访问 https://github.com/sigma-2026/node-pdf2img/actions
2. 点击左侧的 "Build and Release" 工作流
3. 点击右上角的 "Run workflow" 按钮
4. 选择要构建的分支
5. 勾选 "Publish to npm" 选项（如果需要发布）
6. 点击 "Run workflow"

## 配置 NPM_TOKEN

在第一次发布前，需要配置 npm token：

1. **生成 npm token**
   - 访问 https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - 点击 "Create Access Token" → "Automation"
   - 复制生成的 token

2. **在 GitHub 仓库中添加 secret**
   - 访问 https://github.com/sigma-2026/node-pdf2img/settings/secrets/actions
   - 点击 "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: 粘贴你的 npm token
   - 点击 "Add secret"

## 发布流程

### 发布测试版 (beta)

```bash
git checkout -b beta/my-feature
git add .
git commit -m "feat: add new feature"
git push origin beta/my-feature
```

GitHub Actions 会自动：
- 构建所有平台
- 发布到 npm (dist-tag: beta)
- 版本号格式: `1.0.1-beta.my-feature.x`

### 发布正式版

```bash
git checkout master
git merge beta/my-feature
git push origin master
```

GitHub Actions 会自动：
- 构建所有平台
- 发布到 npm (dist-tag: latest)
- 根据 commit message 自动升级版本号

### 发布标签版本

```bash
git checkout master
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会自动：
- 构建所有平台
- 发布到 npm
- 创建 GitHub Release

## 支持的构建平台

| 平台 | 架构 | 构建环境 |
|------|------|----------|
| Linux | x64 | ubuntu-latest |
| Linux | arm64 | ubuntu-latest (cross-compile) |
| macOS | x64 | macos-13 (Intel) |
| macOS | arm64 | macos-14 (Apple Silicon) |
| Windows | x64 | windows-latest |

## 查看构建状态

访问 https://github.com/sigma-2026/node-pdf2img/actions

每个平台都有独立的构建任务，可以在 Actions 页面中查看详细的构建日志。

## 常见问题

### 构建失败：缺少 NPM_TOKEN

**错误**: `npm ERR! need auth This command requires you to be logged in.`

**解决**: 按照上面的步骤配置 NPM_TOKEN secret。

### 构建失败：权限不足

**错误**: `npm ERR! 403 Forbidden`

**解决**: 确保 npm token 有发布权限，且包名 `node-pdf2img` 未被占用。

### 如何重新触发构建

在 Actions 页面中找到失败的构建，点击右上角 "Re-run jobs" 按钮。

### 如何跳过构建

在 commit message 中添加 `[skip ci]` 或 `[ci skip]`：

```bash
git commit -m "docs: update readme [skip ci]"
```

## 发布权限

确保你的 npm 账户有权限发布 `node-pdf2img` 包。如果包名已被占用，需要在 `packages/pdf2img/package.json` 中修改包名。
