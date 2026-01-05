// Scrape team details and rosters from 2kratings.com using Puppeteer
// Usage: node scripts/scrape_2kratings_teams_puppeteer.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

const TEAM_LINKS_FILE = './data/teamLinks.json';
const OUTPUT_DIR = './data/teams_rosters';

puppeteer.use(StealthPlugin());

console.log("Script started");

async function scrapeTeamPage(url, { label = 'team' } = {}) {
    console.log("Reached scrapeTeamPage");
    const browser = await puppeteer.launch({
        headless: true
    });
    // Load cookies if available (for Cloudflare bypass)
    let cookies = null;
    const cookiesPath = path.resolve('./cookies.json');
    // We'll load cookies once and reuse for each page
    if (fs.existsSync(cookiesPath)) {
        try {
            cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
            console.log('[DEBUG] Loaded cookies from cookies.json');
        } catch (e) {
            console.log('[DEBUG] Failed to load cookies:', e.message);
        }
    }
    // Use a temp page to get roster links
    let tempPage = await browser.newPage();
    if (cookies) {
        try {
            await tempPage.setCookie(...cookies);
        } catch (e) {
            console.log('[DEBUG] Failed to set cookies on tempPage:', e.message);
        }
    }
    console.log('[DEBUG] Navigating to team page:', url);
    try {
        await tempPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (e) {
        console.log('[DEBUG] page.goto failed:', e.message);
        return { players: [] };
    }
    console.log('[DEBUG] Team page loaded. Waiting for roster links...');
    try {
        await tempPage.waitForSelector('.entry-font a, .entry-content a, a', { timeout: 15000 });
    } catch (e) {
        console.log('[DEBUG] waitForSelector roster anchors failed:', e.message);
        throw e;
    }
    console.log('[DEBUG] Roster links loaded.');
    // Restore extraction logic from commit 93646b2d8a2c220121828a2aeec2caf8013dfa0c
    const rosterLinks = await tempPage.evaluate(() => {
        // Try to extract from table first
        const table = document.querySelector('table tbody');
        if (table) {
            return Array.from(table.querySelectorAll('tr td a'))
                .map(el => {
                    const name = (el.textContent || '').trim();
                    const href = el.getAttribute('href') || '';
                    return { name, url: new URL(href, window.location.origin).href };
                })
                .filter(x => x.name && x.url && /\s/.test(x.name) && x.name.length > 5);
        }
        // Fallback: strict filter on anchors
        const anchors = Array.from(document.querySelectorAll('.entry-font a, .entry-content a, a'));
        return anchors
            .map(el => {
                const name = (el.textContent || '').trim();
                const href = el.getAttribute('href') || '';
                return { name, url: href ? new URL(href, window.location.origin).href : '' };
            })
            .filter(link => {
                if (!link.name || link.name.length < 5) return false;
                if (!/\s/.test(link.name)) return false; // require at least first/last name
                if (!link.url || link.url === '#' || link.url.startsWith('mailto:')) return false;
                // Exclude position-only, short, or non-player links
                if (/^(PG|SG|SF|PF|C|G|F)$/i.test(link.name)) return false;
                if (/^[A-Z]{1,3}$/.test(link.name)) return false;
                if (/All-Time|All-Decade|All-Star|Classic|G-League|WNBA|FIBA|Compare|Contact|About|Privacy|Terms|Locker|Countries|Lists|wp-content|\.svg|\.jpg|\.png/i.test(link.url)) return false;
                if (/Random|Lineup|Generator|All Current|NBA Teams|Team Ratings|Attributes|Badges/i.test(link.name)) return false;
                try {
                    const u = new URL(link.url, window.location.origin);
                    if (!/2kratings\.com$/i.test(u.hostname)) return false;
                    if (u.pathname.toLowerCase().includes('/teams/')) return false;
                    if (u.pathname.toLowerCase().includes('/lists/')) return false;
                    if (u.pathname.toLowerCase().includes('/position')) return false;
                    if (u.pathname.toLowerCase().includes('/positions/')) return false;
                    const segments = u.pathname.split('/').filter(Boolean);
                    if (segments.length !== 1) return false;
                    const slug = segments[0];
                    if (slug.length < 3) return false;
                    if (!/^[a-z0-9-]+$/i.test(slug)) return false;
                    if (/(current|teams|nba|random|generator|lineup|ratings|player-ratings|team-ratings|compare|attributes)/i.test(slug)) return false;
                    return true;
                } catch {
                    return false;
                }
            });
    });
    await tempPage.close();
    if (!rosterLinks.length) {
        console.log(`  [WARN] No player links found on ${label} page: ${url}`);
    } else {
        // Deduplicate by name and cap to 20 for teams, 50 for free agency
        const seen = new Set();
        const uniqueLinks = [];
        // Detect if this is the free agency page
        const isFreeAgency = /free[-_ ]?agency/i.test(label) || /free[-_ ]?agency/i.test(url);
        const maxLinks = isFreeAgency ? 50 : 20;
        for (const link of rosterLinks) {
            const key = link.name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            uniqueLinks.push(link);
            if (uniqueLinks.length >= maxLinks) break;
        }
        rosterLinks.length = 0;
        rosterLinks.push(...uniqueLinks);
        console.log(`  Found ${rosterLinks.length} player links on ${label} page (deduped & capped at ${maxLinks}).`);
    }
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
            let page = await browser.newPage();
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
                // Set cookies before each player if available
                if (cookies) {
                    try {
                        await page.setCookie(...cookies);
                    } catch (e) {
                        console.log('[DEBUG] Failed to set cookies for player:', player.name, e.message);
                    }
                }
                // Longer delay before navigation to help with Cloudflare/anti-bot (now 5-8s)
                await new Promise(res => setTimeout(res, 5000 + Math.random() * 3000));
                let response;
                try {
                    response = await page.goto(player.url, { waitUntil: 'networkidle2', timeout: 60000 });
                } catch (navErr) {
                    console.log(`[ERROR] page.goto failed for ${player.name} (attempt ${attempt}):`, navErr.message);
                    await page.close();
                    await new Promise(res => setTimeout(res, 6000 + Math.random() * 6000));
                    continue;
                }
                try {
                    await page.waitForSelector('body', { timeout: 20000 });
                    // give time for dynamic content/ads to settle
                    await new Promise(res => setTimeout(res, 3000));
                } catch (wErr) {
                    console.log(`[ERROR] waitForSelector body failed for ${player.name} (attempt ${attempt}):`, wErr.message);
                    await page.close();
                    await new Promise(res => setTimeout(res, 6000 + Math.random() * 6000));
                    continue;
                }
                // Check for 403 or robot challenge
                let bodyText = '';
                try {
                    bodyText = await page.evaluate(() => document.body.innerText);
                } catch (evalErr) {
                    console.log(`[ERROR] page.evaluate failed for ${player.name} (attempt ${attempt}):`, evalErr.message);
                    await page.close();
                    await new Promise(res => setTimeout(res, 6000 + Math.random() * 6000));
                    continue;
                }
                if ((response && response.status() === 403) || /robot challenge|forbidden|cloudflare/i.test(bodyText)) {
                    lastError = new Error('403 or Robot Challenge');
                    await page.close();
                    await new Promise(res => setTimeout(res, 6000 + Math.random() * 6000));
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
                    const textContent = (el) => (el && el.textContent ? el.textContent.trim() : '');
                    const allP = Array.from(document.querySelectorAll('p'));
                    const getByLabel = (label) => {
                        const p = allP.find(x => x.textContent && x.textContent.trim().toLowerCase().startsWith(label));
                        return textContent(p);
                    };
                    const getSpanAfterLabel = (label) => {
                        const p = allP.find(x => x.textContent && x.textContent.trim().toLowerCase().startsWith(label));
                        if (!p) return '';
                        const span = p.querySelector('span.text-light');
                        return textContent(span) || textContent(p).replace(new RegExp('^' + label, 'i'), '').trim();
                    };
                    const name = textContent(document.querySelector('h1.header-title')) || playerName;
                    // Positions
                    let positions = [];
                    const posP = allP.find(p => /Position:/i.test(p.textContent || ''));
                    if (posP) {
                        positions = Array.from(posP.querySelectorAll('a.text-light')).map(a => textContent(a)).filter(Boolean);
                    }
                    let position = positions.join(' / ');
                    let height = getSpanAfterLabel('height:');
                    let weight = getSpanAfterLabel('weight:');
                    let wingspan = getSpanAfterLabel('wingspan:');
                    let birthdate = getByLabel('birthdate:').replace(/^birthdate:\s*/i, '');
                    let yearsInNBA = getByLabel('year(s) in the nba:').replace(/^year\(s\) in the nba:\s*/i, '');
                    let prior_to_nba = getByLabel('prior to  nba:').replace(/^prior to\s*nba:\s*/i, '') || getByLabel('prior to nba:').replace(/^prior to\s*nba:\s*/i, '');
                    let nationality = getByLabel('nationality:').replace(/^nationality:\s*/i, '');

                    let imgUrl = '';
                    const ogImg = document.querySelector('meta[property="og:image"]');
                    if (ogImg && ogImg.content) imgUrl = ogImg.content;
                    if (!imgUrl) {
                        const img = document.querySelector('img.profile-photo, img[src*="2K-Photo"], img[src*="2K-Rating"]');
                        if (img) imgUrl = img.src;
                    }
                    if (!imgUrl) {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        const foundImg = imgs.find(im => im.src && im.src.toLowerCase().includes(playerName.toLowerCase().replace(/\s/g, '-')));
                        if (foundImg) imgUrl = foundImg.src;
                    }
                    // Avoid generic site logo
                    if (/NBA-2K-Ratings-Logo\\.svg/i.test(imgUrl)) imgUrl = '';
                    let ovr = '';
                    const ovrSpan = document.querySelector('span.attribute-box-player') || document.querySelector('span.attribute-box-player.ruby') || document.querySelector('span.attribute-box-player.sapphire') || document.querySelector('span.attribute-box-player.amethyst') || document.querySelector('span.attribute-box-player.gold') || document.querySelector('span.attribute-box-player.silver') || document.querySelector('span.attribute-box-player.bronze');
                    if (ovrSpan) ovr = textContent(ovrSpan);

                    // --- Fallback extraction from visible text if any field is missing ---
                    const pageText = document.body.innerText;
                    const fallback = (regex, flags = 'i') => {
                        const m = pageText.match(new RegExp(regex, flags));
                        return m ? m[1].trim() : '';
                    };
                    // Try more flexible patterns and alternatives
                    if (!position) position = fallback('Position:?\s*([A-Za-z\-/ ]{2,30})');
                    if (!position) position = fallback('Pos:?\s*([A-Za-z\-/ ]{2,30})');
                    if (!height) height = fallback('Height:?\s*([0-9\'"\s]+)');
                    if (!weight) weight = fallback('Weight:?\s*([0-9]+\s*lbs?)');
                    if (!wingspan) wingspan = fallback('Wingspan:?\s*([0-9\'"\s]+)');
                    if (!birthdate) birthdate = fallback('Birthdate:?\s*([A-Za-z0-9, ]+)');
                    if (!yearsInNBA) yearsInNBA = fallback('Year\(s\) in the NBA:?\s*([0-9]+)');
                    if (!yearsInNBA) yearsInNBA = fallback('NBA Experience:?\s*([0-9]+)');
                    if (!prior_to_nba) prior_to_nba = fallback('Prior to\s*NBA:?\s*([A-Za-z0-9 .\'-]+)');
                    if (!nationality) nationality = fallback('Nationality:?\s*([A-Za-z /]+)');
                    if (!ovr) ovr = fallback('Overall:?\s*(\d{2,3})') || fallback('NBA 2K\d+ Rating is\s*(\d{2,3})') || fallback('OVR:?\s*(\d{2,3})');

                    // If all fields are missing, log the raw text for debugging
                    if (!position && !height && !weight && !wingspan && !birthdate && !yearsInNBA && !prior_to_nba && !nationality && !ovr) {
                        // eslint-disable-next-line no-console
                        console.log('[DEBUG][RAW TEXT]', playerName, pageText.slice(0, 1000));
                    }

                    return {
                        name: name || playerName,
                        position,
                        height,
                        weight,
                        archetype: getSpanAfterLabel('archetype:') || getSpanAfterLabel('build:') || '',
                        birthdate,
                        yearsInNBA,
                        wingspan,
                        imgUrl,
                        ovr,
                        prior_to_nba,
                        nationality
                    };
                }, player.name);
                // Log missing fields
                Object.entries(info).forEach(([key, value]) => {
                    if (!value) console.log(`  [MISSING] ${key} is missing for ${player.name}`);
                });
                // Only add real, filled-out player objects (skip placeholders/empty slots)
                if (
                    info &&
                    info.name &&
                    info.name !== '403 - Forbidden' &&
                    !/robot challenge/i.test(info.name) &&
                    info.ovr &&
                    info.position &&
                    info.name.trim() !== '' &&
                    info.ovr.trim() !== '' &&
                    info.position.trim() !== ''
                ) {
                    players.push(info);
                } else {
                    console.log(`[SKIP] Skipping placeholder or incomplete player: ${info && info.name}`);
                }
                // Reduced delay after successful scrape (now 1-3s)
                await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
                await page.close();
                break; // Success, exit retry loop
            } catch (e) {
                lastError = e;
                await page.close();
                if (e.message && e.message.includes('Execution context was destroyed')) {
                    console.log(`  [RETRY] Execution context destroyed for ${player.name}, will try again with new page...`);
                    // Wait extra before retrying
                    await new Promise(res => setTimeout(res, 20000 + Math.random() * 20000));
                } else if (attempt < 3) {
                    // Increase delay before retry (was 6-12s, now 15-30s)
                    await new Promise(res => setTimeout(res, 15000 + Math.random() * 15000));
                } else {
                    console.log(`  [ERROR] Failed to scrape ${player.name} after 3 attempts: ${lastError.message}`);
                }
            }
        }
        // Only add player if info was successfully scraped
        if (info && info.name && info.name !== '403 - Forbidden' && !/robot challenge/i.test(info.name)) {
            // ...existing code...
        }
    }
    // ...any remaining code for scrapeTeamPage...
    await browser.close();
    return { players };
}

