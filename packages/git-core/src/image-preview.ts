import { extname } from 'node:path'
import type { ImagePreview } from '@ingit/rpc-contract'

// Base64 expands the RPC payload by roughly a third. This keeps an expanded
// file row useful without allowing a very large asset to monopolize the
// WebSocket connection.
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
])

export function isPreviewableImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

function hasPrefix(data: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte)
}

function detectImageMimeType(data: Buffer, path: string): string | null {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'

  const sixByteHeader = data.subarray(0, 6).toString('ascii')
  if (sixByteHeader === 'GIF87a' || sixByteHeader === 'GIF89a') return 'image/gif'

  if (
    data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (hasPrefix(data, [0x42, 0x4d])) return 'image/bmp'
  if (hasPrefix(data, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'

  if (data.length >= 16 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = data.subarray(8, Math.min(data.length, 64)).toString('ascii')
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif'
  }

  if (extname(path).toLowerCase() === '.svg') {
    const prefix = data.subarray(0, Math.min(data.length, 4096)).toString('utf8')
    if (!prefix.includes('\0') && /<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml'
  }

  return null
}

export function createImagePreview(data: Buffer, path: string): ImagePreview | null {
  if (data.length > IMAGE_PREVIEW_MAX_BYTES) return null
  const mimeType = detectImageMimeType(data, path)
  if (!mimeType) return null
  return {
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}`,
    byteSize: data.length,
  }
}
