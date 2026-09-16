/**
 * CharactersView — 角色管理列表视图
 */

import { useRef } from 'react'
import { Users, RefreshCw, Plus, Download, Upload } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore, ROLE_LABELS } from '../../../stores/character-store'
import { exportCharactersToJson, parseCharacterImport } from '../../../services/character-io'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../ui/Toast'
import { cn } from '../../../lib/utils'
import { useTranslation } from 'react-i18next'
import { useBranchStore } from '../../../stores/branch-store'
import { displayChapterNameSafe } from '../../../shared/chapter-addressing'

export default function CharactersView() {
  const { t } = useTranslation('panels')
  const currentProject = useProjectStore(s => s.currentProject)
  const branches = useBranchStore(s => s.branches)
  const characters = useCharacterStore(s => s.characters)
  const selectedName = useCharacterStore(s => s.selectedName)
  const load = useCharacterStore(s => s.load)
  const setSelectedName = useCharacterStore(s => s.setSelectedName)
  const addCharacter = useCharacterStore(s => s.addCharacter)
  const importCharacters = useCharacterStore(s => s.importCharacters)
  const importInputRef = useRef<HTMLInputElement>(null)

  const handleExport = () => {
    const cards = useCharacterStore.getState().characters
    if (cards.length === 0) {
      toast.warning(t('characters.exportEmpty'))
      return
    }
    const project = (useProjectStore.getState().currentProject?.name?.trim() || 'characters').replace(
      /[\\/:*?"<>|]/g,
      '_'
    )
    const blob = new Blob([exportCharactersToJson(cards)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project}.vela-characters.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = (file: File) => {
    void (async () => {
      const parsed = parseCharacterImport(await file.text())
      if (!parsed) {
        toast.error(t('characters.importFailed'))
        return
      }
      const count = await importCharacters(parsed)
      toast.success(t('characters.importOk', { count }))
    })()
  }

  if (!currentProject) {
    return (
      <EmptyState 
        icon={<Users size={36} />} 
        message={t('noProject', { ns: 'common' })} 
        className="pb-[15vh]" 
        opacity={0.4} 
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Users size={13} />
          {t('characters.title', { count: characters.length })}
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => load()} title={t('characters.refreshList')}>
            <RefreshCw size={14} strokeWidth={2} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleExport} title={t('characters.exportJsonTooltip')}>
            <Download size={14} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => importInputRef.current?.click()}
            title={t('characters.importJsonTooltip')}
          >
            <Upload size={14} strokeWidth={2} />
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handleImportFile(file)
            }}
          />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addCharacter} title={t('characters.newCharacterBtn')}>
            <Plus size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>
      {/* 角色列表 */}
      <div className="flex-1 overflow-y-auto p-1">
        {characters.map((c) => (
          <div
            key={c.name}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-0.5',
              selectedName === c.name
                ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
            )}
            onClick={() => setSelectedName(c.name)}
          >
            <div className="font-medium">{c.name || t('characters.unnamed')}</div>
            <div className="text-[0.7rem] mt-0.5 opacity-60">{ROLE_LABELS[c.role]}</div>
            {c.currentState && (
              <div className="text-[0.65rem] mt-0.5 opacity-50">
                {t('characters.chapterUpdate', { name: displayChapterNameSafe(c.currentState.updatedAtChapter, branches) })}
              </div>
            )}
          </div>
        ))}
        {characters.length === 0 && (
          <div className="text-center py-6 opacity-30 text-xs">{t('characters.noCharacters')}</div>
        )}
      </div>
    </div>
  )
}
