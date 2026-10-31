import fs from 'node:fs';
import path from 'node:path';
import { JSONFilePreset } from 'lowdb/node';

// Dry runs must not create books/ or books/db.json merely by starting.
// Keep an in-memory copy so scanning also cannot mutate the source file.
export async function openLibraryDatabase<T>(
  file: string, defaults: T, dryRun: boolean,
): Promise<{ data: T; write: () => Promise<void> }> {
  if (dryRun) {
    const data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8')) as T
      : structuredClone(defaults);
    return { data, write: async () => {} };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return JSONFilePreset(file, defaults);
}
