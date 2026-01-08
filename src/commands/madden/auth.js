import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { EA_LOGIN_URL, APP_REDIRECT_URL, CLIENT_ID, CLIENT_SECRET, AUTH_SOURCE } from '../../madden/ea_constants.js';

const data = new SlashCommandBuilder()
  .setName('madden-auth')
  .setDescription('Link your EA account for Madden sync.')
  .addStringOption(option =>
    option.setName('redirect_url')
      .setDescription('Paste the URL you land on after EA login (starts with http://127.0.0.1/success?code=...)')
      .setRequired(false)
  );

const TOKEN_FILE = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

function ensureTokenDir() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
}

async function exchangeCode(code, redirectUrl) {
  const body = `authentication_source=${AUTH_SOURCE}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${redirectUrl}&release_type=prod&client_id=${CLIENT_ID}&token_format=JWS`;
  const res = await fetch('https://accounts.ea.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept-Charset': 'UTF-8',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)',
      'Accept-Encoding': 'gzip',
    },
    body
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`EA token exchange failed: ${JSON.stringify(json)}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiry: Date.now() + (json.expires_in || 0) * 1000,
  };
}

function saveTokens(tokens) {
  ensureTokenDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function parseCodeAndRedirect(input) {
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    if (!code) return null;
    return { code, redirect: `${url.origin}${url.pathname}` };
  } catch {
    // allow raw code only
    return { code: input, redirect: APP_REDIRECT_URL };
  }
}

async function execute(interaction) {
  const redirectUrl = interaction.options.getString('redirect_url');

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
    await interaction.reply({ ephemeral: true, embeds: [embed] });
    return;
  }

  try {
    const parsed = parseCodeAndRedirect(redirectUrl);
    if (!parsed || !parsed.code) {
      throw new Error('Could not find ?code= in the URL you provided.');
    }
    const tokens = await exchangeCode(parsed.code, parsed.redirect);
    tokens.console = process.env.EA_CONSOLE || 'ps5';
    tokens.blazeId = process.env.EA_BLAZE_ID || '';
    saveTokens(tokens);

    const embed = new EmbedBuilder()
      .setTitle('Madden Auth Complete')
      .setDescription('Tokens saved. You can now run /madden-sync.')
      .addFields(
        { name: 'Expires', value: new Date(tokens.expiry).toISOString(), inline: true },
        { name: 'Console', value: tokens.console, inline: true },
        { name: 'Stored at', value: TOKEN_FILE, inline: false }
      )
      .setColor(0x00cc66);
    await interaction.reply({ ephemeral: true, embeds: [embed] });
  } catch (err) {
    const embed = new EmbedBuilder()
      .setTitle('Madden Auth Failed')
      .setDescription(err.message || 'Unknown error')
      .setColor(0xcc0000);
    await interaction.reply({ ephemeral: true, embeds: [embed] });
  }
}

export default { data, execute };
