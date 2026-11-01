//! Image validation, resizing and thumbnail generation (port of
//! `internal/services/image_processor.go`, which used `disintegration/imaging`).
//!
//! Output parity with Go: EXIF orientation applied to JPEG input, full image scaled with
//! Lanczos so its longer side is at most `max_full_size` (never upscaled), a centered square
//! crop scaled to `thumbnail_size`, both encoded as baseline JPEG (4:2:0, IJG quality scaling)
//! at `jpeg_quality`. Transparent pixels are composited onto black, as Go's JPEG encoder does.

use std::io::Cursor;

use bytes::Bytes;
use gt_core::constants::is_allowed_image_extension;
use image::imageops::{self, FilterType};
use image::metadata::Orientation;
use image::{DynamicImage, GrayImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Rgb, RgbImage};
use jpeg_encoder::{ColorType, Encoder};

use crate::validation::file_extension;

pub const MIME_JPEG: &str = "image/jpeg";
pub const MIME_PNG: &str = "image/png";
pub const MIME_WEBP: &str = "image/webp";
pub const MIME_HEIC: &str = "image/heic";
pub const MIME_HEIF: &str = "image/heif";

/// Formats accepted by default (HEIC/HEIF pass validation but are rejected when decoding).
pub const DEFAULT_ALLOWED_MIME_TYPES: &[&str] = &[MIME_JPEG, MIME_PNG, MIME_WEBP, MIME_HEIC, MIME_HEIF];

/// JPEG cannot store images with a side of 65536 pixels or more.
const JPEG_MAX_DIMENSION: u32 = 1 << 16;

/// Why an upload could not be processed. The messages are the Go error strings, which reach
/// clients (e.g. `Failed to process image: invalid image file: unsupported image format`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImageProcessError {
    #[error("unsupported file extension: {0}")]
    UnsupportedExtension(String),
    #[error("invalid image file: {0}")]
    InvalidImage(MagicBytesError),
    #[error("unsupported mime type: {0}")]
    UnsupportedMimeType(&'static str),
    #[error("HEIC/HEIF images are not yet supported, please convert to JPEG or PNG")]
    HeicNotSupported,
    #[error("failed to decode image: {0}")]
    Decode(String),
    #[error("failed to encode full image: {0}")]
    EncodeFull(String),
    #[error("failed to encode thumbnail: {0}")]
    EncodeThumbnail(String),
}

/// Magic-byte detection failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MagicBytesError {
    /// The file is empty (Go reads the header with `io.Reader.Read`, which returns `EOF`).
    #[error("failed to read file header: EOF")]
    EmptyFile,
    #[error("unsupported image format")]
    UnsupportedFormat,
}

/// The processed upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedImages {
    pub full: Bytes,
    pub thumbnail: Bytes,
    pub full_size: i64,
    pub thumb_size: i64,
    /// Always `image/jpeg`.
    pub mime_type: &'static str,
}

/// Validates and converts uploaded images.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageProcessor {
    max_full_size: u32,
    thumbnail_size: u32,
    jpeg_quality: u8,
    allowed_mime_types: Vec<&'static str>,
}

impl Default for ImageProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageProcessor {
    /// Activity photo settings: 1080 px, 150 px thumbnails, quality 85 (Go `NewImageProcessor`).
    pub fn new() -> Self {
        Self::with_options(1080, 150, 85)
    }

    /// Profile picture settings: 1080 px, 200 px thumbnails, quality 85.
    pub fn profile_picture() -> Self {
        Self::with_options(1080, 200, 85)
    }

    /// Go `NewImageProcessorWithOptions`.
    pub fn with_options(max_full_size: u32, thumbnail_size: u32, jpeg_quality: u8) -> Self {
        Self { max_full_size, thumbnail_size, jpeg_quality, allowed_mime_types: DEFAULT_ALLOWED_MIME_TYPES.to_vec() }
    }

