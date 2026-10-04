/**
 * 导出服务 — 将小说项目导出为多种格式
 *
 * 支持：
 * - 合并 Markdown（全书合并为单个 .md）
 * - 分章 Markdown（每章一个 .md）
 * - 纯文本 TXT
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
import i18n from '../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'dialogs', ...opts })


export type ExportFormat = 'merged-md' | 'split-md' | 'txt' | 'epub'

interface ExportOptions {
  format: ExportFormat
  outputDir: string
  includeOutline?: boolean
  includeCharacters?: boolean
  /** EPUB 作者（仅 epub 使用；为空则记为「佚名」） */
  author?: string
}

/** 导出全书 */
export async function exportNovel(options: ExportOptions): Promise<{ success: boolean; path?: string; error?: string }> {
  const project = useProjectStore.getState().currentProject
  if (!project) return { success: false, error: t('export.noProjectError') }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', `📦 开始导出（${formatLabel(options.format)}）...`)

  try {
    // 遍历所有章节蓝图，取定稿内容
    const chapterContents: Array<{ name: string; title: string; chapterNumber: number; content: string }> = []
    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as unknown as Array<Record<string, unknown>>
    const sortedBps = blueprints ? blueprints.sort((a, b) => (a.chapterNumber as number) - (b.chapterNumber as number)) : []

    for (const bp of sortedBps) {
      const meta = await ipc.invoke('db:draft-get-finalized', bp.chapterNumber as number)
      if (meta && (meta as { id: number }).id !== undefined) {
        const full = await ipc.invoke('db:draft-get-full', (meta as { id: number }).id)
        if (full && (full as { content?: string }).content) {
          chapterContents.push({
            name: `chapter_${bp.chapterNumber}.md`,
            title: (bp.title as string) || `第${bp.chapterNumber}章`,
            chapterNumber: bp.chapterNumber as number,
            content: (full as { content: string }).content,
          })
        }
      }
    }

    if (chapterContents.length === 0) {
      return { success: false, error: t('export.noFinalizedChapters') }
    }

    addLog('info', t('export.foundChapters', { count: chapterContents.length }))

    // 确保输出目录存在
    await mkdirOrThrow(options.outputDir)

    // 项目名用作文件名：替换路径分隔符等非法字符，避免写到所选目录之外
    const baseName = toFileNameSegment(project.name)
    let outputPath = ''

    switch (options.format) {
      case 'merged-md': {
        // 合并为单个 Markdown
        let content = `# ${project.name}\n\n`
        content += `> ${project.novelConfig.genre} · ${project.novelConfig.targetAudience}\n\n---\n\n`

        // 可选：包含大纲
        if (options.includeOutline) {
          const core = await ipc.invoke('db:project-core-get')
          if (core?.synopsis) {
            content += core.synopsis + '\n\n---\n\n'
          }
        }

        // 章节内容
        for (const ch of chapterContents) {
          content += ch.content + '\n\n---\n\n'
        }

        outputPath = `${options.outputDir}/${baseName}.md`
        await writeOrThrow(outputPath, content)
        break
      }

      case 'split-md': {
        // 每章一个 Markdown
        const splitDir = `${options.outputDir}/${baseName}`
        await mkdirOrThrow(splitDir)

        for (const ch of chapterContents) {
          await writeOrThrow(`${splitDir}/${ch.name}`, ch.content)
        }

        outputPath = splitDir
        break
      }

      case 'txt': {
        // 纯文本（去除 Markdown 格式）
        let content = `${project.name}\n${'='.repeat(project.name.length * 2)}\n\n`

        for (const ch of chapterContents) {
          // 简单去除 Markdown 标记
          const plainText = ch.content
            .replace(/^#{1,6}\s+/gm, '')  // 去掉标题标记
            .replace(/\*\*(.*?)\*\*/g, '$1')  // 去掉加粗
            .replace(/\*(.*?)\*/g, '$1')  // 去掉斜体
            .replace(/`(.*?)`/g, '$1')  // 去掉代码标记
            .replace(/---+/g, '\n')  // 分隔线
            .trim()

          content += plainText + '\n\n'
        }

        outputPath = `${options.outputDir}/${baseName}.txt`
        await writeOrThrow(outputPath, content)
        break
      }

      case 'epub': {
        // 组装章节（标题 = 「第N章 蓝图标题」）
        const chapters: Array<{ title: string; content: string }> = []

        // 可选：把故事简介作为首章
        if (options.includeOutline) {
          const core = await ipc.invoke('db:project-core-get')
          if (core?.synopsis?.trim()) {
            chapters.push({ title: '内容简介', content: core.synopsis.trim() })
          }
        }

        for (const ch of chapterContents) {
          chapters.push({
            title: `第${ch.chapterNumber}章 ${ch.title}`.trim(),
            content: ch.content,
          })
        }

        outputPath = `${options.outputDir}/${baseName}.epub`
        const res = await ipc.invoke('export:epub', {
          title: project.name,
          author: options.author?.trim() || '佚名',
          language: 'zh-CN',
          outputPath,
          chapters,
        })
        if (!res.success) {
          return { success: false, error: res.error || 'EPUB 生成失败' }
        }
        break
      }
    }

    addLog('info', t('export.exportComplete', { path: outputPath }))
    return { success: true, path: outputPath }
  } catch (error) {
    addLog('error', t('export.exportFailed', { error: String(error) }))
    return { success: false, error: String(error) }
  }
}

/** fs:write-file 失败时只返回 success:false，不会抛异常；这里转成异常，免得把写失败报成导出成功 */
async function writeOrThrow(filePath: string, content: string): Promise<void> {
  const res = await ipc.invoke('fs:write-file', filePath, content)
  if (!res?.success) throw new Error(res?.error || filePath)
}

async function mkdirOrThrow(dirPath: string): Promise<void> {
  const res = await ipc.invoke('fs:mkdir', dirPath)
  if (!res?.success) throw new Error(res?.error || dirPath)
}

/** 把名称转成单段文件名：替换路径分隔符与 Windows 非法字符，去掉结尾的点和空格 */
function toFileNameSegment(name: string): string {
  const cleaned = Array.from(name, (ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned || 'novel'
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
