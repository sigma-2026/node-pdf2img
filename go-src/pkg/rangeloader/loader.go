package rangeloader

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// 主分片大小 1MB
	DefaultChunkSize = 1024 * 1024
	// 子分片大小 256KB，用于并发请求
	DefaultSmallChunkSize = 256 * 1024
	// 初始数据长度 10KB
	DefaultInitialDataLength = 10 * 1024
	// 缓存块大小 64KB - 用于优化小的随机读取
	DefaultCacheBlockSize = 64 * 1024
)

// RangeLoader 实现 HTTP Range 请求的分片加载器
// 等价于 Node.js 版本的 RangeLoader 类
type RangeLoader struct {
	url            string
	size           int64
	client         *http.Client
	chunkSize      int64
	smallChunkSize int64
	cacheBlockSize int64
	
	// 缓存已加载的数据块 - 使用块索引作为 key
	cache     map[int64][]byte
	cacheMu   sync.RWMutex
	
	// 统计信息
	stats     *LoaderStats
	statsMu   sync.Mutex
}

// LoaderStats 加载统计信息
type LoaderStats struct {
	TotalRequests   int64     // 总 HTTP 请求数
	TotalBytes      int64     // 总下载字节数
	CacheHits       int64     // 缓存命中次数
	CacheMisses     int64     // 缓存未命中次数
	StartTime       time.Time // 开始时间
	FileSize        int64     // PDF 文件大小
	ReadAtCalls     int64     // ReadAt 调用次数
	TotalReadBytes  int64     // ReadAt 请求的总字节数
}

// NewRangeLoader 创建新的分片加载器
func NewRangeLoader(url string, opts ...Option) (*RangeLoader, error) {
	loader := &RangeLoader{
		url:            url,
		chunkSize:      DefaultChunkSize,
		smallChunkSize: DefaultSmallChunkSize,
		cacheBlockSize: DefaultCacheBlockSize,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		cache: make(map[int64][]byte),
		stats: &LoaderStats{
			StartTime: time.Now(),
		},
	}
	
	for _, opt := range opts {
		opt(loader)
	}
	
	// 获取文件大小
	size, err := loader.fetchFileSize()
	if err != nil {
		return nil, fmt.Errorf("failed to get file size: %w", err)
	}
	loader.size = size
	
	return loader, nil
}

// Option 配置选项
type Option func(*RangeLoader)

// WithChunkSize 设置主分片大小
func WithChunkSize(size int64) Option {
	return func(l *RangeLoader) {
		l.chunkSize = size
	}
}

// WithSmallChunkSize 设置子分片大小
func WithSmallChunkSize(size int64) Option {
	return func(l *RangeLoader) {
		l.smallChunkSize = size
	}
}

// WithHTTPClient 设置自定义 HTTP 客户端
func WithHTTPClient(client *http.Client) Option {
	return func(l *RangeLoader) {
		l.client = client
	}
}

// Size 返回文件总大小
func (l *RangeLoader) Size() int64 {
	return l.size
}

// Stats 返回统计信息
func (l *RangeLoader) Stats() LoaderStats {
	l.statsMu.Lock()
	defer l.statsMu.Unlock()
	stats := *l.stats
	stats.FileSize = l.size
	return stats
}

// fetchFileSize 通过 HEAD 请求或 Range 请求获取文件大小
func (l *RangeLoader) fetchFileSize() (int64, error) {
	// 先尝试 HEAD 请求
	req, err := http.NewRequest("HEAD", l.url, nil)
	if err != nil {
		return 0, err
	}
	
	resp, err := l.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	
	if resp.ContentLength > 0 {
		return resp.ContentLength, nil
	}
	
	// HEAD 不支持，尝试 Range 请求获取
	return l.fetchFileSizeByRange()
}

// fetchFileSizeByRange 通过 Range 请求获取文件大小
func (l *RangeLoader) fetchFileSizeByRange() (int64, error) {
	req, err := http.NewRequest("GET", l.url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", DefaultInitialDataLength-1))
	
	resp, err := l.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	
	// 解析 Content-Range: bytes 0-10239/12345678
	contentRange := resp.Header.Get("Content-Range")
	if contentRange == "" {
		// 服务器不支持 Range，返回 Content-Length
		return resp.ContentLength, nil
	}
	
	parts := strings.Split(contentRange, "/")
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid Content-Range header: %s", contentRange)
	}
	
	size, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("failed to parse file size from Content-Range: %w", err)
	}
	
	return size, nil
}

// ReadAt 实现 io.ReaderAt 接口，供 pdfium 调用
// 这是分片加载的核心方法
func (l *RangeLoader) ReadAt(p []byte, off int64) (n int, err error) {
	return l.ReadAtContext(context.Background(), p, off)
}

