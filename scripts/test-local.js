import fetch from 'node-fetch';

// --- 配置区 ---
// 从 .env 文件读取 PORT 或使用默认值
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
// 定义需要测试的文件列表
const PDF_FILES_TO_TEST = ['1M.pdf', '10M.pdf', '50M.pdf', '80M.pdf'];
// --- 配置区结束 ---

/**
 * 对单个PDF文件执行一次测试请求
 * @param {string} pdfFile - PDF文件名
 * @returns {Promise<number>} - 返回处理耗时（秒）
 */
async function runTest(pdfFile) {
    const url = `${BASE_URL}/test-local?file=${pdfFile}`;
    console.log(`[请求发起] 正在测试 ${pdfFile}...`);

    const startTime = Date.now();
    try {
        const response = await fetch(url);
        const result = await response.json();
        const duration = (Date.now() - startTime) / 1000; // 转换为秒

        if (response.status === 200 && result.code === 200) {
            console.log(`  ✅ [成功] ${pdfFile} 处理完成，耗时: ${duration.toFixed(3)} 秒`);
            return duration;
        } else {
            console.error(`  ❌ [失败] ${pdfFile} 测试失败，状态码: ${response.status}, 消息: ${result.message || '未知错误'}`);
            return -1;
        }
    } catch (error) {
        const duration = (Date.now() - startTime) / 1000;
        console.error(`  ❌ [异常] ${pdfFile} 请求异常，耗时: ${duration.toFixed(3)} 秒. 错误: ${error.message}`);
        console.error("  请确保您的PDF转换服务正在运行，并且端口号正确。");
        return -1;
    }
}

/**
 * 串行执行所有测试
 */
async function runSerialTests() {
    console.log("\n--- [模式: 串行执行] ---");
    console.log("说明: 任务将一个接一个地执行，这能反映单个任务在无并发压力下的性能。\n");

    const totalStartTime = Date.now();
    let totalDuration = 0;
    const results = {};

    for (const file of PDF_FILES_TO_TEST) {
        const duration = await runTest(file);
        if (duration > 0) {
            results[file] = duration;
            totalDuration += duration;
        }
    }
    
    console.log("\n--- 串行测试结果汇总 ---");
    for (const file in results) {
        console.log(`  - ${file}: ${results[file].toFixed(3)} 秒`);
    }
    console.log(`[串行总耗时] 所有任务完成总共花费: ${( (Date.now() - totalStartTime) / 1000).toFixed(3)} 秒`);
}

/**
 * 并行执行所有测试
 */
async function runParallelTests() {
    console.log("\n--- [模式: 并行执行] ---");
    console.log(`说明: 同时对 ${PDF_FILES_TO_TEST.length} 个文件发起请求，这能测试服务在并发负载下的表现。\n`);

    const totalStartTime = Date.now();
    // 创建所有测试任务的 Promise 数组
    const testPromises = PDF_FILES_TO_TEST.map(file => runTest(file).then(duration => ({ file, duration })));

    // 等待所有任务完成
    const results = await Promise.all(testPromises);
    const successfulResults = results.filter(r => r.duration > 0);

    console.log("\n--- 并行测试结果汇总 ---");
    successfulResults.forEach(result => {
        console.log(`  - ${result.file}: ${result.duration.toFixed(3)} 秒`);
    });
    console.log(`[并行总耗时] 所有并发任务完成花费: ${( (Date.now() - totalStartTime) / 1000).toFixed(3)} 秒`);
}

/**
 * 主函数
 */
async function main() {
    console.log("🚀 开始PDF服务性能测试...");
    await runSerialTests();
    console.log("\n" + "=".repeat(50) + "\n");
    await runParallelTests();
    console.log("\n✅ 性能测试全部完成！");
}

main();
