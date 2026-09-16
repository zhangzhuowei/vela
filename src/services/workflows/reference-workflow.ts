import type { WorkflowDefinition } from '../../stores/workflow-store'
import i18n from '../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export function createReferenceDigestWorkflow(params: { workId: number; workName: string; from: number; to: number }): WorkflowDefinition {
  return {
    type: 'reference_analysis',
    title: t('workflowDefs.refDigestTitle', { name: params.workName, from: params.from, to: params.to }),
    steps: [
      {
        name: t('workflowDefs.refDigestStep'),
        description: t('workflowDefs.refDigestStepDesc', { from: params.from, to: params.to }),
        executor: async (step, context, callbacks) => {
          const { RefDigestChaptersCommand } = await import('./commands/reference-analysis.command')
          return new RefDigestChaptersCommand(params.workId, params.from, params.to).execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent', message: t('workflowDefs.refDigestDone') },
  }
}
