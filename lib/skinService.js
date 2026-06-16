/**
 * 换肤核心逻辑：给玩家套皮肤、批量重发、清除时还原原皮。
 * 套皮肤 = 发 PlayerSkin(在线立即生效) + PlayerList 移除/添加(列表与新进玩家也对)。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");
const proto = imp("./protocol.js", "./skin/lib/protocol.js");
const skins = imp("./skins.js", "./skin/lib/skins.js");
const memory = imp("./memory.js", "./skin/lib/memory.js");
const store = imp("./store.js", "./skin/lib/store.js");

function getOnlineByXuid(xuid) {
    let players = mc.getOnlinePlayers() || [];
    for (let i = 0; i < players.length; i++) {
        if (players[i] && players[i].xuid === xuid) return players[i];
    }
    return null;
}

// 给在线玩家发 PlayerSkin 立即刷新，再走一遍 PlayerList(移除+添加)把列表里的皮肤也改掉
function applySkin(target, skinName) {
    let skin = skins.loadSkin(skinName);
    if (!skin) return false;
    if (!gmlib.get()) { logger.error("没装 GMLIB，发不了皮肤包"); return false; }
    let writeSkin = function (bs) { proto.writeSkinStruct(bs, skin); };
    let entry = proto.entryOfPlayer(target);
    try {
        gmlib.sendAll(function (bs) { proto.writePlayerSkin(bs, target.uuid, writeSkin); });
        gmlib.sendAll(function (bs) { proto.writeListRemove(bs, target.uuid); });
        gmlib.sendAll(function (bs) { proto.writeListAdd(bs, entry, writeSkin); });
    } catch (e) {
        logger.error("发皮肤包失败: " + e);
        return false;
    }
    return true;
}

// 把所有设过皮肤的在线玩家重新刷一遍(改完配置/reload 时用)
function reapplyAll() {
    let players = mc.getOnlinePlayers() || [];
    for (let i = 0; i < players.length; i++) {
        let name = store.get(players[i].xuid);
        if (name) applySkin(players[i], name);
    }
}

// 两步法用的临时皮肤：64x64 纯色普通皮肤(很小)，只为把客户端“当前皮肤”顶掉一下
let _dummySkin = null;
function getDummySkin() {
    if (_dummySkin) return _dummySkin;
    let w = 64, h = 64;
    let data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 30; data[i + 1] = 30; data[i + 2] = 30; data[i + 3] = 255; }
    _dummySkin = { width: w, height: h, data: data, geometryName: "geometry.humanoid.custom", geometryData: "", geometryEngineVersion: "0.0.0" };
    return _dummySkin;
}

// 读内存里的原皮 -> 发包还原。成功返回 true。(开关默认关，readRealSkinBytes 会直接返回 null)
function restoreRealSkin(player) {
    let base = memory.readRealSkinBytes(player);
    if (!base) return false;
    let raw = memory.replaceSkinIdInPlace(base); // 换掉 SkinId，配合两步法避免判重
    if (!gmlib.get()) return false;
    let entry = proto.entryOfPlayer(player);
    let writeDummy = function (bs) { proto.writeSkinStruct(bs, getDummySkin()); };
    let writeRaw = function (bs) { proto.writeRawSkinBytes(bs, raw); };
    try {
        // 先发临时皮肤把“当前皮肤”顶成它，再发真实原皮 => 真实原皮永远与上一个不同，客户端必定应用
        gmlib.sendAll(function (bs) { proto.writePlayerSkin(bs, player.uuid, writeDummy); });
        gmlib.sendAll(function (bs) { proto.writePlayerSkin(bs, player.uuid, writeRaw); });
        gmlib.sendAll(function (bs) { proto.writeListRemove(bs, player.uuid); });
        gmlib.sendAll(function (bs) { proto.writeListAdd(bs, entry, writeRaw); });
    } catch (e) {
        logger.error("还原原皮发包失败: " + e);
        return false;
    }
    return true;
}

// 清除玩家皮肤：先抹记录；优先内存读原皮即时还原，不行再套默认皮(若有)，再不行等重进。
// 返回 { restored: bool, fellBack: bool }
function clearSkin(player) {
    store.remove(player.xuid);
    if (restoreRealSkin(player)) return { restored: true, fellBack: false };
    if (skins.loadSkin(config.DEFAULT_SKIN_NAME) && applySkin(player, config.DEFAULT_SKIN_NAME)) {
        return { restored: false, fellBack: true };
    }
    return { restored: false, fellBack: false };
}

module.exports = {
    getOnlineByXuid: getOnlineByXuid,
    applySkin: applySkin,
    reapplyAll: reapplyAll,
    restoreRealSkin: restoreRealSkin,
    clearSkin: clearSkin,
    getDummySkin: getDummySkin
};
