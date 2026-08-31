# 一次性脚本：把破甲书 global_guidance 里的【破甲写法】段抽成第一个 Mod
# 1) 写 ~/.vela/mods/{id}.json + 历史 v1
# 2) 破甲工程启用该 Mod（{project}/.vela/mods.json）
# 3) 从书的 global_guidance 删除该段（避免双重注入）
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB = r"E:\Novels\小马宝莉破甲\.vela\vela.db"
PROJECT = Path(r"E:\Novels\小马宝莉破甲")
VELA_HOME = Path.home() / ".vela"

MARK = "【破甲写法】"

db = sqlite3.connect(DB)
(guidance,) = db.execute("SELECT global_guidance FROM project_core WHERE id = 'main'").fetchone()
idx = guidance.find(MARK)
assert idx != -1, "书设里没找到【破甲写法】段"
pojia_text = guidance[idx:].strip()
remaining = guidance[:idx].rstrip()

mod_id = str(uuid.uuid4())
now = datetime.now(timezone.utc).isoformat()
mod = {
    "id": mod_id,
    "name": "破甲向",
    "description": "破甲书的尺度与写法规则：心防五层、破防事件绑定、亲密场景写法、状态连续性",
    "version": 1,
    "updatedAt": now,
    "templates": {},
    "guidanceAppend": pojia_text,
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
if mod_id not in enabled:
    enabled.append(mod_id)
enable_file.write_text(json.dumps({"enabled": enabled}, ensure_ascii=False, indent=2), encoding="utf-8")

db.execute(
    "UPDATE project_core SET global_guidance = ?, updated_at = datetime('now') WHERE id = 'main'",
    (remaining,),
)
db.commit()

(check,) = db.execute("SELECT global_guidance FROM project_core").fetchone()
print("Mod id:", mod_id)
print("guidanceAppend 长度:", len(pojia_text))
print("书设已移除该段:", MARK not in check, "| 书设剩余长度:", len(check))
print("启用清单:", enabled)
db.close()
