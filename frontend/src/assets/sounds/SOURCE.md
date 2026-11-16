# 牌声素材来源

`ceramic-tile-{drop-1~4,flip-1~3,shuffle-1~3}.ogg` 取自 [Open Tabletop](https://github.com/optimuspryne/open-tabletop) 的 `public/static_assets/sounds/`，固定在提交 `df8e5154c662b65185c576c0d6bdd18ed6ee5295`，2026-11-12 下载，未改动。

许可：CC0 1.0（公有领域），见该仓库 [docs/ASSET_CREDITS.md](https://github.com/optimuspryne/open-tabletop/blob/df8e5154c662b65185c576c0d6bdd18ed6ee5295/docs/ASSET_CREDITS.md)。作者说明这组声音为程序合成，可由其 `scripts/generate-tile-sounds.py` 复现；调音时参考过麻将录音，但没有复制录音的采样数据。

同名 `.m4a` 是供不能解码 Vorbis 的浏览器使用的 AAC 版本：先用 Chrome 的 `decodeAudioData` 把 `.ogg` 解成 44.1 kHz 单声道 16 位 WAV，再用 macOS `afconvert -f m4af -d aac -b 96000` 编码（macOS 自带的 Vorbis 解码结果与浏览器不符，故不直接转）。转出后与 `.ogg` 的解码比对：长度与峰值一致，波形相关系数 0.99 以上。内容未做其他改动。

用途（`frontend/src/sounds.ts`）：drop 为出牌落桌，flip 为翻开新宝牌，shuffle 为每局配牌。播放时随机选一个变体，并按各自峰值统一音量。
