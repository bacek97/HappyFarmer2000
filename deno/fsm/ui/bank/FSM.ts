// BankFSM - Банковские операции
// ==============================

// ENDPOINTS
export const ENDPOINTS = {
    LOAN: '/bank/loan',         // ?amount=1000
    REPAY: '/bank/repay',       // 
    DEPOSIT: '/bank/deposit',   // ?amount=500
    WITHDRAW: '/bank/withdraw'  //
} as const;

// RATES
export const RATES = {
    LOAN_RATE: 0.05,            // 5% в день
    DEPOSIT_RATE: 0.02,         // 2% в день
    MAX_LOAN: 10000,
    MIN_DEPOSIT: 100
} as const;

// CALCULATIONS
export function calculateLoanDebt(amount: number, takenAt: Date): number {
    const days = (Date.now() - takenAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.floor(amount * Math.pow(1 + RATES.LOAN_RATE, days));
}

export function calculateDepositValue(amount: number, depositAt: Date): number {
    const days = (Date.now() - depositAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.floor(amount * Math.pow(1 + RATES.DEPOSIT_RATE, days));
}

// ENDPOINT HANDLERS
export async function handleLoan(
    userId: bigint,
    amount: number,
    db: {
        getStat: (userId: bigint, key: string) => Promise<number>;
        setStat: (userId: bigint, key: string, value: number) => Promise<void>;
        addSilver: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; debt?: number; error?: string }> {
    if (amount <= 0 || amount > RATES.MAX_LOAN) {
        return { success: false, error: `Amount must be 1-${RATES.MAX_LOAN}` };
    }

    const existingLoan = await db.getStat(userId, 'loan_amount');
    if (existingLoan > 0) {
        return { success: false, error: 'Already have a loan' };
    }

    await db.setStat(userId, 'loan_amount', amount);
    await db.setStat(userId, 'loan_taken_at', Date.now());
    await db.addSilver(userId, amount);

    return { success: true, debt: amount };
}

export async function handleRepay(
    userId: bigint,
    db: {
        getStat: (userId: bigint, key: string) => Promise<number>;
        setStat: (userId: bigint, key: string, value: number) => Promise<void>;
        getSilver: (userId: bigint) => Promise<number>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; paid?: number; error?: string }> {
    const loanAmount = await db.getStat(userId, 'loan_amount');
    if (loanAmount <= 0) {
        return { success: false, error: 'No loan' };
    }

    const loanTakenAt = await db.getStat(userId, 'loan_taken_at');
    const debt = calculateLoanDebt(loanAmount, new Date(loanTakenAt));

    const silver = await db.getSilver(userId);
    if (silver < debt) {
        return { success: false, error: `Need ${debt} silver, have ${silver}` };
    }

    await db.deductSilver(userId, debt);
    await db.setStat(userId, 'loan_amount', 0);
    await db.setStat(userId, 'loan_taken_at', 0);

    return { success: true, paid: debt };
}

export async function handleDeposit(
    userId: bigint,
    amount: number,
    db: {
        getStat: (userId: bigint, key: string) => Promise<number>;
        setStat: (userId: bigint, key: string, value: number) => Promise<void>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; total?: number; error?: string }> {
    if (amount < RATES.MIN_DEPOSIT) {
        return { success: false, error: `Minimum deposit is ${RATES.MIN_DEPOSIT}` };
    }

    const paid = await db.deductSilver(userId, amount);
    if (!paid) {
        return { success: false, error: 'Not enough silver' };
    }

    const existingDeposit = await db.getStat(userId, 'deposit_amount');
    const existingAt = await db.getStat(userId, 'deposit_at');

    let newAmount = amount;
    if (existingDeposit > 0 && existingAt > 0) {
        // Calculate current value and add new deposit
        const currentValue = calculateDepositValue(existingDeposit, new Date(existingAt));
        newAmount = currentValue + amount;
    }

    await db.setStat(userId, 'deposit_amount', newAmount);
    await db.setStat(userId, 'deposit_at', Date.now());

    return { success: true, total: newAmount };
}

export async function handleWithdraw(
    userId: bigint,
    db: {
        getStat: (userId: bigint, key: string) => Promise<number>;
        setStat: (userId: bigint, key: string, value: number) => Promise<void>;
        addSilver: (userId: bigint, amount: number) => Promise<void>;
    }
): Promise<{ success: boolean; received?: number; error?: string }> {
    const depositAmount = await db.getStat(userId, 'deposit_amount');
    if (depositAmount <= 0) {
        return { success: false, error: 'No deposit' };
    }

    const depositAt = await db.getStat(userId, 'deposit_at');
    const value = calculateDepositValue(depositAmount, new Date(depositAt));

    await db.addSilver(userId, value);
    await db.setStat(userId, 'deposit_amount', 0);
    await db.setStat(userId, 'deposit_at', 0);

    return { success: true, received: value };
}
