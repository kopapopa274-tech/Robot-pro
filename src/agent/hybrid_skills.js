import * as skills from './skills.js';
import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';
import Vec3 from 'vec3';

/*
 * hybrid_skills.js
 * ---------------------------------------------------------------------------
 * Deterministic, non-LLM behaviors that run from modes.js. Nothing in this
 * file ever calls the prompter/model - it's all local Mineflayer + game-state
 * logic, same contract as library/skills.js.
 *
 * NOTE ON REALISM: timings in pillarUp() and attemptFallClutch() (jump-apex
 * delay, water-scoop delay) are heuristics. Mineflayer's tick timing varies
 * with server TPS and latency, so these WILL need tuning against a real
 * server/version before you trust them at survival-critical moments. Test
 * pillarUp() and attemptFallClutch() in a creative/peaceful world first.
 */

function log(bot, message) {
    bot.output += message + '\n';
}

// ---------------------------------------------------------------------------
// Gear tier progression (wood -> stone -> iron -> diamond)
// ---------------------------------------------------------------------------

const TOOL_TIER_RANK = { wooden: 0, stone: 1, iron: 2, golden: 2, diamond: 3, netherite: 4 };
const ARMOR_TIER_RANK = { leather: 0, chainmail: 1, iron: 2, golden: 2, diamond: 3, netherite: 4 };
const TOOL_ORDER = ['wooden', 'stone', 'iron', 'diamond'];
const ARMOR_ORDER = ['leather', 'iron', 'diamond'];

function bestOwnedTierRank(bot, suffix, rankTable) {
    let best = -1;
    for (const item of bot.inventory.items()) {
        if (!item.name.endsWith('_' + suffix)) continue;
        const prefix = item.name.slice(0, -(suffix.length + 1));
        const rank = rankTable[prefix];
        if (rank !== undefined && rank > best) best = rank;
    }
    return best;
}

// exported so modes.js / other code can check "is it even worth trying" cheaply
export function hasUpgradeMaterialHint(bot, kind) {
    const inv = world.getInventoryCounts(bot);
    return (inv['cobblestone'] > 0 || inv['iron_ingot'] > 0 || inv['diamond'] > 0 || inv['stone'] > 0);
}

export async function progressToolTier(bot, kind) {
    /**
 * Attempt to craft (and thereby equip, via craftRecipe's auto-equip-armor and
 * the equip() call below) the next tier up of a single tool/weapon kind, one
 * tier at a time, stopping as soon as materials run out. Does NOT go out and
 * mine new resources - it only uses what's already in inventory/nearby chests.
 * @param {MinecraftBot} bot
 * @param {string} kind - 'sword' | 'pickaxe' | 'axe' | 'shovel'
 * @returns {Promise<boolean>} true if at least one tier upgrade was crafted
 **/
    let bestRank = bestOwnedTierRank(bot, kind, TOOL_TIER_RANK);
    let upgraded = false;
    for (const tier of TOOL_ORDER) {
        const rank = TOOL_TIER_RANK[tier];
        if (rank <= bestRank) continue;
        const itemName = `${tier}_${kind}`;
        let crafted = false;
        try {
            crafted = await skills.craftRecipe(bot, itemName, 1);
        } catch (err) {
            crafted = false;
        }
        if (!crafted) break; // missing materials for this tier - don't skip ahead
        bestRank = rank;
        upgraded = true;
        await skills.equip(bot, itemName);
    }
    return upgraded;
}

export async function progressArmorTier(bot, kind) {
    /**
 * Same idea as progressToolTier but for a piece of armor.
 * @param {MinecraftBot} bot
 * @param {string} kind - 'helmet' | 'chestplate' | 'leggings' | 'boots'
 * @returns {Promise<boolean>}
 **/
    let bestRank = bestOwnedTierRank(bot, kind, ARMOR_TIER_RANK);
    let upgraded = false;
    for (const tier of ARMOR_ORDER) {
        const rank = ARMOR_TIER_RANK[tier];
        if (rank <= bestRank) continue;
        const itemName = `${tier}_${kind}`;
        let crafted = false;
        try {
            crafted = await skills.craftRecipe(bot, itemName, 1);
        } catch (err) {
            crafted = false;
        }
        if (!crafted) break;
        bestRank = rank;
        upgraded = true;
    }
    if (upgraded && bot.armorManager) bot.armorManager.equipAll();
    return upgraded;
}

