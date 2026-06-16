/// <reference path='helperlib/index.d.ts'/>

/**
 * 皮肤管理插件(入口)
 *  - /skin 命令，管理员给玩家设皮肤
 *  - 支持普通皮肤(单张 png)、4D 皮肤(png + 自定义几何 json)、URL 皮肤(自动下载)
 *  - 设置会记下来，玩家重进自动补发
 *  - /skin show 用 GMLIB 在面前展示假人皮肤
 *  - 换肤/展示全程发包(GMLIB 二进制流)；/clear 可选用 ila 读内存原皮即时还原(默认关，见 lib/config.js)
 *
 * 代码已模块化，逻辑都在 lib/ 下，本文件只负责装配：
 *   config 常量 / store 持久化 / skins 加载 / urlDownload 下载 / gmlib 发包 /
 *   protocol 协议 / memory 内存读原皮 / skinService 换肤 / showService 展示 /
 *   commands 命令 / events 进退服 / api 对外接口
 *
 * @author 干物社 QQ 2063665699、子沐呀 QQ 1756150362
 */

// LSE 的 require 解析在不同环境下基准不一致(有的按 plugins/ 根，有的按文件自身目录)，
// 这里两种写法都试一遍，谁能加载用谁，保证无论哪种解析模型都能跑起来。
function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }

const commands = imp("./lib/commands.js", "./skin/lib/commands.js");
const events = imp("./lib/events.js", "./skin/lib/events.js");
const api = imp("./lib/api.js", "./skin/lib/api.js");

// 命令要等服务器起来再注册
mc.listen("onServerStarted", function () { commands.register(); });

// 进退服监听 & 对外接口在加载时就绪
events.register();
api.register();

logger.info("皮肤管理插件已加载");
