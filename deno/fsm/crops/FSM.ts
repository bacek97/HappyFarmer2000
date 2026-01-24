// CropFSM - Конечный автомат для культур
// ========================================

// ENDPOINTS
export const ENDPOINTS = {
    PLANT: '/plant',           // ?plot_id=1&crop=tomato&x=1&y=2
    HARVEST: '/harvest',       // ?id=1
    WATER: '/water',           // ?id=1
    REMOVE_PEST: '/remove_pest', // ?id=1
    STEAL: '/steal',           // ?id=1
    THROW_PEST: '/throw_pest'  // ?id=1
} as const;

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
