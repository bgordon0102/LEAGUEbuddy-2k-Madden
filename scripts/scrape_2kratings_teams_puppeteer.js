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
    for (let i = 0; i < rosterLinks.length; i++) {
        const player = rosterLinks[i];
        let success = false;
        let lastError = null;
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
            try {
                process.stdout.write(`${i + 1}/${rosterLinks.length} ${player.name}\n`);
                const playerPage = await browser.newPage();
                await playerPage.goto(player.url, { waitUntil: 'networkidle2', timeout: 60000 });
                const info = await playerPage.evaluate(() => {
                    // Helper to get text content from <p> by label
                    const getTextFromP = (label) => {
                        const ps = Array.from(document.querySelectorAll('p'));
                        const p = ps.find(p => p.textContent.includes(label));
                        if (!p) return '';
                        return p.textContent.replace(label, '').trim();
                    };
                    // Helper to get archetype
                    const getArchetype = () => {
                        const p = Array.from(document.querySelectorAll('p.mb-1.my-lg-0')).find(p => p.textContent.includes('Archetype:'));
                        if (!p) return '';
                        const span = p.querySelector('span.text-light');
                        return span ? span.textContent.trim() : p.textContent.replace('Archetype:', '').trim();
                    };
                    // Helper to get nationality (as string)
                    const getNationality = () => {
                        const ps = Array.from(document.querySelectorAll('p'));
                        const p = ps.find(p => p.textContent.includes('Nationality:'));
                        if (!p) return '';
                        const a = p.querySelector('a.text-light');
                        return a ? a.textContent.trim() : p.textContent.replace('Nationality:', '').trim();
                    };
                    // Helper to get position (as string)
                    const getPosition = () => {
                        const ps = Array.from(document.querySelectorAll('p'));
                        const p = ps.find(p => p.textContent.includes('Position:'));
                        if (!p) return '';
                        const a = Array.from(p.querySelectorAll('a.text-light')).map(a => a.textContent.trim());
                        return a.length ? a.join(' / ') : p.textContent.replace('Position:', '').trim();
                    };
                    // Helper to get image URL
                    const getImg = () => {
                        const img = document.querySelector('img.profile-photo');
                        return img ? img.src : '';
                    };
                    return {
                        name: document.querySelector('h1.header-title.pt-2.mb-0')?.textContent.trim() || '',
                        position: getPosition(),
                        height: getTextFromP('Height:'),
                        weight: getTextFromP('Weight:'),
                        archetype: getArchetype(),
                        birthdate: getTextFromP('Birthdate:'),
                        yearsInNBA: getTextFromP('Year(s) in the NBA:'),
                        wingspan: getTextFromP('Wingspan:'),
                        imgUrl: getImg(),
                        ovr: document.querySelector('span.attribute-box-player')?.textContent.trim() || '',
                        prior_to_nba: getTextFromP('Prior to  NBA:'),
                        nationality: getNationality()
                    };
                });
                // Log missing fields
                Object.entries(info).forEach(([key, value]) => {
                    if (!value) {
                        console.log(`  [MISSING] ${key} is missing for ${player.name}`);
                    }
                });
                players.push(info);
                await playerPage.close();
                success = true;
            } catch (e) {
                lastError = e;
                if (attempt < 3) {
                    console.log(`  Retry ${attempt} for ${player.name}...`);
                } else {
                    console.log(`  Error scraping player: ${player.name}`);
                    console.log(`    Player URL: ${player.url}`);
                    console.log(`    Error: ${e && e.message ? e.message : e}`);
                }
            }
        }
    }
    await browser.close();
    return { players };
}

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
