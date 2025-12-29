import fs from 'fs';
import path from 'path';

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'trade_block.json');

/**
 * Minimal trade block helper to avoid runtime import errors.
 * Loads/saves a JSON array from data/trade_block.json by default.
 */
export function loadTradeBlock(filePath = DEFAULT_PATH) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

export function saveTradeBlock(trades, filePath = DEFAULT_PATH) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(trades ?? [], null, 2));
        return true;
    } catch {
        return false;
    }
}

export default { loadTradeBlock, saveTradeBlock };
