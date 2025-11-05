import { config } from "dotenv";
import apiRouter from "./src/router.js";
import express from "express";
import path from "path";
import fs from "fs";
import { ExportImage } from "./src/pdf2img.js";
import { fileURLToPath } from "url";
// import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from "@mswjs/interceptors/fetch";

const interceptor = new FetchInterceptor();

// Enable the interception of requests.
interceptor.apply();
// 存储请求开始时间的映射表（以 requestId 为键）
const requestTimers = new Map();
// Listen to any "http.ClientRequest" being dispatched,
// and log its method and full URL.
interceptor.on("request", ({ request, requestId }) => {
    requestTimers.set(requestId, Date.now()); // 记录请求开始时间戳
    console.log("监听 request", {
        method: request.method,
        url: request.url,
        requestId,
    });
});

// Listen to any responses sent to "http.ClientRequest".
// Note that this listener is read-only and cannot affect responses.
interceptor.on(
    "response",
    ({ response, isMockedResponse, request, requestId }) => {
        const startTime = requestTimers.get(requestId);

        if (startTime) {
            const cost = Date.now() - startTime; // 计算耗时（毫秒）
            requestTimers.delete(requestId); // 清理计时器

            console.log("监听 response", {
                url: request.url,
                status: response.status,
                // range: response.headers,
                size:
                    response.headers.get("content-length") / 1024 / 1024 + "MB", // 打印接口返回大小
                cost: `${cost}ms`, // 打印接口耗时
            });
        }
    }
);

// 3. 激活拦截器
interceptor.apply();

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全局捕获异常（添加到入口文件顶部）
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
});

config();
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Middleware
app.use(express.json());
// 处理表单数据
app.use(express.urlencoded({ extended: true }));

// 关键配置：静态资源服务支持 Range 请求
app.use("/static", (req, res, next) => {
    // 打印访问路径
    console.log({
        method: req.method,
        url: req.originalUrl,
        range: req.headers.range,
        contentLength: req.headers["content-length"],
    });
    // 显式调用静态资源中间件
    express.static(path.join(__dirname, "static"), {
        setHeaders: (res, filePath, stat) => {
            // 启用分片请求支持
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader(
                "Access-Control-Expose-Headers",
                "Accept-Ranges, Content-Range"
            );
        },
    })(req, res, next);
});

app.get("/test-local", async (req, res) => {
    global.begin = Date.now();
    console.log("触发本地测试接口: /test-local");

    // 检查是否处于开发环境，如果不是，则不允许执行本地测试
    if (process.env.NODE_ENV !== 'dev') {
        return res.status(403).send({
            code: 403,
            message: "本地测试接口仅在 NODE_ENV=dev 环境下可用"
        });
    }

    // 1. 定义测试参数
    // 您可以更改为 static 目录下的其他文件名，如 '10M.pdf', '50M.pdf' 等
    const pdfFileName = '1M.pdf'; 
    const globalPadId = `local-test-${Date.now()}`;
    // 从环境变量中读取截图输出目录
    const outputDir = path.join(__dirname, process.env.OUTPUT_DIR || 'output'); 
    
    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 2. 构造PDF文件的访问URL
    // 这里的URL会指向我们服务自身的 /static 路由，从而实现一次完整的HTTP分片请求测试
    const pdfUrl = `http://localhost:${PORT}/static/${pdfFileName}`;
    console.log(`本地测试PDF路径 (将由服务自身处理): ${pdfUrl}`);
    console.log(`测试用的 globalPadId: ${globalPadId}`);
    console.log(`截图输出目录: ${outputDir}`);

    try {
        // 3. 实例化并调用核心服务
        const exportImage = new ExportImage({ globalPadId });
        
        // 您可以在此自定义测试参数, pages: "all" 表示全量截图, 也可以是页码数组 [1, 3]
        const data = await exportImage.pdfToImage({
            pdfPath: pdfUrl,
            outputDir: outputDir,
            pages: "all",
            screen: null,
        });

        const successMessage = `✅ 本地测试成功！截图已保存至 '${outputDir}' 目录。`;
        console.log(successMessage);
        res.send({
            code: 200,
            data: data,
            message: successMessage,
        });
    } catch (error) {
        console.error("❌ 本地测试时发生错误:", error);
        res.status(500).send({
            code: 500,
            data: null,
            message: error.message,
        });
    }
});

// Routes
app.use("/api", apiRouter);

app.get("/", (req, res) => {
    console.log("未授权页面");
    res.status(404).send("404 Not Found");
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send("Server Error");
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
