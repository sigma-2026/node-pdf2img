//! 流式 PDF 读取器
//!
//! 实现了 `Read + Seek` trait，通过 NAPI-RS 回调到 JavaScript 获取数据。
//! 用于支持 PDFium 的按需加载，避免一次性下载整个 PDF 文件。
//!
//! 关键技术：使用 channel 在 Rust 和 JS 之间同步通信。

use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{mpsc, Arc, Mutex};

/// 数据块请求（传递给 JS 的参数）
#[derive(Debug, Clone)]
pub struct BlockRequest {
    pub offset: u64,
    pub size: u32,
    /// 请求 ID，用于匹配响应
    pub request_id: u32,
}

/// 用于接收 JS 响应的 channel sender
type ResponseSender = mpsc::Sender<Result<Vec<u8>, String>>;

/// 缓存块大小（256KB）
const CACHE_BLOCK_SIZE: u64 = 256 * 1024;

/// 最大缓存块数量
const MAX_CACHE_BLOCKS: usize = 64;

/// LRU 缓存条目
struct CacheEntry {
    data: Vec<u8>,
    access_order: u64,
}

/// 流式加载统计信息
#[derive(Debug, Default, Clone)]
pub struct StreamerStats {
    /// 总请求次数
    pub total_requests: u32,
    /// 缓存命中次数
    pub cache_hits: u32,
    /// 缓存未命中次数
    pub cache_misses: u32,
    /// 总下载字节数
    pub total_bytes_fetched: u64,
}

/// 共享状态（用于在 streamer 被 move 后仍能获取统计信息）
pub struct SharedState {
    /// 任务 ID（用于并发支持）
    task_id: u32,
    /// 数据缓存（LRU）
    cache: Mutex<HashMap<u64, CacheEntry>>,
    /// 缓存访问计数器
    access_counter: Mutex<u64>,
    /// 统计信息
    pub stats: Mutex<StreamerStats>,
    /// 待处理的请求（request_id -> sender）
    pending_requests: Mutex<HashMap<u32, ResponseSender>>,
    /// 下一个请求序号（16 位，会与 task_id 组合成完整的 request_id）
    next_request_seq: Mutex<u16>,
}

impl SharedState {
    fn new(task_id: u32) -> Self {
        Self {
            task_id,
            cache: Mutex::new(HashMap::new()),
            access_counter: Mutex::new(0),
            stats: Mutex::new(StreamerStats::default()),
            pending_requests: Mutex::new(HashMap::new()),
            next_request_seq: Mutex::new(0),
        }
    }

    /// 生成下一个请求 ID
    /// 格式：高 16 位是 task_id，低 16 位是请求序号
    fn next_id(&self) -> u32 {
        let mut seq = self.next_request_seq.lock().unwrap();
        let current_seq = *seq;
        *seq = seq.wrapping_add(1);
        // 组合 task_id 和 seq：task_id << 16 | seq
        (self.task_id << 16) | (current_seq as u32)
    }

    /// 注册一个待处理的请求
    fn register_request(&self, request_id: u32, sender: ResponseSender) {
        self.pending_requests
            .lock()
            .unwrap()
            .insert(request_id, sender);
    }

    /// 完成一个请求
    pub fn complete_request(&self, request_id: u32, data: Result<Vec<u8>, String>) {
        if let Some(sender) = self.pending_requests.lock().unwrap().remove(&request_id) {
            let _ = sender.send(data);
        }
    }
}

/// 流式 PDF 读取器
///
/// 这个结构体实现了 `Read + Seek` trait，允许 PDFium 按需读取 PDF 数据。
/// 当 PDFium 需要数据时，它会通过 NAPI-RS 回调到 JavaScript，
/// JavaScript 使用 HTTP Range 请求获取数据并返回。
///
/// 关键技术：使用独立线程 + tokio runtime 来等待 async JS Promise。
pub struct JsFileStreamer {
    /// 文件总大小
    file_size: u64,
    /// 当前读取位置
    position: u64,
    /// 线程安全函数，用于回调 JavaScript
    fetcher: ThreadsafeFunction<BlockRequest, ErrorStrategy::CalleeHandled>,
    /// 共享状态
    state: Arc<SharedState>,
}

impl JsFileStreamer {
    /// 创建新的流式读取器
    pub fn new(
        file_size: u64,
        fetcher: ThreadsafeFunction<BlockRequest, ErrorStrategy::CalleeHandled>,
        task_id: u32,
    ) -> Self {
        Self {
            file_size,
            position: 0,
            fetcher,
            state: Arc::new(SharedState::new(task_id)),
        }
    }

    /// 获取共享状态的引用（用于在 streamer 被 move 后获取统计信息）
    #[allow(dead_code)]
    pub fn get_shared_state(&self) -> Arc<SharedState> {
        Arc::clone(&self.state)
    }

    /// 获取统计信息
    #[allow(dead_code)]
    pub fn get_stats(&self) -> StreamerStats {
        self.state.stats.lock().unwrap().clone()
    }

    /// 计算缓存块的起始偏移量
    fn cache_block_offset(offset: u64) -> u64 {
        (offset / CACHE_BLOCK_SIZE) * CACHE_BLOCK_SIZE
    }