export async function progressAllGear(bot) {
    /**
 * Runs a single progression pass across all tool/weapon/armor kinds. Meant to
 * be called occasionally while idle, not every tick - crafting attempts that
 * fail are cheap, but there's no reason to hammer them.
 * @param {MinecraftBot} bot
 * @returns {Promise<boolean>} true if anything was upgraded this pass
 **/
    let any = false;
    for (const kind of ['sword', 'pickaxe', 'axe', 'shovel']) {
        if (await progressToolTier(bot, kind)) any = true;
        if (bot.interrupt_code) return any;
    }
    for (const kind of ['helmet', 'chestplate', 'leggings', 'boots']) {
        if (await progressArmorTier(bot, kind)) any = true;
        if (bot.interrupt_code) return any;
    }
    return any;
}

// ---------------------------------------------------------------------------
// Auto-cooking
// ---------------------------------------------------------------------------

const RAW_TO_COOKED = {
    beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
    mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
    salmon: 'cooked_salmon', potato: 'baked_potpotato', // fixed below
};
RAW_TO_COOKED.potato = 'baked_potato';

export async function autoCookRawFood(bot) {
    /**
 * If the bot is holding raw food it could cook, and has fuel + a furnace
 * available, smelt one stack of it. Local-only, no LLM call.
 * @param {MinecraftBot} bot
 * @returns {Promise<boolean>} true if something was cooked
 **/
    const inv = world.getInventoryCounts(bot);
    for (const raw of Object.keys(RAW_TO_COOKED)) {
        if (!inv[raw]) continue;
        const fuel = mc.getSmeltingFuel(bot);
        if (!fuel) return false; // no fuel at all, nothing else to try
        try {
            const ok = await skills.smeltItem(bot, raw, inv[raw]);
            if (ok) {
                log(bot, `Auto-cooked ${inv[raw]} ${raw}.`);
                return true;
            }
        } catch (err) { /* try the next raw food type */ }
    }
    return false;
}

// ---------------------------------------------------------------------------
// MLG fall-damage negation
// ---------------------------------------------------------------------------

function clearanceBelow(bot, maxCheck = 20) {
    const pos = bot.entity.position.floored();
    for (let dy = 1; dy <= maxCheck; dy++) {
        const block = bot.blockAt(pos.offset(0, -dy, 0));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        return dy - 1;
    }
    return maxCheck;
}

export function needsFallClutch(bot) {
    /**
 * Cheap per-tick check for whether a clutch is worth attempting right now.
 * Call this every tick from a mode - it's just arithmetic, no actions taken.
 * @param {MinecraftBot} bot
 * @returns {boolean}
 **/
    if (!bot.entity || bot.entity.onGround) return false;
    if (bot.entity.velocity.y >= -0.6) return false; // not falling fast enough to matter yet
    const clearance = clearanceBelow(bot);
    return clearance >= 3 && clearance < 15; // enough of a fall to hurt, but not an open void
}

