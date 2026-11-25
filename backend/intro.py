"""活动介绍页文案覆盖（P7-b2）：结构化文案的解析与校验。

为什么用 JSON 而不是富文本 / HTML：
  介绍页的主标语与落款现在是**纯文本排版**（原为书法字图，去品牌后改为文字），
  由版式决定字号与位置；可覆盖的仍是三处纯文字：
  顶部两行（line1/line2）与正文段落（desc）。
  HTML 绝不接受——前端一律 textContent 写入，杜绝脚本注入。

数据契约（activity.intro 存 JSON 字符串）：
  {"line1": "...", "line2": "...", "desc": ["第一段", "第二段"]}
  - 三个字段都可选，缺省的字段沿用默认文案（不覆盖）
  - desc 最多 12 段，每段 120 字；单行 80 字
  - 空字符串表示「恢复默认」，解析后归一成 None

唯一真相：解析只在这里做，/config 下发的是**已解析对象**，
前端拿到就能用，不再各自 JSON.parse。
"""
from __future__ import annotations

import json
from typing import Optional

MAX_LINE = 80
MAX_PARA = 120
MAX_PARAS = 12
_FIELDS = ("line1", "line2")


def parse(raw) -> Optional[dict]:
    """把库里的 intro 字段解析成安全对象；任何异常都当「未配置」回落默认。

    不抛错是有意的：运营在界面上填坏了内容，最坏结果也只是文案没覆盖，
    不能让整场活动的介绍页打不开。
    """
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    out = {}
    for key in _FIELDS:
        v = data.get(key)
        if isinstance(v, str) and v.strip():
            out[key] = v.strip()[:MAX_LINE]

    desc = data.get("desc")
    if isinstance(desc, str) and desc.strip():
        # 单串按换行拆段，方便运营在 textarea 里一段一行
        desc = [x for x in desc.split("\n") if x.strip()]
    if isinstance(desc, list):
        paras = [str(x).strip()[:MAX_PARA] for x in desc[:MAX_PARAS] if str(x).strip()]
        if paras:
            out["desc"] = paras

    return out or None


def normalize(raw_input) -> Optional[str]:
    """后台写入前归一化：接受 JSON 串或 dict，只留白名单字段、去空值。

    返回可直接入库的 JSON 串；无有效内容时返回 None（落 NULL = 恢复默认）。
    前端传的是 JSON 串，验证脚本可能传 dict，两种都收。
    """
    cleaned = parse(raw_input)
    return json.dumps(cleaned, ensure_ascii=False) if cleaned else None
