//! 渲染配置

/// 渲染配置参数
#[derive(Debug, Clone)]
pub struct RenderConfig {
    /// 目标渲染宽度
    pub target_width: u32,
    /// 扫描件/图片页面的降级宽度
    pub image_heavy_width: u32,
    /// 最大缩放比例
    pub max_scale: f32,
    /// WebP 质量（1-100）
    pub webp_quality: u8,
    /// 是否启用扫描件检测
    pub detect_scan: bool,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            target_width: 1280,
            image_heavy_width: 1024,
            max_scale: 4.0,
            webp_quality: 70,
            detect_scan: true,
        }
    }
}
