# GitHub 角色、动作与音效素材筛选

核查日期：2026-11-12。用途：本项目的角色展示、3D 打牌手部动作、麻将牌与界面音效。

本次核对了仓库说明、具体素材目录与许可；Seed-san 额外读取了 VRM 文件内嵌的授权和手指骨骼信息。尚未在本项目中加载这些素材，也未逐条试听音效。下列“建议用途”是根据素材内容作出的适配判断。

## 建议优先使用

| 需求 | 优先来源 | 推荐理由 | 还需要的工作 |
| --- | --- | --- | --- |
| 二次元 3D 角色、打牌的手部模型 | Seed-san | 官方 VRM 示例，含双手完整手指骨骼，授权明确 | 制作坐姿、伸手、捏牌、落牌、收手动画；保留署名和许可 |
| 更多免费角色 | Open Source Avatars 的 100Avatars R1/R2/R3 | 这三个系列明确列为 CC0，提供模型下载链接和预览 | 挑选统一风格，逐个核对模型、骨骼和体积 |
| 低多边形角色原型 | KayKit Adventurers | 4 个角色、75 个动画，作者官方仓库，CC0 | 风格为奇幻冒险；打牌动作仍需制作 |
| 通用人物动作 | Quaternius Universal Animation Library Standard | 作者确认 CC0，GitHub 有免费版镜像 | 将动作适配角色骨骼；免费版仅含部分动作 |
| 拿牌、落牌、翻牌、洗牌声 | Open Tabletop 的 ceramic-tile 系列 | 专门的牌块音效，共 13 个变体，作者标注 CC0 | 试听，调整音量，和手部接触牌的时刻同步 |
| 按钮、确认、错误、筹码、骰子声 | Kenney 音效的 GitHub 镜像 | 来源可追溯至 Kenney，相关原始包为 CC0 | 选取少量文件，避免风格混杂 |

## 1. Seed-san：优先看的二次元角色

