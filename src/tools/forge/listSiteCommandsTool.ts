import { ForgeToolDefinition, HttpMethod } from '../../core/types/protocols.js'
import { callForgeApi } from '../../utils/forgeApi.js'
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js'
import { z } from 'zod'

const paramsSchema = {
  serverId: z
    .string()
    .describe(
      'The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'
    ),
  siteId: z
    .string()
    .describe(
      'The ID of the site. The client MUST validate this value against the available sites from listSitesTool before passing it.'
    ),
}

const paramsZodObject = z.object(paramsSchema)

export const listSiteCommandsTool: ForgeToolDefinition<typeof paramsSchema> = {
  name: 'list_site_commands',
  parameters: paramsSchema,
  annotations: {
    title: 'List Site Commands',
    description: `Lists the command history for a specific site.

This returns all commands that have been executed on the site, including:
- Command ID
- The command that was run
- Status (installing, finished, failed)
- Timestamps
- Who executed the command

Use get_site_command with a specific command ID to retrieve the full output.`,
    operation: 'list',
    resource: 'site_command',
    safe: true,
    readOnlyHint: true,
    openWorldHint: false,
    readWriteHint: false,
    destructiveHint: false,
  },
  handler: async (params, forgeApiKey) => {
    try {
      const parsed = paramsZodObject.parse(params)
      const { serverId, siteId } = parsed

      const data = await callForgeApi<object>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}/commands`,
          method: HttpMethod.GET,
        },
        forgeApiKey
      )

      return toMCPToolResult(data)
    } catch (err) {
      return toMCPToolError(err)
    }
  },
}
