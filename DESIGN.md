# Design: 一桌 ICHITAKU

全站共用的设计系统。后续页面先读这里，有意修改时再改这份文件。

## System
- Genre: playful
- Shape of the first page: app screen
- Theme: custom（靛染：靛蓝桌面配杏色点缀，2026-11-10 由项目负责人从三套真实页面候选中选定）
- Axes: light/roman-serif/cool · posture: committed（靛蓝是唯一的大面积色）

## Tokens
`frontend/src/tokens.css` 是唯一来源。角色如下：
```css
:root {
  --color-paper: oklch(96.5% 0.012 80);  --color-paper-2: oklch(93.5% 0.016 80);  --color-paper-3: oklch(89.5% 0.02 80);
  --color-ink: oklch(26% 0.04 262);  --color-ink-2: oklch(37% 0.045 260);  --color-muted: oklch(48% 0.035 255);  --color-rule: oklch(87% 0.018 85);
  --color-accent: oklch(40% 0.1 262);  --color-accent-ink: oklch(97% 0.012 85);  --color-focus: oklch(50% 0.13 55);
  --color-felt: oklch(37% 0.085 258);  --color-felt-deep: oklch(26% 0.06 262);  --color-felt-ink: oklch(96% 0.012 85);
  --color-signal: oklch(80% 0.125 68);  --color-seal: oklch(54% 0.17 35);
  --tile-face: oklch(97.5% 0.012 85);  --tile-side: oklch(72% 0.09 70);  --tile-back: oklch(72% 0.1 68);
  --font-display: "Songti SC", "Noto Serif CJK SC", serif;  --font-body: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --radius-card: 8px;  --radius-control: 6px;  --radius-tile: 4px;  --radius-table: 16px;  --rule-hair: 1px;
}
```
间距、字号、缓动和时长也都在 `tokens.css`。不引入外部字体，中文走系统字栈。

## 用色规则
- 靛蓝只给牌桌本身：首页舞台、房间桌面、对局桌面、回放和牌形示例；深海军蓝是桌沿、导航和中央局况。
- 主色和点缀色都收住饱和度（靛蓝 C≈0.085，杏色 C≈0.125），不要把两个高饱和色贴在一起大面积使用。
- 杏色只表示“该你、选中、桌沿内的主操作、已准备”，也是牌背和牌的底层；柿红只表示立直、和牌和告急。
- 放在牌毡或导航上的区域把 `--color-focus` 换成近白的 `--color-focus-felt`，放回纸面时换回 `--color-focus-paper`。
- 选中牌靠抬起加杏色底条，键盘焦点靠近白外圈，两者不能只靠颜色区分。
- 改配色时检查界面文案里有没有提到具体颜色（规则页里有）。

## Controls
- Primary：靛蓝填充，牌桌操作区内为杏色，和牌按钮为柿红；圆角 `--radius-control`；高度 `--control-h`（40px，粗指针 44px）
- Secondary：描边，同圆角同高度
- 每屏一个填充主按钮；禁用态同时改填充、墨色和指针

## 版式
- 页面内容左缘对齐导航品牌，容器 `--container`；窄内容约束子元素宽度，不做居中窄栏。
- 列表优先用细线分行，不用卡片；不做卡片套卡片。
- 不用 eyebrow、字距拉开的大写标签、中点拼接的信息串和粘在文案后的箭头。

## 文案
- 语气：温润留白（2026-11-12 由项目负责人选定）。短句，少修饰，像熟人落座时的一句招呼；不写口号，也不写条款。
- 只告诉玩家此刻要知道、要做的事。实现细节（回执、裁决、会话、权威状态、毫秒数）不出现在界面上；规则说明留在规则页。
- 统一叫法：首页、牌桌（房间也叫牌桌）、战绩、好友、规则；入座、开一桌、开局、准备、托管、再来一场；游客、账号；东风战、半庄战。
- 首页只讲两件事：开桌快（一条链接即可入座，人不够 AI 补位）和手感好（3D 牌桌与快捷操作）。
- 按钮写动作，不写“确认××并××”；需要二次确认时，取消一侧写清它保留了什么（如“不过，留着荣和”）。

## Motion
- Character: brisk；只动 `transform` 和 `opacity`，无入场动画；减少动效模式下全部立即结束。

## Exports
`frontend/src/tokens.css`。
