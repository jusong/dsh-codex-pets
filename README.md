# dsh-pet

DSH Desktop 的 macOS 悬浮宠物：一只常驻在所有窗口之上的小家伙，拖动可以换位置，点击回到 DSH。

宠物是**纯数据**——一份 manifest 加一张精灵图集，播放逻辑全部由公共运行时提供。加一只新宠物不需要写代码。参考 Codex 的宠物方案。

内置 **9 只 Codex 官方宠物**（Codex / Dewey / Fireball / Hoots / Rocky / Seedy / Stacky / BSOD / Null Signal），全部是官方 v2 图集，会跟着光标转头。

另外还有 **2 只原创**（Cat / Bot）、**6 只派生**（同一只猫头鹰或同一颗豆芽换色加饰品）和 **1 只自定义**（蓝色大肥鱼）——共 **18 只**。

在 **DSH 设置 → 宠物** 里可以挑选宠物、调整它的大小，就像 Codex 的「Mini 与虚拟宠物」那样；设置写进 profile patch，改完立刻生效，不用重启 DSH。

---

## 为什么需要一个原生助手

DSH 的宿主插件跑在独立的 Node 子进程里（`ELECTRON_RUN_AS_NODE=1`），拿不到 Electron 的 `BrowserWindow`。所以：

- `lib/index.js` 是普通的 DSH 宿主插件，只负责解析 manifest、启动/回收助手进程。
- `native/main.swift` 编译出的 `bin/dsh-pet-macos` 是一个 AppKit `NSPanel`，负责窗口、透明、置顶、跨 Space、点击激活 DSH。

---

## 宠物方案：宠物 = 数据

这是本项目现在的核心。参考 Codex 的宠物方案：**宠物只提供数据，宿主负责播放**。

```
pets/<id>/
├── pet.json          # manifest：图集路径、网格、动画行表
├── spritesheet.webp  # 精灵图集
└── preview.png       # 选择器里用的预览图
```

### manifest 契约

```json
{
  "id": "hoots",
  "name": "Hoots",
  "description": "A sharp-eyed owl for polished work in a blink.",
  "size": 200,
  "preview": "preview.png",
  "type": "sprite",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp",
  "cell": { "width": 192, "height": 208 },
  "grid": { "columns": 8, "rows": 11 },
  "idle": "idle",
  "animations": {
    "idle":          { "row": 0, "durations": [280, 110, 110, 140, 140, 320] },
    "running-right": { "row": 1, "durations": [120, 120, 120, 120, 120, 120, 120, 220] },
    "running-left":  { "row": 2, "durations": [120, 120, 120, 120, 120, 120, 120, 220] },
    "waving":        { "row": 3, "durations": [140, 140, 140, 280] },
    "jumping":       { "row": 4, "durations": [140, 140, 140, 140, 280] },
    "failed":        { "row": 5, "durations": [140, 140, 140, 140, 140, 140, 140, 240] },
    "waiting":       { "row": 6, "durations": [150, 150, 150, 150, 150, 260] },
    "running":       { "row": 7, "durations": [120, 120, 120, 120, 120, 220] },
    "review":        { "row": 8, "durations": [150, 150, 150, 150, 150, 280] }
  },
  "drag": { "right": "running-right", "left": "running-left" },
  "look": { "rows": [9, 10], "count": 16, "startDegrees": 0, "stepDegrees": 22.5 },
  "react": { "click": "jumping" },
  "idleRoutine": { "every": [3, 6], "animations": ["waiting", "waving", "running"] },
  "perform": { "sequence": ["jumping", "waving"], "splash": "sparkle" }
}
```

- `animations` 的每一项 = 图集的一行 + 每帧的毫秒数。**运行时不知道 "idle" 是什么意思**，它只按 manifest 播。
- `durations` 允许逐帧不同，最后一帧通常拉长（Codex 的图集也是这个惯例）。
- `look` 描述 16 个朝向：第 9 行放 `000°~157.5°`，第 10 行放 `180°~337.5°`，`000°` 是正上方。
- `react.click` 是被点击时的反应动画（默认 `jumping`）。反应优先于注视，所以宠物是「跳起来回应你」，而不是「盯着你」。
- `idleRoutine` 是宠物自己找点事做的清单：每 `every` 秒挑一行播一次，播完回到 idle。`every` 可以是固定秒数，也可以是 `[最小, 最大]` 区间——区间让动作落在不同的节拍上，才不像循环动画。

### 图集契约

| 项 | 值 |
|---|---|
| 尺寸 | `1536 × 2288`（v2）；也接受 `1536 × 1872`（v1，9 行，没有注视行） |
| 网格 | 8 列 × 11 行 |
| 单元格 | `192 × 208` |
| 格式 | PNG 或 WebP，透明背景 |
| 行 0-8 | 9 个标准动画行，语义见上表 |
| 行 9-10 | 16 个朝向，顺时针，`000°` 为正上方 |

没用到的格子必须全透明。**这套网格和 Codex 的宠物图集一致**，同一张图集可以直接装进 Codex。

### 运行时负责什么

`runtime/sprite-pet.js` 是播放器，`runtime/player.html` 是所有 sprite 宠物共用的页面：

- 按 `durations` 逐帧播放；用 `requestAnimationFrame` 累加时间，帧率抖动不会累积误差
- **自己找点事做**：按 manifest 的 `idleRoutine` 每隔几秒播一行别的动作，播完回到 idle（官方图集的 idle 只改表情，不加这个宠物看起来就是冻住的）
- **光标跟随**：按光标相对宠物中心的角度选 16 向注视帧（这正是 Codex 那 16 行注视的用途）。**角度由原生助手算、原生助手通知页面**——不是页面等 pointermove 事件：宠物是后台应用，macOS 根本不会给它鼠标移动事件
- **拖拽**：拖动时按方向切 `running-right` / `running-left`，松手回到 idle
- **表演**：`perform()` 播 manifest 里写好的动作序列，返回总时长；结束时触发一次庆祝粒子
- **无障碍**：尊重系统「减少动态效果」，开启时只画 idle 首帧
- **画布自适应**：`ResizeObserver` 盯住画布，首帧布局没完成时不会把画布压成 1×1

公共部分（拖动/点击/消息桥）仍在 `runtime/pet-runtime.js`，由原生助手在 document start 注入。

### 新增一只 sprite 宠物

1. 做一张符合上面网格契约的图集，放进 `pets/<id>/spritesheet.webp`
2. 写 `pets/<id>/pet.json`，把图集的行语义填进 `animations`
3. 在 **设置 → 宠物** 里选它（也可以在 config 里写 `pet: <id>`）

不需要写任何 JS 或 HTML，也不需要登记：设置页的画廊每次请求都会重新读 `pets/`。`pets/index.json` 只管**随插件发布的那 18 只的顺序**（排在最前），其余任何带 `pet.json` 的目录按名字排在后面。

---

## 在设置页里装、删宠物

设置页的「可选宠物」下面有两样东西，**不用开终端**：

