#!/bin/bash
set -e  # 任何命令失败时立即退出

# ================== 用户输入 ==================
TAG=$1
if [ -z "$TAG" ]; then
  echo "ERROR: 必须指定镜像标签！用法: $0 <TAG>"
  exit 1
fi

# ================== 自动化流程 ==================

# 1. 构建镜像
echo "构建镜像：pdf2img:${TAG}"
sudo docker build -t pdf2img:${TAG} ./

# 2. 获取镜像ID
IMAGE_ID=$(sudo docker images -q pdf2img:${TAG})
if [ -z "$IMAGE_ID" ]; then
  echo "ERROR: 镜像构建失败，未找到镜像ID！"
  exit 1
fi
echo "镜像构建成功，IMAGE_ID=${IMAGE_ID}"
sudo docker stop my-container && sudo docker rm my-container
sudo docker run -d --name my-container -p 3000:3000 pdf2img:${TAG}
echo "✅ 本地部署完成!"
sleep 3
sudo docker logs my-container