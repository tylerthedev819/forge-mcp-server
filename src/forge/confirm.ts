import { randomUUID } from 'crypto'

/**
 * Two-step confirmation: the first call returns a preview and a token bound to
 * the exact operation; the second call must present that token. This makes the
 * model state what it is about to do before doing it. The human gate is the
 * client's permission prompt on the tool itself (see README).
 */
interface Pending {
  key: string
  expires: number
}

const pending = new Map<string, Pending>()
const TTL_MS = 15 * 60 * 1000

function sweep(): void {
  const now = Date.now()
  for (const [token, p] of pending) if (p.expires < now) pending.delete(token)
}

export function issueToken(operationKey: string): string {
  sweep()
  const token = randomUUID().slice(0, 8)
  pending.set(token, { key: operationKey, expires: Date.now() + TTL_MS })
  return token
}

/** True (and consumes the token) only if it was issued for this exact operation. */
export function redeemToken(token: string | undefined, operationKey: string): boolean {
  sweep()
  if (!token) return false
  const p = pending.get(token)
  if (!p || p.key !== operationKey) return false
  pending.delete(token)
  return true
}
