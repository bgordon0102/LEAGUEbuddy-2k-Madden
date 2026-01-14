import dotenv from 'dotenv';
import process from 'process';
import fs from 'fs';
import path from 'path';
import { REST, Routes, RESTEvents } from 'discord.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
const outFile = process.env.NBA_ROLES_OUT || 'data/2k/nba_role_ids.json';

if (!token || !guildId) {
  console.error('Missing DISCORD_TOKEN and/or DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const baseRoles = [
  'Ghost Paradise',
  'Ghost Paradise Commish',
  'Ghost Paradise Co-Commish',
  'Ghost Paradise Trade Committee',
];

const teamRoles = [
  '76ers Coach', 'Bucks Coach', 'Bulls Coach', 'Cavaliers Coach', 'Celtics Coach', 'Clippers Coach', 'Grizzlies Coach',
  'Hawks Coach', 'Heat Coach', 'Hornets Coach', 'Jazz Coach', 'Kings Coach', 'Knicks Coach', 'Lakers Coach',
  'Magic Coach', 'Mavericks Coach', 'Nets Coach', 'Nuggets Coach', 'Pacers Coach', 'Pelicans Coach', 'Pistons Coach',
  'Raptors Coach', 'Rockets Coach', 'Spurs Coach', 'Suns Coach', 'Thunder Coach', 'Timberwolves Coach',
  'Trail Blazers Coach', 'Warriors Coach', 'Wizards Coach'
];

const desiredRoles = [...baseRoles, ...teamRoles];
const desiredRoleSet = new Set(desiredRoles);
const teamRoleSet = new Set(teamRoles);

const logosDir = path.join(process.cwd(), 'NBA Logos');
const ghostIconPath = path.join(process.cwd(), 'ghost_logos', 'ghost_paradise.png');

function loadIcon(name) {
  const file = path.join(logosDir, `${name}.png`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

async function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(token);

  // Discord REST rate-limit logging
  rest.on(RESTEvents.RateLimited, info => {
    console.warn('[Discord REST RateLimited]', info);
  });

  console.log(`Fetching roles for guild ${guildId}...`);
  let existing;
  try {
    existing = await rest.get(Routes.guildRoles(guildId));
    console.log(`Fetched ${existing.length} roles from Discord.`);
  } catch (err) {
    console.error('Failed to fetch roles:', err?.message || err);
    return;
  }

  // Remove duplicate roles with the same name (keep the first occurrence)
  const byName = new Map();
  for (const role of existing) {
    const key = role.name;
    if (byName.has(key)) {
      try {
        console.log(`Deleting duplicate role: ${role.name} (${role.id})`);
        await rest.delete(Routes.guildRole(guildId, role.id));
        await delay(500);
      } catch (err) {
        logDiscordError(`Failed to delete duplicate role ${role.name}`, err);
      }
    } else {
      byName.set(key, role);
    }
  }

  // Ensure each desired role exists; create if missing.
  for (const name of desiredRoles) {
    console.log(`Processing role: ${name}`);
    if (byName.has(name)) {
      console.log(`Role exists: ${name} (${byName.get(name).id})`);
      continue;
    }
    let created = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        created = await rest.post(Routes.guildRoles(guildId), { body: { name } });
        console.log(`Created role: ${name} (${created.id})`);
        byName.set(name, created);
        await delay(500);
        break;
      } catch (err) {
        logDiscordError(`Attempt ${attempt}: Failed to create role ${name}`, err);
        if (attempt < 3) await delay(2000 * attempt);
      }
    }
    if (!created) {
      console.error(`Giving up on creating role: ${name}`);
    }
  }

  // Only iterate over desiredRoles for icon patching
  for (const name of desiredRoles) {
    const role = byName.get(name);
    if (!role) {
      console.warn(`Role not found for icon patch: ${name}`);
      continue;
    }
    console.log(`Applying icon to role: ${name}`);
    if (baseRoles.includes(name)) {
      try {
        await rest.patch(Routes.guildRole(guildId, role.id), { body: { unicode_emoji: undefined, icon: undefined } });
        await delay(500);
        if (fs.existsSync(ghostIconPath)) {
          const buf = fs.readFileSync(ghostIconPath);
          const iconData = `data:image/png;base64,${buf.toString('base64')}`;
          await rest.patch(Routes.guildRole(guildId, role.id), { body: { icon: iconData } });
          await delay(500);
          console.log(`Updated icon for role: ${name} using Ghost Paradise icon`);
        } else {
          console.warn(`Ghost Paradise icon file not found at ${ghostIconPath}, skipping icon update for ${name}`);
        }
      } catch (err) {
        logDiscordError(`Failed to set icon for ${name}`, err);
      }
      continue;
    }

    if (teamRoleSet.has(name)) {
      const baseName = name.replace(/ Coach$/, '').trim();
      const iconData = loadIcon(baseName);
      if (!iconData) {
        console.log(`Skip (no icon): ${name}`);
        continue;
      }
      let patched = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await rest.patch(Routes.guildRole(guildId, role.id), { body: { icon: iconData } });
          await delay(500);
          console.log(`Updated icon for role: ${name}`);
          patched = true;
          break;
        } catch (err) {
          logDiscordError(`Attempt ${attempt}: Failed to set icon for ${name}`, err);
          if (attempt < 3) await delay(2000 * attempt);
        }
      }
      if (!patched) {
        console.error(`Giving up on setting icon for: ${name}`);
      }
    }
  }

  // Optionally write a JSON map of role IDs.
  if (outFile) {
    const roleMap = {};
    for (const name of desiredRoles) {
      const role = byName.get(name);
      if (!role) continue;
      roleMap[name] = role.id;
    }
    try {
      fs.writeFileSync(outFile, JSON.stringify(roleMap, null, 2), 'utf8');
      console.log(`Wrote role map to ${outFile}`);
    } catch (e) {
      logDiscordError(`Failed to write role map to ${outFile}`, e);
    }
  }

  console.log('NBA role sync complete.');
}

// Improved error logging
function logDiscordError(context, err) {
  if (!err) {
    console.error(context, '(Unknown error)');
    return;
  }
  if (err.status || err.code || err.rawError) {
    console.error(`${context}: [status=${err.status}] [code=${err.code}]`, err.rawError || err.message || err);
  } else {
    console.error(`${context}:`, err.message || err);
  }
}

main().catch(err => {
  logDiscordError('NBA role sync failed', err);
  process.exit(1);
});