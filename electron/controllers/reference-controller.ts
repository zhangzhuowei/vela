import { ipcMain } from 'electron'
import { ReferenceRepository } from '../repositories/reference-repository'
import type { RefChapterData, RefOutlineLevel, RefStageInput } from '../repositories/reference-repository'
import {
  safeValidate, validateRefWorkInput, validateRefDigestInput, validateRefLineInput,
  validateRefStageInput, validateRefOutlineInput, validateRefRevisionInput,
} from '../ipc-validation'

function ok<T>(fn: () => T): { success: boolean; data?: T; error?: string } {
  try {
    return { success: true, data: fn() }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function registerReferenceController() {
  ipcMain.handle('db:ref-work-list', async () => ReferenceRepository.listWorks())
  ipcMain.handle('db:ref-work-recover-interrupted', async () => ReferenceRepository.recoverInterruptedWorks())
  ipcMain.handle('db:ref-work-get', async (_e, id: number) => ReferenceRepository.getWork(id))
  ipcMain.handle('db:ref-work-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefWorkInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.upsertWork(v.data))
  })
  ipcMain.handle('db:ref-work-delete', async (_e, id: number) => ok(() => ReferenceRepository.deleteWork(id)))

  ipcMain.handle('db:ref-chapter-replace', async (_e, workId: number, chapters: Array<Omit<RefChapterData, 'workId'>>) =>
    ok(() => ReferenceRepository.replaceChapters(workId, chapters)))
  ipcMain.handle('db:ref-chapter-meta-list', async (_e, workId: number) => ReferenceRepository.listChapterMeta(workId))
  ipcMain.handle('db:ref-chapter-get', async (_e, workId: number, number: number) => ReferenceRepository.getChapter(workId, number))
  ipcMain.handle('db:ref-chapter-pending', async (_e, workId: number, from: number, to: number) =>
    ReferenceRepository.listPendingChapterNumbers(workId, from, to))

  ipcMain.handle('db:ref-digest-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefDigestInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.upsertDigest(v.data))
  })
  ipcMain.handle('db:ref-digest-list', async (_e, workId: number) => ReferenceRepository.listDigests(workId))

  ipcMain.handle('db:ref-line-list', async (_e, workId: number) => ReferenceRepository.listLines(workId))
  ipcMain.handle('db:ref-line-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefLineInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.upsertLine(v.data))
  })
  ipcMain.handle('db:ref-line-delete', async (_e, id: number) => ok(() => ReferenceRepository.deleteLine(id)))

  ipcMain.handle('db:ref-stage-list', async (_e, workId: number) => ReferenceRepository.listStages(workId))
  ipcMain.handle('db:ref-stage-replace-unlocked', async (_e, workId: number, raw: unknown[]) => {
    const stages: Array<Omit<RefStageInput, 'id' | 'workId'>> = []
    for (const s of raw) {
      const v = safeValidate(validateRefStageInput, { ...(s as object), workId })
      if (!v.ok) return { success: false, error: v.error }
      stages.push(v.data)
    }
    return ok(() => ReferenceRepository.replaceUnlockedStages(workId, stages))
  })
  ipcMain.handle('db:ref-stage-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefStageInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.upsertStage(v.data))
  })

  ipcMain.handle('db:ref-outline-get', async (_e, workId: number, level: RefOutlineLevel) => ReferenceRepository.getOutline(workId, level))
  ipcMain.handle('db:ref-outline-upsert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefOutlineInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.upsertOutline(v.data.workId, v.data.level, v.data.body, v.data.force))
  })
  ipcMain.handle('db:ref-outline-lock', async (_e, workId: number, level: RefOutlineLevel, locked: boolean) =>
    ok(() => ReferenceRepository.setOutlineLocked(workId, level, locked)))

  ipcMain.handle('db:ref-revision-insert', async (_e, raw: unknown) => {
    const v = safeValidate(validateRefRevisionInput, raw)
    if (!v.ok) return { success: false, error: v.error }
    return ok(() => ReferenceRepository.insertRevision(v.data))
  })
  ipcMain.handle('db:ref-revision-list', async (_e, workId: number) => ReferenceRepository.listRevisions(workId))
}
