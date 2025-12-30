// Scrape team details and rosters from 2kratings.com using Puppeteer
// Usage: node scripts/scrape_2kratings_teams_puppeteer.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

const TEAM_LINKS_FILE = './data/teamLinks.json';
const OUTPUT_DIR = './data/teams_rosters';

puppeteer.use(StealthPlugin());

console.log("Script started");

async function scrapeTeamPage(url) {
    console.log("Reached scrapeTeamPage");
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    console.log('[DEBUG] Navigating to team page:', url);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (e) {
        console.log('[DEBUG] page.goto failed:', e.message);
        return { players: [] };
    }
    console.log('[DEBUG] Team page loaded. Waiting for roster links...');
    try {
        await page.waitForSelector('.entry-font a', { timeout: 15000 });
    } catch (e) {
        console.log('[DEBUG] waitForSelector .entry-font a failed:', e.message);
        throw e;
    }
    console.log('[DEBUG] Roster links loaded.');
    // Only select current roster players (not historic/all-time)
    const rosterLinks = await page.$$eval('.entry-font a', els =>
        els
            .filter(el => {
                const name = el.textContent.trim();
                const url = el.href;
                if (!name || name.length < 2) return false;
                // Exclude links that are not player profiles or are historic/all-time
                if (/All-Time|All-Decade|All-Star|Classic|G-League|WNBA|FIBA|Compare|Attributes|Badges|Random|Updates|Contact|About|Privacy|Terms|Locker|Countries|Lists|wp-content|\.svg|\.jpg|\.png|current-teams|teams\//i.test(url)) return false;
                return true;
            })
            .map(el => ({ name: el.textContent.trim(), url: el.href }))
    );
    console.log(`  Found ${rosterLinks.length} player links.`);
    // Scrape full player info for each player
    const players = [];
    // User-agent pool for randomization
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    ];
    function randomUserAgent() {
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }
    function randomViewport() {
        const viewports = [
            { width: 1280, height: 800 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
            { width: 1536, height: 864 },
        ];
        return viewports[Math.floor(Math.random() * viewports.length)];
    }

    for (let i = 0; i < rosterLinks.length; i++) {
        const player = rosterLinks[i];
        let info = null;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                process.stdout.write(`${i + 1}/${rosterLinks.length} ${player.name}${attempt > 1 ? ` (try ${attempt})` : ''}\n`);
                await page.setUserAgent(randomUserAgent());
                await page.setViewport(randomViewport());
                await page.setExtraHTTPHeaders({
                    'accept-language': 'en-US,en;q=0.9',
                    'referer': 'https://www.2kratings.com/',
                    'sec-ch-ua': '"Chromium";v="120", "Not:A-Brand";v="99"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"macOS"',
                    'upgrade-insecure-requests': '1',
                });
                await new Promise(res => setTimeout(res, 2000 + Math.random() * 3000));
                const response = await page.goto(player.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                if (response && response.status() === 403) {
                    lastError = new Error('403 Forbidden');
                    await new Promise(res => setTimeout(res, 4000 + Math.random() * 4000));
                    continue;
                }
                let hasHeader = false;
                try {
                    await page.waitForSelector('h1.header-title', { timeout: 5000 });
                    hasHeader = true;
                } catch (e) {
                    // No header, fallback to summary extraction
                }
                info = await page.evaluate((playerName) => {
                    // Try to get name from h1.header-title, else fallback to summary text
                    let name = '';
                    if (document.querySelector('h1.header-title')) {
                        name = document.querySelector('h1.header-title').textContent.trim();
                    } else if (document.title && document.title.length < 50) {
                        name = document.title.replace(/\s*-\s*NBA 2K\d+ Rating.*$/, '').trim();
                    } else {
                        // Fallback: look for the first # heading or the first line with OVERALL
                        const summary = document.body.innerText || '';
                        const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
                        // Try to find a line that matches the player name and has OVERALL or NBA
                        const namePattern = playerName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
                        let playerLine = lines.find(l => new RegExp(namePattern, 'i').test(l) && (/OVERALL|Year\(s\) in the NBA:|NBA 2K\d+/i.test(l)));
                        if (!playerLine) playerLine = lines.find(l => l.startsWith('# '));
                        if (playerLine) name = playerLine.replace(/^#+\s*/, '').split('OVERALL')[0].split('Year(s)')[0].trim();
                    }
                    // Use summary text for fallback extraction
                    const summary = document.body.innerText || '';
                    // Helper to extract a field by label, allowing for multiple variants and multi-line values
                    const getField = (label, altLabels = []) => {
                        let match = summary.match(new RegExp(label + ':\\s*([^\\n]+)', 'i'));
                        if (!match && altLabels.length) {
                            for (const alt of altLabels) {
                                match = summary.match(new RegExp(alt + ':\\s*([^\\n]+)', 'i'));
                                if (match) break;
                            }
                        }
                        return match ? match[1].trim() : '';
                    };
                    let imgUrl = '';
                    const img = document.querySelector('img.profile-photo, img[src*="2K-Photo"], img[src*="2K-Rating"]');
                    if (img) imgUrl = img.src;
                    if (!imgUrl) {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        const foundImg = imgs.find(im => im.src && im.src.toLowerCase().includes(playerName.toLowerCase().replace(/\s/g, '-')));
                        if (foundImg) imgUrl = foundImg.src;
                    }
                    // OVR: try span, else fallback to text before OVERALL or 'NBA 2K26 Rating is' or 'NBA 2K26 | 79 |'
                    let ovr = '';
                    const ovrSpan = document.querySelector('span.attribute-box-player') || document.querySelector('span.attribute-box-player.ruby') || document.querySelector('span.attribute-box-player.sapphire') || document.querySelector('span.attribute-box-player.amethyst') || document.querySelector('span.attribute-box-player.gold') || document.querySelector('span.attribute-box-player.silver') || document.querySelector('span.attribute-box-player.bronze');
                    if (ovrSpan) ovr = ovrSpan.textContent.trim();
                    if (!ovr) {
                        let ovrMatch = summary.match(/(\d{2,3})\s*OVERALL/i);
                        if (!ovrMatch) ovrMatch = summary.match(/NBA 2K26 Rating is\s*(\d{2,3})/i);
                        if (!ovrMatch) ovrMatch = summary.match(/NBA 2K\d+\s*\|\s*(\d{2,3})\s*\|/i);
                        if (!ovrMatch) ovrMatch = summary.match(/\n(\d{2,3})\s*OVERALL/i);
                        if (ovrMatch) ovr = ovrMatch[1];
                    }
                    // Years in NBA: try p, else fallback to text
                    let yearsInNBA = '';
                    const yearP = Array.from(document.querySelectorAll('p.text-light.mb-1.my-lg-0')).find(p => /Year\(s\) in the NBA:/i.test(p.textContent));
                    if (yearP) {
                        const match = yearP.textContent.match(/Year\(s\) in the NBA:\s*(\d+)/i);
                        if (match) yearsInNBA = match[1];
                    }
                    if (!yearsInNBA) {
                        let yearsMatch = summary.match(/Year\(s\) in the NBA:\s*(\d+)/i);
                        if (!yearsMatch) yearsMatch = summary.match(/NBA\s*:\s*(\d+)\s*years/i);
                        if (!yearsMatch) yearsMatch = summary.match(/Year\(s\) in the NBA\s*\n(\d+)/i);
                        if (yearsMatch) yearsInNBA = yearsMatch[1];
                    }
                    // Fallback for other fields from summary, allow for label variants
                    const fallbackField = (label, altLabels = []) => getField(label, altLabels);
                    // Nationality: handle multiple countries
                    let nationality = fallbackField('Nationality');
                    if (!nationality) {
                        // Try to extract from summary block with country flags
                        const natMatch = summary.match(/Nationality:\s*([\w\s\/]+)(?=\n|$)/i);
                        if (natMatch) nationality = natMatch[1].trim();
                    }
                    // Archetype: allow for 'Build' or 'Archetype'
                    let archetype = fallbackField('Archetype', ['Build']);
                    if (!archetype) {
                        // Try to extract from summary block
                        const archMatch = summary.match(/Archetype:\s*([^\n]+)/i);
                        if (archMatch) archetype = archMatch[1].trim();
                    }
                    return {
                        name: name || playerName,
                        position: fallbackField('Position'),
                        height: fallbackField('Height'),
                        weight: fallbackField('Weight'),
                        archetype,
                        birthdate: fallbackField('Birthdate'),
                        yearsInNBA,
                        wingspan: fallbackField('Wingspan'),
                        imgUrl,
                        ovr,
                        prior_to_nba: fallbackField('Prior to NBA'),
                        nationality
                    };
                }, player.name);
                // Log missing fields
                Object.entries(info).forEach(([key, value]) => {
                    if (!value) console.log(`  [MISSING] ${key} is missing for ${player.name}`);
                });
                players.push(info);
                await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
                break; // Success, exit retry loop
            } catch (e) {
                lastError = e;
                if (attempt < 3) {
                    await new Promise(res => setTimeout(res, 4000 + Math.random() * 4000));
                } else {
                    console.log(`  [ERROR] Failed to scrape ${player.name} after 3 attempts: ${lastError.message}`);
                }
            }
        }
    }
    // ...any remaining code for scrapeTeamPage...
    await browser.close();
    return { players };
}

async function main() {
    console.log("[DEBUG] main() started");
    let teamLinks;
    try {
        teamLinks = JSON.parse(fs.readFileSync(TEAM_LINKS_FILE, 'utf8'));
        console.log(`[DEBUG] Loaded ${teamLinks.length} teams from teamLinks.json`);
    } catch (e) {
        console.error('[ERROR] Failed to load teamLinks.json:', e.message);
        return;
    }
    const arg = process.argv[2];
    if (!arg) {
        console.error('[ERROR] No team name provided. Usage: node scripts/scrape_2kratings_teams_puppeteer.js "Chicago Bulls"');
        return;
    }
    const team = teamLinks.find(t => t.name.toLowerCase() === arg.toLowerCase());
    if (!team) {
        console.error(`[ERROR] Team not found: ${arg}`);
        return;
    }
    console.log(`[DEBUG] Scraping team: ${team.name} (${team.url})`);
    const details = await scrapeTeamPage(team.url);
    const outPath = `${OUTPUT_DIR}/${team.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    fs.writeFileSync(outPath, JSON.stringify(details, null, 2));
    console.log(`[DEBUG] Saved: ${outPath}`);
    console.log("Main complete");
}

main();
