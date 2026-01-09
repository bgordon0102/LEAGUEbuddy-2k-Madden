export type WeekInfo = {
  week: number;
  stage: 'preseason' | 'season' | 'playoffs';
  seasonInfo?: any;
  fetchedAt: string;
};

export type Game = any;

export type Schedule = {
  schedules: Game[];
  fetchedAt: string;
};

export interface MaddenProvider {
  getCurrentWeek(leagueId: string): Promise<WeekInfo>;
  getFullSchedule(leagueId: string): Promise<Schedule>;
  getWeekGames(leagueId: string, week: number): Promise<Game[]>;
}