    /// Restricts the accepted (magic-byte detected) formats.
    pub fn with_allowed_mime_types(mut self, mime_types: &[&'static str]) -> Self {
        self.allowed_mime_types = mime_types.to_vec();
        self
    }

    /// Detects the format from the first 12 bytes (shorter files are zero-padded, like the Go
    /// header buffer).
    pub fn validate_magic_bytes(data: &[u8]) -> Result<&'static str, MagicBytesError> {
        if data.is_empty() {
            return Err(MagicBytesError::EmptyFile);
        }
        let mut header = [0u8; 12];
        let n = data.len().min(header.len());
        header[..n].copy_from_slice(&data[..n]);

        if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Ok(MIME_JPEG)
        } else if header.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            Ok(MIME_PNG)
        } else if header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
            Ok(MIME_WEBP)
        } else if header.starts_with(&[0, 0, 0]) && (header[4] == b'f' || header[4] == b'h') {
            // HEIC/HEIF `ftyp` box.
            Ok(MIME_HEIC)
        } else {
            Err(MagicBytesError::UnsupportedFormat)
        }
    }

    /// Validates `data` (named `filename` by the client), then produces the resized JPEG and
    /// its square thumbnail. CPU-bound: call it from a blocking task.
    pub fn process(&self, data: &[u8], filename: &str) -> Result<ProcessedImages, ImageProcessError> {
        let ext = file_extension(filename);
        if !is_allowed_image_extension(&ext) {
            return Err(ImageProcessError::UnsupportedExtension(ext));
        }
        let mime_type = Self::validate_magic_bytes(data).map_err(ImageProcessError::InvalidImage)?;
        if !self.allowed_mime_types.contains(&mime_type) {
            return Err(ImageProcessError::UnsupportedMimeType(mime_type));
        }
        let format = match mime_type {
            MIME_JPEG => ImageFormat::Jpeg,
            MIME_PNG => ImageFormat::Png,
            // Go's `image.Decode` only recognizes `RIFF????WEBPVP8` as WebP.
            MIME_WEBP if data.get(12..15) != Some(b"VP8".as_slice()) => {
                return Err(ImageProcessError::Decode("image: unknown format".to_string()));
            }
            MIME_WEBP => ImageFormat::WebP,
            _ => return Err(ImageProcessError::HeicNotSupported),
        };
        let decoded = decode(data, format).map_err(|e| ImageProcessError::Decode(go_decode_error(&e)))?;
        let (width, height) = (decoded.image.width(), decoded.image.height());
        tracing::debug!(original_width = width, original_height = height, mime_type, "Processing image");

        let rgb = to_rgb_on_black(&decoded.image);
        let thumbnail = self.thumbnail(&rgb);
        let full = self.encode_full(&decoded, &rgb).map_err(ImageProcessError::EncodeFull)?;
        let thumb = encode_rgb(&thumbnail, self.jpeg_quality).map_err(ImageProcessError::EncodeThumbnail)?;

        let full_size = i64::try_from(full.len()).unwrap_or(i64::MAX);
        let thumb_size = i64::try_from(thumb.len()).unwrap_or(i64::MAX);
        tracing::debug!(full_size_bytes = full_size, thumb_size_bytes = thumb_size, "Image processed successfully");
        Ok(ProcessedImages {
            full: Bytes::from(full),
            thumbnail: Bytes::from(thumb),
            full_size,
            thumb_size,
            mime_type: MIME_JPEG,
        })
    }

    /// [`ImageProcessor::process`] on Tokio's blocking thread pool (decoding and resizing are
    /// CPU-bound and must not stall the async workers).
    pub async fn process_blocking(&self, data: Bytes, filename: String) -> Result<ProcessedImages, ImageProcessError> {
        let processor = self.clone();
        tokio::task::spawn_blocking(move || processor.process(&data, &filename))
            .await
            .unwrap_or_else(|e| Err(ImageProcessError::Decode(format!("image processing task failed: {e}"))))
    }

    /// Size of the full image: unchanged when both sides fit, otherwise the longer side
    /// (width when strictly wider) becomes `max_full_size`.
    pub fn full_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        let max = self.max_full_size;
        if width <= max && height <= max {
            (width, height)
        } else if width > height {
            (max, scaled_side(max, height, width))
        } else {
            (scaled_side(max, width, height), max)
        }
    }

    fn encode_full(&self, decoded: &Decoded, rgb: &RgbImage) -> Result<Vec<u8>, String> {
        let (width, height) = (rgb.width(), rgb.height());
        let (full_w, full_h) = self.full_dimensions(width, height);
        if (full_w, full_h) != (width, height) {
            let resized = imageops::resize(rgb, full_w, full_h, FilterType::Lanczos3);
            return encode_rgb(&resized, self.jpeg_quality);
        }
        // Go encodes the decoded image itself here, and its encoder writes 8-bit grayscale
        // images as single-channel JPEGs.
        match decoded.image.as_luma8() {
            Some(gray) if !decoded.oriented => encode_gray(gray, self.jpeg_quality),
            _ => encode_rgb(rgb, self.jpeg_quality),
        }
    }

    /// Centered square crop of the shorter side, scaled to `thumbnail_size` square.
    fn thumbnail(&self, rgb: &RgbImage) -> RgbImage {
        square_crop_resize(rgb, self.thumbnail_size)
    }
}

