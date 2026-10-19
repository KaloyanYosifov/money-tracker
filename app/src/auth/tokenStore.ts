// Metro and Jest pick tokenStore.native.ts or tokenStore.web.ts. This file
// gives TypeScript the contract that both platform files implement.

/** Returns the stored refresh token. The web always returns null (cookie). */
export declare function getRefreshToken(): Promise<string | null>;
export declare function setRefreshToken(token: string | null): Promise<void>;
export declare function getLastUserId(): Promise<string | null>;
export declare function setLastUserId(userId: string | null): Promise<void>;
