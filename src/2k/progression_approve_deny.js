// Handles approve/deny button interactions for player progression requests
import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const REGRESSION_CHANNEL_ID = '1455069209523650590';
const REGRESSION_LOG_PATH = path.join(process.cwd(), 'data', 'regression.json');
const REGRESSION_SKILLS = [
    'driving',
    'shooting',
    'post scoring',
    'playmaking',
    'interior defense',
    'perimeter defense',
    'rebounding',
    'iq',
];

function readRegressionLog() {
    try {
        return JSON.parse(fs.readFileSync(REGRESSION_LOG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeRegressionLog(log) {
    try {
        fs.writeFileSync(REGRESSION_LOG_PATH, JSON.stringify(log ?? {}, null, 2));
    } catch (err) {
        console.error('[regression] Failed to write regression log:', err);
    }
}

function normalizeSkill(str = '') {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}


export const customId = /^progression_(approve|deny)_.+/;

export async function execute(interaction) {
    // Button customId format: progression_approve_Player Name or progression_deny_Player Name
    const customId = interaction.customId;
    const isApprove = customId.startsWith('progression_approve_');
    const playerName = customId.replace('progression_approve_', '').replace('progression_deny_', '');

    // Find the embed message
    const message = interaction.message;
    const embed = message.embeds[0];
    if (!embed) {
        await interaction.reply({ content: 'No progression embed found.', flags: 64 });
        return;
    }

    // Restrict to staff roles only
    const staffMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/staffRoleMap.main.json'), 'utf8'));
    const allowedRoles = [staffMap['Schedule Tracker'], staffMap['Paradise Commish']];
    const memberRoles = interaction.member.roles.cache;
    const isStaff = allowedRoles.some(roleId => memberRoles.has(roleId));
    if (!isStaff) {
        await interaction.reply({ content: 'Only Schedule Tracker or Paradise Commish can approve or deny progression requests.', flags: 64 });
        return;
    }

    if (isApprove) {
        // Show modal to enter new OVR
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
        const modal = new ModalBuilder()
            .setCustomId(`progression_ovr_modal_${playerName}`)
            .setTitle('Update Player OVR');
        const ovrInput = new TextInputBuilder()
            .setCustomId('newOvr')
            .setLabel('Enter new OVR (if changed)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(ovrInput));
        await interaction.showModal(modal);
        return;
    } else {
        // Update embed with denial
        const status = '❌ Denied by Staff';
        const updatedEmbed = EmbedBuilder.from(embed).addFields({ name: 'Status', value: status });
        await interaction.deferUpdate();
        await message.edit({ embeds: [updatedEmbed], components: [] });
    }
    // end of execute function
}

// Handle modal submit for OVR update
export async function handleOvrModal(interaction) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('progression_ovr_modal_')) return;
    const playerName = interaction.customId.replace('progression_ovr_modal_', '');
    const newOvr = interaction.fields.getTextInputValue('newOvr').trim();
    // Find team from embed
    const message = interaction.message || interaction;
    const embed = message.embeds?.[0] || interaction.message?.embeds?.[0];
    let teamName = '';
    if (embed) {
        const teamField = embed.fields?.find(f => f.name.toLowerCase().includes('team'));
        if (teamField) teamName = teamField.value;
    }
    if (!teamName) {
        interaction.reply({ content: 'Could not determine team for OVR update.', ephemeral: true });
        return;
    }
    const regressionLog = readRegressionLog();
    // Load roster file
    const fileName = teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + '.json';
    const rosterPath = path.join(process.cwd(), 'data/2k/teams_rosters', fileName);
    if (!fs.existsSync(rosterPath)) {
        interaction.reply({ content: 'Roster file not found.', ephemeral: true });
        return;
    }
    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const players = Array.isArray(roster) ? roster : roster.players || [];
    const idx = players.findIndex(p => p.name?.toLowerCase() === playerName.toLowerCase());
    if (idx === -1) {
        interaction.reply({ content: 'Player not found in roster.', ephemeral: true });
        return;
    }
    if (newOvr) {
        players[idx].ovr = newOvr;
        if (Array.isArray(roster)) {
            fs.writeFileSync(rosterPath, JSON.stringify(players, null, 2));
        } else {
            roster.players = players;
            fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
        }
    }
    // Update embed with approval
    const status = '✅ Approved by Staff';
    const updatedEmbed = EmbedBuilder.from(embed).addFields({ name: 'Status', value: status });
    interaction.reply({ content: 'Progression approved.' + (newOvr ? ` OVR updated to ${newOvr}.` : ''), ephemeral: true });
    message.edit({ embeds: [updatedEmbed], components: [] });

    // --- Regression tracking: minus one per approved upgrade ---
    try {
        const teamEntry = regressionLog[teamName] || {};
        const playerEntry = teamEntry[playerName] || { count: 0, logs: [], regressionMessageId: null };
        // Extract extra details from embed if available
        const skillFieldRaw = embed.fields?.find(f => f.name.toLowerCase().includes('skill'))?.value || '';
        const tokens = skillFieldRaw
            .split(/[,/&+]| and /i)
            .map(s => s.trim())
            .filter(Boolean)
            .map(normalizeSkill);
        const matched = tokens
            .map(t => REGRESSION_SKILLS.find(s => normalizeSkill(s) === t))
            .filter(Boolean);
        const regIncrement = matched.length > 0 ? matched.length : 0;
        playerEntry.count = (playerEntry.count || 0) + regIncrement;
        const skillField = matched.length > 1 ? matched.join(', ') : (skillFieldRaw || 'N/A');
        const attrField = embed.fields?.find(f => f.name.toLowerCase().includes('attribute'))?.value || '';
        playerEntry.logs = playerEntry.logs || [];
        playerEntry.logs.push({
            date: new Date().toISOString(),
            reviewer: interaction.user.id,
            skillSet: skillField,
            skillSets: matched,
            attributes: attrField,
            newOvr: newOvr || null,
            regIncrement,
            messageId: message.id,
        });
        teamEntry[playerName] = playerEntry;
        regressionLog[teamName] = teamEntry;
        // Build embed once
        // Tag coach role for transparency
        let coachRoleTag = '';
        try {
            const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
            const roleId = coachMap[teamName];
            if (roleId) coachRoleTag = `<@&${roleId}>`;
        } catch {
            coachRoleTag = '';
        }

        // Aggregate all skill sets to show cumulative regression sources
        const allSkillSets = Array.from(
            new Set(
                (playerEntry.logs || [])
                    .flatMap(log => Array.isArray(log.skillSets) ? log.skillSets : (log.skillSet ? [log.skillSet] : []))
                    .map(s => (s || '').toString().trim())
                    .filter(Boolean)
            )
        );

        const regEmbed = new EmbedBuilder()
            .setTitle(`Regression Track • ${teamName}`)
            .setColor(0xED4245)
            .addFields(
                { name: 'Player', value: `${playerName}${coachRoleTag ? ` (${coachRoleTag})` : ''}`, inline: true },
                { name: 'Regressions', value: `-${playerEntry.count} OVR (this approval: -${regIncrement}${matched.length > 1 ? ` across ${matched.length} skill sets` : ''})`, inline: true },
                { name: 'Skill Set (this approval)', value: skillField || 'N/A', inline: false },
                { name: 'All Skill Sets (cumulative)', value: allSkillSets.length ? allSkillSets.join(', ') : 'N/A', inline: false },
                { name: 'Attribute Upgrades', value: attrField || 'N/A', inline: false },
                { name: 'Reviewed By', value: `<@${interaction.user.id}>`, inline: false },
            )
            .setTimestamp(new Date());

        const regressionChannel = await interaction.client.channels.fetch(REGRESSION_CHANNEL_ID).catch(() => null);
        if (regressionChannel) {
            let sentMsg = null;
            if (playerEntry.regressionMessageId) {
                try {
                    const existingMsg = await regressionChannel.messages.fetch(playerEntry.regressionMessageId);
                    sentMsg = await existingMsg.edit({ embeds: [regEmbed] });
                } catch (err) {
                    console.error('[regression] Failed to edit existing regression message, will create new:', err);
                    playerEntry.regressionMessageId = null;
                }
            }
            if (!sentMsg) {
                sentMsg = await regressionChannel.send({ embeds: [regEmbed] });
                playerEntry.regressionMessageId = sentMsg.id;
            }
            teamEntry[playerName] = playerEntry;
            regressionLog[teamName] = teamEntry;
            writeRegressionLog(regressionLog);
        } else {
            console.error('[regression] Regression channel not found.');
            writeRegressionLog(regressionLog);
        }
    } catch (err) {
        console.error('[regression] Failed to log/send regression:', err);
    }
}

// Only one export statement for both functions
// (Removed duplicate export block; functions are already exported above)
