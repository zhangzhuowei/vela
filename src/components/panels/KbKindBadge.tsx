import { useTranslation } from 'react-i18next'
import { kbKindOf, type KbKind } from '../../services/kb-allocate'

/** 来源角标：设定纲要同步的 / 词表示范类；正文与手导资料不标 */
export function KbKindBadge({ fileName }: { fileName: string }) {
  const { t } = useTranslation('panels')
  const kind: KbKind = kbKindOf(fileName)
  if (kind === 'other') return null
  const color = kind === 'setting' ? 'var(--color-success)' : 'var(--color-warning, #eab308)'
  return (
    <span
      className="text-[0.6rem] px-1 py-px rounded flex-shrink-0"
      style={{ color, border: `1px solid ${color}` }}
      title={t(`knowledge.kind.${kind}Hint`)}
    >
      {t(`knowledge.kind.${kind}`)}
    </span>
  )
}
