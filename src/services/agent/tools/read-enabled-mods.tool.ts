/**
 * read_enabled_mods — 读取本书小说配置里启用的 Mod
 */
import i18n from '../../../i18n'
import { buildAgentTool } from '../tool-registry'
import { useProjectStore } from '../../../stores/project-store'
import { listEnabledModSnapshots, normalizeModInject } from '../../mods'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'panels', ...opts })

const GUIDANCE_CAP = 2000

export const readEnabledModsTool = buildAgentTool({
  name: 'read_enabled_mods',
  description: t('agent.tools.readEnabledMods.desc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  requiresConfirmation: false,
  execute: async () => {
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: t('agent.tools.noProject') }
    }

    const enabled = listEnabledModSnapshots()
    if (enabled.length === 0) {
      return { success: true, content: t('agent.tools.readEnabledMods.empty') }
    }

    const blocks = enabled.map((mod, i) => {
      const slot = normalizeModInject(mod.inject)
      const slotLabel =
        slot === 'system'
          ? t('agent.tools.readEnabledMods.slotSystem')
          : t('agent.tools.readEnabledMods.slotPostHistory')
      const keys = Object.keys(mod.templates || {}).filter((k) => mod.templates[k]?.trim())
      const guidance = (mod.guidanceAppend || '').trim()
      const clipped =
        guidance.length > GUIDANCE_CAP ? `${guidance.slice(0, GUIDANCE_CAP)}\n…` : guidance
      const lines = [
        `### ${i + 1}. ${mod.name}（v${mod.version}）`,
        mod.description?.trim() ? t('agent.tools.readEnabledMods.description', { text: mod.description.trim() }) : '',
        t('agent.tools.readEnabledMods.inject', { slot: slotLabel }),
        keys.length
          ? t('agent.tools.readEnabledMods.templates', { keys: keys.join('、') })
          : t('agent.tools.readEnabledMods.noTemplates'),
        clipped
          ? t('agent.tools.readEnabledMods.guidance', { text: clipped })
          : t('agent.tools.readEnabledMods.noGuidance'),
      ]
      return lines.filter(Boolean).join('\n')
    })

    return {
      success: true,
      content: `${t('agent.tools.readEnabledMods.title', { count: enabled.length })}\n\n${blocks.join('\n\n')}`,
    }
  },
})
