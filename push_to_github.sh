#!/bin/bash

echo "=== GitHub 推送脚本 ==="
echo
necho "请选择认证方式："
echo "1) 使用 GitHub CLI（推荐）"
echo "2) 使用 Personal Access Token"
echo "3) 使用 SSH"
echo

read -p "请输入选项 (1-3): " choice

case $choice in
    1)
        echo "使用 GitHub CLI..."
        if ! command -v gh &> /dev/null; then
            echo "请先安装 GitHub CLI:"
            echo "  macOS: brew install gh"
            echo "  Linux: sudo apt install gh"
            echo "  Windows: scoop install gh"
            exit 1
        fi
        
        gh auth login
        git push -u github beta/cli_20260112
        ;;
    
    2)
        echo
        echo "请访问: https://github.com/settings/tokens"
        echo "创建 Personal Access Token (classic)"
        echo "所需权限: repo, workflow"
        echo
        read -p "请输入你的 GitHub Token: " token
        
        if [ -z "$token" ]; then
            echo "Token 不能为空"
            exit 1
        fi
        
        git remote set-url github https://${token}@github.com/sigma-2026/node-pdf2img.git
        git push -u github beta/cli_20260112
        ;;
    
    3)
        echo "使用 SSH 方式..."
        git remote set-url github git@github.com:sigma-2026/node-pdf2img.git
        git push -u github beta/cli_20260112
        ;;
    
    *)
        echo "无效选项"
        exit 1
        ;;
esac

echo
echo "推送完成！"
echo