    /// 从缓存中读取数据
    fn read_from_cache(&self, offset: u64, size: u32) -> Option<Vec<u8>> {
        let block_offset = Self::cache_block_offset(offset);
        let mut cache = self.state.cache.lock().unwrap();

        if let Some(entry) = cache.get_mut(&block_offset) {
            // 更新访问顺序
            let mut counter = self.state.access_counter.lock().unwrap();
            *counter += 1;
            entry.access_order = *counter;

            // 计算在缓存块中的偏移
            let offset_in_block = (offset - block_offset) as usize;
            let available = entry.data.len().saturating_sub(offset_in_block);
            let read_size = (size as usize).min(available);

            if read_size > 0 {
                self.state.stats.lock().unwrap().cache_hits += 1;
                return Some(entry.data[offset_in_block..offset_in_block + read_size].to_vec());
            }
        }

        None
    }

    /// 将数据写入缓存
    fn write_to_cache(&self, offset: u64, data: Vec<u8>) {
        let block_offset = Self::cache_block_offset(offset);
        let mut cache = self.state.cache.lock().unwrap();

        // 如果缓存已满，删除最旧的条目
        while cache.len() >= MAX_CACHE_BLOCKS {
            let oldest_key = cache
                .iter()
                .min_by_key(|(_, v)| v.access_order)
                .map(|(k, _)| *k);

            if let Some(key) = oldest_key {
                cache.remove(&key);
            } else {
                break;
            }
        }

        let mut counter = self.state.access_counter.lock().unwrap();
        *counter += 1;

        cache.insert(
            block_offset,
            CacheEntry {
                data,
                access_order: *counter,
            },
        );
    }

    /// 从 JavaScript 获取数据块
    ///
    /// 这个方法发送请求到 JS，然后阻塞等待响应。
    /// JS 端需要在获取数据后调用 completeRequest 来发送响应。
    fn fetch_block(&self, offset: u64, size: u32) -> io::Result<Vec<u8>> {
        // 先检查缓存
        if let Some(data) = self.read_from_cache(offset, size) {
            return Ok(data);
        }

        self.state.stats.lock().unwrap().cache_misses += 1;
        self.state.stats.lock().unwrap().total_requests += 1;

        // 计算要获取的块大小（至少获取一个缓存块大小）
        let block_offset = Self::cache_block_offset(offset);
        let remaining = self.file_size.saturating_sub(block_offset);
        let fetch_size = CACHE_BLOCK_SIZE.min(remaining) as u32;

        if fetch_size == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("fetch_size is 0: offset={}, block_offset={}, file_size={}", offset, block_offset, self.file_size),
            ));
        }

        // 创建 channel 用于接收响应
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

        // 生成请求 ID 并注册
        let request_id = self.state.next_id();
        self.state.register_request(request_id, tx);

        let request = BlockRequest {
            offset: block_offset,
            size: fetch_size,
            request_id,
        };

        // 发送请求到 JS（非阻塞）
        let status = self.fetcher.call(Ok(request), ThreadsafeFunctionCallMode::NonBlocking);

        if status != napi::Status::Ok {
            // 移除待处理的请求
            self.state.pending_requests.lock().unwrap().remove(&request_id);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ThreadsafeFunction call failed with status: {:?}", status),
            ));
        }

        // 阻塞等待响应（超时 30 秒）
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|e| {
                // 移除待处理的请求
                self.state.pending_requests.lock().unwrap().remove(&request_id);
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("Timeout waiting for JS response: {}", e),
                )
            })?;

        match result {
            Ok(data) => {
                self.state.stats.lock().unwrap().total_bytes_fetched += data.len() as u64;

                // 写入缓存
                self.write_to_cache(block_offset, data.clone());

                // 返回请求的部分
                let offset_in_block = (offset - block_offset) as usize;
                let available = data.len().saturating_sub(offset_in_block);
                let read_size = (size as usize).min(available);

                Ok(data[offset_in_block..offset_in_block + read_size].to_vec())
            }
            Err(e) => Err(io::Error::new(
                io::ErrorKind::Other,
                format!("Failed to fetch block: {}", e),
            )),
        }
    }
}

impl Read for JsFileStreamer {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.file_size {
            return Ok(0);
        }

        let remaining = self.file_size - self.position;
        let to_read = (buf.len() as u64).min(remaining) as u32;

        if to_read == 0 {
            return Ok(0);
        }

        let data = self.fetch_block(self.position, to_read)?;
        let bytes_read = data.len();

        buf[..bytes_read].copy_from_slice(&data);
        self.position += bytes_read as u64;

        Ok(bytes_read)
    }
}

impl Seek for JsFileStreamer {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::End(offset) => self.file_size as i64 + offset,
            SeekFrom::Current(offset) => self.position as i64 + offset,
        };

        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Seek to negative position",
            ));
        }

        self.position = new_pos as u64;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_block_offset() {
        assert_eq!(JsFileStreamer::cache_block_offset(0), 0);
        assert_eq!(JsFileStreamer::cache_block_offset(100), 0);
        assert_eq!(
            JsFileStreamer::cache_block_offset(CACHE_BLOCK_SIZE),
            CACHE_BLOCK_SIZE
        );
        assert_eq!(
            JsFileStreamer::cache_block_offset(CACHE_BLOCK_SIZE + 100),
            CACHE_BLOCK_SIZE
        );
    }
}
