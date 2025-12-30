// Scrape team details and rosters from 2kratings.com using Puppeteer
// Usage: node scripts/scrape_2kratings_teams_puppeteer.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

const TEAM_LINKS_FILE = './data/teamLinks.json';
const OUTPUT_DIR = './data/teams_rosters';

puppeteer.use(StealthPlugin());

async function scrapeTeamPage(url) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    // Wait for current roster player links to load
    await page.waitForSelector('.entry-font a', { timeout: 15000 });
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
        let success = false;
        let lastError = null;
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
            let playerPage = null;
            try {
                process.stdout.write(`${i + 1}/${rosterLinks.length} ${player.name}\n`);
                playerPage = await browser.newPage();
                await playerPage.setUserAgent(randomUserAgent());
                await playerPage.setViewport(randomViewport());
                await new Promise(res => setTimeout(res, 2000 + Math.random() * 2000));
                await playerPage.goto(player.url, { waitUntil: 'networkidle2', timeout: 120000 });
                await new Promise(res => setTimeout(res, 2000 + Math.random() * 2000));
                try {
                    await playerPage.waitForSelector('h1.header-title.pt-2.mb-0', { timeout: 10000 });
                } catch {
                    try { await playerPage.waitForSelector('h1.header-title', { timeout: 5000 }); } catch {}
                }
                const info = await playerPage.evaluate((playerName) => {
                    const summary = document.body.innerText || '';
                    const getField = (label) => {
                        const match = summary.match(new RegExp(label + ':\\s*([^\\n]+)', 'i'));
                        return match ? match[1].trim() : '';
                    };
                    let imgUrl = '';
                    const img = document.querySelector('img.profile-photo, img[src*="2K-Photo"], img[src*="2K-Rating"]');
                    if (img) imgUrl = img.src;
                    if (!imgUrl) {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        const foundImg = imgs.find(im => im.src && im.src.toLowerCase().includes(playerName.toLowerCase().replace(/\\s/g, '-')));
                        if (foundImg) imgUrl = foundImg.src;
                    }
                    return {
                        name: (document.querySelector('h1.header-title')?.textContent || playerName || '').trim(),
                        position: getField('Position') || '',
                        height: getField('Height') || '',
                        weight: getField('Weight') || '',
                        archetype: getField('Archetype') || '',
                        birthdate: getField('Birthdate') || '',
                        yearsInNBA: getField('Year(s) in the NBA') || '',
                        wingspan: getField('Wingspan') || '',
                        imgUrl: imgUrl || '',
                        ovr: getField('OVERALL') || '',
                        prior_to_nba: getField('Prior to NBA') || '',
                        nationality: getField('Nationality') || ''
                    };
                }, player.name);
                if (info && typeof info === 'object') {
                    Object.entries(info).forEach(([key, value]) => {
                        if (!value) console.log(`  [MISSING] ${key} is missing for ${player.name}`);
                    });
                } else {
                    console.log(`  [ERROR] No info object returned for ${player.name}`);
                }
                players.push(info);
                success = true;
            } catch (e) {
                lastError = e;
                if (attempt < 3) {
                    console.log(`  Retry ${attempt} for ${player.name}...`);
                    await new Promise(res => setTimeout(res, 4000 + Math.random() * 2000));
                } else {
                    console.log(`  Error scraping player: ${player.name}`);
                    console.log(`    Player URL: ${player.url}`);
                    console.log(`    Error: ${e && e.message ? e.message : e}`);
                }
            } finally {
                if (playerPage) { try { await playerPage.close(); } catch {} }
            }
        }
        if (!success && lastError) {
            console.log(`  Failed to scrape ${player.name} after 3 attempts. Last error: ${lastError.message || lastError}`);
        }
    }
    await browser.close();
    return { players };
}

// Main function to handle team argument and output
async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
    const teamLinks = JSON.parse(fs.readFileSync(TEAM_LINKS_FILE, 'utf8'));
    // Accept team name or index as argument
    const arg = process.argv[2];
    let teamsToScrape = teamLinks;
    if (arg) {
        const idx = parseInt(arg, 10);
        if (!isNaN(idx) && idx >= 0 && idx < teamLinks.length) {
            teamsToScrape = [teamLinks[idx]];
        } else {
            // Try to match by name (case-insensitive, partial ok)
            const found = teamLinks.find(t => t.name.toLowerCase().includes(arg.toLowerCase()));
            if (found) {
                teamsToScrape = [found];
            } else {
                console.error('Team not found by index or name:', arg);
                process.exit(1);
            }
        }
    }
    for (const team of teamsToScrape) {
        console.log(`Scraping ${team.name}...`);
        try {
            const details = await scrapeTeamPage(team.url);
            const outPath = `${OUTPUT_DIR}/${team.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
            fs.writeFileSync(outPath, JSON.stringify(details, null, 2));
            console.log(`Saved: ${outPath}`);
        } catch (err) {
            console.error(`Error scraping ${team.name}:`, err.message);
        }
    }
    console.log('Scraping complete.');
}

main();
