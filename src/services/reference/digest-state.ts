export const REF_STAGES = ['first_meet', 'progress', 'breakthrough', 'closure', 'done', 'none'] as const
export const REF_FUNCS = ['main', 'daily', 'assist', 'introduce', 'mention'] as const

export type RefDigestStage = typeof REF_STAGES[number]
export type RefDigestFunc = typeof REF_FUNCS[number]

const STAGE_SET = new Set<string>(REF_STAGES)
const FUNC_SET = new Set<string>(REF_FUNCS)

/** stage 与 func 两套枚举不相交；模型填反时对调或清到安全默认，未知字符串原样留下交给校验。 */
export function coerceCharacterState(raw: {
  name: string
  stage?: unknown
  func?: unknown
}): { name: string; stage: string; func: string } {
  let stage = typeof raw.stage === 'string' ? raw.stage : ''
  let func = typeof raw.func === 'string' ? raw.func : ''
  const stageOk = STAGE_SET.has(stage)
  const funcOk = FUNC_SET.has(func)
  const stageIsFunc = FUNC_SET.has(stage)
  const funcIsStage = STAGE_SET.has(func)

  if (!stageOk && stageIsFunc && !funcOk && funcIsStage) {
    const swapped = stage
    stage = func
    func = swapped
  } else if (!stageOk && stageIsFunc) {
    if (!funcOk) func = stage
    stage = 'none'
  } else if (!funcOk && funcIsStage) {
    if (!stageOk) stage = func
    func = 'mention'
  }

  if (!stage) stage = 'none'
  if (!func) func = 'mention'
  return { name: raw.name, stage, func }
}

export function coerceCharacterStates(
  states: Array<{ name: string; stage?: unknown; func?: unknown }> | undefined,
): Array<{ name: string; stage: string; func: string }> {
  return (states ?? []).map((s) => coerceCharacterState(s))
}
