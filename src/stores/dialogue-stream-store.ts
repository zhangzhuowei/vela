/**
 * 对话流式会话 store（按场 id）
 *
 * 把「生成/蒸馏」进行中的实时文本与请求 id 提到组件之外，
 * 这样切换编辑器页签（对话编辑器被卸载再挂载）时能接着显示实时流与停止按钮，
 * 而不是断掉重来。数据落库仍由服务层负责，此处只管「界面态」。
 */
import { create } from 'zustand'

export type StreamPhase = 'generating' | 'distilling'

export interface StreamSession {
  /** 当前阶段；null 表示无进行中的流（蒸馏完成后进入对照编辑态仍保留 distillDraft） */
  phase: StreamPhase | null
  /** 活跃 LLM 请求 id，供停止按钮使用 */
  requestId: string | null
  /** 生成阶段的实时正文（含未剥离的 <state>，展示时再剥） */
  streaming: string
  /** 蒸馏阶段的实时/成稿文本；null 表示当前没有蒸馏草稿 */
  distillDraft: string | null
}

interface DialogueStreamState {
  sessions: Record<number, StreamSession | undefined>
  /** 完成信号：数值自增触发组件从数据库重载回合 */
  doneTick: Record<number, number | undefined>

  beginGenerate: (sceneId: number) => void
  beginDistill: (sceneId: number) => void
  setRequest: (sceneId: number, requestId: string | null) => void
  appendStreaming: (sceneId: number, chunk: string) => void
  setStreaming: (sceneId: number, text: string) => void
  appendDistill: (sceneId: number, chunk: string) => void
  setDistillDraft: (sceneId: number, text: string | null) => void
  /** 生成完成：清会话 + 触发重载 */
  finishGenerate: (sceneId: number) => void
  /** 蒸馏完成：保留成稿草稿进入对照编辑态 */
  finishDistill: (sceneId: number, draft: string) => void
  /** 失败/取消：清流式态；keepDistill=true 时保留已有蒸馏草稿 */
  fail: (sceneId: number, keepDistill?: boolean) => void
}

const EMPTY: StreamSession = { phase: null, requestId: null, streaming: '', distillDraft: null }

export const useDialogueStream = create<DialogueStreamState>()((set) => {
  const patch = (sceneId: number, next: Partial<StreamSession>) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sceneId]: { ...(s.sessions[sceneId] ?? EMPTY), ...next },
      },
    }))

  return {
    sessions: {},
    doneTick: {},

    beginGenerate: (sceneId) => patch(sceneId, { phase: 'generating', requestId: null, streaming: '' }),
    beginDistill: (sceneId) => patch(sceneId, { phase: 'distilling', requestId: null, distillDraft: '' }),
    setRequest: (sceneId, requestId) => patch(sceneId, { requestId }),
    appendStreaming: (sceneId, chunk) =>
      set((s) => {
        const cur = s.sessions[sceneId] ?? EMPTY
        return { sessions: { ...s.sessions, [sceneId]: { ...cur, streaming: cur.streaming + chunk } } }
      }),
    setStreaming: (sceneId, text) => patch(sceneId, { streaming: text }),
    appendDistill: (sceneId, chunk) =>
      set((s) => {
        const cur = s.sessions[sceneId] ?? EMPTY
        return { sessions: { ...s.sessions, [sceneId]: { ...cur, distillDraft: (cur.distillDraft ?? '') + chunk } } }
      }),
    setDistillDraft: (sceneId, text) => patch(sceneId, { distillDraft: text }),

    finishGenerate: (sceneId) =>
      set((s) => ({
        sessions: { ...s.sessions, [sceneId]: { ...EMPTY, distillDraft: s.sessions[sceneId]?.distillDraft ?? null } },
        doneTick: { ...s.doneTick, [sceneId]: (s.doneTick[sceneId] ?? 0) + 1 },
      })),
    finishDistill: (sceneId, draft) =>
      patch(sceneId, { phase: null, requestId: null, streaming: '', distillDraft: draft }),
    fail: (sceneId, keepDistill) =>
      set((s) => {
        const cur = s.sessions[sceneId] ?? EMPTY
        return {
          sessions: {
            ...s.sessions,
            [sceneId]: { phase: null, requestId: null, streaming: '', distillDraft: keepDistill ? cur.distillDraft : null },
          },
        }
      }),
  }
})
