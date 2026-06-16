/**
 * 进退服事件。
 *  - 进服：晚一秒(等客户端加载好)，把别人的皮肤发给新人、再把新人自己的皮肤广播出去。
 *  - 退服：清掉假人展示记录。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");
const proto = imp("./protocol.js", "./skin/lib/protocol.js");
const skins = imp("./skins.js", "./skin/lib/skins.js");
const store = imp("./store.js", "./skin/lib/store.js");
const service = imp("./skinService.js", "./skin/lib/skinService.js");
const urlDownload = imp("./urlDownload.js", "./skin/lib/urlDownload.js");
const show = imp("./showService.js", "./skin/lib/showService.js");

function register() {
    mc.listen("onJoin", onJoin);
    mc.listen("onLeft", onLeft);
}

function onJoin(pl) {
    setTimeout(function () {
        if (!gmlib.get()) return;
        // 把在线所有人的皮肤发给刚进来的玩家
        let players = mc.getOnlinePlayers() || [];
        for (let i = 0; i < players.length; i++) {
            let name = store.get(players[i].xuid);
            if (!name) continue;
            let skin = skins.loadSkin(name);
            if (!skin) continue;
            let other = players[i];
            let entry = proto.entryOfPlayer(other);
            let writeSkin = function (bs) { proto.writeSkinStruct(bs, skin); };
            try {
                gmlib.sendOne(pl, function (bs) { proto.writeListRemove(bs, other.uuid); });
                gmlib.sendOne(pl, function (bs) { proto.writeListAdd(bs, entry, writeSkin); });
                gmlib.sendOne(pl, function (bs) { proto.writePlayerSkin(bs, other.uuid, writeSkin); });
            } catch (e) {}
        }
        // 再把新人自己的皮肤广播出去
        let myName = store.get(pl.xuid);
        if (myName) {
            // URL 皮肤如果本地缓存没了(换服/清过缓存)，补下一次再套
            if (skins.isUrl(myName) && !skins.loadSkin(myName)) {
                urlDownload.ensureUrlSkin(myName, function (ok) { if (ok) { service.applySkin(pl, myName); skins.cleanupUrlCache(myName); } });
            } else {
                service.applySkin(pl, myName);
            }
        }
    }, 1000);
}

function onLeft(pl) {
    show.onPlayerLeft(pl);
}

module.exports = {
    register: register
};