async function main() {
    console.log("[DEBUG] main() started");
    const arg = process.argv[2];
    const playerUrl = process.argv[3];
    // If a player URL is provided, scrape that player only
    if (playerUrl && typeof playerUrl === 'string' && playerUrl.includes('2kratings.com') && !playerUrl.includes('/teams/')) {
        console.log(`[DEBUG] Scraping individual player: ${playerUrl}`);
        const browser = await puppeteer.launch({ headless: true });
        let cookies = null;
        const cookiesPath = path.resolve('./cookies.json');
        if (fs.existsSync(cookiesPath)) {
            try {
                cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
                console.log('[DEBUG] Loaded cookies from cookies.json');
            } catch (e) {
                console.log('[DEBUG] Failed to load cookies:', e.message);
            }
        }
        let page = await browser.newPage();
        if (cookies) {
            try {
                await page.setCookie(...cookies);
            } catch (e) {
                console.log('[DEBUG] Failed to set cookies on player page:', e.message);
            }
        }
        await page.goto(playerUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('body', { timeout: 20000 });
        await new Promise(res => setTimeout(res, 3000));
        const info = await page.evaluate(() => {
            const textContent = (el) => (el && el.textContent ? el.textContent.trim() : '');
            const allP = Array.from(document.querySelectorAll('p'));
            const getByLabel = (label) => {
                const p = allP.find(x => x.textContent && x.textContent.trim().toLowerCase().startsWith(label));
                return textContent(p);
            };
            const getSpanAfterLabel = (label) => {
                const p = allP.find(x => x.textContent && x.textContent.trim().toLowerCase().startsWith(label));
                if (!p) return '';
                const span = p.querySelector('span.text-light');
                return textContent(span) || textContent(p).replace(new RegExp('^' + label, 'i'), '').trim();
            };
            const name = textContent(document.querySelector('h1.header-title'));
            let positions = [];
            const posP = allP.find(p => /Position:/i.test(p.textContent || ''));
            if (posP) {
                positions = Array.from(posP.querySelectorAll('a.text-light')).map(a => textContent(a)).filter(Boolean);
            }
            let position = positions.join(' / ');
            let height = getSpanAfterLabel('height:');
            let weight = getSpanAfterLabel('weight:');
            let wingspan = getSpanAfterLabel('wingspan:');
            let birthdate = getByLabel('birthdate:').replace(/^birthdate:\s*/i, '');
            let yearsInNBA = getByLabel('year(s) in the nba:').replace(/^year\(s\) in the nba:\s*/i, '');
            let prior_to_nba = getByLabel('prior to  nba:').replace(/^prior to\s*nba:\s*/i, '') || getByLabel('prior to nba:').replace(/^prior to\s*nba:\s*/i, '');
            let nationality = getByLabel('nationality:').replace(/^nationality:\s*/i, '');
            let imgUrl = '';
            const ogImg = document.querySelector('meta[property="og:image"]');
            if (ogImg && ogImg.content) imgUrl = ogImg.content;
            if (!imgUrl) {
                const img = document.querySelector('img.profile-photo, img[src*="2K-Photo"], img[src*="2K-Rating"]');
                if (img) imgUrl = img.src;
            }
            if (!imgUrl) {
                const imgs = Array.from(document.querySelectorAll('img'));
                const foundImg = imgs.find(im => im.src && im.src.toLowerCase().includes(name.toLowerCase().replace(/\s/g, '-')));
                if (foundImg) imgUrl = foundImg.src;
            }
            if (/NBA-2K-Ratings-Logo\.svg/i.test(imgUrl)) imgUrl = '';
            let ovr = '';
            const ovrSpan = document.querySelector('span.attribute-box-player') || document.querySelector('span.attribute-box-player.ruby') || document.querySelector('span.attribute-box-player.sapphire') || document.querySelector('span.attribute-box-player.amethyst') || document.querySelector('span.attribute-box-player.gold') || document.querySelector('span.attribute-box-player.silver') || document.querySelector('span.attribute-box-player.bronze');
            if (ovrSpan) ovr = textContent(ovrSpan);
            // Fallback extraction from visible text if any field is missing
            const pageText = document.body.innerText;
            const fallback = (regex, flags = 'i') => {
                const m = pageText.match(new RegExp(regex, flags));
                return m ? m[1].trim() : '';
            };
            if (!position) position = fallback('Position:?\s*([A-Za-z\-/ ]{2,30})');
            if (!position) position = fallback('Pos:?\s*([A-Za-z\-/ ]{2,30})');
            if (!height) height = fallback('Height:?\s*([0-9\'\"\s]+)');
            if (!weight) weight = fallback('Weight:?\s*([0-9]+\s*lbs?)');
            if (!wingspan) wingspan = fallback('Wingspan:?\s*([0-9\'\"\s]+)');
            if (!birthdate) birthdate = fallback('Birthdate:?\s*([A-Za-z0-9, ]+)');
            if (!yearsInNBA) yearsInNBA = fallback('Year\(s\) in the NBA:?\s*([0-9]+)');
            if (!yearsInNBA) yearsInNBA = fallback('NBA Experience:?\s*([0-9]+)');
            if (!prior_to_nba) prior_to_nba = fallback('Prior to\s*NBA:?\s*([A-Za-z0-9 .\'-]+)');
            if (!nationality) nationality = fallback('Nationality:?\s*([A-Za-z /]+)');
            if (!ovr) ovr = fallback('Overall:?\s*(\d{2,3})') || fallback('NBA 2K\d+ Rating is\s*(\d{2,3})') || fallback('OVR:?\s*(\d{2,3})');
            return {
                name: name,
                position,
                height,
                weight,
                archetype: getSpanAfterLabel('archetype:') || getSpanAfterLabel('build:') || '',
                birthdate,
                yearsInNBA,
                wingspan,
                imgUrl,
                ovr,
                prior_to_nba,
                nationality
            };
        });
        await page.close();
        await browser.close();
        // --- Auto-add player to correct roster file ---
        let teamName = (info.nationality && info.nationality.toLowerCase().includes('free agent')) ? 'Free_Agency' : null;
        // Try to extract team from page if available
        if (!teamName && info.position && info.position.toLowerCase().includes('free agent')) {
            teamName = 'Free_Agency';
        }
        // If not free agent, try to get team from URL or fallback to manual entry
        if (!teamName) {
            // Try to extract team from the URL (e.g., /teams/{team}) or ask user to specify
            // For now, fallback to Free_Agency if not found
            teamName = 'Free_Agency';
        }
        // Normalize team file name
        let fileName = teamName.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
        let filePath = path.join(OUTPUT_DIR, fileName);
        let players = [];
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                players = Array.isArray(data.players) ? data.players : [];
            } catch (e) {
                console.log('[ERROR] Failed to load roster file:', filePath, e.message);
            }
        }
        // Remove any existing player with the same name
        players = players.filter(p => p.name.toLowerCase() !== info.name.toLowerCase());
        // Add the new player
        players.push(info);
        // Sort by OVR descending
        players.sort((a, b) => parseInt(b.ovr) - parseInt(a.ovr));
        // Save back to file
        fs.writeFileSync(filePath, JSON.stringify({ players }, null, 2));
        console.log(`[INFO] Added ${info.name} to ${fileName} in OVR order.`);
        console.log(JSON.stringify(info, null, 2));
        return;
    }
    // Otherwise, run normal team scraping
    let teamLinks;
    try {
        teamLinks = JSON.parse(fs.readFileSync(TEAM_LINKS_FILE, 'utf8'));
        console.log(`[DEBUG] Loaded ${teamLinks.length} teams from teamLinks.json`);
    } catch (e) {
        console.error('[ERROR] Failed to load teamLinks.json:', e.message);
        return;
    }
    if (!arg) {
        console.error('[ERROR] No team name provided. Usage: node scripts/scrape_2kratings_teams_puppeteer.js "Chicago Bulls"');
        return;
    }
    const team = teamLinks.find(t => t.name.toLowerCase() === arg.toLowerCase())
        || teamLinks.find(t => t.name.toLowerCase().includes(arg.toLowerCase()));
    if (!team) {
        console.error(`[ERROR] Team not found: ${arg}`);
        return;
    }
    const isFreeAgency = /free[-_ ]?agency/i.test(team.name) || /free[-_ ]?agency/i.test(team.url);
    const label = isFreeAgency ? 'free agency' : 'team';
    console.log(`[DEBUG] Scraping team: ${team.name} (${team.url})`);
    const details = await scrapeTeamPage(team.url, { label });
    const outPath = `${OUTPUT_DIR}/${team.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    fs.writeFileSync(outPath, JSON.stringify(details, null, 2));
    console.log(`[DEBUG] Saved: ${outPath}`);
    console.log("Main complete");
}

main();
