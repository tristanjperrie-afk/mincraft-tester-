# Minecraft Datapack Lab

A hosted browser-based datapack preview sandbox with a small HTTP JSON-RPC MCP endpoint.

## Run locally
- Node.js 20+
- `npm install`
- `npm start`
- Open `http://localhost:3000`

## Deploy on Render
Use a Node web service with build command `npm install` and start command `npm start`. The service listens on `PORT`.

## Preview engine scope
The current safe preview engine parses `pack.mcmeta`, function files and load/tick function tags. It supports `function`, `say`, `tellraw` logging, `setblock`, `fill`, and `summon`. Unsupported commands are logged explicitly. This is not a full Java Edition server or complete command implementation. It does not claim parity for scoreboard, execute, predicates, loot tables, advancements, scheduled functions, block states, NBT, or game physics.

## MCP
POST JSON-RPC requests to `/mcp`. Tools:
- `get_sandbox_state`
- `run_function`
- `reset_world`

Upload a datapack through the website before calling the MCP tools. The default session is `default`.

## Safety and limits
Uploads are ZIP files limited to 20 MB. The engine never executes shell commands or arbitrary scripts from datapacks. Fill commands are limited to 50,000 blocks and execution to 12,000 commands per run. State is held in memory and may reset when the hosted service restarts.
