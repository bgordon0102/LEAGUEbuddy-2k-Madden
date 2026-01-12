import dotenv from 'dotenv';
import process from 'process';
import fs from 'fs';
import path from 'path';
import { REST, Routes } from 'discord.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
const outFile = process.env.MADDEN_ROLES_OUT || 'data/madden/madden_role_ids.json';

if (!token || !guildId) {
  console.error('Missing DISCORD_TOKEN and/or DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const baseRoles = [
  'Madden Commish',
  'Madden Co-Commish',
  'Madden Free Agent Coach',
  'Madden Coach',
  'Madden Trade Committee',
];

const teamRoles = [
  'Cardinals Coach',
  'Falcons Coach',
  'Ravens Coach',
  'Bills Coach',
  'Panthers Coach',
  'Bears Coach',
  'Bengals Coach',
  'Browns Coach',
  'Cowboys Coach',
  'Broncos Coach',
  'Lions Coach',
  'Packers Coach',
  'Texans Coach',
  'Colts Coach',
  'Jaguars Coach',
  'Chiefs Coach',
  'Raiders Coach',
  'Chargers Coach',
  'Rams Coach',
  'Dolphins Coach',
  'Vikings Coach',
  'Patriots Coach',
  'Saints Coach',
  'Giants Coach',
  'Jets Coach',
  'Eagles Coach',
  'Steelers Coach',
  '49ers Coach',
  'Seahawks Coach',
  'Buccaneers Coach',
  'Titans Coach',
  'Commanders Coach',
];

const desiredRoles = [...baseRoles, ...teamRoles];
const desiredRoleSet = new Set(desiredRoles);

const logosDir = path.join(process.cwd(), 'apps', 'snallabot-service', 'emojis', 'nfl_logos');

const teamToFile = {
  Cardinals: 'ari',
  Falcons: 'atl',
  Ravens: 'bal',
  Bills: 'buf',
  Panthers: 'car',
  Bears: 'chi',
  Bengals: 'cin',
  Browns: 'cle',
  Cowboys: 'dal',
  Broncos: 'den',
  Lions: 'det',
  Packers: 'gb',
  Texans: 'hou',
  Colts: 'ind',
  Jaguars: 'jax',
  Chiefs: 'kc',
  Raiders: 'lv',
  Chargers: 'lac',
  Rams: 'lar',
  Dolphins: 'mia',
  Vikings: 'min',
  Patriots: 'ne',
  Saints: 'no',
  Giants: 'nyg',
  Jets: 'nyj',
  Eagles: 'phi',
  Steelers: 'pit',
  '49ers': 'sf',
  Seahawks: 'sea',
  Buccaneers: 'tb',
  Titans: 'ten',
  Commanders: 'was',
};

function loadIcon(name) {
  const code = teamToFile[name];
  if (!code) return null;
  const file = path.join(logosDir, `${code}.png`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(token);

  console.log(`Fetching roles for guild ${guildId}...`);
  const existing = await rest.get(Routes.guildRoles(guildId));

  // Remove duplicate roles with the same name (keep the first occurrence)
  const byName = new Map();
  for (const role of existing) {
    const key = role.name;
    if (byName.has(key)) {
      console.log(`Deleting duplicate role: ${role.name} (${role.id})`);
      await rest.delete(Routes.guildRole(guildId, role.id));
    } else {
      byName.set(key, role);
    }
  }

  // Ensure each desired role exists; create if missing.
  for (const name of desiredRoles) {
    if (byName.has(name)) {
      console.log(`Role exists: ${name} (${byName.get(name).id})`);
      continue;
    }
    try {
      const created = await rest.post(Routes.guildRoles(guildId), { body: { name } });
      console.log(`Created role: ${name} (${created.id})`);
      byName.set(name, created);
    } catch (err) {
      console.error(`Failed to create role ${name}:`, err?.message || err);
    }
  }

  // Apply icons to team roles where possible.
  for (const [name, role] of byName.entries()) {
    if (!name.endsWith('Coach')) continue;
    const baseName = name.replace(/ Coach$/, '').trim();
    const iconData = loadIcon(baseName);
    if (!iconData) {
      console.log(`Skip (no icon): ${name}`);
      continue;
    }
    try {
      await rest.patch(Routes.guildRole(guildId, role.id), { body: { icon: iconData } });
      console.log(`Updated icon for role: ${name}`);
    } catch (err) {
      console.error(`Failed to set icon for ${name}:`, err?.message || err);
    }
  }

  // Optionally write a JSON map of role IDs.
  if (outFile) {
    const roleMap = {};
    for (const [name, role] of byName.entries()) {
      if (!desiredRoleSet.has(name)) continue;
      roleMap[name] = role.id;
    }
    try {
      fs.writeFileSync(outFile, JSON.stringify(roleMap, null, 2), 'utf8');
      console.log(`Wrote role map to ${outFile}`);
    } catch (e) {
      console.error(`Failed to write role map to ${outFile}:`, e?.message || e);
    }
  }

  console.log('Role sync complete.');
}

main().catch(err => {
  console.error('Role sync failed:', err?.message || err);
  process.exit(1);
});
