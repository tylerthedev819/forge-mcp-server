import { ForgeToolDefinition } from '../../core/types/protocols.js'
import { toMCPToolResult } from '../../utils/mcpToolResult.js'
import { z } from 'zod'
import {
  createConfirmationStore,
  createConfirmation,
} from '../../utils/confirmationStore.js'
import { CONFIRMATION_DESCRIPTION } from '../../utils/protocolDescriptions.js'

const paramsSchema = {
  serverId: z
    .string()
    .describe(
      'The ID of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'
    ),
  serverName: z
    .string()
    .describe(
      'The name of the server. The client MUST validate this value against the available servers from listServersTool before passing it.'
    ),
  siteId: z
    .string()
    .optional()
    .describe(
      'The ID of an existing site to delete and recreate with WordPress. If provided along with createFreshSite=true, the site will be deleted first. If createFreshSite=false, WordPress will be installed on this existing site (may fail if site already has an app).'
    ),
  siteName: z
    .string()
    .describe(
      'The domain name for the WordPress site (e.g., "example.com"). This will be used as the site name.'
    ),
  database: z
    .string()
    .describe(
      'The name of the database to use for WordPress. The client MUST validate this value against the available databases from listDatabasesTool before passing it.'
    ),
  userId: z
    .number()
    .describe(
      'The database user ID (integer) for WordPress. The client MUST get this ID from listDatabaseUsersTool. This is the numeric ID of the user, not the username string.'
    ),
  createFreshSite: z
    .boolean()
    .optional()
    .describe(
      'Whether to delete any existing site and create a fresh one before installing WordPress. Defaults to true. This is the recommended approach as Forge cannot install WordPress on sites that already have an application deployed (including the default PHP info page). When false, attempts to install on existing site (may fail).'
    ),
  isolated: z
    .boolean()
    .optional()
    .describe('Whether the site should be isolated (optional). Creates a separate system user for the site.'),
  phpVersion: z
    .string()
    .optional()
    .describe('The PHP version for the site (optional, e.g., "php84", "php83"). Defaults to server default.'),
}

const paramsZodObject = z.object(paramsSchema)

// Confirmation store uses Record<string, unknown> for compatibility
export const installWordPressConfirmationStore =
  createConfirmationStore<Record<string, unknown>>()

const baseDescription = 'Confirms the WordPress installation parameters and returns a summary for user confirmation.'

export const confirmInstallWordPressTool: ForgeToolDefinition<typeof paramsSchema> = {
  name: 'confirm_install_wordpress',
  parameters: paramsSchema,
  annotations: {
    title: 'Confirm WordPress Installation',
    description: `${baseDescription}\n\n${CONFIRMATION_DESCRIPTION}`,
    operation: 'confirm',
    resource: 'wordpress_installation',
    safe: false,
    readOnlyHint: false,
    openWorldHint: true,
    readWriteHint: true,
    destructiveHint: false
  },
  handler: async params => {
    // Parse params with Zod to get typed values
    const parsed = paramsZodObject.parse(params)
    const { serverId, serverName, siteId, siteName, database, userId, isolated, phpVersion } = parsed
    const createFreshSite = parsed.createFreshSite ?? true
    
    // Build the confirmation data
    const confirmationData: Record<string, unknown> = {
      serverId,
      serverName,
      siteName,
      database,
      userId,
      createFreshSite,
      siteId,
      isolated,
      phpVersion,
    }
    
    const entry = createConfirmation(installWordPressConfirmationStore, confirmationData)
    
    let summary = `Please confirm WordPress installation with the following settings:\n` +
      `Server: ${serverName} (ID: ${serverId})\n` +
      `Site Domain: ${siteName}\n`
    
    if (siteId && createFreshSite) {
      summary += `Existing Site ID: ${siteId} (WILL BE DELETED and recreated)\n`
    } else if (siteId && !createFreshSite) {
      summary += `Existing Site ID: ${siteId} (will attempt install on existing site)\n`
    } else {
      summary += `New Site: Yes (will create new site)\n`
    }
    
    summary += `Database: ${database}\n` +
      `Database User ID: ${userId}\n` +
      `Create Fresh Site: ${createFreshSite ? 'Yes (recommended - deletes existing site first)' : 'No (may fail if site has app installed)'}\n`
    
    if (isolated !== undefined) {
      summary += `Isolated: ${isolated ? 'Yes' : 'No'}\n`
    }
    if (phpVersion) {
      summary += `PHP Version: ${phpVersion}\n`
    }
    
    summary += `Confirmation ID: ${entry.confirmationId}\n` +
      `\nType "yes" to confirm or "no" to cancel.`
    
    return toMCPToolResult({ summary, confirmationId: entry.confirmationId })
  },
}
