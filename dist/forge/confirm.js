import { randomUUID } from 'crypto';
const pending = new Map();
const TTL_MS = 15 * 60 * 1000;
function sweep() {
    const now = Date.now();
    for (const [token, p] of pending)
        if (p.expires < now)
            pending.delete(token);
}
export function issueToken(operationKey) {
    sweep();
    const token = randomUUID().slice(0, 8);
    pending.set(token, { key: operationKey, expires: Date.now() + TTL_MS });
    return token;
}
/** True (and consumes the token) only if it was issued for this exact operation. */
export function redeemToken(token, operationKey) {
    sweep();
    if (!token)
        return false;
    const p = pending.get(token);
    if (!p || p.key !== operationKey)
        return false;
    pending.delete(token);
    return true;
}
