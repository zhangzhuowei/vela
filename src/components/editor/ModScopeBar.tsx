import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useModRevision } from '../../hooks/use-mod-revision'
import {
  getActiveModLayers,
  getChapterExcludedMods,
  getEnabledModIds,
  getSceneExcludedMods,
  listMods,
  setChapterExcludedMods,
  setSceneExcludedMods,
  type ModApplyScope,
} from '../../services/mods'

function pinChars(text: string): number {
  return text.replace(/\s/g, '').length
}

export default function ModScopeBar({
  chapterNumber,
  sceneId,
}: ModApplyScope & { chapterNumber: number }) {
  const { t } = useTranslation('editors')
  useModRevision()
  const [open, setOpen] = useState(false)
  const scope = { chapterNumber, sceneId }
  const layers = getActiveModLayers(scope)
  const bookIds = getEnabledModIds()
  const mods = listMods()
  const chapterOff = new Set(getChapterExcludedMods(chapterNumber))
  const sceneOff = sceneId != null ? new Set(getSceneExcludedMods(sceneId)) : new Set<string>()
  const names = layers.parts
    .map((p) =>
      t('dialogue.requestLayerItem', {
        name: p.name,
        slot: p.inject === 'system' ? t('dialogue.requestSlotSystem') : t('dialogue.requestSlotPostHistory'),
      })
    )
    .join(t('dialogue.requestLayerJoin'))
  const enabledMods = bookIds.map((id) => mods.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m))

  const summary =
    layers.parts.length > 0
      ? t(sceneId != null ? 'dialogue.requestActiveMods' : 'dialogue.requestActiveModsChapter', {
          names,
          pinChars: pinChars(layers.postHistory),
        })
      : t('dialogue.requestActiveModsNone')

  const toggleChapter = (id: string) => {
    const next = chapterOff.has(id) ? [...chapterOff].filter((x) => x !== id) : [...chapterOff, id]
    void setChapterExcludedMods(chapterNumber, next)
  }

  const toggleScene = (id: string) => {
    if (sceneId == null) return
    const next = sceneOff.has(id) ? [...sceneOff].filter((x) => x !== id) : [...sceneOff, id]
    void setSceneExcludedMods(sceneId, next)
  }

  if (bookIds.length === 0) {
    return (
      <div className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {t('dialogue.requestActiveModsNone')}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        <span>{summary}</span>
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          style={{ color: 'var(--color-text-secondary)' }}
          onClick={() => setOpen((v) => !v)}
        >
          {t('dialogue.modsScopeToggle')}
        </button>
      </div>
      {open && (
        <div
          className="space-y-1 rounded-lg px-2.5 py-2"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
        >
          {enabledMods.map((mod) => {
            const chOff = chapterOff.has(mod.id)
            const scOff = sceneOff.has(mod.id)
            return (
              <div key={mod.id} className="flex flex-wrap items-center gap-2 text-[0.68rem]">
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                  {mod.name}
                </span>
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5"
                  style={{
                    border: '1px solid var(--color-border)',
                    color: chOff ? 'var(--color-text-muted)' : 'var(--color-success)',
                    backgroundColor: chOff ? 'var(--color-hover)' : 'rgba(74,222,128,0.08)',
                  }}
                  onClick={() => toggleChapter(mod.id)}
                >
                  {t(chOff ? 'dialogue.modsScopeChapterOff' : 'dialogue.modsScopeChapterOn')}
                </button>
                {sceneId != null && (
                  <button
                    type="button"
                    className="rounded-full px-2 py-0.5"
                    style={{
                      border: '1px solid var(--color-border)',
                      color: scOff ? 'var(--color-text-muted)' : 'var(--color-success)',
                      backgroundColor: scOff ? 'var(--color-hover)' : 'rgba(74,222,128,0.08)',
                    }}
                    onClick={() => toggleScene(mod.id)}
                  >
                    {t(scOff ? 'dialogue.modsScopeSceneOff' : 'dialogue.modsScopeSceneOn')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
