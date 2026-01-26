// CropFSM - Конечный автомат для культур
// ========================================

import type { ModuleAPI, HandlerContext } from "../types.ts";

// ENDPOINTS - for documentation only, actual registration in init()
export const ENDPOINTS = {
    PLANT: 'plant',            // ?plot_id=1&crop=tomato&x=1&y=2
    HARVEST: 'harvest',        // ?id=1
    WATER: 'water',            // ?id=1
    REMOVE_PEST: 'remove_pest', // ?id=1
    STEAL: 'steal',            // ?id=1
    THROW_PEST: 'throw_pest'   // ?id=1
} as const;

// ===== HASURA HELPER =====
const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT") || "https://happy-farmer-2000.hasura.app/v1/graphql";
const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN") || "";

async function hasuraQuery(query: string, variables: Record<string, unknown> = {}, userId?: string) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (SERVICE_USER_TOKEN) {
        headers["Authorization"] = SERVICE_USER_TOKEN;
    }

    if (userId) {
        headers["X-Hasura-Role"] = "user";
        headers["X-Hasura-User-Id"] = userId;
    }

    const res = await fetch(HASURA_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });

    const json = await res.json();
    if (json.errors) {
        console.error("Hasura Error:", json.errors);
        throw new Error(json.errors[0]?.message || "GraphQL Error");
    }
    return json.data;
}

// ===== MODULE INIT =====
let CONFIGS: Record<string, Record<string, unknown>> = {};

export function init(api: ModuleAPI) {
    CONFIGS = api.configs;

    api.registerEndpoint(ENDPOINTS.PLANT, handlePlantEndpoint, "crops");
    api.registerEndpoint(ENDPOINTS.HARVEST, handleHarvestEndpoint, "crops");
}

// ===== HTTP ENDPOINT HANDLERS =====

