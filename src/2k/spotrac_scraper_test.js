// Test harness for Spotrac contract scraper (ESM)
import { scrapeSpotracContracts } from './spotrac_scraper.js';

async function test() {
    try {
        const contracts = await scrapeSpotracContracts('Atlanta Hawks');
        console.log('Contracts for Atlanta Hawks:', contracts);
    } catch (err) {
        console.error('Error scraping contracts:', err);
    }
}

test();
