import type { PromptTemplate } from '../prompt-templates'
import { BUILTIN_PROMPTS } from '../prompt-templates'

/**
 * 基础抽象 Prompt 建造者
 * 用于安全地拼装 LLM 生成所需的不可变上下文片段，避免漏传变量。
 */
export class BasePromptBuilder {
  protected template: PromptTemplate;
  protected variables: Record<string, string> = {};

  /**
   * 注入叙事一致性 Canon 上下文，所有 Builder 子类均可使用。模板应预留 {{canon_context}} 变量。
   */
  withCanonContext(renderedCanon: string) {
    this.variables.canon_context = renderedCanon;
    return this;
  }

  constructor(template: PromptTemplate) {
    this.template = template;
  }

  /** 获取模板定义的 system role（LLM system message 角色定位） */
  public getSystemRole(): string {
    return this.template.systemRole || ''
  }

  /** 打包输出最终经过所有合法性替换的字符串 */
  public build(): string {
    let result = this.template.content
    // 修复：转义 value 中的 {{xxx}}，防止再次被 replaceAll 替换（prompt injection）
    const escapeTemplateVars = (v: string) =>
      (v || '').toString().replace(/\{\{/g, '⦃⦃').replace(/\}\}/g, '⦄⦄')
    for (const [key, value] of Object.entries(this.variables)) {
      // 使用 replaceAll 避免正则注入风险，安全替换所有匹配项
      const safeValue = escapeTemplateVars(value)
      result = result.replaceAll(`{{${key}}}`, safeValue)
    }

    // 自动追加 systemSuffix（始终从内置模板获取，与 renderPrompt 行为对齐）
    const builtinTemplate = BUILTIN_PROMPTS.find(p => p.key === this.template.key)
    const suffix = builtinTemplate?.systemSuffix
    if (suffix) {
      let renderedSuffix = suffix
      for (const [key, value] of Object.entries(this.variables)) {
        renderedSuffix = renderedSuffix.replaceAll(`{{${key}}}`, escapeTemplateVars(value))
      }
      result = result + '\n\n' + renderedSuffix
    }

    // 空变量段落裁剪：清除可选变量为空时残留的空标签段落
    result = result
      .replace(/\n★【[^】]*】★[：:]\s*\n?\s*$/gm, '')
      .replace(/\n【[^】]*（如有[^）]*）[^】]*】\s*\n?\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')

    // 防御性校验：检查是否有未处理的模板占位符
    const missing = result.match(/\{\{.*?\}\}/g)
    if (missing) {
      console.warn(`[PromptBuilder] 警告：模板 "${this.template.name}" 中有未赋值的变量残留:`, missing)
    }
    return result
  }
}

/**
 * 章节生成专用 Builder
 * 提供全链条上下文强类型注入，拒绝 raw Record<string,string> 的 "盲打模式"
 */
export class ChapterPromptBuilder extends BasePromptBuilder {
  
  withArchitecture(architecture: string) {
    this.variables.architecture = architecture;
    return this;
  }

  withGlobalSummary(globalSummary: string) {
    this.variables.global_summary = globalSummary;
    return this;
  }

  withCharacterStates(characterStates: string) {
    this.variables.character_states = characterStates;
    return this;
  }

  withShortSummary(shortSummary: string) {
    this.variables.short_summary = shortSummary;
    return this;
  }

  withPreviousEnding(previousEnding: string) {
    this.variables.previous_ending = previousEnding;
    return this;
  }

  withChapterInfo(chapterInfo: string | object) {
    this.variables.chapter_info = typeof chapterInfo === 'string' 
      ? chapterInfo 
      : JSON.stringify(chapterInfo, null, 2);
    return this;
  }

  withFutureBlueprints(futureBlueprints: string) {
    this.variables.future_blueprints = futureBlueprints;
    return this;
  }

  withUserGuidance(userGuidance: string) {
    this.variables.user_guidance = userGuidance;
    return this;
  }

  withFilteredContext(filteredContext: string) {
    this.variables.filtered_context = filteredContext;
    return this;
  }

  withGlobalGuidance(globalGuidance: string) {
    this.variables.global_guidance = globalGuidance;
    return this;
  }

  withNovelConfig(novelConfig: string | object) {
    this.variables.novel_config = typeof novelConfig === 'string' 
      ? novelConfig 
      : JSON.stringify(novelConfig, null, 2);
    return this;
  }

