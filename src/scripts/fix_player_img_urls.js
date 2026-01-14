import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rostersDir = path.join(__dirname, '../teams_rosters');

function toSlug(name) {
    // Remove Jr., Sr., III, II, etc. and special chars, then hyphenate
    return name
        .replace(/\b(Jr\.|Sr\.|II|III|IV|V)\b/gi, '')
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

function getPossibleImgUrl(name) {
    const slug = toSlug(name);
    return `https://www.2kratings.com/wp-content/uploads/${slug}-2K-Rating.png`;
}

const placeholderPatterns = [
    'NBA-2K-Ratings-Logo.svg',
    'postimg.cc',
    'i.postimg.cc',
    'cdn.2kratings.com/players',
];

const flagged = [];

fs.readdirSync(rostersDir).forEach(file => {
    if (file.endsWith('.json')) {
        const filePath = path.join(rostersDir, file);
        let json;
        try {
            json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error(`Failed to parse ${file}:`, e);
            return;
        }
        let changed = false;
        if (Array.isArray(json.players)) {
            json.players.forEach(player => {
                // Fix if missing, placeholder, or using 2K-Photo.jpg or similar
                const needsFix =
                    !player.imgUrl ||
                    placeholderPatterns.some(p => player.imgUrl.includes(p)) ||
                    /-2K-Photo(.*)\.jpg$/i.test(player.imgUrl);
                if (needsFix) {
                    const imgUrl = getPossibleImgUrl(player.name);
                    player.imgUrl = imgUrl;
                    flagged.push({ team: file, player: player.name, imgUrl });
                    changed = true;
                }
            });
            if (changed) {
                fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
                console.log(`Updated ${file}`);
            }
        }
    }
});

if (flagged.length) {
    fs.writeFileSync(path.join(rostersDir, 'flagged_img_urls.json'), JSON.stringify(flagged, null, 2));
    console.log(`Flagged ${flagged.length} players with possibly invalid image URLs. See flagged_img_urls.json.`);
} else {
    console.log('No players flagged.');
}
