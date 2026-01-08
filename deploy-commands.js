// Deploy Discord commands (root version for src/commands)
import { REST, Routes } from 'discord.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const commands = [];

async function loadCommandsForDeployment() {
  const commandFolders = [
    ['2k', 'staff'],
    ['2k', 'coach'],
    ['madden'],
    ['madden', 'coach'],
    ['madden', 'staff'],
  ];

  for (const parts of commandFolders) {
    const commandsPath = join(__dirname, 'src', 'commands', ...parts);
    const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    const label = parts.join('/');
    console.log(`📂 Loading ${label} commands...`);

    for (const file of commandFiles) {
      const filePath = join(commandsPath, file);
      const fileURL = pathToFileURL(filePath).href;

      try {
        const commandModule = await import(fileURL);
        const command = commandModule.default || commandModule;
        if (command?.skipDeploy) {
          console.log(`⏭️  Skipping ${label}/${file} (skipDeploy=true)`);
          continue;
        }
        if (command && 'data' in command) {
          commands.push(command.data.toJSON());
          console.log(`✅ Loaded ${label}/${file}`);
        } else {
          console.log(`⚠️  Command at ${label}/${file} is missing required "data" property.`);
        }
      } catch (error) {
        console.error(`❌ Error loading command ${label}/${file}:`, error);
      }
    }
  }
}

async function deployCommands() {
  try {
    console.log('🔄 Loading LEAGUEbuddy commands for deployment...');
    await loadCommandsForDeployment();

    console.log(`📊 Loaded ${commands.length} commands total`);
    console.log('🚀 Deploying commands to Discord...');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN || process.env.TOKEN);

    const data = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID || process.env.SERVER_ID),
      { body: commands }
    );

    console.log(`✅ Successfully registered ${data.length} application commands!`);
    console.log('🏀 LEAGUEbuddy commands are ready to use!');

  } catch (error) {
    console.error('❌ Error deploying commands:', error);
    process.exit(1);
  }
}

deployCommands();
