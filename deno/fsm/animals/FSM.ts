// AnimalFSM - Конечный автомат для животных
// ==========================================

// ENDPOINTS
export const ENDPOINTS = {
    FEED: '/feed',             // ?id=1
    COLLECT: '/collect',       // ?id=1
    CURE: '/cure'              // ?id=1
} as const;

// TYPES
interface AnimalConfig {
    name: string;
    buy_silver: number;
    feed_interval: number;
    produce_time: number;
    product: string;
    product_count: number;
    sick_time: number;
    cure_price: number;
    exp: number;
}

type AnimalState = 'hungry' | 'fed' | 'producing' | 'ready' | 'sick';

interface AnimalStatus {
    state: AnimalState;
    timeToNext: number;
    canCollect: boolean;
    needsFeeding: boolean;
    needsCure: boolean;
}

// STATE CALCULATION
export function getAnimalState(
    stateChangedAt: Date,
    currentState: string,
    config: AnimalConfig
): AnimalStatus {
    const elapsed = (Date.now() - stateChangedAt.getTime()) / 1000;

    switch (currentState) {
        case 'hungry':
            if (elapsed >= config.sick_time) {
                return { state: 'sick', timeToNext: 0, canCollect: false, needsFeeding: false, needsCure: true };
            }
            return { state: 'hungry', timeToNext: Math.ceil(config.sick_time - elapsed), canCollect: false, needsFeeding: true, needsCure: false };

        case 'fed':
            if (elapsed >= config.produce_time) {
                return { state: 'ready', timeToNext: 0, canCollect: true, needsFeeding: false, needsCure: false };
            }
            return { state: 'producing', timeToNext: Math.ceil(config.produce_time - elapsed), canCollect: false, needsFeeding: false, needsCure: false };

        case 'ready':
            return { state: 'ready', timeToNext: 0, canCollect: true, needsFeeding: false, needsCure: false };

        case 'sick':
            return { state: 'sick', timeToNext: 0, canCollect: false, needsFeeding: false, needsCure: true };

        default:
            return { state: 'hungry', timeToNext: config.sick_time, canCollect: false, needsFeeding: true, needsCure: false };
    }
}

// ENDPOINT HANDLERS
export async function handleFeed(
    userId: bigint,
    animalId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<AnimalConfig>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        hasItem: (userId: bigint, item: string, qty: number) => Promise<boolean>;
        removeItem: (userId: bigint, item: string, qty: number) => Promise<void>;
    }
): Promise<{ success: boolean; error?: string }> {
    const animal = await db.getObject(animalId);
    if (!animal || animal.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(animal.type_code);
    const status = getAnimalState(new Date(animal.state_changed_at || animal.created_at), animal.state || 'hungry', config);

    if (!status.needsFeeding) return { success: false, error: 'Not hungry' };

    const hasFeed = await db.hasItem(userId, 'feed', 1);
    if (!hasFeed) return { success: false, error: 'No feed' };

    await db.removeItem(userId, 'feed', 1);
    await db.updateObjectState(animalId, 'fed');

    return { success: true };
}

export async function handleCollect(
    userId: bigint,
    animalId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<AnimalConfig>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        addItem: (userId: bigint, item: string, qty: number) => Promise<void>;
        addExp: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; product?: string; qty?: number; error?: string }> {
    const animal = await db.getObject(animalId);
    if (!animal || animal.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(animal.type_code);
    const status = getAnimalState(new Date(animal.state_changed_at || animal.created_at), animal.state || 'hungry', config);

    if (!status.canCollect) return { success: false, error: 'Not ready' };

    await db.addItem(userId, config.product, config.product_count);
    await db.addExp(userId, config.exp);
    await db.updateObjectState(animalId, 'hungry');

    return { success: true, product: config.product, qty: config.product_count };
}

export async function handleCure(
    userId: bigint,
    animalId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<AnimalConfig>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; error?: string }> {
    const animal = await db.getObject(animalId);
    if (!animal || animal.user_id !== userId) return { success: false, error: 'Not found' };

    const config = await db.getConfig(animal.type_code);
    const status = getAnimalState(new Date(animal.state_changed_at || animal.created_at), animal.state || 'hungry', config);

    if (!status.needsCure) return { success: false, error: 'Not sick' };

    const paid = await db.deductSilver(userId, config.cure_price);
    if (!paid) return { success: false, error: 'Not enough silver' };

    await db.updateObjectState(animalId, 'hungry');

    return { success: true };
}
