# Madden EA Client (Snallabot-style)

We pulled a minimal EA client from Snallabot to fetch Madden data directly from EA. No Firebase needed for the sync command.

Required env vars:
- `EA_ACCESS_TOKEN` – current EA access token (expires ~4h)
- `EA_REFRESH_TOKEN` – refresh token (lasts ~10 days)
- `EA_ACCESS_TOKEN_EXPIRES_AT` – optional ms epoch for current access token expiry
- `EA_CONSOLE` – one of `ps5|xbsx|xone|pc|ps4|stadia` (defaults to `ps5`)
- `EA_BLAZE_ID` – persona id (optional)

Flow:
- `/madden-sync league_id:<id>` → uses `src/madden/ea_client.js` to refresh token, open a Blaze session, fetch league info, teams, standings, and the current week schedule, then save to `src/data/madden/leagues/<id>.json`.
- Helpers: `src/madden/ea_constants.js`, `src/madden/madden_utils.js`.
