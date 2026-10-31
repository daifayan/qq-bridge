// 诊断插件：包住 DeepSeek 请求扩展注册表的 prepare，
// 在它抛错时把每个贡献者的真实异常打出来（原始 LlmError 只保留 message，cause 被丢弃）。
// 纯诊断用，不改变任何业务行为；出错时只打印，然后原样抛出。
export const name = 'ext-debug'

export const inject = ['deepseekLlmApiExtensions']

function describe(error) {
  if (error === undefined || error === null) return String(error)
  const parts = [String(error.stack ?? error.message ?? error)]
  let cause = error.cause
  let depth = 0
  while (cause !== undefined && cause !== null && depth < 5) {
    parts.push(`  ← cause[${depth}]: ${String(cause.stack ?? cause.message ?? cause)}`)
    cause = cause.cause
    depth += 1
  }
  return parts.join('\n')
}

export function apply(ctx) {
  try {
    const registry = ctx.deepseekLlmApiExtensions
    if (registry === undefined || registry === null) {
      console.error('[ext-debug] registry 不可用，跳过')
      return
    }
    if (typeof registry.prepare !== 'function') {
      console.error('[ext-debug] registry.prepare 不是函数，跳过')
      return
    }
    if (registry.__extDebugPatched === true) return

    const original = registry.prepare.bind(registry)
    registry.prepare = async function patchedPrepare(request) {
      try {
        return await original(request)
      } catch (error) {
        console.error('[ext-debug] ===== registry.prepare 抛错 =====')
        console.error(describe(error))
        // 逐个贡献者单独跑一次，定位到底是哪一支
        const providers = registry.providers
        if (providers instanceof Map && providers.size > 0) {
          for (const [field, provider] of providers.entries()) {
            try {
              const result = await provider.prepare(request)
              const preview = result === undefined ? '(undefined)' : JSON.stringify(result)?.slice(0, 120)
              console.error(`[ext-debug]   ${field}: OK ${preview}`)
            } catch (providerError) {
              console.error(`[ext-debug]   ${field}: THREW`)
              console.error(describe(providerError))
            }
          }
        } else {
          console.error('[ext-debug]   (无法枚举 providers，size=' + String(providers?.size) + ')')
        }
        console.error('[ext-debug] ===== 诊断结束 =====')
        throw error
      }
    }
    registry.__extDebugPatched = true
    console.error('[ext-debug] 已挂载 prepare 诊断钩子')
  } catch (error) {
    // 诊断插件自身绝不能影响启动
    console.error('[ext-debug] 自身异常（已忽略）: ' + describe(error))
  }
}
