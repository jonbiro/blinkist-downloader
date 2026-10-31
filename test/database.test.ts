import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLibraryDatabase } from '../lib/database.js';

test('dry-run database does not create a folder or metadata file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-db-dryrun-'));
  try {
    const file = path.join(root, 'books', 'db.json');
    const db = await openLibraryDatabase(file, { saved: [] as string[] }, true);
    db.data.saved.push('test-book');
    await db.write();
    assert.equal(fs.existsSync(path.dirname(file)), false);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dry-run reads existing metadata without writing edits back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-db-existing-'));
  try {
    const file = path.join(root, 'db.json');
    fs.writeFileSync(file, JSON.stringify({ saved: ['original'] }));
    const db = await openLibraryDatabase(file, { saved: [] as string[] }, true);
    db.data.saved.push('another');
    await db.write();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { saved: ['original'] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
