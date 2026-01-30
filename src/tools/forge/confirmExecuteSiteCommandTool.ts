import { ForgeToolDefinition } from '../../core/types/protocols.js'
import { toMCPToolResult } from '../../utils/mcpToolResult.js'
import { z } from 'zod'
import {
  createConfirmationStore,
  createConfirmation,
} from '../../utils/confirmationStore.js'

// Confirmation store for site command execution
export const executeSiteCommandConfirmationStore = createConfirmationStore<{
  serverId: string
  siteId: string
  command: string
}>()

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
  command: z
    .string()
    .describe(
      'The shell command to execute on the site. This will run in the context of the site directory. WARNING: Shell commands can be destructive - use with caution.'
    ),
}

const paramsZodObject = z.object(paramsSchema)

export const confirmExecuteSiteCommandTool: ForgeToolDefinition<
  typeof paramsSchema
> = {
  name: 'confirm_execute_site_command',
  parameters: paramsSchema,
  annotations: {
    title: 'Confirm Execute Site Command',
    description: `Confirms the request to execute a shell command on a site and returns a summary for user confirmation.

This tool MUST NOT be called automatically. The client MUST display the confirmation summary and confirmation ID to the end user and require explicit, manual user input (such as typing 'yes' or clicking a confirmation button) before proceeding. Automation, pre-filling, or bypassing this user confirmation step is strictly forbidden and considered a violation of the protocol. Only after receiving explicit user confirmation should the client call the corresponding action tool with the confirmationId.

WARNING: Shell commands have full access to the site's filesystem and can be destructive. Always review commands carefully before confirming.`,
    operation: 'confirm',
    resource: 'site_command',
    safe: true,
    readOnlyHint: true,
    openWorldHint: false,
    readWriteHint: false,
    destructiveHint: false,
  },
  handler: async params => {
    const parsed = paramsZodObject.parse(params)
    const { serverId, siteId, command } = parsed

    // Create confirmation entry
    const confirmation = createConfirmation(
      executeSiteCommandConfirmationStore,
      { serverId, siteId, command }
    )

    return toMCPToolResult({
      confirmationId: confirmation.confirmationId,
      summary: {
        action: 'Execute Site Command',
        serverId,
        siteId,
        command,
        warning:
          'This will execute a shell command on the server. Shell commands have full access to the site filesystem and can be destructive. Please review the command carefully.',
      },
      instructions:
        'Please confirm you want to execute this command by calling execute_site_command with this confirmationId.',
    })
  },
}
