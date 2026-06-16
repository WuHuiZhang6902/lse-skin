/**
 * /skin 命令注册(GameMasters 权限，玩家执行需 OP)。
 *   set / clear / list / reload / show / symtest
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");
const skins = imp("./skins.js", "./skin/lib/skins.js");
const store = imp("./store.js", "./skin/lib/store.js");
const urlDownload = imp("./urlDownload.js", "./skin/lib/urlDownload.js");
const service = imp("./skinService.js", "./skin/lib/skinService.js");
const show = imp("./showService.js", "./skin/lib/showService.js");
const memory = imp("./memory.js", "./skin/lib/memory.js");
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");

function register() {
    let cmd = mc.newCommand("skin", "皮肤管理", PermType.GameMasters);
    cmd.setEnum("ActSet", ["set"]);
    cmd.setEnum("ActClear", ["clear"]);
    cmd.setEnum("ActList", ["list"]);
    cmd.setEnum("ActReload", ["reload"]);
    cmd.setEnum("ActShow", ["show"]);
    cmd.setEnum("ActSymTest", ["symtest"]);
    cmd.mandatory("action", ParamType.Enum, "ActSet", 1);
    cmd.mandatory("action", ParamType.Enum, "ActClear", 1);
    cmd.mandatory("action", ParamType.Enum, "ActList", 1);
    cmd.mandatory("action", ParamType.Enum, "ActReload", 1);
    cmd.mandatory("action", ParamType.Enum, "ActShow", 1);
    cmd.mandatory("action", ParamType.Enum, "ActSymTest", 1);
    cmd.mandatory("target", ParamType.Player);
    cmd.mandatory("skinName", ParamType.RawText);
    cmd.overload(["ActSet", "target", "skinName"]);
    cmd.overload(["ActClear", "target"]);
    cmd.overload(["ActList"]);
    cmd.overload(["ActReload"]);
    cmd.overload(["ActShow", "skinName"]);
    cmd.overload(["ActSymTest"]);
    cmd.setCallback(onCommand);
    cmd.setup();
    logger.info("/skin 命令已注册");
}

function onCommand(_c, _ori, out, res) {
    // 命令本身已是 GameMasters 权限，这里再兜一道：玩家执行的必须是 OP，后台(无 player)放行
    let executor = _ori.player;
    if (executor && !executor.isOP()) return out.error("§c你没权限用这个命令");
    switch (res.action) {
        case "list": return doList(out);
        case "reload": return doReload(out);
        case "set": return doSet(executor, out, res);
        case "clear": return doClear(out, res);
        case "show": return doShow(_ori, out, res);
        case "symtest": return doSymTest(executor, out);
        default: return out.error("§c未知操作");
    }
}

function doList(out) {
    let s = skins.listSkins();
    return out.success("§e可用皮肤(" + s.length + ")：§f" + (s.join(", ") || "无"));
}

function doReload(out) {
    skins.clearCache();
    store.load();
    service.reapplyAll();
    return out.success("§a已重新扫描皮肤目录并重发");
}

function doSet(executor, out, res) {
    let targets = res.target;
    if (!targets || !targets.length) return out.error("§c没找到目标玩家");
    let nameOrUrl = res.skinName;

    // URL 皮肤：要先异步下载，下好了再套；命令先即时回个“下载中”
    if (skins.isUrl(nameOrUrl)) {
        if (!skins.isSafeUrl(nameOrUrl)) return out.error("§cURL 不合法或含特殊字符");
        let xuids = [];
        for (let i = 0; i < targets.length; i++) xuids.push(targets[i].xuid);
        out.success("§e正在下载 URL 皮肤，请稍候…");
        urlDownload.ensureUrlSkin(nameOrUrl, function (ok, err) {
            if (!ok) {
                if (executor) { try { executor.tell("§cURL 皮肤下载失败：" + err); } catch (e) {} }
                else logger.error("URL 皮肤下载失败：" + err);
                return;
            }
            let n = 0;
            for (let i = 0; i < xuids.length; i++) {
                let p = service.getOnlineByXuid(xuids[i]);
                if (p && service.applySkin(p, nameOrUrl)) { store.set(xuids[i], nameOrUrl); n++; }
            }
            store.save();
            skins.cleanupUrlCache(nameOrUrl);
            let msg = "§a已给 " + n + " 个玩家设置 URL 皮肤";
            if (executor) { try { executor.tell(msg); } catch (e) {} } else logger.info("" + msg);
        });
        return;
    }

    if (!skins.loadSkin(nameOrUrl)) return out.error("§c没有这个皮肤：" + nameOrUrl);
    let n = 0;
    for (let i = 0; i < targets.length; i++) {
        if (service.applySkin(targets[i], nameOrUrl)) {
            store.set(targets[i].xuid, nameOrUrl);
            n++;
        }
    }
    store.save();
    return out.success("§a已给 " + n + " 个玩家设置皮肤：" + nameOrUrl);
}

function doClear(out, res) {
    let targets = res.target;
    if (!targets || !targets.length) return out.error("§c没找到目标玩家");
    let hasDefault = !!skins.loadSkin(config.DEFAULT_SKIN_NAME);
    let restored = 0, fellBack = 0;
    for (let i = 0; i < targets.length; i++) {
        let r = service.clearSkin(targets[i]);
        if (r.restored) restored++;
        else if (r.fellBack) fellBack++;
    }
    store.save();
    if (restored > 0) return out.success("§a已清除，其中 " + restored + " 个发包还原了原皮，其余 " + fellBack + " 个套默认皮/等重进");
    if (hasDefault) return out.success("§a已清除并发包恢复默认皮肤(" + fellBack + "/" + targets.length + ")");
    return out.success("§a已清除记录，对应玩家重新进服后变回原皮肤(开启 ENABLE_MEM_RESTORE 可改成内存读原皮即时还原)");
}

function doShow(_ori, out, res) {
    let player = _ori.player;
    if (!player) return out.error("§c这个命令只能玩家执行");
    if (!skins.loadSkin(res.skinName)) return out.error("§c没有这个皮肤：" + res.skinName);
    if (!gmlib.get()) return out.error("§c没装 GMLIB，展示功能用不了");
    if (show.showSkin(player, res.skinName)) {
        return out.success("§a已在你面前展示皮肤：" + res.skinName + "（约 " + (config.SHOW_DURATION_MS / 1000) + " 秒后消失）");
    }
    return out.error("§c展示失败，看后台日志");
}

function doSymTest(executor, out) {
    let logFn = function (s) {
        if (executor) { try { executor.tell(s); } catch (e) {} }
        logger.info(s.replace(/§./g, ""));
    };
    memory.runSymTest(logFn);
    return out.success("§a符号测试完成，看聊天/后台日志，把结果贴回来");
}

module.exports = {
    register: register
};
