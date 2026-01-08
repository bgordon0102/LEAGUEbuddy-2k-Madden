# LEAGUEbuddy Data Structure (Refactor Plan)

## New File Layout (in /data/):

- season.json: { "currentWeek": 0, "seasonNo": 1 }
- schedule.json: [ { week, team1, team2 }, ... ]
- teams.json: [ "Hawks", "Celtics", ... ]
- coachRoleMap.json: { "Hawks": "roleId", ... }
- prospectBoards.json: { "pre": "./CUS01/2k26_CUS01 - Preseason Big Board.json", ... }
- standings.json: { "Hawks": { ... }, ... }
- All other league files (scout_points.json, bigboard.json, etc.) remain as is.

## Migration Steps
1. Refactor /startseason to write each section to its own file.
2. Update all commands to read from the new files instead of season.json.
3. Ensure all files are created/reset on /startseason.

## Benefits
- No more risk of empty/overwritten season.json.
- Easier manual editing and debugging.
- Each file is smaller and focused.

---

This file is for developer reference. You can delete it after migration is complete.
