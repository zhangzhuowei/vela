/**
 * 从已有工程抽出「设定种子」：小说配置 + 故事架构四大件。
 * 不含章节蓝图、草稿、对话场、角色卡表、知识库。
 */

export type ProjectSeed = {
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  plotStructure: string
  narrativePov: string
  writingStyle: string
  styleReference: string
  referenceWorks: string
  artStyle: string
  negativePrompt: string
  globalGuidance: string
  goldenFinger: string
  coreOutline: string
  worldSetting: string
  protagonistProfile: string
  premise: string
  worldbuilding: string
  charactersArch: string
  synopsis: string
  creationMode: string
  multilineMode: string
  scenePreludeMode: string
  optionHintsEnabled: boolean
  optionHintsCount: number
  optionHintsMaxChars: number
  chapterEnding: string
}

export function pickProjectSeed(core: Partial<ProjectSeed> & { characterStates?: string; projectName?: string }): ProjectSeed {
  return {
    genre: core.genre ?? '',
    subGenre: core.subGenre ?? '',
    targetAudience: core.targetAudience ?? '',
    totalChapters: core.totalChapters ?? 100,
    wordsPerChapter: core.wordsPerChapter ?? 3000,
    plotStructure: core.plotStructure ?? 'three_act',
    narrativePov: core.narrativePov ?? 'third_limited',
    writingStyle: core.writingStyle ?? '',
    styleReference: core.styleReference ?? '',
    referenceWorks: core.referenceWorks ?? '',
    artStyle: core.artStyle ?? '',
    negativePrompt: core.negativePrompt ?? '',
    globalGuidance: core.globalGuidance ?? '',
    goldenFinger: core.goldenFinger ?? '',
    coreOutline: core.coreOutline ?? '',
    worldSetting: core.worldSetting ?? '',
    protagonistProfile: core.protagonistProfile ?? '',
    premise: core.premise ?? '',
    worldbuilding: core.worldbuilding ?? '',
    charactersArch: core.charactersArch ?? '',
    synopsis: core.synopsis ?? '',
    creationMode: core.creationMode ?? 'pipeline',
    multilineMode: core.multilineMode ?? 'off',
    scenePreludeMode: core.scenePreludeMode ?? 'chapter_summaries',
    optionHintsEnabled: core.optionHintsEnabled ?? false,
    optionHintsCount: core.optionHintsCount ?? 3,
    optionHintsMaxChars: core.optionHintsMaxChars ?? 24,
    chapterEnding: core.chapterEnding === 'smooth' ? 'smooth' : 'cliffhanger',
  }
}

export function defaultCloneName(sourceName: string): string {
  const base = sourceName.trim() || '未命名'
  return /(?:副本|copy)$/i.test(base) ? `${base} 2` : `${base} 副本`
}

export function parentDir(projectPath: string): string {
  return projectPath.replace(/[\\/][^\\/]+$/, '') || projectPath
}
