# skin —— LeviLamina / LSE 皮肤管理插件

给 Minecraft 基岩版服务器（LeviLamina + LegacyScriptEngine QuickJS）用的皮肤插件。
管理员可以给玩家换皮肤，支持普通皮肤（单张 png）和 **4D 皮肤**（png + 自定义 geometry 模型），
全程纯发包实现，并提供给其他插件调用的接口。

> 作者：干物社（QQ 2063665699）、子沐呀（QQ 1756150362）

## 特性

- `/skin` 命令给玩家设置 / 清除 / 列出 / 重载皮肤
- 支持 2D 普通皮肤与 4D 自定义模型皮肤
- 玩家退出后再进服自动补回已设置的皮肤
- `/skin show` 在自己面前临时生成假人预览皮肤（只自己可见，不占服务器实体）
- `/skin mem` 实验性：用 iListenAttentively 直接改服务器内存里的皮肤（`SerializedSkinImpl::read`）
- 全程走 GMLIB 二进制流发包，包头按版本对应，跨版本更稳
- 通过 `ll.exports` 暴露 `SkinAPI` 给其他插件调用

## 前置依赖

- [LegacyScriptEngine (QuickJS)](https://github.com/LiteLDev/LegacyScriptEngine)
- [GMLIB-LegacyRemoteCallApi](https://github.com/GroupMountain/GMLIB)（发包必需）
- [iListenAttentively-LseExport](https://github.com/MiracleForest/iListenAttentively-Mod)（仅 `/skin mem` 需要）

## 安装

把整个 `skin` 文件夹放进服务器的 `plugins/` 目录，确保上面的前置依赖都已安装，重启服务器。

## 命令（需要 OP / 管理员）

| 命令 | 说明 |
| --- | --- |
| `/skin set <玩家> <皮肤名>` | 给玩家套皮肤，广播给所有人并记录 |
| `/skin clear <玩家>` | 清掉记录，该玩家重进恢复原皮肤 |
| `/skin list` | 列出 `skins/` 目录里能用的皮肤 |
| `/skin reload` | 重新扫描皮肤目录并重发已设置的皮肤 |
| `/skin show <皮肤名>` | 在自己面前预览皮肤（约 20 秒消失） |
| `/skin mem <玩家> <皮肤名>` | 实验性：直接改服务器内存里的皮肤 |

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

## 给其他插件用的接口（`ll.exports`，命名空间 `SkinAPI`）

```js
const setSkin = ll.imports("SkinAPI", "setSkin");
setSkin(player, "龙娘");
```

| 函数 | 返回 | 说明 |
| --- | --- | --- |
| `setSkin(player, skinName)` | bool | 套皮肤并记录（玩家退进自动补） |
| `applySkin(player, skinName)` | bool | 只发包套皮肤，不写记录（临时） |
| `clearSkin(player)` | bool | 清掉记录，玩家重进恢复原皮 |
| `showSkin(player, skinName)` | bool | 在该玩家面前展示假人皮肤（仅他可见） |
| `setSkinByMemory(player, skinName)` | string | 内存改皮肤，成功返回 `""`，失败返回错误说明 |
| `listSkins()` | string[] | 列出可用皮肤名 |
| `reload()` | bool | 重新扫描皮肤目录 |

## 致谢

- PNG 解码使用了 [UPNG.js](https://github.com/photopea/UPNG.js)（作者 Photopea，MIT 协议）。

## 许可

MIT
