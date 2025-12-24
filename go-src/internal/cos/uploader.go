package cos

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

// Config COS 配置
type Config struct {
	SecretID  string
	SecretKey string
	Region    string
	Bucket    string
	BaseURL   string // 可选，自定义域名
}

// ConfigFromEnv 从环境变量读取配置
func ConfigFromEnv() Config {
	return Config{
		SecretID:  os.Getenv("COS_SECRET_ID"),
		SecretKey: os.Getenv("COS_SECRET_KEY"),
		Region:    os.Getenv("COS_REGION"),
		Bucket:    os.Getenv("COS_BUCKET"),
		BaseURL:   os.Getenv("COS_BASE_URL"),
	}
}

// Uploader COS 上传器
type Uploader struct {
	client  *cos.Client
	config  Config
	baseURL string
}

// NewUploader 创建上传器
func NewUploader(config Config) (*Uploader, error) {
	if config.SecretID == "" || config.SecretKey == "" {
		return nil, fmt.Errorf("COS credentials not configured")
	}

	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", config.Bucket, config.Region))
	if err != nil {
		return nil, err
	}

	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  config.SecretID,
			SecretKey: config.SecretKey,
		},
		Timeout: 60 * time.Second,
	})

	baseURL := config.BaseURL
	if baseURL == "" {
		baseURL = bucketURL.String()
	}

	return &Uploader{
		client:  client,
		config:  config,
		baseURL: baseURL,
	}, nil
}

// UploadResult 上传结果
type UploadResult struct {
	Key string
	URL string
}

// Upload 上传文件
func (u *Uploader) Upload(ctx context.Context, key string, data []byte, contentType string) (*UploadResult, error) {
	opt := &cos.ObjectPutOptions{
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType: contentType,
		},
	}

	_, err := u.client.Object.Put(ctx, key, bytes.NewReader(data), opt)
	if err != nil {
		return nil, fmt.Errorf("failed to upload to COS: %w", err)
	}

	return &UploadResult{
		Key: key,
		URL: u.baseURL + "/" + key,
	}, nil
}

// UploadImage 上传图片（与 Node.js 版本保持一致）
// 路径格式: pdf2img/{globalPadID}_{pageNum}.webp
// pageNum 是 1-based（从1开始）
func (u *Uploader) UploadImage(ctx context.Context, globalPadID string, pageNum int, data []byte) (*UploadResult, error) {
	// 与 Node.js 版本保持一致的路径格式
	key := fmt.Sprintf("pdf2img/%s_%d.webp", globalPadID, pageNum)
	return u.Upload(ctx, key, data, "image/webp")
}

// Delete 删除文件
func (u *Uploader) Delete(ctx context.Context, key string) error {
	_, err := u.client.Object.Delete(ctx, key)
	return err
}

// BatchUpload 批量上传
func (u *Uploader) BatchUpload(ctx context.Context, files map[string][]byte, contentType string) ([]UploadResult, error) {
	results := make([]UploadResult, 0, len(files))

	for key, data := range files {
		result, err := u.Upload(ctx, key, data, contentType)
		if err != nil {
			return results, err
		}
		results = append(results, *result)
	}

	return results, nil
}
