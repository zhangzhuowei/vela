/**
 * CharacterRepository — 角色卡 (characters 表)
 *
 * currentState 子结构已拍平为 cs_* 前缀列，杜绝 JSON 大字段。
 */
import { getProjectDb } from '../database'
import { safeUnlinkImage } from '../utils/image-file'

/** 角色卡动态状态 */
export interface CharacterStateData {
    location: string
    powerLevel: string
    physicalState: string
    mentalState: string
    keyItems: string
    recentEvents: string
    knownInfo?: string
    updatedAtChapter: number
}

/** 角色卡完整数据（前端驼峰接口） */
export interface CharacterData {
    name: string
    role: string
    gender: string
    age: string
    appearance: string
    personality: string
    background: string
    abilities: string
    motivation: string
    relationships: string
    arc: string
    notes: string
    speechStyle?: string
    /** 角色专属文生图提示词（手工补充外观特征，用于修正 AI 对角色形象的误判） */
    imagePrompt?: string
    portraitPath?: string
    currentState?: CharacterStateData
}

function rowToData(row: Record<string, unknown>): CharacterData {
    const data: CharacterData = {
        name: row.name as string,
        role: (row.role as string) || 'supporting',
        gender: (row.gender as string) || '',
        age: (row.age as string) || '',
        appearance: (row.appearance as string) || '',
        personality: (row.personality as string) || '',
        background: (row.background as string) || '',
        abilities: (row.abilities as string) || '',
        motivation: (row.motivation as string) || '',
        relationships: (row.relationships as string) || '',
        arc: (row.arc as string) || '',
        notes: (row.notes as string) || '',
        speechStyle: (row.speech_style as string) || '',
        imagePrompt: (row.image_prompt as string) || '',
        portraitPath: (row.portrait_path as string) || '',
    }

    // 只有当 cs_updated_at_chapter > 0 时才构建 currentState
    const updatedChapter = row.cs_updated_at_chapter as number
    if (updatedChapter > 0) {
        data.currentState = {
            location: (row.cs_location as string) || '',
            powerLevel: (row.cs_power_level as string) || '',
            physicalState: (row.cs_physical_state as string) || '',
            mentalState: (row.cs_mental_state as string) || '',
            keyItems: (row.cs_key_items as string) || '',
            recentEvents: (row.cs_recent_events as string) || '',
            knownInfo: (row.cs_known_info as string) || '',
            updatedAtChapter: updatedChapter,
        }
    }

    return data
}

