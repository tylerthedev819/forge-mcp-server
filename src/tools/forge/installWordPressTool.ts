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

// Helper to wait for WordPress installation to complete
async function waitForWordPressInstalled(
  serverId: string,
  siteId: string,
  forgeApiKey: string,
  maxAttempts = 60,
  delayMs = 2000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await callForgeApi<{ site: { app: string | null; app_status: string | null } }>(
        {
          endpoint: `/servers/${serverId}/sites/${siteId}`,
          method: HttpMethod.GET,
        },
        forgeApiKey
      )
      // WordPress is installed when app is 'wordpress' and app_status is 'installed'
      if (response.site?.app === 'wordpress' && response.site?.app_status === 'installed') {
        return true
      }
      // Also check if app_status indicates failure
      if (response.site?.app_status === 'failed') {
        return false
      }
    } catch (e) {
      // Ignore errors during polling
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

// Helper to get database user name by ID
async function getDatabaseUserName(
  serverId: string,
  userId: number,
  forgeApiKey: string
): Promise<string | null> {
  try {
    const response = await callForgeApi<{ user: { name: string } }>(
      {
        endpoint: `/servers/${serverId}/database-users/${userId}`,
        method: HttpMethod.GET,
      },
      forgeApiKey
    )
    return response.user?.name || null
  } catch (e) {
    return null
  }
}

// Try to install WordPress using Forge's official API
async function tryForgeWordPressApi(
  serverId: string,
  siteId: string,
  database: string,
  userId: number,
  forgeApiKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await callForgeApi<object>(
      {
        endpoint: `/servers/${serverId}/sites/${siteId}/wordpress`,
        method: HttpMethod.POST,
        data: {
          database: database,
          user: userId,
        },
      },
      forgeApiKey
    )
    
    // Wait for WordPress to be installed
    const installed = await waitForWordPressInstalled(serverId, siteId, forgeApiKey)
    if (installed) {
      return { success: true }
    }
    return { success: false, error: 'WordPress installation timed out or failed' }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, error: errorMessage }
  }
}

