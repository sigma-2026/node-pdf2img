// Package pdf2img provides Go bindings for the pdf2img library.
//
// This package wraps the pdf2img Rust library via CGO, providing high-performance
// PDF to image conversion using PDFium.
//
// # Example
//
//	package main
//
//	import (
//		"fmt"
//		"os"
//
//		"github.com/nicepkg/pdf2img/go"
//	)
//
//	func main() {
//		// Check if PDFium is available
//		if !pdf2img.IsAvailable() {
//			fmt.Println("PDFium not available")
//			os.Exit(1)
//		}
//
//		// Convert PDF to images
//		result, err := pdf2img.ConvertFile("document.pdf", &pdf2img.Options{
//			Format:      pdf2img.FormatWebP,
//			TargetWidth: 1280,
//			Quality:     80,
//		})
//		if err != nil {
//			fmt.Printf("Conversion failed: %v\n", err)
//			os.Exit(1)
//		}
//		defer result.Free()
//
//		// Save pages
//		for _, page := range result.Pages {
//			if page.Success {
//				filename := fmt.Sprintf("page_%d.webp", page.PageNum)
//				os.WriteFile(filename, page.Data, 0644)
//				fmt.Printf("Saved %s (%dx%d)\n", filename, page.Width, page.Height)
//			}
//		}
//	}
package pdf2img

/*
#cgo LDFLAGS: -L${SRCDIR}/../target/release -lpdf2img -lm -ldl -lpthread
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security
#cgo windows LDFLAGS: -lws2_32 -luserenv -lbcrypt

#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

// Forward declarations of FFI functions
typedef struct {
    uint32_t page_num;
    uint32_t width;
    uint32_t height;
    uint8_t* data;
    size_t data_len;
    bool success;
    char* error;
    uint32_t render_time_ms;
    uint32_t encode_time_ms;
} Pdf2ImgPageResult;

typedef struct {
    bool success;
    char* error;
    uint32_t total_pages;
    Pdf2ImgPageResult* pages;
    size_t pages_len;
    uint32_t total_time_ms;
} Pdf2ImgResult;

typedef struct {
    uint32_t format;
    uint32_t mode;
    uint32_t target_width;
    uint32_t quality;
    uint32_t* pages;
    size_t pages_len;
    bool detect_scan;
} Pdf2ImgOptions;

extern Pdf2ImgResult* pdf2img_convert_file(const char* path, const Pdf2ImgOptions* options);
extern Pdf2ImgResult* pdf2img_convert_url(const char* url, const Pdf2ImgOptions* options);
extern Pdf2ImgResult* pdf2img_convert_buffer(const uint8_t* data, size_t data_len, const Pdf2ImgOptions* options);
extern int32_t pdf2img_get_page_count(const char* path);
extern int32_t pdf2img_get_page_count_buffer(const uint8_t* data, size_t data_len);
extern bool pdf2img_is_available();
extern const char* pdf2img_get_version();
extern int32_t pdf2img_warmup();
extern void pdf2img_free_result(Pdf2ImgResult* result);
extern void pdf2img_free_string(char* s);
*/
import "C"
import (
	"errors"
	"unsafe"
)

// OutputFormat specifies the output image format
type OutputFormat uint32

const (
	// FormatWebP outputs WebP format (default, best compression)
	FormatWebP OutputFormat = 0
	// FormatPNG outputs PNG format (lossless)
	FormatPNG OutputFormat = 1
	// FormatJPEG outputs JPEG format (lossy, no alpha)
	FormatJPEG OutputFormat = 2
)

// RenderMode specifies the rendering mode
type RenderMode uint32

const (
	// ModeNative loads entire PDF into memory (best for local/small files)
	ModeNative RenderMode = 0
	// ModeNativeStream streams PDF via HTTP Range requests (best for large remote files)
	ModeNativeStream RenderMode = 1
)

// Options configures PDF conversion
type Options struct {
	// Format specifies output image format (default: FormatWebP)
	Format OutputFormat
	// Mode specifies render mode (default: ModeNative)
	Mode RenderMode
	// TargetWidth specifies target render width (default: 1280)
	TargetWidth uint32
	// Quality specifies image quality 0-100 (default: 80)
	Quality uint32
	// Pages specifies which pages to render (empty = all pages)
	Pages []uint32
	// DetectScan enables scan detection for optimizing scanned documents
	DetectScan bool
}

// DefaultOptions returns default conversion options
func DefaultOptions() *Options {
	return &Options{
		Format:      FormatWebP,
		Mode:        ModeNative,
		TargetWidth: 1280,
		Quality:     80,
		Pages:       nil,
		DetectScan:  true,
	}
}

// PageResult contains the result of rendering a single page
type PageResult struct {
	// PageNum is the page number (1-based)
	PageNum uint32
	// Width is the image width
	Width uint32
	// Height is the image height
	Height uint32
	// Data is the encoded image data
	Data []byte
	// Success indicates whether rendering succeeded
	Success bool
	// Error contains the error message if failed
	Error string
	// RenderTimeMs is the render time in milliseconds
	RenderTimeMs uint32
	// EncodeTimeMs is the encode time in milliseconds
	EncodeTimeMs uint32
}

// Result contains the result of a PDF conversion
type Result struct {
	// Success indicates whether conversion succeeded
	Success bool
	// Error contains the error message if failed
	Error string
	// TotalPages is the total number of pages in the PDF
	TotalPages uint32
	// Pages contains the rendered pages
	Pages []PageResult
	// TotalTimeMs is the total conversion time in milliseconds
	TotalTimeMs uint32

	// cResult holds the C result pointer for freeing
	cResult *C.Pdf2ImgResult
}

