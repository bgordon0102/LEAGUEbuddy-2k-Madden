// Handles approve/deny button interactions for player progression requests
import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';


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
        await interaction.reply({ content: 'No progression embed found.', ephemeral: true });
        return;
    }

    // Restrict to staff roles only
    const staffMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/staffRoleMap.main.json'), 'utf8'));
    const allowedRoles = [staffMap['Schedule Tracker'], staffMap['Paradise Commish']];
    const memberRoles = interaction.member.roles.cache;
    const isStaff = allowedRoles.some(roleId => memberRoles.has(roleId));
    if (!isStaff) {
        await interaction.reply({ content: 'Only Schedule Tracker or Paradise Commish can approve or deny progression requests.', ephemeral: true });
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
export function handleOvrModal(interaction) {
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
    // Load roster file
    const fileName = teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + '.json';
    const rosterPath = path.join(process.cwd(), 'data/teams_rosters', fileName);
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
}

// Only one export statement for both functions
// (Removed duplicate export block; functions are already exported above)
