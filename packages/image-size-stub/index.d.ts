export interface ImageDimensions {
  width: number;
  height: number;
}

export declare function imageSize(
  input: Uint8Array | ArrayBuffer,
): ImageDimensions;
