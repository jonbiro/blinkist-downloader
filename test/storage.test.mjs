import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExportSpace, estimateExportSpace, formatFreeSpace, getFreeBytes } from '../lib/storage.mjs';

const MiB = 1024 * 1024;

test('storage check prevents an export that would exceed available disk space', () => {
  assert.ok(estimateExportSpace(3600, 'm4b') > 80 * MiB);
  assert.ok(estimateExportSpace(3600, 'mp3') > estimateExportSpace(3600, 'm4b'));
  assert.equal(checkExportSpace('/a/path', 3600, 'm4b', () => 50 * MiB).ok, false);
  assert.equal(checkExportSpace('/a/path', 3600, 'm4b', () => 200 * MiB).ok, true);
  assert.equal(checkExportSpace('/a/path', 3600, 'm4b', () => null).ok, true);
  assert.equal(formatFreeSpace(3.5 * MiB), '4 MiB');
});

test('storage lookup works for nested output directory that does not exist yet', () => {
  const bytes = getFreeBytes(process.cwd() + '/not-yet-created/child');
  assert.ok(bytes === null || Number.isFinite(bytes) && bytes >= 0);
});
