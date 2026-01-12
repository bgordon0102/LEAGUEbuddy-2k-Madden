import fs from 'fs';
import path from 'path';

const PINS_FILE = path.join(process.cwd(), 'data', 'madden', 'pins.json');

export function loadPins() {
  try {
    return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function savePins(pins) {
  fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins ?? {}, null, 2));
}

export function getPinId(key) {
  const pins = loadPins();
  return pins[key] || null;
}

export function setPinId(key, id) {
  const pins = loadPins();
  pins[key] = id;
  savePins(pins);
}

export function clearPins() {
  try { fs.unlinkSync(PINS_FILE); } catch {}
}

export default { loadPins, savePins, getPinId, setPinId, clearPins };
