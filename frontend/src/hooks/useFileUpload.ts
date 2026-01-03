/**
 * useFileUpload Hook
 * 
 * Handles file upload with validation, progress tracking, and error handling.
 * Extracted from SettingsPage.tsx and ProfileDialog.tsx to eliminate duplication.
 */

import { useState, useCallback, useRef } from 'react';
import { VALIDATION, VALIDATION_MESSAGES } from '../constants/validation';

interface UseFileUploadOptions {
  /** Maximum file size in bytes (default: 5MB) */
  maxSize?: number;
  /** Allowed MIME types */
  allowedTypes?: string[];
  /** Allowed file extensions (without dot) */
  allowedExtensions?: string[];
  /** Callback when upload starts */
  onUploadStart?: () => void;
  /** Callback when upload completes successfully */
  onUploadSuccess?: (result: unknown) => void;
  /** Callback when upload fails */
  onUploadError?: (error: string) => void;
}

interface UseFileUploadReturn {
  /** Reference to attach to file input */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** Whether upload is in progress */
  isUploading: boolean;
  /** Error message if validation/upload failed */
  error: string | null;
  /** Handle file selection from input */
  handleFileSelect: (
    event: React.ChangeEvent<HTMLInputElement>,
    uploadFn: (file: File) => Promise<unknown>
  ) => Promise<void>;
  /** Trigger file input click */
  openFilePicker: () => void;
  /** Clear file input value */
  resetInput: () => void;
  /** Clear error state */
  clearError: () => void;
}

/**
 * Hook for handling file uploads with validation
 * 
 * @example
 * ```tsx
 * const {
 *   fileInputRef,
 *   isUploading,
 *   error,
 *   handleFileSelect,
 *   openFilePicker,
 * } = useFileUpload({
 *   onUploadSuccess: (result) => {
 *     updateProfilePic(result.profile_pic);
 *     showToast('Profile picture updated!', 'success');
 *   },
 *   onUploadError: (error) => {
 *     showToast(error, 'error');
 *   },
 * });
 * 
 * return (
 *   <>
 *     <input
 *       type="file"
 *       ref={fileInputRef}
 *       onChange={(e) => handleFileSelect(e, api.uploadFile)}
 *       accept="image/*"
 *       hidden
 *     />
 *     <button onClick={openFilePicker} disabled={isUploading}>
 *       {isUploading ? 'Uploading...' : 'Upload Photo'}
 *     </button>
 *     {error && <p className="error">{error}</p>}
 *   </>
 * );
 * ```
 */
export function useFileUpload(
  options: UseFileUploadOptions = {}
): UseFileUploadReturn {
  const {
    maxSize = VALIDATION.MAX_FILE_SIZE,
    allowedTypes = VALIDATION.ALLOWED_IMAGE_TYPES,
    allowedExtensions = VALIDATION.ALLOWED_IMAGE_EXTENSIONS,
    onUploadStart,
    onUploadSuccess,
    onUploadError,
  } = options;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Validate file before upload
   */
  const validateFile = useCallback(
    (file: File): string | null => {
      // Check file type
      const ext = file.name.toLowerCase().split('.').pop() || '';
      const isValidType = allowedTypes.includes(file.type);
      const isValidExt = allowedExtensions.includes(ext);

      if (!isValidType && !isValidExt) {
        return VALIDATION_MESSAGES.FILE_TYPE_ERROR;
      }

      // Check file size
      if (file.size > maxSize) {
        return VALIDATION_MESSAGES.FILE_SIZE_ERROR;
      }

      return null;
    },
    [maxSize, allowedTypes, allowedExtensions]
  );

  /**
   * Handle file selection and upload
   */
  const handleFileSelect = useCallback(
    async (
      event: React.ChangeEvent<HTMLInputElement>,
      uploadFn: (file: File) => Promise<unknown>
    ): Promise<void> => {
      const file = event.target.files?.[0];
      if (!file) return;

      // Validate file
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        onUploadError?.(validationError);
        return;
      }

      // Start upload
      setError(null);
      setIsUploading(true);
      onUploadStart?.();

      try {
        const result = await uploadFn(file);
        onUploadSuccess?.(result);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to upload file';
        setError(errorMessage);
        onUploadError?.(errorMessage);
      } finally {
        setIsUploading(false);
        // Reset input to allow re-uploading same file
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [validateFile, onUploadStart, onUploadSuccess, onUploadError]
  );

  /**
   * Open file picker dialog
   */
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Reset file input value
   */
  const resetInput = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    fileInputRef,
    isUploading,
    error,
    handleFileSelect,
    openFilePicker,
    resetInput,
    clearError,
  };
}
