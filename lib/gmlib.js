/**
 * GMLIB 发包封装。所有皮肤/玩家列表/展示包都走它的二进制流，包头按版本对应，兼容性更好。
 * GMLIB 是前置依赖；没装时发包相关功能不可用。
 */

let GMLIB = null;
let tried = false;

function get() {
    if (GMLIB || tried) return GMLIB;
    tried = true;
    try {
        try { GMLIB = require("../../GMLIB-LegacyRemoteCallApi/lib/GMLIB_API-JS.js"); }
        catch (e) { GMLIB = require("./GMLIB-LegacyRemoteCallApi/lib/GMLIB_API-JS.js"); }
    }
    catch (e) { logger.error("加载 GMLIB 失败，皮肤发包用不了: " + e); GMLIB = null; }
    return GMLIB;
}

// 新建一条二进制流(失败返回 null)
function newStream() {
    let g = get();
    return g ? new g.GMLIB_BinaryStream() : null;
}

// 建流、填好、发给所有在线玩家。fill(bs) 负责写内容。成功 true
function sendAll(fill) {
    let bs = newStream();
    if (!bs) return false;
    fill(bs);
    bs.sendToAll(true);
    return true;
}

// 建流、填好、只发给某个玩家。成功 true
function sendOne(target, fill) {
    let bs = newStream();
    if (!bs) return false;
    fill(bs);
    bs.sendTo(target, true);
    return true;
}

module.exports = {
    get: get,
    newStream: newStream,
    sendAll: sendAll,
    sendOne: sendOne
};
