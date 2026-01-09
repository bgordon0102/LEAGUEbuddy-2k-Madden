import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { EA_LOGIN_URL, YEAR, ConsoleOverride } from '../../madden/ea_constants.js';
import { exchangeLoginCode, fetchTokenInfo, fetchEntitlements, fetchPersonas, extractValidPersonas, exchangePersonaToken } from '../../madden/ea_personas.js';
import { saveTokens as saveTokensDb, deleteTokens as deleteTokensDb } from '../../madden/madden_db.js';

const data = new SlashCommandBuilder()
  .setName('madden-auth')
  .setDescription('Link your EA account for Madden sync.')
  .addStringOption(option =>
    option.setName('redirect_url')
      .setDescription('Paste the URL you land on after EA login (starts with http://127.0.0.1/success?code=...)')
      .setRequired(false)
  )
  .addBooleanOption(option =>
    option.setName('reset')
      .setDescription('Clear saved Madden tokens before authenticating again')
      .setRequired(false)
  );

const TOKEN_FILE = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

function ensureTokenDir() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
}

function saveTokens(tokens) {
  ensureTokenDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  saveTokensDb(tokens);
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const redirectUrl = interaction.options.getString('redirect_url');
  const doReset = interaction.options.getBoolean('reset');
  const consoleOverride = ConsoleOverride.NONE;

  if (doReset) {
    try { fs.unlinkSync(TOKEN_FILE); } catch {}
    deleteTokensDb();
    if (!redirectUrl) {
      const embed = new EmbedBuilder()
        .setTitle('Madden Tokens Reset')
        .setDescription('Saved Madden tokens cleared. Run /madden-auth with redirect_url to relink.')
        .setColor(0xffcc00);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  }

  if (!redirectUrl) {
    const embed = new EmbedBuilder()
      .setTitle('Madden EA Login')
      .setDescription('Link your EA account so the bot can sync your league.')
      .addFields(
        { name: 'Step 1', value: `Click and sign in: ${EA_LOGIN_URL}` },
        { name: 'Step 2', value: 'You will land on a page at http://127.0.0.1/success?... Copy that entire URL.' },
        { name: 'Step 3', value: 'Run /madden-auth again and paste the URL into redirect_url. Tokens will be saved locally.' }
      )
      .setColor(0x5865f2);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  try {
    const loginTokens = await exchangeLoginCode(redirectUrl);
    const tokenInfo = await fetchTokenInfo(loginTokens.access_token);
    const pid = tokenInfo?.pid_id;
    if (!pid) throw new Error('No pid_id returned from tokeninfo.');
    const entRes = await fetchEntitlements(pid, loginTokens.access_token);
    const entitlements = entRes?.entitlements?.entitlement || [];
    const personaResponses = await Promise.all(entitlements.map(async ent => ({ ent, personas: await fetchPersonas(ent.pidUri, loginTokens.access_token) })));
    const personas = extractValidPersonas(entRes, personaResponses, consoleOverride);
    if (!personas.length) {
      throw new Error('No Madden personas found for this EA account (check entitlements and platform).');
    }
    const pickPersona = () => {
      // Prefer PS5 or next-gen Madden 26 entitlements if present.
      const score = p => {
        let s = 0;
        const ent = `${p.entitlement || ''}`.toUpperCase();
        const ns = `${p.namespaceName || ''}`.toUpperCase();
        if (p.systemConsole && p.systemConsole.toLowerCase() === 'ps5') s += 5;
        if (p.systemConsole && p.systemConsole.toLowerCase() === 'xbsx') s += 4;
        if (ent.includes('MADDEN_26')) s += 3;
        if (ns.includes('MADDEN')) s += 1;
        return s;
      };
      const sorted = [...personas].sort((a, b) => score(b) - score(a));
      return sorted[0];
    };
    const chosen = pickPersona();
    const personaToken = await exchangePersonaToken(loginTokens.access_token, chosen.personaId, chosen.namespaceName);
    const tokens = {
      accessToken: personaToken.access_token,
      refreshToken: personaToken.refresh_token,
      expiry: Date.now() + (personaToken.expires_in || 0) * 1000,
      console: chosen.systemConsole || process.env.EA_CONSOLE || 'ps5',
      blazeId: `${chosen.personaId}`,
      gameYear: YEAR,
    };
    saveTokens(tokens);

    const embed = new EmbedBuilder()
      .setTitle('Madden Auth Complete')
      .setDescription('Tokens saved. You can now run /madden-sync.')
      .addFields(
        { name: 'Expires', value: new Date(tokens.expiry).toISOString(), inline: true },
        { name: 'Console', value: tokens.console, inline: true },
        { name: 'Persona', value: `${chosen.displayName} (${chosen.personaId})`, inline: false },
        { name: 'Entitlement', value: chosen.entitlement, inline: false },
        { name: 'Namespace', value: chosen.namespaceName, inline: false },
        { name: 'Stored at', value: TOKEN_FILE, inline: false },
        { name: 'Game Year', value: `${YEAR}`, inline: true }
      )
      .setColor(0x00cc66);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const embed = new EmbedBuilder()
      .setTitle('Madden Auth Failed')
      .setDescription(err.message || 'Unknown error')
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
