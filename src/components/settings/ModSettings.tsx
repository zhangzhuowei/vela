/**
 * Mod 管理面板 — 设置页「Mod」分区
 *
 * Mod = 可切换的写作改装包：提示词模板覆盖 + 行文指导追加。
 * 全局存放，按当前打开的书启用，可叠加（列表内启用顺序越靠后优先级越高）。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Download, History, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import {
  collectTags,
  deleteMod,
  exportModToJson,
  filterModsByTag,
  getEnabledModIds,
  importModFromJson,
  listMods,
  loadModHistory,
  loadMods,
  removeTagEverywhere,
  renameTagEverywhere,
  rollbackMod,
  saveMod,
  type ModVersion,
  type WritingMod,
} from '../../services/mods'
import { EDITABLE_PROMPT_KEYS, getPromptName } from '../../services/prompt-templates'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import { confirm } from '../ui/Confirm'
import { randomUUID } from '../../utils/id'

export default function ModSettings() {
  const { t } = useTranslation('settings')
  const [mods, setMods] = useState<WritingMod[]>([])
  const [enabled, setEnabled] = useState<string[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [manageTags, setManageTags] = useState(false)
  const [tagEdits, setTagEdits] = useState<Record<string, string>>({})
  const importInputRef = useRef<HTMLInputElement>(null)

  const refresh = () => {
    setMods(listMods())
    setEnabled(getEnabledModIds())
  }

  useEffect(() => {
    void loadMods().then(refresh)
  }, [])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setCreateError('')
    const created = await saveMod({
      id: randomUUID(),
      name,
      description: '',
      templates: {},
      guidanceAppend: '',
    })
    setBusy(false)
    refresh()
    if (created) {
      setNewName('')
      setExpandedId(created.id)
    } else {
      setCreateError(t('mods.saveFailed'))
    }
  }

  return (
    <div className="max-w-[640px] space-y-4">
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
        {t('mods.intro')}
      </p>

      {/* 新建 */}
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('mods.namePlaceholder')}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
        />
        <Button
          variant="outline"
          size="sm"
          className="flex-shrink-0 whitespace-nowrap"
          disabled={busy || !newName.trim()}
          onClick={() => void handleCreate()}
        >
          <Plus size={13} /> {t('mods.create')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-shrink-0 whitespace-nowrap"
          disabled={busy}
          title={t('mods.importTooltip')}
          onClick={() => importInputRef.current?.click()}
        >
          <Upload size={13} /> {t('mods.import')}
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            void (async () => {
              setBusy(true)
              setCreateError('')
              const imported = await importModFromJson(await file.text())
              setBusy(false)
              refresh()
              if (imported) setExpandedId(imported.id)
              else setCreateError(t('mods.importFailed'))
            })()
          }}
        />
      </div>
      {createError && (
        <p className="text-xs" style={{ color: 'var(--color-error)' }}>
          {createError}
        </p>
      )}

      {mods.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('mods.empty')}
        </p>
      )}

      {/* 标签过滤栏 + 标签管理 */}
      {mods.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TagChip
              label={`${t('mods.allTags')} (${mods.length})`}
              active={filterTag === null}
              onClick={() => setFilterTag(null)}
            />
            {collectTags(mods).map(({ tag, count }) => (
              <TagChip
                key={tag}
                label={`${tag} (${count})`}
                active={filterTag === tag}
                onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              />
            ))}
            {collectTags(mods).length > 0 && (
              <button
                className="text-[0.68rem] underline-offset-2 hover:underline"
                style={{ color: 'var(--color-text-muted)' }}
                onClick={() => setManageTags((v) => !v)}
              >
                {t('mods.manageTags')}
              </button>
            )}
          </div>
          {manageTags && (
            <div
              className="space-y-1.5 rounded-lg p-2.5"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {collectTags(mods).map(({ tag, count }) => (
                <div key={tag} className="flex items-center gap-2 text-xs">
                  <Input
                    className="w-40"
                    value={tagEdits[tag] ?? tag}
                    onChange={(e) => setTagEdits((prev) => ({ ...prev, [tag]: e.target.value }))}
                  />
                  <span style={{ color: 'var(--color-text-muted)' }}>×{count}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !(tagEdits[tag] ?? tag).trim() || (tagEdits[tag] ?? tag) === tag}
                    onClick={() =>
                      void (async () => {
                        setBusy(true)
                        await renameTagEverywhere(tag, tagEdits[tag] ?? tag)
                        setBusy(false)
                        setTagEdits((prev) => {
                          const next = { ...prev }
                          delete next[tag]
                          return next
                        })
                        if (filterTag === tag) setFilterTag(null)
                        refresh()
                      })()
                    }
                  >
                    {t('mods.renameTag')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true)
                        await removeTagEverywhere(tag)
                        setBusy(false)
                        if (filterTag === tag) setFilterTag(null)
                        refresh()
                      })()
                    }
                  >
                    <Trash2 size={11} /> {t('mods.deleteTag')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        {filterModsByTag(mods, filterTag).map((mod) => (
          <ModItem
            key={mod.id}
            mod={mod}
            enabled={enabled.includes(mod.id)}
            enabledIndex={enabled.indexOf(mod.id)}
            isExpanded={expandedId === mod.id}
            onToggleExpand={() => setExpandedId(expandedId === mod.id ? null : mod.id)}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  )
}

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className="rounded-full px-2.5 py-1 text-[0.68rem] transition-colors"
      style={{
        border: '1px solid var(--color-border)',
        backgroundColor: active ? 'var(--color-accent)' : 'var(--color-hover)',
        color: active ? '#fff' : 'var(--color-text-secondary)',
      }}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function ModItem({
  mod,
  enabled,
  enabledIndex,
  isExpanded,
  onToggleExpand,
  onChanged,
}: {
  mod: WritingMod
  enabled: boolean
  enabledIndex: number
  isExpanded: boolean
  onToggleExpand: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(mod.name)
  const [description, setDescription] = useState(mod.description)
  const [guidance, setGuidance] = useState(mod.guidanceAppend)
  const [templates, setTemplates] = useState<Record<string, string>>(mod.templates)
  const [tags, setTags] = useState<string[]>(mod.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [addKey, setAddKey] = useState('')
  const [history, setHistory] = useState<ModVersion[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // 展开时同步最新内容
  useEffect(() => {
    if (isExpanded) {
      setName(mod.name)
      setDescription(mod.description)
      setGuidance(mod.guidanceAppend)
      setTemplates(mod.templates)
      setTags(mod.tags ?? [])
      setMsg('')
    }
  }, [isExpanded, mod])

  useEffect(() => {
    if (isExpanded && historyOpen) {
      void loadModHistory(mod.id).then(setHistory)
    }
  }, [isExpanded, historyOpen, mod.id, mod.version])

  const availableKeys = EDITABLE_PROMPT_KEYS.filter((k) => !(k in templates))

  const flash = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(''), 3000)
  }

  const handleSave = async () => {
    setBusy(true)
    const saved = await saveMod({
      ...mod,
      name: name.trim() || mod.name,
      description,
      guidanceAppend: guidance,
      templates,
      tags,
    })
    setBusy(false)
    flash(saved ? t('mods.saved', { version: saved.version }) : t('mods.saveFailed'))
    onChanged()
  }

  const handleDelete = async () => {
    const ok = await confirm(t('mods.deleteConfirm', { name: mod.name }), {
      title: t('mods.delete'),
      confirmText: t('mods.delete'),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    const done = await deleteMod(mod.id)
    setBusy(false)
    if (!done) flash(t('mods.saveFailed'))
    onChanged()
  }

  const handleRollback = async (version: number) => {
    setBusy(true)
    const restored = await rollbackMod(mod.id, version)
    setBusy(false)
    flash(restored ? t('mods.rolledBack', { version }) : t('mods.saveFailed'))
    onChanged()
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        border: `1px solid ${isExpanded ? 'var(--color-accent)' : 'var(--color-border)'}`,
        backgroundColor: 'var(--color-panel)',
      }}
    >
      <div className="flex w-full items-center gap-2.5 px-4 py-3">
        <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none" onClick={onToggleExpand}>
          {isExpanded ? (
            <ChevronDown size={14} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          ) : (
            <ChevronRight size={14} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          )}
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {mod.name}
          </span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[0.65rem]"
            style={{ color: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)' }}
          >
            v{mod.version}
          </span>
          {(mod.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="rounded-full px-1.5 py-0.5 text-[0.62rem]"
              style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-hover)' }}
            >
              {tag}
            </span>
          ))}
          {enabled && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[0.65rem]"
              style={{ color: 'var(--color-success)', backgroundColor: 'rgba(74,222,128,0.1)' }}
            >
              {t('mods.enabledBadge', { order: enabledIndex + 1 })}
            </span>
          )}
        </button>
      </div>

      {isExpanded && (
        <div className="space-y-3 px-4 pb-4" style={{ borderTop: '1px solid var(--color-border)' }}>
          <div className="grid grid-cols-2 gap-2 pt-3">
            <label className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('mods.name')}
              <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('mods.description')}
              <Input className="mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          {/* 标签编辑 */}
          <div>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('mods.tags')}
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.68rem]"
                  style={{
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text-secondary)',
                    backgroundColor: 'var(--color-hover)',
                  }}
                >
                  {tag}
                  <button
                    className="opacity-60 hover:opacity-100"
                    onClick={() => setTags((prev) => prev.filter((x) => x !== tag))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <Input
                className="w-44"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder={t('mods.tagInputPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const tag = tagInput.trim()
                    if (tag && !tags.includes(tag)) setTags((prev) => [...prev, tag])
                    setTagInput('')
                  }
                }}
              />
            </div>
          </div>

          <label className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('mods.guidance')}
            <textarea
              className="mt-1 w-full rounded-lg px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--color-editor-bg)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                minHeight: 110,
                lineHeight: 1.6,
              }}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder={t('mods.guidancePlaceholder')}
              spellCheck={false}
            />
          </label>

          {/* 模板覆盖 */}
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t('mods.templates')}
              </span>
              <NativeSelect
                className="w-52"
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
              >
                <option value="">{t('mods.addTemplate')}</option>
                {availableKeys.map((k) => (
                  <option key={k} value={k}>
                    {getPromptName(k)}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="outline"
                size="sm"
                disabled={!addKey}
                onClick={() => {
                  if (addKey) setTemplates((prev) => ({ ...prev, [addKey]: '' }))
                  setAddKey('')
                }}
              >
                <Plus size={12} />
              </Button>
            </div>
            {Object.keys(templates).length === 0 && (
              <p className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                {t('mods.noTemplates')}
              </p>
            )}
            {Object.entries(templates).map(([key, content]) => (
              <div key={key} className="mb-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[0.7rem] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                    {getPromptName(key)}
                    <span className="ml-1 opacity-50">({key})</span>
                  </span>
                  <button
                    className="icon-btn"
                    title={t('mods.removeTemplate')}
                    onClick={() =>
                      setTemplates((prev) => {
                        const next = { ...prev }
                        delete next[key]
                        return next
                      })
                    }
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <textarea
                  className="w-full rounded-lg px-3 py-2 font-mono text-xs"
                  style={{
                    backgroundColor: 'var(--color-editor-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    minHeight: 140,
                    lineHeight: 1.6,
                  }}
                  value={content}
                  onChange={(e) => setTemplates((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder={t('mods.templatePlaceholder')}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>

          {/* 操作 */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleSave()}>
              {t('mods.save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title={t('mods.exportTooltip')}
              onClick={() => {
                const blob = new Blob([exportModToJson(mod)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${mod.name}.vela-mod.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
            >
              <Download size={12} /> {t('mods.export')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handleDelete()}>
              <Trash2 size={12} /> {t('mods.delete')}
            </Button>
            {msg && (
              <span className="text-xs" style={{ color: 'var(--color-success)' }}>
                {msg}
              </span>
            )}
          </div>

          {/* 版本历史 */}
          <div>
            <button
              className="flex items-center gap-1.5 text-xs outline-none"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History size={12} />
              {t('mods.history')}
              {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
            {historyOpen && (
              <div className="mt-2 space-y-1">
                {history.length === 0 && (
                  <p className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                    {t('mods.historyEmpty')}
                  </p>
                )}
                {history.map((v) => (
                  <div
                    key={v.version}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[0.7rem]"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                  >
                    <span className="flex-shrink-0 font-medium">v{v.version}</span>
                    <span className="flex-shrink-0">{new Date(v.savedAt).toLocaleString()}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {(v.snapshot.guidanceAppend || Object.keys(v.snapshot.templates).map(getPromptName).join('、') || '—').slice(0, 50)}
                    </span>
                    {v.version !== mod.version && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-shrink-0"
                        disabled={busy}
                        onClick={() => void handleRollback(v.version)}
                      >
                        <RotateCcw size={11} /> {t('mods.rollback')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
