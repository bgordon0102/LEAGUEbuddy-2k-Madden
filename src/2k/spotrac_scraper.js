// spotrac_scraper.js
// Scrapes NBA contract data from Spotrac for a given team
// Integrates with your existing 2K scraper workflow

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

/**
 * Map NBA team names to Spotrac URL slugs
 * Example: 'Los Angeles Lakers' => 'los-angeles-lakers'
 */
// Spotrac team slugs for /nba/contracts/_/team/{slug}
const TEAM_SLUGS = {
    'Atlanta Hawks': 'atl',
    'Boston Celtics': 'bos',
    'Brooklyn Nets': 'bkn',
    'Charlotte Hornets': 'cha',
    'Chicago Bulls': 'chi',
    'Cleveland Cavaliers': 'cle',
    'Dallas Mavericks': 'dal',
    'Denver Nuggets': 'den',
    'Detroit Pistons': 'det',
    'Golden State Warriors': 'gsw',
    'Houston Rockets': 'hou',
    'Indiana Pacers': 'ind',
    'LA Clippers': 'lac',
    'Los Angeles Lakers': 'lal',
    'Memphis Grizzlies': 'mem',
    'Miami Heat': 'mia',
    'Milwaukee Bucks': 'mil',
    'Minnesota Timberwolves': 'min',
    'New Orleans Pelicans': 'nor',
    'New York Knicks': 'nyk',
    'Oklahoma City Thunder': 'okc',
    'Orlando Magic': 'orl',
    'Philadelphia 76ers': 'phi',
    'Phoenix Suns': 'phx',
    'Portland Trail Blazers': 'por',
    'Sacramento Kings': 'sac',
    'San Antonio Spurs': 'sas',
    'Toronto Raptors': 'tor',
    'Utah Jazz': 'uta',
    'Washington Wizards': 'was',
};

/**
 * Scrape contracts for a given NBA team from Spotrac
 * @param {string} teamName - Full NBA team name
 * @returns {Promise<Array>} - Array of contract objects
 */
async function scrapeSpotracContracts(teamName) {

    const slug = TEAM_SLUGS[teamName];
    if (!slug) throw new Error(`No Spotrac slug for team: ${teamName}`);
    // Use new URL format: /nba/contracts/_/team/{slug}
    const url = `https://www.spotrac.com/nba/contracts/_/team/${slug}`;

    console.log(`[Spotrac] Navigating to: ${url}`);
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Set user-agent and headers to mimic a real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://www.google.com/',
        'sec-ch-ua': '"Chromium";v="120", "Not:A-Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'upgrade-insecure-requests': '1',
    });

    // Optionally load cookies if available (for Cloudflare bypass)
    const cookiesPath = path.resolve('./cookies.json');
    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
            await page.setCookie(...cookies);
            console.log('[Spotrac] Loaded cookies from cookies.json');
        } catch (e) {
            console.log('[Spotrac] Failed to load cookies:', e.message);
        }
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });


    // Try to wait for the contracts table, fallback to first <table> if needed
    // Always select the contract table by id
    const tableSelector = 'table#table';
    try {
        await page.waitForSelector(tableSelector, { timeout: 20000 });
    } catch (e) {
        console.log('[Spotrac] Contract table with id="table" not found. Dumping page content for debugging...');
        const body = await page.evaluate(() => document.body.innerText);
        console.log(body.slice(0, 2000));
        await browser.close();
        throw new Error('Could not find contracts table. See above for page content.');
    }

    // Scrape contract data from the contract table
    const contracts = await page.evaluate(() => {
        const table = document.querySelector('table#table');
        if (!table) return [];
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        return rows.map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 9) return null;
            // Player name from anchor tag
            let player = '';
            const anchor = cells[0].querySelector('a');
            if (anchor) {
                player = anchor.innerText.trim();
            } else {
                player = cells[0]?.innerText.trim();
            }
            return {
                player,
                pos: cells[1]?.innerText.trim(),
                team: cells[2]?.innerText.trim(),
                age: cells[3]?.innerText.trim(),
                start: cells[4]?.innerText.trim(),
                end: cells[5]?.innerText.trim(),
                yrs: cells[6]?.innerText.trim(),
                value: cells[7]?.innerText.trim(),
                aav: cells[8]?.innerText.trim(),
            };
        }).filter(Boolean);
    });

    console.log(`[Spotrac] Contracts scraped: ${contracts.length}`);
    await browser.close();
    return contracts;
}

export { scrapeSpotracContracts, TEAM_SLUGS };
