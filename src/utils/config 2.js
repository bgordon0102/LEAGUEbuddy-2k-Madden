// Minimal config helpers; extend with real settings as needed
import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');

export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('[config] Failed to write config:', e);
    return false;
  }
}

// Defaults for mergedraft and other commands
export const TEAM_FILES = {
  default: path.join(process.cwd(), 'data', 'teams.json')
};

export const TEAM_ALIASES = {};