export async function attemptFallClutch(bot) {
    /**
 * Executes the best available MLG clutch: water bucket, then boat, then a
 * soft fallback block. Tries to leave the world roughly as it found it (scoops
 * the water back up) but prioritizes not taking fall damage over tidiness.
 * @param {MinecraftBot} bot
 * @returns {Promise<boolean>} true if a clutch was performed
 **/
    const below = bot.entity.position.offset(0, -1, 0).floored();

    const waterBucket = bot.inventory.findInventoryItem('water_bucket');
    if (waterBucket) {
        const placed = await skills.placeBlock(bot, 'water', below.x, below.y, below.z, 'bottom', true).catch(() => false);
        if (placed) {
            log(bot, 'MLG water clutch!');
            // best-effort cleanup; failing to scoop the water back up is not fatal
            setTimeout(async () => {
                try {
                    const waterBlock = bot.blockAt(below);
                    const emptyBucket = bot.inventory.findInventoryItem('bucket');
                    if (emptyBucket && waterBlock && waterBlock.name === 'water') {
                        await bot.equip(emptyBucket, 'hand');
                        await bot.lookAt(waterBlock.position.offset(0.5, 0.5, 0.5));
                        await bot.activateItem();
                    }
                } catch (err) { /* leave the water, not worth crashing over */ }
            }, 500);
            return true;
        }
    }

    const boat = bot.inventory.items().find(i => i.name.endsWith('_boat'));
    if (boat) {
        try {
            await bot.equip(boat, 'hand');
            await bot.look(bot.entity.yaw, -Math.PI / 2, true);
            await bot.activateItem();
            log(bot, 'MLG boat clutch!');
            return true;
        } catch (err) { /* fall through to block fallback */ }
    }

    for (const name of ['slime_block', 'hay_block', 'cobweb']) {
        const item = bot.inventory.findInventoryItem(name);
        if (!item) continue;
        const placed = await skills.placeBlock(bot, name, below.x, below.y, below.z, 'bottom', true).catch(() => false);
        if (placed) {
            log(bot, `MLG ${name} clutch!`);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Multi-tier unstuck primitives (stage 1: dig, stage 2: pillar, stage 3 is
// just skills.moveAway, already implemented in skills.js)
// ---------------------------------------------------------------------------

export async function digOutStuck(bot) {
    /**
 * Stage 1: break the blocks immediately surrounding the bot at foot and head
 * height. breakBlockAt() already auto-equips the right tool per block.
 * @param {MinecraftBot} bot
 * @returns {Promise<boolean>} true if at least one block was dug out
 **/
    const pos = bot.entity.position.floored();
    const offsets = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
    ];
    let dugAny = false;
    for (const [dx, dy, dz] of offsets) {
        if (bot.interrupt_code) break;
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (!block || block.name === 'air' || !block.diggable) continue;
        try {
            const ok = await skills.breakBlockAt(bot, pos.x + dx, pos.y + dy, pos.z + dz);
            if (ok) dugAny = true;
        } catch (err) { /* keep trying the remaining sides */ }
    }
    return dugAny;
}

export async function pillarUp(bot, height = 4) {
    /**
 * Stage 2: pillar straight up using whatever solid building block is
 * available, jumping and placing beneath the bot's own feet. This
 * deliberately avoids skills.placeBlock's pathfinder "back away first" logic
 * (which is wrong for placing a block directly under yourself mid-jump) and
 * instead places directly against the block below via the raw bot API.
 * @param {MinecraftBot} bot
 * @param {number} height - how many blocks to try to pillar up
 * @returns {Promise<boolean>} true if at least one block was placed
 **/
    const buildMaterials = ['cobblestone', 'stone', 'dirt', 'netherrack', 'cobbled_deepslate', 'oak_planks'];
    let placedTotal = 0;
    for (let i = 0; i < height; i++) {
        if (bot.interrupt_code) break;
        const material = buildMaterials
            .map(name => bot.inventory.findInventoryItem(name))
            .find(item => item);
        if (!material) break;
        const belowBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!belowBlock || belowBlock.name === 'air') break;
        try {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 250)); // heuristic: wait near jump apex, needs live tuning
            await bot.equip(material, 'hand');
            await bot.lookAt(belowBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
            placedTotal++;
        } catch (err) {
            break; // timing was off this attempt - let the caller decide whether to retry
        } finally {
            bot.setControlState('jump', false);
        }
        await new Promise(r => setTimeout(r, 150));
    }
    return placedTotal > 0;
}

// ---------------------------------------------------------------------------
// Tactical combat: traps + a trap-aware wrapper around skills.defendSelf
// ---------------------------------------------------------------------------

export async function placeTacticalTrap(bot, enemy) {
    /**
 * Places a hazard at/under the target enemy: lava if available and the bot is
 * at a safe distance, otherwise a cobweb to slow it, otherwise (if the bot
 * isn't standing right next to it) digs a one-block pit beneath it.
 * @param {MinecraftBot} bot
 * @param {Entity} enemy
 * @returns {Promise<boolean>} true if a trap was placed
 **/
    if (!enemy || !enemy.position) return false;
    const pos = enemy.position.floored();
    const dist = bot.entity.position.distanceTo(enemy.position);

    const lava = bot.inventory.findInventoryItem('lava_bucket');
    if (lava && dist >= 2.5 && dist <= 5) {
        const ok = await skills.placeBlock(bot, 'lava', pos.x, pos.y, pos.z, 'bottom', true).catch(() => false);
        if (ok) { log(bot, 'Placed a lava trap!'); return true; }
    }

    const cobweb = bot.inventory.findInventoryItem('cobweb');
    if (cobweb) {
        const ok = await skills.placeBlock(bot, 'cobweb', pos.x, pos.y, pos.z, 'bottom', true).catch(() => false);
        if (ok) { log(bot, 'Trapped the enemy in a cobweb!'); return true; }
    }

    if (dist > 1.5) {
        const under = bot.blockAt(pos.offset(0, -1, 0));
        if (under && under.diggable && under.name !== 'air') {
            const ok = await skills.breakBlockAt(bot, pos.x, pos.y - 1, pos.z).catch(() => false);
            if (ok) { log(bot, 'Dug a pit trap under the enemy!'); return true; }
        }
    }
    return false;
}

export async function tacticalDefendSelf(bot, range = 9) {
    /**
 * Trap-aware replacement for skills.defendSelf: if the bot is at low health
 * and an enemy is close, try to place a trap once before committing to the
 * fight, then defend normally either way.
 * @param {MinecraftBot} bot
 * @param {number} range
 * @returns {Promise<boolean>}
 **/
    const enemy = world.getNearestEntityWhere(bot, e => mc.isHostile(e), range);
    if (enemy && bot.health <= 10 && bot.entity.position.distanceTo(enemy.position) <= 5) {
        await placeTacticalTrap(bot, enemy).catch(() => {});
    }
    return await skills.defendSelf(bot, range);
}

// ---------------------------------------------------------------------------
// Autonomous shelter construction
// ---------------------------------------------------------------------------

async function ensureHave(bot, itemName, num = 1) {
    const have = world.getInventoryCounts(bot)[itemName] || 0;
    if (have >= num) return true;
    try {
        return await skills.craftRecipe(bot, itemName, num - have);
    } catch (err) {
        return false;
    }
}

export async function buildShelter(bot, material = 'cobblestone') {
    /**
 * Scans for a flat 5x5 area, clears a 3-tall interior, builds perimeter walls
 * with a doorway, a roof, and (if the bot has or can craft them) a door, bed,
 * chest, furnace and crafting table inside. This is a simple deterministic
 * builder, not a full construction planner - it assumes the chosen area is
 * roughly flat (getNearestFreeSpace already filters for diggable, non-air-gap
 * ground) and will skip any furnishing it can't obtain.
 * @param {MinecraftBot} bot
 * @param {string} material - wall/roof block, defaults to cobblestone
 * @returns {Promise<boolean>} true if the shelter was completed
 **/
    const size = 5;
    const corner = world.getNearestFreeSpace(bot, size, 20);
    if (!corner) {
        log(bot, 'Could not find a flat area to build a shelter.');
        return false;
    }
    const baseY = corner.y;
    const doorX = corner.x + Math.floor(size / 2);
    const doorZ = corner.z;

    const wallBlocksPerLayer = size * size - (size - 2) * (size - 2);
    const roofBlocks = size * size;
    const needed = wallBlocksPerLayer * 2 + roofBlocks; // 2 wall layers + roof
    const have = world.getInventoryCounts(bot)[material] || 0;
    if (have < needed) {
        await skills.collectBlock(bot, 'stone', needed - have).catch(() => {});
    }

    log(bot, `Building a shelter near ${corner.x}, ${corner.y}, ${corner.z}.`);

    // clear interior air space, 3 blocks tall
    for (let y = 0; y < 3 && !bot.interrupt_code; y++) {
        for (let x = 0; x < size && !bot.interrupt_code; x++) {
            for (let z = 0; z < size && !bot.interrupt_code; z++) {
                await skills.breakBlockAt(bot, corner.x + x, baseY + y, corner.z + z).catch(() => {});
            }
        }
    }

    // walls, 2 layers tall, leaving a doorway gap
    for (let y = 0; y < 2 && !bot.interrupt_code; y++) {
        for (let x = 0; x < size && !bot.interrupt_code; x++) {
            for (let z = 0; z < size && !bot.interrupt_code; z++) {
                const onEdge = x === 0 || x === size - 1 || z === 0 || z === size - 1;
                if (!onEdge) continue;
                const worldX = corner.x + x, worldZ = corner.z + z;
                if (y < 2 && worldX === doorX && worldZ === doorZ) continue;
                await skills.placeBlock(bot, material, worldX, baseY + y, worldZ, 'bottom').catch(() => {});
            }
        }
    }

    // roof
    for (let x = 0; x < size && !bot.interrupt_code; x++) {
        for (let z = 0; z < size && !bot.interrupt_code; z++) {
            await skills.placeBlock(bot, material, corner.x + x, baseY + 2, corner.z + z, 'bottom').catch(() => {});
        }
    }

    if (bot.interrupt_code) return false;

    // furnishings - best effort, craft if missing and possible, skip if not
    const doorItem = bot.inventory.items().find(i => i.name.endsWith('_door')) || (await (async () => {
        await ensureHave(bot, 'oak_door', 1);
        return bot.inventory.items().find(i => i.name.endsWith('_door'));
    })());
    if (doorItem) await skills.placeBlock(bot, doorItem.name, doorX, baseY, doorZ, 'bottom').catch(() => {});

    const insideX = corner.x + 1;
    const insideZ = corner.z + 1;

    await ensureHave(bot, 'crafting_table', 1);
    if (world.getInventoryCounts(bot)['crafting_table'])
        await skills.placeBlock(bot, 'crafting_table', insideX, baseY, insideZ, 'bottom').catch(() => {});

    await ensureHave(bot, 'furnace', 1);
    if (world.getInventoryCounts(bot)['furnace'])
        await skills.placeBlock(bot, 'furnace', insideX + 1, baseY, insideZ, 'bottom').catch(() => {});

    await ensureHave(bot, 'chest', 1);
    if (world.getInventoryCounts(bot)['chest'])
        await skills.placeBlock(bot, 'chest', insideX, baseY, insideZ + 1, 'bottom').catch(() => {});

    const bed = bot.inventory.items().find(i => i.name.endsWith('_bed'));
    if (bed) await skills.placeBlock(bot, bed.name, insideX + 1, baseY, insideZ + 1, 'bottom').catch(() => {});

    log(bot, 'Shelter complete.');
    return true;
}
