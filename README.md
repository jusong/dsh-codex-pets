# dsh-pet

![deepseek-whale](pets/deepseek-whale/preview.png)

DSH Desktop 的 macOS 桌面宠物：一只 DeepSeek 小鲸鱼浮在所有窗口之上，点一下唤起 DSH，拖着换位置，闲着会自己动。

## 功能

- **常驻桌面**：透明无边框、始终置顶、跟随所有桌面，不抢焦点。
- **点击回 DSH**：点宠物把 DSH 窗口带到前面；没在运行就打开它。
- **拖动跟手**：窗口按屏幕刷新率跟随光标，位置记住，下次启动还在原处。
- **自己会动**：闲时轮流演小动作，偶尔来一次带粒子的表演；系统开了「减少动态效果」时只显示静态帧。
- **可换可调**：设置 → 宠物里挑宠物、拉大小（120–260 px），即时生效，不用重启 DSH。
- **更多宠物**：兼容 Codex 的宠物格式，可以从 [codex-pets.net](https://codex-pets.net) 装，也可以从本机 Codex 一键导入。
- **最近会话球**（可选）：宠物脚下显示会话数，点开就能跳到你正在等的那个会话。

## 安装

需要 macOS 13+ 和 DSH Desktop 0.2.1+。

插件只有一个依赖（`@deepseek-ai/schemastery`）。本地目录安装是以 `link:` 链进 profile 的，DSH 不会替这个 checkout 装依赖，所以先装一次：

```sh
npm install        # 或 pnpm install
```

再挂到 profile 上：

```sh
dsh plugin --profile desktop add ./dsh-pet
```

重启 DSH，鲸鱼会出现在屏幕右下、输入框上方。

如果没出现，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里手动加上这段，让 loader 加载它：

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: deepseek-whale
```

## 使用

**设置 → 宠物**（也挂在「插件 → 内置插件配置 → 桌面宠物」下）：

- 点画廊里的卡片切换宠物，上方的预览和尺寸滑块跟着变；
- 在输入框里粘 codex-pets.net 的宠物 ID 或页面链接即可安装，装完排到「已安装」末尾；
- 「从 Codex 导入」会把 `~/.codex/pets` 里还没导入的一次装进来；
- 用户装的宠物可以删除、拖拽排序；内置那只不能删。

## 配置

```yaml
- id: dsh-pet
  name: dsh-pet
  config:
    pet: deepseek-whale   # pets/<id> 的目录名
    size: 220             # 120–260 px
    sessions: false       # 脚下的最近会话球
    sessionLimit: 5       # 球里列几条（1–10）
    sessionMotion: false  # 有会话在忙时宠物不闲着，忙完跳一下
```

## 宠物

内置一只 `deepseek-whale`（v1 图集，8 列 × 9 行）。宠物就是一份 `pet.json` 加一张精灵图集，格式和 Codex 的完全一致。

- 想用现成的：在设置页安装，或者 `node tools/install-pet.mjs <id | 链接 | zip | 目录>`；
- 想做自己的：把图集和 manifest 放进 `~/.dsh/pets/<id>/`；手上已有 Codex 宠物的话，`python3 tools/port_custom_pet.py` 能直接转过来。

格式与动画行的细节见 [docs/internals.md](docs/internals.md)。

## 开发

```sh
node tools/check-host.mjs           # 宿主路由与画廊
node tools/test-sprite-pet.mjs      # 播放引擎
node tools/test-codex-compat.mjs    # Codex 宠物兼容
node tools/test-pet-management.mjs  # 装 / 删 / 排序 / 导入
node tools/test-session-ball.mjs    # 最近会话球
python3 tools/check_pets.py         # 图集契约
```

不开窗口检查一只宠物画得对不对：`bin/dsh-pet-macos --describe --pet-dir pets/deepseek-whale`。

实现笔记（原生助手为什么存在、拖动排查、踩过的坑）在 [docs/internals.md](docs/internals.md)。
