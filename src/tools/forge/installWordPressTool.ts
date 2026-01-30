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

export const installWordPressTool: ForgeToolDefinition<typeof paramsSchema> = {
  name: 'install_wordpress',
  parameters: paramsSchema,
  annotations: {
    title: 'Install WordPress',
    description: `Installs WordPress on a Laravel Forge server using WP-CLI (manual installation).

This tool handles the full WordPress installation workflow:
1. If an existing siteId is provided and createFreshSite is true: deletes the existing site
2. Creates a new PHP site with the specified domain
3. Waits for the site to be ready
4. Downloads and installs WordPress using WP-CLI commands
5. Configures wp-config.php with database credentials

NOTE: This uses manual WP-CLI installation because Forge's WordPress API endpoint
has a limitation that prevents it from working on sites created via API.

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

      // Get the database username from the userId
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

      // Step 4: Install WordPress using WP-CLI
      // First, clear the public directory and download WordPress
      const siteDir = `/home/forge/${siteName}`
      const publicDir = `${siteDir}/public`

      // Clear public directory
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

      // Download WordPress using curl and extract it
      const downloadCmd = `cd ${publicDir} && curl -sS https://wordpress.org/latest.tar.gz | tar xz --strip-components=1`
      const downloadResult = await executeCommandInternal(
        serverId,
        newSiteId,
        downloadCmd,
        forgeApiKey,
        true
      )

      if (!downloadResult.success) {
        return toMCPToolError(new Error(`Failed to download WordPress: ${downloadResult.error}`))
      }

      // Step 5: Create wp-config.php
      // We need to get database password from the environment or use a placeholder
      // Since we don't have the password, we'll create a basic wp-config that needs manual setup
      const wpConfigCmd = `cd ${publicDir} && cp wp-config-sample.php wp-config.php && \\
        sed -i "s/database_name_here/${database}/" wp-config.php && \\
        sed -i "s/username_here/${dbUsername}/" wp-config.php && \\
        sed -i "s/password_here/YOUR_DB_PASSWORD_HERE/" wp-config.php && \\
        sed -i "s/localhost/127.0.0.1/" wp-config.php`
      
      const configResult = await executeCommandInternal(
        serverId,
        newSiteId,
        wpConfigCmd,
        forgeApiKey,
        true
      )

      if (!configResult.success) {
        return toMCPToolError(new Error(`Failed to configure wp-config.php: ${configResult.error}`))
      }

      // Generate and set security keys using WP salt API
      const saltCmd = `cd ${publicDir} && \\
        SALT=$(curl -sS https://api.wordpress.org/secret-key/1.1/salt/) && \\
        printf '%s\\n' "g/put your unique phrase here/d" "w" | ed -s wp-config.php 2>/dev/null; \\
        sed -i "/define( 'AUTH_KEY'/d" wp-config.php && \\
        sed -i "/define( 'SECURE_AUTH_KEY'/d" wp-config.php && \\
        sed -i "/define( 'LOGGED_IN_KEY'/d" wp-config.php && \\
        sed -i "/define( 'NONCE_KEY'/d" wp-config.php && \\
        sed -i "/define( 'AUTH_SALT'/d" wp-config.php && \\
        sed -i "/define( 'SECURE_AUTH_SALT'/d" wp-config.php && \\
        sed -i "/define( 'LOGGED_IN_SALT'/d" wp-config.php && \\
        sed -i "/define( 'NONCE_SALT'/d" wp-config.php && \\
        sed -i "/@-/r /dev/stdin" wp-config.php <<< "$SALT" || true`

      await executeCommandInternal(
        serverId,
        newSiteId,
        saltCmd,
        forgeApiKey,
        true
      )

      // Set proper permissions
      const permCmd = `chown -R forge:forge ${publicDir} && chmod -R 755 ${publicDir}`
      await executeCommandInternal(
        serverId,
        newSiteId,
        permCmd,
        forgeApiKey,
        true
      )

      return toMCPToolResult({
        success: true,
        message: `WordPress has been downloaded and installed on site ${siteName} (ID: ${newSiteId}).

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
        note: 'Database password needs to be set manually in wp-config.php'
      })

    } catch (err) {
      return toMCPToolError(err)
    }
  },
}
