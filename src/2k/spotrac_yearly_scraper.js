// basketball_reference_contracts_scraper.js
// Scrapes NBA contract data from Basketball Reference contracts page for a given team

import puppeteer from 'puppeteer-extra';
import fs from 'fs';
import path from 'path';

const TEAM_CODES = {
    'Atlanta Hawks': 'ATL',
    'Boston Celtics': 'BOS',
    'Brooklyn Nets': 'BRK',
    'Charlotte Hornets': 'CHO',
    'Chicago Bulls': 'CHI',
    'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL',
    'Denver Nuggets': 'DEN',
    'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW',
    'Houston Rockets': 'HOU',
    'Indiana Pacers': 'IND',
    'LA Clippers': 'LAC',
    'Los Angeles Clippers': 'LAC',
    'Los Angeles Lakers': 'LAL',
    'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA',
    'Milwaukee Bucks': 'MIL',
    'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NOP',
    'New York Knicks': 'NYK',
    'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL',
    'Philadelphia 76ers': 'PHI',
    'Phoenix Suns': 'PHO',
    'Portland Trail Blazers': 'POR',
    'Sacramento Kings': 'SAC',
    'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR',
    'Utah Jazz': 'UTA',
    'Washington Wizards': 'WAS',
};

async function scrapeBasketballReferenceContracts(teamName) {
    const code = TEAM_CODES[teamName];
    if (!code) throw new Error(`No Basketball Reference code for team: ${teamName}`);
    const url = `https://www.basketball-reference.com/contracts/${code}.html`;

    console.log(`[BBR-Contracts] Navigating to: ${url}`);
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://www.google.com/',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Scrape contract data from Basketball Reference contracts table
    const contracts = await page.evaluate(() => {
        // Find the main contracts table
        const table = document.querySelector('table#contracts');
        if (!table) return [];
        const headerCells = Array.from(table.querySelectorAll('thead tr th'));
        // Map year columns using data-stat attribute (y1, y2, y3, ...)
        const yearCols = headerCells
            .map((th, i) => {
                const stat = th.getAttribute('data-stat');
                const year = th.innerText.match(/\d{4}-\d{2}/)?.[0];
                if (/^y\d+$/.test(stat) && year) {
                    return { year, idx: i, stat };
                }
                return null;
            })
            .filter(Boolean);
        // Option column (e.g., "2025-26 Option")
        const optionCols = headerCells.map((th, i) => {
            if (/Option|Qualifying|RFA|UFA/i.test(th.innerText)) return i;
            return null;
        }).filter(i => i !== null);
        const rows = Array.from(table.querySelectorAll('tbody tr')).filter(row => row.querySelector('td'));
        return rows.map(row => {
            const cells = row.querySelectorAll('td');
            // Extract player name from first anchor element in the row
            let player = '';
            const playerAnchor = row.querySelector('a');
            if (playerAnchor) {
                player = playerAnchor.innerText.trim();
            } else {
                player = cells[0]?.innerText.trim();
            }
            let contractYears = [];
            yearCols.forEach(col => {
                // Find salary cell by data-stat attribute
                let salary = '';
                let option = null;
                for (let cell of cells) {
                    if (cell.getAttribute('data-stat') === col.stat) {
                        salary = cell.innerText.trim();
                        // Detect player/team option by class
                        const className = cell.className || '';
                        if (className.includes('salary-pl')) option = 'Player';
                        else if (className.includes('salary-tm')) option = 'Team';
                        break;
                    }
                }
                // Check for option in option columns (fallback)
                optionCols.forEach(optIdx => {
                    const optText = cells[optIdx]?.innerText.trim();
                    if (optText && optText !== '-') option = optText;
                });
                if (salary && salary !== '-') {
                    contractYears.push({
                        year: col.year,
                        salary,
                        option
                    });
                }
            });
            return {
                player,
                contractYears
            };
        });
    });

    await browser.close();
    // Only return players with at least one contract year
    return contracts.filter(p => p.contractYears && p.contractYears.length > 0);
}

export { scrapeBasketballReferenceContracts, TEAM_CODES };