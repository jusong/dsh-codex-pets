# dsh-codex-pets

![deepseek-whale](pets/deepseek-whale/preview.png)

DSH Desktop 的 macOS 桌面宠物：一只 DeepSeek 小鲸鱼浮在所有窗口之上，点一下唤起 DSH，拖着换位置，闲着会自己动。

## 功能

- **常驻桌面**：透明无边框、始终置顶、跟随所有桌面，不抢焦点。
- **点击回 DSH**：点宠物把 DSH 窗口带到前面；没在运行就打开它。
- **拖动跟手**：窗口按屏幕刷新率跟随光标，位置记住，下次启动还在原处。
- **自己会动**：闲时轮流演小动作，偶尔来一次带粒子的表演；系统开了「减少动态效果」时只显示静态帧。
- **可换可调**：设置 → 宠物里挑宠物、拉大小（80–260 px），即时生效，不用重启 DSH。
- **可开可关**：设置里关掉「显示宠物」，或者在宠物上右键选「隐藏宠物」，鲸鱼就从桌面上收起来，再打开时回到原来的位置。
- **右键设置**：在宠物上右键选「设置」，直接打开设置页并跳到「宠物」这一节。
- **右键新会话**：在宠物上右键选「新会话」，挑一个工作区后弹出输入框，直接开一轮。
- **快捷键新会话**：默认 `Command+Option+N` 打开同一套输入框；设置里可改快捷键或留空关闭。
- **更多宠物**：兼容 Codex 的宠物格式，可以从 [codex-pets.net](https://codex-pets.net) 装，也可以从本机 Codex 一键导入。
- **最近会话球**（默认开启）：宠物脚下显示会话数，点开就能跳到你正在等的那个会话。

## 安装

需要 macOS 13+ 和 DSH Desktop 0.2.1+。

### 先启用桌面版的 `dsh`

`desktop` 这个 profile 只归 DeepSeek Harness 管。`npm install -g @deepseek-ai/dsh` 装出来的命令会拒绝它：

```text
error: profile "desktop" is managed exclusively by the Electron application
```

在 DeepSeek Harness 菜单栏打开 **Manage dsh Command…**（就在 **Check for Updates…** 下面），选 **Install**。macOS 会在 `/usr/local/bin/dsh` 放一个指向应用自带运行时的命令，目录需要权限时会要求管理员密码。这一步不改 shell 配置文件。

新开一个终端确认用的是这一份：

```sh
which dsh
dsh --version
```

`which` 应指向 `/usr/local/bin/dsh`。如果仍是 Homebrew 或 npm 的全局包（常见是 `/opt/homebrew/bin/dsh`，而且它排在 `/usr/local/bin` 前面），先卸掉那一份，例如 `npm uninstall -g @deepseek-ai/dsh`，再开一个新终端。应用换过位置之后，用同一菜单里的 **Repair**。

然后从 GitHub 安装。插件的依赖由 profile 的 pnpm 一起装好：

```sh
dsh plugin --profile desktop add github:jusong/dsh-codex-pets
```

要固定版本就带上 tag，例如 `github:jusong/dsh-codex-pets#v0.12.0`。

装完重启 DSH。第一次会下载 Electron（约 120 MB）到 `~/.dsh/dsh-codex-pets/runtime/`，校验通过后鲸鱼出现在屏幕右下、输入框上方。之后直接用已下载的那一份。

如果没出现，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里手动加上这段，让 loader 加载它：

```yaml
- id: dsh-codex-pets
  name: dsh-codex-pets
  config:
    pet: deepseek-whale
```

## 使用

**设置 → 宠物**（也挂在「插件 → 内置插件配置 → 桌面宠物」下）：

- 顶部的「显示宠物」开关控制它是否留在桌面上；在宠物上右键有「设置」（直接跳到这一页）和「隐藏宠物」；
- 点画廊里的卡片切换宠物，上方的预览和尺寸滑块跟着变；
- 在输入框里粘 codex-pets.net 的宠物 ID 或页面链接即可安装，装完排到「已安装」末尾；
- 「从 Codex 导入」会把 `~/.codex/pets` 里还没导入的、以及 Codex 自带（打在 `ChatGPT.app` 里）的宠物一起装进来；
- 用户装的宠物可以删除、拖拽排序；内置那只不能删。删掉正在用的那只时会自动切到剩下的第一只（至少要保留一只）。

## 配置

```yaml
- id: dsh-codex-pets
  name: dsh-codex-pets
  config:
    pet: deepseek-whale   # pets/<id> 的目录名
    size: 220             # 80–260 px
    visible: true         # false 隐藏宠物（右键宠物也能隐藏）
    sessions: true        # 脚下的最近会话球
    sessionLimit: 5       # 球里列几条（1–10）
    sessionMotion: true   # 有会话在忙时宠物不闲着，忙完跳一下
    shortcut: Command+Option+N  # 打开新会话输入框；留空关闭
```

用户装的宠物放在 `~/.dsh/dsh-codex-pets/pets/`，顺序记在同目录的 `pets.json`。Electron 和其他运行文件在同级的 `runtime/`。

## 宠物

内置一只 `deepseek-whale`（v1 图集，8 列 × 9 行）。宠物就是一份 `pet.json` 加一张精灵图集，格式和 Codex 的完全一致。

- 想用现成的：在设置页安装，或者 `node tools/install-pet.mjs <id | 链接 | zip | 目录>`；
- 想做自己的：把图集和 manifest 放进 `~/.dsh/dsh-codex-pets/pets/<id>/`；手上已有 Codex 宠物的话，`python3 tools/port_custom_pet.py` 能直接转过来。

## 桌面窗口

宠物画在 `electron/` 里的一个小窗口中，源码是普通 JavaScript，随插件一起发，仓库里没有需要编译的二进制。Electron 本体不打包：第一次显示宠物时，插件把它下载到 `~/.dsh/dsh-codex-pets/runtime/electron`，用固定的 SHA-256 校验后再解压。

内置两个地址（GitHub Releases 和 npmmirror），先试答得快的那个，失败再换下一个。都失败时，到设置 → 宠物里点重试，或者填一个自己的下载地址。不想走网络的话，把对应的 zip（文件名写在设置页上）放进 `~/.dsh/dsh-codex-pets/runtime/electron/drop/` 再点重试。

拖动交给系统窗口服务（页面上的原生拖动区域），脚本不逐帧挪窗口。目前只做了 macOS；和系统相关的部分在 `electron/platform/`，以后加 Windows 是新加一个适配器，再在 `lib/electron-runtime.js` 里加一行下载目标。

## 开发

```sh
node tools/check-host.mjs           # 宿主路由与画廊
node tools/test-sprite-pet.mjs      # 播放引擎
node tools/test-codex-compat.mjs    # Codex 宠物兼容
node tools/test-pet-management.mjs  # 装 / 删 / 排序 / 导入
node tools/test-session-ball.mjs    # 最近会话球
node tools/test-electron-core.mjs   # 窗口里的纯逻辑
node tools/test-electron-runtime.mjs # Electron 下载与校验
node tools/test-host-window.mjs     # 宿主拉起真实窗口（本机已下载 Electron 时）
python3 tools/check_pets.py         # 图集契约
```

## 许可

代码和内置宠物（`pets/deepseek-whale`）以 **MIT** 许可证发布，见 [LICENSE](LICENSE)。

Codex 官方那 9 只宠物是 OpenAI 的第一方资产，**不在本仓库中分发**：设置页的「从 Codex 导入」只读本机 `~/.codex/pets` 和 `ChatGPT.app` 里已有的副本，装进你自己的 `~/.dsh/dsh-codex-pets/pets/`，不涉及再分发。从 codex-pets.net 安装的社区宠物各自由其作者授权。
