// Lightweight runtime definitions for Madden provider contracts.
// JSDoc types are included to keep IDE hints without requiring TypeScript at runtime.

/**
 * @typedef {Object} WeekInfo
 * @property {number} week
 * @property {string} stage
 * @property {any} seasonInfo
 * @property {string} fetchedAt
 */

/**
 * @typedef {Object} Schedule
 * @property {any[]} schedules
 * @property {string} fetchedAt
 */

/**
 * @typedef {Object} Game
 * @property {any} [leagueId]
 */

/**
 * @interface
 */
export class MaddenProvider {
  /**
   * @param {string} _leagueId
   * @returns {Promise<WeekInfo>}
   */
  // eslint-disable-next-line class-methods-use-this
  async getCurrentWeek(_leagueId) {
    throw new Error('Not implemented');
  }

  /**
   * @param {string} _leagueId
   * @returns {Promise<Schedule>}
   */
  // eslint-disable-next-line class-methods-use-this
  async getFullSchedule(_leagueId) {
    throw new Error('Not implemented');
  }

  /**
   * @param {string} _leagueId
   * @param {number} _week
   * @returns {Promise<Game[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async getWeekGames(_leagueId, _week) {
    throw new Error('Not implemented');
  }
}

export default MaddenProvider;