**安装宠物** —— 在 [codex-pets.net](https://codex-pets.net) 挑一只，复制它的 **ID**（如 `deepseek`）或**页面链接**（`https://codex-pets.net/#/pets/deepseek`），粘到输入框，回车或点「安装」：

- 装完自动切换到这只宠物；
- 同一只宠物（图集逐字节相同）已经装过，就只切换过去，不会装第二份；
- 目录名被**另一只**宠物占了，新宠物改叫 `<id>-2`、`-3`……，**不会覆盖**已有的；
- 只认站点的 ID 和页面链接；别的网址、`/download` 直链、文件路径一律拒绝（要装 zip 或本地文件夹，用下面的命令行）。

**从 Codex 导入** —— 面板会看本机 `~/.codex/pets`（或 `$CODEX_HOME/pets`），告诉你有几只还没导入，点「一键导入」全部装进来：

- 目录名就是宠物 id（`Mixed Case` → `mixed-case`）；
- 图集和已装的某只相同 → 跳过；目录名被另一只占了 → 跳过；**从不替换任何东西**；
- 某一只坏了（`pet.json` 解析不了、图集尺寸不对）只会算「失败」，不影响其余的；
- 只读 Codex 目录，不动里面的文件。

**删除宠物** —— 鼠标移到卡片上，右上角出现 `×`，点一下卡片就地变成「确定删除「xxx」吗？」，确认才真的删（**直接删掉 `pets/<id>/`，不进回收站**，默认焦点在「取消」上，`Esc` 也是取消）：

- **正在用的宠物不能删**（按钮置灰并说明原因），先选别的；
- 至少要留一只；
- 宿主只删「`pets/` 下带 `pet.json` 的真目录」：id 不是 `[a-z0-9-]+`、目录里没有 `pet.json` 都拒绝；符号链接只解除链接，不会顺着删到目标；
- 随插件发布的内置宠物也能删——想要回来就 `git checkout pets/<id>`。

三个动作在宿主里**一次只做一个**（两个窗口同时点也不会装出半只宠物），装的时候先写到 `pets/.<id>-xxxx/` 再整体改名，失败不留残骸。

宿主多了四条路由，都只在宿主进程里读写 `pets/`：

| 路由 | 作用 |
|---|---|
| `POST /api/dsh-pet/install` `{source}` | 按 ID / 页面链接装；返回 `{ok, already, pet}` |
| `POST /api/dsh-pet/remove` `{id}` | 删除；失败返回 `{error:{code,message}}`（`active` / `last` / `invalid-id` / `not-installed`） |
| `GET /api/dsh-pet/codex-pets` | 本机 Codex 里每只宠物的状态：`ready` / `installed` / `taken` / `failed` |
| `POST /api/dsh-pet/import-codex` | 一键导入，返回 `{installed, skipped, failed}` |

注册表地址默认 `https://codex-pets.net`，用环境变量 `DSH_PET_REGISTRY` 可以换。命令行和设置页共用 `lib/pet-store.js`，行为一致。

---

## 安装 Codex 宠物

[codex-pets.net](https://codex-pets.net) 上有很多社区做的 Codex 宠物，本项目**直接兼容**。设置页里就能装（见上一节）；命令行还能装 zip 和本地文件夹：

```bash
node tools/install-pet.mjs deepseek                                   # 站点上的宠物 id
node tools/install-pet.mjs 'https://codex-pets.net/#/pets/deepseek'    # 或者直接贴页面链接
node tools/install-pet.mjs ~/Downloads/deepseek.zip                    # 站点 Download 按钮给的 zip
node tools/install-pet.mjs ~/.codex/pets/wangcai                       # 本机 Codex 里已有的
node tools/install-pet.mjs --codex-home wangcai blue-whale-girl        # 同上，按 id 一次装多只
```

不需要 Python、不需要任何依赖：Node 18+ 就行（zip 用系统自带的 `unzip`）。装完刷新设置页，宠物就在画廊里，**不用登记**（要让桌面上的宠物换成它，在设置页点一下即可）。

| 选项 | 作用 |
|---|---|
| `--id <id>` | 换个目录名装（只能一次装一只）。清单 id 不是 ASCII（比如中文）又没法从文件夹名推出来时必须给 |
| `--force` | 替换已经装过的同名宠物。默认**拒绝覆盖**，并告诉你用 `--id` 并存还是 `--force` 替换 |
| `--registry <url>` | 换一个注册表地址（默认 `https://codex-pets.net`） |
| `--pets-dir <dir>` | 装到别处（默认本项目的 `pets/`） |
| `--dry-run` | 只检查来源、说明会装什么，不写任何文件 |

### 兼容的到底是什么

一只 Codex 宠物就是**两个文件**，别的什么都没有：

```
pet.json          { "id", "displayName", "description", "spritesheetPath", "spriteVersionNumber"?, "kind"? }
spritesheet.webp  1536 × 1872（v1，9 行）或 1536 × 2288（v2，11 行，多 16 个注视方向）
```

**它没有动画表。** 每一行是哪个动画、有几帧、每帧多久，是 Codex 契约规定的，不是宠物自己写的。所以本项目把这张表放在一个地方（`lib/codex-pet.js`，原生端 `CodexContract` 里有同一份），`pet.json` 里没写的字段都按它补：

| 缺什么 | 怎么补 |
|---|---|
| `animations` | 官方 9 行 + 每帧时长 |
| 版本、行数 | **以图集真实像素高度为准**：1872 → v1 / 9 行，2288 → v2 / 11 行；`pet.json` 里的 `spriteVersionNumber` 写错了也以图集为准（装的时候会提示） |
| `look`（注视光标） | 只有 v2 才有。**v1 宠物没有那 16 行，所以不会转头看光标**——这是图集决定的，不是兼容性缺陷 |
| `drag` / `react` / `idleRoutine` / `perform` | 和内置宠物一样：拖动切 `running-left/right`、点击跳一下、闲着时在 `waiting / waving / running` 里挑一个演、表演带粒子 |
| `name` | 取 `displayName` |
| 预览图 | Codex 宠物没有。设置页直接从图集里裁待机第一帧当缩略图 |

`pet.json` 里**写了**的字段一律优先，所以本项目自己的完整清单（内置 18 只）读出来和以前一模一样。

安装器做的事：先校验（`pet.json` 合法、`spritesheetPath` 只能是文件名不能是路径、图集是 `.webp/.png` 且恰好是上面两种尺寸之一），再把图集**原样**复制过去，把补全后的清单写成 `pet.json`（保留 `displayName`、`kind` 等原字段，记下 `source`）。先写到临时目录再改名，失败不会留下半只宠物。**手动把 Codex 宠物文件夹拷进 `pets/` 也行**——读取端对只有 Codex 字段的 `pet.json` 同样宽容，安装器只是帮你校验和补全。目录名就是宠物 id，清单里的 `id` 和目录名不一致也没关系。

两点安全：`pet.json` 是别人写的，里面的文件名必须是**目录内的文件名**，`../x` 这类路径宿主和安装器都会拒绝；站点的图集链接必须是 `https`（只有 `localhost` 允许 `http`），大小上限 32MB。

### 怎么验证一只宠物能正常播放

原生助手带一个诊断参数，不开窗口，只报告清单怎么对上了图集：

```bash
bin/dsh-pet-macos --describe --pet-dir pets/deepseek-whale
```

输出网格、拖动/点击用哪一行、**每个动画有几帧、其中几帧格子里真有像素**（`drawn` 必须等于 `frames`）、16 个注视格有几个有图。行映射错了（比如把 v1 图集按 11 行切）这里一眼就能看出来。

---

## 行为

- `NSPanel` + `.floating` + `.canJoinAllSpaces` + `.fullScreenAuxiliary`：浮在普通窗口之上，跟随所有桌面。
- 默认出现在屏幕右下、输入框上方，避免挡住发送按钮；拖到任意位置后会记住。
- 点击宠物：`NSRunningApplication` 激活 `com.deepseek.dsh`；如果 DSH 没在运行，则打开 `/Applications/DeepSeek Harness.app`。
- 拖动宠物：窗口跟着鼠标移动，位置保存在 `~/.dsh/dsh-pet-state.json`。**按下事件由原生助手直接捕获**（不经过页面），拖动从按下的确切位置开始；窗口按屏幕刷新率移动。细节见下面「拖动跟手」那一节。
- 每次拖动都会在 `~/.dsh/dsh-pet-drag.log` 留一行：延迟多少毫秒才开始跟、最多落后光标多少像素。
- 原地表演：每隔 18–30 秒播一次 manifest 里定义的动作序列，结束时溅一圈庆祝粒子。
  - 鼠标停在宠物上时会跳过本轮，避免在光标下突然动起来。
  - 拖动会打断正在进行的表演；窗口位置只在拖动时改变，不会再自己横穿屏幕。
- 闲时自己动：按 `idleRoutine` 每隔 3–6 秒播一次小动作（晃身、招手、干活），播完回到 idle。间隔是随机的，所以看起来像活的而不是循环动画。
- 看人：光标在宠物身上时，宠物会转头盯着它（16 向注视帧）。**由原生助手每帧读真实光标位置**，所以即使宠物不是前台应用（浮在别人桌面上的宠物通常不是）也照样看着你。**光标一移开，宠物立刻回到自己的动画**——盯着光标的那几帧是静止的，不松开就会一直冻在那个姿势上。
- 被点一下：宠物会**跳一下**来回你（manifest 里的 `react.click`）。反应时注视会让位，所以你看得到的是跳跃而不是一张静止的脸；跳完回到闲时状态。点击仍然会把 DSH 唤到前台（这是宠物存在的意义）。
- 助手每 1 秒检查 DSH 宿主 PID；宿主退出后自动退出。`flock` 保证同一时间只有一只宠物。
- 纯本机资源，没有网络请求，不读凭据。

---

## 拖动跟手：别让窗口追不上光标

拖动宠物曾经很卡，光标和宠物之间有明显延迟。这一节记的是**两轮排查的真实结论**，包括第一轮那个**是错的**结论——留着它，是因为它说明了这类问题最容易骗人的地方。

### 第一轮的结论：搬窗口很贵（错了）

第一轮的假设是：拖动时每移动一次窗口，窗口服务器都要把整个 WebView 层重新合成一遍，所以「搬窗口」是瓶颈。代码按这个假设改了（注视合并、消息合并、每帧最多搬一次）。

**这个假设是错的。** 把三处改动都量完之后，真相是：

| 量 | 值 |
|---|---|
| 一次 `setFrameOrigin` 的主线程开销 | **0.33ms**（240 次搬窗共 80ms） |
| 跟随时器被推迟 >20ms 的次数 | **0** |
| 跟随时器的间隔抖动 | **1.96ms**（中位数 8.38ms，120Hz） |

搬窗口一点都不贵。**那基准里那些 100ms+ 的停顿是谁造的？——是基准自己。** 它每 4 帧调一次 `CGWindowListCopyWindowInfo` 去问窗口服务器「你到底把窗口画到哪了」，而这个调用**恰好在刚搬完窗的时候最慢：71ms 一次**。窗口服务器正忙着提交这次移动，查询就排在后面。

关掉探针再测，同样的拖动：**0 帧迟到**。

> 教训：测量工具本身会成为被测系统的负载，而且它总在最关键的时刻最慢。要证明「是 X 慢」，先证明「测量 X 的那个动作不慢」。

### 真正的两个病根

排掉假线索之后，剩下两条是查出来、也修掉的：

**病根一：后台应用根本收不到鼠标移动事件。**

macOS 只把 mouse-moved 事件发给**前台**应用。宠物助手是 `NSApplication.shared` 配 `setActivationPolicy(.accessory)`——一个浮在别人桌面上的后台应用。于是：

- 页面的 `pointermove` 一次都不会触发 → **注视功能在真实环境里是坏的**（除非助手碰巧成了前台应用）。
- 拖动的起点必须绕一圈：WebKit 收事件 → 页面 `postMessage` → 原生才知道。实测这一圈 **~12ms**。

**病根二：拖动的起点由页面决定。**

按下事件要先经过 WebView 和页面，原生侧才知道「开始拖」，于是宠物是「迟到」才开始跟的。

### 这一轮的改动

1. **原生侧直接捕获按下**（`native/main.swift`）：`NSEvent.addLocalMonitorForEvents` 在事件交给 WebView **之前**看到它。拖动因此从按下的**确切位置**开始，页面只是顺带知道了这件事。
2. **原生侧驱动注视**（`native/main.swift` + `runtime/pet-runtime.js`）：原生按屏幕刷新率读真实光标位置，自己算 16 向角度，**只在角度变了**时才通过 `DSHPet.look(x, y)` 告诉页面。注视不再依赖页面收到 pointermove，后台应用也能看着你。
3. **删掉 `move` 消息**（`runtime/pet-runtime.js`）：页面不再为每个 pointermove 过一次桥——原生侧读的是真实光标位置，本来就不需要这个信息。

### 量出来的效果

端到端基准：合成一次按下，把**真实光标**以 700px/s 沿直线拖动 1 秒，全程记录宠物落后光标多少像素。

| | 旧路径（页面报按下） | 现在（原生捕获按下） |
|---|---|---|
| 按下 → 宠物第一次动 | 12.5ms | **9.0ms**（一帧内） |
| 拖动中最大落后 | 8px | **6px** |
| 拖动结束时的偏差 | 0px | **0px**（抓哪儿就还在哪儿） |
| 跟随帧迟到 >20ms | — | **0** |

### 怎么复现

```sh
# 端到端：合成一次按下，真实光标沿直线拖 1 秒
bin/dsh-pet-macos --pet-dir pets/hoots --runtime runtime/pet-runtime.js \
  --size 200 --lock /tmp/dsh-pet-bench.lock --drag-bench --bench-profile press
# -> press bench: moves=120 attempts=120 pressToFirstMoveMs=9.0 maxTrailPx=6.0 finalTrailPx=0.0 moved=true

# 对照：把拖动放回旧路径（由页面的 down 消息启动）
bin/dsh-pet-macos --pet-dir pets/hoots --runtime runtime/pet-runtime.js \
  --size 200 --lock /tmp/dsh-pet-bench.lock --drag-bench --bench-profile oldpress
# -> press bench: moves=119 attempts=119 pressToFirstMoveMs=13.2 maxTrailPx=8.0 finalTrailPx=0.0 moved=true

# 真实拖动时，助手会把结果写进 ~/.dsh/dsh-pet-drag.log
```

`--bench-profile press` 用的是**它自己按下去的事件**（`NSApp.postEvent` 直接投进应用），因为这台机器上**系统会丢掉合成的鼠标事件**（`CGEvent.post` 之后 `NSEvent.pressedMouseButtons` 纹丝不动）。光标本身倒是可以动——`CGWarpMouseCursorPosition` 好使——所以拖动的轨迹是真的，只有「按下」是投进去的。

### 还没做到的一件事

Codex 在 macOS 上（单显示器、native 模式）把拖动**整个交给系统**：`performDrag(with:)`，窗口服务器自己跟光标，一步都不等应用。理论上限比我们的「每帧搬一次窗口」更高。

这条路这里**没有采用**，因为它在本机无法验证：合成按键被系统丢掉，而 `performDrag` 需要一次真实的按下才能测；而且它会把 pointerdown/up 从页面手里拿走（反应动画和拖拽动画都要改成原生驱动）。**不能验证的机制不进仓库**——这一节记着它，等有能真机验证的条件再说。

---

## 安装

```sh
dsh plugin --profile desktop add ./dsh-pet
```

插件用 `@deepseek-ai/schemastery` 声明自己的配置（两个 volatile 字段），装之前先装依赖：

```sh
npm install            # 或 pnpm install
```

DSH Desktop 0.2.1 的 profile 由应用自己管理。如果装完没有立即出现宠物，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一行让 loader 热加载：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: codex
    size: 220
```

这行是**可选的**：不写就用插件自带 `cordis.patch.yml` 里的默认值，装好之后到 **设置 → 宠物** 里挑就行。重启 DSH 后，bundle 自己会加载，不需要这行手工配置。

## 在设置里切换宠物和大小

插件带一个**设置分区**，挂在 DSH 设置面板左侧导航的「宠物」上（`settings.section` slot，id `pet`）：

- 列出宿主持有的每一只宠物（网格 + 预览图），**点一下就选中并立即生效**；
- 上方是选中宠物的**实时动画预览**（直接读它的精灵图集，按 manifest 的帧时长播放）；
- 下面是**尺寸滑块**（120–260 px），预览会跟着一起缩放；
- **没有保存按钮**：`pet` / `size` 一改就写进 profile patch，宿主随即重启助手，桌面上的宠物当场换掉；
- 画廊每张卡片带删除按钮，下面是安装/导入面板（见上一节）；
- **最近会话**开关：打开后宠物下方出现一个数字球，数字是列表里的会话数。点一下展开最近交互过的会话（标题，正在跑的显示「正在思考」），再点收起；点某一条会把 DSH 窗口带到前面并打开那个会话。数量 1–10，默认关。子会话和还没发过言的空会话不进列表。

> 尺寸滑块不会在拖动的每一帧都写宿主——那样每拖一下就要重启一次助手。做法是：本地先记一个草稿值让预览跟着走，**手势结束**（松手 / 松键 / 失焦）或 500 毫秒后写一次，一次手势只写一次。

同一套界面也挂在**插件页**上（`plugins.item` slot，id `dsh-pet`）：侧边栏「插件 → 内置插件配置 → 桌面宠物」，
和「子智能体 / 网页搜索 / Agent 循环」这些官方卡片并列；点进去就是同一个选择器，插件卡片上显示一行
「当前：Codex · 220 px」。

实现分成两半，和 DSH 其它 UI 插件一样：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | 宿主半边。声明 `Config`，注册画廊/图集/预览，以及安装/删除/导入共七条 Fetch 路由，启动并看护原生助手 |
| `lib/pet-store.js` | 装、删、扫描 Codex 目录的共用核心；设置页路由和 `tools/install-pet.mjs` 用的是同一份 |
| `lib/client.js` | 浏览器半边。注册 `settings.section` 与 `plugins.item`，渲染画廊（含删除）、预览、滑块、安装/导入面板，调用 `ctx.configForms` 写设置 |

两个设置都是 **volatile** 字段，所以 DSH 会把写入直接提交进运行中的引用，并用 `loader/volatile-update` 通知宿主——**宿主据此重启助手**，于是换宠物/改大小都不需要重启 DSH。

画廊和图集走的是 DSH 的 **exact Fetch 路由**（`ctx.connection.fetch.register`），Web 版和 Desktop 版走的是同一条通路；Desktop 的渲染进程是 `dsh-app://` 自定义协议，fetch 经 IPC 桥转发到宿主，路由照样命中。

也可以直接改配置：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: hoots          # 对应 pets/hoots/pet.json
    size: 220           # 省略时用 schema 默认值 220
```

`lib/index.js` 读 manifest，按 `spritesheetPath` 找到图集。找不到就退回画廊里第一只确实存在的宠物（默认宠物也是动态取出来的，删掉一只宠物不会把宿主指向空气）。

> **注意**：DSH profile 的 patch 层（`~/.dsh/profiles/desktop/cordis.patch.yml`）优先级**高于**插件自带的 `cordis.patch.yml`。重装或切宠物后如果"没变化"，先查这一行：
>
> ```sh
> grep -A3 '^- id: dsh-pet' ~/.dsh/profiles/desktop/cordis.patch.yml
> ```
>
> 设置页写的就是这一行，所以它和设置页显示的值永远一致；手工改这一行同样会立即生效。

---

## 内置的 9 只 Codex 官方宠物

| id | 名字 | 说明 |
|---|---|---|
| `codex` | Codex | The original Codex companion. |
| `dewey` | Dewey | A calm companion for focused workspace days |
| `fireball` | Fireball | Hot path energy for fast iteration |
| `hoots` | Hoots | A sharp-eyed owl for polished work in a blink. |
| `rocky` | Rocky | A steady rock when the diff gets larger |
| `seedy` | Seedy | Small green shoots for new ideas |
| `stacky` | Stacky | A balanced stack for deep work |
| `bsod` | BSOD | A tiny blue-screen gremlin |
| `null-signal` | Null Signal | Quiet signal from the void |

图集是 **8×11（1536×2288，v2）**，行语义和本项目的契约完全一致：

| 行 | 状态 | 用的列 | 帧时长 |
|---|---|---|---|
| 0 | idle | 0-5 | 280, 110, 110, 140, 140, 320 ms |
| 1 | running-right | 0-7 | 120 ms each，末帧 220 |
| 2 | running-left | 0-7 | 120 ms each，末帧 220 |
| 3 | waving | 0-3 | 140 ms each，末帧 280 |
| 4 | jumping | 0-4 | 140 ms each，末帧 280 |
| 5 | failed | 0-7 | 140 ms each，末帧 240 |
| 6 | waiting | 0-5 | 150 ms each，末帧 260 |
| 7 | running | 0-5 | 120 ms each，末帧 220 |
| 8 | review | 0-5 | 150 ms each，末帧 280 |
| 9-10 | 16 个朝向 | 0-7 each | 静态帧，按角度选 |

这套表直接抄自 Codex 桌面版自己的动画表（`requiredFramesByRow: [6,8,8,4,5,8,6,6,6,8,8]`），所以播放节奏和 Codex 里的表现一致。

### 素材从哪来：CDN 和 app.asar 不是一回事

**这是 `hoots` 当初没被移植过来的原因**，也是移植脚本里唯一有难度的部分：

- **Codex 终端 CLI** 只认 **8 只**（codex / dewey / fireball / rocky / seedy / stacky / bsod / null-signal），图集由 OpenAI 的 CDN 发布：`persistent.oaistatic.com/codex/pets/v1/<id>-spritesheet-v4.webp`，形状是 **v1（8×9）**。
- **Codex 桌面版（ChatGPT.app）** 打包了 **9 只**，多出来的那只就是 **`hoots`**（一只戴眼镜的猫头鹰）。它的图集不在 CDN 上，而是**直接打在 `app.asar` 里**，形状是 **v2（8×11）**。

只按 CLI 的清单去枚举 CDN，永远也拿不到 `hoots`——它在那个枚举源里根本不存在。

移植脚本因此默认从桌面版的 `app.asar` 里抽图集，并自动识别 v1 / v2 形状：

```sh
python3 tools/port_codex_pets.py                # 全部，默认读桌面版 app.asar
python3 tools/port_codex_pets.py hoots          # 指定几只
python3 tools/port_codex_pets.py --source cdn   # 改用 CDN 的 v1 图集
```

`app.asar` 的读法（踩坑记录）：文件是「8 字节 pickle 头 + 头块 + 数据段」，**数据段起点 = 8 + 头块长度**（头块长度的第 2 个 UInt32），头块里第一个 UInt32 是 JSON 长度，JSON 里每个文件的 `offset` 是相对数据段的偏移。少了任何一步都会把文件读成「上一个文件的尾巴 + 本文件少几个字节」。

每个 manifest 的 `source` 字段记录了素材来源（桌面版时是 asar 里的路径，CDN 时是原始 URL）。

### manifest 里多出来的两个小能力

- `manifest.drag` — 拖拽时播哪两个动画。Codex 这批叫 `running-right` / `running-left`；做成可配的，以后自定义宠物可以叫别的。
- `manifest.perform.splash` — 庆祝粒子类型。`"sparkle"` 是金色星星（Codex 这批），`true` 是水花，`false` 不要。

---

## 2 只原创宠物

`cat` / `bot` 是本项目自己画的。

| id | 名字 | 说明 |
|---|---|---|
| `cat` | Cat | A round ginger cat that swishes its tail and stretches when it hops. |
| `bot` | Bot | A little bot whose screen makes faces and whose antenna wobbles. |

**只留有腿的。** 最早还画了果冻、幽灵、豆芽三只，但它们都没有腿——走路那两行（`running-right` / `running-left`）演不出来：没有腿就没有迈步，没有迈步就只能靠位移糊弄，看着像在飘。三只已经删掉，`tools/make_pets.py` 里也不留它们的代码。

### 为什么又画了一套

上面那 9 只官方宠物是 OpenAI 的**第一方美术资产**，不是开源素材：`ChatGPT.app/Contents/Resources/THIRD_PARTY_NOTICES.txt` 里只列第三方开源组件，**没有它们**；Codex 的服务条款把「复制、发行」和「逆向工程」都划为禁止，并明确写了 OpenAI 拥有 Services 的全部权利，还留着 copyright complaints 表格。

也就是说，**把这 9 只镜像进一个公开仓库是有法律风险的**。原创这套不是为了「画得更好」，是为了让这个仓库和这个插件对外公开的那部分**是干净的**。

（想继续用官方那 9 只、且不想分发素材，只有干净的做法是**运行时从 OpenAI 的公开 CDN 拉**，8 只都有；`hoots` 只存在于桌面版 app.asar 里，CDN 上没有。）

### 宠物不是图片，是骨架

`tools/make_pets.py` 里每只宠物是一小段 Python：几个形状 + 几条运动规则，渲染出来的图集和官方那套契约完全一样，**引擎分辨不出来源**。

- 画在 **48×52 的网格**上，一个网格像素 = 4 个图像素，缩放**恒为 1**——保证每个像素块一样大。
- 造型语言：硬边像素 + 垂直渐变阴影 + 左上高光 + 1px 描边。
- 帧时长直接抄官方那套，所以播放节奏和官方宠物一致。

猫是这套骨架里最讲究的一只：**四条腿**（两条前腿画在身体前面、颜色是主体色；两条后腿画在身体后面、颜色是暗一档的阴影色，一眼能分出前后），走路用**对角步态**——左前腿和右后腿一起动、右前腿和左后腿一起动，像真猫那样；挥手的动作不是多长一只手，而是**抬起右前腿**。

**尾巴会跟着方向走。** 站着的时候它卷在身侧；朝右走，它甩到**身后（左边）**；朝左走，它甩到身后（右边）；转身（16 向注视）的时候它收短。尾巴的方向由 pose 里的 `facing` 决定，不是画死的。

#### 九行动作：对齐官方语义

| 行 | 状态 | 我们怎么演 |
|---|---|---|
| 0 | idle | 呼吸起伏，第 4 帧眨眼（和官方一样只动脸） |
| 1 / 2 | running-right / left | **朝那个方向走**：身体前倾 3 格、脑袋带着走、身子上下颠、脸朝行进方向看；四条腿按**对角步态**迈（两条对角线上的腿一起动），摆动的那条会离地 |
| 3 | waving | 抬起一只爪子挥 |
| 4 | jumping | 蹲-起-顶-落-落地，顶点抬 4 格（16px，和官方一致） |
| 5 | failed | 下沉、左右抖、X 眼 / 沮丧眼交替 |
| 6 | waiting | **环顾四周**：脑袋左右转 ±3 格、眼睛往别处看、身体跟着晃、尾巴抖 |
| 7 | running | **忙着干活**：手里拿着东西低头看——猫玩毛线球、机器人举平板 |
| 8 | review | 举放大镜低头看（放大镜用爪子连着，不是浮在空里） |
| 9-10 | 16 个朝向 | 见下 |

#### 16 个朝向：偏航转身 + 俯仰抬头

官方那 9 只的注视行是**绕垂直轴的转台**：第 0 帧正面、第 4 帧右侧面、第 8 帧背面、第 12 帧左侧面（我把官方图集逐帧导出来量过包围盒才确认的）。也就是说官方**只有左右转身，没有上下看**——指针在宠物正上方时，它转过来正对着你。

我们把两件事合在一起：

- **左右沿用官方的转台**：身体按 `sin(角度)` 横向收窄最多 25%，尾巴收进身侧，转过 55° 之后**远侧那只眼睛消失**——这一下就把「侧脸」演出来了。
- **上下用俯仰补上**：指针在上方时脑袋抬 3 格、眼睛上移；指针在下方时脑袋低 3 格、眼睛下移。

引擎的映射是「0° 正上方起、顺时针、22.5° 一格」，实测四个方向选中的帧正好是：

| 指针位置 | 引擎选中的格子 |
|---|---|
| 正上方 | 行 9 第 0 格 |
| 正右方 | 行 9 第 4 格 |
| 正下方 | 行 10 第 0 格 |
| 正左方 | 行 10 第 4 格 |

```sh
python3 tools/make_pets.py          # 重画全部 2 只（图集 + preview + manifest）
python3 tools/check_pets.py          # 校验全部宠物的图集契约
```

`check_pets.py` 会逐只检查：manifest 字段齐不齐、格子是不是 192×208、图集是不是 1536×2288、**manifest 真正用到的每一帧都非空**、没有一帧画到邻居格子里、静止时宠物既不悬空也不陷进地板、跳跃不会飞出格子。14 只（官方 9 + 原创 2 + 派生 3）全部通过。

---

## 3 只派生宠物：同一个猫头鹰，换个颜色、加点穿戴

`teal-hoot` / `violet-hoot` / `mint-hoot` 是**从 `hoots` 派生**出来的：同一只猫头鹰，换一身羽毛颜色，戴一顶帽子、系一条领结。

| id | 名字 | 羽毛 | 帽子 | 领结 |
|---|---|---|---|---|
| `teal-hoot` | Teal Hoot | 蓝绿 | 琥珀 | 珊瑚红 |
| `violet-hoot` | Violet Hoot | 紫 | 珊瑚红 | 金 |
| `mint-hoot` | Mint Hoot | 薄荷绿 | 藏青 | 粉 |

**动作种类和官方 hoots 完全一致。** 派生宠物不是重新画的动画，而是**在同一张图集上逐帧改**：行数、每行的帧数、每帧的时长、16 向注视的行，全都是源宠物 manifest 里的原值，一个字节都没动。所以 `teal-hoot` 走路的节奏、眨眼的第 4 帧、跳跃抬 4 格，和 `hoots` 一模一样。

> ⚠️ **合规提醒**：这 3 只**用官方 hoots 的美术改的**，和仓库里那 9 只官方素材承担**同样的分发风险**（OpenAI 第一方资产，服务条款禁止复制发行）。下面那 3 只 seedy 派生宠物同理。它们是为了满足「换配色、加饰品、动作不变」的需求而存在的；真要让仓库对外公开的那部分干净，得把这 6 只也去掉，只留 `cat` / `bot`。

### 怎么改色的：调色板重映射，不是色相旋转

第一版用的是「按饱和度加权地旋转色相」——羽毛全旋、奶油脸盘和眼白不动。看起来能跑，但**阴影里的脸盘会变成黄绿色**：实测脸盘的饱和度在受光处是 0.26、在阴影里是 0.42，而加权旋转从 0.30 就开始介入，阴影部分于是被转到绿色去。更糟的是奶油色的判定要求 `r >= g >= b`，**转成绿色之后整块脸盘从连通块里碎掉**，脸盘定位直接失效。

现在改成**沿「奶油 → 橙羽」轴做投影**：

1. 源图集的颜色都落在这条轴上——奶油脸盘 `rgb(253,225,181)` 是一端，橙羽 `rgb(253,125,1)` 是另一端。
2. 每个像素投影到这条轴上，得到它「有多橙」（0 = 纯奶油，1 = 纯羽毛）。
3. 用同样的比例去混**新的**奶油色和新的羽毛色。
4. 亮度按原图的比例还原——这一步是阴影和高光能留下来的原因。

好处是**中间只会出现新奶油和新羽毛的混合色**，不会经过绿色；而且亮度是按比例还原的，原渲染的柔和渐变完整保留。

（顺带测出来：**喙和额头那一小块楔形跟羽毛是同一个橙色**，所以它们会一起变色；这没有影响，反而更像同一只鸟。）

### 怎么定位帽子和领结

帽子和领结要跟着头动，而头在每一帧里都不一样大、不一样歪。这套锚点是量出来之后定下来的：

- **脸盘**：取「最靠上的那块奶油连通块」。脸上戴的道具（马克杯、记事本、书）都在更下面，肚子上那块高光也更低，所以最靠上的那块一定是脸。奶油阈值 `饱和度 <= 0.46` 是按实测定的（受光 0.26 / 阴影 0.42 / 羽毛 0.8 以上）。
- **头顶**：从脸盘中心那一列往上走，撞到透明为止——这是头顶真正的位置。用脸盘自身的**高度**是不行的：肚子的高光有时会和脸盘连成一整块，把「脸盘高度」撑大一倍。
- **转向帧的帽子**：官方那 16 向注视是**转台**——身体不动、只有头在转，所以头顶在屏幕上是不动的，脸却在左右甩。实测脸心在 58~132 之间来回摆，而精灵轮廓顶部跨度的中点稳定在 83~102。所以转台帧里帽子按轮廓定位，其余帧按脸心定位。
- **下巴线**：脸盘每一列的奶油段结束位置，取 **80 百分位**——中间几列被眼睛/眼镜截断没关系，一对眼睛不足以把整体拉上去。

领结挂在**喙**下面，喙挂在下巴线下面，所以领结的位置 = 下巴线 + 0.85 × 头顶高度，并且**不超过脸盘下缘 0.25 × 脸宽**——否则抱着书的那一帧，领结会掉到书上。

### 这三只在真实运行时里验过

不只是静态图过校验。真的 WKWebView 里跑过：图集加载无报错、动画在跑（`rafCount` 持续增长）、真实 `pointermove` 事件驱动下**四个方向的注视帧都对**（正上=行9第0格、正右=行9第4格、正下=行10第0格、正左=行10第4格），而且每个方向帽子和领结都跟着头走。

```sh
python3 tools/derive_pets.py           # 重新派生这 3 只
python3 tools/derive_pets.py --debug   # 顺便出一张标注脸盘锚点的接触表
```

---

## 又 3 只派生宠物：同一颗豆芽，换个颜色、戴顶草帽

`sky-seedy` / `rose-seedy` / `lilac-seedy` 是**从 `seedy` 派生**出来的，和上面那 3 只猫头鹰是同一套机制——**同一张图集上逐帧改**，动作种类、行数、帧数、时长、16 向注视全部沿用源宠物 manifest 的原值。

| id | 名字 | 豆芽 | 帽子 |
|---|---|---|---|
| `sky-seedy` | Sky Seedy | 天蓝 | 琥珀草帽 |
| `rose-seedy` | Rose Seedy | 玫瑰粉 | 青色 |
| `lilac-seedy` | Lilac Seedy | 丁香紫 | 金 |

> ⚠️ 这 3 只同样是用官方 seedy 的美术改的，分发风险和上面那 3 只一样。

但 seedy 跟 hoots 是**两种完全不同的角色**，工具里的做法也跟着分了两条路。

### 改色为什么不能沿用「调色板重映射」

hoots 那套是「把像素投影到奶油→橙羽那条轴上」，前提是**这只角色的颜色都落在一条轴上**。seedy 不满足：它的身体是橄榄米色 `rgb(179,170,118)`，脸屏是奶油 `rgb(245,228,196)`，两者几乎同色——奶油→身体这条轴的向量只有 `(-5,-4,-4)`，投影结果被噪声淹没，整张图会糊成一片。

所以 seedy 改用**色相旋转 + 角色掩膜**：整体转色相（保留角色内部各部分原有的色相关系，所以还是像它自己），再用一张掩膜把「不该变色的部分」保护起来：

- **脸屏**：奶油色 `饱和度 <= 0.28 且 明度 >= 0.90`。seedy 的脸屏和头框之间有一道深色分隔线，所以紧掩膜能把脸屏单独抓出来（实测每帧脸屏宽 69~73px，很稳）。
- **头顶的芽**：按**位置**保护（头顶以上的整行），不按颜色。按颜色保护是不行的——身体橄榄色 `饱和度 0.34` 正好落在芽的色相/饱和度区间里，一按颜色锁就把身体也锁住不改色了。
- **肚子上那颗绿点**和**腮红**：绿点 `饱和度 >= 0.55`，腮红 `饱和度 >= 0.22 且 20 度上下`。

### 头是个会转的方盒子，帽子得跟着缩

seedy 的头不是固定的，是**一个会转的立方体**。前 9 行动作里它基本朝正面，16 向注视那两行则是真的在转——转到某个角度，脸上的屏幕会缩成一条缝，甚至整个朝后看不见屏幕（行10第0格）。

这就带来三个坑：

1. **锚点必须在原图上找。** 第一版把 `find_head` 写在了改色**之后**的图上，于是它去找的是「色相 55~70 的黄绿色框」——而那副颜料的色相已经被转走了（+160 度 → 215 度），于是在改色后的图上只能捡到几个抗锯齿的散点，帽子锚点彻底乱掉。**脸盘定位要跑原图，头部定位也一样。**

2. **身体和头穿几乎同一种颜色，不能取「最大块」。** 头框是 `rgb(213,214,169)`（色相 55~70、饱和度 0.21~0.25），身体是 `rgb(179,170,118)`（色相 51、饱和度 0.34）——差了好几个色度。颜色规则放宽到能同时吃下两者之后，**靠「位置」分开：头永远在身体上面，所以取最高的那一块**。

3. **帽子要按头在屏幕上的实际宽度缩放。** 头转过去的时候可见宽度会变窄，帽子不缩就会变成「浮在空中的帽子」。实测头正面时框宽约 103px，转到侧面明显变窄，所以帽檐半宽 = `103 × 0.64 × (实测框宽 / 103)`，上下限夹在 0.45~1.0 倍之间。

另外**帽子必须夹在格子里面**：帽檐下面那圈阴影是模糊出来的，会往外扩大约 6px，所以留 8px 余量。第一版没夹，`sky-seedy` 有 8 帧的帽檐捅出了格子左右边（行9第4格探到 x=192、行9第7格和行10第2~7格探到 x=0），`check_pets.py` 直接报 24 项不合格。

### 这三只也验过

和猫头鹰那三只一样，不只是静态图过校验：真的 WKWebView 里跑过，真实 `pointermove` 驱动下**四个方向的注视帧都对**——正上是行9第0格（头往后仰、只看得到下巴）、正右是行9第4格（脸转到右边、帽子跟着缩窄）、正下是行10第0格（整个头往前趴、帽子扣在头顶）、正左是行10第4格。

```sh
python3 tools/derive_pets.py --only sky-seedy   # 只重生成一只
```

---

## 1 只自定义宠物：蓝色大肥鱼

`deepseek`（画廊里显示的名字是**蓝色大肥鱼**）不是官方那 9 只里的任何一只，而是**手工装进 Codex 的自定义宠物**：一只蓝发、尾巴渐变成鲸尾的二次元女仆助手。

它在 Codex 里的位置是 `~/.codex/pets/deepseek-2/`，里面就是一个 `pet.json` 加一张 `spritesheet.webp`：

```json
{
  "id": "deepseek",
  "displayName": "蓝色大肥鱼",
  "description": "一位蓝发、深海鲸鱼主题的可爱二次元女仆助手宠物，来自deepseek。",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

> ✅ **这一只没有授权问题**：官方 9 只和那 6 只派生宠物都是 OpenAI 第一方资产（服务条款禁止复制发行），而这一只是自己生成、自己拥有的美术，可以放心留在公开仓里。

**移植几乎是白拿的**：它已经是 **v2 形状**（1536×2288，8 列 × 11 行，每格 192×208），格子和行约定跟引擎要的完全一致，所以只需要补一份本项目方言的 manifest 和一张画廊预览图。

### 帧数不必跟官方一样

官方那 9 只的每一行帧数都不一样（idle 6 帧、running 8 帧、waving 4 帧……），而自定义宠物**不必照抄**：这一只的 **idle 行是 7 帧**，比官方多一帧。硬套官方的时长表就会丢掉最后一帧，或者多播一帧空气。

所以 `tools/port_custom_pet.py` **自己数帧**：按 alpha 通道找每一行最后一个还有内容的格子（尾部空格不算帧），再把官方的时长表撑到这么长——**保持「每帧一个固定步长、最后一帧多停一会儿」这个规律**，idle 就变成 `[280, 110, 110, 140, 140, 140, 320]`。

顺带也做了两件防呆的事：图集尺寸不是 1536×2288 就直接报错（生成器出来的东西尺寸经常不对，而引擎只会安静地画错格子）；一行中间出现空洞也会报错（那说明素材坏了，不是一行短）。

### 也验过

- `check_pets.py`：**18 只全部合格**。逐格量过包围盒——没有一帧碰到格子边，idle 行整体 `top=5 / bottom=203`（安全区是 2~204），跳跃行也不顶格。
- 真的 WKWebView 里跑过：图集加载无报错、`rafCount` 持续增长、**四个方向的注视帧全对**（正上=行9第0格、正右=行9第4格、正下=行10第0格、正左=行10第4格），**点击会跳**（`animation` 变成 `jumping`）。

```sh
python3 tools/port_custom_pet.py ~/.codex/pets/deepseek-2 \
    --id deepseek --name "蓝色大肥鱼"
```

---

## 工具

```sh
# 引擎单测：时间轴、角度→注视帧映射、表演时序
node tools/test-sprite-pet.mjs

# 宿主半边自检：真的加载 lib/index.js，真的调那几条 Fetch 路由，
# 断言画廊里有哪几只宠物、图集字节对不对、被删掉的宠物是不是 404
node tools/check-host.mjs

# Codex 兼容：契约模块、宿主图鉴/路由读纯 Codex 宠物、安装器的各种边界
# （全在临时目录里，注册表是本地假服务，不联网）
node tools/test-codex-compat.mjs

# 设置页的装/删/导入：宿主四条路由 + 共用核心（本地假注册站、临时 CODEX_HOME）
node tools/test-pet-management.mjs

# 装一只 Codex 宠物 / 检查一只宠物能不能正常播放
node tools/install-pet.mjs deepseek --dry-run
bin/dsh-pet-macos --describe --pet-dir pets/<id>

# 生成浏览器预览页（写到 pets/<id>/__preview.html）
node tools/preview-sprite-pet.mjs hoots

# 离屏渲染一张 PNG：走和原生助手完全一样的注入逻辑
swiftc -O -swift-version 5 -framework AppKit -framework WebKit \
  tools/render-pet.swift -o /tmp/render-pet
/tmp/render-pet --pet-dir pets/hoots --runtime runtime --out /tmp/pet.png --after 1500

# 往页面里塞一段脚本、再把引擎的状态读回来（端到端验证某个交互）
/tmp/render-pet --pet-dir pets/bsod --runtime runtime --out /tmp/pet.png --after 1800 \
  --script "document.dispatchEvent(new PointerEvent('pointermove', {clientX: 40, clientY: 5}))" \
  --eval "JSON.stringify({look: window.__pet.lookFrame})"

# 数一数页面往原生助手发了多少条消息（--messages 会打印 messages: down=1 move=77）
/tmp/render-pet --pet-dir pets/bsod --runtime runtime --out /tmp/pet.png --after 1800 \
  --messages --script "<灌 pointermove 事件的脚本>"

# 拖动基准：助手自己控制光标、自己搬窗口（真实拖动交给窗口服务器，测不到），
# 打印主线程最长被卡多久。这条路径的数字就是「为什么不能由助手搬窗口」的证据
bin/dsh-pet-macos --pet-dir pets/hoots --size 200 --lock /tmp/dsh-pet-bench.lock --drag-bench

# 真实拖动的记录：宿主启动助手时带了 --drag-log，每次拖动追加一行
# （mover=window-server 表示由窗口服务器拖动）
tail ~/.dsh/dsh-pet-drag.log

# 从 Codex 桌面版重新抽一遍全部素材（会覆盖 pets/ 下的图集和 manifest）
python3 tools/port_codex_pets.py

# 重画 2 只原创宠物（会覆盖 pets/{cat,bot}/）
python3 tools/make_pets.py

# 从 hoots 和 seedy 派生 6 只改色 + 加饰品的宠物
# （会覆盖 pets/{teal,violet,mint}-hoot/ 和 pets/{sky,rose,lilac}-seedy/）
python3 tools/derive_pets.py
python3 tools/derive_pets.py --only sky-seedy   # 只重生成一只
python3 tools/derive_pets.py --debug            # 顺便出一张标注锚点的接触表

# 移植一只手工装进 Codex 的自定义宠物（数帧、算时长、写 manifest 和预览图）
python3 tools/port_custom_pet.py ~/.codex/pets/deepseek-2 \
    --id deepseek --name "蓝色大肥鱼"

# 校验全部宠物的图集契约：格子尺寸、帧是否齐、有没有越界
python3 tools/check_pets.py
```


需要 Pillow 的脚本（移植 + 绘制 + 校验）建议装在独立 venv 里（macOS 的系统 Python 是 externally-managed，`pip install` 会被 PEP 668 挡掉）：

```sh
python3 -m venv .venv && .venv/bin/pip install Pillow
.venv/bin/python tools/port_codex_pets.py
```

---

## 构建

```sh
swiftc -O -swift-version 5 -target arm64-apple-macosx13.0 \
  -framework AppKit -framework QuartzCore native/main.swift -o /tmp/dsh-pet-arm64
swiftc -O -swift-version 5 -target x86_64-apple-macosx13.0 \
  -framework AppKit -framework QuartzCore native/main.swift -o /tmp/dsh-pet-x86_64
lipo -create /tmp/dsh-pet-arm64 /tmp/dsh-pet-x86_64 -output bin/dsh-pet-macos
codesign --force --sign - bin/dsh-pet-macos
```

---

## 踩过的坑

**拖动卡顿的根因：助手自己搬窗口。**
每次 `setFrameOrigin` 都是一次和窗口服务器的往返；窗口服务器一忙（5K 120Hz 屏上它常年吃 30~45% CPU），单次搬动就要等十几到三十多毫秒，主线程被卡 40~60ms，宠物就掉在光标后面。实测：只播动画不搬窗口，主线程最长卡 5ms；每个拖动事件搬一次窗口，最长卡 47~58ms——和用 WebView 还是原生图层画宠物无关。修法是 `performDrag(with:)`：按下时把拖动交给窗口服务器，由它自己让窗口跟着光标走（标题栏拖动用的就是这套），助手只监听移动通知、检测松开、区分点击和拖动。顺带把 WKWebView 换成了 Core Animation 图层（图集切格、一层显示一格），助手里不再有网页进程。

**WKWebView 会拒绝 `loadHTMLString` 页面里的所有 file:// 资源。**
`loadHTMLString(_:baseURL:)` 造出来的页面是 opaque origin，WebKit 直接拒绝加载 `file://` 子资源——**连合法的 `data:` URL 之外的任何图片都失败**，表现是"面板在、影子在、宠物画布全空"。必须用 `loadFileURL(_:allowingReadAccessTo:)` 让页面拿到 file:// origin。

**`allowingReadAccessTo` 要覆盖页面和图集两边的公共祖先目录**，而且必须是带结尾斜杠的目录 URL，否则报 `Ignoring request to load this main resource because it is outside the sandbox`。

**manifest 里的相对路径在原生壳里要解析成绝对路径。**
播放器页面在 `runtime/` 下，`spritesheet.webp` 这种相对路径会指到 runtime 目录去。壳在注入 manifest 时把它解析成绝对 `file://` URL；浏览器预览里则保持相对（预览页就在宠物目录里）。

**首帧布局竞态会让画布变成 1×1。**
图集加载完成时页面可能还没排版完，`getBoundingClientRect()` 返回 0，画布被设成 1×1，宠物就永远看不见了。`ResizeObserver` + 每帧校验尺寸才能兜住。

**DSH 的 Fetch 路由不能用 `requestBody: 'none'`。**
`ctx.connection.fetch.register` 的 `requestBody` 只有 `buffered` / `streaming` 两种实际取值，宿主桥接会把**非 buffered** 的请求统一构造成带 body 的 `Request`；而 GET 请求带 body 会直接抛错，最终表现为 **400** 而不是 404。GET 路由一律写 `requestBody: 'buffered'`。

**宿主默认不监视源码，改了插件代码不会自动生效。**
DSH 的 HMR 基础配置是 `root: []`（只保留显式的配置监视），所以 `lib/*.js` 改了不会触发重载；但**改 profile 的 `cordis.patch.yml`** 会触发一次重合成，重合成会把「链接包」（软链到工作区的插件）里变化的文件换掉。想让改动生效，改一下 patch 就行，不用重启 DSH。

**volatile 字段不会重新挂载插件。**
DSH 的 Loader 比较原始配置时忽略 volatile 字段，只有 volatile 值变了就**就地提交**到运行中的引用，并给属主 fiber 发 `loader/volatile-update`；普通值变了才走重挂载。所以「改宠物/改大小」这条链路要靠 `ctx.on('loader/volatile-update', ...)` 接，而不是指望 `apply` 再跑一次。

**Codex v2 图集的 idle 行只改表情，body 纹丝不动。**
这就是「宠物不会自己动」的真正原因：不是引擎坏了，是素材本身在 idle 上就只动脸。把九行逐帧画出来一看就清楚了——`idle` / `jumping` / `review` 只有五官在变，`waiting`（晃身）、`waving`（抬手）、`running`（掏出笔记本）才是身体在动。所以 `idleRoutine` 只挑后者，`every` 给成 `[3, 6]` 区间免得像循环动画。**别用「变化像素总数」去选行**：某只宠物换个惊讶表情也能刷出上万像素，但肉眼一动不动。

**想知道一行到底有没有「动身体」，得量宠物在格子里的位置，不是量像素。**
量每一帧不透明像素的包围盒顶部：`jumping` 行的 top 序列是 `18 → 10 → 2 → 10 → 18`——一条完整的抛物线，宠物真的离地了（bsod 16px、rocky 42px、hoots 只有 7px 因为猫头鹰本来就顶到格子上沿）。只量「变化像素数」会得出「jumping 只是换了个表情」的错误结论，因为惊讶脸改的像素特别多。

**`screencapture -l <windowID>` 对透明 NSPanel 会返回陈旧帧。**
对着宠物窗口截图，连续抓十次可能是同一张旧画面，会得出「宠物完全没动」的错误结论。可靠做法是**全屏截图再裁剪**宠物区域（注意 `screencapture` 出的是 2 倍像素，裁剪坐标要 ×2）。

**动画时钟在 WebView 里面，从外面看不见。**
「宠物看起来不动」有太多可能：引擎坏了？rAF 没跑？素材不动？原生侧一个都判断不了。所以给助手加了 `--diagnose`：它往页面里注入一段探针，插桩引擎自己的 `step`/`play`，把「注入的是哪个版本的引擎、`idleElapsed` 涨到多少、`play()` 被调了哪些次、画布尺寸校验有没有提前返回」全打出来。同一段诊断还证明了引擎是好的——问题在选错了行。

**WebView 只在光标位于它上方时才收得到指针事件，所以它永远不知道光标「离开了」。**
盯着光标的那几行是静止帧，于是「点一下宠物 → 它转头看你 → 光标移开 → 它永远卡在那个姿势」。页面里的 `pointerleave` 在 WKWebView 里基本不会被投递，只能由**窗口**来通知：原生助手用 `NSTrackingArea`（`.activeAlways`，因为浮窗通常永远不是 key 窗口）加上对 `NSEvent.mouseLocation` 的轮询兜底，发现光标离开面板就调 `window.DSHPet.lookOut()`，页面清掉注视帧并回到动画。

**`NSTrackingArea` 的常量名在 Swift 里不是 `.mouseEntered`。**
SDK 里是 `NSTrackingArea.Options.mouseEnteredAndExited` / `.activeAlways` / `.inVisibleRect`（注意 `inVisible` 的驼峰）；而且 `NSTrackingAreaDelegate` 协议早就被删了，退出事件是发给 owner 的 `mouseExited(with:)`——所以 owner 得是 `NSResponder`。

**像素风一旦按比例缩放就废了。**
第一版想「让每只宠物都长到官方那么大」，做法是量出各自的包围盒再乘一个系数缩放。结果每只宠物的缩放系数都不一样（1.30 / 0.96 / 1.30 / 0.86 / 1.00），同一批图集里像素块有 5.7px 的也有 3.4px 的——像素风最忌讳这个，看着像马赛克。**正确做法是按最终尺寸作画、缩放恒为 1**，尺寸差异靠「每只的设计」去补。

**测包围盒必须看 alpha 通道，`Image.getbbox()` 会骗人。**
对 RGBA 图直接调 `getbbox()`，PIL 会把**透明但有颜色**的像素也算进去，于是量出来的范围比真实内容大一圈。判断「有没有越界」时用 `img.getchannel('A').getbbox()`。

**手动画的宠物要给跳跃和下垂留够余量。**
48×52 的网格不是随便画的：静止时脚底踩在格子底部往上 1 格的地方，行 5（沮丧）要再往下沉 1 格，行 4（跳跃）要往上抬 4 格。第一版没留余量，结果跳跃的顶点直接顶出格子（`top=0`），机器人的手臂还被算到了脚下（`ay` 随 `pump` 变负就往下跑）。**每一帧都要量一遍包围盒，确认没有一帧碰到网格最外圈**，`tools/check_pets.py` 现在就在做这件事。

**裁剪区要整体居中，不能拿 idle 帧去对齐。**
图集是「按每只宠物的实际footprint 裁剪 → 缩放 → 放进格子」。一开始用 idle 帧的水平中心去对齐裁剪区，结果猫被甩偏了 10px，**胡须尖端被切掉**——而且只有「等待」这一行看得出来（它会把头偏到一边）。裁剪区本身就居中，因为宠物本来就是按网格中线设计的。

**「转半圈」这件事，像素画里靠的是少画一只眼睛。**
官方的注视行是绕垂直轴的转台（0=正面、4=右侧面、8=背面）。像素画没法真转三维，于是把转台拆成三件事：身体横向收窄（`sin` 驱动，最多收 25%）、尾巴收进身侧、**转过 55° 之后远侧那只眼睛不画**。最后这一下最关键——有没有它，侧脸就只是一张被压扁的正面脸。

**上下看不能靠移动眼睛，得动脑袋。**
16 个方向里官方只有左右（指针在正上方时它转过来面对你），没有上下。我们把垂直的那一半交给俯仰：指针在上方就抬头、眼睛上移，指针在下方就低头、眼睛下移。抬低头 3 格（12px）才看得出来，2 格基本分辨不出。

**道具要用对比色，而且得和爪子连上。**
第一版「忙活」行的道具全是同色系：白杯子画在薄荷色果冻身上、玻璃灯笼画在淡紫幽灵身上、浅绿洒水壶画在绿色豆芽身上——在真机上全是「身体上多了一块颜色」。改用对比色（青毛线球 / 深灰平板）并且把爪子画到道具上，才看出是「拿着」。

**改色不能用「按饱和度加权的色相旋转」。**
第一版就是这么改的：饱和像素全旋、奶油脸盘和眼白不动。看着能跑，但阴影里的脸盘会变成**黄绿色**——实测脸盘的饱和度受光处 0.26、阴影处 0.42，而加权旋转从 0.30 就开始介入。更隐蔽的是：奶油的判定要求 `r >= g >= b`，**像素一旦转成绿色就整块掉出掩膜**，脸盘连通块当场碎掉，脸盘定位全线失效（88 帧里 18 帧检不到脸）。现在改成沿「奶油→橙羽」轴投影的**调色板重映射**，中间色只在新奶油和新羽毛之间插值，亮度按原图比例还原。

**脸上的奶油连通块会把肚子的高光吞进来，别拿脸盘的高度当尺寸。**
`idle` 第 3 帧的奶油块一路连到肚子（bbox 高到 y=100，正常只有 81），`failed` 整行更夸张（y=118）——于是按脸盘高度算出来的帽子高度直接翻倍，帽子撑出格子、领结掉到肚子上。头顶的正确量法是**从脸盘中心那一列往上走，撞到透明为止**；同一行里这个值几乎是常数（idle 行 28~29），比脸盘高度稳得多。

**官方那 16 向注视是转台：身体不动、只有头在转。**
所以头顶在屏幕上**不动**，脸却在左右甩——实测脸心在 58~132 之间摆，精灵轮廓顶部跨度的中点稳定在 83~102。转头的时候按脸心摆帽子，帽子就会滑到脑袋边上、悬在半空。转台帧要按轮廓定位，其余帧才按脸心。

**锚点必须在原图上找，改完色再找就废了。**
给 seedy 加草帽时，`find_head` 是按「色相 55~70 的黄绿色框」找头的，而它**跑在了改色之后的图上**——那副颜料的色相已经被转走了（+160 度 → 215 度），于是只剩几个抗锯齿的散点符合条件，帽子的锚点彻底乱掉：帽檐捅出格子左右边，`check_pets.py` 报 24 项不合格。脸盘定位要跑原图，头部定位也一样。

**「头」和「身体」穿几乎同一种颜色时，要靠位置分开，不能靠大小。**
seedy 的头框是 `rgb(213,214,169)`（色相 55~70），身体是 `rgb(179,170,118)`（色相 51、饱和度 0.34），差好几个色度；颜色规则一放宽就把身体一起吃进来。**头永远在身体上面，所以取「最高的那一块」**，而不是最大的那一块。

**帽子要按头在屏幕上的实际宽度缩放。**
seedy 的头是个会转的立方体，正面时框宽约 103px，转过去明显变窄。帽子不跟着缩就成了浮在空中的帽子，所以帽檐半宽 = `103 × 0.64 × (实测框宽 / 103)`。

**帽檐下面那圈阴影会把轮廓往外扩约 6px，饰品必须留够余量。**
阴影是「形状 alpha → 模糊 → 整体下移 2px」画出来的，模糊让边缘往外洇了 6px。第一版没夹，8 帧的帽檐探出了格子边（`check_pets.py` 的 `touches the edge`）。所以帽檐中心要夹在 `8 + 半宽` 和 `格宽 - 8 - 半宽` 之间。

**自定义宠物的帧数不必跟官方一致，硬套官方的时长表就会丢帧。**
官方的时长表同时也是「这一行有几帧」的声明（idle 6 帧、running 8 帧、waving 4 帧）。自定义宠物不守这个规矩——`deepseek` 的 idle 行就是 **7 帧**。移植时要**按 alpha 通道数帧**（找这一行最后一个还有内容的格子），再把时长撑到这么长，同时保住「每帧一个固定步长、最后一帧多停一会儿」的规律。

**拖动卡顿的根因是「每个事件都让窗口动一次」，不是代码慢。**
指针事件每秒来 150~240 次，每一次都让 `setFrameOrigin` 搬一次窗口，而**搬一次窗口就要让窗口服务器把整个 WebView 层重新合成一遍**——机器做不完，消息就在主线程上排队，窗口越拖越落后。修法是三层都**按帧合并**：注视一帧算一次（方向没变就不重绘）、`move` 消息一帧发一条、窗口一帧最多搬一次。

关键在于**用标志而不是队列**：某一帧来不及就跳过，积压不会发生；用队列的话，拖得越久落后越多。

**`updateLook` 不能改成异步。**
引擎单测是直接调 `updateLook()` 然后立刻断言 `lookFrame` 的，所以它必须保持同步——要合并的是**事件层**（pointermove 只记位置、交给 rAF），不是 `updateLook` 本身。同理，「光标离开」时必须把还没应用的那一帧注视丢掉，否则光标已经走了还会突然转头。

---

## 限制

- 目前只支持 macOS；Windows/Linux 需要各自的置顶窗口实现。
- 200×200（可调 120–260，随设置里的尺寸滑块变化）的透明窗口仍然是一个矩形命中区，宠物四周的透明角落会挡住点击；要彻底解决，需要全局鼠标监听做像素级 hit-test。
- 助手是 ad-hoc 签名，适合本机使用；分发给别人需要 Developer ID 签名和公证。
- 置顶级别是 `.floating`。如果遇到某些全屏应用盖住宠物，可以把 `panel.level` 改成 `.screenSaver`（会更高，但也更侵入）。
- sprite 宠物目前只消费 agent 状态里"没有状态"这一种情况；`running` / `waiting` / `failed` 这几行动画已经画好了，但宿主还没有把 DSH 的任务状态接过来。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-pet
```

并删掉 `cordis.patch.yml` 里手工加的 `dsh-pet` 行（如果加过）。
