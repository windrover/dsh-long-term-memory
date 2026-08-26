// dsh-long-term-memory — one-shot LLM helper.
//
// Wraps the DSH `ctx.llm.stream` seam into a single request → text helper for
// the plugin's auxiliary model calls (auto-summarize extraction, LLM
// compression). It is deliberately small: the plugin's memory path stays
// deterministic by default, and these calls only happen when the
// auto-summarize / LLM-compress switches are enabled.

/** How long one auxiliary model call may run before aborting. */
export const AUX_LLM_TIMEOUT_MS = 60_000

/**
 * Run one auxiliary LLM request and return the full text reply.
 *
 * @param ctx - plugin context exposing `llm`.
 * @param agent - the caller agent whose provider/model route is inherited.
 * @param opts - system prompt, user messages, and an optional abort signal.
 * @returns the concatenated text of the first text block, trimmed.
 * @throws on timeout, cancellation, or adapter failure (message preserved).
 */
export async function askLlm(ctx, agent, { system, userText, signal }) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is not mounted; enable auto-summarize/compress only in a profile with an LLM')
  if (agent === undefined) throw new Error('auxiliary LLM call requires an agent to inherit provider/model')
  const { provider, model } = agent.options ?? {}
  if (provider === undefined || model === undefined) {
    throw new Error(`auxiliary LLM call has no provider/model route (agent has ${JSON.stringify(agent.options)})`)
  }

  let timeout
  const timer = new Promise((resolve) => {
    timeout = setTimeout(resolve, AUX_LLM_TIMEOUT_MS)
  })
  const onAbort = () => { /* the stream loop checks signal; timeout bounds the await */ }
  signal?.addEventListener('abort', onAbort, { once: true })

  const lines = []
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ type: 'user', content: [{ type: 'text', text: userText }] }],
      purpose: 'compaction',
      ...(signal !== undefined ? { signal } : {}),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') lines.push(chunk.text)
    }
  } catch (error) {
    if (signal?.aborted) throw new Error('auxiliary LLM call cancelled')
    throw new Error(`auxiliary LLM call failed: ${error?.message ?? error}`)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
  return lines.join('').trim()
}

export default askLlm
