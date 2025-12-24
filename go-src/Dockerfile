# 多阶段构建 - 使用 go-fitz (MuPDF)

# 阶段1: 构建
FROM golang:1.21-bookworm AS builder

# 安装构建依赖 (MuPDF 需要的库)
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    tzdata \
    build-essential \
    pkg-config \
    libmupdf-dev \
    libfreetype6-dev \
    libharfbuzz-dev \
    libjpeg-dev \
    libopenjp2-7-dev \
    libjbig2dec0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制依赖文件
COPY go.mod go.sum* ./
RUN go mod download || true

# 复制源码
COPY . .

# 下载依赖并构建
RUN go mod tidy && \
    CGO_ENABLED=1 go build \
    -ldflags="-w -s" \
    -o /app/pdf2img \
    ./cmd/server

# 阶段2: 运行时镜像
FROM debian:bookworm-slim

# 安装运行时依赖
RUN apt-get update && apt-get install -y \
    ca-certificates \
    tzdata \
    libmupdf-dev \
    libfreetype6 \
    libharfbuzz0b \
    libjpeg62-turbo \
    libopenjp2-7 \
    libjbig2dec0 \
    # 字体支持
    fontconfig \
    fonts-dejavu \
    # 中文字体
    fonts-noto-cjk \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 设置时区
ENV TZ=Asia/Shanghai

WORKDIR /app

# 从构建阶段复制二进制
COPY --from=builder /app/pdf2img /app/pdf2img

# 创建非 root 用户
RUN useradd -u 1000 -m appuser
USER appuser

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# 启动
ENTRYPOINT ["/app/pdf2img"]
CMD ["-port", "3000", "-mode", "release"]
