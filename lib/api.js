/**
 * 对外接口(命名空间 SkinAPI)。别的插件 ll.imports("SkinAPI", "xxx") 就能调下面这些。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const skins = imp("./skins.js", "./skin/lib/skins.js");
const store = imp("./store.js", "./skin/lib/store.js");
const urlDownload = imp("./urlDownload.js", "./skin/lib/urlDownload.js");
const service = imp("./skinService.js", "./skin/lib/skinService.js");
const show = imp("./showService.js", "./skin/lib/showService.js");
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");

function setSkin(player, skinName) {
    if (!player || !skinName) return false;
    // URL 皮肤是异步下载，这里接受请求后台下，下好自动套上并记录，返回 true 表示已受理
    if (skins.isUrl(skinName)) {
        let xuid = player.xuid;
        urlDownload.ensureUrlSkin(skinName, function (ok) {
            if (!ok) return;
            let p = service.getOnlineByXuid(xuid);
            if (p && service.applySkin(p, skinName)) { store.set(xuid, skinName); store.save(); }
            skins.cleanupUrlCache(skinName);
        });
        return true;
    }
    if (!skins.loadSkin(skinName)) return false;
    if (!service.applySkin(player, skinName)) return false;
    store.set(player.xuid, skinName);
    store.save();
    return true;
}

function applySkin(player, skinName) {
    if (!player || !skinName || !skins.loadSkin(skinName)) return false;
    return service.applySkin(player, skinName);
}

function clearSkin(player) {
    if (!player) return false;
    service.clearSkin(player); // 内部已抹记录、还原原皮/套默认皮
    store.save();
    return true;
}

function showSkin(player, skinName) {
    if (!player || !skinName || !skins.loadSkin(skinName) || !gmlib.get()) return false;
    return show.showSkin(player, skinName);
}

function listSkins() { return skins.listSkins(); }

function reload() { skins.clearCache(); store.load(); return true; }

function register() {
    ll.exports(setSkin, "SkinAPI", "setSkin");
    ll.exports(applySkin, "SkinAPI", "applySkin");
    ll.exports(clearSkin, "SkinAPI", "clearSkin");
    ll.exports(showSkin, "SkinAPI", "showSkin");
    ll.exports(listSkins, "SkinAPI", "listSkins");
    ll.exports(reload, "SkinAPI", "reload");
}

module.exports = {
    register: register
};
