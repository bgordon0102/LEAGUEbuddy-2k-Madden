import fs from 'fs';
import path from 'path';

const PINS_FILE = path.join(process.cwd(), 'data', 'madden', 'pins.json');
const STATIC_PINS = {
  available_teams: '1479545575903858791',
  stat_leaders: '1479314025002045676',
  standings: '1479314692999479326',
  playoff_picture: '1479314696728346654',
  power_rankings: '1479314701732282480',
};

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
  if (STATIC_PINS[key]) return STATIC_PINS[key];
  const pins = loadPins();
  return pins[key] || null;
}

export function setPinId(key, id) {
  if (STATIC_PINS[key]) return; // do not overwrite fixed pins
  const pins = loadPins();
  pins[key] = id;
  savePins(pins);
}

export function clearPins() {
  try { fs.unlinkSync(PINS_FILE); } catch {}
}

export default { loadPins, savePins, getPinId, setPinId, clearPins };
