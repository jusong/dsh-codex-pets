# dsh-pet 实现笔记

[README](../README.md) 讲的是怎么装、怎么用；这里记的是**为什么这么做**：
原生助手为什么必须存在、宠物契约长什么样、拖动跟手那两轮排查、以及一路踩过的坑。

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
  "id": "deepseek-whale",
  "name": "deepseek-whale",
  "description": "一只以 DeepSeek 鲸鱼为原型的 3D 软萌小鲸鱼桌面宠物",
  "size": 200,
  "preview": "preview.png",
  "type": "sprite",
  "spriteVersionNumber": 1,
  "spritesheetPath": "spritesheet.webp",
  "cell": { "width": 192, "height": 208 },
  "grid": { "columns": 8, "rows": 9 },
  "idle": "idle",
  "animations": {
    "idle":          { "row": 0, "durations": [280, 110, 110, 140, 140, 140, 140, 320] },
    "running-right": { "row": 1, "durations": [120, 120, 120, 120, 120, 120, 120, 220] },
    "running-left":  { "row": 2, "durations": [120, 120, 120, 120, 120, 120, 120, 220] },
    "waving":        { "row": 3, "durations": [140, 140, 140, 140, 140, 140, 140, 280] },
    "jumping":       { "row": 4, "durations": [140, 140, 140, 140, 140, 140, 140, 280] },
    "failed":        { "row": 5, "durations": [140, 140, 140, 140, 140, 140, 140, 240] },
    "waiting":       { "row": 6, "durations": [150, 150, 150, 150, 150, 150, 150, 260] },
    "running":       { "row": 7, "durations": [120, 120, 120, 120, 120, 120, 120, 220] },
    "review":        { "row": 8, "durations": [150, 150, 150, 150, 150, 150, 150, 280] }
  },
  "drag": { "right": "running-right", "left": "running-left" },
  "react": { "click": "jumping" },
  "idleRoutine": { "every": [3, 6], "animations": ["waiting", "waving", "running"] },
  "perform": { "sequence": ["jumping", "waving"], "splash": "sparkle" },
  "source": "custom Codex pet (~/.dsh/pets/deepseek-whale-2)"
}
```

- `animations` 的每一项 = 图集的一行 + 每帧的毫秒数。**运行时不知道 "idle" 是什么意思**，它只按 manifest 播。
- `durations` 允许逐帧不同，最后一帧通常拉长（Codex 的图集也是这个惯例）。
- `look` 描述 16 个朝向：第 9 行放 `000°~157.5°`，第 10 行放 `180°~337.5°`，`000°` 是正上方。**只有 v2 图集有这两行**；包内这只只有 9 行，所以清单里没有 `look`。
- `react.click` 是被点击时的反应动画（默认 `jumping`）。反应优先于注视，所以宠物是「跳起来回应你」，而不是「盯着你」。
- `perform.splash` 是庆祝粒子的类型：`"sparkle"` 金色星星、`true` 水花、`false` 不要。
- `idleRoutine` 是宠物自己找点事做的清单：每 `every` 秒挑一行播一次，播完回到 idle。`every` 可以是固定秒数，也可以是 `[最小, 最大]` 区间——区间让动作落在不同的节拍上，才不像循环动画。

### 图集契约

| 项 | 值 |
|---|---|
| 尺寸 | `1536 × 1872`（v1，9 行）；也接受 `1536 × 2288`（v2，11 行，多 16 个注视方向） |
| 网格 | 8 列 × 9 行（v1）或 8 列 × 11 行（v2） |
| 单元格 | `192 × 208` |
| 格式 | PNG 或 WebP，透明背景 |
| 行 0-8 | 9 个标准动画行，语义见上表 |
| 行 9-10 | 只 v2 有：16 个朝向，顺时针，`000°` 为正上方 |

没用到的格子必须全透明。**这套网格和 Codex 的宠物图集一致**，同一张图集可以直接装进 Codex。

### 运行时负责什么

`runtime/sprite-pet.js` 是播放器，`runtime/player.html` 是所有 sprite 宠物共用的页面：

- 按 `durations` 逐帧播放；用 `requestAnimationFrame` 累加时间，帧率抖动不会累积误差
- **自己找点事做**：按 manifest 的 `idleRoutine` 每隔几秒播一行别的动作，播完回到 idle（官方图集的 idle 只改表情，不加这个宠物看起来就是冻住的）
- **光标跟随**：按光标相对宠物中心的角度选 16 向注视帧（只对 v2 图集；包内这只没有注视行，所以不转头）。**角度由原生助手算、原生助手通知页面**——不是页面等 pointermove 事件：宠物是后台应用，macOS 根本不会给它鼠标移动事件
- **拖拽**：拖动时按方向切 `running-right` / `running-left`，松手回到 idle
- **表演**：`perform()` 播 manifest 里写好的动作序列，返回总时长；结束时触发一次庆祝粒子
- **无障碍**：尊重系统「减少动态效果」，开启时只画 idle 首帧
- **画布自适应**：`ResizeObserver` 盯住画布，首帧布局没完成时不会把画布压成 1×1

公共部分（拖动/点击/消息桥）仍在 `runtime/pet-runtime.js`，由原生助手在 document start 注入。

### 新增一只 sprite 宠物

1. 做一张符合上面网格契约的图集，放进 `pets/<id>/spritesheet.webp`
2. 写 `pets/<id>/pet.json`，把图集的行语义填进 `animations`
3. 在 **设置 → 宠物** 里选它（也可以在 config 里写 `pet: <id>`）

不需要写任何 JS 或 HTML，也不需要登记：设置页的画廊每次请求都会重新读磁盘。

画廊分两段：

| 来源 | 位置 | 顺序 | 能否删 / 拖 |
|---|---|---|---|
| **内置**（随插件发布） | 插件里的 `pets/` + `pets/index.json` | 永远最前，顺序固定 | 不可删、不可拖 |
| **用户安装** | `~/.dsh/pets/` + `pets.json` | 紧跟内置之后；新装的追加到末尾 | 可删、可拖拽排序 |

`DSH_PET_USER_DIR` 可改用户目录（测试用）。升级插件时，以前误装进包内 `pets/`、又不在 `index.json` 里的目录会一次性迁到用户目录。

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
bin/dsh-pet-macos --pet-dir pets/deepseek-whale --runtime runtime/pet-runtime.js \
  --size 200 --lock /tmp/dsh-pet-bench.lock --drag-bench --bench-profile press
# -> press bench: moves=120 attempts=120 pressToFirstMoveMs=9.0 maxTrailPx=6.0 finalTrailPx=0.0 moved=true

# 对照：把拖动放回旧路径（由页面的 down 消息启动）
bin/dsh-pet-macos --pet-dir pets/deepseek-whale --runtime runtime/pet-runtime.js \
  --size 200 --lock /tmp/dsh-pet-bench.lock --drag-bench --bench-profile oldpress
# -> press bench: moves=119 attempts=119 pressToFirstMoveMs=13.2 maxTrailPx=8.0 finalTrailPx=0.0 moved=true

# 真实拖动时，助手会把结果写进 ~/.dsh/dsh-pet-drag.log
```

