/**
 * 导出服务 — 将小说项目导出为多种格式
 *
 * 支持：
 * - 合并 Markdown（全书合并为单个 .md）
 * - 分章 Markdown（每章一个 .md）
 * - 纯文本 TXT
 * - EPUB
 *
 * 番外按 extraMode 分流；IF 线始终单独成文。
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
import i18n from '../i18n'
import {
  layoutExportDocuments, normalizeExtraExportMode,
  type ExtraExportMode, type ExportDocument, type LaidOutChapter, type LayoutChapter,
} from './export-layout'
import type { BranchData } from '../../electron/repositories/branch-repository'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'dialogs', ...opts })

export type ExportFormat = 'merged-md' | 'split-md' | 'txt' | 'epub'

interface ExportOptions {
  format: ExportFormat
  outputDir: string
  includeOutline?: boolean
  includeCharacters?: boolean
  /** EPUB 作者（仅 epub 使用；为空则记为「佚名」） */
  author?: string
  extraMode?: ExtraExportMode
  includeIf?: boolean
}

function withSection(ch: LaidOutChapter, asMarkdown: boolean): string {
  if (!ch.section) return ch.content
  if (asMarkdown) return `## ${ch.section}\n\n${ch.content}`
  return `${ch.section}\n${'='.repeat(Math.max(4, ch.section.length * 2))}\n\n${ch.content}`
}

function toPlainText(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/---+/g, '\n')
    .trim()
}

async function writeMergedMd(doc: ExportDocument, outputDir: string, header: string): Promise<string> {
  let content = header
  for (const ch of doc.chapters) {
    content += withSection(ch, true) + '\n\n---\n\n'
  }
  const outputPath = `${outputDir}/${doc.fileStem}.md`
  await ipc.invoke('fs:write-file', outputPath, content)
  return outputPath
}

async function writeSplitMd(doc: ExportDocument, outputDir: string): Promise<string> {
  const splitDir = `${outputDir}/${doc.fileStem}`
  await ipc.invoke('fs:mkdir', splitDir)
  for (const ch of doc.chapters) {
    const safe = ch.title.replace(/[/\\:*?"<>|]/g, '_')
    await ipc.invoke('fs:write-file', `${splitDir}/${safe}.md`, withSection(ch, true))
  }
  return splitDir
}

async function writeTxt(doc: ExportDocument, outputDir: string, header: string): Promise<string> {
  let content = header
  for (const ch of doc.chapters) {
    content += toPlainText(withSection(ch, false)) + '\n\n'
  }
  const outputPath = `${outputDir}/${doc.fileStem}.txt`
  await ipc.invoke('fs:write-file', outputPath, content)
  return outputPath
}

async function writeEpub(
  doc: ExportDocument,
  outputDir: string,
  opts: { author: string; outline?: string },
): Promise<{ path: string; error?: string }> {
  const chapters: Array<{ title: string; content: string }> = []
  if (opts.outline?.trim()) {
    chapters.push({ title: '内容简介', content: opts.outline.trim() })
  }
  for (const ch of doc.chapters) {
    chapters.push({
      title: ch.section ? `${ch.section} · ${ch.title}` : ch.title,
      content: withSection(ch, true),
    })
  }
  const outputPath = `${outputDir}/${doc.fileStem}.epub`
  const res = await ipc.invoke('export:epub', {
    title: doc.fileStem,
    author: opts.author,
    language: 'zh-CN',
    outputPath,
    chapters,
  })
  return { path: outputPath, error: res.success ? undefined : (res.error || 'EPUB 生成失败') }
}

/** 导出全书 */
export async function exportNovel(options: ExportOptions): Promise<{ success: boolean; path?: string; error?: string }> {
  const project = useProjectStore.getState().currentProject
  if (!project) return { success: false, error: t('export.noProjectError') }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', `📦 开始导出（${formatLabel(options.format)}）...`)

  try {
    const chapterContents: LayoutChapter[] = []
    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as unknown as Array<Record<string, unknown>>
    const sortedBps = blueprints ? blueprints.sort((a, b) => (a.chapterNumber as number) - (b.chapterNumber as number)) : []

    for (const bp of sortedBps) {
      const meta = await ipc.invoke('db:draft-get-finalized', bp.chapterNumber as number)
      if (meta && (meta as { id: number }).id !== undefined) {
        const full = await ipc.invoke('db:draft-get-full', (meta as { id: number }).id)
        if (full && (full as { content?: string }).content) {
          chapterContents.push({
            title: (bp.title as string) || '',
            chapterNumber: bp.chapterNumber as number,
            content: (full as { content: string }).content,
          })
        }
      }
    }

    if (chapterContents.length === 0) {
      return { success: false, error: t('export.noFinalizedChapters') }
    }

    const core = await ipc.invoke('db:project-core-get')
    const branches = (await ipc.invoke('db:branch-list').catch(() => [] as BranchData[])) as BranchData[]
    const extraMode = options.extraMode ?? normalizeExtraExportMode(core?.extraExportMode ?? project.novelConfig.extraExportMode)
    const includeIf = options.includeIf !== false
    const documents = layoutExportDocuments(project.name, chapterContents, branches, extraMode, includeIf)

    if (documents.length === 0) {
      return { success: false, error: t('export.noFinalizedChapters') }
    }

    addLog('info', t('export.foundChapters', { count: chapterContents.length }))

    await ipc.invoke('fs:mkdir', options.outputDir)

    const paths: string[] = []
    const outline = options.includeOutline ? (core?.synopsis || '') : ''
    const mdHeader = (stem: string) => {
      let h = `# ${stem}\n\n`
      h += `> ${project.novelConfig.genre} · ${project.novelConfig.targetAudience}\n\n---\n\n`
      return h
    }
    const txtHeader = (stem: string) => `${stem}\n${'='.repeat(Math.max(4, stem.length * 2))}\n\n`

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i]
      const isMain = !doc.fileStem.includes('·IF·') && !doc.fileStem.includes('·番外·')
      const outlineBlock = isMain && outline ? `${outline}\n\n---\n\n` : ''

      switch (options.format) {
        case 'merged-md':
          paths.push(await writeMergedMd(doc, options.outputDir, mdHeader(doc.fileStem) + outlineBlock))
          break
        case 'split-md':
          paths.push(await writeSplitMd(doc, options.outputDir))
          break
        case 'txt':
          paths.push(await writeTxt(doc, options.outputDir, txtHeader(doc.fileStem) + (isMain && outline ? `${toPlainText(outline)}\n\n` : '')))
          break
        case 'epub': {
          const res = await writeEpub(doc, options.outputDir, {
            author: options.author?.trim() || '佚名',
            outline: isMain ? outline : '',
          })
          if (res.error) return { success: false, error: res.error }
          paths.push(res.path)
          break
        }
      }
    }

    const outputPath = paths.length === 1 ? paths[0] : options.outputDir
    addLog('info', t('export.exportComplete', { path: outputPath }))
    return { success: true, path: outputPath }
  } catch (error) {
    addLog('error', t('export.exportFailed', { error: String(error) }))
    return { success: false, error: String(error) }
  }
}

function formatLabel(format: ExportFormat): string {
  const labels: Record<ExportFormat, string> = {
    'merged-md': t('export.formatMergedMd'),
    'split-md': t('export.formatSplitMd'),
    'txt': t('export.formatTxt'),
    'epub': t('export.formatEpub'),
  }
  return labels[format]
}
