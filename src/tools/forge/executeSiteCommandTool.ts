import { ForgeToolDefinition, HttpMethod } from '../../core/types/protocols.js'
import { callForgeApi } from '../../utils/forgeApi.js'
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js'
import { z } from 'zod'
import { executeSiteCommandConfirmationStore } from './confirmExecuteSiteCommandTool.js'
import {
  validateConfirmation,
  markConfirmationUsed,
} from '../../utils/confirmationStore.js'

// Response types for the Forge API
interface SiteCommand {
  id: number
  server_id: number
  site_id: number
  user_id: number
  event_id: number
  command: string
  status: string
  created_at: string
  updated_at: string
  profile_photo_url?: string
  user_name?: string
}

interface ExecuteCommandResponse {
  command: SiteCommand
}

interface GetCommandResponse {
  command: SiteCommand
  output: string
}

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
      'The shell command to execute on the site. This will run in the context of the site directory.'
    ),
  waitForCompletion: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to wait for the command to complete before returning. If true (default), the tool will poll until the command finishes and return the output. If false, returns immediately with the command ID.'
    ),
  confirmationId: z
    .string()
    .describe(
      'This confirmationId must be obtained from confirm_execute_site_command tool after explicit user confirmation. If an invalid or mismatched confirmationId is provided, the operation will be rejected.'
    ),
}

const paramsZodObject = z.object(paramsSchema)

/**
 * Helper function to wait for a command to complete.
 * Polls the command status until it's "finished" or timeout is reached.
 */
async function waitForCommandCompletion(
  serverId: string,
  siteId: string,
  commandId: number,
  forgeApiKey: string,
  maxAttempts = 30,
  delayMs = 2000
): Promise<GetCommandResponse | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await callForgeApi<GetCommandResponse>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}/commands/${commandId}`,
          method: HttpMethod.GET,
        },
        forgeApiKey
      )

      if (response.command?.status === 'finished') {
        return response
      }

      // Check for error status
      if (
        response.command?.status === 'failed' ||
        response.command?.status === 'error'
      ) {
        return response
      }
    } catch (e) {
      // Ignore errors during polling, continue trying
    }

    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  return null
}

export const executeSiteCommandTool: ForgeToolDefinition<typeof paramsSchema> =
  {
    name: 'execute_site_command',
    parameters: paramsSchema,
    annotations: {
      title: 'Execute Site Command',
      description: `Executes a shell command on a site in Laravel Forge.

The command runs in the context of the site's directory on the server. This is useful for:
- Clearing files (e.g., rm -rf /home/forge/{domain}/public/*)
- Running artisan commands
- Checking file contents
- Any other shell operations

Before calling this tool, the client MUST call the 'confirm_execute_site_command' tool and present the returned summary to the user for explicit confirmation. Only if the user confirms, the client should proceed to call this tool.

WARNING: Shell commands have full access to the site's filesystem and can be destructive. Always review commands carefully.`,
      operation: 'create',
      resource: 'site_command',
      safe: false,
      readOnlyHint: false,
      openWorldHint: true,
      readWriteHint: true,
      destructiveHint: true,
    },
    handler: async (params, forgeApiKey) => {
      try {
        const parsed = paramsZodObject.parse(params)
        const { confirmationId, serverId, siteId, command, waitForCompletion } =
          parsed

        // Validate confirmation using generic utility
        const confirmation = validateConfirmation(
          executeSiteCommandConfirmationStore,
          confirmationId,
          (stored: { serverId: string; siteId: string; command: string }) => {
            return (
              stored.serverId === serverId &&
              stored.siteId === siteId &&
              stored.command === command
            )
          }
        )

        if (!confirmation) {
          return toMCPToolError(
            new Error(
              'Invalid or expired confirmation ID. Please call confirm_execute_site_command first and get user approval.'
            )
          )
        }

        markConfirmationUsed(executeSiteCommandConfirmationStore, confirmationId)

        // Execute the command
        const executeResponse = await callForgeApi<ExecuteCommandResponse>(
          {
            endpoint: `/servers/${serverId}/sites/${siteId}/commands`,
            method: HttpMethod.POST,
            data: { command },
          },
          forgeApiKey
        )

        const commandId = executeResponse.command?.id

        if (!commandId) {
          return toMCPToolError(
            new Error('Failed to execute command: No command ID returned')
          )
        }

        // If not waiting for completion, return immediately
        if (!waitForCompletion) {
          return toMCPToolResult({
            success: true,
            message: 'Command execution started',
            commandId,
            status: executeResponse.command.status,
            note: 'Use get_site_command to check status and retrieve output',
          })
        }

        // Wait for command to complete
        const completedCommand = await waitForCommandCompletion(
          serverId,
          siteId,
          commandId,
          forgeApiKey
        )

        if (!completedCommand) {
          return toMCPToolResult({
            success: false,
            message:
              'Command execution timed out. The command may still be running.',
            commandId,
            note: 'Use get_site_command to check status and retrieve output',
          })
        }

        return toMCPToolResult({
          success: completedCommand.command.status === 'finished',
          message: `Command execution ${completedCommand.command.status}`,
          commandId,
          status: completedCommand.command.status,
          output: completedCommand.output,
        })
      } catch (err) {
        return toMCPToolError(err)
      }
    },
  }

/**
 * Internal helper function for executing commands without the confirmation flow.
 * This is useful for other tools (like installWordPressTool) that already have
 * their own confirmation mechanisms.
 *
 * @param serverId - The server ID
 * @param siteId - The site ID
 * @param command - The shell command to execute
 * @param forgeApiKey - The Forge API key
 * @param waitForCompletion - Whether to wait for the command to complete
 * @returns The command result with output (if waited) or just the command ID
 */
export async function executeCommandInternal(
  serverId: string,
  siteId: string,
  command: string,
  forgeApiKey: string,
  waitForCompletion = true
): Promise<{
  success: boolean
  commandId?: number
  status?: string
  output?: string
  error?: string
}> {
  try {
    // Execute the command
    const executeResponse = await callForgeApi<ExecuteCommandResponse>(
      {
        endpoint: `/servers/${serverId}/sites/${siteId}/commands`,
        method: HttpMethod.POST,
        data: { command },
      },
      forgeApiKey
    )

    const commandId = executeResponse.command?.id

    if (!commandId) {
      return {
        success: false,
        error: 'No command ID returned from Forge API',
      }
    }

    if (!waitForCompletion) {
      return {
        success: true,
        commandId,
        status: executeResponse.command.status,
      }
    }

    // Wait for command to complete
    const completedCommand = await waitForCommandCompletion(
      serverId,
      siteId,
      commandId,
      forgeApiKey
    )

    if (!completedCommand) {
      return {
        success: false,
        commandId,
        error: 'Command execution timed out',
      }
    }

    return {
      success: completedCommand.command.status === 'finished',
      commandId,
      status: completedCommand.command.status,
      output: completedCommand.output,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
