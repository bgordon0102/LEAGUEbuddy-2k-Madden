import fs from 'fs';
import path from 'path';

export class DataManager {
  constructor(basePath = './data') {
    this.basePath = path.resolve(basePath);
  }

  pathFor(name) {
    return path.join(this.basePath, `${name}.json`);
  }

  readData(name) {
    const file = this.pathFor(name);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  writeData(name, data) {
    try {
      fs.mkdirSync(this.basePath, { recursive: true });
      fs.writeFileSync(this.pathFor(name), JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.error(`[DataManager] Failed to write ${name}:`, e);
      return false;
    }
  }
}
