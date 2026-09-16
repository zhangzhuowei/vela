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

export function createReferenceOutlineWorkflow(params: { workId: number; workName: string; userHint?: string }): WorkflowDefinition {
  const hint = params.userHint ?? ''
  return {
    type: 'reference_analysis',
    title: t('workflowDefs.refOutlineTitle', { name: params.workName }),
    steps: [
      {
        name: t('workflowDefs.refStepStages'), description: t('workflowDefs.refStepStagesDesc'),
        executor: async (step, context, callbacks) => {
          const { RefSegmentStagesCommand } = await import('./commands/reference-analysis.command')
          return new RefSegmentStagesCommand(params.workId, hint).execute({ step, context, callbacks })
        },
      },
      {
        name: t('workflowDefs.refStepLineArcs'), description: t('workflowDefs.refStepLineArcsDesc'),
        executor: async (step, context, callbacks) => {
          const { RefLineArcsCommand } = await import('./commands/reference-analysis.command')
          return new RefLineArcsCommand(params.workId, undefined, hint).execute({ step, context, callbacks })
        },
      },
      {
        name: t('workflowDefs.refStepL2'), description: t('workflowDefs.refStepL2Desc'),
        executor: async (step, context, callbacks) => {
          const { RefGlobalOutlineCommand } = await import('./commands/reference-analysis.command')
          return new RefGlobalOutlineCommand(params.workId, hint).execute({ step, context, callbacks })
        },
      },
      {
        name: t('workflowDefs.refStepL3'), description: t('workflowDefs.refStepL3Desc'),
        executor: async (step, context, callbacks) => {
          const { RefProgressionPatternCommand } = await import('./commands/reference-analysis.command')
          return new RefProgressionPatternCommand(params.workId, hint).execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent', message: t('workflowDefs.refOutlineDone') },
  }
}

export function createReferenceRefineWorkflow(params: {
  workId: number; workName: string; scope: import('./commands/reference-analysis.command').RefRefineScope; instruction: string; scopeLabel: string
}): WorkflowDefinition {
  return {
    type: 'reference_analysis',
    title: t('workflowDefs.refRefineTitle', { name: params.workName, scope: params.scopeLabel }),
    steps: [{
      name: t('workflowDefs.refRefineStep'), description: params.instruction.slice(0, 80),
      executor: async (step, context, callbacks) => {
        const { RefRefineCommand } = await import('./commands/reference-analysis.command')
        return new RefRefineCommand(params.workId, params.scope, params.instruction).execute({ step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: t('workflowDefs.refRefineDone') },
  }
}

export function createReferenceRerunWorkflow(params: {
  workId: number
  workName: string
  scope: import('./commands/reference-analysis.command').RefRerunScope
  scopeLabel: string
}): WorkflowDefinition {
  return {
    type: 'reference_analysis',
    title: t('workflowDefs.refRerunTitle', { name: params.workName, scope: params.scopeLabel }),
    steps: [{
      name: t('workflowDefs.refRerunStep'),
      description: params.scopeLabel,
      executor: async (step, context, callbacks) => {
        const cmd = await import('./commands/reference-analysis.command')
        const s = params.scope
        if (s.kind === 'L2') {
          return new cmd.RefGlobalOutlineCommand(params.workId).execute({ step, context, callbacks })
        }
        if (s.kind === 'L3') {
          return new cmd.RefProgressionPatternCommand(params.workId).execute({ step, context, callbacks })
        }
        if (s.kind === 'lines') {
          return new cmd.RefLineArcsCommand(params.workId).execute({ step, context, callbacks })
        }
        if (s.kind === 'line') {
          return new cmd.RefLineArcsCommand(params.workId, s.lineId).execute({ step, context, callbacks })
        }
        if (s.kind === 'stage') {
          return new cmd.RefRerunStageCommand(params.workId, s.stageId).execute({ step, context, callbacks })
        }
        return new cmd.RefDigestChaptersCommand(
          params.workId, s.chapterNumber, s.chapterNumber, [s.chapterNumber],
        ).execute({ step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: t('workflowDefs.refRerunDone') },
  }
}
