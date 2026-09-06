import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollText } from 'lucide-react'
import { listSettingModules } from '../../services/setting-bible-service'
import { isGridEmpty, type SettingModuleData } from '../../services/setting-bible'
import { globalEventBus } from '../../shared/event-bus'

/**
 * 「本章 / 本场涉及设定」芯片选择器。
 * 选中的模块写稿时全文注入，不靠检索碰运气；关闭状态的模块不可选。
 */
export default function SettingKeysPicker({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
  compact?: boolean
}) {
  const { t } = useTranslation('editors')
  const [modules, setModules] = useState<SettingModuleData[]>([])

  useEffect(() => {
    let alive = true
    const load = () => listSettingModules().then((list) => { if (alive) setModules(list) })
    load()
    const off = globalEventBus.on('SETTING_MODULES_CHANGED', () => { load() })
    return () => { alive = false; off() }
  }, [])

  const candidates = modules.filter((m) => m.injectMode !== 'off')
  if (candidates.length === 0) return null

  const toggle = (key: string) => {
    if (disabled) return
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])
  }

  return (
    <div className={compact ? 'flex items-center gap-1 flex-wrap' : 'flex items-center gap-1.5 flex-wrap'}>
      <span className="text-xs flex items-center gap-1 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} title={t('settingBible.pickerHint')}>
        <ScrollText size={11} />
        {t('settingBible.pickerLabel')}
      </span>
      {candidates.map((m) => {
        const on = value.includes(m.key)
        const empty = isGridEmpty(m.body)
        return (
          <button
            key={m.key}
            type="button"
            disabled={disabled}
            onClick={() => toggle(m.key)}
            title={empty ? t('settingBible.pickerEmpty') : m.injectMode === 'always' ? t('settingBible.pickerAlwaysHint') : t('settingBible.pickerRetrievalHint')}
            className="text-[0.7rem] px-1.5 py-px rounded-full transition-colors"
            style={{
              border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
              backgroundColor: on ? 'rgba(var(--color-accent-rgb,99 102 241),0.15)' : 'transparent',
              color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              opacity: empty ? 0.5 : 1,
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            {m.title}
          </button>
        )
      })}
    </div>
  )
}
