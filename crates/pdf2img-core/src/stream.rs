//! HTTP streaming for PDF loading
//!
//! Implements Read + Seek trait for streaming PDF data via HTTP Range requests.

use crate::error::{Error, Result};
use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

/// Cache block size (256KB)
const CACHE_BLOCK_SIZE: u64 = 256 * 1024;

/// Maximum cache blocks
const MAX_CACHE_BLOCKS: usize = 64;

/// HTTP client for streaming (blocking)
static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::blocking::Client> =
    once_cell::sync::Lazy::new(|| {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client")
    });

/// Download entire file
pub async fn download_file(url: &str) -> Result<Vec<u8>> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| Error::HttpError(e.to_string()))?;

    if !response.status().is_success() {
        return Err(Error::HttpError(format!(
            "HTTP {} from {}",
            response.status(),
            url
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| Error::HttpError(e.to_string()))?;

    Ok(bytes.to_vec())
}

/// Cache entry
struct CacheEntry {
    data: Vec<u8>,
    access_order: u64,
}

/// Stream reader stats
#[derive(Debug, Default, Clone)]
pub struct StreamStats {
    pub total_requests: u32,
    pub cache_hits: u32,
    pub cache_misses: u32,
    pub total_bytes_fetched: u64,
}

/// Stream reader for HTTP Range requests
///
/// Implements Read + Seek to allow PDFium to load PDF data on-demand.
pub struct StreamReader {
    url: String,
    file_size: u64,
    position: u64,
    cache: Arc<Mutex<HashMap<u64, CacheEntry>>>,
    access_counter: Arc<Mutex<u64>>,
    stats: Arc<Mutex<StreamStats>>,
}

impl StreamReader {
    /// Create new stream reader
    pub async fn new(url: &str) -> Result<Self> {
        // Get file size via HEAD request
        let response = reqwest::Client::new()
            .head(url)
            .send()
            .await
            .map_err(|e| Error::HttpError(e.to_string()))?;

        if !response.status().is_success() {
            return Err(Error::HttpError(format!(
                "HTTP {} from HEAD request",
                response.status()
            )));
        }

        // Check if server supports range requests
        let accept_ranges = response
            .headers()
            .get("accept-ranges")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if accept_ranges != "bytes" {
            tracing::warn!("Server may not support range requests");
        }

        let file_size = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| Error::HttpError("Missing content-length header".to_string()))?;

        Ok(Self {
            url: url.to_string(),
            file_size,
            position: 0,
            cache: Arc::new(Mutex::new(HashMap::new())),
            access_counter: Arc::new(Mutex::new(0)),
            stats: Arc::new(Mutex::new(StreamStats::default())),
        })
    }

    /// Get file size
    pub fn file_size(&self) -> u64 {
        self.file_size
    }

    /// Get stats
    pub fn stats(&self) -> StreamStats {
        self.stats.lock().unwrap().clone()
    }

    /// Calculate cache block offset
    fn cache_block_offset(offset: u64) -> u64 {
        (offset / CACHE_BLOCK_SIZE) * CACHE_BLOCK_SIZE
    }

    /// Read from cache
    fn read_from_cache(&self, offset: u64, size: u32) -> Option<Vec<u8>> {
        let block_offset = Self::cache_block_offset(offset);
        let mut cache = self.cache.lock().unwrap();

        if let Some(entry) = cache.get_mut(&block_offset) {
            // Update access order
            let mut counter = self.access_counter.lock().unwrap();
            *counter += 1;
            entry.access_order = *counter;

            // Calculate offset within block
            let offset_in_block = (offset - block_offset) as usize;
            let available = entry.data.len().saturating_sub(offset_in_block);
            let read_size = (size as usize).min(available);

            if read_size > 0 {
                self.stats.lock().unwrap().cache_hits += 1;
                return Some(entry.data[offset_in_block..offset_in_block + read_size].to_vec());
            }
        }

        None
    }

    /// Write to cache
    fn write_to_cache(&self, offset: u64, data: Vec<u8>) {
        let block_offset = Self::cache_block_offset(offset);
        let mut cache = self.cache.lock().unwrap();

        // Evict oldest entries if cache is full
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

        let mut counter = self.access_counter.lock().unwrap();
        *counter += 1;

        cache.insert(
            block_offset,
            CacheEntry {
                data,
                access_order: *counter,
            },
        );
    }

    /// Fetch block from server
    fn fetch_block(&self, offset: u64, size: u32) -> io::Result<Vec<u8>> {
        // Check cache first
        if let Some(data) = self.read_from_cache(offset, size) {
            return Ok(data);
        }

        self.stats.lock().unwrap().cache_misses += 1;
        self.stats.lock().unwrap().total_requests += 1;

        // Calculate block to fetch
        let block_offset = Self::cache_block_offset(offset);
        let remaining = self.file_size.saturating_sub(block_offset);
        let fetch_size = CACHE_BLOCK_SIZE.min(remaining);

        if fetch_size == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "No more data to fetch",
            ));
        }

        // Fetch via HTTP Range request
        let end = block_offset + fetch_size - 1;
        let range_header = format!("bytes={}-{}", block_offset, end);

        let response = HTTP_CLIENT
            .get(&self.url)
            .header("Range", &range_header)
            .send()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

        if !response.status().is_success() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("HTTP {} fetching range {}", response.status(), range_header),
            ));
        }

        let data = response
            .bytes()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
            .to_vec();

        self.stats.lock().unwrap().total_bytes_fetched += data.len() as u64;

        // Write to cache
        self.write_to_cache(block_offset, data.clone());

        // Return requested portion
        let offset_in_block = (offset - block_offset) as usize;
        let available = data.len().saturating_sub(offset_in_block);
        let read_size = (size as usize).min(available);

        Ok(data[offset_in_block..offset_in_block + read_size].to_vec())
    }
}

impl Read for StreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.file_size {
            return Ok(0);
        }

        let remaining = self.file_size - self.position;
        let to_read = (buf.len() as u64).min(remaining) as usize;

        if to_read == 0 {
            return Ok(0);
        }

        // Loop to read across cache block boundaries
        let mut total_read = 0;

        while total_read < to_read {
            let current_size = (to_read - total_read) as u32;
            let data = self.fetch_block(self.position, current_size)?;

            if data.is_empty() {
                break;
            }

            let bytes_read = data.len();
            buf[total_read..total_read + bytes_read].copy_from_slice(&data);
            self.position += bytes_read as u64;
            total_read += bytes_read;
        }

        Ok(total_read)
    }
}

impl Seek for StreamReader {
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
        assert_eq!(StreamReader::cache_block_offset(0), 0);
        assert_eq!(StreamReader::cache_block_offset(100), 0);
        assert_eq!(
            StreamReader::cache_block_offset(CACHE_BLOCK_SIZE),
            CACHE_BLOCK_SIZE
        );
        assert_eq!(
            StreamReader::cache_block_offset(CACHE_BLOCK_SIZE + 100),
            CACHE_BLOCK_SIZE
        );
    }
}
