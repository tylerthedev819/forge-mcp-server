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
  commandId: z
    .string()
    .describe(
      'The ID of the command to retrieve. This is returned when executing a command via execute_site_command.'
    ),
}

const paramsZodObject = z.object(paramsSchema)

export const getSiteCommandTool: ForgeToolDefinition<typeof paramsSchema> = {
  name: 'get_site_command',
  parameters: paramsSchema,
  annotations: {
    title: 'Get Site Command',
    description: `Retrieves the details and output of a specific site command.

This is useful for:
- Checking the status of a command that was started with waitForCompletion=false
- Retrieving the output of a previously executed command
- Debugging failed commands

The response includes the command status ('installing', 'finished', 'failed') and the output.`,
    operation: 'get',
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
      const { serverId, siteId, commandId } = parsed

      const data = await callForgeApi<object>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}/commands/${commandId}`,
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
