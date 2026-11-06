import type { ContentBlockData } from "@strands-agents/sdk";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CONVERSATION_IMAGE_BYTES = 8 * 1024 * 1024;
export type AssistantImageFormat = "png" | "jpeg" | "webp";
export interface AssistantImage {
  id: string;
  name: string;
  format: AssistantImageFormat;
  dataUrl: string;
  byteLength: number;
}

export function imageDataUrl(format: string, bytes: Uint8Array): string {
  if (!["png", "jpeg", "webp"].includes(format)) throw new Error("Use PNG, JPEG, or WebP images.");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Each image must be between 1 byte and 4 MB.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/${format};base64,${btoa(binary)}`;
}

function formatOf(bytes: Uint8Array): AssistantImageFormat {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  const ascii = (offset: number, value: string) =>
    [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  throw new Error("Use valid PNG, JPEG, or WebP images. Other file types are not supported.");
}

/** Decode locally before adding a preview. No network request or persistent storage. */
async function checkDimensions(file: Blob): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Try another PNG, JPEG, or WebP file.");
  }
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw new Error("This image is too large. Reduce it to 40 megapixels or fewer.");
  } finally {
    bitmap.close();
  }
}

export async function readAssistantImage(
  file: File,
  decode: (file: Blob) => Promise<void> = checkDimensions,
): Promise<AssistantImage> {
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error("Each image must be between 1 byte and 4 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = formatOf(bytes);
  await decode(new Blob([bytes], { type: `image/${format}` }));
  return {
    id: crypto.randomUUID(),
    name: file.name || "Pasted image",
    format,
    dataUrl: imageDataUrl(format, bytes),
    byteLength: bytes.length,
  };
}

export function validateImageBatch(images: readonly AssistantImage[]): void {
  if (images.length > MAX_IMAGES) throw new Error("Attach up to 4 images per message.");
  if (images.reduce((total, image) => total + image.byteLength, 0) > MAX_CONVERSATION_IMAGE_BYTES)
    throw new Error("Images must total 8 MB or less. Remove an image or use smaller files.");
}

/** Strands keeps these bytes in user history for subsequent turns and tool results. */
export function imageContent(images: readonly AssistantImage[]): ContentBlockData[] {
  validateImageBatch(images);
  return images.map((image) => {
    const prefix = `data:image/${image.format};base64,`;
    if (!image.dataUrl.startsWith(prefix)) throw new Error("Invalid image attachment.");
    const bytes = Uint8Array.from(atob(image.dataUrl.slice(prefix.length)), (c) => c.charCodeAt(0));
    if (bytes.length !== image.byteLength || formatOf(bytes) !== image.format)
      throw new Error("Invalid image attachment.");
    imageDataUrl(image.format, bytes); // Enforce the same limit for non-UI callers.
    return { image: { format: image.format, source: { bytes } } };
  });
}
