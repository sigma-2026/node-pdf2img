#!/bin/bash
set -e  # 任何命令失败时立即退出

# ================== 用户输入 ==================
TAG=$1
if [ -z "$TAG" ]; then
  echo "ERROR: 必须指定镜像标签！用法: $0 <TAG>"
  exit 1
fi

# ================== 自动化流程 ==================
# 0. 登录镜像仓库
echo "登录腾讯云镜像仓库..."
sudo docker login csighub.tencentyun.com

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

# 3. 打标镜像
TARGET_IMAGE="csighub.tencentyun.com/pdf-developer/pdf2img:${TAG}"
echo "打标镜像：${TARGET_IMAGE}"
sudo docker tag ${IMAGE_ID} ${TARGET_IMAGE}

# 4. 推送镜像
echo "推送镜像到仓库..."
sudo docker push ${TARGET_IMAGE}

echo "✅ 部署完成！镜像地址：${TARGET_IMAGE}"