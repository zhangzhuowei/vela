/**
 * ModEnablePanel — 小说配置页的「写作 Mod」启用面板
 *
 * Mod 库在 设置 → Mod 管理 里维护（全局共享）；
 * 这里负责本书启用哪些、以什么顺序叠加（越晚勾选优先级越高），
 * 以及版本钉住：跟随最新，或锁定某个历史版本（不同书可钉不同版本）。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getEnabledEntries,
  listMods,
  loadModHistory,
  loadMods,
  saveProjectEnabledMods,
  type ModEnableEntry,
  type ModVersion,
  type WritingMod,
} from '../../services/mods'
import { NativeSelect } from '../ui/NativeSelect'

export default function ModEnablePanel() {
  const { t } = useTranslation('editors')
  const [mods, setMods] = useState<WritingMod[]>([])
  const [entries, setEntries] = useState<ModEnableEntry[]>([])
  const [historyByMod, setHistoryByMod] = useState<Record<string, ModVersion[]>>({})

  useEffect(() => {
    void loadMods().then(() => {
      setMods(listMods())
      const current = getEnabledEntries()
      setEntries(current)
      // 已启用的 Mod 预载历史，供版本下拉使用
      for (const entry of current) void ensureHistory(entry.id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  if (mods.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('novelConfig.modsEmpty')}
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {mods.map((mod) => {
        const entry = entries.find((e) => e.id === mod.id)
        const idx = entries.findIndex((e) => e.id === mod.id)
        const history = historyByMod[mod.id] ?? []
        return (
          <div
            key={mod.id}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-[var(--color-hover)]"
            style={{ border: '1px solid var(--color-border)' }}
          >
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
                <span
                  className="rounded-full px-1.5 py-0.5 text-[0.65rem]"
                  style={{ color: 'var(--color-success)', backgroundColor: 'rgba(74,222,128,0.1)' }}
                >
                  #{idx + 1}
                </span>
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
      <p className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {t('novelConfig.modsManageHint')}
      </p>
    </div>
  )
}
