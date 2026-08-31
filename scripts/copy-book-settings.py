# 一次性脚本：把《小马宝莉同人文》的设定复制进《小马宝莉破甲》
# 复制：project_core 配置与架构四大件、全部角色卡（静态字段）
# 不复制：章节蓝图/草稿/canon/伏笔（剧情进度），角色动态状态清零
import sqlite3

SRC = r"E:\Novels\小马宝莉同人文\.vela\vela.db"
DST = r"E:\Novels\小马宝莉破甲\.vela\vela.db"

CORE_FIELDS = [
    "genre", "sub_genre", "target_audience", "total_chapters", "words_per_chapter",
    "plot_structure", "narrative_pov", "writing_style", "style_reference",
    "reference_works", "art_style", "negative_prompt", "global_guidance",
    "golden_finger", "core_outline", "world_setting", "protagonist_profile",
    "premise", "worldbuilding", "characters_arch", "synopsis",
]

CHAR_STATIC = [
    "name", "role", "gender", "age", "appearance", "personality", "background",
    "abilities", "motivation", "relationships", "arc", "notes", "speech_style",
    "image_prompt",
]

src = sqlite3.connect(SRC)
src.row_factory = sqlite3.Row
dst = sqlite3.connect(DST)

core = src.execute(f"SELECT {', '.join(CORE_FIELDS)} FROM project_core WHERE id = 'main'").fetchone()
assert core, "源工程没有 project_core"
sets = ", ".join(f"{f} = ?" for f in CORE_FIELDS)
dst.execute(
    f"UPDATE project_core SET {sets}, updated_at = datetime('now') WHERE id = 'main'",
    [core[f] for f in CORE_FIELDS],
)

chars = src.execute(f"SELECT {', '.join(CHAR_STATIC)} FROM characters").fetchall()
cols = ", ".join(CHAR_STATIC)
marks = ", ".join("?" for _ in CHAR_STATIC)
for row in chars:
    dst.execute(
        f"INSERT OR REPLACE INTO characters ({cols}) VALUES ({marks})",
        [row[f] for f in CHAR_STATIC],
    )

dst.commit()

check = dst.execute(
    "SELECT length(worldbuilding), length(premise), length(synopsis), length(characters_arch) FROM project_core"
).fetchone()
n = dst.execute("SELECT COUNT(*) FROM characters").fetchone()[0]
blank_state = dst.execute(
    "SELECT COUNT(*) FROM characters WHERE cs_location = '' AND cs_mental_state = ''"
).fetchone()[0]
print(f"四大件长度 世界观={check[0]} 前提={check[1]} 大纲={check[2]} 人物网络={check[3]}")
print(f"角色 {n} 张（动态状态为空的 {blank_state} 张）")
src.close()
dst.close()