- [官方素材目录](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)
- [角色预览](https://github.com/vrm-c/vrm-specification/blob/master/samples/Seed-san/screenshot/screenshot.png)
- [模型文件](https://github.com/vrm-c/vrm-specification/blob/master/samples/Seed-san/vrm/Seed-san.vrm)
- [官方许可说明](https://github.com/vrm-c/vrm-specification/blob/master/samples/Seed-san/README.md)
- [VRM Public License 1.0](https://vrm.dev/en/licenses/1.0/)

作者为 VirtualCast, Inc.，文件约 10.9 MB。官方样例说明列出表情、视线、弹簧骨骼等功能。

直接读取该模型的内嵌元数据，确认：

| 字段 | 当前值 | 意义 |
| --- | --- | --- |
| `avatarPermission` | `everyone` | 允许所有人使用为化身 |
| `commercialUsage` | `corporation` | 允许包括法人在内的商业使用 |
| `allowRedistribution` | `true` | 允许再分发 |
| `modification` | `allowModificationRedistribution` | 允许修改并再分发修改版 |
| `creditNotation` | `required` | 必须署名 |

确认含左右手拇指、食指、中指、无名指、小指的共 30 根标准手指骨骼，适合作为捏牌动作的模型基础。尚未验证手部网格在近景下的效果。

署名至少应标明角色与作者，并保留许可链接、来源及修改说明，例如：`Seed-san — VirtualCast, Inc. — VRM Public License 1.0`。完整要求以许可为准。它不是 CC0。

## 2. Open Source Avatars：可继续挑角色的素材库

- [GitHub 仓库](https://github.com/ToxSam/open-source-avatars)
- [角色预览和下载入口](https://opensourceavatars.com/)
- [各系列的授权清单](https://github.com/ToxSam/open-source-avatars/blob/main/data/projects.json)
- [100Avatars R1 的具体角色及下载链接](https://github.com/ToxSam/open-source-avatars/blob/main/data/avatars/100avatars-r1.json)

推荐先看 `100avatars-r1`、`100avatars-r2`、`100avatars-r3`，三个系列均在数据清单中明确标为 CC0。R1 的角色条目含 `model_file_url` 和 `thumbnail_url`，可以单独下载所选角色，不必下载全库。

这是角色索引，模型主要放在外部存储，并非全部存放在 GitHub 内。整个索引的 CC0 不代表所有社区角色的许可相同：其他系列含 CC-BY 等，需按具体系列核对。

建议用于角色选择、玩家形象和原型验证；视觉风格并不统一，不能直接视作一套二次元麻将人物。

## 3. KayKit Adventurers：低多边形角色与动画

- [作者官方 GitHub 仓库](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0)
- [内容和预览](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/blob/main/README.md)
- [素材许可](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/blob/main/LICENSE.txt)

免费部分包含 4 个已绑定骨骼并带动画的角色、75 个动画和 25 件以上配件。格式为 FBX、glTF；许可 CC0，可商业使用、修改和分发，无强制署名。

适合轻量角色原型。其奇幻冒险造型与本项目的麻将环境需要进一步统一；现有说明不能证明它提供细致的手指捏牌动作。

## 4. Quaternius Universal Animation Library：通用动作基础

- [GitHub 免费 Standard 版镜像](https://github.com/J-Ponzo/gltf-universal-animation-library)
- [镜像中的动画文件](https://github.com/J-Ponzo/gltf-universal-animation-library/tree/main/glTF)
- [镜像实际 LICENSE 文件](https://github.com/J-Ponzo/gltf-universal-animation-library/blob/main/LICENSE)
- [作者原始发布页与许可](https://quaternius.com/packs/universalanimationlibrary.html)

作者发布页明确列为 CC0；GitHub 镜像明确说明仅收录免费的 Standard 子集，不能将完整商业版本宣传的全部动画视为免费版内容。

镜像目录实际提供 `AnimationLibrary_Godot_Standard.gltf` 和配套 `.bin`，使用时两者需要一并获取。适合作为通用动作的参考和起点，换到不同骨骼的角色时需要做动作适配。

本次未确认免费子集中有可直接使用的麻将动作。精确的拿牌、出牌、立直放棒，应单独制作。

## 5. Open Tabletop：最贴近麻将的牌块音效

- [具体音频目录](https://github.com/optimuspryne/open-tabletop/tree/main/public/static_assets/sounds)
- [音效来源和 CC0 声明](https://github.com/optimuspryne/open-tabletop/blob/main/docs/ASSET_CREDITS.md#sound-effects---publicstatic_assetssounds)
- [合成源文件及 CC0 说明](https://github.com/optimuspryne/open-tabletop/blob/main/scripts/generate-tile-sounds.py)

建议先试听以下 13 个文件，目录中已确认存在：

| 文件组 | 数量 | 建议映射 |
| --- | --- | --- |
| `ceramic-tile-pickup-1.ogg` 至 `-3.ogg` | 3 | 摸牌、拿牌 |
| `ceramic-tile-drop-1.ogg` 至 `-4.ogg` | 4 | 出牌落桌 |
| `ceramic-tile-flip-1.ogg` 至 `-3.ogg` | 3 | 翻宝牌、手牌摊开 |
| `ceramic-tile-shuffle-1.ogg` 至 `-3.ogg` | 3 | 洗牌、开局过渡 |

作者说明这组声音为程序合成，使用麻将录音作音色与节奏参考，但未复制或分发参考录音的采样数据；这组文件明确标注 CC0。它们不是实录麻将音效。

建议每种操作随机选一个变体，降低重复感；音量和适配效果需试听确定。

## 6. Kenney：界面、筹码、骰子与结算音效

- [GitHub 索引与音频镜像](https://github.com/Mcamento8/open-game-sfx-index)
- [来源追溯清单](https://github.com/Mcamento8/open-game-sfx-index/blob/main/SOURCES.md)
- [Casino Audio 音频目录](https://github.com/Mcamento8/open-game-sfx-index/tree/main/audio/casino-audio)
- [Interface Sounds 音频目录](https://github.com/Mcamento8/open-game-sfx-index/tree/main/audio/interface-sounds)
- [预览入口](https://github.com/Mcamento8/open-game-sfx-index/blob/main/previews/README.md)

这是第三方镜像。已核对 [Kenney Casino Audio 原始页](https://kenney.nl/assets/casino-audio) 和 [Impact Sounds 原始页](https://kenney.nl/assets/impact-sounds)，二者明确标注 CC0。

| 文件例子或目录 | 建议用途 |
| --- | --- |
| `interface-sounds/click_001.ogg`、`click_002.ogg` | 按钮、选牌反馈 |
| `interface-sounds/confirmation_001.ogg` | 确认操作、准备完成 |
| `interface-sounds/error_001.ogg` | 错误提示 |
| `casino-audio/chip-lay-1.ogg`、`chips-stack-1.ogg` | 立直棒或点数变化的候选音色 |
| `casino-audio/dice-throw-1.ogg` | 骰子表现 |
| `music-jingles/` | 和牌、终局的短提示旋律候选 |

Casino Audio 的纸牌声是纸牌音色，不能直接当作麻将实录。筹码声也只是立直棒的候选，需试听后决定。

另外，[Calinou/kenney-ui-audio](https://github.com/Calinou/kenney-ui-audio) 提供 50 个 Kenney UI 音效的 WAV 转换版，文件在 `addons/kenney_ui_audio/`，其 [LICENSE.txt](https://github.com/Calinou/kenney-ui-audio/blob/master/LICENSE.txt) 明确列为 CC0。虽按 Godot 目录组织，WAV 文件也可以独立用于网页。

## 7. Meta Open Sound：补充音效库

- [Meta 官方仓库](https://github.com/facebookincubator/Meta-open-sound)
- [Oculus Audio Pack 目录](https://github.com/facebookincubator/Meta-open-sound/tree/main/corpora/oculus-audio-pack)
- [必须保留的署名说明](https://github.com/facebookincubator/Meta-open-sound/blob/main/corpora/oculus-audio-pack/ATTRIBUTION.md)

包含界面声、环境声、角色发声和其他游戏音效，适合作为补充。仓库内有 OGG，完整 WAV 可在 Releases 获取。

注意分包许可：钢琴、吉他采样为 CC0，Oculus Audio Pack 音效为 CC BY 4.0，需要按其 ATTRIBUTION.md 保留署名，修改后说明修改。不能将整个仓库的音效一概当作 CC0。

## 打牌动作和人物语音的缺口

本次没有确认到授权清晰、能直接放进本项目的完整“麻将手部动作包”。推荐以 Seed-san 的双手骨骼为基础，制作“伸手 → 捏牌 → 移动 → 落牌松手 → 收回”的短动画，并另做摸牌和立直放棒。角色情绪、呼吸和视线可以与手部动作分开处理。

本次也未确认到可直接商用和再分发的日语“吃、碰、杠、立直、荣和、自摸”完整配音包。通用音效库的角色发声不等于麻将台词配音；这部分应另行找明确授权的配音或录制。

## 后续接入本项目时

当前牌桌使用 Three.js / React Three Fiber，GLB/glTF 是自然的模型选择；VRM 需要增加 VRM 加载与角色控制能力。本次未验证具体素材与现有依赖版本的兼容性。

实际选定素材后，保存原始许可、来源链接和修改记录；通过 Vite 导入或 `import.meta.env.BASE_URL` 引用文件，并按 `docs/3D打牌视角设计.md` 的约定登记来源。角色和声音仅跟随对局事件表现，不改变对局规则。