// ReadAtContext 带 context 的 ReadAt
// 使用块缓存策略：每次请求时预取一个较大的块，优化小的随机读取
func (l *RangeLoader) ReadAtContext(ctx context.Context, p []byte, off int64) (n int, err error) {
	// 统计 ReadAt 调用
	l.statsMu.Lock()
	l.stats.ReadAtCalls++
	l.stats.TotalReadBytes += int64(len(p))
	l.statsMu.Unlock()
	
	if off >= l.size {
		return 0, io.EOF
	}
	
	end := off + int64(len(p))
	if end > l.size {
		end = l.size
		p = p[:end-off]
	}
	
	// 尝试从块缓存读取
	data, cacheHit := l.readFromBlockCache(off, int64(len(p)))
	if cacheHit {
		l.statsMu.Lock()
		l.stats.CacheHits++
		l.statsMu.Unlock()
		copy(p, data)
		return len(p), nil
	}
	
	l.statsMu.Lock()
	l.stats.CacheMisses++
	l.statsMu.Unlock()
	
	// 计算需要获取的块范围（对齐到块边界）
	blockStart := (off / l.cacheBlockSize) * l.cacheBlockSize
	
	// 动态预取策略：根据文件大小调整预取量
	// 大文件预取更多，小文件预取较少
	prefetchBlocks := int64(1)
	if l.size > 10*1024*1024 { // > 10MB
		prefetchBlocks = 4 // 预取 4 个块 = 256KB
	} else if l.size > 1*1024*1024 { // > 1MB
		prefetchBlocks = 2 // 预取 2 个块 = 128KB
	}
	
	blockEnd := blockStart + l.cacheBlockSize*prefetchBlocks - 1
	if blockEnd >= l.size {
		blockEnd = l.size - 1
	}
	
	// 获取数据
	blockData, err := l.fetchRange(ctx, blockStart, blockEnd)
	if err != nil {
		return 0, err
	}
	
	// 存入块缓存
	l.putToBlockCache(blockStart, blockData)
	
	// 从获取的数据中提取需要的部分
	dataStart := off - blockStart
	dataEnd := dataStart + int64(len(p))
	if dataEnd > int64(len(blockData)) {
		dataEnd = int64(len(blockData))
	}
	
	copy(p, blockData[dataStart:dataEnd])
	return int(dataEnd - dataStart), nil
}

// fetchRangeWithChunks 将大请求拆分为多个小请求并发执行
// 等价于 Node.js 版本的 requestDataRange + getBatchGroups
func (l *RangeLoader) fetchRangeWithChunks(ctx context.Context, start, end int64) ([]byte, error) {
	totalSize := end - start + 1
	
	// 如果请求小于子分片大小，直接请求
	if totalSize <= l.smallChunkSize {
		return l.fetchRange(ctx, start, end)
	}
	
	// 拆分为多个子分片
	groups := l.getBatchGroups(start, end, l.smallChunkSize)
	
	// 并发请求所有子分片
	results := make([][]byte, len(groups))
	var wg sync.WaitGroup
	var fetchErr error
	var errOnce sync.Once
	
	for i, group := range groups {
		wg.Add(1)
		go func(idx int, s, e int64) {
			defer wg.Done()
			
			data, err := l.fetchRange(ctx, s, e)
			if err != nil {
				errOnce.Do(func() {
					fetchErr = err
				})
				return
			}
			results[idx] = data
		}(i, group[0], group[1])
	}
	
	wg.Wait()
	
	if fetchErr != nil {
		return nil, fetchErr
	}
	
	// 合并所有分片数据
	totalBytes := int64(0)
	for _, data := range results {
		totalBytes += int64(len(data))
	}
	
	result := make([]byte, 0, totalBytes)
	for _, data := range results {
		result = append(result, data...)
	}
	
	// 注意：TotalBytes 已在 fetchRange 中统计，这里不再重复统计
	
	return result, nil
}

// getBatchGroups 将范围拆分为多个子分片
// 等价于 Node.js 版本的 getBatchGroups
func (l *RangeLoader) getBatchGroups(start, end, limitLength int64) [][2]int64 {
	count := (end - start + limitLength) / limitLength
	groups := make([][2]int64, 0, count)
	
	for i := int64(0); i < count; i++ {
		eachStart := i*limitLength + start
		eachEnd := eachStart + limitLength - 1
		if eachEnd > end {
			eachEnd = end
		}
		groups = append(groups, [2]int64{eachStart, eachEnd})
	}
	
	return groups
}