`--bench-profile press` 用的是**它自己按下去的事件**（`NSApp.postEvent` 直接投进应用），因为这台机器上**系统会丢掉合成的鼠标事件**（`CGEvent.post` 之后 `NSEvent.pressedMouseButtons` 纹丝不动）。光标本身倒是可以动——`CGWarpMouseCursorPosition` 好使——所以拖动的轨迹是真的，只有「按下」是投进去的。

### 还没做到的一件事

Codex 在 macOS 上（单显示器、native 模式）把拖动**整个交给系统**：`performDrag(with:)`，窗口服务器自己跟光标，一步都不等应用。理论上限比我们的「每帧搬一次窗口」更高。

这条路这里**没有采用**，因为它在本机无法验证：合成按键被系统丢掉，而 `performDrag` 需要一次真实的按下才能测；而且它会把 pointerdown/up 从页面手里拿走（反应动画和拖拽动画都要改成原生驱动）。**不能验证的机制不进仓库**——这一节记着它，等有能真机验证的条件再说。

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
量每一帧不透明像素的包围盒顶部：`jumping` 行的 top 序列是 `18 → 10 → 2 → 10 → 18`——一条完整的抛物线，宠物真的离地了。只量「变化像素数」会得出「jumping 只是换了个表情」的错误结论，因为惊讶脸改的像素特别多。

