"""平台内置风控词表（RD-08 扩展）。

## 这份表和 `risk_word` 表的关系

`risk_word` 是运营可维护的词库，本文件是**出厂预置**：服务启动时幂等补齐，
只补不删、不覆盖运营的改动。运营删掉某个内置词，重启不会回来——
删除是明确的意思表示，跟「从没配过」不是一回事。

## 选词标准（比分类更重要）

一条词进这张表，要同时满足：

1. **几乎不可能出现在合法场景**。宁可漏，不可误伤——误伤的代价是运营
   在客户面前存不下东西，且他不知道为什么。
   反例：「银行」「返利」「日结」「国家级」都曾在候选里，最后全部剔除或
   归入默认停用的 `ad_law` 组。
2. **按词不按字**。「赌」「枪」「黄」单字一律不进表，只收「六合彩」「仿真枪」
   这类完整词。单字匹配会让「赌城风云观影会」这种活动名存不下去。
3. **同一件事的多种写法要收齐**。运营写「办证」还是「代办证件」，
   漏一种就等于没拦。

## 关于涉政类

**本文件不含涉政词条，这是刻意的**，不是遗漏：

- 静态词表拦涉政内容，误伤率极高（大量正常表述会被卷进来），且词表
  本身需要持续更新，半年不维护就等于失效；
- 这块的正解是内容安全服务（阿里云内容安全 GreenWeb 的
  `political_content` 标签），语义判定而非字面匹配，我们已经在该云上。

所以 `political` 分类**只保留分类本身**，词条留给超管按需导入
（后台「平台风控」支持批量导入），或后续接入内容安全接口时由服务端回填。

## 新增词条

往 `WORDS` 里加一行 `(词, 分类, 默认启用, 备注)` 即可，`verify_riskword.py`
会自动覆盖：新词必须能拦住，且必须不与已有词重复。
"""
from __future__ import annotations

# 分类 → 中文名。顺序即后台展示顺序。
CATEGORIES = {
    "illegal_gamble": "赌博博彩",
    "illegal_drug": "毒品",
    "illegal_weapon": "枪爆管制",
    "illegal_fraud": "诈骗传销",
    "illegal_forge": "假证假票",
    "illegal_finance": "非法金融",
    "illegal_privacy": "个人信息交易",
    "contraband": "违禁品",
    "adult": "色情低俗",
    "vulgar": "辱骂歧视",
    "ad_law": "广告法违禁",
    "political": "涉政",
}

