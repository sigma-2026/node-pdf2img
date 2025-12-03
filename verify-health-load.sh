#!/bin/bash

echo "=========================================="
echo "验证健康检查高负载丢弃功能"
echo "=========================================="

# 检查健康监控模块
echo ""
echo "1. 检查健康监控模块..."
if [ -f "src/health-monitor.js" ]; then
    echo "✅ src/health-monitor.js 存在"
    
    # 检查关键函数
    grep -q "export async function checkHealth" src/health-monitor.js
    if [ $? -eq 0 ]; then
        echo "✅ checkHealth 函数存在"
    else
        echo "❌ checkHealth 函数不存在"
    fi
    
    grep -q "getCpuUsage" src/health-monitor.js
    if [ $? -eq 0 ]; then
        echo "✅ getCpuUsage 函数存在"
    else
        echo "❌ getCpuUsage 函数不存在"
    fi
    
    grep -q "getMemoryUsage" src/health-monitor.js
    if [ $? -eq 0 ]; then
        echo "✅ getMemoryUsage 函数存在"
    else
        echo "❌ getMemoryUsage 函数不存在"
    fi
else
    echo "❌ src/health-monitor.js 不存在"
fi

# 检查 router.js 集成
echo ""
echo "2. 检查 router.js 集成..."
if grep -q "import.*checkHealth.*from.*health-monitor" src/router.js; then
    echo "✅ router.js 已导入 checkHealth"
else
    echo "❌ router.js 未导入 checkHealth"
fi

if grep -q "await checkHealth()" src/router.js; then
    echo "✅ router.js 已调用 checkHealth"
else
    echo "❌ router.js 未调用 checkHealth"
fi

if grep -q "503" src/router.js; then
    echo "✅ router.js 包含 503 状态码处理"
else
    echo "❌ router.js 未包含 503 状态码处理"
fi

# 检查测试文件
echo ""
echo "3. 检查测试文件..."
if [ -f "test/health-load.test.mjs" ]; then
    echo "✅ test/health-load.test.mjs 存在"
else
    echo "❌ test/health-load.test.mjs 不存在"
fi

# 检查文档
echo ""
echo "4. 检查文档..."
if [ -f "docs/HEALTH_LOAD_REJECTION.md" ]; then
    echo "✅ docs/HEALTH_LOAD_REJECTION.md 存在"
else
    echo "❌ docs/HEALTH_LOAD_REJECTION.md 不存在"
fi

# 检查 package.json
echo ""
echo "5. 检查 package.json..."
if grep -q "test:health-load" package.json; then
    echo "✅ package.json 已添加 test:health-load 脚本"
else
    echo "❌ package.json 未添加 test:health-load 脚本"
fi

# 检查 README.md
echo ""
echo "6. 检查 README.md..."
if grep -q "健康检查高负载丢弃" README.md; then
    echo "✅ README.md 已添加高负载丢弃说明"
else
    echo "❌ README.md 未添加高负载丢弃说明"
fi

echo ""
echo "=========================================="
echo "验证完成"
echo "=========================================="
