// SocialFSM - Социальные действия между игроками
// ===============================================

// ENDPOINTS
export const ENDPOINTS = {
    ADD_FRIEND: '/add_friend',     // ?id=123
    REMOVE_FRIEND: '/remove_friend' // ?id=123
} as const;

// LIMITS
export const LIMITS = {
    MAX_STEALS_PER_NEIGHBOR: 3,
    MAX_PESTS_PER_NEIGHBOR: 2,
    MAX_WATERS_PER_NEIGHBOR: 5,
    STEAL_COOLDOWN: 300,           // секунд между кражами у одного
    WATER_EXP_BONUS: 5,
    PEST_EXP_BONUS: 3
} as const;

// ENDPOINT HANDLERS
export async function handleSteal(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getConfig: (code: string) => Promise<{ steal_percent: number }>;
        getParam: (objectId: number, key: string) => Promise<string | null>;
        setParam: (objectId: number, key: string, value: string) => Promise<void>;
        addItem: (userId: bigint, item: string, qty: number) => Promise<void>;
        logAction: (userId: bigint, action: string, objectId: number, targetUserId: bigint) => Promise<void>;
        countTodayActions: (userId: bigint, action: string, targetUserId: bigint) => Promise<number>;
        isFriend: (userId: bigint, friendId: bigint) => Promise<boolean>;
    }
): Promise<{ success: boolean; stolen?: number; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };
    if (crop.user_id === userId) return { success: false, error: 'Cannot steal own crop' };

    // Check friend
    const isFriend = await db.isFriend(userId, crop.user_id);
    if (!isFriend) return { success: false, error: 'Not a friend' };

    // Check daily limit
    const todayCount = await db.countTodayActions(userId, 'steal', crop.user_id);
    if (todayCount >= LIMITS.MAX_STEALS_PER_NEIGHBOR) {
        return { success: false, error: 'Daily limit reached' };
    }

    // Get yield and stolen
    const yieldStr = await db.getParam(cropId, 'yield');
    const stolenStr = await db.getParam(cropId, 'stolen');
    const totalYield = parseInt(yieldStr || '0');
    const alreadyStolen = parseInt(stolenStr || '0');

    const config = await db.getConfig(crop.type_code);
    const maxStealable = Math.floor(totalYield * config.steal_percent / 100);
    const canSteal = maxStealable - alreadyStolen;

    if (canSteal <= 0) return { success: false, error: 'Nothing to steal' };

    const stealing = 1; // steal 1 at a time
    await db.setParam(cropId, 'stolen', String(alreadyStolen + stealing));
    await db.addItem(userId, crop.type_code, stealing);
    await db.logAction(userId, 'steal', cropId, crop.user_id);

    return { success: true, stolen: stealing };
}

export async function handleThrowPest(
    userId: bigint,
    cropId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        getCheckpoints: (objectId: number) => Promise<Array<{ action: string; done_at: Date | null }>>;
        insertCheckpoint: (objectId: number, checkpoint: any) => Promise<void>;
        logAction: (userId: bigint, action: string, objectId: number, targetUserId: bigint) => Promise<void>;
        countTodayActions: (userId: bigint, action: string, targetUserId: bigint) => Promise<number>;
        isFriend: (userId: bigint, friendId: bigint) => Promise<boolean>;
    }
): Promise<{ success: boolean; error?: string }> {
    const crop = await db.getObject(cropId);
    if (!crop) return { success: false, error: 'Not found' };
    if (crop.user_id === userId) return { success: false, error: 'Cannot throw pest on own crop' };

    const isFriend = await db.isFriend(userId, crop.user_id);
    if (!isFriend) return { success: false, error: 'Not a friend' };

    const todayCount = await db.countTodayActions(userId, 'throw_pest', crop.user_id);
    if (todayCount >= LIMITS.MAX_PESTS_PER_NEIGHBOR) {
        return { success: false, error: 'Daily limit reached' };
    }

    // Check if already has pest
    const checkpoints = await db.getCheckpoints(cropId);
    const hasPest = checkpoints.some(c => c.action === 'remove_pest' && !c.done_at);
    if (hasPest) return { success: false, error: 'Already has pest' };

    const elapsed = (Date.now() - new Date(crop.created_at).getTime()) / 1000;
    await db.insertCheckpoint(cropId, {
        time_offset: Math.floor(elapsed),
        action: 'remove_pest',
        deadline: Math.floor(elapsed) + 600
    });

    await db.logAction(userId, 'throw_pest', cropId, crop.user_id);

    return { success: true };
}

export async function handleAddFriend(
    userId: bigint,
    friendId: bigint,
    db: {
        userExists: (id: bigint) => Promise<boolean>;
        isFriend: (userId: bigint, friendId: bigint) => Promise<boolean>;
        addFriend: (userId: bigint, friendId: bigint) => Promise<void>;
    }
): Promise<{ success: boolean; error?: string }> {
    if (userId === friendId) return { success: false, error: 'Cannot add yourself' };

    const exists = await db.userExists(friendId);
    if (!exists) return { success: false, error: 'User not found' };

    const already = await db.isFriend(userId, friendId);
    if (already) return { success: false, error: 'Already friends' };

    await db.addFriend(userId, friendId);

    return { success: true };
}

export async function handleRemoveFriend(
    userId: bigint,
    friendId: bigint,
    db: {
        removeFriend: (userId: bigint, friendId: bigint) => Promise<void>;
    }
): Promise<{ success: boolean }> {
    await db.removeFriend(userId, friendId);
    return { success: true };
}