**`screencapture -l <windowID>` 对透明 NSPanel 会返回陈旧帧。**
对着宠物窗口截图，连续抓十次可能是同一张旧画面，会得出「宠物完全没动」的错误结论。可靠做法是**全屏截图再裁剪**宠物区域（注意 `screencapture` 出的是 2 倍像素，裁剪坐标要 ×2）。

**动画时钟在 WebView 里面，从外面看不见。**
「宠物看起来不动」有太多可能：引擎坏了？rAF 没跑？素材不动？原生侧一个都判断不了。所以给助手加了 `--diagnose`：它往页面里注入一段探针，插桩引擎自己的 `step`/`play`，把「注入的是哪个版本的引擎、`idleElapsed` 涨到多少、`play()` 被调了哪些次、画布尺寸校验有没有提前返回」全打出来。同一段诊断还证明了引擎是好的——问题在选错了行。

**WebView 只在光标位于它上方时才收得到指针事件，所以它永远不知道光标「离开了」。**
盯着光标的那几行是静止帧，于是「点一下宠物 → 它转头看你 → 光标移开 → 它永远卡在那个姿势」。页面里的 `pointerleave` 在 WKWebView 里基本不会被投递，只能由**窗口**来通知：原生助手用 `NSTrackingArea`（`.activeAlways`，因为浮窗通常永远不是 key 窗口）加上对 `NSEvent.mouseLocation` 的轮询兜底，发现光标离开面板就调 `window.DSHPet.lookOut()`，页面清掉注视帧并回到动画。

**`NSTrackingArea` 的常量名在 Swift 里不是 `.mouseEntered`。**
SDK 里是 `NSTrackingArea.Options.mouseEnteredAndExited` / `.activeAlways` / `.inVisibleRect`（注意 `inVisible` 的驼峰）；而且 `NSTrackingAreaDelegate` 协议早就被删了，退出事件是发给 owner 的 `mouseExited(with:)`——所以 owner 得是 `NSResponder`。

**测包围盒必须看 alpha 通道，`Image.getbbox()` 会骗人。**
对 RGBA 图直接调 `getbbox()`，PIL 会把**透明但有颜色**的像素也算进去，于是量出来的范围比真实内容大一圈。判断「有没有越界」时用 `img.getchannel('A').getbbox()`。

**自定义宠物的帧数不必跟官方一致，硬套官方的时长表就会丢帧。**
官方的时长表同时也是「这一行有几帧」的声明（idle 6 帧、running 8 帧、waving 4 帧）。自定义宠物不守这个规矩——包内这只的九行**全是 8 帧**。移植时要**按 alpha 通道数帧**（找这一行最后一个还有内容的格子），再把时长撑到这么长，同时保住「每帧一个固定步长、最后一帧多停一会儿」的规律。

**`updateLook` 不能改成异步。**
引擎单测是直接调 `updateLook()` 然后立刻断言 `lookFrame` 的，所以它必须保持同步——要合并的是**事件层**（pointermove 只记位置、交给 rAF），不是 `updateLook` 本身。同理，「光标离开」时必须把还没应用的那一帧注视丢掉，否则光标已经走了还会突然转头。
