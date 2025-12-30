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
        let playerPage = null;
        try {
            process.stdout.write(`${i + 1}/${rosterLinks.length} ${player.name}\n`);
            playerPage = await browser.newPage();
            await playerPage.setUserAgent(randomUserAgent());
            await playerPage.setViewport(randomViewport());
            await new Promise(res => setTimeout(res, 1000 + Math.random() * 1000));
            await playerPage.goto(player.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await playerPage.waitForSelector('h1.header-title', { timeout: 10000 });
            // Extract player info
            const info = await playerPage.evaluate((playerName) => {
                const getText = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
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
                    const foundImg = imgs.find(im => im.src && im.src.toLowerCase().includes(playerName.toLowerCase().replace(/\s/g, '-')));
                    if (foundImg) imgUrl = foundImg.src;
                }
                // Primary extraction for OVR and years in NBA
                let ovr = '';
                const ovrSpan = document.querySelector('span.attribute-box-player') || document.querySelector('span.attribute-box-player.ruby') || document.querySelector('span.attribute-box-player.sapphire') || document.querySelector('span.attribute-box-player.amethyst') || document.querySelector('span.attribute-box-player.gold') || document.querySelector('span.attribute-box-player.silver') || document.querySelector('span.attribute-box-player.bronze');
                if (ovrSpan) ovr = ovrSpan.textContent.trim();
                let yearsInNBA = '';
                const yearP = Array.from(document.querySelectorAll('p.text-light.mb-1.my-lg-0')).find(p => /Year\(s\) in the NBA:/i.test(p.textContent));
                if (yearP) {
                    const match = yearP.textContent.match(/Year\(s\) in the NBA:\s*(\d+)/i);
                    if (match) yearsInNBA = match[1];
                }
                // Fallback: parse summary line for OVR and years if missing
                if (!ovr || !yearsInNBA) {
                    const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
                    const namePattern = playerName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
                    const playerLine = lines.find(l => new RegExp(namePattern, 'i').test(l) && /\d/.test(l));
                    if (playerLine) {
                        let cols = playerLine.split('|').map(s => s.trim()).filter(Boolean);
                        if (cols.length < 3) {
                            cols = playerLine.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
                        }
                        let archetypeIdx = cols.findIndex(c => c.toLowerCase().includes('playmaking') || c.toLowerCase().includes('slasher') || c.toLowerCase().includes('scorer') || c.toLowerCase().includes('dimer') || c.toLowerCase().includes('sharpshooter') || c.toLowerCase().includes('bully') || c.toLowerCase().includes('riser') || c.toLowerCase().includes('maestro') || c.toLowerCase().includes('cleaner') || c.toLowerCase().includes('rocker') || c.toLowerCase().includes('sniper'));
                        if (archetypeIdx !== -1 && cols[archetypeIdx + 1]) {
                            let nums = cols[archetypeIdx + 1].match(/\d+/g) || [];
                            if (nums.length >= 2) {
                                if (!ovr) ovr = nums[0];
                                if (!yearsInNBA) yearsInNBA = nums[1];
                            } else if (nums.length === 1) {
                                if (!ovr) ovr = nums[0];
                            }
                        }
                    }
                }
                return {
                    name: getText('h1.header-title') || playerName,
                    position: getField('Position'),
                    height: getField('Height'),
                    weight: getField('Weight'),
                    archetype: getField('Archetype'),
                    birthdate: getField('Birthdate'),
                    yearsInNBA,
                    wingspan: getField('Wingspan'),
                    imgUrl,
                    ovr,
                    prior_to_nba: getField('Prior to NBA'),
                    nationality: getField('Nationality')
                };
            }, player.name);
            // Log missing fields
            Object.entries(info).forEach(([key, value]) => {
                if (!value) console.log(`  [MISSING] ${key} is missing for ${player.name}`);
            });
            players.push(info);
        } catch (e) {
            console.log(`  [ERROR] Failed to scrape ${player.name}: ${e.message}`);
        } finally {
            if (playerPage) { try { await playerPage.close(); } catch { } }
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
