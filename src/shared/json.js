import fs from 'fs';

export function loadJson(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error(`[json.js] Failed to load ${filePath}:`, err);
    }
    return defaultValue;
}

export function saveJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[json.js] Failed to save ${filePath}:`, err);
        return false;
    }
}
