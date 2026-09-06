import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ScrollText, Sparkles, RefreshCw, Plus, Trash2, Save, ChevronUp, ChevronDown, Loader2, Wand2, AlertTriangle,
  SplitSquareVertical, SearchCheck, Download, Upload,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../ui/Dialog'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { EmptyState } from '../ui/EmptyState'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import { globalEventBus } from '../../shared/event-bus'
import {
  DIGEST_BUDGET,
  GRID_KEYS,
  SUMMARY_MAX,
  defaultModulesForGenre,
  digestChars,
  emptyGrid,
  exportSettingModulesToJson,
  newCustomKey,
  parseGrid,
  parseSettingModulesImport,
  serializeGrid,
  type GridKey,
  type SettingGrid,
  type SettingInjectMode,
  type SettingModuleData,
} from '../../services/setting-bible'
import {
  deleteSettingModule,
  importSettingModules,
  listSettingModules,
  reorderSettingModules,
  saveSettingModule,
  seedDefaultModules,
} from '../../services/setting-bible-service'

interface Draft {
  title: string
  injectMode: SettingInjectMode
  grid: SettingGrid
  summary: string
}

const draftOf = (m: SettingModuleData): Draft => ({
  title: m.title,
  injectMode: m.injectMode,
  grid: parseGrid(m.body),
  summary: m.summary,
})

const sameDraft = (a: Draft, b: Draft) =>
  a.title === b.title &&
  a.injectMode === b.injectMode &&
  a.summary === b.summary &&
  GRID_KEYS.every((k) => a.grid[k] === b.grid[k])

