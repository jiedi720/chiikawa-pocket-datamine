# 口袋吉伊卡哇 — 完整拆包资料（v2.4.1）

> 本文是简体中文翻译，原文见 **[README.md](README.md)**。

> **《口袋吉伊卡哇》（Chiikawa Pocket，国际服）** `jp.co.applibot.chiikawapocketgl` v2.4.1（Unity IL2CPP）的完整离线拆包。
> 236 张主数据表全部解码，所有游戏公式均从原生代码中还原并验证，另附玩法指南、队伍计算器网页工具，以及完整去混淆的代码结构。
>
> **非官方玩家研究项目。** 与 Applibot 及吉伊卡哇 IP 权利方无任何关联。仅用于教育与拆包研究。本仓库不托管任何游戏二进制文件（见[「未收录的内容及原因」](#未收录的内容及原因)）。

---

## 文档（从这里开始）

| 文档 | 内容 |
|---|---|
| **[analysis/MECHANICS.md](analysis/MECHANICS.md)** | 各个游戏系统的运作方式 |
| **[analysis/MATH.md](analysis/MATH.md)** | 所有重要公式，附逐步演算示例 |
| **[analysis/OPTIMAL_PLAY.md](analysis/OPTIMAL_PLAY.md)** | 每种机制在数学上的最优玩法 |
| **[analysis/TEAM_SETUP.md](analysis/TEAM_SETUP.md)** | 编队与站位数学：顺序改变了什么、怎样排列最优 |
| **[analysis/LITTLE_HOUSE.md](analysis/LITTLE_HOUSE.md)** | 小小屋物品（Treasure 系统）：经核实的持有／装备加成、触发条件、最优物品 |
| **[analysis/KEYCHAIN.md](analysis/KEYCHAIN.md)** | 钥匙扣（Keyholder）系统：定向装备效果、稀有度分级、合成消耗 |
| **[analysis/MYROOM.md](analysis/MYROOM.md)** | 概念辨析：代码里的「MyRoom」（外观编辑器）与小小屋物品的区别 |
| **[analysis/REPORT.md](analysis/REPORT.md)** | 技术拆包报告（格式、系统、论证） |
| **[analysis/formulas_decompiled.md](analysis/formulas_decompiled.md)** · **[batch2](analysis/formulas_decompiled_batch2.md)** · **[batch3](analysis/formulas_decompiled_batch3.md)** · **[batch4](analysis/formulas_decompiled_batch4.md)** | 90+ 个计算器／机制函数反编译为 C |
| **[analysis/report_data_digests.md](analysis/report_data_digests.md)** | 大型参考表（全部 153 个 Config 常量、经验曲线、168 个技能及其成长、消耗区间） |
| **[webapp/](webapp/)** | **队伍与顺序计算器** — 用浏览器打开 `webapp/index.html` |

## 游戏实际使用的公式（精华）

**普通攻击伤害：**
```
damage = Attack × NormalAttackDamageRate × CostumeAttackRate
       × (boss ? BossDamageRate : MobDamageRate) × DefenceDebuffAmp ÷ AttackDebuff
if rand(0,1) < CritRate:  ×= CriticalDamage × CriticalDefenceDebuffAmp
if ConstantDamage > 0:    flat override (never crits)
```

**暴击期望：** `E = 1 + CritRate × (CritDamage − 1)` — 基础暴击率 **0%**（每级 +0.1%），基础暴击伤害 **1.2×**（每级 +1%）。

**所有属性：** `final = BaseValue × CorrectValue × StatusUpRate + StatusUpValue` — 面板攻击力 = 很小的线性基础值 × 庞大的收集倍率（这正是「全收集」远胜「单点升级」的原因）。

**等级成长（所有数值）：** 线性 `start + (end−start)×(L−startLv)/(endLv−startLv)`；Permil = ÷1000；不做上下限截断。技能示例：超稀有群体技能从 L1 的 56× 成长到 L100 的 650× 攻击力。

**编队：** 单体攻击永远命中**最左侧的存活位置**（前排 = 肉盾）；技能按编队顺序从 FIFO 队列发出（特技 0.5 秒／支援 2 秒间隔）——增益角色放在主输出的左侧，主 C 放最右。

**经济：** 挂机金币 = 关卡速率 × GoldAcquire，12 小时上限，看广告 +6 小时 ×3 次／天；关卡速率从 18／分钟膨胀到 10²¹／分钟；敌方 HP 可达约 10⁴⁰（全程 BigDecimal；字母后缀采用 26 进制字母表 — `264i` = 2.64×10²⁹）。

**料理：** 纯倍率连乘 — 类型匹配 1.5×、主／副位 1.0／0.3×、稀有度 SR 3×／HR 1×／UR 0.3×（越高稀有度反而越低！）、加成 2× → 配置正确可达 9×。

**消耗：** 攻击强化 = 3 金币／级，而暴击率 = 10¹⁴ 金币／级（刻意设置的后期金币回收口）；扭蛋 500 宝石／11 连 对 1500 宝石／35 连（便宜 5.7%）；广告免费 11 连 ×3 次／天。

完整公式与推导：**[analysis/MATH.md](analysis/MATH.md)**。

## 数据

- **[analysis/masterdata/](analysis/masterdata/)** — **236 张主数据表全部解码为 JSON**（逐字节精确）：8,648 个关卡、25,008 条敌方状态、146 套服装、168 个技能／186 个效果、2,823 个持有效果、2,084 个商店商品，以及扭蛋结构、料理、特训、除草、联赛……
- **[dumps/MasterData/](dumps/MasterData/)** — 从设备拉取的原始 `.bytes` 主数据文件
- **[analysis/schema.json](analysis/schema.json)** — 提取出的 message／enum 结构（568 个类、1,331 个枚举）+ [proto_descriptors.json](analysis/proto_descriptors.json)（部分 `.proto` 恢复）
- **[analysis/skills_resolved.json](analysis/skills_resolved.json)** — 每个技能效果均已解析出按等级缩放后的数值
- **[dumps/il2cppdumper/dump.cs](dumps/il2cppdumper/dump.cs)** — 整个游戏去混淆后的 C# 结构（每个类、字段、方法 + 原生地址）
- **[dumps/il2cppdumper/DummyDll/](dumps/il2cppdumper/DummyDll/)** — 重建的托管 DLL 桩（含 Assembly-CSharp 在内的全部程序集）
- **[decompiled/jadx-base/](decompiled/jadx-base/)** — 反编译的 Java 层（主要是平台 SDK；游戏逻辑在 IL2CPP 侧）

## 计算器网页工具

用任意浏览器打开 **[webapp/index.html](webapp/index.html)**（无需服务器）。输入账号属性、勾选已拥有的服装，它就会用真实公式算出最优的 6 服装队伍**以及**最佳站位顺序（含技能等级缩放、暴击期望、增益覆盖率、标签协同，并对全部 720 种排列做兼顾生存与队列的排序）。另附增益／物品浏览器（149 件物品的持有与装备效果）和数学参考标签页。

## 拆包流程

1. 通过 ADB（root）从模拟器拉取已安装的 APK 分包与运行时主数据。
2. 随包附带的 `global-metadata.dat` 是加密的 — 从运行中的游戏内存映射里还原出**解密后**的副本。
3. Il2CppDumper → 完整 C# 结构（`dump.cs`、DummyDll、script.json）。
4. 逆向出 MasterData `.bytes` 格式（无标签、类 proto、varint／fixed-8 混合），编写逐字节精确的解析器 → 236 张表全部转为 JSON。
5. 借助 Capstone 反汇编 + Ghidra／PyGhidra 反编译 90+ 个函数，从 `libil2cpp.so`（ARM64）还原计算代码（伤害、状态聚合、技能队列、料理、CP……）。

复现脚本（本项目自研）：**[scripts/](scripts/)** — 解析器、结构提取器、反汇编器、反编译驱动、数据集导出器。下载的第三方工具链（Ghidra、jadx、Il2CppDumper）未包含在内 — 版本与链接见各脚本头部。

## 未收录的内容及原因

- **APK 与 Unity 资源包**（受版权保护的游戏文件；且超过 800 MB，超出 GitHub 限制）。
- **`libil2cpp.so`、`il2cpp.h`、`script.json`**（二进制／体积过大；`dump.cs` + DummyDll 已包含同样信息）。
- **扭蛋概率、主数据文本、挂机奖励最终数值** — 由**服务器端**（GS2）计算，客户端里没有，因此无法离线拆包。你在别处看到的任何「概率」都来自服务器，而不是 APK。
- 工具链（Ghidra／jadx／Il2CppDumper）— 需要下载什么见 `scripts/`。

## 免责声明

玩家自制的非官方研究项目，仅用于教育与互操作性讨论。所有游戏数据、名称与素材归各自权利人所有（Applibot ／ 吉伊卡哇 IP 权利方）。若您是权利方并希望移除此处任何内容，请提一个 issue，我们会立即下架。本仓库不分发任何受版权保护的游戏二进制文件。
