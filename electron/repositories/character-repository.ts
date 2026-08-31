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

    /**
     * 重命名角色（原地改主键 name，避免改名被当成新卡插入而产生重复）。
     * - oldName 与 newName 相同：无操作。
     * - 目标名已被别的卡占用：抛错，交由上层处理，绝不覆盖或制造重复。
     * - 角色卡自身按名字引用的数据（cs_* 动态状态、人设图路径等）都在同一行上，
     *   改主键即整行迁移，无需额外搬运。
     * - 叙事一致性 canon 各表按名字引用该角色（状态表主键、时间线/剧情线/事实的
     *   characters 数组、其他角色的关系键），必须在同一事务内一并迁移，
     *   否则改名后 Canon 按新名查不到状态、写回又按新名另起一行，状态从此分裂。
     */
    static rename(oldName: string, newName: string): void {
        const db = getProjectDb()
        if (!db) return
        if (!oldName || !newName || oldName === newName) return

        const clash = db.prepare('SELECT 1 FROM characters WHERE name = ?').get(newName)
        if (clash) {
            throw new Error(`角色名「${newName}」已存在，无法改名`)
        }
        const exists = db.prepare('SELECT 1 FROM characters WHERE name = ?').get(oldName)
        if (!exists) return

        const tx = db.transaction(() => {
            db.prepare(
                `UPDATE characters SET name = ?, updated_at = datetime('now') WHERE name = ?`
            ).run(newName, oldName)
            CharacterRepository.renameInCanon(db, oldName, newName)
        })
        tx()
    }

    /**
     * 把 canon 各表中对角色名的引用从 oldName 迁移到 newName。
     * 只迁移结构化引用（主键、JSON 数组成员、关系键）；
     * 摘要/事实陈述等自由文本里的名字不做替换（文本替换易误伤同名子串）。
     */
    private static renameInCanon(db: NonNullable<ReturnType<typeof getProjectDb>>, oldName: string, newName: string): void {
        // 1) 角色状态表：主键行迁移
        type StateRow = {
            character: string
            location: string; power_level: string; physical_state: string; mental_state: string
            key_items: string; current_goal: string; knowledge_json: string
            relationships_json: string; recent_events: string; updated_at_chapter: number
        }
        const oldState = db.prepare('SELECT * FROM canon_character_state WHERE character = ?').get(oldName) as StateRow | undefined
        if (oldState) {
            const target = db.prepare('SELECT * FROM canon_character_state WHERE character = ?').get(newName) as StateRow | undefined
            if (!target) {
                db.prepare(
                    `UPDATE canon_character_state SET character = ?, updated_at = datetime('now') WHERE character = ?`
                ).run(newName, oldName)
            } else {
                // 两名并存（历史写回曾按新名另建过一行）：合并后删除旧名行。
                // 标量字段以更新章较大的一方为准、空值从另一方补齐；知识取并集、关系合并
                const parseArr = (s: string): string[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
                const parseObj = (s: string): Record<string, string> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
                const primary = (target.updated_at_chapter || 0) >= (oldState.updated_at_chapter || 0) ? target : oldState
                const secondary = primary === target ? oldState : target
                const pick = (f: keyof StateRow) => (primary[f] as string) || (secondary[f] as string) || ''
                const knowledge = Array.from(new Set([...parseArr(secondary.knowledge_json), ...parseArr(primary.knowledge_json)]))
                const relationships = { ...parseObj(secondary.relationships_json), ...parseObj(primary.relationships_json) }
                db.prepare(`
          UPDATE canon_character_state SET
            location = ?, power_level = ?, physical_state = ?, mental_state = ?,
            key_items = ?, current_goal = ?, knowledge_json = ?, relationships_json = ?,
            recent_events = ?, updated_at_chapter = ?, updated_at = datetime('now')
          WHERE character = ?
        `).run(
                    pick('location'), pick('power_level'), pick('physical_state'), pick('mental_state'),
                    pick('key_items'), pick('current_goal'), JSON.stringify(knowledge), JSON.stringify(relationships),
                    pick('recent_events'), Math.max(target.updated_at_chapter || 0, oldState.updated_at_chapter || 0),
                    newName,
                )
                db.prepare('DELETE FROM canon_character_state WHERE character = ?').run(oldName)
            }
        }

        // 2) characters JSON 数组成员替换（LIKE 预筛可能有误报，JS 内精确比对）
        for (const table of ['canon_timeline_events', 'canon_plot_lines', 'canon_facts']) {
            const rows = db.prepare(
                `SELECT id, characters FROM ${table} WHERE characters LIKE ?`
            ).all(`%${oldName}%`) as Array<{ id: number; characters: string }>
            const upd = db.prepare(`UPDATE ${table} SET characters = ? WHERE id = ?`)
            for (const row of rows) {
                try {
                    const arr = JSON.parse(row.characters || '[]')
                    if (!Array.isArray(arr) || !arr.includes(oldName)) continue
                    const next = Array.from(new Set(arr.map((n: string) => (n === oldName ? newName : n))))
                    upd.run(JSON.stringify(next), row.id)
                } catch { /* 单行 JSON 损坏不阻断改名 */ }
            }
        }

        // 3) 其他角色关系映射中以 oldName 为键的条目
        const relRows = db.prepare(
            `SELECT character, relationships_json FROM canon_character_state WHERE relationships_json LIKE ?`
        ).all(`%${oldName}%`) as Array<{ character: string; relationships_json: string }>
        const updRel = db.prepare(`UPDATE canon_character_state SET relationships_json = ? WHERE character = ?`)
        for (const row of relRows) {
            try {
                const rel = JSON.parse(row.relationships_json || '{}') as Record<string, string>
                if (!rel || typeof rel !== 'object' || Array.isArray(rel) || !(oldName in rel)) continue
                const moved = rel[oldName]
                delete rel[oldName]
                // 新名键已存在时保留既有值（来自更近的写回）
                if (!(newName in rel)) rel[newName] = moved
                updRel.run(JSON.stringify(rel), row.character)
            } catch { /* 单行 JSON 损坏不阻断改名 */ }
        }
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