// fetchRange 执行单个 HTTP Range 请求
func (l *RangeLoader) fetchRange(ctx context.Context, start, end int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", l.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	
	l.statsMu.Lock()
	l.stats.TotalRequests++
	l.statsMu.Unlock()
	
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}
	
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	// 统计下载字节数
	l.statsMu.Lock()
	l.stats.TotalBytes += int64(len(data))
	l.statsMu.Unlock()
	
	return data, nil
}

// readFromBlockCache 从块缓存读取数据
// 块缓存使用块索引作为 key，可以处理跨块读取
func (l *RangeLoader) readFromBlockCache(off, length int64) ([]byte, bool) {
	l.cacheMu.RLock()
	defer l.cacheMu.RUnlock()
	
	// 计算需要的块
	startBlock := off / l.cacheBlockSize
	endBlock := (off + length - 1) / l.cacheBlockSize
	
	// 检查所有需要的块是否都在缓存中
	for blockIdx := startBlock; blockIdx <= endBlock; blockIdx++ {
		blockStart := blockIdx * l.cacheBlockSize
		if _, ok := l.cache[blockStart]; !ok {
			return nil, false
		}
	}
	
	// 所有块都在缓存中，组装数据
	result := make([]byte, length)
	copied := int64(0)
	
	for blockIdx := startBlock; blockIdx <= endBlock && copied < length; blockIdx++ {
		blockStart := blockIdx * l.cacheBlockSize
		blockData := l.cache[blockStart]
		
		// 计算在这个块中需要读取的范围
		readStart := int64(0)
		if blockIdx == startBlock {
			readStart = off - blockStart
		}
		
		readEnd := int64(len(blockData))
		remaining := length - copied
		if readEnd-readStart > remaining {
			readEnd = readStart + remaining
		}
		
		copy(result[copied:], blockData[readStart:readEnd])
		copied += readEnd - readStart
	}
	
	return result[:copied], true
}

// putToBlockCache 存入块缓存
func (l *RangeLoader) putToBlockCache(blockStart int64, data []byte) {
	l.cacheMu.Lock()
	defer l.cacheMu.Unlock()
	
	// 限制缓存大小
	const maxCacheSize = 50 * 1024 * 1024 // 50MB
	
	totalSize := int64(0)
	for _, v := range l.cache {
		totalSize += int64(len(v))
	}
	
	// 如果缓存过大，清空
	if totalSize > maxCacheSize {
		l.cache = make(map[int64][]byte)
	}
	
	// 将数据按块大小分割存储
	for i := int64(0); i < int64(len(data)); i += l.cacheBlockSize {
		chunkStart := blockStart + i
		chunkEnd := i + l.cacheBlockSize
		if chunkEnd > int64(len(data)) {
			chunkEnd = int64(len(data))
		}
		l.cache[chunkStart] = data[i:chunkEnd]
	}
}

// Close 关闭加载器，清理资源
func (l *RangeLoader) Close() error {
	l.cacheMu.Lock()
	defer l.cacheMu.Unlock()
	l.cache = nil
	return nil
}

// GetInitialData 获取初始数据（用于 PDF 解析）
func (l *RangeLoader) GetInitialData(ctx context.Context) ([]byte, error) {
	return l.fetchRange(ctx, 0, DefaultInitialDataLength-1)
}

// DownloadAll 并行分片下载整个文件
// 这是为了配合 go-fitz (MuPDF) 使用，因为它需要完整的 PDF 数据
// 通过并行分片下载可以显著加速大文件的获取
func (l *RangeLoader) DownloadAll(ctx context.Context) ([]byte, error) {
	// 将整个文件拆分为多个分片并行下载
	groups := l.getBatchGroups(0, l.size-1, l.smallChunkSize)
	
	results := make([][]byte, len(groups))
	var wg sync.WaitGroup
	var fetchErr error
	var errOnce sync.Once
	
	// 限制并发数，避免过多连接
	const maxConcurrency = 8
	sem := make(chan struct{}, maxConcurrency)
	
	for i, group := range groups {
		wg.Add(1)
		go func(idx int, s, e int64) {
			defer wg.Done()
			
			sem <- struct{}{} // 获取信号量
			defer func() { <-sem }() // 释放信号量
			
			data, err := l.fetchRange(ctx, s, e)
			if err != nil {
				errOnce.Do(func() {
					fetchErr = err
				})
				return
			}
			results[idx] = data
		}(i, group[0], group[1])
	}
	
	wg.Wait()
	
	if fetchErr != nil {
		return nil, fetchErr
	}
	
	// 合并所有分片数据
	totalBytes := int64(0)
	for _, data := range results {
		totalBytes += int64(len(data))
	}
	
	result := make([]byte, 0, totalBytes)
	for _, data := range results {
		result = append(result, data...)
	}
	
	// 注意：TotalBytes 已在 fetchRange 中统计，这里不再重复统计
	
	return result, nil
}
