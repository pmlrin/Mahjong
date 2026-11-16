# 模型来源

| 文件           | 来源                                                                                                                                                    | 许可                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `seed-san.vrm` | [vrm-c/vrm-specification `samples/Seed-san/vrm/Seed-san.vrm`](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)，2026-11-16 下载 | [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) |

- 作者：VirtualCast, Inc.；署名必需（`creditNotation: required`）。
- 内嵌许可字段（VRM 1.0 meta）：`avatarPermission: everyone`，`commercialUsage: corporation`，`allowRedistribution: true`，`modification: allowModificationRedistribution`，其余用途限制字段均为允许。
- 原始文件 SHA-256：`624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23`，10,917,800 字节。
- 仓库里的是精简版：由 `scripts/slim-figure.ts` 从原始文件生成（`node --import tsx scripts/slim-figure.ts <原始文件> frontend/src/assets/models/seed-san.vrm`，输出固定），SHA-256：`6053e3fcfc939d8a89ca0bc796d4a47c4574ad2519cdc042bab966f71129170f`，1,345,324 字节。精简内容：
  - 删去头部、头发、背包、机械臂等牌桌上不显示的网格与图元；
  - 删去表情、第一人称、视线、弹簧骨骼与缩略图数据；
  - 删去法线贴图，两张颜色贴图从 1024 缩到 512、两张从 512 缩到 256，其余不再使用的贴图换成 1×1 占位图；
  - 只保留仍被引用的二进制数据。骨骼、蒙皮与许可字段（meta）不变。
- 运行时（`frontend/src/table3d/arms.tsx`）的修改：
  - 去掉无用顶点、合并骨架；只显示衣服与身体网格。
  - 把黑色手套（内衬网格上跟随手掌、指根与拇指骨骼的三角形，以及手腕上方一小段前臂：右手 6 厘米，左手 9 厘米）改用肤色绘制，颜色取自模型右手指尖的贴图；左手皮肤在贴图里画成蓝色护甲，同样改用肤色。
  - 双手缩小到原来的 0.75 倍。
  - 三家各用一份（文件读取一次、解析三次，网格与材质共用）；上家、下家只绘制右臂部分的三角形（推牌时另显示左臂），对家不绘制腿脚。
  - 由程序驱动手臂与手指。
