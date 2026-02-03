# WorldBox Cloud MVP (Cloudflare Only)

Cloud-first 2D survival simulator with NPCs forming villages. Everything runs on Cloudflare free tiers:
- Frontend: Cloudflare Pages (Vite + React)
- Backend: Cloudflare Workers + Durable Objects (SQLite-backed)

## Repo Structure
- `apps/web` Vite + React web UI for Pages
- `apps/worker` Cloudflare Worker + Durable Object simulation server
- `wrangler.toml` Durable Object binding and config

## Local Dev
1. Install dependencies: `npm install`
2. Worker dev server: `npm run dev -w apps/worker`
3. Web dev server: `npm run dev -w apps/web`

## Environment Variables
- Worker (set in Cloudflare or `.env` for wrangler):
  - `ADMIN_TOKEN`
  - `WORLD_SIZE` (default 128)
  - `NPC_COUNT` (default 50)
  - `TICK_RATE` (default 1)
- Web (Pages env):
  - `VITE_HTTP_URL=https://your-worker.your-domain.workers.dev`
  - `VITE_WS_URL=wss://your-worker.your-domain.workers.dev/ws`
  - `VITE_BUILD_ID` (any string to verify deploy)
  - `VITE_ADMIN_TOKEN` (same as worker)

## Deploy Worker (Cloudflare Workers)
1. Install Wrangler: `npm i -g wrangler`
2. Login: `wrangler login`
3. From `apps/worker`:
   - `npm install`
   - `npx wrangler deploy`
4. In Cloudflare dashboard, set environment variables under Workers:
   - `ADMIN_TOKEN`, `WORLD_SIZE`, `NPC_COUNT`, `TICK_RATE`
5. Confirm health endpoint: `https://<your-worker>.workers.dev/health`

## Deploy Web (Cloudflare Pages)
1. Create a new Pages project from this repo.
2. Build settings:
   - Root directory: `apps/web`
   - Build command: `npm install && npm run build`
   - Build output: `dist`
3. Add Pages environment variables:
   - `VITE_HTTP_URL`
   - `VITE_WS_URL`
   - `VITE_BUILD_ID`
   - `VITE_ADMIN_TOKEN`
4. Deploy (or trigger a rebuild).

## Verification Checklist
1. Worker endpoints:
   - Open `https://<your-worker>.workers.dev/health` → `{ "ok": true }`
   - Open `https://<your-worker>.workers.dev/world/snapshot` → `npcs.length === NPC_COUNT`
2. Pages app:
   - Open the site and confirm:
     - Connection shows `Live`
     - Tick increments every second
     - Alive NPCs > 0
     - Build shows the `VITE_BUILD_ID` value
3. Browser console:
   - Check the log `CivForge URLs` for resolved `HTTP_BASE` and `WS` URL

## API Overview
- `GET /health`
- `GET /world/snapshot`
- `WS /ws` realtime tick updates
- `POST /admin/pause` (header `x-admin-token`)
- `POST /admin/resume` (header `x-admin-token`)
- `POST /admin/speed` body `{ "rate": 1 | 2 | 5 }`

## Notes
- Simulation runs in a Durable Object using alarms (1 tick/sec by default).
- State persists in Durable Object SQLite (no external DB).
- WebSocket clients reconnect automatically.