/// A `size` x `size` JPEG thumbnail of `image` at `quality`: centered square crop of the
/// shorter side, Lanczos-scaled (Go `imaging.CropCenter` + `imaging.Resize`, as in
/// `cmd/backfill_profile_thumbs`; no EXIF orientation).
pub fn square_thumbnail_jpeg(image: &DynamicImage, size: u32, quality: u8) -> Result<Vec<u8>, String> {
    encode_rgb(&square_crop_resize(&to_rgb_on_black(image), size), quality)
}

/// Centered square crop of the shorter side, scaled to `size` square (unchanged when the
/// crop already has that size).
fn square_crop_resize(rgb: &RgbImage, size: u32) -> RgbImage {
    let (width, height) = (rgb.width(), rgb.height());
    let side = width.min(height);
    let cropped = imageops::crop_imm(rgb, (width - side) / 2, (height - side) / 2, side, side).to_image();
    if side == size {
        cropped
    } else {
        imageops::resize(&cropped, size, size, FilterType::Lanczos3)
    }
}

/// A decoded image and whether an EXIF orientation transform was applied.
struct Decoded {
    image: DynamicImage,
    oriented: bool,
}

/// Decodes `data`; JPEG EXIF orientation is applied (Go `imaging.AutoOrientation(true)` only
/// reads JPEG EXIF).
fn decode(data: &[u8], format: ImageFormat) -> Result<Decoded, ImageError> {
    let mut decoder = ImageReader::with_format(Cursor::new(data), format).into_decoder()?;
    let orientation = if format == ImageFormat::Jpeg {
        decoder.orientation().unwrap_or(Orientation::NoTransforms)
    } else {
        Orientation::NoTransforms
    };
    let mut image = DynamicImage::from_decoder(decoder)?;
    let oriented = orientation != Orientation::NoTransforms;
    if oriented {
        image.apply_orientation(orientation);
    }
    Ok(Decoded { image, oriented })
}

/// imaging's aspect-preserving side: `max(1, floor(target * num / den + 0.5))`.
fn scaled_side(target: u32, numerator: u32, denominator: u32) -> u32 {
    let side = (f64::from(target) * f64::from(numerator) / f64::from(denominator) + 0.5).floor();
    // Bounded by `target * numerator / denominator` with numerator <= denominator.
    side.max(1.0) as u32
}

/// RGB with alpha premultiplied (Go's JPEG encoder reads premultiplied `RGBA()` values, which
/// composites transparent pixels onto black).
fn to_rgb_on_black(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        Rgb([premultiply(r, a), premultiply(g, a), premultiply(b, a)])
    })
}

/// `uint8(((c | c<<8) * a / 0xff) >> 8)`, exactly as Go computes it.
fn premultiply(channel: u8, alpha: u8) -> u8 {
    let value = (u32::from(channel) * 0x101 * u32::from(alpha) / 0xff) >> 8;
    u8::try_from(value).unwrap_or(u8::MAX)
}

fn encode_rgb(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    encode_jpeg(image.as_raw(), image.width(), image.height(), ColorType::Rgb, quality)
}

fn encode_gray(image: &GrayImage, quality: u8) -> Result<Vec<u8>, String> {
    encode_jpeg(image.as_raw(), image.width(), image.height(), ColorType::Luma, quality)
}

