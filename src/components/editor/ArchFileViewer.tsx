import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Save, RefreshCw, Sparkles, Loader2, AlertTriangle, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { renderIcon } from '../panels/sidebar/SidebarShared'

import { useEditorStore } from '../../stores/editor-store'
import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { ipc } from '../../services/ipc-client'
import { readCoreContent } from '../../services/vela-protocol'
import { persistEditorContent } from '../../services/editor-persistence'
import { registerEditorFlusher } from '../../services/editor-autosave'
import CodeMirrorEditor from './CodeMirrorEditor'
import { useProjectStore } from '../../stores/project-store'
import { useCharacterStore } from '../../stores/character-store'
import { runArchCharacterExtract, createArchitectureWorkflow } from '../../services/workflows/architecture-workflow'
import { useWorkflowStore } from '../../stores/workflow-store'
import { globalEventBus } from '../../shared/event-bus'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

/** 从文件路径推断出 ArchStepKey */
function detectStepKey(filePath: string): ArchStepKey | null {
  if (filePath.endsWith('premise.md')) return 'premise'
  if (filePath.endsWith('characters.md')) return 'characters'
  if (filePath.endsWith('worldbuilding.md')) return 'worldbuilding'
  if (filePath.endsWith('synopsis.md')) return 'synopsis'
  return null
}

interface Props {
  filePath: string
  content: string
}

/**
 * 架构文件编辑器（Markdown 文件 WYSIWYG 编辑）
 * - 使用 CodeMirrorEditor（document 模式）+ hideStatusBar，底部栏信息整合到本组件工具栏
 * - 脏状态通过比较内容字符串判断，不依赖 onChange 时机
 */
