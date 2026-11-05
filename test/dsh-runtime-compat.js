import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'

export function installSessionProjectionRegistry(ctx) {
  return ctx.plugin(SessionProjectionRegistry)
}

export function installNativeToolExecutor(ctx) {
  return ctx.plugin(NativeToolExecutorPlugin)
}

export async function executeToolOnce(tools, {
  callId,
  name,
  arguments: args = {},
  agent,
  signal = new AbortController().signal,
}) {
  const batch = await tools.execute({
    calls: [{ id: callId, name, arguments: JSON.stringify(args) }],
    agent,
    signal,
  })
  const outcome = batch.results.find(result => result.callId === callId)
  if (!outcome) throw new Error(`Tool batch omitted result for ${callId}`)
  return outcome.result
}
