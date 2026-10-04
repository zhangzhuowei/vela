/**
 * 备用模型链的选择（纯函数，便于单测）
 *
 * 主模型持续失败时依次换用备用模型。备用模型必须能做文本生成：
 * 此前把所有已配置模型都排进链里，会切到 Embedding / 文生图模型上，
 * 它们对聊天请求返回 400（不可重试）直接终止整条链，把原本的 429 掩盖掉。
 */
import type { ModelProfile } from '../../shared/ipc-channels'

type ModelLike = Pick<ModelProfile, 'id' | 'baseUrl'> & { purposes?: ModelProfile['purposes'] }

/** 能做文本生成的模型：用途含生成 / 改写 / 摘要；没填用途的老配置也算 */
export function isTextGenerationModel(model: Pick<ModelLike, 'purposes'>): boolean {
  const purposes = model.purposes ?? []
  if (purposes.length === 0) return true
  return purposes.some((p) => p === 'generation' || p === 'refinement' || p === 'summary')
}

/**
 * 备用模型的尝试顺序：排除主模型与不能做文本生成的模型，
 * 与主模型不同服务商（baseUrl）的排在前面，规避「同一家服务商同时繁忙 / 故障」。
 */
export function orderFallbackModels<T extends ModelLike>(models: T[], primaryId?: string): T[] {
  const primaryBase = primaryId ? models.find((m) => m.id === primaryId)?.baseUrl ?? '' : ''
  const candidates = models.filter((m) => m.id !== primaryId && isTextGenerationModel(m))
  return [
    ...candidates.filter((m) => m.baseUrl !== primaryBase),
    ...candidates.filter((m) => m.baseUrl === primaryBase),
  ]
}
