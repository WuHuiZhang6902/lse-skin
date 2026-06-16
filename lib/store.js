/**
 * 玩家皮肤记录的持久化：xuid -> 皮肤名(或 URL)。
 * 谁设了啥皮肤记在 players.json 里，玩家退了再进就照着这个表补发，不然一掉线皮肤就没了。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");

let data = {};

function load() {
    try { if (File.exists(config.DATA_PATH)) data = JSON.parse(File.readFrom(config.DATA_PATH)) || {}; }
    catch (e) { data = {}; }
}

function save() {
    try { File.writeTo(config.DATA_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
}

function get(xuid) { return data[xuid]; }
function set(xuid, name) { data[xuid] = name; }
function remove(xuid) { delete data[xuid]; }
function all() { return data; }

load();

module.exports = {
    load: load,
    save: save,
    get: get,
    set: set,
    remove: remove,
    all: all
};
