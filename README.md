# LEAGUEbuddy Monorepo

This repo now holds multiple apps and shared packages:
- `apps/leaguebuddy-2k` — existing NBA 2K Discord bot (moved from root).
- `apps/snallabot-service` — Snallabot source (for Madden features/reference).
- `apps/bot` — legacy bot snapshot (left untouched).
- `packages/shared` — placeholder for code shared between bots.
- `packages/madden-core` — placeholder for Madden logic ported from Snallabot.
- `tools` — space for repo-level scripts and helpers.

Node version: `.nvmrc` set to 21 to satisfy Snallabot; use `nvm use`.

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
