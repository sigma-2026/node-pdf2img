# PDF to Image Converter

A simple tool to convert PDF files to images.

## Prerequisites
- Node.js 20+
- Docker (optional)

## Installation
```bash
npm install
```

## Running the App

### Without Docker
```bash
npm start
```

### With Docker
1. Build the Docker image:
```bash
docker build -t pdf2img .
```
2. Run the container:
```bash
docker run -p 3000:3000 pdf2img
```

### Using PM2 for Monitoring
```bash
npm install pm2 -g
npm run pm2
```

# 特性

* 支持数据分片，拆4个子片，并发请求
* 接入cos桶

# TODO

1、pkg

2、pm2 部署


# 请求示例：

## 不带页码默认首页
<img src='./image.png'>

## 带页码多页
<img src='./image1.png'>


# docker 镜像(devcloud)

## 自动打镜像脚本
```
npm run docker:push
```

## mirrors.tencent.com
[仓库地址](https://mirrors.tencent.com/#/private/docker/detail?project_name=tdocs-pdf&repo_name=pdf2img)

```
1、打镜像
docker build -t pdf2img:v1.0.0 ./ 

2、查看镜像
docker images 

3、打tag
docker tag 486ff26017ff mirrors.tencent.com/tdocs-pdf/pdf2img:v2

4、推送
docker push mirrors.tencent.com/tdocs-pdf/pdf2img:v2

5、登陆
docker login --username johnsomwu --password [token] mirrors.tencent.com
```

## csighub.tencentyun.com
[仓库地址](https://csighub.woa.com/tencenthub/repo/detail/pdf-developer/pdf2img/images)
```
0、登陆
sudo docker login csighub.tencentyun.com

1、打镜像
sudo docker build -t pdf2img:[tag] ./

2、查看镜像[imageid], 关联下面的 tag
sudo docker images

3、打tag
sudo docker tag [imageid] csighub.tencentyun.com/pdf-developer/pdf2img:[tag]

4、push
sudo docker push csighub.tencentyun.com/pdf-developer/pdf2img:[tag]
```