/** 设定纲要编辑器：左侧模块列表，右侧四格 + 注入方式 + 摘要 */
export default function SettingBibleEditor() {
  const { t } = useTranslation('editors')
  const currentProject = useProjectStore((s) => s.currentProject)
  const defaultModelId = useLLMStore((s) => s.defaultModelId)

  const [modules, setModules] = useState<SettingModuleData[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'rewrite' | 'summary' | null>(null)
  const [instruction, setInstruction] = useState('')
  const [toolBusy, setToolBusy] = useState<'split' | 'check' | null>(null)
  const [checkReport, setCheckReport] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchPicked, setBatchPicked] = useState<Set<number>>(new Set())
  const batchRunning = useWorkflowStore((s) => s.isTypeRunning('batch_generate'))

  const selected = useMemo(() => modules.find((m) => m.id === selectedId) ?? null, [modules, selectedId])
  const dirty = !!(selected && draft && !sameDraft(draft, draftOf(selected)))
  const alwaysCount = modules.filter((m) => m.injectMode === 'always').length
  const used = digestChars(modules)
  const overBudget = used > DIGEST_BUDGET

  const load = useCallback(async () => {
    setLoading(true)
    const list = await listSettingModules()
    setModules(list)
    setLoading(false)
    setSelectedId((prev) => (prev && list.some((m) => m.id === prev) ? prev : list[0]?.id ?? null))
  }, [])

  useEffect(() => { load() }, [load, currentProject?.path])

  // 批量生成 / Agent / 导入等在别处改了模块，这里跟着刷新列表
  useEffect(() => globalEventBus.on('SETTING_MODULES_CHANGED', () => { void load() }), [load])

  // 切换模块或该模块被落库（updatedAt 变了）时重置编辑副本；没保存的手改不受列表刷新影响
  const selectedId2 = selected?.id
  const selectedStamp = selected?.updatedAt
  useEffect(() => {
    setDraft(selected ? draftOf(selected) : null)
    setInstruction('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId2, selectedStamp])

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const patchGrid = (k: GridKey, v: string) => setDraft((d) => (d ? { ...d, grid: { ...d.grid, [k]: v } } : d))

  const applySaved = (saved: SettingModuleData | null) => {
    if (!saved) return
    setModules((list) => list.map((m) => (m.id === saved.id ? saved : m)))
  }

  const handleSave = async () => {
    if (!selected || !draft || saving) return
    setSaving(true)
    try {
      const saved = await saveSettingModule({
        ...selected,
        title: draft.title.trim() || selected.title,
        injectMode: draft.injectMode,
        body: serializeGrid(draft.grid),
        summary: draft.summary.trim(),
        source: 'user',
      })
      applySaved(saved)
      toast.success(t('settingBible.saved'))
    } catch (e) {
      toast.error(`${t('settingBible.messages.saveFailed')}: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    try {
      const saved = await saveSettingModule({
        key: newCustomKey(),
        title: t('settingBible.newModuleTitle'),
        sortOrder: modules.length,
        injectMode: 'retrieval',
        body: serializeGrid(emptyGrid()),
        summary: '',
        source: 'user',
        kbDocId: '',
      })
      if (saved) {
        setModules((list) => [...list, saved])
        setSelectedId(saved.id)
      }
    } catch (e) {
      toast.error(`${t('settingBible.messages.saveFailed')}: ${e}`)
    }
  }

  const handleSeed = async () => {
    if (!currentProject) return
    const list = await seedDefaultModules(currentProject.novelConfig.genre)
    setModules(list)
    setSelectedId(list[0]?.id ?? null)
    toast.success(t('settingBible.messages.seeded'))
  }

  const handleDelete = async () => {
    if (!selected) return
    const ok = await confirm(t('settingBible.deleteConfirm', { title: selected.title }), { danger: true })
    if (!ok) return
    await deleteSettingModule(selected)
    const rest = modules.filter((m) => m.id !== selected.id)
    setModules(rest)
    setSelectedId(rest[0]?.id ?? null)
    toast.success(t('settingBible.messages.deleted'))
  }

  const handleMove = async (dir: -1 | 1) => {
    if (!selected) return
    const idx = modules.findIndex((m) => m.id === selected.id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= modules.length) return
    const next = [...modules]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    const reordered = next.map((m, i) => ({ ...m, sortOrder: i }))
    setModules(reordered)
    await reorderSettingModules(reordered.map((m) => m.id))
  }

  /** 生成 / 改写 / 摘要都走同一个命令；未保存的手改先落库，免得被 AI 版本覆盖 */
  const runAI = async (mode: 'generate' | 'rewrite' | 'summary') => {
    if (!selected || busy) return
    if (!defaultModelId) {
      toast.error(t('settingBible.noModel'))
      return
    }
    setBusy(mode)
    try {
      if (dirty) await handleSave()
      const { GenerateSettingModuleCommand } = await import('../../services/workflows/commands/setting-module.command')
      const cmd = new GenerateSettingModuleCommand(selected.id, {
        mode: mode === 'summary' ? 'summary' : 'generate',
        instruction: mode === 'rewrite' ? instruction : '',
      })
      const result = await cmd.execute(dummyExec())
      applySaved(result)
      if (mode === 'rewrite') setInstruction('')
    } catch (e) {
      toast.error(`${t('settingBible.messages.generateFailed')}: ${e}`)
    } finally {
      setBusy(null)
    }
  }

  const dummyExec = () => ({
    step: { id: '', commandId: '', name: '', params: {} },
    context: { data: {}, cancelled: false },
    callbacks: {
      log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
      setProgress: () => {},
      appendText: () => {},
    },
  })

  /** 把故事架构的世界观拆进空模块；已有内容的模块不动 */
  const runSplit = async () => {
    if (toolBusy) return
    if (!defaultModelId) { toast.error(t('settingBible.noModel')); return }
    setToolBusy('split')
    try {
      const { SplitWorldbuildingCommand } = await import('../../services/workflows/commands/setting-bible-tools.command')
      const result = await new SplitWorldbuildingCommand().execute(dummyExec())
      await load()
      toast.success(t('settingBible.messages.splitDone', { filled: result.filled, created: result.created }))
    } catch (e) {
      toast.error(`${t('settingBible.messages.generateFailed')}: ${e instanceof Error ? e.message : e}`)
    } finally {
      setToolBusy(null)
    }
  }

  const handleExport = () => {
    if (!currentProject || modules.length === 0) return
    const blob = new Blob([exportSettingModulesToJson(modules)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentProject.name.replace(/[\\/:*?"<>|]/g, '_')}.vela-setting-bible.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (file: File) => {
    const parsed = parseSettingModulesImport(await file.text())
    if (!parsed) { toast.error(t('settingBible.messages.importFailed')); return }
    try {
      const count = await importSettingModules(parsed)
      await load()
      toast.success(t('settingBible.messages.importOk', { count }))
    } catch (e) {
      toast.error(`${t('settingBible.messages.saveFailed')}: ${e}`)
    }
  }

  const openBatch = () => {
    // 默认勾空模块；已有内容的默认不勾，勾了就是重生成
    setBatchPicked(new Set(modules.filter((m) => m.injectMode !== 'off' && !GRID_KEYS.some((k) => parseGrid(m.body)[k].trim())).map((m) => m.id)))
    setBatchOpen(true)
  }

  /** 批量生成走工作流：任务面板里能看进度、能取消 */
  const runBatch = async () => {
    if (!defaultModelId) { toast.error(t('settingBible.noModel')); return }
    const ids = [...batchPicked]
    if (ids.length === 0) return
    setBatchOpen(false)
    await useWorkflowStore.getState().startWorkflow({
      type: 'batch_generate',
      title: t('settingBible.batchTitle'),
      steps: [
        {
          name: t('settingBible.batchStep', { count: ids.length }),
          description: t('settingBible.batchStepDesc'),
          executor: async (step, context, callbacks) => {
            const { BatchGenerateSettingModulesCommand } = await import('../../services/workflows/commands/setting-bible-tools.command')
            const r = await new BatchGenerateSettingModulesCommand(ids).execute({ step, context, callbacks })
            return t('settingBible.messages.batchDone', { done: r.done, failed: r.failed.length })
          },
        },
      ],
      onComplete: { mode: 'silent', message: t('settingBible.batchTitle') },
    })
  }

  const runCheck = async () => {
    if (toolBusy) return
    if (!defaultModelId) { toast.error(t('settingBible.noModel')); return }
    setToolBusy('check')
    try {
      const { CrossCheckSettingsCommand } = await import('../../services/workflows/commands/setting-bible-tools.command')
      setCheckReport(await new CrossCheckSettingsCommand().execute(dummyExec()))
    } catch (e) {
      toast.error(`${t('settingBible.messages.generateFailed')}: ${e instanceof Error ? e.message : e}`)
    } finally {
      setToolBusy(null)
    }
  }

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState icon={<ScrollText size={36} />} message={t('worldBuilding.openProjectFirst')} opacity={0.4} />
      </div>
    )
  }

  const genre = currentProject.novelConfig.genre || '—'
  const defaultTitles = defaultModulesForGenre(currentProject.novelConfig.genre).map((s) => s.title).join('、')

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ScrollText size={14} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{t('settingBible.title')}</span>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('settingBible.modulesCount', { count: modules.length })} · {t('settingBible.alwaysCount', { count: alwaysCount })}
          </span>
          <span
            className="text-xs flex items-center gap-1"
            title={overBudget ? t('settingBible.overBudget') : undefined}
            style={{ color: overBudget ? 'var(--color-error, #ef4444)' : 'var(--color-text-muted)' }}
          >
            {overBudget && <AlertTriangle size={11} />}
            {t('settingBible.digestBudget', { used, budget: DIGEST_BUDGET })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={load} title={t('settingBible.refresh')}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button variant="ghost" size="icon" disabled={modules.length === 0} onClick={handleExport} title={t('settingBible.exportJson')}>
            <Download size={13} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => importInputRef.current?.click()} title={t('settingBible.importJson')}>
            <Upload size={13} />
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleImportFile(file)
            }}
          />
          <Button variant="ghost" size="sm" disabled={!!toolBusy} onClick={runSplit} title={t('settingBible.splitHint')}>
            {toolBusy === 'split' ? <Loader2 size={12} className="animate-spin" /> : <SplitSquareVertical size={12} />}
            {t('settingBible.split')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!!toolBusy || modules.length < 2} onClick={runCheck} title={t('settingBible.checkHint')}>
            {toolBusy === 'check' ? <Loader2 size={12} className="animate-spin" /> : <SearchCheck size={12} />}
            {t('settingBible.check')}
          </Button>
          <Button variant="ai" size="sm" disabled={batchRunning || modules.length === 0} onClick={openBatch} title={t('settingBible.batchHint')}>
            {batchRunning ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {batchRunning ? t('settingBible.generating') : t('settingBible.batch')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleAdd}>
            <Plus size={12} />
            {t('settingBible.addModule')}
          </Button>
        </div>
      </div>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settingBible.batchTitle')}</DialogTitle>
            <DialogDescription>{t('settingBible.batchDesc')}</DialogDescription>
          </DialogHeader>
          <div className="px-1 space-y-1.5 max-h-[50vh] overflow-y-auto">
            {modules.filter((m) => m.injectMode !== 'off').map((m) => {
              const filled = GRID_KEYS.some((k) => parseGrid(m.body)[k].trim())
              const on = batchPicked.has(m.id)
              return (
                <label key={m.id} className="flex items-center gap-2 text-xs cursor-pointer select-none py-0.5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setBatchPicked((prev) => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}
                  />
                  <span className="flex-1" style={{ color: 'var(--color-text)' }}>{m.title}</span>
                  <span
                    className="text-[0.65rem] px-1.5 py-px rounded"
                    style={{
                      color: filled ? (on ? 'var(--color-warning, #eab308)' : 'var(--color-success)') : 'var(--color-accent)',
                      border: '1px solid currentColor',
                    }}
                  >
                    {filled ? (on ? t('settingBible.batchWillOverride') : t('settingBible.batchKeep')) : t('settingBible.batchEmpty')}
                  </span>
                </label>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBatchOpen(false)}>{t('cancel', { ns: 'common' })}</Button>
            <Button variant="ai" size="sm" disabled={batchPicked.size === 0} onClick={runBatch}>
              <Sparkles size={12} />
              {t('settingBible.batchConfirm', { count: batchPicked.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={checkReport !== null} onOpenChange={(open) => { if (!open) setCheckReport(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('settingBible.checkReportTitle')}</DialogTitle>
            <DialogDescription>{t('settingBible.checkReportDesc')}</DialogDescription>
          </DialogHeader>
          <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-[60vh] overflow-y-auto" style={{ color: 'var(--color-text)' }}>
            {checkReport}
          </pre>
          <DialogFooter>
            <Button size="sm" onClick={() => setCheckReport(null)}>{t('settingBible.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="px-3 py-1.5 text-[0.7rem] leading-relaxed flex-shrink-0" style={{ color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}>
        {t('settingBible.priorityNote')}
      </div>

      {modules.length === 0 && !loading ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
          <EmptyState icon={<ScrollText size={36} />} message={t('settingBible.emptyTitle')} opacity={0.5} />
          <div className="text-xs text-center max-w-md" style={{ color: 'var(--color-text-muted)' }}>{t('settingBible.emptyDesc')}</div>
          <div className="flex items-center gap-2">
            <Button variant="ai" size="default" onClick={handleSeed} title={t('settingBible.seedDefaultsHint', { titles: defaultTitles })}>
              <Sparkles size={12} />
              {t('settingBible.seedDefaults', { genre })}
            </Button>
            <Button variant="outline" size="default" disabled={!!toolBusy} onClick={async () => { await handleSeed(); await runSplit() }} title={t('settingBible.splitHint')}>
              {toolBusy === 'split' ? <Loader2 size={12} className="animate-spin" /> : <SplitSquareVertical size={12} />}
              {t('settingBible.seedAndSplit')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* 左：模块列表 */}
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r" style={{ borderColor: 'var(--color-border)' }}>
            {modules.map((m) => {
              const active = m.id === selectedId
              return (
                <div
                  key={m.id}
                  className="px-3 py-2 cursor-pointer flex items-center gap-2"
                  style={{
                    backgroundColor: active ? 'var(--color-hover)' : 'transparent',
                    borderLeft: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                  }}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="text-xs flex-1 truncate" style={{ color: 'var(--color-text)' }}>{m.title || t('settingBible.newModuleTitle')}</span>
                  <ModeBadge mode={m.injectMode} />
                </div>
              )
            })}
          </div>

          {/* 右：编辑区 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
            {!selected || !draft ? (
              <EmptyState icon={<ScrollText size={28} />} message={t('settingBible.selectModule')} opacity={0.4} />
            ) : (
              <>
                {/* 标题 / 注入方式 / 操作 */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[12rem]">
                    <label className="text-[0.7rem] block mb-1" style={{ color: 'var(--color-text-muted)' }}>{t('settingBible.moduleTitle')}</label>
                    <Input value={draft.title} onChange={(e) => patchDraft({ title: e.target.value })} />
                  </div>
                  <div className="w-36">
                    <label className="text-[0.7rem] block mb-1" style={{ color: 'var(--color-text-muted)' }}>{t('settingBible.injectMode')}</label>
                    <NativeSelect
                      value={draft.injectMode}
                      onChange={(e) => patchDraft({ injectMode: e.target.value as SettingInjectMode })}
                      title={t(`settingBible.mode${cap(draft.injectMode)}Desc`)}
                    >
                      <option value="always">{t('settingBible.modeAlways')}</option>
                      <option value="retrieval">{t('settingBible.modeRetrieval')}</option>
                      <option value="off">{t('settingBible.modeOff')}</option>
                    </NativeSelect>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => handleMove(-1)} title={t('settingBible.moveUp')}><ChevronUp size={13} /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleMove(1)} title={t('settingBible.moveDown')}><ChevronDown size={13} /></Button>
                    <Button variant="ghost" size="icon" onClick={handleDelete} title={t('settingBible.delete')}><Trash2 size={13} /></Button>
                  </div>
                </div>
                <div className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                  {t(`settingBible.mode${cap(draft.injectMode)}Desc`)} · {selected.source === 'ai' ? t('settingBible.sourceAi') : t('settingBible.sourceUser')}
                </div>

                {/* AI 操作 */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ai" size="sm" disabled={!!busy} onClick={() => runAI('generate')}>
                    {busy === 'generate' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {busy === 'generate' ? t('settingBible.generating') : (GRID_KEYS.some((k) => draft.grid[k].trim()) ? t('settingBible.regenerate') : t('settingBible.generate'))}
                  </Button>
                  <div className="flex-1 min-w-[16rem] flex items-center gap-1.5">
                    <Input
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder={t('settingBible.rewritePlaceholder')}
                      onKeyDown={(e) => { if (e.key === 'Enter' && instruction.trim()) runAI('rewrite') }}
                    />
                    <Button variant="outline" size="sm" disabled={!!busy || !instruction.trim()} onClick={() => runAI('rewrite')}>
                      {busy === 'rewrite' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                      {t('settingBible.rewrite')}
                    </Button>
                  </div>
                </div>

                {/* 四格 */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {GRID_KEYS.map((k) => (
                    <div key={k}>
                      <div className="flex items-baseline justify-between mb-1">
                        <label className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>{t(`settingBible.grid.${k}`)}</label>
                        <span className="text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>{t(`settingBible.gridHint.${k}`)}</span>
                      </div>
                      <Textarea
                        rows={6}
                        value={draft.grid[k]}
                        onChange={(e) => patchGrid(k, e.target.value)}
                        className="text-xs leading-relaxed"
                      />
                    </div>
                  ))}
                </div>

                {/* 常驻摘要 */}
                {draft.injectMode === 'always' && (
                  <div>
                    <div className="flex items-baseline justify-between mb-1">
                      <label className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>{t('settingBible.summary')}</label>
                      <span className="text-[0.65rem]" style={{ color: draft.summary.length > SUMMARY_MAX ? 'var(--color-error, #ef4444)' : 'var(--color-text-muted)' }}>
                        {draft.summary.length}/{SUMMARY_MAX} · {t('settingBible.summaryHint', { max: SUMMARY_MAX })}
                      </span>
                    </div>
                    <div className="flex gap-2 items-start">
                      <Textarea
                        rows={3}
                        value={draft.summary}
                        onChange={(e) => patchDraft({ summary: e.target.value })}
                        className="text-xs leading-relaxed flex-1"
                      />
                      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => runAI('summary')} title={t('settingBible.summarize')}>
                        {busy === 'summary' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {t('settingBible.summarize')}
                      </Button>
                    </div>
                  </div>
                )}

                {/* 保存 */}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <span className="text-[0.7rem]" style={{ color: dirty ? 'var(--color-warning, #eab308)' : 'var(--color-text-muted)' }}>
                    {dirty ? t('settingBible.unsaved') : t('settingBible.saved')}
                  </span>
                  <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {t('settingBible.save')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function ModeBadge({ mode }: { mode: SettingInjectMode }) {
  const { t } = useTranslation('editors')
  const color =
    mode === 'always' ? 'var(--color-success)' : mode === 'retrieval' ? 'var(--color-accent)' : 'var(--color-text-muted)'
  return (
    <span
      className="text-[0.6rem] px-1 py-px rounded flex-shrink-0"
      style={{ color, border: `1px solid ${color}`, opacity: mode === 'off' ? 0.6 : 1 }}
    >
      {t(`settingBible.mode${cap(mode)}`)}
    </span>
  )
}