  /**
   * 注入目标字数，并同时派生「硬下限 / 上限」区间变量。
   *
   * 原实现只注入 {{word_number}}，模板措辞为"大约 N 字左右"，属于弱约束；
   * 与紧随其后的"切忌注水/达成目标即断章"叠加后，模型会系统性地朝下方偏离，
   * 实测目标 2500 字仅产出 1100~1300 字。派生出显式区间供模板做硬性下限表述。
   */
  withWordNumber(wordNumber: number | string) {
    this.variables.word_number = String(wordNumber);
    const n = Number(wordNumber)
    if (Number.isFinite(n) && n > 0) {
      this.variables.word_number_min = String(Math.round(n * 0.95))
      this.variables.word_number_max = String(Math.round(n * 1.25))
    } else {
      this.variables.word_number_min = String(wordNumber)
      this.variables.word_number_max = String(wordNumber)
    }
    return this;
  }

  withDraftContent(draftContent: string) {
    this.variables.draft_content = draftContent;
    return this;
  }

  withUserRefinePrompt(userRefinePrompt: string) {
    this.variables.user_refine_prompt = userRefinePrompt;
    return this;
  }

  withReviewReport(reviewReport: string) {
    this.variables.review_report = reviewReport;
    return this;
  }

  /** 文风描述（注入写稿/修稿 Prompt） */
  withWritingStyle(style: string) {
    this.variables.writing_style = style;
    return this;
  }

  /** 去AI味清洗强度（轻/中/重） */
  withIntensity(intensity: string) {
    this.variables.intensity = intensity;
    return this;
  }

  /** 用户指定的知识库检索关键词（追加到向量搜索 query） */
  withKnowledgeQueryHint(hint: string) {
    this.variables.knowledge_query_hint = hint;
    return this;
  }

  /** 未回收伏笔清单（注入写稿 Prompt） */
  withForeshadowing(text: string) {
    this.variables.foreshadowing = text;
    return this;
  }

  /** 近期章节开场/断章速览（用于跨章反雷同） */
  withAntiRepetition(text: string) {
    this.variables.anti_repetition = text;
    return this;
  }

  /** 出场角色说话风格/口癖（用于对白一致性） */
  withCharacterVoices(text: string) {
    this.variables.character_voices = text;
    return this;
  }

  /** 作者文风指纹（从样章提炼，用于文笔向作者靠拢） */
  withStyleReference(text: string) {
    this.variables.style_reference = text;
    return this;
  }
}

/**
 * 审稿/审查专用 Builder
 */
export class ReviewPromptBuilder extends BasePromptBuilder {
  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  withCharacterStates(states: string) {
    this.variables.character_states = states;
    return this;
  }

  withGlobalSummary(summary: string) {
    this.variables.global_summary = summary;
    return this;
  }

  withWorldBuilding(world: string) {
    this.variables.world_building = world;
    return this;
  }

  /** 审稿维度侧重点（角色一致性/世界观合理性/剧情逻辑等） */
  withReviewFocus(focus: string) {
    this.variables.review_focus = focus;
    return this;
  }

  /** 已知未回收伏笔清单（供审稿核对伏笔完整性） */
  withForeshadowing(text: string) {
    this.variables.foreshadowing = text;
    return this;
  }
}

/**
 * 定稿后处理专项 Builder
 */
export class PostProcessPromptBuilder extends BasePromptBuilder {
  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  withChapterNumber(num: string | number) {
    this.variables.chapter_number = String(num);
    return this;
  }

  withChapterTitle(title: string) {
    this.variables.chapter_title = title;
    return this;
  }

  withExistingCardsJson(json: string | object) {
    this.variables.existing_cards_json = typeof json === 'string'
      ? json
      : JSON.stringify(json, null, 2);
    return this;
  }

  /** 当前未回收伏笔清单 JSON（供伏笔抽取识别回收） */
  withOpenForeshadowings(json: string | object) {
    this.variables.open_foreshadowings = typeof json === 'string'
      ? json
      : JSON.stringify(json, null, 2);
    return this;
  }
}

/**
 * 架构生成与逆向推演 Builders
 */
export class ArchitecturePromptBuilder extends BasePromptBuilder {
  withGenre(genre: string) {
    this.variables.genre = genre;
    return this;
  }
  
  withSubGenre(subGenre: string) {
    this.variables.sub_genre = subGenre;
    return this;
  }

  withTopic(topic: string) {
    this.variables.topic = topic;
    return this;
  }

  withTargetAudience(audience: string) {
    this.variables.target_audience = audience;
    return this;
  }