export class CharacterRepository {
    /** 获取所有角色（按角色定位排序：主角→配角→反派→龙套） */
    static getAll(): CharacterData[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM characters
      ORDER BY
        CASE role
          WHEN 'protagonist' THEN 0
          WHEN 'supporting' THEN 1
          WHEN 'antagonist' THEN 2
          WHEN 'minor' THEN 3
          ELSE 9
        END ASC
    `).all() as Record<string, unknown>[]

        return rows.map(rowToData)
    }

    /** 获取单个角色 */
    static getByName(name: string): CharacterData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM characters WHERE name = ?'
        ).get(name) as Record<string, unknown> | undefined

        return row ? rowToData(row) : null
    }

    /** 获取角色数量 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM characters'
        ).get() as { cnt: number }

        return row.cnt
    }

    /** 插入或更新角色 */
    static upsert(data: CharacterData): void {
        const db = getProjectDb()
        if (!db) return

        // 人设图路径：传入为空时保留库中已有值，避免重新提取角色卡（不含 portraitPath）抹掉已生成的人设图。
        // 人设图在 UI 上只有「生成/重新生成」、没有手动清除入口，故空传一律视为「未改动」而非「清空」。
        // 传入非空且与旧图不同时视为真实替换，写入后清理旧文件。
        // 注：speech_style 是可手动编辑清空的文本框，不能空则保留，保持按传入值写入。
        const prev = db.prepare(`SELECT portrait_path FROM characters WHERE name = ?`).get(data.name) as { portrait_path: string } | undefined
        const oldPortrait = prev?.portrait_path || ''
        const incomingPortrait = data.portraitPath ?? ''
        const effectivePortrait = incomingPortrait || oldPortrait

        const cs = data.currentState
        db.prepare(`
      INSERT INTO characters (
        name, role, gender, age, appearance, personality, background,
        abilities, motivation, relationships, arc, notes, speech_style, image_prompt, portrait_path,
        cs_location, cs_power_level, cs_physical_state, cs_mental_state,
        cs_key_items, cs_recent_events, cs_known_info, cs_updated_at_chapter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        role = excluded.role,
        gender = excluded.gender,
        age = excluded.age,
        appearance = excluded.appearance,
        personality = excluded.personality,
        background = excluded.background,
        abilities = excluded.abilities,
        motivation = excluded.motivation,
        relationships = excluded.relationships,
        arc = excluded.arc,
        notes = excluded.notes,
        speech_style = excluded.speech_style,
        image_prompt = excluded.image_prompt,
        portrait_path = excluded.portrait_path,
        cs_location = excluded.cs_location,
        cs_power_level = excluded.cs_power_level,
        cs_physical_state = excluded.cs_physical_state,
        cs_mental_state = excluded.cs_mental_state,
        cs_key_items = excluded.cs_key_items,
        cs_recent_events = excluded.cs_recent_events,
        cs_known_info = excluded.cs_known_info,
        cs_updated_at_chapter = excluded.cs_updated_at_chapter,
        updated_at = datetime('now')
    `).run(
            data.name,
            data.role,
            data.gender,
            data.age,
            data.appearance,
            data.personality,
            data.background,
            data.abilities,
            data.motivation,
            data.relationships,
            data.arc,
            data.notes,
            data.speechStyle ?? '',
            data.imagePrompt ?? '',
            effectivePortrait,
            cs?.location ?? '',
            cs?.powerLevel ?? '',
            cs?.physicalState ?? '',
            cs?.mentalState ?? '',
            cs?.keyItems ?? '',
            cs?.recentEvents ?? '',
            cs?.knownInfo ?? '',
            cs?.updatedAtChapter ?? 0,
        )

        if (oldPortrait && incomingPortrait && oldPortrait !== incomingPortrait) {
            safeUnlinkImage(oldPortrait)
        }
    }

    /** 批量保存角色（事务） */
    static saveAll(characters: CharacterData[]): void {
        const db = getProjectDb()
        if (!db) return

        const tx = db.transaction(() => {
            for (const char of characters) {
                CharacterRepository.upsert(char)
            }
        })
        tx()
    }

    /** 删除角色（连带清理其人设图磁盘文件） */
    static delete(name: string): void {
        const db = getProjectDb()
        if (!db) return

        const old = db.prepare(`SELECT portrait_path FROM characters WHERE name = ?`).get(name) as { portrait_path: string } | undefined
        db.prepare('DELETE FROM characters WHERE name = ?').run(name)
        if (old?.portrait_path) safeUnlinkImage(old.portrait_path)
    }

    /** 仅更新角色动态状态（后处理时使用） */
    static updateState(name: string, state: CharacterStateData): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE characters SET
        cs_location = ?, cs_power_level = ?, cs_physical_state = ?,
        cs_mental_state = ?, cs_key_items = ?, cs_recent_events = ?,
        cs_known_info = ?, cs_updated_at_chapter = ?, updated_at = datetime('now')
      WHERE name = ?
    `).run(
            state.location,
            state.powerLevel,
            state.physicalState,
            state.mentalState,
            state.keyItems,
            state.recentEvents,
            state.knownInfo ?? '',
            state.updatedAtChapter,
            name,
        )
    }

    /** 仅更新说话风格/口癖（定稿自动推断时使用，用于初始化空档案） */
    static updateSpeechStyle(name: string, speechStyle: string): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(
            `UPDATE characters SET speech_style = ?, updated_at = datetime('now') WHERE name = ?`
        ).run(speechStyle, name)
    }

    /** 仅更新人设图路径（文生图生成后持久化，避免整卡 upsert 覆盖） */
    static updatePortrait(name: string, portraitPath: string): void {
        const db = getProjectDb()
        if (!db) return

        // 取旧图路径，替换后清理磁盘文件，避免孤儿人设图堆积
        const old = db.prepare(`SELECT portrait_path FROM characters WHERE name = ?`).get(name) as { portrait_path: string } | undefined
        db.prepare(
            `UPDATE characters SET portrait_path = ?, updated_at = datetime('now') WHERE name = ?`
        ).run(portraitPath, name)
        if (old?.portrait_path && old.portrait_path !== portraitPath) {
            safeUnlinkImage(old.portrait_path)
        }
    }
}
