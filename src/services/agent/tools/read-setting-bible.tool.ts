/**
 * read_setting_bible — 读取本书设定纲要：不传模块名给全表概览，传了给该模块四格全文
 */
import i18n from '../../../i18n'
import { buildAgentTool } from '../tool-registry'
import { listSettingModules } from '../../setting-bible-service'
import { effectiveSummary, isGridEmpty, renderModuleFull } from '../../setting-bible'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'panels', ...opts })

export const readSettingBibleTool = buildAgentTool({
  name: 'read_setting_bible',
  description: t('agent.tools.readSettingBible.desc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      module: {
        type: 'string',
        description: t('agent.tools.readSettingBible.moduleDesc'),
      },
    },
    required: [],
  },
  requiresConfirmation: false,
  execute: async (args) => {
    const modules = await listSettingModules()
    if (modules.length === 0) {
      return { success: true, content: t('agent.tools.readSettingBible.empty') }
    }
    const wanted = String(args.module ?? '').trim()
    if (wanted) {
      const hit = modules.find((m) => m.title === wanted || m.key === wanted) ??
        modules.find((m) => m.title.includes(wanted))
      if (!hit) {
        return { success: false, content: '', error: t('agent.tools.readSettingBible.notFound', { name: wanted }) }
      }
      const full = renderModuleFull(hit)
      return {
        success: true,
        content: full || t('agent.tools.readSettingBible.moduleEmpty', { name: hit.title }),
      }
    }
    const lines = modules.map((m) => {
      const mode = t(`agent.tools.readSettingBible.mode.${m.injectMode}`)
      const summary = isGridEmpty(m.body) ? t('agent.tools.readSettingBible.noContent') : effectiveSummary(m) || '—'
      return `- **${m.title}**（${mode}）：${summary}`
    })
    return {
      success: true,
      content: `${t('agent.tools.readSettingBible.title', { count: modules.length })}\n\n${lines.join('\n')}\n\n${t('agent.tools.readSettingBible.hint')}`,
    }
  },
})
