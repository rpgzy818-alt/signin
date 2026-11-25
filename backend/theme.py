"""活动主题定义（P7）：换一场活动的视觉，只改这里，不改任何 JS。

为什么放在后端：
  * 主题随活动走，活动在数据库里；前端是三个产物共用一份 CSS，
    把主题写进 JS 会让「换视觉」变成改代码 + 重新构建。
  * /config 已经按活动上下文下发配置（见 routers/public.py），
    主题搭同一条通道，不新增接口、不新增请求。

约定（改主题前先看）：
  1. THEMES 是唯一真相。CSS 的 :root 里保留同名变量的**同值默认**，
     用于接口拿不到配置时的首屏兜底；两处改值必须同步。
  2. key 是 CSS 自定义属性名，value 是合法 CSS 值。前端逐条
     setProperty 到 documentElement，不拼接字符串、不 eval。
  3. 新增变量时：THEMES['default'] 先加，再在 base.css :root 加同值默认，
     最后把硬编码的地方改成 var(--xxx)。少一步都会在降级路径上露馅。
  4. activity.theme 存的是这里的 key；未配置、配错都回落 DEFAULT_THEME，
     绝不因为一个拼错的主题名让整页没样式。
"""
from __future__ import annotations

from typing import Dict

# 默认主题：色值与 base.css :root 逐项一致，保证现有活动视觉零变化。
# --surface-soft / --accent-soft / --hero-bg 等是把原先散落在各 CSS 文件里的
# 硬编码收敛上来的，值取的原样。
THEMES: Dict[str, dict] = {
    "default": {
        "name": "青绿（默认）",
        "vars": {
            "--teal": "#1ba9a0",
            "--teal-d": "#128b85",
            "--teal-l": "#5db6ca",
            "--teal-2": "#0f8d85",
            "--teal-mid": "#2f8fd0",
            "--teal-glow": "rgba(27,169,160,.16)",
            "--blue": "#2f6df0",
            "--blue-l": "#4f8ef7",
            "--coral": "#ff6b4a",
            "--coral-l": "#ff8a6a",
            "--coral-l2": "#ffa47a",
            "--ink": "#0f3d43",
            "--body": "#1f3a40",
            "--muted": "#8a9aa6",
            "--line": "#e6ebf0",
            "--bg": "#f5f8fb",
            "--surface-soft": "#f8fcfd",
            "--accent-soft": "#e4f0f1",
            "--hero-bg": "#eaf7f8",
        },
    },
    # 演示主题：用来证明「换视觉只改主题定义」。梯度、层次、对比度关系
    # 与默认主题保持一致（主色/深主色/浅主色/强调色/暖色/中性色），
    # 这样换主题不会把某个页面的可读性换没了。
    "violet": {
        "name": "紫蓝",
        "vars": {
            "--teal": "#6d5ce7",
            "--teal-d": "#5546c4",
            "--teal-l": "#8f83ef",
            "--teal-2": "#5b4bd0",
            "--teal-mid": "#7d6ce8",
            "--teal-glow": "rgba(109,92,231,.16)",
            "--blue": "#3a5fd6",
            "--blue-l": "#6f8ce8",
            "--coral": "#e2655a",
            "--coral-l": "#ef8a80",
            "--coral-l2": "#f2a69e",
            "--ink": "#2b2350",
            "--body": "#332e52",
            "--muted": "#8d8aa6",
            "--line": "#e8e6f2",
            "--bg": "#f7f6fc",
            "--surface-soft": "#faf9fe",
            "--accent-soft": "#ece9f8",
            "--hero-bg": "#f0eefb",
        },
    },
}

DEFAULT_THEME = "default"


def public_theme(theme_key=None) -> dict:
    """给 /config 用的主题描述。未知 key 静默回落默认，不抛错。"""
    key = theme_key if theme_key in THEMES else DEFAULT_THEME
    t = THEMES[key]
    return {"key": key, "name": t["name"], "vars": dict(t["vars"])}


def theme_keys() -> list:
    """后台做主题下拉用；顺序稳定，default 永远第一。"""
    keys = [DEFAULT_THEME] + [k for k in THEMES if k != DEFAULT_THEME]
    return keys
