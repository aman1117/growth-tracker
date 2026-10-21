package services

import (
	"bytes"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Magic-byte headers of formats that cannot be produced with the standard library.
var (
	webpHeader = []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")
	heicHeader = []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00")
)

func TestImageProcessor_ValidateMagicBytes(t *testing.T) {
	p := NewImageProcessor()

	formats := map[string][]byte{
		"image/jpeg": jpegBytes(t, 4, 4),
		"image/png":  pngBytes(t, 4, 4),
		"image/webp": webpHeader,
		"image/heic": heicHeader,
	}
	for want, data := range formats {
		file := newMemFile(data)
		got, err := p.ValidateMagicBytes(file)
		require.NoError(t, err, want)
		assert.Equal(t, want, got)
		pos, _ := file.Seek(0, io.SeekCurrent)
		assert.Zero(t, pos, "%s: the file is rewound for decoding", want)
	}

	_, err := p.ValidateMagicBytes(newMemFile([]byte("GIF89a......")))
	assert.EqualError(t, err, "unsupported image format")
	_, err = p.ValidateMagicBytes(newMemFile(nil))
	assert.ErrorContains(t, err, "failed to read file header")
	_, err = p.ValidateMagicBytes(unseekableFile{newMemFile(pngBytes(t, 4, 4))})
	assert.ErrorContains(t, err, "failed to reset file position")
}

func TestImageProcessor_Process(t *testing.T) {
	p := NewImageProcessorWithOptions(64, 16, 80)

	cases := []struct {
		name         string
		data         []byte
		filename     string
		fullW, fullH int
	}{
		{"landscape is scaled to the maximum width", pngBytes(t, 200, 100), "wide.PNG", 64, 32},
		{"portrait is scaled to the maximum height", jpegBytes(t, 40, 160), "tall.jpeg", 16, 64},
		{"small images keep their size", jpegBytes(t, 30, 20), "small.jpg", 30, 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := p.Process(newMemFile(tc.data), fileHeader(tc.filename, len(tc.data)))
			require.NoError(t, err)
			assert.Equal(t, "image/jpeg", out.MimeType, "output is always JPEG")

			full, err := io.ReadAll(out.Full)
			require.NoError(t, err)
			assert.EqualValues(t, len(full), out.FullSize)
			img := decodeJPEG(t, bytes.NewReader(full))
			assert.Equal(t, [2]int{tc.fullW, tc.fullH}, [2]int{img.Bounds().Dx(), img.Bounds().Dy()})

			thumb, err := io.ReadAll(out.Thumbnail)
			require.NoError(t, err)
			assert.EqualValues(t, len(thumb), out.ThumbSize)
			img = decodeJPEG(t, bytes.NewReader(thumb))
			assert.Equal(t, [2]int{16, 16}, [2]int{img.Bounds().Dx(), img.Bounds().Dy()}, "square thumbnail")
		})
	}
}

func TestImageProcessor_ProcessDefaults(t *testing.T) {
	data := jpegBytes(t, 1200, 600)
	out, err := NewImageProcessor().Process(newMemFile(data), fileHeader("photo.jpg", len(data)))
	require.NoError(t, err)

	full := decodeJPEG(t, out.Full)
	assert.Equal(t, [2]int{1080, 540}, [2]int{full.Bounds().Dx(), full.Bounds().Dy()})
	thumb := decodeJPEG(t, out.Thumbnail)
	assert.Equal(t, [2]int{150, 150}, [2]int{thumb.Bounds().Dx(), thumb.Bounds().Dy()})
}

func TestImageProcessor_ProcessRejectsInvalidInput(t *testing.T) {
	p := NewImageProcessor()
	jpg := jpegBytes(t, 8, 8)

	cases := []struct {
		name     string
		filename string
		data     []byte
		want     string
	}{
		{"unsupported extension", "anim.gif", jpg, "unsupported file extension: .gif"},
		{"missing extension", "photo", jpg, "unsupported file extension: "},
		{"not an image", "notes.jpg", []byte("just some text, no image"), "invalid image file: unsupported image format"},
		{"HEIC", "phone.heic", heicHeader, "HEIC/HEIF images are not yet supported, please convert to JPEG or PNG"},
		{"corrupt JPEG", "broken.jpg", append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{0x42}, 32)...), "failed to decode image"},
		{"WebP header without image data", "fake.webp", webpHeader, "failed to decode image"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := p.Process(newMemFile(tc.data), fileHeader(tc.filename, len(tc.data)))
			assert.Nil(t, out)
			assert.ErrorContains(t, err, tc.want)
		})
	}

	t.Run("format not allowed", func(t *testing.T) {
		pngOnly := NewImageProcessor()
		pngOnly.allowedMimeTypes = map[string]bool{"image/png": true}
		_, err := pngOnly.Process(newMemFile(jpg), fileHeader("photo.jpg", len(jpg)))
		assert.EqualError(t, err, "unsupported mime type: image/jpeg")
	})

	t.Run("image too large to encode", func(t *testing.T) {
		// JPEG is limited to 65535 pixels per side; with a larger maximum size nothing is scaled down.
		wide := pngBytes(t, 1<<16, 1)
		_, err := NewImageProcessorWithOptions(1<<17, 16, 80).Process(newMemFile(wide), fileHeader("wide.png", len(wide)))
		assert.ErrorContains(t, err, "failed to encode full image")
	})
}
