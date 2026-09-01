/**
 * ModEnablePanel — 小说配置页的「写作 Mod」启用面板
 *
 * Mod 库在 设置 → Mod 管理 里维护（全局共享）；
 * 这里负责本书启用哪些、以什么顺序叠加（越晚勾选优先级越高），
 * 以及版本钉住。大列表友好：搜索 + 标签过滤 + 固定高度滚动 + 已启用置顶。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, GripVertical, Search } from 'lucide-react'
import {
  collectTags,
  getEnabledEntries,
  listMods,
  loadModHistory,
  loadMods,
  loadProjectEnabledMods,
  moveEnabledEntry,
  saveProjectEnabledMods,
  type ModEnableEntry,
  type ModVersion,
  type WritingMod,
} from '../../services/mods'
import { useProjectStore } from '../../stores/project-store'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'

export default function ModEnablePanel() {
  const { t } = useTranslation('editors')
  const [mods, setMods] = useState<WritingMod[]>([])
  const [entries, setEntries] = useState<ModEnableEntry[]>([])
  const [historyByMod, setHistoryByMod] = useState<Record<string, ModVersion[]>>({})
  const [query, setQuery] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const projectPath = useProjectStore((s) => s.currentProject?.path)

  useEffect(() => {
    void (async () => {
      await loadMods()
      // 从磁盘重载本书启用表：热重载/模块重置后内存可能已清空，
      // 直接读盘并重设 currentProjectPath，避免面板显示空、后续保存写空文件
      if (projectPath) await loadProjectEnabledMods(projectPath)
      setMods(listMods())
      const current = getEnabledEntries()
      setEntries(current)
      // 已启用的 Mod 预载历史，供版本下拉使用
      for (const entry of current) void ensureHistory(entry.id)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const ensureHistory = async (id: string) => {
    const history = await loadModHistory(id)
    setHistoryByMod((prev) => ({ ...prev, [id]: history }))
  }

  const persist = async (next: ModEnableEntry[]) => {
    setEntries(next)
    await saveProjectEnabledMods(next)
  }

  const toggle = (id: string) => {
    const existing = entries.find((e) => e.id === id)
    if (existing) {
      void persist(entries.filter((e) => e.id !== id))
    } else {
      void ensureHistory(id)
      void persist([...entries, { id, version: null }])
    }
  }

  const pinVersion = (id: string, version: number | null) => {
    void persist(entries.map((e) => (e.id === id ? { ...e, version } : e)))
  }

  const moveTo = (fromId: string, toId: string) => {
    const next = moveEnabledEntry(entries, fromId, toId)
    if (next === entries) return
    void persist(next)
  }

  const moveBy = (id: string, delta: number) => {
    const from = entries.findIndex((e) => e.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= entries.length) return
    moveTo(id, entries[to].id)
  }

  const active = useMemo(() => mods.filter((m) => !m.disabled), [mods])
  const tags = useMemo(() => collectTags(active), [active])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = (m: WritingMod) => {
      if (filterTag && !(m.tags ?? []).includes(filterTag)) return false
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        (m.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      )
    }
    const enabledOrder = new Map(entries.map((e, i) => [e.id, i]))
    // 已启用置顶（按启用顺序），未启用按名称
    return active.filter(hit).sort((a, b) => {
      const ia = enabledOrder.has(a.id) ? (enabledOrder.get(a.id) as number) : Infinity
      const ib = enabledOrder.has(b.id) ? (enabledOrder.get(b.id) as number) : Infinity
      if (ia !== ib) return ia - ib
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  }, [active, entries, query, filterTag])

  if (mods.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('novelConfig.modsEmpty')}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {/* 检索行：搜索 + 标签 + 统计 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <Input
            className="w-44 pl-6"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('novelConfig.modsSearchPlaceholder')}
          />
        </div>
        {tags.slice(0, 8).map(({ tag, count }) => (
          <button
            key={tag}
            className="rounded-full px-2 py-0.5 text-[0.68rem] transition-colors"
            style={{
              border: '1px solid var(--color-border)',
              backgroundColor: filterTag === tag ? 'var(--color-accent)' : 'var(--color-hover)',
              color: filterTag === tag ? '#fff' : 'var(--color-text-secondary)',
            }}
            onClick={() => setFilterTag(filterTag === tag ? null : tag)}
          >
            {tag} ({count})
          </button>
        ))}
        <span className="ml-auto text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
          {t('novelConfig.modsCount', { enabled: entries.length, total: active.length })}
        </span>
      </div>

      {/* 列表：固定高度内滚动，超过再多也不撑爆配置页 */}
      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('novelConfig.modsNoMatch')}
          </p>
        )}
        {visible.map((mod) => {
          const entry = entries.find((e) => e.id === mod.id)
          const idx = entries.findIndex((e) => e.id === mod.id)
          const history = historyByMod[mod.id] ?? []
          return (
            <div
              key={mod.id}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-[var(--color-hover)]"
              style={{
                border: `1px solid ${draggingId === mod.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                opacity: draggingId && draggingId !== mod.id && entry ? 0.7 : 1,
              }}
              draggable={Boolean(entry)}
              onDragStart={() => {
                if (entry) setDraggingId(mod.id)
              }}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(e) => {
                if (!entry || !draggingId || draggingId === mod.id) return
                e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (draggingId && entry) moveTo(draggingId, mod.id)
                setDraggingId(null)
              }}
            >
              {entry ? (
                <span
                  className="cursor-grab text-[var(--color-text-muted)]"
                  title={t('novelConfig.modsDragHandle')}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <GripVertical size={13} />
                </span>
              ) : (
                <span className="w-[13px]" />
              )}
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={Boolean(entry)}
                onChange={() => toggle(mod.id)}
              />
              <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                {mod.name}
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
              {mod.description && (
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {mod.description}
                </span>
              )}
              <div className="ml-auto flex flex-shrink-0 items-center gap-2">
                {entry && (
                  <NativeSelect
                    className="w-32"
                    title={t('novelConfig.modVersionTooltip')}
                    value={entry.version == null ? '' : String(entry.version)}
                    onChange={(e) =>
                      pinVersion(mod.id, e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">{t('novelConfig.modVersionLatest', { version: mod.version })}</option>
                    {history.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version} · {new Date(v.savedAt).toLocaleDateString()}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {entry && (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={idx <= 0}
                      title={t('novelConfig.modsMoveUp')}
                      onClick={() => moveBy(mod.id, -1)}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={idx >= entries.length - 1}
                      title={t('novelConfig.modsMoveDown')}
                      onClick={() => moveBy(mod.id, 1)}
                    >
                      <ChevronDown size={12} />
                    </button>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[0.65rem]"
                      style={{ color: 'var(--color-success)', backgroundColor: 'rgba(74,222,128,0.1)' }}
                    >
                      #{idx + 1}
                    </span>
                  </>
                )}
                {!entry && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[0.65rem]"
                    style={{ color: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)' }}
                  >
                    v{mod.version}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {t('novelConfig.modsDragHint')}
      </p>
      <p className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {t('novelConfig.modsManageHint')}
      </p>
    </div>
  )
}
