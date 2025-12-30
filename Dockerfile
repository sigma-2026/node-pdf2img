# 构建阶段：安装编译依赖并构建 canvas
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production

# 运行阶段：仅包含运行时依赖
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

EXPOSE 3000
CMD ["npm", "run", "prod"]