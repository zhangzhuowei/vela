# 演示脚本：建一个覆盖 chapter_blueprint 模板的 Mod，并对破甲书启用
# 目的：让用户直观看到「模板覆盖类」Mod 如何作用到章节蓝图
# 覆盖内容 = 内置模板原样 + 一条醒目的演示规则（保留全部变量与 JSON 格式，不破坏生成）
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(r"E:\Novels\小马宝莉破甲")
VELA_HOME = Path.home() / ".vela"

# 内置 chapter_blueprint 的 content（原样复制），仅在节奏原则里加一条演示规则
BLUEPRINT_CONTENT = """请基于我们此前推演出的【全书架构引擎】，为本书生成从第1章到第{{number_of_chapters}}章的具体"保姆级执行目录细纲"。

【核心防偏离守则】
- 小说题材：{{genre}}
- 全局写作要求与禁忌：{{global_guidance}}（这是绝对不能触碰的底线！）

【全书架构数据池】
{{novel_architecture}}

【商业网文节奏设计原则】
1. 黄金三章法则：第1章极速抛出"生存/高压困境"，第2章激活金手指/最大反差变量，第3章完成首次"小型打脸/破局"，留钩子。
2. 小高潮循环：严格执行"3-5章一个小循环"。
3. 拒绝水文与流水账：每一章都必须发生"实质性的事件变动"。
4. 悬念钩子机制：每章结尾必须有一个让读者想连续翻页的变数。
5. 【演示 Mod 生效标记】每章 purpose 结尾统一追加标签「〔破甲节奏〕」，用于验证本 Mod 已覆盖蓝图模板。

【输出格式规定】
严格且仅按以下 JSON 数组格式输出每一章：

{
  "blueprints": [
    {
      "chapterNumber": 1,
      "title": "引人入胜的标题",
      "purpose": "本章主角最想解决的一件事",
      "characters": ["本章互动的要人A", "要人B"],
      "keyEvents": "主角做了什么，遭遇了什么反转，金手指怎么用的。100字左右具体说明",
      "suspenseHook": "一句话说明结尾留了什么悬念"
    }
  ]
}"""

now = datetime.now(timezone.utc).isoformat()
mod_id = str(uuid.uuid4())
mod = {
    "id": mod_id,
    "name": "演示·蓝图口味",
    "description": "演示模板覆盖：覆盖章节蓝图模板，每章 purpose 追加〔破甲节奏〕标签",
    "version": 1,
    "updatedAt": now,
    "templates": {"chapter_blueprint": BLUEPRINT_CONTENT},
    "guidanceAppend": "",
    "tags": ["演示"],
}

mods_dir = VELA_HOME / "mods"
history_dir = mods_dir / "history"
history_dir.mkdir(parents=True, exist_ok=True)
(mods_dir / f"{mod_id}.json").write_text(json.dumps(mod, ensure_ascii=False, indent=2), encoding="utf-8")
(history_dir / f"{mod_id}.json").write_text(
    json.dumps([{"version": 1, "savedAt": now, "snapshot": mod}], ensure_ascii=False, indent=2),
    encoding="utf-8",
)

enable_file = PROJECT / ".vela" / "mods.json"
enabled = []
if enable_file.is_file():
    try:
        enabled = json.loads(enable_file.read_text(encoding="utf-8")).get("enabled", [])
    except Exception:
        enabled = []
enabled.append({"id": mod_id, "version": None})
enable_file.write_text(json.dumps({"enabled": enabled}, ensure_ascii=False, indent=2), encoding="utf-8")

print("演示 Mod 已创建并对破甲书启用")
print("mod id:", mod_id)
print("覆盖模板: chapter_blueprint")
print("启用清单:", json.dumps(enabled, ensure_ascii=False))
