import fs from 'fs';
import path from 'path';

// Simple JSON file helper used across the bot
export class DataManager {
  constructor(baseDir = path.join(process.cwd(), 'data')) {
    this.baseDir = baseDir;
  }

  filePath(key) {
    const safeKey = `${key}`.replace(/[^a-zA-Z0-9-_]/g, '');
    return path.join(this.baseDir, `${safeKey}.json`);
  }

  readData(key, defaultValue = null) {
    const file = this.filePath(key);
    try {
      if (!fs.existsSync(file)) return defaultValue;
      const contents = fs.readFileSync(file, 'utf-8');
      return JSON.parse(contents);
    } catch (err) {
      console.error(`[DataManager] Failed to read ${file}:`, err);
      return defaultValue;
    }
  }

  writeData(key, data) {
    const file = this.filePath(key);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error(`[DataManager] Failed to write ${file}:`, err);
      return false;
    }
  }
}

export default DataManager;