// Free releases the memory associated with the result.
// This should be called when the result is no longer needed.
func (r *Result) Free() {
	if r.cResult != nil {
		C.pdf2img_free_result(r.cResult)
		r.cResult = nil
	}
}

// ConvertFile converts a PDF file to images
func ConvertFile(path string, opts *Options) (*Result, error) {
	if opts == nil {
		opts = DefaultOptions()
	}

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	cOpts := buildCOptions(opts)
	defer freeCOptions(cOpts)

	cResult := C.pdf2img_convert_file(cPath, cOpts)
	return convertResult(cResult)
}

// ConvertURL converts a PDF from URL to images
func ConvertURL(url string, opts *Options) (*Result, error) {
	if opts == nil {
		opts = DefaultOptions()
	}

	cURL := C.CString(url)
	defer C.free(unsafe.Pointer(cURL))

	cOpts := buildCOptions(opts)
	defer freeCOptions(cOpts)

	cResult := C.pdf2img_convert_url(cURL, cOpts)
	return convertResult(cResult)
}

// ConvertBuffer converts a PDF from memory buffer to images
func ConvertBuffer(data []byte, opts *Options) (*Result, error) {
	if len(data) == 0 {
		return nil, errors.New("data is empty")
	}

	if opts == nil {
		opts = DefaultOptions()
	}

	cOpts := buildCOptions(opts)
	defer freeCOptions(cOpts)

	cResult := C.pdf2img_convert_buffer(
		(*C.uint8_t)(unsafe.Pointer(&data[0])),
		C.size_t(len(data)),
		cOpts,
	)
	return convertResult(cResult)
}

// GetPageCount returns the number of pages in a PDF file
func GetPageCount(path string) (int, error) {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	count := int(C.pdf2img_get_page_count(cPath))
	if count < 0 {
		return 0, errors.New("failed to get page count")
	}
	return count, nil
}

// GetPageCountFromBuffer returns the number of pages in a PDF buffer
func GetPageCountFromBuffer(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, errors.New("data is empty")
	}

	count := int(C.pdf2img_get_page_count_buffer(
		(*C.uint8_t)(unsafe.Pointer(&data[0])),
		C.size_t(len(data)),
	))
	if count < 0 {
		return 0, errors.New("failed to get page count")
	}
	return count, nil
}

// IsAvailable returns whether PDFium is available
func IsAvailable() bool {
	return bool(C.pdf2img_is_available())
}

// GetVersion returns the library version
func GetVersion() string {
	return C.GoString(C.pdf2img_get_version())
}

// Warmup pre-loads PDFium to avoid cold start latency.
// Returns warmup time in milliseconds.
func Warmup() (int, error) {
	time := int(C.pdf2img_warmup())
	if time < 0 {
		return 0, errors.New("warmup failed")
	}
	return time, nil
}

// buildCOptions creates C options from Go options
func buildCOptions(opts *Options) *C.Pdf2ImgOptions {
	cOpts := (*C.Pdf2ImgOptions)(C.malloc(C.sizeof_Pdf2ImgOptions))
	cOpts.format = C.uint32_t(opts.Format)
	cOpts.mode = C.uint32_t(opts.Mode)
	cOpts.target_width = C.uint32_t(opts.TargetWidth)
	cOpts.quality = C.uint32_t(opts.Quality)
	cOpts.detect_scan = C.bool(opts.DetectScan)

	if len(opts.Pages) > 0 {
		cPages := C.malloc(C.size_t(len(opts.Pages)) * C.sizeof_uint32_t)
		for i, p := range opts.Pages {
			*(*C.uint32_t)(unsafe.Pointer(uintptr(cPages) + uintptr(i)*C.sizeof_uint32_t)) = C.uint32_t(p)
		}
		cOpts.pages = (*C.uint32_t)(cPages)
		cOpts.pages_len = C.size_t(len(opts.Pages))
	} else {
		cOpts.pages = nil
		cOpts.pages_len = 0
	}

	return cOpts
}

// freeCOptions frees C options
func freeCOptions(cOpts *C.Pdf2ImgOptions) {
	if cOpts == nil {
		return
	}
	if cOpts.pages != nil {
		C.free(unsafe.Pointer(cOpts.pages))
	}
	C.free(unsafe.Pointer(cOpts))
}

// convertResult converts C result to Go result
func convertResult(cResult *C.Pdf2ImgResult) (*Result, error) {
	if cResult == nil {
		return nil, errors.New("null result from library")
	}

	result := &Result{
		Success:     bool(cResult.success),
		TotalPages:  uint32(cResult.total_pages),
		TotalTimeMs: uint32(cResult.total_time_ms),
		cResult:     cResult,
	}

	if cResult.error != nil {
		result.Error = C.GoString(cResult.error)
	}

	// Convert pages
	if cResult.pages != nil && cResult.pages_len > 0 {
		result.Pages = make([]PageResult, cResult.pages_len)
		cPages := unsafe.Slice(cResult.pages, cResult.pages_len)

		for i, cPage := range cPages {
			page := PageResult{
				PageNum:      uint32(cPage.page_num),
				Width:        uint32(cPage.width),
				Height:       uint32(cPage.height),
				Success:      bool(cPage.success),
				RenderTimeMs: uint32(cPage.render_time_ms),
				EncodeTimeMs: uint32(cPage.encode_time_ms),
			}

			if cPage.error != nil {
				page.Error = C.GoString(cPage.error)
			}

			// Copy data to Go slice
			if cPage.data != nil && cPage.data_len > 0 {
				page.Data = C.GoBytes(unsafe.Pointer(cPage.data), C.int(cPage.data_len))
			}

			result.Pages[i] = page
		}
	}

	if !result.Success && result.Error != "" {
		return result, errors.New(result.Error)
	}

	return result, nil
}
