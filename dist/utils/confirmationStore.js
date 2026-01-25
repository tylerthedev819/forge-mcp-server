import { randomUUID } from 'crypto';
export function createConfirmationStore() {
    return new Map();
}
export function createConfirmation(store, params) {
    const confirmationId = randomUUID();
    const entry = {
        confirmationId,
        used: false,
        createdAt: Date.now(),
        params,
    };
    store.set(confirmationId, entry);
    return entry;
}
export function validateConfirmation(store, confirmationId, paramsCheck, expiryMs = 10 * 60 * 1000) {
    const entry = store.get(confirmationId);
    if (!entry || entry.used)
        return null;
    if (Date.now() - entry.createdAt > expiryMs) {
        store.delete(confirmationId);
        return null;
    }
    if (paramsCheck && !paramsCheck(entry.params))
        return null;
    return entry;
}
export function markConfirmationUsed(store, confirmationId) {
    const entry = store.get(confirmationId);
    if (entry) {
        entry.used = true;
        store.set(confirmationId, entry);
    }
}