fn encode_jpeg(pixels: &[u8], width: u32, height: u32, color: ColorType, quality: u8) -> Result<Vec<u8>, String> {
    let too_large = || "jpeg: image is too large to encode".to_string();
    if width >= JPEG_MAX_DIMENSION || height >= JPEG_MAX_DIMENSION {
        return Err(too_large());
    }
    let (w, h) = (u16::try_from(width).map_err(|_| too_large())?, u16::try_from(height).map_err(|_| too_large())?);
    let mut out = Vec::with_capacity(pixels.len() / 8);
    Encoder::new(&mut out, quality.clamp(1, 100)).encode(pixels, w, h, color).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Decoder errors phrased like Go's where they commonly differ: truncated data is
/// `unexpected EOF`, unrecognized data `image: unknown format`.
fn go_decode_error(err: &ImageError) -> String {
    match err {
        ImageError::IoError(io) if io.kind() == std::io::ErrorKind::UnexpectedEof => "unexpected EOF".to_string(),
        ImageError::Unsupported(_) => "image: unknown format".to_string(),
        other => {
            let message = other.to_string();
            let lower = message.to_ascii_lowercase();
            let truncated = ["eof", "end of file", "no more bytes", "exhausted", "unexpected end", "not enough"]
                .iter()
                .any(|needle| lower.contains(needle));
            if truncated {
                "unexpected EOF".to_string()
            } else {
                message
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma, Rgba, RgbaImage};

    pub(crate) fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(width, height, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    pub(crate) fn jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(width, height, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 64]));
        encode_rgb(&img, 90).unwrap()
    }

    fn jpeg_with_orientation(width: u32, height: u32, orientation: u8) -> Vec<u8> {
        let jpeg = jpeg_bytes(width, height);
        // APP1 "Exif" segment: big-endian TIFF header, IFD0 with one SHORT entry 0x0112.
        let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0]);
        let len = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1, len[0], len[1]]);
        out.extend_from_slice(&exif);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    const WEBP_HEADER: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
    const HEIC_HEADER: &[u8] = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00";

    fn dims(jpeg: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn validate_magic_bytes() {
        assert_eq!(ImageProcessor::validate_magic_bytes(&jpeg_bytes(4, 4)), Ok(MIME_JPEG));
        assert_eq!(ImageProcessor::validate_magic_bytes(&png_bytes(4, 4)), Ok(MIME_PNG));
        assert_eq!(ImageProcessor::validate_magic_bytes(WEBP_HEADER), Ok(MIME_WEBP));
        assert_eq!(ImageProcessor::validate_magic_bytes(HEIC_HEADER), Ok(MIME_HEIC));
        assert_eq!(ImageProcessor::validate_magic_bytes(b"GIF89a......"), Err(MagicBytesError::UnsupportedFormat));
        assert_eq!(MagicBytesError::UnsupportedFormat.to_string(), "unsupported image format");
        assert_eq!(ImageProcessor::validate_magic_bytes(&[]), Err(MagicBytesError::EmptyFile));
        assert_eq!(MagicBytesError::EmptyFile.to_string(), "failed to read file header: EOF");
        assert_eq!(ImageProcessor::validate_magic_bytes(&[0xFF, 0xD8, 0xFF]), Ok(MIME_JPEG), "short files are padded");
    }

    #[test]
    fn process_scales_and_crops() {
        let p = ImageProcessor::with_options(64, 16, 80);
        let cases = [
            ("landscape is scaled to the maximum width", png_bytes(200, 100), "wide.PNG", (64, 32)),
            ("portrait is scaled to the maximum height", jpeg_bytes(40, 160), "tall.jpeg", (16, 64)),
            ("small images keep their size", jpeg_bytes(30, 20), "small.jpg", (30, 20)),
        ];
        for (name, data, filename, full) in cases {
            let out = p.process(&data, filename).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(out.mime_type, "image/jpeg", "{name}: output is always JPEG");
            assert_eq!(out.full_size, out.full.len() as i64, "{name}");
            assert_eq!(dims(&out.full), full, "{name}");
            assert_eq!(out.thumb_size, out.thumbnail.len() as i64, "{name}");
            assert_eq!(dims(&out.thumbnail), (16, 16), "{name}: square thumbnail");
        }
    }

    #[test]
    fn process_defaults() {
        let data = jpeg_bytes(1200, 600);
        let out = ImageProcessor::new().process(&data, "photo.jpg").unwrap();
        assert_eq!(dims(&out.full), (1080, 540));
        assert_eq!(dims(&out.thumbnail), (150, 150));

        let out = ImageProcessor::profile_picture().process(&png_bytes(400, 300), "Me.PNG").unwrap();
        assert_eq!(dims(&out.full), (400, 300), "small images are not upscaled");
        assert_eq!(dims(&out.thumbnail), (200, 200));
    }

    #[test]
    fn square_images_and_rounding() {
        let p = ImageProcessor::with_options(100, 10, 85);
        assert_eq!(p.full_dimensions(300, 300), (100, 100));
        assert_eq!(p.full_dimensions(301, 200), (100, 66), "floor(66.44 + 0.5)");
        assert_eq!(p.full_dimensions(200, 303), (66, 100));
        assert_eq!(p.full_dimensions(10_000, 1), (100, 1), "at least one pixel");
        assert_eq!(p.full_dimensions(100, 50), (100, 50));
    }

    #[test]
    fn exif_orientation_is_applied_to_jpeg() {
        let p = ImageProcessor::with_options(1000, 10, 85);
        let out = p.process(&jpeg_with_orientation(40, 20, 6), "phone.jpg").unwrap();
        assert_eq!(dims(&out.full), (20, 40), "rotated 90 degrees");
        let out = p.process(&jpeg_with_orientation(40, 20, 1), "phone.jpg").unwrap();
        assert_eq!(dims(&out.full), (40, 20));
    }

    #[test]
    fn grayscale_and_transparency_follow_go() {
        let gray = GrayImage::from_pixel(8, 8, Luma([200]));
        let mut png = Cursor::new(Vec::new());
        gray.write_to(&mut png, ImageFormat::Png).unwrap();
        let out = ImageProcessor::new().process(png.get_ref(), "g.png").unwrap();
        let full = image::load_from_memory_with_format(&out.full, ImageFormat::Jpeg).unwrap();
        assert!(matches!(full, DynamicImage::ImageLuma8(_)), "unscaled 8-bit gray stays single-channel");
        let thumb = image::load_from_memory_with_format(&out.thumbnail, ImageFormat::Jpeg).unwrap();
        assert!(matches!(thumb, DynamicImage::ImageRgb8(_)));

        let clear = RgbaImage::from_pixel(4, 4, Rgba([255, 255, 255, 0]));
        let mut png = Cursor::new(Vec::new());
        clear.write_to(&mut png, ImageFormat::Png).unwrap();
        let out = ImageProcessor::new().process(png.get_ref(), "clear.png").unwrap();
        let full = image::load_from_memory_with_format(&out.full, ImageFormat::Jpeg).unwrap().to_rgb8();
        assert!(full.pixels().all(|p| p.0.iter().all(|&c| c < 8)), "transparent pixels become black");
        assert_eq!(premultiply(200, 255), 200);
        assert_eq!(premultiply(255, 128), 128);
    }

    #[test]
    fn process_rejects_invalid_input() {
        let p = ImageProcessor::new();
        let jpg = jpeg_bytes(8, 8);
        let mut corrupt = vec![0xFF, 0xD8, 0xFF, 0xE0];
        corrupt.extend(std::iter::repeat_n(0x42, 32));
        let cases: [(&str, &str, &[u8], &str); 6] = [
            ("unsupported extension", "anim.gif", &jpg, "unsupported file extension: .gif"),
            ("missing extension", "photo", &jpg, "unsupported file extension: "),
            ("not an image", "notes.jpg", b"just some text, no image", "invalid image file: unsupported image format"),
            (
                "HEIC",
                "phone.heic",
                HEIC_HEADER,
                "HEIC/HEIF images are not yet supported, please convert to JPEG or PNG",
            ),
            ("corrupt JPEG", "broken.jpg", &corrupt, "failed to decode image: unexpected EOF"),
            ("WebP header without image data", "fake.webp", WEBP_HEADER, "failed to decode image"),
        ];
        for (name, filename, data, want) in cases {
            let err = p.process(data, filename).unwrap_err();
            assert!(err.to_string().contains(want), "{name}: {err}");
        }

        let png_only = ImageProcessor::new().with_allowed_mime_types(&[MIME_PNG]);
        assert_eq!(png_only.process(&jpg, "photo.jpg").unwrap_err().to_string(), "unsupported mime type: image/jpeg");
        assert_eq!(
            p.process(b"RIFF\x24\x00\x00\x00WEBPXXXX", "x.webp").unwrap_err().to_string(),
            "failed to decode image: image: unknown format"
        );
    }

    #[test]
    fn webp_is_decoded() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(30, 10, Rgba([10, 20, 30, 255])));
        let mut webp = Vec::new();
        img.write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(&mut webp)).unwrap();
        let out = ImageProcessor::with_options(20, 5, 85).process(&webp, "a.webp").unwrap();
        assert_eq!(dims(&out.full), (20, 7), "floor(20 * 10 / 30 + 0.5)");
        assert_eq!(dims(&out.thumbnail), (5, 5));
    }

    #[test]
    fn image_too_large_to_encode() {
        // With a larger maximum size nothing is scaled down, and JPEG cannot hold 65536 pixels.
        let wide = png_bytes(1 << 16, 1);
        let err = ImageProcessor::with_options(1 << 17, 16, 80).process(&wide, "wide.png").unwrap_err();
        assert_eq!(err.to_string(), "failed to encode full image: jpeg: image is too large to encode");
    }
}
