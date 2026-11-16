# 模型来源

| 文件           | 来源                                                                                                                                                    | 许可                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `seed-san.vrm` | [vrm-c/vrm-specification `samples/Seed-san/vrm/Seed-san.vrm`](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)，2026-11-16 下载 | [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) |

- 作者：VirtualCast, Inc.；署名必需（`creditNotation: required`）。
- 内嵌许可字段（VRM 1.0 meta）：`avatarPermission: everyone`，`commercialUsage: corporation`，`allowRedistribution: true`，`modification: allowModificationRedistribution`，其余用途限制字段均为允许。
- 原始文件 SHA-256：`624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23`，10,917,800 字节。
- 仓库里的是精简版：由 `scripts/slim-figure.ts` 从原始文件生成（`node --import tsx scripts/slim-figure.ts <原始文件> frontend/src/assets/models/seed-san.vrm`，输出固定），SHA-256：`c3d8b1926e009d48f2af3def8d1cea856cea6d97eb27757d5e439dadb0e9f0c7`，760,464 字节。精简内容：
  - 删去头部、头发、外套、背包、机械臂等牌桌上不显示的网格与图元，只留内衬与皮肤；
  - 删去表情、第一人称、视线、弹簧骨骼与缩略图数据；
  - 删去法线贴图，用到的颜色贴图缩小一半（1024 缩到 512、512 缩到 256），其余不再使用的贴图换成 1×1 占位图；
  - 只保留仍被引用的二进制数据。骨骼、蒙皮与许可字段（meta）不变。
- 运行时（`frontend/src/table3d/arms.tsx`）的修改：
  - 去掉无用顶点、合并骨架；只绘制手臂：内衬的袖子和皮肤上的手（推牌时才显示左臂），不绘制身体。
  - 把黑色手套（内衬网格上跟随手掌、指根与拇指骨骼的三角形，以及手腕上方 9 厘米内的前臂）改用肤色绘制，颜色取自模型右手指尖的贴图；左手皮肤在贴图里画成蓝色护甲，同样改用肤色。
  - 整体按 36 倍绘制，双手放大到 0.9 倍；手臂越过牌桌边缘后渐隐（改写材质着色器的透明度）。
  - 三家各用一份（文件读取一次、解析三次，网格与材质共用）。
  - 由程序驱动手臂与手指。
