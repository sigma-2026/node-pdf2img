// 本地测试服务器 - 用于测试 PDF 分片加载
// 提供静态 PDF 文件服务，支持 HTTP Range 请求
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var (
	port    = flag.Int("port", 8080, "服务端口")
	pdfDir  = flag.String("dir", "", "PDF 文件目录（默认为项目 static 目录）")
	verbose = flag.Bool("v", false, "详细日志")
)

// rangeHandler 处理带 Range 请求的文件服务
func rangeHandler(w http.ResponseWriter, r *http.Request) {
	// 获取请求的文件路径
	filePath := filepath.Join(*pdfDir, r.URL.Path)
	
	// 检查文件是否存在
	fileInfo, err := os.Stat(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	
	// 打开文件
	file, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "Failed to open file", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	
	fileSize := fileInfo.Size()
	
	// 检查是否有 Range 请求头
	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		// 无 Range 请求，返回完整文件
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Length", strconv.FormatInt(fileSize, 10))
		w.Header().Set("Accept-Ranges", "bytes")
		http.ServeContent(w, r, filePath, fileInfo.ModTime(), file)
		if *verbose {
			log.Printf("[Full] %s - %d bytes", r.URL.Path, fileSize)
		}
		return
	}
	
	// 解析 Range 请求头: bytes=start-end
	if !strings.HasPrefix(rangeHeader, "bytes=") {
		http.Error(w, "Invalid Range header", http.StatusBadRequest)
		return
	}
	
	rangeSpec := strings.TrimPrefix(rangeHeader, "bytes=")
	parts := strings.Split(rangeSpec, "-")
	if len(parts) != 2 {
		http.Error(w, "Invalid Range header", http.StatusBadRequest)
		return
	}
	
	var start, end int64
	
	if parts[0] == "" {
		// 格式: bytes=-500 (最后 500 字节)
		end = fileSize - 1
		suffixLen, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			http.Error(w, "Invalid Range header", http.StatusBadRequest)
			return
		}
		start = fileSize - suffixLen
		if start < 0 {
			start = 0
		}
	} else {
		// 格式: bytes=0-499 或 bytes=500-
		start, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			http.Error(w, "Invalid Range header", http.StatusBadRequest)
			return
		}
		
		if parts[1] == "" {
			// bytes=500- (从 500 到文件末尾)
			end = fileSize - 1
		} else {
			end, err = strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				http.Error(w, "Invalid Range header", http.StatusBadRequest)
				return
			}
		}
	}
	
	// 验证范围
	if start < 0 || end >= fileSize || start > end {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
		http.Error(w, "Range Not Satisfiable", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	
	// 读取指定范围的数据
	contentLength := end - start + 1
	buf := make([]byte, contentLength)
	_, err = file.ReadAt(buf, start)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}
	
	// 设置响应头
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(http.StatusPartialContent)
	
	// 写入数据
	w.Write(buf)
	
	if *verbose {
		log.Printf("[Range] %s - bytes=%d-%d/%d (%d bytes)", r.URL.Path, start, end, fileSize, contentLength)
	}
}

func main() {
	flag.Parse()
	
	// 设置默认 PDF 目录
	if *pdfDir == "" {
		// 尝试找到项目根目录的 static 目录
		cwd, _ := os.Getwd()
		*pdfDir = filepath.Join(cwd, "..", "..", "static")
		if _, err := os.Stat(*pdfDir); err != nil {
			*pdfDir = filepath.Join(cwd, "static")
		}
	}
	
	// 检查目录是否存在
	if _, err := os.Stat(*pdfDir); err != nil {
		log.Fatalf("PDF directory not found: %s", *pdfDir)
	}
	
	// 列出可用的 PDF 文件
	files, _ := filepath.Glob(filepath.Join(*pdfDir, "*.pdf"))
	log.Printf("PDF Test Server starting...")
	log.Printf("PDF Directory: %s", *pdfDir)
	log.Printf("Available PDF files:")
	for _, f := range files {
		info, _ := os.Stat(f)
		log.Printf("  - /%s (%d bytes)", filepath.Base(f), info.Size())
	}
	
	// 设置路由
	http.HandleFunc("/", rangeHandler)
	
	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Server listening on http://localhost%s", addr)
	log.Printf("Example: http://localhost%s/1M.pdf", addr)
	
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
