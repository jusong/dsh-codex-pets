# dsh-pet

![deepseek-whale 待在设置页的画廊里](pets/deepseek-whale/preview.png)

DSH Desktop 的 macOS 桌面宠物。一只 DeepSeek 小鲸鱼常驻在所有窗口之上：**点一下把 DSH 唤到前台**，**拖着能换位置**，闲着的时候会自己晃晃、招手、跳一下。

- **宠物是纯数据**：一只宠物 = 一份 `pet.json` + 一张精灵图集，播放逻辑全在公共运行时里。加一只宠物不用写 JS。
- **包里只带一只**：`deepseek-whale`（自己画的）。更多宠物从 [codex-pets.net](https://codex-pets.net) 装、或从本机 Codex 导入，落在 `~/.dsh/pets/`，不随包分发。
- **可调**：设置页里换宠物、拉尺寸（120–260 px），还能打开「最近会话」球，点一下把某个会话带到前台。
- **只在 macOS 上**：宿主插件解析 manifest、看护子进程，原生 `NSPanel` 助手负责窗口（透明、置顶、跨 Space）。

---

## 安装

需要 macOS 13+ 和 DSH Desktop 0.2.1+。

```sh
dsh plugin --profile desktop add ./dsh-pet
```

插件只有一个依赖 `@deepseek-ai/schemastery`，先装它：

```sh
npm install        # 或 pnpm install
```

重启 DSH，鲸鱼就应该出现在屏幕右下、输入框上方。

如果没出现，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一段让 loader 加载它：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: deepseek-whale
    size: 220
```

这段是**可选的**：不写就用插件自带 `cordis.patch.yml` 的默认值（`deepseek-whale` / 220 px）。

---

## 用法

### 设置 → 宠物

设置面板左侧导航里的「宠物」就是它（同一个界面也挂在「插件 → 内置插件配置 → 桌面宠物」下）：

- **换宠物**：画廊里点一张卡片，宠物当场换掉，不用重启 DSH。
- **调大小**：上面是选中宠物的实时动画预览，下面是 120–260 px 的滑块，松手才写配置（拖动过程中不会一直重启助手）。
- **最近会话球**：打开后宠物脚下出现一个数字球，数字是最近会话数；点一下展开，点某一条把 DSH 窗口带到前面并打开那个会话。条数 1–10，默认关。
- 画廊分两段：**内置**（随插件发布的 `deepseek-whale`，不可删、不可拖）和**用户安装**（可删、可拖拽排序）。

### 装更多宠物

**从注册表装** —— 在 [codex-pets.net](https://codex-pets.net) 挑一只，把它的 **ID**（如 `deepseek`）或**页面链接**粘进输入框，回车即可：

- 装进 `~/.dsh/pets/<id>/`，自动排到用户段末尾并切换过去；
- 同一只（图集逐字节相同）装过就只是切过去，不会装第二份；
- 目录名被另一只占了会改叫 `<id>-2`，**从不覆盖**；
- 只认站点的 ID 和页面链接，别的网址一律拒绝。

**从 Codex 导入** —— 面板会扫本机 `~/.codex/pets`（或 `$CODEX_HOME/pets`），说有几只还没导入，点「一键导入」全部装进来。只读，不动 Codex 里的文件。

**命令行**（zip、本地文件夹、批量）：

```sh
node tools/install-pet.mjs deepseek                                 # 注册表里的 id
node tools/install-pet.mjs 'https://codex-pets.net/#/pets/deepseek' # 页面链接
node tools/install-pet.mjs ~/Downloads/deepseek.zip                 # 站点 Download 给的 zip
node tools/install-pet.mjs ~/.codex/pets/wangcai                    # 本机 Codex 里已有的
node tools/install-pet.mjs --codex-home wangcai blue-whale-girl     # 按 id 一次装多只
```

| 选项 | 作用 |
|---|---|
| `--id <id>` | 换个目录名装（只能一次一只；清单 id 不是 ASCII 时用得上） |
| `--force` | 替换已装的同名宠物（默认拒绝覆盖） |
| `--codex-home` | 把裸 id 当成 `~/.codex/pets` 下的目录 |
| `--registry <url>` | 换注册表（默认 `https://codex-pets.net`） |
| `--pets-dir <dir>` | 装到别处（默认 `~/.dsh/pets`） |
| `--dry-run` | 只检查来源，不写文件 |

安装器不需要额外依赖：Node 18+，zip 用系统的 `unzip`。

**删除**：用户段卡片右上角的 `×`，点一下就地变成确认，确认才真删（直接 `rm` 掉 `~/.dsh/pets/<id>/`，不进回收站）。内置宠物、正在用的宠物不能删，至少要留一只。

### 桌面上的行为

- **点击**：跳一下回应你，同时把 `DeepSeek Harness` 唤到前台；没在运行就打开 `/Applications/DeepSeek Harness.app`。
- **拖动**：窗口按屏幕刷新率跟手，松手后位置记住（`~/.dsh/dsh-pet-state.json`），下次启动还在那儿。
- **闲时**：每隔 3–6 秒演一个小动作（晃身 / 招手 / 忙活），播完回到 idle；每 18–30 秒来一次带粒子的表演。光标停在宠物上时会跳过，不在你手底下突然动。
- **看人**：v2 图集的宠物会转头盯着光标；包里这只 `deepseek-whale` 是 v1（九行，没有注视帧），所以不转头。
- **生命周期**：助手每秒检查一次宿主 PID，DSH 退出它自己退出；`flock` 保证同一时间只有一只。
- **无障碍**：系统开了「减少动态效果」时只画 idle 首帧。

### 配置

两个 volatile 字段（换宠物、改大小会即时生效）之外，还有三个会话球的开关：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: deepseek-whale   # pets/<id>/ 的目录名
    size: 220             # 120–260，CSS 像素
    sessions: false       # 脚下的最近会话球
    sessionLimit: 5       # 球里列几条（1–10）
    sessionMotion: false  # 有会话在忙时宠物不闲着，忙完跳一下
```

> profile 的 patch 层（`~/.dsh/profiles/desktop/cordis.patch.yml`）**优先于**插件自带的 `cordis.patch.yml`。设置页写的就是这一行，所以「改了没反应」时先看它：
>
> ```sh
> grep -A6 '^- id: dsh-pet' ~/.dsh/profiles/desktop/cordis.patch.yml
> ```

---

## 宠物

内置 **1 只**：`pets/deepseek-whale/` —— 一只 3D 软萌小鲸鱼，v1 图集（1536×1872，8 列 × 9 行），默认宠物。它的 manifest 是这份（节选：省掉了 `description`、`preview`、`drag` 等字段和另外七行动画）：

```json
{
  "id": "deepseek-whale",
  "name": "deepseek-whale",
  "size": 200,
  "spriteVersionNumber": 1,
  "spritesheetPath": "spritesheet.webp",
  "grid": { "columns": 8, "rows": 9 },
  "cell": { "width": 192, "height": 208 },
  "animations": {
    "idle": { "row": 0, "durations": [280, 110, 110, 140, 140, 140, 140, 320] },
    "jumping": { "row": 4, "durations": [140, 140, 140, 140, 140, 140, 140, 280] }
  }
}
```

完整的那份九行动画全都写出来了，见 [pets/deepseek-whale/pet.json](pets/deepseek-whale/pet.json)。

### 为什么包里只有一只

Codex 官方那 9 只宠物是 OpenAI 的第一方美术资产，服务条款禁止复制发行，打进公开仓库有法律风险。所以 `pets/` 只放自己画的、自己拥有的美术；官方和社区的宠物走「运行时安装到 `~/.dsh/pets/`」，包本身不分发素材。

### 自己加一只

一只宠物就是一个目录：

```
pets/<id>/
├── pet.json          # manifest：图集路径、网格、动画行表
├── spritesheet.webp  # 精灵图集
└── preview.png       # 画廊里的预览图（可选，缺了就从图集裁 idle 首帧）
```

图集契约和 Codex 完全一致，同一张图集可以直接装进 Codex：

| 项 | 值 |
|---|---|
| 尺寸 | `1536 × 1872`（v1，9 行）或 `1536 × 2288`（v2，11 行） |
| 网格 | 8 列 × 9 / 11 行，单元格 `192 × 208` |
| 行 0–8 | idle、running-right、running-left、waving、jumping、failed、waiting、running、review |
| 行 9–10 | 只 v2 有：16 个朝向，顺时针，`000°` 为正上方 |

把目录放进 `pets/` 并在 `pets/index.json` 里登记（内置，顺序即画廊顺序，第一条是默认宠物），或者直接丢进 `~/.dsh/pets/`（用户安装，不用登记）。清单里没写的字段按 Codex 契约补全。

从一只手工装进 Codex 的宠物移植过来，用自带脚本（数每行帧数、按真实帧数撑开时长、写 manifest 和预览图）：

```sh
python3 tools/port_custom_pet.py ~/.dsh/pets/deepseek-whale-2 \
    --id deepseek-whale --name deepseek-whale
```

校验图集合不合契约（格子尺寸、帧是否齐、有没有越界）：

```sh
python3 tools/check_pets.py
```

两个 Python 脚本需要 Pillow（macOS 系统 Python 装不了包，用 venv）：

```sh
python3 -m venv .venv && .venv/bin/pip install Pillow
.venv/bin/python tools/check_pets.py
```

---

## 目录结构

```
lib/           宿主半边（index.js）与设置页（client.js）、宠物仓库（pet-store.js）、Codex 契约（codex-pet.js）
runtime/       播放器：sprite-pet.js 引擎 + player.html
native/        AppKit 助手源码（main.swift，编译成 bin/dsh-pet-macos）
pets/          随包发布的宠物 + index.json（顺序即画廊顺序，第一条是默认宠物）
locale/        中英文案
tools/         测试、校验、安装器、移植脚本
docs/          实现笔记（为什么用原生助手、拖动排查、踩过的坑）
```

---

## 开发

```sh
node tools/test-sprite-pet.mjs      # 引擎：时间轴、注视帧映射、表演时序
node tools/test-codex-compat.mjs    # Codex 契约、读纯 Codex 宠物、安装器边界
node tools/test-pet-management.mjs  # 装 / 删 / 排序 / 导入路由与共用核心
node tools/test-session-ball.mjs    # 最近会话球
node tools/check-host.mjs           # 真的加载 lib/index.js 并调 Fetch 路由
python3 tools/check_pets.py         # 图集契约
```

不开窗口看一只宠物画得对不对：

```sh
bin/dsh-pet-macos --describe --pet-dir pets/deepseek-whale   # 每行几帧、有几帧真有像素
```

重新编译原生助手（产物提交在 `bin/`）：

```sh
swiftc -O -swift-version 5 -target arm64-apple-macosx13.0 \
  -framework AppKit -framework QuartzCore native/main.swift -o /tmp/dsh-pet-arm64
swiftc -O -swift-version 5 -target x86_64-apple-macosx13.0 \
  -framework AppKit -framework QuartzCore native/main.swift -o /tmp/dsh-pet-x86_64
lipo -create /tmp/dsh-pet-arm64 /tmp/dsh-pet-x86_64 -output bin/dsh-pet-macos
codesign --force --sign - bin/dsh-pet-macos
```

实现细节和排查记录在 [docs/internals.md](docs/internals.md)：为什么必须有原生助手、拖动为什么曾经不跟手，以及 `loadFileURL` / Fetch 路由 / volatile 字段那些坑。

---

## 限制

- 只支持 macOS；Windows / Linux 需要各自的置顶窗口实现。
- 窗口是矩形的，宠物四周的透明区域仍然会挡住点击。
- 助手是 ad-hoc 签名，适合本机用；要分发给别人得 Developer ID 签名并公证。
- 置顶级别 `.floating`；个别全屏应用可能盖住它（把 `panel.level` 改成 `.screenSaver` 会更靠前）。
- 动画只覆盖「空闲」这一种状态，`running` / `waiting` / `failed` 几行画好了，但宿主还没接 DSH 的任务状态。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-pet
```

如果你手工加过 `cordis.patch.yml` 里的 `dsh-pet` 段，一并删掉。
