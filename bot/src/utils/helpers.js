/**
 * Utility functions for Discord interactions and formatting
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/**
 * Create a formatted embed for recruit information
 * @param {Object} recruit - Recruit data object
 * @returns {EmbedBuilder} Formatted embed
 */
export function createRecruitEmbed(recruit) {
    return new EmbedBuilder()
        .setTitle(`${recruit.name} - ${recruit.position}`)
        .setColor('#1f8b4c')
        .addFields(
            { name: 'Overall Rating', value: `${recruit.overall}`, inline: true },
            { name: 'Height/Weight', value: `${recruit.height} / ${recruit.weight} lbs`, inline: true },
            { name: 'School', value: recruit.school, inline: true },
            { name: 'Status', value: recruit.status, inline: true },
            { name: 'State', value: recruit.state, inline: true },
            { name: 'Recruiting Level', value: recruit.recruitingLevel, inline: true }
        )
        .setFooter({ text: `Player ID: ${recruit.id}` })
        .setTimestamp();
}

/**
 * Create pagination buttons for lists
 * @param {number} currentPage - Current page number
 * @param {number} totalPages - Total number of pages
 * @returns {ActionRowBuilder} Button row
 */
export function createPaginationButtons(currentPage, totalPages) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('previous')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage <= 1),
            new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage >= totalPages)
        );
}

/**
 * Format team schedule for display
 * @param {Array} games - Array of game objects
 * @param {string} teamId - Team identifier
 * @returns {string} Formatted schedule text
 */
export function formatSchedule(games, teamId) {
    if (!games || games.length === 0) {
        return 'No games scheduled.';
    }

    return games.map(game => {
        const isHome = game.homeTeam === teamId;
        const opponent = isHome ? game.awayTeam : game.homeTeam;
        const venue = isHome ? 'vs' : '@';
        const result = game.result ? ` - ${game.result}` : '';

        return `**Week ${game.week}**: ${venue} ${opponent}${result}`;
    }).join('\n');
}

/**
 * Get team role from user's roles
 * @param {GuildMember} member - Discord guild member
 * @returns {string|null} Team identifier or null
 */
export function getUserTeam(member) {
    // TODO: Implement logic to extract team from user's roles
    // This should match against NBA team role names
    const teamRoles = member.roles.cache.filter(role =>
        // Add logic to identify NBA team roles
        role.name.includes('Lakers') ||
        role.name.includes('Warriors') ||
        role.name.includes('Celtics')
        // Add all NBA teams
    );

    return teamRoles.first()?.name || null;
}

/**
 * Check if user has staff permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} Whether user is staff
 */
export function isStaff(member) {
    return member.roles.cache.some(role =>
        role.name.toLowerCase().includes('staff') ||
        role.name.toLowerCase().includes('admin') ||
        role.name.toLowerCase().includes('commissioner')
    );
}

/**
 * Check if user has coach permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} Whether user is a coach
 */
export function isCoach(member) {
    return member.roles.cache.some(role =>
        role.name.toLowerCase().includes('coach') ||
        getUserTeam(member) !== null
    );
}

/**
 * Create error embed
 * @param {string} message - Error message
 * @returns {EmbedBuilder} Error embed
 */
export function createErrorEmbed(message) {
    return new EmbedBuilder()
        .setTitle('❌ Error')
        .setDescription(message)
        .setColor('#ff0000')
        .setTimestamp();
}

/**
 * Create success embed
 * @param {string} message - Success message
 * @returns {EmbedBuilder} Success embed
 */
export function createSuccessEmbed(message) {
    return new EmbedBuilder()
        .setTitle('✅ Success')
        .setDescription(message)
        .setColor('#00ff00')
        .setTimestamp();
}