// Manual WordPress installation using direct download
async function manualWordPressInstall(
  serverId: string,
  siteId: string,
  siteName: string,
  database: string,
  dbUsername: string,
  forgeApiKey: string
): Promise<{ success: boolean; error?: string }> {
  const siteDir = `/home/forge/${siteName}`
  const publicDir = `${siteDir}/public`

  try {
    // Clear public directory
    const clearResult = await executeCommandInternal(
      serverId,
      siteId,
      `rm -rf ${publicDir}/* ${publicDir}/.[!.]* 2>/dev/null; echo "Cleared"`,
      forgeApiKey,
      true
    )

    if (!clearResult.success) {
      return { success: false, error: `Failed to clear public directory: ${clearResult.error}` }
    }

    // Download WordPress using curl and extract it
    const downloadCmd = `cd ${publicDir} && curl -sS https://wordpress.org/latest.tar.gz | tar xz --strip-components=1`
    const downloadResult = await executeCommandInternal(
      serverId,
      siteId,
      downloadCmd,
      forgeApiKey,
      true
    )

    if (!downloadResult.success) {
      return { success: false, error: `Failed to download WordPress: ${downloadResult.error}` }
    }

    // Create wp-config.php with database settings
    const wpConfigCmd = `cd ${publicDir} && cp wp-config-sample.php wp-config.php && \
      sed -i "s/database_name_here/${database}/" wp-config.php && \
      sed -i "s/username_here/${dbUsername}/" wp-config.php && \
      sed -i "s/password_here/YOUR_DB_PASSWORD_HERE/" wp-config.php && \
      sed -i "s/localhost/127.0.0.1/" wp-config.php`

    const configResult = await executeCommandInternal(
      serverId,
      siteId,
      wpConfigCmd,
      forgeApiKey,
      true
    )

    if (!configResult.success) {
      return { success: false, error: `Failed to configure wp-config.php: ${configResult.error}` }
    }

    // Generate and set security keys using WP salt API
    const saltCmd = `cd ${publicDir} && \
      SALT=$(curl -sS https://api.wordpress.org/secret-key/1.1/salt/) && \
      sed -i "/define( 'AUTH_KEY'/d" wp-config.php && \
      sed -i "/define( 'SECURE_AUTH_KEY'/d" wp-config.php && \
      sed -i "/define( 'LOGGED_IN_KEY'/d" wp-config.php && \
      sed -i "/define( 'NONCE_KEY'/d" wp-config.php && \
      sed -i "/define( 'AUTH_SALT'/d" wp-config.php && \
      sed -i "/define( 'SECURE_AUTH_SALT'/d" wp-config.php && \
      sed -i "/define( 'LOGGED_IN_SALT'/d" wp-config.php && \
      sed -i "/define( 'NONCE_SALT'/d" wp-config.php && \
      sed -i "/put your unique phrase here/d" wp-config.php && \
      echo "$SALT" >> wp-config.php || true`

    await executeCommandInternal(
      serverId,
      siteId,
      saltCmd,
      forgeApiKey,
      true
    )

    // Set proper permissions
    const permCmd = `chown -R forge:forge ${publicDir} && chmod -R 755 ${publicDir}`
    await executeCommandInternal(
      serverId,
      siteId,
      permCmd,
      forgeApiKey,
      true
    )

    return { success: true }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    return { success: false, error: errorMessage }
  }
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

      // Get the database username from the userId (needed for manual install fallback)
      const dbUsername = await getDatabaseUserName(serverId, userId, forgeApiKey)
      if (!dbUsername) {
        return toMCPToolError(new Error(`Could not find database user with ID ${userId}`))
      }

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

        // Step 3: Wait for site to be ready
        const isReady = await waitForSiteReady(serverId, newSiteId, forgeApiKey)
        if (!isReady) {
          return toMCPToolError(new Error('Timed out waiting for site to be ready'))
        }

        // Additional delay to ensure site is fully provisioned
        await new Promise(resolve => setTimeout(resolve, 3000))

      } else {
        // Use existing site
        if (!siteId) {
          return toMCPToolError(new Error('siteId is required when createFreshSite is false'))
        }
        newSiteId = siteId
      }

      // Step 4: Clear the public directory first to reset site state
      // This is crucial - Forge's WordPress API won't work if the site has any app deployed
      const siteDir = `/home/forge/${siteName}`
      const publicDir = `${siteDir}/public`
      
      const clearResult = await executeCommandInternal(
        serverId,
        newSiteId,
        `rm -rf ${publicDir}/* ${publicDir}/.[!.]* 2>/dev/null; echo "Cleared"`,
        forgeApiKey,
        true
      )

      if (!clearResult.success) {
        return toMCPToolError(new Error(`Failed to clear public directory: ${clearResult.error}`))
      }

      // Small delay after clearing
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Step 5: Try Forge's official WordPress API first
      const apiResult = await tryForgeWordPressApi(serverId, newSiteId, database, userId, forgeApiKey)
      
      if (apiResult.success) {
        return toMCPToolResult({
          success: true,
          message: `WordPress has been successfully installed on site ${siteName} (ID: ${newSiteId}) using Forge's official API.

Visit https://${siteName} to complete the WordPress setup wizard.`,
          siteId: newSiteId,
          siteUrl: `https://${siteName}`,
          database: database,
          dbUser: dbUsername,
          method: 'forge-api'
        })
      }

      // Step 6: Fallback to manual installation if API fails
      console.log(`Forge API WordPress installation failed: ${apiResult.error}. Falling back to manual installation.`)
      
      const manualResult = await manualWordPressInstall(
        serverId,
        newSiteId,
        siteName,
        database,
        dbUsername,
        forgeApiKey
      )

      if (!manualResult.success) {
        return toMCPToolError(new Error(`Both Forge API and manual WordPress installation failed.\nAPI error: ${apiResult.error}\nManual error: ${manualResult.error}`))
      }

      return toMCPToolResult({
        success: true,
        message: `WordPress has been downloaded and installed on site ${siteName} (ID: ${newSiteId}) using manual installation.

IMPORTANT: You need to update the database password in wp-config.php:
1. SSH into the server or use Forge's file editor
2. Edit /home/forge/${siteName}/public/wp-config.php
3. Replace 'YOUR_DB_PASSWORD_HERE' with the actual database password

Then visit https://${siteName} to complete the WordPress setup wizard.`,
        siteId: newSiteId,
        siteUrl: `https://${siteName}`,
        wpConfigPath: `${publicDir}/wp-config.php`,
        database: database,
        dbUser: dbUsername,
        method: 'manual',
        note: 'Database password needs to be set manually in wp-config.php'
      })

    } catch (err) {
      return toMCPToolError(err)
    }
  },
}
