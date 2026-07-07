interface ImageValidationResult {
  isValid: boolean;
  error?: string;
}

interface ProcessedImage {
  dataUrl: string;
  name: string;
  size: number;
  type: string;
}

const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB per image (after compression).

const MAX_ORIGINAL_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB original file size limit.

const MAX_IMAGE_DIMENSION = 1920; // Max width/height in pixels.

const COMPRESSION_QUALITY = 0.8; // JPEG compression quality (0.1 - 1.0).

const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

/**
 * Validates an image file (before processing/compression).
 */
function validateImageFile(file: File): ImageValidationResult {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return {
      isValid: false,
      error: `Unsupported file type. Please use: ${SUPPORTED_IMAGE_TYPES.map((type) => type.split('/')[1]).join(', ')}`,
    };
  }

  if (file.size > MAX_ORIGINAL_IMAGE_SIZE) {
    return {
      isValid: false,
      error: `Original file size too large. Maximum size is ${formatFileSize(MAX_ORIGINAL_IMAGE_SIZE)}.`,
    };
  }

  return { isValid: true };
}

/**
 * Resizes and compresses an image to fit within size constraints.
 */
function resizeAndCompressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    img.onload = () => {
      let { width, height } = img;

      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const ratio = Math.min(
          MAX_IMAGE_DIMENSION / width,
          MAX_IMAGE_DIMENSION / height,
        );

        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, 0, 0, width, height);

      // Convert to blob with compression.
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to compress image'));
            return;
          }

          // Check if compressed size is still too large.
          if (blob.size > MAX_IMAGE_SIZE) {
            // Try with lower quality.
            canvas.toBlob(
              (retryBlob) => {
                if (!retryBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                if (retryBlob.size > MAX_IMAGE_SIZE) {
                  reject(
                    new Error(
                      `Image too large even after compression. Size: ${formatFileSize(retryBlob.size)}, Max: ${formatFileSize(MAX_IMAGE_SIZE)}`,
                    ),
                  );
                  return;
                }

                // Convert blob to data URL.
                const reader = new FileReader();

                reader.onload = () => {
                  if (typeof reader.result === 'string') {
                    resolve(reader.result);
                  } else {
                    reject(new Error('Failed to read compressed image'));
                  }
                };

                reader.onerror = () =>
                  reject(new Error('Failed to read compressed image'));

                reader.readAsDataURL(retryBlob);
              },
              'image/jpeg',
              0.5, // Lower quality for retry.
            );
          } else {
            // Convert blob to data URL.
            const reader = new FileReader();

            reader.onload = () => {
              if (typeof reader.result === 'string') {
                resolve(reader.result);
              } else {
                reject(new Error('Failed to read compressed image'));
              }
            };

            reader.onerror = () =>
              reject(new Error('Failed to read compressed image'));

            reader.readAsDataURL(blob);
          }
        },
        'image/jpeg',
        COMPRESSION_QUALITY,
      );
    };

    img.onerror = () => {
      reject(new Error('Failed to load image for compression'));
    };

    const reader = new FileReader();

    reader.onload = (e) => {
      if (typeof e.target?.result === 'string') {
        img.src = e.target.result;
      } else {
        reject(new Error('Failed to read file'));
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Converts a file to a base64 data URL (with automatic resizing/compression).
 */
function fileToDataUrl(file: File): Promise<string> {
  // For SVG files, don't compress as they're already optimized.
  if (file.type === 'image/svg+xml') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read file as data URL'));
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };

      reader.readAsDataURL(file);
    });
  }

  // For other image types, use compression.
  return resizeAndCompressImage(file);
}

/**
 * Processes multiple image files and returns data URLs.
 */
export async function processImageFiles(
  files: File[],
): Promise<ProcessedImage[]> {
  const processedImages: ProcessedImage[] = [];

  for (const file of files) {
    const validation = validateImageFile(file);

    if (!validation.isValid) {
      throw new Error(`${file.name}: ${validation.error}`);
    }

    try {
      const dataUrl = await fileToDataUrl(file);

      processedImages.push({
        dataUrl,
        name: file.name,
        size: file.size,
        type: file.type,
      });
    } catch (error) {
      throw new Error(
        `Failed to process ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  return processedImages;
}

/**
 * Formats file size in human-readable format.
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 Bytes';
  }

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
