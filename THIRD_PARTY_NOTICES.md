# 第三方与素材来源

- 日麻向听和计分基于 [@kobalab/majiang-core 1.4.1](https://github.com/kobalab/majiang-core)，作者 Satoshi Kobayashi，MIT。原始许可随 `backend/vendor/LICENSE.majiang-core` 交付。
- `backend/vendor/hule.cjs` 来源为上述版本的 `lib/hule.js`，改动为调整模块路径并导出 `explain`，用于返回同一计分过程选中的拆分及符数依据。规则变体、实体牌、裁决、包牌和整场结算由本项目适配层处理。
- React、Express、Socket.IO、pg、Zod、Nodemailer、TypeScript、Vite 等依赖的许可证保留在发行包的依赖目录中，精确依赖版本见 `pnpm-lock.yaml`。
- 牌面为本项目 SVG／文字绘制，牌背、桌面和首页插画使用 CSS；无外部照片、角色、商标或收费素材。
- 音效为本项目 Web Audio 合成，无外部录音；默认关闭。
- 字体使用设备已有的系统字体，不分发第三方字体文件。

- V4 的 12 款预设头像位于 `frontend/public/avatars/`，为本项目自制 SVG 色块、圆环与文字图案，固定 ID 映射；不引用外部图片、不分发字体。
## V4.1 image decoding

pngjs 7.0.0 uses the MIT license; its original license is included in the installed package. It decodes and re-encodes bounded avatar PNGs. Project: https://github.com/pngjs/pngjs . @types/pngjs 6.0.5 supplies development-only TypeScript definitions under MIT.
