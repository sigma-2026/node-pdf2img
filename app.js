import { config } from "dotenv";
import apiRouter from "./src/router.js";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { IS_DEV } from "./src/env.js";
import { registerTestLocalRoute } from './src/test-local-route.js';

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

// 仅在开发环境加载测试路由（生产环境不打包）
if (IS_DEV) {
    registerTestLocalRoute(app, PORT);
    console.log('✅ 开发环境：已加载 /test-local 测试接口');
}

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
