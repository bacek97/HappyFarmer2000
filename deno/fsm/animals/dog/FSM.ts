// DogFSM - Guard module
// Hooks into harvest to protect farm from thieves

import type { HandlerContext, ModuleHook, ModuleAPI } from "../../types.ts";

let config: Record<string, unknown> | null = null;

export function init(api: ModuleAPI) {
    config = api.configs.animals?.dog as Record<string, unknown> | undefined ?? null;
    console.log("[DOG] 🐕 Guard module loaded");
}

export const HOOKS: Record<string, ModuleHook> = {
    harvest: {
        before: guardCheck
    }
};

async function guardCheck(ctx: HandlerContext): Promise<Response | null> {
    // Get object ID from URL
    const objectId = parseInt(ctx.url.searchParams.get("id") || "0");
    if (!objectId) return null;

    // Get crop object
    const crop = await ctx.db.getObject(objectId);
    if (!crop) return null;  // Let main handler return 404

    // Get plot to find owner
    const plot = await ctx.db.getPlotByCrop(objectId);
    if (!plot) return null;

    const plotOwnerId = String(plot.user_id);

    // Own plot? Allow.
    if (plotOwnerId === ctx.userId) {
        return null;
    }

    // Foreign plot - check if owner has a dog
    const dogs = await ctx.db.query(`
    SELECT state FROM game_objects 
    WHERE user_id = $1 AND type_code = 'animal_dog'
    LIMIT 1
  `, [plotOwnerId]);

    if (!dogs || (dogs as unknown[]).length === 0) {
        return null;  // No dog - allow stealing
    }

    // Get block chance from config
    const modConfig = (config?.mod as Record<string, unknown>) || {};
    const dogState = ((dogs as Record<string, unknown>[])[0]?.state as string) || 'hungry';
    const blockChanceFed = (modConfig.block_chance_fed as number) || 0.9;
    const blockChanceHungry = (modConfig.block_chance_hungry as number) || 0.5;
    const blockChance = dogState === 'fed' ? blockChanceFed : blockChanceHungry;

    // Roll dice
    if (Math.random() < blockChance) {
        const messages = (modConfig.message as Record<string, string>) || {};
        const msg = messages.ru || "Собака укусила воришку!";

        return new Response(JSON.stringify({
            error: "dog_bite",
            message: `🐕 ${msg}`,
            blocked: true
        }), {
            status: 403,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }

    // Lucky - dog was sleeping
    console.log(`[DOG] Thief ${ctx.userId} escaped from ${plotOwnerId}'s dog!`);
    return null;
}
