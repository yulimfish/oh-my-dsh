import { registerHooks } from 'node:module'

// Installed only in test processes via --import. Never modifies the dependency
// on disk or installs a plugin in the user's profile.
const toolsUrl = import.meta.resolve('@deepseek-ai/dsh-tools')
const originalUrl = `${toolsUrl}?dsh_omo_original_output_audit`
const checkerUrl = new URL('./tool-output-contract.js', import.meta.url).href

registerHooks({
  load(url, context, nextLoad) {
    if (url !== toolsUrl) return nextLoad(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export * from ${JSON.stringify(originalUrl)};
        export { default } from ${JSON.stringify(originalUrl)};
        import { defineTool as originalDefineTool, validateJsonSchemaValue } from ${JSON.stringify(originalUrl)};
        import { checkToolOutput } from ${JSON.stringify(checkerUrl)};
        export function defineTool(options) {
          const definition = originalDefineTool(options);
          return {
            ...definition,
            async execute(...args) {
              const value = await definition.execute(...args);
              try {
                checkToolOutput(definition, args[0], value, validateJsonSchemaValue);
              } catch (error) {
                // Persist failure even if a test intentionally catches execution errors.
                process.exitCode = 1;
                console.error('[tool-output-audit]', error);
                throw error;
              }
              return value;
            },
          };
        }
      `,
    }
  },
})
