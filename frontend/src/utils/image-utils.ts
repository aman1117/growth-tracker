/**
 * Image Utilities
 *
 * Client-side image compression and validation for uploads.
 * Compresses images before upload to reduce bandwidth on mobile.
 */

// Maximum file size after compression (1MB)
const MAX_COMPRESSED_SIZE = 1 * 1024 * 1024;

// Maximum dimension for compressed image
const MAX_DIMENSION = 1920;

// JPEG quality for compression
const JPEG_QUALITY = 0.85;

// Allowed MIME types
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Validate image file type
 */
export function isValidImageType(file: File): boolean {
  return ALLOWED_TYPES.includes(file.type);
}

/**
 * Validate image file size (max 5MB for upload)
 */
export function isValidImageSize(file: File): boolean {
  return file.size <= 5 * 1024 * 1024;
}

/**
 * Compress an image file to reduce size before upload
 * @param file - Original image file
 * @returns Compressed image as Blob
 */
export async function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // If file is already small enough and is JPEG, return as-is
    if (file.size <= MAX_COMPRESSED_SIZE && file.type === 'image/jpeg') {
      resolve(file);
      return;
    }

    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    img.onload = () => {
      // Calculate new dimensions maintaining aspect ratio
      let { width, height } = img;

      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          height = (height / width) * MAX_DIMENSION;
          width = MAX_DIMENSION;
        } else {
          width = (width / height) * MAX_DIMENSION;
          height = MAX_DIMENSION;
        }
      }

      canvas.width = width;
      canvas.height = height;

      // Draw image on canvas (this strips EXIF data)
      ctx.drawImage(img, 0, 0, width, height);

      // Convert to JPEG blob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to compress image'));
          }
        },
        'image/jpeg',
        JPEG_QUALITY
      );
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    // Create object URL for the file
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Compress image and convert to File object
 * @param file - Original image file
 * @returns Compressed image as File
 */
export async function compressImageToFile(file: File): Promise<File> {
  const blob = await compressImage(file);
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });
}

/**
 * Check if a date is within the upload window (7 days in IST)
 * @param date - Date to check
 * @returns Whether uploads are allowed for this date
 */
export function isDateWithinUploadWindow(date: Date): boolean {
  // Get current date in IST
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const nowIST = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
  const todayIST = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());

  // Normalize the target date to IST midnight
  const targetDate = new Date(date);
  const targetIST = new Date(targetDate.getTime() + istOffset + targetDate.getTimezoneOffset() * 60 * 1000);
  const targetDayIST = new Date(targetIST.getFullYear(), targetIST.getMonth(), targetIST.getDate());

  // Check if in future
  if (targetDayIST > todayIST) {
    return false;
  }

  // Check if within 7 days
  const sevenDaysAgo = new Date(todayIST);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return targetDayIST >= sevenDaysAgo;
}

/**
 * Format date for API (YYYY-MM-DD)
 */
export function formatDateForAPI(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Create a thumbnail preview from a file
 * @param file - Image file
 * @returns Data URL for preview
 */
export async function createThumbnailPreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    reader.readAsDataURL(file);
  });
}