# (词, 分类, 默认启用, 备注)
#
# 默认启用=0 的两组说明：
#   ad_law  —— 绝对化用语在正常活动文案里出现频率很高（「国家级示范区」
#              「唯一指定」），一刀切会挡住大量合法录入，所以出厂停用，
#              要做广告合规的机构自己在后台打开。
#   political —— 见文件头，词条需从可信来源导入。
WORDS = (
    # ---------------- 赌博博彩 ----------------
    ("六合彩", "illegal_gamble", 1, ""),
    ("时时彩", "illegal_gamble", 1, ""),
    ("百家乐", "illegal_gamble", 1, ""),
    ("网赌", "illegal_gamble", 1, ""),
    ("网络赌博", "illegal_gamble", 1, ""),
    ("赌博网站", "illegal_gamble", 1, ""),
    ("赌球平台", "illegal_gamble", 1, ""),
    ("外围投注", "illegal_gamble", 1, ""),
    ("私彩", "illegal_gamble", 1, ""),
    ("博彩代理", "illegal_gamble", 1, ""),
    ("棋牌代理", "illegal_gamble", 1, ""),
    ("老虎机", "illegal_gamble", 1, ""),
    ("押注平台", "illegal_gamble", 1, ""),
    ("代理开户送彩金", "illegal_gamble", 1, ""),
    ("博彩平台", "illegal_gamble", 1, ""),
    ("赌博平台", "illegal_gamble", 1, ""),
    ("网络博彩", "illegal_gamble", 1, ""),

    # ---------------- 毒品 ----------------
    ("冰毒", "illegal_drug", 1, ""),
    ("海洛因", "illegal_drug", 1, ""),
    ("摇头丸", "illegal_drug", 1, ""),
    ("氯胺酮", "illegal_drug", 1, ""),
    ("可卡因", "illegal_drug", 1, ""),
    ("麻古", "illegal_drug", 1, ""),
    ("k粉", "illegal_drug", 1, ""),
    ("芬太尼", "illegal_drug", 1, ""),
    ("制毒", "illegal_drug", 1, ""),
    ("贩毒", "illegal_drug", 1, ""),
    ("吸毒工具", "illegal_drug", 1, ""),
    ("毒品货源", "illegal_drug", 1, ""),
    ("大麻交易", "illegal_drug", 1, ""),

    # ---------------- 枪爆管制 ----------------
    ("枪支买卖", "illegal_weapon", 1, ""),
    ("仿真枪", "illegal_weapon", 1, ""),
    ("气枪", "illegal_weapon", 1, ""),
    ("弹药出售", "illegal_weapon", 1, ""),
    ("炸药配方", "illegal_weapon", 1, ""),
    ("雷管", "illegal_weapon", 1, ""),
    ("导火索", "illegal_weapon", 1, ""),
    ("管制刀具", "illegal_weapon", 1, ""),
    ("弩箭", "illegal_weapon", 1, ""),
    ("燃烧瓶", "illegal_weapon", 1, ""),
    ("爆炸物", "illegal_weapon", 1, ""),

    # ---------------- 诈骗传销 ----------------
    ("刷单", "illegal_fraud", 1, ""),
    ("杀猪盘", "illegal_fraud", 1, ""),
    ("稳赚不赔", "illegal_fraud", 1, ""),
    ("保本高息", "illegal_fraud", 1, ""),
    ("保本保收益", "illegal_fraud", 1, ""),
    ("内部渠道", "illegal_fraud", 1, ""),
    ("带你赚钱", "illegal_fraud", 1, ""),
    ("跑分平台", "illegal_fraud", 1, ""),
    ("洗钱", "illegal_fraud", 1, ""),
    ("四件套出售", "illegal_fraud", 1, ""),
    ("银行卡出租", "illegal_fraud", 1, ""),
    ("拉人头", "illegal_fraud", 1, ""),
    ("多层分销", "illegal_fraud", 1, ""),
    ("静态收益", "illegal_fraud", 1, ""),
    ("动态收益", "illegal_fraud", 1, ""),
    ("无限代", "illegal_fraud", 1, ""),
    ("资金盘", "illegal_fraud", 1, ""),
    ("庞氏骗局", "illegal_fraud", 1, ""),
    ("传销", "illegal_fraud", 1, ""),
    ("杀熟", "illegal_fraud", 1, ""),

    # ---------------- 假证假票 ----------------
    ("办证", "illegal_forge", 1, ""),
    ("假证", "illegal_forge", 1, ""),
    ("代开发票", "illegal_forge", 1, ""),
    ("虚开发票", "illegal_forge", 1, ""),
    ("假学历", "illegal_forge", 1, ""),
    ("代写论文", "illegal_forge", 1, ""),
    ("替考", "illegal_forge", 1, ""),
    ("改成绩", "illegal_forge", 1, ""),
    ("假身份证", "illegal_forge", 1, ""),
    ("克隆身份证", "illegal_forge", 1, ""),
    ("假户口本", "illegal_forge", 1, ""),
    ("刻章办证", "illegal_forge", 1, ""),

    # ---------------- 非法金融 ----------------
    ("套现", "illegal_finance", 1, ""),
    ("养卡", "illegal_finance", 1, ""),
    ("代还信用卡", "illegal_finance", 1, ""),
    ("炒币", "illegal_finance", 1, ""),
    ("usdt跑分", "illegal_finance", 1, ""),
    ("外汇跟单", "illegal_finance", 1, ""),
    ("原始股", "illegal_finance", 1, ""),
    ("私募保本", "illegal_finance", 1, ""),
    ("荐股", "illegal_finance", 1, ""),
    ("内幕消息", "illegal_finance", 1, ""),
    ("配资", "illegal_finance", 1, ""),
    ("场外期权", "illegal_finance", 1, ""),
    ("征信修复", "illegal_finance", 1, ""),
    ("数字货币钱包", "illegal_finance", 1, ""),
    ("套路贷", "illegal_finance", 1, ""),
    ("裸贷", "illegal_finance", 1, ""),
    ("校园贷", "illegal_finance", 1, ""),
    ("高利贷", "illegal_finance", 1, ""),
    ("暴力催收", "illegal_finance", 1, ""),
    ("私人换汇", "illegal_finance", 1, ""),

    # ---------------- 个人信息交易 ----------------
    ("数据爬取", "illegal_privacy", 1, ""),
    ("个人信息出售", "illegal_privacy", 1, ""),
    ("号码资源", "illegal_privacy", 1, ""),
    ("精准客户名单", "illegal_privacy", 1, ""),
    ("开房记录", "illegal_privacy", 1, ""),
    ("手机定位", "illegal_privacy", 1, ""),
    ("户籍查询", "illegal_privacy", 1, ""),
    ("人肉搜索", "illegal_privacy", 1, ""),
    ("查档", "illegal_privacy", 1, ""),

    # ---------------- 违禁品 ----------------
    ("迷药", "contraband", 1, ""),
    ("催情药", "contraband", 1, ""),
    ("听话水", "contraband", 1, ""),
    ("窃听器", "contraband", 1, ""),
    ("针孔摄像头", "contraband", 1, ""),
    ("定位追踪器", "contraband", 1, ""),
    ("开锁工具", "contraband", 1, ""),
    ("万能钥匙", "contraband", 1, ""),
    ("假币", "contraband", 1, ""),
    ("高仿名表", "contraband", 1, ""),
    ("代孕", "contraband", 1, ""),
    ("器官买卖", "contraband", 1, ""),
    ("卖淫", "contraband", 1, ""),
    ("嫖娼", "contraband", 1, ""),
    ("邪教", "contraband", 1, ""),

    # ---------------- 色情低俗 ----------------
    ("裸聊", "adult", 1, ""),
    ("约炮", "adult", 1, ""),
    ("援交", "adult", 1, ""),
    ("色情", "adult", 1, ""),
    ("成人视频", "adult", 1, ""),
    ("黄片", "adult", 1, ""),
    ("一夜情", "adult", 1, ""),
    ("特殊服务", "adult", 1, ""),
    ("包养", "adult", 1, ""),
    ("情色", "adult", 1, ""),
    ("淫秽", "adult", 1, ""),
    ("上门服务", "adult", 1, ""),

    # ---------------- 辱骂歧视 ----------------
    ("傻逼", "vulgar", 1, ""),
    ("操你妈", "vulgar", 1, ""),
    ("贱人", "vulgar", 1, ""),
    ("杂种", "vulgar", 1, ""),
    ("支那", "vulgar", 1, ""),
    ("黑鬼", "vulgar", 1, ""),
    ("死全家", "vulgar", 1, ""),
    ("狗娘养", "vulgar", 1, ""),

    # ---------------- 广告法违禁（出厂停用）----------------
    # 误伤面太大：正常活动名里「国家级」「唯一」「首选」很常见。
    # 做广告合规审核的机构自己决定要不要开。
    ("国家级", "ad_law", 0, "绝对化用语，误伤面大，默认停用"),
    ("最高级", "ad_law", 0, "绝对化用语，误伤面大，默认停用"),
    ("第一品牌", "ad_law", 0, "绝对化用语，误伤面大，默认停用"),
    ("顶级", "ad_law", 0, "绝对化用语，误伤面大，默认停用"),
    ("包治百病", "ad_law", 0, "医疗违禁表述，默认停用"),
    ("药到病除", "ad_law", 0, "医疗违禁表述，默认停用"),
    ("无副作用", "ad_law", 0, "医疗违禁表述，默认停用"),
    ("永久有效", "ad_law", 0, "绝对化用语，默认停用"),
)
