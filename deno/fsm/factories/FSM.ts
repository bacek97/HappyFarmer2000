// FactoryFSM - Конечный автомат для фабрик
// =========================================

// ENDPOINTS
export const ENDPOINTS = {
    START: '/start',           // ?id=1&recipe=bread
    COLLECT: '/collect_factory' // ?id=1
} as const;

// TYPES
interface Recipe {
    name: string;
    inputs: Array<{ item: string; count: number }>;
    output: string;
    output_count: number;
    time: number;
}

interface FactoryConfig {
    name: string;
    buy_silver: number;
    build_time: number;
    slots: number;
    recipes: Recipe[];
}

type FactoryState = 'building' | 'idle' | 'processing' | 'ready';

interface FactoryStatus {
    state: FactoryState;
    currentRecipe?: string;
    timeToReady?: number;
    canCollect: boolean;
    canStart: boolean;
}

// STATE CALCULATION
export function getFactoryState(
    createdAt: Date,
    stateChangedAt: Date,
    currentState: string,
    currentRecipe: string | null,
    config: FactoryConfig,
    recipeTime: number
): FactoryStatus {
    const now = Date.now();

    if (currentState === 'building') {
        const elapsed = (now - createdAt.getTime()) / 1000;
        if (elapsed < config.build_time) {
            return { state: 'building', timeToReady: Math.ceil(config.build_time - elapsed), canCollect: false, canStart: false };
        }
        return { state: 'idle', canCollect: false, canStart: true };
    }

    if (currentState === 'idle') {
        return { state: 'idle', canCollect: false, canStart: true };
    }

    if (currentState === 'processing' && currentRecipe) {
        const elapsed = (now - stateChangedAt.getTime()) / 1000;
        if (elapsed >= recipeTime) {
            return { state: 'ready', currentRecipe, canCollect: true, canStart: false };
        }
        return { state: 'processing', currentRecipe, timeToReady: Math.ceil(recipeTime - elapsed), canCollect: false, canStart: false };
    }

    if (currentState === 'ready') {
        return { state: 'ready', currentRecipe: currentRecipe || undefined, canCollect: true, canStart: false };
    }

    return { state: 'idle', canCollect: false, canStart: true };
}

// ENDPOINT HANDLERS
export async function handleStart(
    userId: bigint,
    factoryId: number,
    recipeName: string,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<FactoryConfig>;
        getParam: (objectId: number, key: string) => Promise<string | null>;
        setParam: (objectId: number, key: string, value: string) => Promise<void>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        hasItem: (userId: bigint, item: string, qty: number) => Promise<boolean>;
        removeItem: (userId: bigint, item: string, qty: number) => Promise<void>;
    }
): Promise<{ success: boolean; timeToReady?: number; error?: string }> {
    const factory = await db.getObject(factoryId);
    if (!factory || factory.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(factory.type_code);
    const recipe = config.recipes.find(r => r.name === recipeName);
    if (!recipe) return { success: false, error: 'Unknown recipe' };

    const currentRecipe = await db.getParam(factoryId, 'current_recipe');
    const stateChangedAt = factory.state_changed_at ? new Date(factory.state_changed_at) : new Date(factory.created_at);
    const status = getFactoryState(new Date(factory.created_at), stateChangedAt, factory.state || 'idle', currentRecipe, config, recipe.time);

    if (!status.canStart) return { success: false, error: 'Factory busy' };

    // Check inputs
    for (const input of recipe.inputs) {
        const has = await db.hasItem(userId, input.item, input.count);
        if (!has) return { success: false, error: `Not enough ${input.item}` };
    }

    // Consume inputs
    for (const input of recipe.inputs) {
        await db.removeItem(userId, input.item, input.count);
    }

    await db.setParam(factoryId, 'current_recipe', recipeName);
    await db.setParam(factoryId, 'recipe_time', String(recipe.time));
    await db.updateObjectState(factoryId, 'processing');

    return { success: true, timeToReady: recipe.time };
}

export async function handleCollectFactory(
    userId: bigint,
    factoryId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<FactoryConfig>;
        getParam: (objectId: number, key: string) => Promise<string | null>;
        deleteParam: (objectId: number, key: string) => Promise<void>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        addItem: (userId: bigint, item: string, qty: number) => Promise<void>;
        addExp: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; output?: string; qty?: number; error?: string }> {
    const factory = await db.getObject(factoryId);
    if (!factory || factory.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(factory.type_code);
    const currentRecipeName = await db.getParam(factoryId, 'current_recipe');
    const recipeTimeStr = await db.getParam(factoryId, 'recipe_time');

    if (!currentRecipeName) return { success: false, error: 'No recipe' };

    const recipe = config.recipes.find(r => r.name === currentRecipeName);
    if (!recipe) return { success: false, error: 'Unknown recipe' };

    const stateChangedAt = factory.state_changed_at ? new Date(factory.state_changed_at) : new Date(factory.created_at);
    const status = getFactoryState(new Date(factory.created_at), stateChangedAt, factory.state || 'idle', currentRecipeName, config, parseInt(recipeTimeStr || '0'));

    if (!status.canCollect) return { success: false, error: 'Not ready' };

    await db.addItem(userId, recipe.output, recipe.output_count);
    await db.addExp(userId, 10);
    await db.deleteParam(factoryId, 'current_recipe');
    await db.deleteParam(factoryId, 'recipe_time');
    await db.updateObjectState(factoryId, 'idle');

    return { success: true, output: recipe.output, qty: recipe.output_count };
}
