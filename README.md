# dsh-pet

DSH Desktop 的 macOS 悬浮宠物：一只小鲸鱼常驻在所有窗口之上，拖动可以换位置，点击回到 DSH。

## 为什么需要一个原生助手

DSH 的宿主插件跑在独立的 Node 子进程里（`ELECTRON_RUN_AS_NODE=1`），拿不到 Electron 的 `BrowserWindow`。所以：

- `lib/index.js` 是普通的 DSH 宿主插件，只负责启动/回收助手进程。
- `native/main.swift` 编译出的 `bin/dsh-pet-macos` 是一个 AppKit `NSPanel`，负责窗口、透明、置顶、跨 Space、点击激活 DSH。

## 行为

- `NSPanel` + `.floating` + `.canJoinAllSpaces` + `.fullScreenAuxiliary`：浮在普通窗口之上，跟随所有桌面。
- 点击宠物：`NSRunningApplication` 激活 `com.deepseek.dsh`；如果 DSH 没在运行，则打开 `/Applications/DeepSeek Harness.app`。
- 拖动宠物：窗口跟着鼠标移动，位置保存在 `~/.dsh/dsh-pet-state.json`。
- 助手每 1 秒检查 DSH 宿主 PID；宿主退出后自动退出。`flock` 保证同一时间只有一只宠物。
- 纯本机 HTML/SVG，没有网络请求，不读凭据。

## 安装

```sh
dsh plugin --profile desktop add ./dsh-pet
```

DSH Desktop 0.2.1 的 profile 由应用自己管理。如果装完没有立即出现宠物，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一行让 loader 热加载：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    size: 150
```

重启 DSH 后，bundle 自己会加载，不需要这行手工配置。

## 构建

```sh
swiftc -O -swift-version 5 -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit native/main.swift -o /tmp/dsh-pet-arm64
swiftc -O -swift-version 5 -target x86_64-apple-macosx13.0 \
  -framework AppKit -framework WebKit native/main.swift -o /tmp/dsh-pet-x86_64
lipo -create /tmp/dsh-pet-arm64 /tmp/dsh-pet-x86_64 -output bin/dsh-pet-macos
codesign --force --sign - bin/dsh-pet-macos
```

## 限制

- 目前只支持 macOS；Windows/Linux 需要各自的置顶窗口实现。
- 150×150 的透明窗口仍然是一个矩形命中区，宠物四周的透明角落会挡住点击；要彻底解决，需要全局鼠标监听做像素级 hit-test。
- 助手是 ad-hoc 签名，适合本机使用；分发给别人需要 Developer ID 签名和公证。
- 置顶级别是 `.floating`。如果遇到某些全屏应用盖住宠物，可以把 `panel.level` 改成 `.screenSaver`（会更高，但也更侵入）。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-pet
```

并删掉 `cordis.patch.yml` 里手工加的 `dsh-pet` 行（如果加过）。
