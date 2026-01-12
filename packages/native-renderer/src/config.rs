//! 渲染配置

use crate::renderer::OutputFormat;

/// 渲染配置参数
#[derive(Debug, Clone)]
pub struct RenderConfig {
    /// 目标渲染宽度
    pub target_width: u32,
    /// 扫描件/图片页面的降级宽度
    pub image_heavy_width: u32,
    /// 最大缩放比例
    pub max_scale: f32,
    /// 是否启用扫描件检测
    pub detect_scan: bool,
    /// 输出格式
    pub format: OutputFormat,
    /// WebP 编码质量（0-100）
    pub webp_quality: u8,
    /// WebP 编码方法/速度（0-6，0最快，6最慢但压缩最好）
    /// 默认值 4 是速度和压缩率的最佳平衡点
    pub webp_method: i32,
    /// JPEG 编码质量（0-100）
    pub jpeg_quality: u8,
    /// PNG 压缩级别（0-9，0不压缩，9最大压缩）
    pub png_compression: u8,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            target_width: 1280,
            image_heavy_width: 1024,
            max_scale: 4.0,
            detect_scan: true,
            format: OutputFormat::WebP,
            webp_quality: 80,
            webp_method: 4,  // 速度和压缩率的最佳平衡点
            jpeg_quality: 85,
            png_compression: 6,
        }
    }
}
