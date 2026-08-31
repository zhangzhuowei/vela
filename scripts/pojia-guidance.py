# 一次性脚本：给《小马宝莉破甲》改写全局行文指导与感情线规则
# global_guidance 追加【破甲写法】段；writing_style 替换第 6 条尺度规则
import sqlite3

DB = r"E:\Novels\小马宝莉破甲\.vela\vela.db"

POJIA_GUIDANCE = """

【破甲写法】
攻略的对象是心防，不是身体。每位女主的心防分五层：警惕→习惯→依赖→动摇→沦陷。先破心防后有亲密，顺序不可颠倒；一章最多推进一层，禁止跳层。

每一次破防必须绑定一个具体触发事件（对应一次心结修补或共同经历），破防瞬间用动作、神态与生理细节呈现，禁止旁白直接宣告"她沦陷了""她彻底属于他了"这类总结。

亲密场景写法：节奏放慢，段落更短；感官描写具体到触觉、温度、呼吸节奏；心理描写与身体反应同步推进，写出抗拒、动摇与放任之间的实时拉扯——身体反应与心理防线的矛盾是破甲的核心张力，二者不同步时张力最大。写到亲密处收起幽默腔。

尺度由控场指令决定：控场未明确要求时，默认写到临界点、停在张力最高处；控场明确推进时直写到底，不跳切、不黑幕、不用省略号代替过程。事后戏必写，重点是心理防线被突破后的余震与关系重构。

状态连续性：位置、衣着、身体状态、心理状态、攻略进度在场与场之间严格连贯，禁止无解释重置。每场开头默认继承上一场结束时的全部状态；收场蒸馏时这些状态变化必须完整保留进正文。"""

OLD_RULE_6 = "6. 感情戏以陪伴、并肩、误解与和解为主，重情绪张力与细节留白，不写露骨内容。"
NEW_RULE_6 = (
    "6. 感情戏以拉扯与渐进破防为主，重情绪张力与身心矛盾。亲密内容允许直写，"
    "但必须发生在对应心防层级解锁之后、依托具体的破防事件，禁止无铺垫直接推进；"
    "尺度与详略遵循【破甲写法】的分级规则。"
)

db = sqlite3.connect(DB)
guidance, style = db.execute(
    "SELECT global_guidance, writing_style FROM project_core WHERE id = 'main'"
).fetchone()

assert OLD_RULE_6 in style, "writing_style 第 6 条原文没找到，先人工核对"
style = style.replace(OLD_RULE_6, NEW_RULE_6)

if "【破甲写法】" not in guidance:
    guidance = guidance.rstrip() + POJIA_GUIDANCE

db.execute(
    "UPDATE project_core SET global_guidance = ?, writing_style = ?, updated_at = datetime('now') WHERE id = 'main'",
    (guidance, style),
)
db.commit()

g2, s2 = db.execute("SELECT global_guidance, writing_style FROM project_core").fetchone()
print("guidance 含破甲写法:", "【破甲写法】" in g2, "| 长度:", len(g2))
print("style 第6条已替换:", OLD_RULE_6 not in s2 and "破防事件" in s2)
db.close()
