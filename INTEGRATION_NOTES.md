# Hybrid Agent — integration notes

## Where these files go

| File in this delivery      | Replaces / creates                      |
|-----------------------------|------------------------------------------|
| `settings.js`                | `./settings.js` (repo root)              |
| `modes.js`                   | `./src/agent/modes.js`                   |
| `hybrid_skills.js`           | `./src/agent/library/hybrid_skills.js` (**new file**) |
| `index.js`                   | `./src/agent/library/index.js`           |

Nothing else in the repo needs to change. `skills.js`, `world.js`, `agent.js`, `action_manager.js`, etc. are untouched.

## Read this before you assume everything below is new

A good chunk of what your brief asked for was **already implemented** in this codebase before I touched anything:

- **Armor auto-equip** — `mineflayer-armor-manager` is already loaded (`src/utils/mcdata.js`) and already auto-equips the best armor you own after every craft (`bot.armorManager.equipAll()` inside `craftRecipe`).
- **Auto-eat when hungry** — `mineflayer-auto-eat` is already loaded and configured in `agent.js`.
- **Critical/jump hits, pathing around enemies during combat** — `mineflayer-pvp` is already loaded and `skills.defendSelf` / `attackEntity` already use it; the plugin handles the jump-hit timing internally.
- **Self-preservation from fire/lava/drowning/low health, cowardice, hunting, item pickup, torch placing, "elbow room," idle look-around** — all pre-existing modes in `modes.js`, untouched here.
- **De-spamming chat/console** — this was just two config flags (`narrate_behavior`, `show_command_syntax`), already present in `settings.js`. I flipped them off; no code changes needed.

## What's actually new in this delivery

- **`fall_clutch` mode + `attemptFallClutch`/`needsFallClutch`** — MLG water/boat/soft-block clutch, checked every tick, bypasses the normal action queue so it can react within a tick or two.
- **3-stage `unstuck` escalation** — dig-out (`digOutStuck`) → pillar-up (`pillarUp`) → the pre-existing `moveAway` fallback, with the mode remembering which stage it's on.
- **`progressToolTier`/`progressArmorTier`/`progressAllGear`** — wood→stone→iron→diamond crafting progression, run periodically while idle (`auto_progression` mode).
- **`autoCookRawFood`** — smelts raw food when hunger is low and a furnace/fuel are available (`auto_cook` mode).
- **`placeTacticalTrap`/`tacticalDefendSelf`** — lava/cobweb/pit trap before committing to a fight the bot is losing; `self_defense` mode now calls this instead of plain `defendSelf`.
- **`buildShelter`** — scans for a flat 5×5 spot, clears it, builds walls/roof/doorway, and places a door/bed/chest/furnace/crafting table if available or craftable. Wired to an `auto_shelter` mode that fires once per session near nightfall if no bed is nearby.

## Please test before you trust these near danger

I don't have a live Minecraft server to run this against, so I validated the code by reading it against the actual APIs this repo already uses (`skills.js`, `world.js`, `mcdata.js`) and by syntax-checking every file — not by playing it. Two things in particular are timing-sensitive and will need tuning on your server/version:

1. **`pillarUp`** — the jump-then-place timing (`250ms`/`150ms` waits) is a heuristic. If your server's tick rate or your connection latency differs, the bot may whiff placements. Test it somewhere falling doesn't matter before relying on it underground.
2. **`attemptFallClutch`** — the velocity/clearance thresholds (`velocity.y < -0.6`, 3–15 block clearance) are reasonable starting points, not measured against a real fall-damage curve for your Minecraft version. Test in creative/peaceful first, then dial in.

Also: `buildShelter` is a simple deterministic builder, not a construction planner — it doesn't check for uneven multi-level terrain beyond what `getNearestFreeSpace` already filters for, and it doesn't orient the door toward anything in particular. It's meant to produce "a functional box with the essentials," not a good-looking base.

## One thing I did *not* build

The brief asked for automatic resource gathering as part of gear progression ("Automatically handles tier progression"). `progressAllGear` only **crafts and equips** the next tier from materials already in inventory/nearby — it does not send the bot out mining for ore it doesn't have. Autonomously deciding when/where to go mining safely (path planning around lava, caves, mob density) is a meaningfully bigger project on its own, and bolting it on here would have meant shipping logic I couldn't ground in this codebase's existing conventions with any confidence. If you want that next, it'd build naturally on `auto_progression` — happy to take it on as a follow-up once the above is confirmed working.
