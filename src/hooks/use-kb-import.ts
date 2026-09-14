import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '../components/ui/Toast'
import { importKbFilesFromDialog } from '../services/knowledge-service'

/** 侧栏 / 概览共用：选文件导入知识库并 toast */
export function useKbImport() {
  const { t } = useTranslation('panels', { keyPrefix: 'knowledge' })
  const [importing, setImporting] = useState(false)

  const importFiles = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const r = await importKbFilesFromDialog()
      if (r.cancelled) return
      if (r.imported === 0 && r.failed.length === 0) {
        toast.warning(t('importNone'))
        return
      }
      if (r.imported > 0 && r.failed.length === 0) {
        toast.success(t('importOk', { count: r.imported, chunks: r.chunks }))
      } else if (r.imported > 0) {
        toast.warning(t('importPartial', { count: r.imported, failed: r.failed.length }))
      } else {
        toast.error(t('importFailed', { error: r.failed[0]?.error || '' }))
      }
      if (r.skipped.length > 0) {
        toast.info(t('importSkipped', { names: r.skipped.join('、') }))
      }
    } catch (e) {
      toast.error(t('importFailed', { error: String(e) }))
    } finally {
      setImporting(false)
    }
  }, [importing, t])

  return { importing, importFiles }
}
