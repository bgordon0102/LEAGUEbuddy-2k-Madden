import fs from 'fs';
import process from 'process';

const SECRET = process.env.MADDEN_EXPORT_SECRET || '';
const PORT = Number(process.env.MADDEN_EXPORT_PORT || 4010);
const HOST = process.env.MADDEN_EXPORT_HOST || 'localhost';
const URL = `http://${HOST}:${PORT}/madden/export`;

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/madden-upload-export.js <export.json>');
    process.exit(1);
  }
  if (!SECRET) {
    console.error('MADDEN_EXPORT_SECRET is not set. Set it in your .env.');
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = raw.trim();
  if (!payload) {
    console.error('File is empty or unreadable:', filePath);
    process.exit(1);
  }

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-export-secret': SECRET,
    },
    body: payload,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    console.error('Upload failed:', res.status, json);
    process.exit(1);
  }
  console.log('Upload ok:', json);
}

main().catch(err => {
  console.error('Upload error:', err?.message || err);
  process.exit(1);
});
