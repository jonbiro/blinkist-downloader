import fs from 'node:fs';
import path from 'node:path';

const MiB = 1024 * 1024;

/** Read free blocks at the nearest existing ancestor of an output folder. */
export function getFreeBytes(targetPath) {
  try {
    let current = path.resolve(targetPath);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    const blocks = fs.statfsSync(current);
    return Number(blocks.bavail) * Number(blocks.bsize);
  } catch {
    return null; // Unsupported filesystem: let FFmpeg report an I/O error.
  }
}

/**
 * Estimate final output size conservatively. No enormous WAV staging is needed.
 * Leave 48 MiB for cover artwork, metadata, filesystem and other activity.
 */
export function estimateExportSpace(durationSeconds, format) {
  const bitrate = format === 'm4b' ? 128_000 : 192_000;
  return Math.ceil(Math.max(0, durationSeconds) * bitrate / 8) + 48 * MiB;
}

export function checkExportSpace(targetPath, durationSeconds, format, getFree = getFreeBytes) {
  const freeBytes = getFree(targetPath);
  const requiredBytes = estimateExportSpace(durationSeconds, format);
  return {
    freeBytes,
    requiredBytes,
    ok: freeBytes === null || freeBytes >= requiredBytes,
  };
}

export function formatFreeSpace(bytes) {
  return bytes === null ? 'unknown' : (bytes / MiB).toFixed(0) + ' MiB';
}
