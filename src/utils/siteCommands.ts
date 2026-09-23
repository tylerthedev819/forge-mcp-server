import { HttpMethod } from '../core/types/protocols.js'
import { callForgeApi } from './forgeApi.js'

/**
 * A site command, normalized across Forge API versions.
 *
 * Forge API v2 returns JSON:API resources ({ data: { id, type, attributes } })
 * and serves a command's stdout from a separate `/output` endpoint. v1 returned
 * { command: {...}, output } in one body. Tools read commands through these
 * helpers so they don't depend on either envelope.
 */
export interface SiteCommand {
  id: string
  command?: string
  status?: string
  exit_code?: number | null
  error_output?: string | null
  duration?: string | null
  created_at?: string
  updated_at?: string
}

interface JsonApiResource {
  id: string | number
  attributes?: Record<string, unknown>
}

function toSiteCommand(resource: JsonApiResource): SiteCommand {
  return { ...(resource.attributes ?? {}), id: String(resource.id) }
}

/** Parse a single command from a v2 (`data`) or v1 (`command`) response body. */
export function parseSiteCommand(body: unknown): SiteCommand | null {
  const b = body as {
    data?: JsonApiResource
    command?: Record<string, unknown> & { id?: string | number }
  } | null
  if (b?.data?.id !== undefined) return toSiteCommand(b.data)
  if (b?.command?.id !== undefined) {
    return { ...b.command, id: String(b.command.id) } as SiteCommand
  }
  return null
}

const commandsPath = (serverId: string, siteId: string) =>
  `/servers/${serverId}/sites/${siteId}/commands`

export async function createSiteCommand(
  serverId: string,
  siteId: string,
  command: string,
  forgeApiKey: string
): Promise<unknown> {
  return callForgeApi<unknown>(
    {
      endpoint: commandsPath(serverId, siteId),
      method: HttpMethod.POST,
      data: { command },
    },
    forgeApiKey
  )
}

export async function getSiteCommand(
  serverId: string,
  siteId: string,
  commandId: string,
  forgeApiKey: string
): Promise<SiteCommand | null> {
  const body = await callForgeApi<unknown>(
    {
      endpoint: `${commandsPath(serverId, siteId)}/${commandId}`,
      method: HttpMethod.GET,
    },
    forgeApiKey
  )
  return parseSiteCommand(body)
}

/**
 * Fetch a command's stdout. v2 serves it at `/commands/{id}/output` as
 * `data.attributes.output`; v1 put `output` next to `command` in the GET body.
 * Returns null when no output string is present.
 */
export async function getSiteCommandOutput(
  serverId: string,
  siteId: string,
  commandId: string,
  forgeApiKey: string
): Promise<string | null> {
  const body = await callForgeApi<unknown>(
    {
      endpoint: `${commandsPath(serverId, siteId)}/${commandId}/output`,
      method: HttpMethod.GET,
    },
    forgeApiKey
  )
  const b = body as {
    data?: { attributes?: { output?: unknown } }
    output?: unknown
  } | null
  const output = b?.data?.attributes?.output ?? b?.output
  return typeof output === 'string' ? output : null
}

/** List a site's commands newest-first, one page of at most `limit`. */
export async function listSiteCommands(
  serverId: string,
  siteId: string,
  forgeApiKey: string,
  limit: number,
  cursor?: string
): Promise<{ commands: SiteCommand[]; nextCursor: string | null }> {
  const query = new URLSearchParams({
    sort: '-created_at',
    'page[size]': String(limit),
  })
  if (cursor) query.set('page[cursor]', cursor)

  const body = await callForgeApi<{
    data?: JsonApiResource[]
    commands?: Array<Record<string, unknown> & { id: string | number }>
    meta?: { next_cursor?: string | null }
  }>(
    {
      endpoint: `${commandsPath(serverId, siteId)}?${query.toString()}`,
      method: HttpMethod.GET,
    },
    forgeApiKey
  )

  if (Array.isArray(body?.data)) {
    return {
      commands: body.data.map(toSiteCommand),
      nextCursor: body.meta?.next_cursor ?? null,
    }
  }

  // v1 fallback: no server-side sort/paging, so apply both here.
  const legacy = (body?.commands ?? [])
    .map(c => ({ ...c, id: String(c.id) }) as SiteCommand)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  return { commands: legacy.slice(0, limit), nextCursor: null }
}
