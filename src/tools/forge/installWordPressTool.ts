import { ForgeToolDefinition, HttpMethod } from '../../core/types/protocols.js'
import { callForgeApi } from '../../utils/forgeApi.js'
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js'
import { z } from 'zod'
import { installWordPressConfirmationStore } from './confirmInstallWordPressTool.js'
import {
  validateConfirmation,
  markConfirmationUsed,
} from '../../utils/confirmationStore.js'
import { executeCommandInternal } from './executeSiteCommandTool.js'

const paramsSchema = {
  serverId: z.string().describe('The ID of the server.'),
  serverName: z.string().describe('The name of the server.'),
  siteId: z
    .string()
    .optional()
    .describe('The ID of an existing site to delete and recreate with WordPress.'),
  siteName: z.string().describe('The domain name for the WordPress site.'),
  database: z.string().describe('The name of the database to use for WordPress.'),
  userId: z.number().describe('The database user ID (integer) for WordPress. Get this ID from list_database_users tool.'),
  createFreshSite: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to delete any existing site and create a fresh one before installing WordPress. Defaults to true.'
    ),
  isolated: z
    .boolean()
    .optional()
    .describe('Whether the site should be isolated (optional).'),
  phpVersion: z
    .string()
    .optional()
    .describe('The PHP version for the site (optional).'),
  confirmationId: z
    .string()
    .describe(
      'This confirmationId must be obtained from confirm_install_wordpress tool after explicit user confirmation.'
    ),
}

const paramsZodObject = z.object(paramsSchema)

// Helper to wait for site to be ready
async function waitForSiteReady(
  serverId: string,
  siteId: string,
  forgeApiKey: string,
  maxAttempts = 30,
  delayMs = 2000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await callForgeApi<{ site: { status: string } }>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}`,
          method: HttpMethod.GET,
        },
        forgeApiKey
      )
      if (response.site?.status === 'installed') {
        return true
      }
    } catch (e) {
      // Ignore errors during polling
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

export const installWordPressTool: ForgeToolDefinition<typeof paramsSchema> = {
  name: 'install_wordpress',
  parameters: paramsSchema,
  annotations: {
    title: 'Install WordPress',
    description: `Installs WordPress on a Laravel Forge server by creating a fresh site and installing WordPress.

This tool handles the full WordPress installation workflow:
1. If an existing siteId is provided and createFreshSite is true: deletes the existing site
2. Creates a new PHP site with the specified domain
3. Waits for the site to be ready
4. **Clears the default files from the public directory** (this is the key fix!)
5. Installs WordPress using the specified database and user

This approach is necessary because Forge cannot install WordPress on sites that already have an application deployed (including the default PHP info page that Forge creates on new sites). By clearing the public directory first, we work around this API limitation.

IMPORTANT: The userId parameter must be the numeric database user ID (integer) from list_database_users, NOT the username string.

After installation, visit the site URL to complete the WordPress setup wizard.

Before calling this tool, the client MUST call the 'confirm_install_wordpress' tool and present the returned summary to the user for explicit confirmation.`,
    operation: 'create',
    resource: 'wordpress',
    safe: true,
    readOnlyHint: false,
    openWorldHint: true,
    readWriteHint: true,
    destructiveHint: false
  },
  handler: async (params, forgeApiKey) => {
    try {
      const parsed = paramsZodObject.parse(params)
      const { confirmationId, serverId, siteId, siteName, database, userId, createFreshSite, isolated, phpVersion } = parsed

      // Validate confirmation using generic utility
      const confirmation = validateConfirmation(
        installWordPressConfirmationStore,
        confirmationId,
        (stored: Record<string, unknown>) => {
          return (
            stored.serverId === serverId &&
            stored.siteName === siteName &&
            stored.database === database &&
            stored.userId === userId
          )
        }
      )
      if (!confirmation) {
        return toMCPToolResult(false)
      }
      markConfirmationUsed(installWordPressConfirmationStore, confirmationId)

      let newSiteId: string

      if (createFreshSite !== false) {
        // Step 1: Delete existing site if siteId provided
        if (siteId) {
          try {
            await callForgeApi<object>(
              {
                endpoint: `/servers/${serverId}/sites/${siteId}`,
                method: HttpMethod.DELETE,
              },
              forgeApiKey
            )
            // Wait a bit for deletion to complete
            await new Promise(resolve => setTimeout(resolve, 3000))
          } catch (deleteError) {
            // Ignore deletion errors - site might not exist
          }
        }

        // Step 2: Create a new PHP site
        const createSitePayload: Record<string, unknown> = {
          domain: siteName,
          project_type: 'php',
        }
        if (isolated !== undefined) {
          createSitePayload.isolated = isolated
        }
        if (phpVersion) {
          createSitePayload.php_version = phpVersion
        }

        const createResponse = await callForgeApi<{ site: { id: number; status: string } }>(
          {
            endpoint: `/servers/${serverId}/sites`,
            method: HttpMethod.POST,
            data: createSitePayload,
          },
          forgeApiKey
        )

        newSiteId = String(createResponse.site.id)

        // Step 3: Wait for site to be ready
        const isReady = await waitForSiteReady(serverId, newSiteId, forgeApiKey)
        if (!isReady) {
          return toMCPToolError(new Error('Timed out waiting for site to be ready'))
        }

        // Small additional delay to ensure Forge has fully initialized the site
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Step 4: Clear the public directory to remove the default index.php
        // This is the KEY FIX - the default index.php triggers the "application installed" check
        const clearCommand = `rm -rf /home/forge/${siteName}/public/*`
        const clearResult = await executeCommandInternal(
          serverId,
          newSiteId,
          clearCommand,
          forgeApiKey,
          true // wait for completion
        )

        if (!clearResult.success) {
          return toMCPToolError(
            new Error(
              `Failed to clear default files from public directory: ${clearResult.error || 'Unknown error'}. ` +
              `This step is required before WordPress can be installed.`
            )
          )
        }

        // Small delay after clearing files
        await new Promise(resolve => setTimeout(resolve, 1000))

      } else {
        // Use existing site (may fail if it has an app installed)
        if (!siteId) {
          return toMCPToolError(new Error('siteId is required when createFreshSite is false'))
        }
        newSiteId = siteId
      }

      // Step 5: Install WordPress
      const wordpressPayload = {
        database,
        user: userId,
      }

      const data = await callForgeApi<object>(
        {
          endpoint: `/servers/${serverId}/sites/${newSiteId}/wordpress`,
          method: HttpMethod.POST,
          data: wordpressPayload,
        },
        forgeApiKey
      )

      return toMCPToolResult({
        success: true,
        message: `WordPress installation initiated on site ${siteName} (ID: ${newSiteId}). Visit the site URL to complete the WordPress setup wizard.`,
        siteId: newSiteId,
        data,
      })
    } catch (err) {
      return toMCPToolError(err)
    }
  },
}
