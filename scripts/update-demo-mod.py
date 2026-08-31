# 更新演示 Mod：补覆盖 chapter_blueprint_chunk（续写/增量走的是这个模板）
# 保留全部变量与 JSON 格式，只加一条演示规则
import json
from datetime import datetime, timezone
from pathlib import Path

VELA_HOME = Path.home() / ".vela"
MOD_ID = "c99ff493-fef9-41e2-8046-45ab2070f693"

CHUNK_CONTENT = """请基于【全书架构引擎】与【已生成的目录进度】，为接下来的 第{{n}}章到第{{m}}章 生成极其严密的"保姆级执行目录细纲"。

【核心防偏离守则】
- 小说题材：{{genre}}
- 全书规模：共 {{number_of_chapters}} 章
- 全局写作要求与禁忌：{{global_guidance}}（这是绝对不能触碰的底线！）

【全书架构数据池】
{{novel_architecture}}

【前置剧情进度与连贯性检查】
以下是前置章节（简略截取，以防遗忘主线进度）：
{{chapter_list}}

【本次生成任务：接力推演】
请紧密承接上面最后一章的情节，继续严密推演 第{{n}}章 到 第{{m}}章。
1. 连续小高潮法则：维持每 3-5 章一个小高潮的节奏。
2. 伏笔强制回收与释放：如果前面章节留下了危机，这里必须引爆或解决。
3. 拒绝水文：每一章都必须有实质性进展。
4. 【演示 Mod 生效标记】每章 purpose 结尾统一追加标签「〔破甲节奏〕」，用于验证本 Mod 已覆盖续写蓝图模板。

【输出格式规定】
严格且仅按以下 JSON 数组格式输出每一章：

{
  "blueprints": [
    {
      "chapterNumber": {{n}},
      "title": "引人入胜的标题",
      "purpose": "本章主角最想解决的一件事",
      "characters": ["本章互动的要人A", "要人B"],
      "keyEvents": "具体发生了什么，金手指怎么运作的。100字左右",
      "suspenseHook": "结尾留的钩子"
    }
  ]
}"""

mod_file = VELA_HOME / "mods" / f"{MOD_ID}.json"
mod = json.loads(mod_file.read_text(encoding="utf-8"))
mod["templates"]["chapter_blueprint_chunk"] = CHUNK_CONTENT
mod["version"] = mod.get("version", 1) + 1
mod["updatedAt"] = datetime.now(timezone.utc).isoformat()
mod_file.write_text(json.dumps(mod, ensure_ascii=False, indent=2), encoding="utf-8")

hist_file = VELA_HOME / "mods" / "history" / f"{MOD_ID}.json"
history = json.loads(hist_file.read_text(encoding="utf-8")) if hist_file.is_file() else []
history.insert(0, {"version": mod["version"], "savedAt": mod["updatedAt"], "snapshot": mod})
hist_file.write_text(json.dumps(history[:20], ensure_ascii=False, indent=2), encoding="utf-8")

print(f"已更新为 v{mod['version']}，覆盖模板:", list(mod["templates"].keys()))
