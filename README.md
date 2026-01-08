# LEAGUEbuddy Monorepo

This repo now holds multiple apps and shared packages:
- `apps/leaguebuddy-2k` — existing NBA 2K Discord bot (moved from root).
- `apps/snallabot-service` — Snallabot source (for Madden features/reference).
- `apps/bot` — legacy bot snapshot (left untouched).
- `packages/shared` — placeholder for code shared between bots.
- `packages/madden-core` — placeholder for Madden logic ported from Snallabot.
- `tools` — space for repo-level scripts and helpers.

Node version: `.nvmrc` set to 21 to satisfy Snallabot; use `nvm use`.

## Madden EA sync (Snallabot-style)
- Commands: `/madden-sync league_id:<id>` pulls from EA and saves to `src/data/madden/leagues/<id>.json`. `/madden-ping` checks the module.
- Env required: `EA_ACCESS_TOKEN`, `EA_REFRESH_TOKEN`, optional `EA_ACCESS_TOKEN_EXPIRES_AT` (ms epoch), `EA_CONSOLE` (ps5/xbsx/xone/pc/ps4/stadia), `EA_BLAZE_ID` (persona id if known). Tokens expire ~4h; refresh token ~10 days.

## Working on the 2K bot
```
cd apps/leaguebuddy-2k
npm install
npm run start   # or npm run dev
```

## Working on Snallabot
```
cd apps/snallabot-service
npm install
npm run dev
```

## Notes
- Root `node_modules` is from the old layout; reinstall per app as needed.
- Env files stay where you prefer; place per-app `.env` files inside each app for clarity.
