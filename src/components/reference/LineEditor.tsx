import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { suggestLineCandidates, normalizeName } from '../../services/reference/line-matrix'
import { ipc } from '../../services/ipc-client'
import { confirm } from '../ui/Confirm'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import { Switch } from '../ui/Switch'
import type { RefDigestData, RefLineData, RefLineKind } from '../../../electron/repositories/reference-repository'

interface Props {
  workId: number
  digests: RefDigestData[]
  lines: RefLineData[]
  reloadSelected: () => Promise<void>
}

export default function LineEditor({ workId, digests, lines, reloadSelected }: Props) {
  const { t } = useTranslation('pages')
  const [mergeFor, setMergeFor] = useState<Record<string, number>>({})

  const candidates = useMemo(
    () => suggestLineCandidates(digests).filter((c) => normalizeName(c.name, lines) === null).slice(0, 30),
    [digests, lines],
  )

  const addAsLine = async (name: string) => {
    await ipc.invoke('db:ref-line-upsert', {
      workId, name: name.slice(0, 60), aliases: [], kind: 'romance',
      sortOrder: lines.length, locked: false, arcSummary: '',
    })
    await reloadSelected()
  }

  const mergeInto = async (name: string, lineId: number) => {
    const l = lines.find((x) => x.id === lineId)
    if (!l) return
    await ipc.invoke('db:ref-line-upsert', { ...l, aliases: [...new Set([...l.aliases, name.slice(0, 60)])] })
    await reloadSelected()
  }

  const saveLine = async (line: RefLineData) => {
    await ipc.invoke('db:ref-line-upsert', line)
    await reloadSelected()
  }

  const move = async (index: number, dir: -1 | 1) => {
    const other = index + dir
    if (other < 0 || other >= lines.length) return
    const a = lines[index]
    const b = lines[other]
    await ipc.invoke('db:ref-line-upsert', { ...a, sortOrder: b.sortOrder })
    await ipc.invoke('db:ref-line-upsert', { ...b, sortOrder: a.sortOrder })
    await reloadSelected()
  }

  const remove = async (line: RefLineData) => {
    const ok = await confirm(t('reference.lines.delete'), { danger: true })
    if (!ok) return
    await ipc.invoke('db:ref-line-delete', line.id)
    await reloadSelected()
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-medium mb-2">{t('reference.lines.candidates')}</h3>
        {candidates.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t('reference.lines.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {candidates.map((c) => (
              <li key={c.name} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {c.name}
                  <span className="ml-2 text-[var(--color-text-muted)]">
                    {t('reference.lines.firstChapter', { chapter: c.firstChapter })}
                    {' · '}
                    {t('reference.lines.mainCount', { count: c.mainCount })}
                    {' · '}
                    {t('reference.lines.total', { count: c.total })}
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => void addAsLine(c.name)}>
                  {t('reference.lines.setAsLine')}
                </Button>
                {lines.length > 0 && (
                  <div className="flex items-center gap-1">
                    <NativeSelect
                      className="w-28"
                      value={mergeFor[c.name] ?? ''}
                      onChange={(e) => setMergeFor((prev) => ({ ...prev, [c.name]: Number(e.target.value) }))}
                    >
                      <option value="">{t('reference.lines.mergeInto')}</option>
                      {lines.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </NativeSelect>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mergeFor[c.name]}
                      onClick={() => void mergeInto(c.name, mergeFor[c.name])}
                    >
                      {t('reference.lines.mergeInto')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-xs font-medium mb-2">{t('reference.lines.defined')}</h3>
        {lines.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">{t('reference.lines.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {lines.map((line, index) => (
              <li
                key={line.id}
                className="rounded-lg px-3 py-2 border border-[var(--color-border)] space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    className="w-32"
                    defaultValue={line.name}
                    disabled={line.locked}
                    onBlur={(e) => {
                      const name = e.target.value.trim().slice(0, 60)
                      if (name && name !== line.name) void saveLine({ ...line, name })
                    }}
                  />
                  <NativeSelect
                    className="w-24"
                    value={line.kind}
                    disabled={line.locked}
                    onChange={(e) => void saveLine({ ...line, kind: e.target.value as RefLineKind })}
                  >
                    <option value="romance">{t('reference.lines.kind.romance')}</option>
                    <option value="plot">{t('reference.lines.kind.plot')}</option>
                    <option value="other">{t('reference.lines.kind.other')}</option>
                  </NativeSelect>
                  <label className="flex items-center gap-1 text-[var(--color-text-muted)]">
                    <Switch
                      checked={line.locked}
                      onCheckedChange={(locked) => void saveLine({ ...line, locked })}
                      aria-label={t('reference.lines.locked')}
                    />
                    {t('reference.lines.locked')}
                  </label>
                  <div className="flex-1" />
                  <Button size="icon" variant="ghost" disabled={index === 0} onClick={() => void move(index, -1)}>
                    <ChevronUp size={12} />
                  </Button>
                  <Button size="icon" variant="ghost" disabled={index === lines.length - 1} onClick={() => void move(index, 1)}>
                    <ChevronDown size={12} />
                  </Button>
                  <Button size="icon" variant="ghost" disabled={line.locked} onClick={() => void remove(line)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
                <Input
                  placeholder={t('reference.lines.aliases')}
                  defaultValue={line.aliases.join('，')}
                  disabled={line.locked}
                  onBlur={(e) => {
                    const aliases = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 30)
                    const same = aliases.length === line.aliases.length && aliases.every((a, i) => a === line.aliases[i])
                    if (!same) void saveLine({ ...line, aliases })
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