async function handlePlantEndpoint(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const plotId = parseInt(ctx.url.searchParams.get("plot_id") || "0");
        const cropCode = ctx.url.searchParams.get("crop") || "";

        console.log("[PLANT] Request:", { userId: ctx.userId, plotId, cropCode });

        if (!cropCode || plotId < 0) {
            return new Response(JSON.stringify({ error: "Missing crop or plot_id" }), { status: 400, headers });
        }

        // Get crop config
        console.log("[PLANT] Available crops:", Object.keys(CONFIGS.crops || {}));
        const cropConfig = CONFIGS.crops?.[cropCode] as CropConfig | undefined;
        if (!cropConfig) {
            console.log("[PLANT] Crop not found:", cropCode);
            return new Response(JSON.stringify({ error: "Unknown crop", available: Object.keys(CONFIGS.crops || {}) }), { status: 404, headers });
        }

        console.log("[PLANT] Crop config found:", cropConfig.name);

        // Check and deduct seeds from user_stats
        const seedKey = `seed_${cropCode}`;
        const seedCheck = await hasuraQuery(`
      query($userId: bigint!, $key: String!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) {
          value
        }
      }
    `, { userId: ctx.userId, key: seedKey }, ctx.userId);

        const currentSeeds = seedCheck?.user_stats?.[0]?.value || 0;
        if (currentSeeds < 1) {
            return new Response(JSON.stringify({ error: "No seeds" }), { status: 400, headers });
        }

        // Deduct 1 seed
        await hasuraQuery(`
      mutation($key: String!, $value: Int!) {
        insert_user_stats_one(
          object: {key: $key, value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { key: seedKey, value: currentSeeds - 1 }, ctx.userId);

        // Create game_object
        const objData = await hasuraQuery(`
      mutation($typeCode: String!, $x: Int!) {
        insert_game_objects_one(object: {
          type_code: $typeCode,
          x: $x,
          y: 0
        }) {
          id
          created_at
        }
      }
    `, { typeCode: `crop_${cropCode}`, x: plotId }, ctx.userId);

        const objectId = objData?.insert_game_objects_one?.id;
        const createdAt = objData?.insert_game_objects_one?.created_at;

        if (!objectId) {
            return new Response(JSON.stringify({ error: "Failed to create object" }), { status: 500, headers });
        }

        // Generate and insert checkpoints
        const checkpoints = generateCropCheckpoints(cropConfig);

        for (const cp of checkpoints) {
            await hasuraQuery(`
        mutation($objectId: Int!, $action: String!, $timeOffset: Int!, $deadline: Int!) {
          insert_game_checkpoints_one(object: {
            object_id: $objectId,
            action: $action,
            time_offset: $timeOffset,
            deadline: $deadline
          }) { id }
        }
      `, {
                objectId,
                action: cp.action,
                timeOffset: cp.time_offset,
                deadline: cp.deadline || (cp.time_offset + 1800),
            }, ctx.userId);
        }

        // Store yield in params
        const yieldAmount = generateYield(cropConfig);

        await hasuraQuery(`
      mutation($objectId: Int!, $key: String!, $value: String!) {
        insert_game_object_params_one(object: {object_id: $objectId, key: $key, value: $value}) { object_id }
      }
    `, { objectId, key: "yield", value: String(yieldAmount) }, ctx.userId);

        console.log(`[PLANT] User ${ctx.userId} planted ${cropCode} on plot ${plotId}, object ${objectId}`);

        return new Response(JSON.stringify({
            success: true,
            objectId,
            cropCode,
            plotId,
            checkpoints: checkpoints.length,
            yield: yieldAmount
        }), { headers });

    } catch (e) {
        console.error("[PLANT] Error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

async function handleHarvestEndpoint(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const objectId = parseInt(ctx.url.searchParams.get("id") || "0");

        if (!objectId) {
            return new Response(JSON.stringify({ error: "Missing object id" }), { status: 400, headers });
        }

        // Get object and check ownership
        const objData = await hasuraQuery(`
      query($objectId: Int!) {
        game_objects_by_pk(id: $objectId) {
          id
          type_code
          user_id
          created_at
          params { key value }
          checkpoints { action time_offset deadline done_at }
        }
      }
    `, { objectId }, ctx.userId);

        const obj = objData?.game_objects_by_pk;
        if (!obj) {
            return new Response(JSON.stringify({ error: "Object not found" }), { status: 404, headers });
        }

        if (String(obj.user_id) !== ctx.userId) {
            return new Response(JSON.stringify({ error: "Not your crop" }), { status: 403, headers });
        }

        // Check if ready to harvest
        const harvestCheckpoint = obj.checkpoints?.find((c: Checkpoint) => c.action === 'harvest');
        if (!harvestCheckpoint) {
            return new Response(JSON.stringify({ error: "No harvest checkpoint" }), { status: 400, headers });
        }

        const now = Date.now();
        const createdAtMs = new Date(obj.created_at).getTime();
        const triggerTimeMs = createdAtMs + (harvestCheckpoint.time_offset * 1000);
        const deadlineMs = createdAtMs + (harvestCheckpoint.deadline * 1000);

        if (now < triggerTimeMs) {
            return new Response(JSON.stringify({ error: "Not ready yet" }), { status: 400, headers });
        }

        if (now > deadlineMs) {
            // Withered - just delete
            await hasuraQuery(`
        mutation($objectId: Int!) {
          delete_game_objects_by_pk(id: $objectId) { id }
        }
      `, { objectId }, ctx.userId);
            return new Response(JSON.stringify({ error: "Withered", harvested: 0 }), { headers });
        }

        // Get yield
        const yieldParam = obj.params?.find((p: { key: string; value: string }) => p.key === 'yield');
        const yieldAmount = parseInt(yieldParam?.value || "2");

        // Get item code from type_code (crop_tomato -> tomato)
        const itemCode = obj.type_code.replace('crop_', '');
        const itemKey = `item_${itemCode}`;

        // Get crop config for exp and sell_silver
        const cropConfig = CONFIGS.crops?.[itemCode] as CropConfig | undefined;
        const exp = cropConfig?.exp || 5;
        const products = (cropConfig as Record<string, unknown>)?.products as Array<{ sell_silver?: number }> | undefined;
        const sellSilver = products?.[0]?.sell_silver || 10;

        // Add items to inventory
        const currentItems = await hasuraQuery(`
      query($userId: bigint!, $key: String!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) { value }
      }
    `, { userId: ctx.userId, key: itemKey }, ctx.userId);

        const currentItemCount = currentItems?.user_stats?.[0]?.value || 0;
        await hasuraQuery(`
      mutation($key: String!, $value: Int!) {
        insert_user_stats_one(
          object: {key: $key, value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { key: itemKey, value: currentItemCount + yieldAmount }, ctx.userId);

        // Add exp
        const currentExp = await hasuraQuery(`
      query($userId: bigint!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: "exp"}}) { value }
      }
    `, { userId: ctx.userId }, ctx.userId);
        const expValue = (currentExp?.user_stats?.[0]?.value || 0) + exp;
        await hasuraQuery(`
      mutation($key: String!, $value: Int!) {
        insert_user_stats_one(
          object: {key: $key, value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { key: "exp", value: expValue }, ctx.userId);

        // Delete the game object
        await hasuraQuery(`
      mutation($objectId: Int!) {
        delete_game_objects_by_pk(id: $objectId) { id }
      }
    `, { objectId }, ctx.userId);

        console.log(`[HARVEST] User ${ctx.userId} harvested ${itemCode} x${yieldAmount}`);

        return new Response(JSON.stringify({
            success: true,
            item: itemCode,
            harvested: yieldAmount,
            exp: exp
        }), { headers });

    } catch (e) {
        console.error("[HARVEST] Error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

// TYPES
interface CropConfig {
    name: string;
    stage_times: number[];
    wither_time: number;
    buy_silver: number;
    sell_silver: number;
    exp: number;
    level: number;
    yield: [number, number];
    steal_percent: number;
    pest_chance?: number;
    water_chance?: number;
}

interface Checkpoint {
    time_offset: number;
    action: string;
    deadline: number;
    done_at?: Date | null;
}

interface CropState {
    stage: number;
    isReady: boolean;
    isWithered: boolean;
    needsAction?: string;
    timeToNext?: number;
}

// STATE CALCULATION
export function getCropState(
    createdAt: Date,
    config: CropConfig,
    checkpoints: Checkpoint[]
): CropState {
    const now = Date.now();
    const elapsed = (now - createdAt.getTime()) / 1000;

    let totalTime = 0;
    for (let i = 0; i < config.stage_times.length; i++) {
        totalTime += config.stage_times[i];
        if (elapsed < totalTime) {
            return {
                stage: i + 1,
                isReady: false,
                isWithered: false,
                timeToNext: Math.ceil(totalTime - elapsed)
            };
        }
    }

    // Handle wither_time = 0 as "never withers"
    const witherTime = config.wither_time > 0 ? totalTime + config.wither_time : Infinity;

    if (config.wither_time > 0 && elapsed > witherTime) {
        return { stage: config.stage_times.length, isReady: false, isWithered: true };
    }

    const pending = checkpoints.find(c => !c.done_at && elapsed >= c.time_offset);
    if (pending && elapsed > pending.deadline) {
        return { stage: config.stage_times.length, isReady: false, isWithered: true };
    }

    if (pending) {
        return {
            stage: config.stage_times.length,
            isReady: false,
            isWithered: false,
            needsAction: pending.action,
            timeToNext: Math.ceil(pending.deadline - elapsed)
        };
    }

    return {
        stage: config.stage_times.length,
        isReady: true,
        isWithered: false,
        timeToNext: Math.ceil(witherTime - elapsed)
    };
}

// CHECKPOINT GENERATION
export function generateCropCheckpoints(config: CropConfig): Checkpoint[] {
    const checkpoints: Checkpoint[] = [];
    let currentTime = 0;

    for (let i = 0; i < config.stage_times.length; i++) {
        currentTime += config.stage_times[i];

        if (Math.random() < (config.pest_chance || 0.1)) {
            checkpoints.push({
                time_offset: currentTime,
                action: 'remove_pest',
                deadline: currentTime + 600
            });
        }

        if (Math.random() < (config.water_chance || 0.3)) {
            checkpoints.push({
                time_offset: currentTime,
                action: 'water',
                deadline: currentTime + 1800
            });
        }
    }

    // Handle wither_time = 0 as "never withers" (use very large deadline)
    const harvestDeadline = config.wither_time > 0
        ? currentTime + config.wither_time
        : currentTime + 999999999; // effectively infinite

    checkpoints.push({
        time_offset: currentTime,
        action: 'harvest',
        deadline: harvestDeadline
    });

    return checkpoints;
}

export function generateYield(config: CropConfig): number {
    const [min, max] = config.yield;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ENDPOINT HANDLERS
export async function handlePlant(
    userId: bigint,
    plotId: number,
    cropCode: string,
    db: {
        getConfig: (code: string) => Promise<CropConfig>;
        insertObject: (obj: any) => Promise<{ id: number }>;
        insertCheckpoints: (objectId: number, checkpoints: Checkpoint[]) => Promise<void>;
        insertParam: (objectId: number, key: string, value: string) => Promise<void>;
        updatePlot: (plotId: number, state: string, cropId: number) => Promise<void>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; cropId?: number; error?: string }> {
    const config = await db.getConfig(cropCode);
    if (!config) return { success: false, error: 'Unknown crop' };

    const deducted = await db.deductSilver(userId, config.buy_silver);
    if (!deducted) return { success: false, error: 'Not enough silver' };

    const crop = await db.insertObject({
        user_id: userId,
        type_code: cropCode
    });

    const checkpoints = generateCropCheckpoints(config);
    await db.insertCheckpoints(crop.id, checkpoints);

    const yieldAmount = generateYield(config);
    await db.insertParam(crop.id, 'yield', String(yieldAmount));
    await db.insertParam(crop.id, 'stolen', '0');

    await db.updatePlot(plotId, 'planted', crop.id);

    return { success: true, cropId: crop.id };
}

export async function handleHarvest(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<CropConfig>;
        getCheckpoints: (objectId: number) => Promise<Checkpoint[]>;
        getParam: (objectId: number, key: string) => Promise<string | null>;
        addSilver: (userId: bigint, amount: number) => Promise<void>;
        addExp: (userId: bigint, amount: number) => Promise<void>;
        addItem: (userId: bigint, item: string, qty: number) => Promise<void>;
        deleteObject: (id: number) => Promise<void>;
        updatePlot: (plotId: number, state: string) => Promise<void>;
    }
): Promise<{ success: boolean; items?: number; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop || crop.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(crop.type_code);
    const checkpoints = await db.getCheckpoints(cropId);
    const state = getCropState(new Date(crop.created_at), config, checkpoints);

    if (!state.isReady) return { success: false, error: 'Not ready' };
    if (state.isWithered) return { success: false, error: 'Withered' };

    const yieldStr = await db.getParam(cropId, 'yield');
    const stolenStr = await db.getParam(cropId, 'stolen');
    const totalYield = parseInt(yieldStr || '0');
    const stolen = parseInt(stolenStr || '0');
    const remaining = totalYield - stolen;

    await db.addItem(userId, crop.type_code, remaining);
    await db.addSilver(userId, remaining * config.sell_silver);
    await db.addExp(userId, config.exp);
    await db.deleteObject(cropId);

    return { success: true, items: remaining };
}

export async function handleWater(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getCheckpoints: (objectId: number) => Promise<Checkpoint[]>;
        completeCheckpoint: (objectId: number, action: string, doneBy: bigint) => Promise<boolean>;
        addExp: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };

    const completed = await db.completeCheckpoint(cropId, 'water', userId);
    if (!completed) return { success: false, error: 'No water needed' };

    if (crop.user_id !== userId) {
        await db.addExp(userId, 5); // бонус за полив соседа
    }

    return { success: true };
}

export async function handleRemovePest(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        completeCheckpoint: (objectId: number, action: string, doneBy: bigint) => Promise<boolean>;
        addExp: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };

    const completed = await db.completeCheckpoint(cropId, 'remove_pest', userId);
    if (!completed) return { success: false, error: 'No pest' };

    await db.addExp(userId, 3);

    return { success: true };
}

export async function handleSteal(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<CropConfig>;
        getCheckpoints: (objectId: number) => Promise<Checkpoint[]>;
        getParam: (objectId: number, key: string) => Promise<string | null>;
        setParam: (objectId: number, key: string, value: string) => Promise<void>;
        addItem: (userId: bigint, item: string, qty: number) => Promise<void>;
        getStealsToday: (userId: bigint, neighborId: bigint) => Promise<number>;
        recordSteal: (userId: bigint, neighborId: bigint, cropId: number, qty: number) => Promise<void>;
    }
): Promise<{ success: boolean; stolen?: number; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };
    if (crop.user_id === userId) return { success: false, error: 'Cannot steal from yourself' };

    const config = await db.getConfig(crop.type_code);
    const checkpoints = await db.getCheckpoints(cropId);
    const state = getCropState(new Date(crop.created_at), config, checkpoints);

    if (!state.isReady) return { success: false, error: 'Not ready' };
    if (state.isWithered) return { success: false, error: 'Withered' };

    // Check daily limit
    const stealsToday = await db.getStealsToday(userId, crop.user_id);
    if (stealsToday >= 3) return { success: false, error: 'Daily limit reached' };

    const yieldStr = await db.getParam(cropId, 'yield');
    const stolenStr = await db.getParam(cropId, 'stolen');
    const totalYield = parseInt(yieldStr || '0');
    const alreadyStolen = parseInt(stolenStr || '0');

    const maxStealable = Math.floor(totalYield * (config.steal_percent / 100));
    const remaining = maxStealable - alreadyStolen;

    if (remaining <= 0) return { success: false, error: 'Nothing left to steal' };

    const stolen = Math.min(remaining, 1); // Steal 1 at a time
    await db.setParam(cropId, 'stolen', String(alreadyStolen + stolen));
    await db.addItem(userId, crop.type_code, stolen);
    await db.recordSteal(userId, crop.user_id, cropId, stolen);

    return { success: true, stolen };
}

export async function handleThrowPest(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<CropConfig>;
        getCheckpoints: (objectId: number) => Promise<Checkpoint[]>;
        insertCheckpoint: (objectId: number, checkpoint: Checkpoint) => Promise<void>;
        getPestsToday: (userId: bigint, neighborId: bigint) => Promise<number>;
        recordPest: (userId: bigint, neighborId: bigint, cropId: number) => Promise<void>;
    }
): Promise<{ success: boolean; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };
    if (crop.user_id === userId) return { success: false, error: 'Cannot throw pest on yourself' };

    const config = await db.getConfig(crop.type_code);
    const checkpoints = await db.getCheckpoints(cropId);
    const state = getCropState(new Date(crop.created_at), config, checkpoints);

    if (state.isReady || state.isWithered) return { success: false, error: 'Too late' };
    if (state.needsAction === 'remove_pest') return { success: false, error: 'Already has pest' };

    // Check daily limit
    const pestsToday = await db.getPestsToday(userId, crop.user_id);
    if (pestsToday >= 2) return { success: false, error: 'Daily limit reached' };

    const elapsed = (Date.now() - new Date(crop.created_at).getTime()) / 1000;
    await db.insertCheckpoint(cropId, {
        time_offset: elapsed,
        action: 'remove_pest',
        deadline: elapsed + 600
    });
    await db.recordPest(userId, crop.user_id, cropId);

    return { success: true };
}
