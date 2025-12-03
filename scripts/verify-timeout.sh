#!/bin/bash

echo "=========================================="
echo "验证40秒超时配置"
echo "=========================================="

# 检查超时中间件文件
echo ""
echo "1. 检查超时中间件文件..."
if [ -f "src/timeout-middleware.js" ]; then
    echo "✅ src/timeout-middleware.js 存在"
    grep "DEFAULT_TIMEOUT = 40000" src/timeout-middleware.js > /dev/null
    if [ $? -eq 0 ]; then
        echo "✅ 超时时间配置为 40000ms (40秒)"
    else
        echo "❌ 超时时间配置不正确"
    fi
else
    echo "❌ src/timeout-middleware.js 不存在"
fi

# 检查 app.js 集成
echo ""
echo "2. 检查 app.js 集成..."
if grep -q "timeout-middleware" app.js; then
    echo "✅ app.js 已导入超时中间件"
else
    echo "❌ app.js 未导入超时中间件"
fi

if grep -q "timeoutMiddleware()" app.js; then
    echo "✅ app.js 已使用超时中间件"
else
    echo "❌ app.js 未使用超时中间件"
fi

# 检查测试文件
echo ""
echo "3. 检查测试文件..."
if [ -f "test/timeout.test.mjs" ]; then
    echo "✅ test/timeout.test.mjs 存在"
else
    echo "❌ test/timeout.test.mjs 不存在"
fi

# 检查文档
echo ""
echo "4. 检查文档..."
if [ -f "docs/TIMEOUT_CONFIG.md" ]; then
    echo "✅ docs/TIMEOUT_CONFIG.md 存在"
else
    echo "❌ docs/TIMEOUT_CONFIG.md 不存在"
fi

if [ -f "docs/TIMEOUT_IMPLEMENTATION.md" ]; then
    echo "✅ docs/TIMEOUT_IMPLEMENTATION.md 存在"
else
    echo "❌ docs/TIMEOUT_IMPLEMENTATION.md 不存在"
fi

# 检查 package.json
echo ""
echo "5. 检查 package.json..."
if grep -q "test:timeout" package.json; then
    echo "✅ package.json 已添加 test:timeout 脚本"
else
    echo "❌ package.json 未添加 test:timeout 脚本"
fi

echo ""
echo "=========================================="
echo "验证完成"
echo "=========================================="
