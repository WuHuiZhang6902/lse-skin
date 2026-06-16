# skin —— LeviLamina / LSE 皮肤管理插件

给 Minecraft 基岩版服务器（LeviLamina + LegacyScriptEngine QuickJS）用的皮肤插件。
管理员可以给玩家换皮肤，支持普通皮肤（单张 png）、**4D 皮肤**（png + 自定义 geometry 模型）和 **URL 在线皮肤**。
换肤、预览走 GMLIB 二进制流发包；`/skin clear` 还会读内存里的真实皮肤即时还原。还提供给其他插件调用的接口。

> 作者：干物社（QQ 2063665699）、子沐呀（QQ 1756150362）

## 特性

- `/skin` 命令给玩家设置 / 清除 / 列出 / 重载 / 预览皮肤
- 支持 2D 普通皮肤、4D 自定义模型皮肤、URL 在线皮肤
- 玩家退出后再进服自动补回已设置的皮肤
- `/skin show` 在自己面前临时生成假人预览皮肤（只自己可见，不占服务器实体）
- `/skin clear` 读内存里玩家的真实皮肤并发包**即时还原原皮**（含 Persona 市场皮肤）
- 换肤走 GMLIB 二进制流发包，包头按版本对应，跨版本更稳
- 通过 `ll.exports` 暴露 `SkinAPI` 给其他插件调用

## 前置依赖

- [LegacyScriptEngine (QuickJS)](https://github.com/LiteLDev/LegacyScriptEngine)
- [GMLIB-LegacyRemoteCallApi](https://github.com/GroupMountain/GMLIB)（发包必需）
- [iListenAttentively-LseExport](https://github.com/MiracleForest/iListenAttentively-Wiki)（`/skin clear` 即时还原原皮需要，要求其 `getString` 支持 base64 参数）
- 系统自带 **curl**（Win10+ / Linux 都有）：URL 在线皮肤需要

## 安装

把整个 `skin` 文件夹放进服务器的 `plugins/` 目录，确保上面的前置依赖都已安装，重启服务器。

## 命令（需要 OP / 管理员）

| 命令 | 说明 |
| --- | --- |
| `/skin set <玩家> <皮肤名>` | 给玩家套皮肤，广播给所有人并记录 |
| `/skin set <玩家> <图片URL>` | 下载 URL 图片当皮肤（套上后自动清掉下载缓存） |
| `/skin clear <玩家>` | 清掉记录并还原原皮（读内存真实皮肤即时还原，失败则套默认皮/等重进） |
| `/skin list` | 列出 `skins/` 目录里能用的皮肤 |
| `/skin reload` | 重新扫描皮肤目录并重发已设置的皮肤 |
| `/skin show <皮肤名>` | 在自己面前预览皮肤（约 20 秒消失） |

## 皮肤怎么放

皮肤都放在 `plugins/skin/skins/` 目录里：

**普通皮肤（2D）**：直接丢一张 png，皮肤名就是文件名（不带 `.png`）。

```
skins/小明.png      ->  皮肤名 "小明"
```

**4D 皮肤（自定义模型）**：建一个以皮肤名命名的文件夹，里面放一张贴图 png + 一个 geometry.json。

```
skins/龙娘/
  texture.png       <- 贴图（认 .png）
  geometry.json     <- 模型（认 .json，新老格式都支持）
```

> 4D 皮肤贴图尺寸要和 geometry.json 里的 `texture_width` / `texture_height` 对上，否则贴图错乱。
> 发包只能还原模型形状，会动的特效（动画）得靠真正挂资源包。

**URL 在线皮肤**：`/skin set <玩家> <图片URL>` 会用 curl 下载图片当 2D 皮肤，套上后自动删掉下载缓存。

## 关于 /skin clear 还原

发包换肤只改客户端、不动服务器内存，所以服务器里一直存着玩家的「原皮」。`clear` 按下面顺序还原：

1. **读内存真实皮肤即时还原**（需 iListenAttentively-LseExport）：用符号调用 `getLevel → getPlayerList`
   定位玩家，`SerializedSkinImpl::write` 把原皮序列化，再用 `getString(addr, true)` 以 base64 无损读出字节、
   发包还原，**瞬间变回原皮**（含 Persona 市场皮肤），无需重进或提前存盘；
2. 读内存失败（没装 ila / 旧版无 base64 参数）时：有 `skins/default` 就发包套默认皮；
3. 再不行就只删记录，玩家**重进**后服务器会重新广播真实皮肤，自然恢复。

> 内存读用的是稳定的导出符号 + 标准库 ABI 偏移；如某版本符号对不上会自动回退到第 2/3 步，不会崩服。

## 给其他插件用的接口（`ll.exports`，命名空间 `SkinAPI`）

```js
const setSkin = ll.imports("SkinAPI", "setSkin");
setSkin(player, "龙娘");
```

| 函数 | 返回 | 说明 |
| --- | --- | --- |
| `setSkin(player, skinName)` | bool | 套皮肤并记录（玩家退进自动补） |
| `applySkin(player, skinName)` | bool | 只发包套皮肤，不写记录（临时） |
| `clearSkin(player)` | bool | 清掉记录并还原原皮（读内存真实皮肤即时还原，失败则默认皮/重进） |
| `showSkin(player, skinName)` | bool | 在该玩家面前展示假人皮肤（仅他可见） |
| `listSkins()` | string[] | 列出可用皮肤名 |
| `reload()` | bool | 重新扫描皮肤目录 |

## 致谢

- PNG 解码使用了 [UPNG.js](https://github.com/photopea/UPNG.js)（作者 Photopea，MIT 协议）。

## 许可

MIT
