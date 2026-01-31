// Package services contains the image processing utilities.
package services

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"

	"github.com/aman1117/backend/internal/logger"
	"github.com/disintegration/imaging"
	"golang.org/x/image/webp"
)

// ImageProcessor handles image validation, processing, and thumbnail generation
type ImageProcessor struct {
	maxFullSize      int // Max dimension for full-size image
	thumbnailSize    int // Dimension for thumbnail
	jpegQuality      int // JPEG quality (1-100)
	allowedMimeTypes map[string]bool
}

// NewImageProcessor creates a new ImageProcessor with default settings
func NewImageProcessor() *ImageProcessor {
	return &ImageProcessor{
		maxFullSize:   1080,
		thumbnailSize: 150,
		jpegQuality:   85,
		allowedMimeTypes: map[string]bool{
			"image/jpeg": true,
			"image/png":  true,
			"image/webp": true,
			"image/heic": true,
			"image/heif": true,
		},
	}
}

// ProcessedImages contains both full-size and thumbnail versions
type ProcessedImages struct {
	Full      io.Reader
	Thumbnail io.Reader
	FullSize  int64
	ThumbSize int64
	MimeType  string
}

// ValidateMagicBytes checks if the file is a valid image by reading magic bytes
func (p *ImageProcessor) ValidateMagicBytes(file multipart.File) (string, error) {
	// Read first 12 bytes for magic number detection
	header := make([]byte, 12)
	_, err := file.Read(header)
	if err != nil {
		return "", fmt.Errorf("failed to read file header: %w", err)
	}

	// Reset file position
	if _, err := file.Seek(0, 0); err != nil {
		return "", fmt.Errorf("failed to reset file position: %w", err)
	}

	// Check magic bytes
	switch {
	case bytes.HasPrefix(header, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg", nil
	case bytes.HasPrefix(header, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png", nil
	case bytes.HasPrefix(header, []byte{0x52, 0x49, 0x46, 0x46}) && bytes.Contains(header[8:], []byte{0x57, 0x45, 0x42, 0x50}):
		return "image/webp", nil
	case bytes.HasPrefix(header, []byte{0x00, 0x00, 0x00}) && (header[4] == 0x66 || header[4] == 0x68):
		// HEIC/HEIF detection (ftyp box)
		return "image/heic", nil
	default:
		return "", fmt.Errorf("unsupported image format")
	}
}

// Process validates and processes an image, returning full-size and thumbnail versions
// It validates magic bytes, strips EXIF, resizes, and generates thumbnail
func (p *ImageProcessor) Process(file multipart.File, fileHeader *multipart.FileHeader) (*ProcessedImages, error) {
	// Validate file extension
	ext := strings.ToLower(filepath.Ext(fileHeader.Filename))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" && ext != ".heic" && ext != ".heif" {
		return nil, fmt.Errorf("unsupported file extension: %s", ext)
	}

	// Validate magic bytes
	mimeType, err := p.ValidateMagicBytes(file)
	if err != nil {
		return nil, fmt.Errorf("invalid image file: %w", err)
	}

	if !p.allowedMimeTypes[mimeType] {
		return nil, fmt.Errorf("unsupported mime type: %s", mimeType)
	}

	// Decode image based on detected type
	var img image.Image
	switch mimeType {
	case "image/jpeg":
		img, err = jpeg.Decode(file)
	case "image/png":
		img, err = png.Decode(file)
	case "image/webp":
		img, err = webp.Decode(file)
	case "image/heic", "image/heif":
		// HEIC requires special handling - for now, reject and ask for conversion
		return nil, fmt.Errorf("HEIC/HEIF images are not yet supported, please convert to JPEG or PNG")
	default:
		return nil, fmt.Errorf("unsupported image type: %s", mimeType)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to decode image: %w", err)
	}

	// Get original dimensions
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	logger.Sugar.Debugw("Processing image",
		"original_width", width,
		"original_height", height,
		"mime_type", mimeType,
	)

	// Resize full image if needed (maintain aspect ratio)
	var fullImg image.Image
	if width > p.maxFullSize || height > p.maxFullSize {
		if width > height {
			fullImg = imaging.Resize(img, p.maxFullSize, 0, imaging.Lanczos)
		} else {
			fullImg = imaging.Resize(img, 0, p.maxFullSize, imaging.Lanczos)
		}
	} else {
		fullImg = img
	}

	// Generate thumbnail (square crop from center, then resize)
	var thumbImg image.Image
	minDim := width
	if height < width {
		minDim = height
	}
	// Crop to square from center
	thumbImg = imaging.CropCenter(img, minDim, minDim)
	// Resize to thumbnail size
	thumbImg = imaging.Resize(thumbImg, p.thumbnailSize, p.thumbnailSize, imaging.Lanczos)

	// Encode full image to JPEG (strips EXIF automatically)
	var fullBuf bytes.Buffer
	if err := jpeg.Encode(&fullBuf, fullImg, &jpeg.Options{Quality: p.jpegQuality}); err != nil {
		return nil, fmt.Errorf("failed to encode full image: %w", err)
	}

	// Encode thumbnail to JPEG
	var thumbBuf bytes.Buffer
	if err := jpeg.Encode(&thumbBuf, thumbImg, &jpeg.Options{Quality: p.jpegQuality}); err != nil {
		return nil, fmt.Errorf("failed to encode thumbnail: %w", err)
	}

	fullSize := int64(fullBuf.Len())
	thumbSize := int64(thumbBuf.Len())

	logger.Sugar.Debugw("Image processed successfully",
		"full_size_bytes", fullSize,
		"thumb_size_bytes", thumbSize,
		"full_dimensions", fmt.Sprintf("%dx%d", fullImg.Bounds().Dx(), fullImg.Bounds().Dy()),
		"thumb_dimensions", fmt.Sprintf("%dx%d", thumbImg.Bounds().Dx(), thumbImg.Bounds().Dy()),
	)

	return &ProcessedImages{
		Full:      bytes.NewReader(fullBuf.Bytes()),
		Thumbnail: bytes.NewReader(thumbBuf.Bytes()),
		FullSize:  fullSize,
		ThumbSize: thumbSize,
		MimeType:  "image/jpeg", // Always output JPEG
	}, nil
}