export default function ArchFileViewer({ filePath, content: initialContent }: Props) {
  const { t } = useTranslation('editors')
  const stepKey = detectStepKey(filePath)

  const ARCH_META: Record<ArchStepKey, { iconName: string; label: string; desc: string }> = useMemo(() => ({
    premise: { iconName: 'target', label: t('archFile.premise'), desc: t('archFile.premiseDesc') },
    characters: { iconName: 'users', label: t('archFile.characterMap'), desc: t('archFile.characterMapDesc') },
    worldbuilding: { iconName: 'globe', label: t('archFile.worldbuilding'), desc: t('archFile.worldbuildingDesc') },
    synopsis: { iconName: 'map', label: t('archFile.synopsis'), desc: t('archFile.synopsisDesc') },
  }), [t])
  const meta = stepKey ? ARCH_META[stepKey] : null

  // 磁盘上的内容（已保存的基准）
  const savedContentRef = useRef(initialContent)
  // 编辑器当前内容（用 ref 而非 state，避免每次键入都重渲染导致光标跳末尾）
  const currentContentRef = useRef(initialContent)
  // 传给 CodeMirrorEditor 的初始内容（只有『外部重载』时才更新，不随用户键入变化）
  const [editorContent, setEditorContent] = useState(initialContent)

  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [checkingArch, setCheckingArch] = useState(false)
  const [fullArchStatus, setFullArchStatus] = useState<Record<string, boolean>>({})
  const [extracting, setExtracting] = useState(false)

  const characterCount = useCharacterStore(s => s.characters.length)
  const isArchRunning = useWorkflowStore(s => s.isTypeRunning('architecture_generation'))

  // 中文字数（由 CodeMirrorEditor 回调更新）
  const [charCount, setCharCount] = useState(0)

  // 脚状态（独立 state，不跟着 content 走）
  const [isDirty, setIsDirty] = useState(false)

  // 外部内容更新时的热重载（拦截 store.syncTabContent 带来的 props.content 更新）
  useEffect(() => {
    if (initialContent !== savedContentRef.current && initialContent !== currentContentRef.current) {
      savedContentRef.current = initialContent
      currentContentRef.current = initialContent
      setEditorContent(initialContent)
      setIsDirty(false)
    }
  }, [initialContent])

  // 卸载（切 Tab）时把编辑中的内容刷回 store：键入路径不再逐键写入，
  // 切走再切回来仍能看到未保存的编辑
  useEffect(() => {
    return () => {
      const tab = useEditorStore.getState().tabs.find(t => t.id === filePath)
      if (tab && currentContentRef.current !== tab.content) {
        useEditorStore.getState().syncTabContent(filePath, currentContentRef.current)
      }
    }
  }, [filePath])


  // 内容变化回调：更新 ref，不触发重渲染，避免 content prop 回传导致光标跳末尾。
  // 只同步 dirty 标志、不逐键写 content（那会让订阅 tabs 的 EditorArea 按键级重渲染），
  // 内容在保存/卸载时统一刷回 store
  const handleChange = useCallback((md: string) => {
    currentContentRef.current = md
    const dirty = md !== savedContentRef.current
    setIsDirty(dirty)
    if (dirty) {
      useEditorStore.getState().markTabDirty(filePath)
    } else {
      // 撤销回到已保存基准：清除 dirty 标志
      useEditorStore.getState().markTabSaved(filePath)
    }
  }, [filePath])

  /**
   * 保存（统一走 vela://core/ DB 路径，见 persistEditorContent）。
   * silent=true（自动保存 / 关窗刷盘）时不弹提示，失败直接抛出，由调用方统一处理。
   */
  const handleSave = useCallback(async (md: string, silent = false) => {
    setSaving(true)
    try {
      if (!filePath.startsWith('vela://core/')) {
        // DB 化后架构文件不应有物理路径；如果意外触发，按物理路径兜底写入
        console.warn('[ArchFileViewer] 非预期的物理路径保存:', filePath)
      }
      const res = await persistEditorContent(filePath, md)
      if (!res.success) {
        if (silent) throw new Error(res.error)
        toast.error(t('saveFailed', { ns: 'common', error: res.error ?? '' }))
        return
      }
      savedContentRef.current = md
      // 保存期间用户还在输入：保留未保存状态，也不回写 store
      if (currentContentRef.current === md) {
        setIsDirty(false)
        useEditorStore.getState().markTabSaved(filePath)
        // 键入路径不再逐键写 store，保存时把最终内容刷回，保证重开 Tab 看到的是新内容
        useEditorStore.getState().syncTabContent(filePath, md)
      }
    } finally {
      setSaving(false)
    }
  }, [filePath, t])

  // 自动保存 / 关窗刷盘入口
  useEffect(() => registerEditorFlusher(filePath, async () => {
    if (currentContentRef.current === savedContentRef.current) return
    await handleSave(currentContentRef.current, true)
  }), [filePath, handleSave])

  /** 从 DB 重新加载（AI 生成后刷新用） */
  const handleReload = useCallback(async () => {
    setLoading(true)
    let newContent = ''
    if (filePath.startsWith('vela://core/')) {
      newContent = await readCoreContent(filePath)
    } else {
      // DB 化后架构文件不应有物理路径
      console.warn('[ArchFileViewer] 非预期的物理路径刷新:', filePath)
      const res = await ipc.invoke('fs:read-file', filePath)
      if (res.success) newContent = res.content
    }
    savedContentRef.current = newContent
    currentContentRef.current = newContent
    setEditorContent(newContent)
    setIsDirty(false)
    useEditorStore.getState().markTabSaved(filePath)
    useEditorStore.getState().syncTabContent(filePath, newContent)
    setLoading(false)
  }, [filePath])

  // 监听架构生成完成事件，自动刷新当前页面
  useEffect(() => {
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (payload.type === 'architecture_generation') {
        handleReload()
      }
    })
  }, [handleReload])

  /** 确认后启动架构生成工作流 */
  const handleConfirm = async (selectedSteps: ArchStepKey[], stepGuidance: Record<string, string>) => {
    useWorkflowStore.getState().startWorkflow(createArchitectureWorkflow({ selectedSteps, stepGuidance }))
  }

  const handleOpenDialog = async () => {
    if (!stepKey) return
    setCheckingArch(true)
    const core = await ipc.invoke('db:project-core-get')
    const status: Record<string, boolean> = {
      premise: !!core?.premise && core.premise.length > 50 && !core.premise.includes('待生成'),
      characters: !!core?.charactersArch && core.charactersArch.length > 50 && !core.charactersArch.includes('待生成'),
      worldbuilding: !!core?.worldbuilding && core.worldbuilding.length > 50 && !core.worldbuilding.includes('待生成'),
      synopsis: !!core?.synopsis && core.synopsis.length > 50 && !core.synopsis.includes('待生成'),
    }

    // 对于当前文件，如果编辑器内已修改但未保存，也暂时以前面的基准为准即可
    const EditorContentLen = currentContentRef.current.length;
    if (EditorContentLen > 50 && !currentContentRef.current.includes('待生成')) {
      status[stepKey] = true
    }
    setFullArchStatus(status)
    setCheckingArch(false)
    setShowDialog(true)
  }

  const generated = initialContent.length > 50 && !initialContent.includes('待生成')

  const handleExtractCharacters = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || extracting) return
    setExtracting(true)
    try {
      const core = await ipc.invoke('db:project-core-get')
      const charArch = core?.charactersArch ?? ''
      if (charArch.length < 50) {
        setExtracting(false)
        return
      }
      runArchCharacterExtract(project.path, charArch, project.novelConfig.genre)

      // 通过 EventBus 监听提取完成事件
      const unsub1 = globalEventBus.on('ARCH_POSTPROCESS_UPDATED', () => {
        setExtracting(false)
        unsub1()
        unsub2()
      })
      const unsub2 = globalEventBus.on('CHARACTER_EXTRACT_FAILED', () => {
        setExtracting(false)
        unsub1()
        unsub2()
      })

    } catch (e) {
      console.error('角色卡提取失败', e)
      setExtracting(false)
    }
  }, [extracting])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 工具栏（背景与编辑区一致，内嵌在内容区中而非独立标题栏） */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        {/* 左侧：Emoji + 标题 + 描述 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>{meta ? renderIcon(meta.iconName, 14) : <FileText size={14} />}</span>
          <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
            {meta?.label ?? t('archFile.architectureDoc')}
          </span>
          {meta && (
            <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--color-text-muted)' }}>
              — {meta.desc}
            </span>
          )}
        </div>

        {/* 右侧：字数 + 状态 + 操作按钮 */}
        <div className="flex items-center gap-2 flex-shrink-0">

          {/* 字数 */}
          {charCount > 0 && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {charCount.toLocaleString()} {t('archFile.characters')}
            </span>
          )}

          {/* 保存状态 */}
          {saving && (
            <span className="text-xs" style={{ color: 'var(--color-accent)' }}>{t('archFile.saving')}</span>
          )}
          {isDirty && !saving && (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--color-warning)' }} title={t('archFile.hasUnsavedChanges')} />
          )}

          {/* 刷新按钮 */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleReload}
            title={t('archFile.reloadTooltip')}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>

          {/* 保存按钮（有修改时才显示） */}
          {isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSave(currentContentRef.current)}
              disabled={saving}
              title={t('archFile.saveTooltip')}
            >
              <Save size={12} />
              {t('archFile.save')}
            </Button>
          )}

          {/* 角色卡提取按钮（仅角色图谱页面显式且为空时、且不在架构生成中时才显示） */}
          {stepKey === 'characters' && generated && characterCount === 0 && !isArchRunning && (
            <Button
              size="sm"
              disabled={extracting}
              onClick={handleExtractCharacters}
              className="gap-1.5 bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-sm hover:from-red-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
              title={t('archFile.rolesEmptyTooltip')}
            >
              {extracting
                ? <RefreshCw size={12} className="animate-spin opacity-90" />
                : <AlertTriangle size={12} className="opacity-90" />
              }
              {extracting ? t('archFile.extractingRoles') : t('archFile.extractRoles')}
            </Button>
          )}

          {/* AI 生成按钮 */}
          {stepKey && (
            <Button
              variant="ai"
              size="sm"
              onClick={handleOpenDialog}
              disabled={checkingArch}
              title={t('archFile.aiGenerateTooltip', { action: generated ? t('archFile.aiRegenerate') : t('archFile.aiGenerate'), label: meta?.label })}
            >
              {checkingArch ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {generated ? t('archFile.aiRegenerate') : t('archFile.aiGenerate')}
            </Button>
          )}
        </div>
      </div>

      {/* CodeMirrorEditor document 模式，隐藏底部栏（信息已整合到上方工具栏） */}
      <div className="flex-1 overflow-hidden">
        <CodeMirrorEditor
          mode="document"
          content={editorContent}
          filePath={filePath}
          onChange={handleChange}
          onSave={handleSave}
          onCharCountChange={setCharCount}
          hideStatusBar
          placeholder={t('archFile.notGeneratedPlaceholder')}
        />
      </div>

      {/* AI 生成确认弹窗 */}
      {stepKey && (
        <ArchitectureConfirmDialog
          isOpen={showDialog}
          onClose={() => setShowDialog(false)}
          archStatus={fullArchStatus}
          initialSelectedSteps={[stepKey]}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  )
}
