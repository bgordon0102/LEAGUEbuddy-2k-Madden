import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { createEAClientFromEnv } from '../../madden/ea_client.js';
import { YEAR } from '../../madden/ea_constants.js';

const tokenFile = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

async function loadTokens() {
  try {
    const txt = await fs.readFile(tokenFile, 'utf-8');
    const parsed = JSON.parse(txt);
    if (parsed?.gameYear && `${parsed.gameYear}` !== `${YEAR}`) {
      console.warn(`[madden-leagues] Ignoring cached tokens from year ${parsed.gameYear}, current YEAR=${YEAR}`);
      try { await fs.unlink(tokenFile); } catch {}
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const data = new SlashCommandBuilder()
  .setName('madden-leagues')
  .setDescription('List leagues available for the EA account (requires saved tokens).');

function shorten(msg, max = 1000) {
  if (!msg) return 'Unknown error';
  const str = String(msg);
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
      const embed = new EmbedBuilder()
        .setTitle('Madden Leagues')
        .setDescription('No EA tokens found. Run /madden-auth with the redirect URL first.')
        .setColor(0xffcc00);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    const client = await createEAClientFromEnv({
      ...process.env,
      EA_ACCESS_TOKEN: tokens.accessToken,
      EA_REFRESH_TOKEN: tokens.refreshToken,
      EA_ACCESS_TOKEN_EXPIRES_AT: tokens.expiry,
      EA_CONSOLE: tokens.console,
      EA_BLAZE_ID: tokens.blazeId,
      EA_GAME_YEAR: tokens.gameYear
    });
    const leagues = await client.getLeagues();
    const items = leagues.map(l => `**${l.leagueId}** — ${l.leagueName || 'Unnamed'} (Season ${l.seasonText || ''})`).slice(0, 10);
    const embed = new EmbedBuilder()
      .setTitle('Madden Leagues')
      .setDescription(items.length ? items.join('\n') : 'No leagues found for this account.')
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    if ((err?.message || '').includes('Server Information was not found')) {
      try { await fs.unlink(tokenFile); } catch {}
    }
    console.error('Madden leagues failed:', err);
    const description = shorten(err?.message, 3900);
    const embed = new EmbedBuilder()
      .setTitle('Madden Leagues Failed')
      .setDescription(`${description}\n(See server logs for full details)`)
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
