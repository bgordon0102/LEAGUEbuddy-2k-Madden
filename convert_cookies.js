// convert_cookies.js (ESM version)
// Converts Chrome/extension-exported cookies to Puppeteer format
import fs from 'fs';

const cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
const puppeteerCookies = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : undefined
}));
fs.writeFileSync('cookies.json', JSON.stringify(puppeteerCookies, null, 2));
console.log('Converted cookies saved to cookies.json');