  withNumberOfChapters(num: string | number) {
    this.variables.number_of_chapters = String(num);
    return this;
  }

  withWordNumber(num: string | number) {
    this.variables.word_number = String(num);
    return this;
  }

  withCoreSetting(setting: string) {
    this.variables.core_setting = setting;
    return this;
  }

  withGoldenFinger(finger: string) {
    this.variables.golden_finger = finger;
    return this;
  }

  withProtagonistProfile(profile: string) {
    this.variables.protagonist_profile = profile;
    return this;
  }

  withGlobalGuidance(guidance: string) {
    this.variables.global_guidance = guidance;
    return this;
  }

  withCoreSeed(seed: string) {
    this.variables.premise = seed;
    return this;
  }

  withCharacterDynamics(dynamics: string) {
    this.variables.character_dynamics = dynamics;
    return this;
  }

  withWorldBuilding(world: string) {
    this.variables.world_building = world;
    return this;
  }

  withPlotStructureGuide(guide: string) {
    this.variables.plot_structure_guide = guide;
    return this;
  }

  withNarrativePov(pov: string) {
    this.variables.narrative_pov = pov;
    return this;
  }
  
  withUserIdea(idea: string) {
    this.variables.user_idea = idea;
    return this;
  }

  /** 逐步指导（每步可选的补充说明） */
  withStepGuidance(guidance: string) {
    this.variables.step_guidance = guidance;
    return this;
  }

  /** 参考作品 */
  withReferenceWorks(works: string) {
    this.variables.reference_works = works;
    return this;
  }
}

/**
 * 目录细纲生成 Builders
 */
export class DirectoryPromptBuilder extends BasePromptBuilder {
  withNovelArchitecture(arch: string) {
    this.variables.novel_architecture = arch;
    return this;
  }

  withNumberOfChapters(num: string | number) {
    this.variables.number_of_chapters = String(num);
    return this;
  }

  withGlobalGuidance(guidance: string) {
    this.variables.global_guidance = guidance;
    return this;
  }

  withGenre(genre: string) {
    this.variables.genre = genre;
    return this;
  }

  withChapterList(list: string) {
    this.variables.chapter_list = list;
    return this;
  }

  withN(n: string | number) {
    this.variables.n = String(n);
    return this;
  }

  withM(m: string | number) {
    this.variables.m = String(m);
    return this;
  }

  /** 节奏/风格指导（如"前30章快节奏，每章一爽点"） */
  withPacingGuidance(guidance: string) {
    this.variables.pacing_guidance = guidance;
    return this;
  }
}

/**
 * 导入小说专用 Builder
 * 用于逆向推演（向量采样增强版配置推演 & 单章蓝图推演）
 */
export class ImportPromptBuilder extends BasePromptBuilder {
  /** 向量检索：世界观与力量体系片段 */
  withSampledWorldview(content: string) {
    this.variables.sampled_worldview = content;
    return this;
  }

  /** 向量检索：主角设定与金手指片段 */
  withSampledProtagonist(content: string) {
    this.variables.sampled_protagonist = content;
    return this;
  }

  /** 向量检索：核心矛盾与敌对势力片段 */
  withSampledConflict(content: string) {
    this.variables.sampled_conflict = content;
    return this;
  }

  /** 向量检索：写作风格与叙事视角片段 */
  withSampledStyle(content: string) {
    this.variables.sampled_style = content;
    return this;
  }

  /** 第一章正文 */
  withFirstChapter(content: string) {
    this.variables.first_chapter = content;
    return this;
  }

  /** 最新一章正文 */
  withLatestChapter(content: string) {
    this.variables.latest_chapter = content;
    return this;
  }

  /** 已有总章数 */
  withTotalChapters(num: number | string) {
    this.variables.total_chapters = String(num);
    return this;
  }

  /** 本章正文全文（单章蓝图推演用） */
  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  /** 章节序号 */
  withChapterNumber(num: number | string) {
    this.variables.chapter_number = String(num);
    return this;
  }

  /** 章节标题 */
  withChapterTitle(title: string) {
    this.variables.chapter_title = title;
    return this;
  }

  /** 全局配置脱水版 */
  withNovelConfigSummary(summary: string) {
    this.variables.novel_config_summary = summary;
    return this;
  }

  /** 旧版兼容：sample_content（infer_novel_config 原始 Prompt 用） */
  withSampleContent(content: string) {
    this.variables.sample_content = content;
    return this;
  }
}
