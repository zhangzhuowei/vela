import { useState, useEffect } from 'react'
import { Save, Trash2, Users, Network, Image as ImageIcon, Loader2, RefreshCw, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import { ipc } from '../../services/ipc-client'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import {
  useCharacterStore,
  EMPTY_STATE,
  ROLE_LABELS,
  type CharacterCurrentState,
} from '../../stores/character-store'
import RelationshipGraph from './RelationshipGraph'
import { EmptyState as BaseEmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'

/**
 * 角色卡编辑器 — 纯编辑区域（角色列表已移至侧栏）
 * 从 character-store 读取选中角色，仅渲染编辑表单。
 */
export default function CharacterEditor() {
  const { t } = useTranslation('editors')
  const currentProject = useProjectStore(s => s.currentProject)
  const addLog = useWorkflowStore(s => s.addLog)
  const characters = useCharacterStore(s => s.characters)
  const selectedName = useCharacterStore(s => s.selectedName)
  const saving = useCharacterStore(s => s.saving)
  const updateField = useCharacterStore(s => s.updateField)
  const deleteCharacter = useCharacterStore(s => s.deleteCharacter)
  const saveAll = useCharacterStore(s => s.saveAll)
  const [viewMode, setViewMode] = useState<'edit' | 'state' | 'graph'>('edit')
  // 人设图 dataUrl 缓存（按角色名）+ 生成中状态
  const [portraits, setPortraits] = useState<Record<string, string>>({})
  const [generatingPortrait, setGeneratingPortrait] = useState(false)
  const [uploadingPortrait, setUploadingPortrait] = useState(false)

  // 数据由 ProjectService 统一加载，组件只消费 store 数据

  const selectedCard = characters.find((c) => c.name === selectedName) || null

  // 选中角色变化时，若已有人设图路径则读取为 dataUrl 显示
  useEffect(() => {
    const name = selectedCard?.name
    const p = selectedCard?.portraitPath
    if (!name || !p) return
    let cancelled = false
    ipc.invoke('image:read', p).then((r) => {
      if (!cancelled && r.success && r.dataUrl) {
        setPortraits((prev) => ({ ...prev, [name]: r.dataUrl! }))
      }
    }).catch(() => { })
    return () => { cancelled = true }
  }, [selectedCard?.name, selectedCard?.portraitPath])

  /** 生成角色人设图：拼提示词 →（可选）文本模型润色 → 文生图 → 存盘 + 显示 */
  const handleGeneratePortrait = async () => {
    if (!selectedCard || !currentProject || generatingPortrait) return
    const llm = useLLMStore.getState()
    const imgModel = llm.models.find((m) => m.id === llm.defaultImageModelId)
      ?? llm.models.find((m) => m.purposes?.includes('image'))
    if (!imgModel) {
      toast.warning('请先在 设置 → 文生图模型 里配置一个模型')
      return
    }

    setGeneratingPortrait(true)
    try {
      const c = selectedCard
      const genre = currentProject.novelConfig?.genre || ''
      const artStyle = (currentProject.novelConfig?.artStyle || '').trim()
      const negativePrompt = (currentProject.novelConfig?.negativePrompt || '').trim()
      const charPrompt = (c.imagePrompt || '').trim()
      const base = [
        c.gender && `性别：${c.gender}`,
        c.age && `年龄：${c.age}`,
        c.appearance && `外貌：${c.appearance}`,
        charPrompt && `外观补充（最高优先级，必须严格体现）：${charPrompt}`,
        c.personality && `性格气质：${c.personality}`,
        genre && `作品类型：${genre}`,
      ].filter(Boolean).join('；')

      // 兜底提示词
      let prompt = `${c.name}，${base}。单人半身立绘，高质量角色人设图，简洁背景，精致五官，电影感光影。`
      // 用默认文本模型把中文设定润色成更规范的画图提示词（best-effort）
      try {
        if (llm.defaultModelId) {
          const r = await llm.generate([
            { role: 'system', content: '你是文生图提示词工程师。把人物设定浓缩成一段用于文生图的中文提示词，聚焦外貌/服饰/气质/构图/画面质感，80-140字，单人半身立绘，只输出提示词本身，不要任何解释。若设定中含「外观补充」，其中的特征必须全部保留，不得省略或改写。' },
            { role: 'user', content: `${c.name}\n${base}` },
          ])
          if (r.success && r.content.trim()) prompt = r.content.trim()
        }
      } catch { /* 用兜底 prompt */ }

      // 角色专属提示词与全局画风在润色之后强制追加，避免被文本模型的改写吞掉
      if (charPrompt) prompt += `。角色关键特征：${charPrompt}`
      if (artStyle) prompt += `。整体画风：${artStyle}`

      addLog('info', `🎨 正在生成「${c.name}」的人设图...`)
      const res = await ipc.invoke('image:generate', {
        model: imgModel,
        prompt,
        negativePrompt,
        projectPath: currentProject.path,
        size: '1024x1024',
        filenameHint: c.name || 'character',
      })
      if (res.success && res.dataUrl && res.path) {
        setPortraits((prev) => ({ ...prev, [c.name]: res.dataUrl! }))
        updateField(c.name, 'portraitPath', res.path)
        await ipc.invoke('db:character-update-portrait', c.name, res.path)
        addLog('info', `✅ 「${c.name}」人设图已生成`)
      } else {
        toast.error(`人设图生成失败：${res.error ?? '未知错误'}`)
        addLog('error', `人设图生成失败：${res.error ?? ''}`)
      }
    } catch (e) {
      toast.error(`人设图生成失败：${e}`)
    } finally {
      setGeneratingPortrait(false)
    }
  }

  /** 手动上传人设图：选本地图片 → 复制进项目 → 更新角色卡 */
  const handleUploadPortrait = async () => {
    if (!selectedCard || !currentProject || uploadingPortrait) return
    setUploadingPortrait(true)
    try {
      const c = selectedCard
      const res = await ipc.invoke('image:import', {
        projectPath: currentProject.path,
        filenameHint: c.name || 'character',
      })
      if (res.canceled) return
      if (res.success && res.dataUrl && res.path) {
        setPortraits((prev) => ({ ...prev, [c.name]: res.dataUrl! }))
        updateField(c.name, 'portraitPath', res.path)
        await ipc.invoke('db:character-update-portrait', c.name, res.path)
        addLog('info', `✅ 「${c.name}」人设图已上传`)
      } else {
        toast.error(`人设图上传失败：${res.error ?? '未知错误'}`)
      }
    } catch (e) {
      toast.error(`人设图上传失败：${e}`)
    } finally {
      setUploadingPortrait(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedCard || !currentProject) return
    const ok = await confirm(
      t('characterEditor.deleteConfirmText', { name: selectedCard.name || t('chapterCard.unnamed') }),
      { title: t('characterEditor.deleteConfirmTitle'), confirmText: t('characterEditor.delete'), danger: true }
    )
    if (!ok) return
    await deleteCharacter(selectedCard.name, currentProject.path)
  }

  const handleSave = async () => {
    if (!currentProject) return
    await saveAll(currentProject.path)
    addLog('info', t('characterEditor.saveSuccess', { count: characters.length }))
  }

  // ===== 渲染 =====

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* 统一顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
            {viewMode === 'graph'
              ? t('characterEditor.characterGraph')
              : selectedCard
                ? `${selectedCard.name || t('characterEditor.newCharacter')} ${viewMode === 'state' ? `— ${t('characterEditor.currentState')}` : `— ${t('characterEditor.editProfile')}`}`
                : t('characterEditor.characterProfile')}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {viewMode === 'graph' ? (
            <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title={t('characterEditor.backToEdit')}>
              <Users size={12} /> {t('characterEditor.editMode')}
            </Button>
          ) : selectedCard ? (
            <>
              {viewMode === 'state' ? (
                <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title={t('characterEditor.backToBasic')}>
                  <Users size={12} /> {t('characterEditor.basicSettings')}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setViewMode('state')} title={t('characterEditor.viewCurrentStatus')}>
                  {t('characterEditor.currentStatus')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title={t('characterEditor.viewRelationshipMap')}>
                <Network size={12} /> {t('characterEditor.relationshipGraph')}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 size={12} /> {t('characterEditor.delete')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
                <Save size={12} /> {saving ? t('characterEditor.saving') : t('characterEditor.save')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title={t('characterEditor.viewRelationshipMap')}>
              <Network size={12} /> {t('characterEditor.relationshipGraph')}
            </Button>
          )}
        </div>
      </div>

      {/* 主体区 */}
      <div className="flex-1 overflow-y-auto relative">
        {viewMode === 'graph' ? (
          <RelationshipGraph characters={characters} />
        ) : !selectedCard ? (
          <BaseEmptyState
            icon={<Users size={36} />}
            message={currentProject ? t('characterEditor.selectOrCreate') : t('characterEditor.openProjectFirst')}
            opacity={currentProject ? 0.3 : 0.4}
          />
        ) : viewMode === 'state' ? (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[var(--color-text)]">
                {t('characterEditor.currentStatusProfile')}
              </h3>
              <span className="text-xs text-[var(--color-text-secondary)]">
                {t('characterEditor.lastUpdated', { chapter: selectedCard.currentState?.updatedAtChapter ?? 0 })}
              </span>
            </div>
            <div className="space-y-3">
              {([
                ['location', t('characterEditor.stateFields.location')],
                ['powerLevel', t('characterEditor.stateFields.powerLevel')],
                ['physicalState', t('characterEditor.stateFields.physicalState')],
                ['mentalState', t('characterEditor.stateFields.mentalState')],
                ['keyItems', t('characterEditor.stateFields.keyItems')],
                ['recentEvents', t('characterEditor.stateFields.recentEvents')],
                ['knownInfo', '已知信息（TA 掌握的关键情报/秘密，用于防穿帮）'],
              ] as const).map(([field, label]) => (
                <div key={field}>
                  <Label>{label}</Label>
                  <Textarea
                    value={selectedCard.currentState?.[field]?.toString() ?? ''}
                    onChange={(e) => {
                      const cs: CharacterCurrentState = {
                        ...(selectedCard.currentState ?? EMPTY_STATE),
                        [field]: e.target.value,
                      }
                      updateField(selectedCard.name, 'currentState', cs)
                    }}
                    rows={2}
                    placeholder={`${label}...`}
                  />
                </div>
              ))}
            </div>
            {!selectedCard.currentState && (
              <div className="mt-4 p-3 rounded-lg bg-[var(--color-hover)] text-xs text-[var(--color-text-secondary)]">
                {t('characterEditor.stateHint')}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="space-y-3">
              {/* 人设图 */}
              <div className="flex items-start gap-4">
                <div
                  className="w-28 h-36 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0"
                  style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}
                >
                  {portraits[selectedCard.name]
                    ? <img src={portraits[selectedCard.name]} alt={selectedCard.name} className="w-full h-full object-cover" />
                    : <ImageIcon size={28} style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <Label>人设图</Label>
                  <p className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    可用文生图模型根据「外貌 / 性格」生成，也可直接上传本地图片（如官方设定图），上传的形象完全准确且跨章节一致。
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleGeneratePortrait} disabled={generatingPortrait || uploadingPortrait}>
                      {generatingPortrait
                        ? <Loader2 size={12} className="animate-spin" />
                        : (portraits[selectedCard.name] ? <RefreshCw size={12} /> : <ImageIcon size={12} />)}
                      {generatingPortrait ? '生成中...' : (portraits[selectedCard.name] ? '重新生成' : '生成人设图')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleUploadPortrait} disabled={generatingPortrait || uploadingPortrait} title="选择本地图片作为人设图">
                      {uploadingPortrait ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                      {uploadingPortrait ? '上传中...' : '上传图片'}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div><Label>{t('characterEditor.fields.name')}</Label><Input value={selectedCard.name} onChange={(e) => updateField(selectedCard.name, 'name', e.target.value)} /></div>
                <div><Label>{t('characterEditor.fields.gender')}</Label><Input value={selectedCard.gender} onChange={(e) => updateField(selectedCard.name, 'gender', e.target.value)} /></div>
                <div><Label>{t('characterEditor.fields.age')}</Label><Input value={selectedCard.age} onChange={(e) => updateField(selectedCard.name, 'age', e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t('characterEditor.fields.role')}</Label>
                  <NativeSelect value={selectedCard.role} onChange={(e) => updateField(selectedCard.name, 'role', e.target.value as typeof selectedCard.role)}>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div><Label>{t('characterEditor.fields.appearance')}</Label><Textarea value={selectedCard.appearance} onChange={(e) => updateField(selectedCard.name, 'appearance', e.target.value)} rows={3} placeholder={t('characterEditor.fields.appearancePlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.personality')}</Label><Textarea value={selectedCard.personality} onChange={(e) => updateField(selectedCard.name, 'personality', e.target.value)} rows={3} placeholder={t('characterEditor.fields.personalityPlaceholder')} /></div>
              <div><Label>说话风格 / 口癖 <span className="text-[0.7rem] opacity-50">（写稿时注入，让该角色对白有辨识度）</span></Label><Textarea value={selectedCard.speechStyle || ''} onChange={(e) => updateField(selectedCard.name, 'speechStyle', e.target.value)} rows={2} placeholder="如：说话简短爱用反问；口头禅『行吧』；紧张时结巴；文绉绉爱掉书袋..." /></div>
              <div><Label>生图提示词 <span className="text-[0.7rem] opacity-50">（仅用于人设图，强制生效，用来纠正 AI 画错的形象特征）</span></Label><Textarea value={selectedCard.imagePrompt || ''} onChange={(e) => updateField(selectedCard.name, 'imagePrompt', e.target.value)} rows={2} placeholder="如：四足小马而非人类；额上有独角、背生双翼；毛色纯白，鬃毛为流动的极光色..." /></div>
              <div><Label>{t('characterEditor.fields.background')}</Label><Textarea value={selectedCard.background} onChange={(e) => updateField(selectedCard.name, 'background', e.target.value)} rows={4} placeholder={t('characterEditor.fields.backgroundPlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.abilities')}</Label><Textarea value={selectedCard.abilities} onChange={(e) => updateField(selectedCard.name, 'abilities', e.target.value)} rows={3} placeholder={t('characterEditor.fields.abilitiesPlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.motivation')}</Label><Textarea value={selectedCard.motivation} onChange={(e) => updateField(selectedCard.name, 'motivation', e.target.value)} rows={2} placeholder={t('characterEditor.fields.motivationPlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.relationships')}</Label><Textarea value={selectedCard.relationships} onChange={(e) => updateField(selectedCard.name, 'relationships', e.target.value)} rows={3} placeholder={t('characterEditor.fields.relationshipsPlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.arc')}</Label><Textarea value={selectedCard.arc} onChange={(e) => updateField(selectedCard.name, 'arc', e.target.value)} rows={3} placeholder={t('characterEditor.fields.arcPlaceholder')} /></div>
              <div><Label>{t('characterEditor.fields.notes')}</Label><Textarea value={selectedCard.notes} onChange={(e) => updateField(selectedCard.name, 'notes', e.target.value)} rows={2} placeholder={t('characterEditor.fields.notesPlaceholder')} /></div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
