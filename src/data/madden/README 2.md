# Madden Data Imports

To test Madden league imports (Snallabot-style):
1. Set EA env vars (`EA_ACCESS_TOKEN`, `EA_REFRESH_TOKEN`, optional `EA_ACCESS_TOKEN_EXPIRES_AT` in ms epoch, `EA_CONSOLE` like ps5/xbsx, `EA_BLAZE_ID`).
2. Run `/madden-sync league_id:<id>` to pull directly from EA and save to `src/data/madden/leagues/<id>.json`.
3. Use `/madden-ping` to confirm the Madden command group is loaded.
