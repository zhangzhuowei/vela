import { useState, useEffect } from 'react'
import { Save, Trash2, Users, Network, Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react'
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
      const base = [
        c.gender && `性别：${c.gender}`,
        c.age && `年龄：${c.age}`,
        c.appearance && `外貌：${c.appearance}`,
        c.personality && `性格气质：${c.personality}`,
        genre && `作品类型：${genre}`,
      ].filter(Boolean).join('；')

      // 兜底提示词
      let prompt = `${c.name}，${base}。单人半身立绘，高质量角色人设图，简洁背景，精致五官，电影感光影。`
      // 用默认文本模型把中文设定润色成更规范的画图提示词（best-effort）
      try {
        if (llm.defaultModelId) {
          const r = await llm.generate([
            { role: 'system', content: '你是文生图提示词工程师。把人物设定浓缩成一段用于文生图的中文提示词，聚焦外貌/服饰/气质/构图/画面质感，80-140字，单人半身立绘，只输出提示词本身，不要任何解释。' },
            { role: 'user', content: `${c.name}\n${base}` },
          ])
          if (r.success && r.content.trim()) prompt = r.content.trim()
        }
      } catch { /* 用兜底 prompt */ }

      addLog('info', `🎨 正在生成「${c.name}」的人设图...`)
      const res = await ipc.invoke('image:generate', {
        model: imgModel,
        prompt,
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

  const handleDelete = async () => {
    if (!selectedCard || !currentProject) return
    const ok = await confirm(
      `确定要删除角色「${selectedCard.name || '未命名'}」吗？此操作不可撤销。`,
      { title: '删除角色', confirmText: '删除', danger: true }
    )
    if (!ok) return
    await deleteCharacter(selectedCard.name, currentProject.path)
  }

  const handleSave = async () => {
    if (!currentProject) return
    await saveAll(currentProject.path)
    addLog('info', `✅ 已保存 ${characters.length} 个角色卡`)
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
              ? '角色图谱' 
              : selectedCard 
                ? `${selectedCard.name || '新角色'} ${viewMode === 'state' ? '— 当前状态' : '— 编辑档案'}`
                : '角色档案'}
          </span>
        </div>
        
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {viewMode === 'graph' ? (
            <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title="返回编辑">
              <Users size={12} /> 编辑模式
            </Button>
          ) : selectedCard ? (
            <>
              {viewMode === 'state' ? (
                <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title="返回基础设定">
                  <Users size={12} /> 基础设定
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setViewMode('state')} title="查看当前进展/状态">
                  📋 当前状态
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title="查看全员关系网">
                <Network size={12} /> 关系图谱
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 size={12} /> 删除
              </Button>
              <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
                <Save size={12} /> {saving ? '保存中...' : '保存'}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title="查看全员关系网">
              <Network size={12} /> 关系图谱
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
            message={currentProject ? "在左侧选择或创建角色卡" : "请先打开项目"} 
            opacity={currentProject ? 0.3 : 0.4}
          />
        ) : viewMode === 'state' ? (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[var(--color-text)]">
                当前状态档案
              </h3>
              <span className="text-xs text-[var(--color-text-secondary)]">
                最后更新：第 {selectedCard.currentState?.updatedAtChapter ?? 0} 章
              </span>
            </div>
            <div className="space-y-3">
              {([
                ['location', '当前位置/阵营'],
                ['powerLevel', '修为境界/能力等级'],
                ['physicalState', '身体状态（伤势/BUFF/外貌）'],
                ['mentalState', '心理状态（愿望/恐惧/心态）'],
                ['keyItems', '关键道具/资源'],
                ['recentEvents', '最近重要事件'],
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
                当前状态档案将在章节定稿后由 AI 自动更新，也可手动填写初始状态。
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
                    根据「外貌 / 性格」用文生图模型生成。需先在 设置 → 文生图模型 配置模型。
                  </p>
                  <Button variant="outline" size="sm" onClick={handleGeneratePortrait} disabled={generatingPortrait}>
                    {generatingPortrait
                      ? <Loader2 size={12} className="animate-spin" />
                      : (portraits[selectedCard.name] ? <RefreshCw size={12} /> : <ImageIcon size={12} />)}
                    {generatingPortrait ? '生成中...' : (portraits[selectedCard.name] ? '重新生成' : '生成人设图')}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div><Label>姓名</Label><Input value={selectedCard.name} onChange={(e) => updateField(selectedCard.name, 'name', e.target.value)} /></div>
                <div><Label>性别</Label><Input value={selectedCard.gender} onChange={(e) => updateField(selectedCard.name, 'gender', e.target.value)} /></div>
                <div><Label>年龄</Label><Input value={selectedCard.age} onChange={(e) => updateField(selectedCard.name, 'age', e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>定位</Label>
                  <NativeSelect value={selectedCard.role} onChange={(e) => updateField(selectedCard.name, 'role', e.target.value as typeof selectedCard.role)}>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div><Label>外貌描写</Label><Textarea value={selectedCard.appearance} onChange={(e) => updateField(selectedCard.name, 'appearance', e.target.value)} rows={3} placeholder="输入外貌描写..." /></div>
              <div><Label>性格特征</Label><Textarea value={selectedCard.personality} onChange={(e) => updateField(selectedCard.name, 'personality', e.target.value)} rows={3} placeholder="输入性格特征..." /></div>
              <div><Label>说话风格 / 口癖 <span className="text-[0.7rem] opacity-50">（写稿时注入，让该角色对白有辨识度）</span></Label><Textarea value={selectedCard.speechStyle || ''} onChange={(e) => updateField(selectedCard.name, 'speechStyle', e.target.value)} rows={2} placeholder="如：说话简短爱用反问；口头禅『行吧』；紧张时结巴；文绉绉爱掉书袋..." /></div>
              <div><Label>背景故事</Label><Textarea value={selectedCard.background} onChange={(e) => updateField(selectedCard.name, 'background', e.target.value)} rows={4} placeholder="输入背景故事..." /></div>
              <div><Label>能力/技能</Label><Textarea value={selectedCard.abilities} onChange={(e) => updateField(selectedCard.name, 'abilities', e.target.value)} rows={3} placeholder="输入能力/技能..." /></div>
              <div><Label>核心动机</Label><Textarea value={selectedCard.motivation} onChange={(e) => updateField(selectedCard.name, 'motivation', e.target.value)} rows={2} placeholder="输入核心动机..." /></div>
              <div><Label>关系网</Label><Textarea value={selectedCard.relationships} onChange={(e) => updateField(selectedCard.name, 'relationships', e.target.value)} rows={3} placeholder="输入关系网..." /></div>
              <div><Label>成长轨迹</Label><Textarea value={selectedCard.arc} onChange={(e) => updateField(selectedCard.name, 'arc', e.target.value)} rows={3} placeholder="输入成长轨迹..." /></div>
              <div><Label>备注</Label><Textarea value={selectedCard.notes} onChange={(e) => updateField(selectedCard.name, 'notes', e.target.value)} rows={2} placeholder="输入备注..." /></div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
