import * as fs from 'fs';
import { LruCache } from './cache';

const PREVIEW_MAX_BYTES = 8 * 1024;
const PREVIEW_MAX_LINES = 35;
const AROUND_RADIUS = 6;
const previewCache = new LruCache<string>(80);

/**
 * Read a short code preview from disk — capped size/lines, cached.
 */
export function readFilePreview(filePath: string): string {
  const cached = previewCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const preview = readPreviewWindow(filePath, 0, PREVIEW_MAX_LINES);
  previewCache.set(filePath, preview);
  return preview;
}

/** Preview lines around a 0-based line (for route / method defs). */
export function readPreviewAroundLine(filePath: string, line: number): string {
  const start = Math.max(0, line - 2);
  const key = `${filePath}@${start}`;
  const cached = previewCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const preview = readPreviewWindow(filePath, start, AROUND_RADIUS + 3);
  previewCache.set(key, preview);
  return preview;
}

function readPreviewWindow(
  filePath: string,
  startLine: number,
  maxLines: number
): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return '';
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, PREVIEW_MAX_BYTES * 4));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, bytesRead).toString('utf8');
      const allLines = text.split(/\r?\n/);
      if (startLine >= allLines.length) {
        return '';
      }
      const end = Math.min(allLines.length, startLine + maxLines);
      const lines = allLines.slice(startLine, end);
      if (end < allLines.length && startLine + maxLines < allLines.length) {
        lines.push('// …');
      }
      return lines.join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function clearPreviewCache(): void {
  previewCache.clear();
}
