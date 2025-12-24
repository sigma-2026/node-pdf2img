#!/bin/bash
set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}PDF2IMG Go Docker 镜像推送脚本${NC}"
echo -e "${GREEN}========================================${NC}"

# 获取版本号
VERSION=${1:-$(date +%Y%m%d%H%M)}
IMAGE_NAME="pdf2img-go"

echo -e "${YELLOW}版本: ${VERSION}${NC}"

# 进入项目目录
cd "$(dirname "$0")/.."

# 运行测试
echo -e "\n${GREEN}[1/5] 运行测试...${NC}"
go test -v ./... || {
    echo -e "${RED}测试失败，终止构建${NC}"
    exit 1
}

# 构建镜像
echo -e "\n${GREEN}[2/5] 构建 Docker 镜像...${NC}"
docker build -t ${IMAGE_NAME}:${VERSION} -f Dockerfile .
docker tag ${IMAGE_NAME}:${VERSION} ${IMAGE_NAME}:latest

# 本地验证
echo -e "\n${GREEN}[3/5] 本地验证...${NC}"
docker run -d --name ${IMAGE_NAME}-test -p 3001:3000 ${IMAGE_NAME}:${VERSION}
sleep 3

# 健康检查
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health || echo "000")
docker stop ${IMAGE_NAME}-test && docker rm ${IMAGE_NAME}-test

if [ "$HEALTH_STATUS" != "200" ]; then
    echo -e "${RED}健康检查失败 (HTTP ${HEALTH_STATUS})，终止推送${NC}"
    exit 1
fi
echo -e "${GREEN}健康检查通过${NC}"

# 推送到 mirrors.tencent.com
echo -e "\n${GREEN}[4/5] 推送到 mirrors.tencent.com...${NC}"
docker tag ${IMAGE_NAME}:${VERSION} mirrors.tencent.com/tdocs-pdf/${IMAGE_NAME}:${VERSION}
docker tag ${IMAGE_NAME}:${VERSION} mirrors.tencent.com/tdocs-pdf/${IMAGE_NAME}:latest
docker push mirrors.tencent.com/tdocs-pdf/${IMAGE_NAME}:${VERSION}
docker push mirrors.tencent.com/tdocs-pdf/${IMAGE_NAME}:latest

# 推送到 csighub
echo -e "\n${GREEN}[5/5] 推送到 csighub.tencentyun.com...${NC}"
docker tag ${IMAGE_NAME}:${VERSION} csighub.tencentyun.com/pdf-developer/${IMAGE_NAME}:${VERSION}
docker tag ${IMAGE_NAME}:${VERSION} csighub.tencentyun.com/pdf-developer/${IMAGE_NAME}:latest
docker push csighub.tencentyun.com/pdf-developer/${IMAGE_NAME}:${VERSION}
docker push csighub.tencentyun.com/pdf-developer/${IMAGE_NAME}:latest

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}推送完成!${NC}"
echo -e "${GREEN}镜像: ${IMAGE_NAME}:${VERSION}${NC}"
echo -e "${GREEN}========================================${NC}"
