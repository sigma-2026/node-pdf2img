# 本地开发指南

## 预编译的 Native 模块

本项目已在 `packages/native-renderer/` 目录中内置了 Linux x64 平台预编译的 native 模块，方便本地开发。

### 包含的文件

- `packages/native-renderer/pdf-renderer.linux-x64-gnu.node` - Linux x64 原生模块
- `packages/native-renderer/libpdfium.so` - Linux PDFium 库

### 使用方法

在 Linux x64 平台上开发时，直接运行以下命令即可：

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 运行测试
cd packages/native-renderer
node test.mjs

# 或者运行主包测试
cd packages/pdf2img
node --test test/*.test.js
```

### 重新编译

如果需要修改 native 模块的 Rust 代码，可以重新编译：

```bash
cd packages/native-renderer
pnpm run build
```

编译完成后，新的 `.node` 文件会自动覆盖预编译的版本。

### 其他平台

对于非 Linux x64 平台（如 macOS、Windows），或者需要交叉编译其他平台，请参考 [README.md](packages/pdf2img/README.md#多平台构建说明)。

### 注意事项

- 预编译的 native 模块仅适用于 Linux x64 (glibc)
- 如果在非 Linux x64 平台上使用，install 脚本会尝试本地编译
- 提交代码时，新的 `.node` 文件会自动包含在提交中
- `target/` 目录仍会被 `.gitignore` 忽略，不会提交中间编译产物
