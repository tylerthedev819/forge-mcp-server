import { ForgeToolDefinition, HttpMethod } from '../../core/types/protocols.js'
import { callForgeApi } from '../../utils/forgeApi.js'
import { toMCPToolResult, toMCPToolError } from '../../utils/mcpToolResult.js'
import { z } from 'zod'
import { installWordPressConfirmationStore } from './confirmInstallWordPressTool.js'
import {
  validateConfirmation,
  markConfirmationUsed,
} from '../../utils/confirmationStore.js'

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

// Helper to wait for WordPress installation to complete
async function waitForWordPressReady(
  serverId: string,
  siteId: string,
  forgeApiKey: string,
  maxAttempts = 60,
  delayMs = 3000
): Promise<{ ready: boolean; site?: Record<string, unknown> }> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await callForgeApi<{ site: Record<string, unknown> }>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}`,
          method: HttpMethod.GET,
        },
        forgeApiKey
      )
      // Check if site is installed and has WordPress app
      if (
        response.site?.status === 'installed' &&
        response.site?.app === 'wordpress'
      ) {
        return { ready: true, site: response.site }
      }
    } catch (e) {
      // Ignore errors during polling
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return { ready: false }
}

// Helper to attempt WordPress installation with retries - NO DELAY on first attempt
async function attemptWordPressInstall(
  serverId: string,
  siteId: string,
  database: string,
  userId: number,
  forgeApiKey: string,
  maxAttempts = 10,
  delayMs = 500
): Promise<{ success: boolean; data?: object; error?: string }> {
  const wordpressPayload = {
    database,
    user: userId,
  }

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await callForgeApi<object>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}/wordpress`,
          method: HttpMethod.POST,
          data: wordpressPayload,
        },
        forgeApiKey
      )
      return { success: true, data }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      
      // If it's the "application installed" error, wait briefly and retry
      if (errorMessage.includes('application installed')) {
        if (i < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
          continue
        }
      }
      
      // For other errors or final attempt, return the error
      return { success: false, error: errorMessage }
    }
  }
  
  return { success: false, error: 'Max retry attempts reached' }
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
3. **IMMEDIATELY** calls the WordPress installation API (no waiting - this is critical!)
4. Waits for WordPress installation to complete

The key to this approach is calling the WordPress API IMMEDIATELY after site creation,
with zero delay, to try to beat Forge's internal state update that marks the site as having an application.

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
            // Wait for deletion to complete
            await new Promise(resolve => setTimeout(resolve, 5000))
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

        // Step 3: IMMEDIATELY attempt WordPress installation - NO WAITING!
        // This is critical - we must call the WordPress API before Forge marks the site as having an app
        const wpResult = await attemptWordPressInstall(
          serverId,
          newSiteId,
          database,
          userId,
          forgeApiKey
        )

        if (!wpResult.success) {
          return toMCPToolError(
            new Error(`WordPress installation failed: ${wpResult.error}`)
          )
        }

        // Step 4: Wait for WordPress to be fully installed
        const wpReady = await waitForWordPressReady(serverId, newSiteId, forgeApiKey)
        
        if (!wpReady.ready) {
          // WordPress API call succeeded but installation is still in progress
          // This is not necessarily an error - just return success with a note
          return toMCPToolResult({
            success: true,
            message: `WordPress installation initiated on site ${siteName} (ID: ${newSiteId}). Installation is in progress. Visit the site URL to complete the WordPress setup wizard once installation finishes.`,
            siteId: newSiteId,
            data: wpResult.data,
            status: 'installing',
          })
        }

        return toMCPToolResult({
          success: true,
          message: `WordPress successfully installed on site ${siteName} (ID: ${newSiteId}). Visit the site URL to complete the WordPress setup wizard.`,
          siteId: newSiteId,
          site: wpReady.site,
          data: wpResult.data,
          status: 'installed',
        })

      } else {
        // Use existing site (may fail if it has an app installed)
        if (!siteId) {
          return toMCPToolError(new Error('siteId is required when createFreshSite is false'))
        }
        newSiteId = siteId

        // Try to install WordPress on existing site
        const wpResult = await attemptWordPressInstall(
          serverId,
          newSiteId,
          database,
          userId,
          forgeApiKey
        )

        if (!wpResult.success) {
          return toMCPToolError(
            new Error(`WordPress installation failed: ${wpResult.error}`)
          )
        }

        return toMCPToolResult({
          success: true,
          message: `WordPress installation initiated on site ${siteName} (ID: ${newSiteId}). Visit the site URL to complete the WordPress setup wizard.`,
          siteId: newSiteId,
          data: wpResult.data,
        })
      }
    } catch (err) {
      return toMCPToolError(err)
    }
  },
}
