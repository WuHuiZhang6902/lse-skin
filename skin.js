/// <reference path='helperlib/index.d.ts'/>

/**
 * 皮肤管理插件
 *  - /skin 命令，管理员给玩家设皮肤
 *  - 支持普通皮肤(单张 png)和 4D 皮肤(png + 自定义几何 json)
 *  - 设置会记下来，玩家重进自动补发
 *  - /skin show 用 GMLIB 在面前展示假人皮肤
 *  - 换肤/展示全程发包(GMLIB 二进制流)；/clear 可选用 ila 读内存原皮即时还原(默认关，见 ENABLE_MEM_RESTORE)
 *
 * @author 干物社 QQ 2063665699、子沐呀 QQ 1756150362
 */

const PLUGIN_DIR = "./plugins/skin";
const SKINS_DIR = PLUGIN_DIR + "/skins/";
const DATA_PATH = PLUGIN_DIR + "/players.json";
// URL 皮肤下载下来的图缓存在这，文件名按 URL 算个 hash，同一个链接复用不重复下
const URL_CACHE_DIR = SKINS_DIR + ".urlcache/";
// clear 时若存在这个皮肤(skins/default.png 或文件夹)，就发包套上当"恢复默认"，否则只能等玩家重进
const DEFAULT_SKIN_NAME = "default";

let UPNG = null;
try { UPNG = require("./skin/UPNG.js"); } catch (e) { logger.error("加载 UPNG 失败: " + e); }

try { if (!File.exists(SKINS_DIR)) File.mkdir(SKINS_DIR); } catch (e) {}
try { if (!File.exists(URL_CACHE_DIR)) File.mkdir(URL_CACHE_DIR); } catch (e) {}


// ==================== 持久化：xuid -> 皮肤名 ====================
// 谁设了啥皮肤记在 players.json 里，玩家退了再进就照着这个表补上，不然一掉线皮肤就没了
let playerData = {};
function loadData() {
    try { if (File.exists(DATA_PATH)) playerData = JSON.parse(File.readFrom(DATA_PATH)) || {}; }
    catch (e) { playerData = {}; }
}
function saveData() {
    try { File.writeTo(DATA_PATH, JSON.stringify(playerData, null, 2)); } catch (e) {}
}
loadData();


// ==================== 皮肤加载(png / 4D 文件夹) ====================
const skinCache = {};

function clearSkinCache() {
    for (let k in skinCache) {
        if (Object.prototype.hasOwnProperty.call(skinCache, k)) delete skinCache[k];
    }
}

// 看看 skins/ 目录里有啥能用：一张 png 算一个，一个文件夹也算一个(4D 皮肤)
function listSkins() {
    let result = [];
    let entries;
    try { entries = File.getFilesList(SKINS_DIR); } catch (e) { entries = []; }
    if (!entries) return result;
    for (let i = 0; i < entries.length; i++) {
        let e = entries[i];
        if (!e) continue;
        if (e.toLowerCase().endsWith(".png")) result.push(e.slice(0, -4));
        else if (File.checkIsDir(SKINS_DIR + e)) result.push(e);
    }
    return result;
}

function decodePng(path) {
    if (!UPNG) return null;
    if (!File.exists(path) || File.checkIsDir(path)) return null;
    let content;
    let f = new File(path, File.ReadMode, true);
    try { content = f.readAllSync(); } finally { try { f.close(); } catch (e) {} }
    if (!content) return null;
    // URL 下回来的可能不是 png(比如错误页)，解析失败别让它抛出去
    try {
        let img = UPNG.decode(content);
        return { width: img.width, height: img.height, data: UPNG.toRGBA8(img)[0] };
    } catch (e) {
        logger.warn("解析 PNG 失败: " + path + " (" + e + ")");
        return null;
    }
}

// 从几何 json 取几何名(default 引用的 identifier)和格式版本。
// engineVersion 必须带上，否则客户端会拿老格式解析新格式骨骼，4D 模型就废了
function parseGeometry(raw) {
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    let fmt = (typeof obj.format_version === "string") ? obj.format_version : "";
    if (obj["minecraft:geometry"] && obj["minecraft:geometry"][0] && obj["minecraft:geometry"][0].description) {
        let id = obj["minecraft:geometry"][0].description.identifier;
        if (id) return { name: id, data: JSON.stringify(obj), engineVersion: fmt || "1.12.0" };
    }
    for (let k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && k.indexOf("geometry.") === 0) {
            return { name: k.split(":")[0], data: JSON.stringify(obj), engineVersion: fmt || "0.0.0" };
        }
    }
    return null;
}

// 把一个皮肤读出来：单张 png 就是普通皮肤，文件夹(png + geometry json)就是 4D 皮肤。
// 读过的缓存住，别每次发包都去翻硬盘。返回 { width, height, data, geometryName, geometryData, geometryEngineVersion }
function loadSkin(name) {
    if (!name) return null;
    if (skinCache[name]) return skinCache[name];

    // URL 皮肤：图已经下到 .urlcache/ 了，当普通 2D 皮肤读；没下好就返回 null，让调用方先去下
    if (isUrl(name)) {
        let img = decodePng(urlCachePath(name));
        if (!img) return null;
        let r = {
            width: img.width, height: img.height, data: img.data,
            geometryName: "geometry.humanoid.custom", geometryData: "", geometryEngineVersion: "0.0.0"
        };
        skinCache[name] = r;
        return r;
    }

    let texturePath = null;
    let jsonPaths = [];
    let folder = SKINS_DIR + name + "/";
    if (File.exists(folder) && File.checkIsDir(folder)) {
        let files = File.getFilesList(folder) || [];
        for (let i = 0; i < files.length; i++) {
            let lf = files[i].toLowerCase();
            if (lf.endsWith(".png")) texturePath = folder + files[i];
            else if (lf.endsWith(".json")) jsonPaths.push(folder + files[i]);
        }
    } else if (File.exists(SKINS_DIR + name + ".png")) {
        texturePath = SKINS_DIR + name + ".png";
    }
    if (!texturePath) return null;

    let img = decodePng(texturePath);
    if (!img) return null;

    let geometryName = "geometry.humanoid.custom";
    let geometryData = "";
    let geometryEngineVersion = "0.0.0";
    // 文件夹里可能有好几个 json，挨个试，取真正含 geometry 的那个
    for (let i = 0; i < jsonPaths.length; i++) {
        let raw = File.readFrom(jsonPaths[i]);
        let g = raw ? parseGeometry(raw) : null;
        if (g) { geometryName = g.name; geometryData = g.data; geometryEngineVersion = g.engineVersion || "0.0.0"; break; }
    }
    if (jsonPaths.length && geometryData === "") {
        logger.warn("" + name + " 目录里没找到能识别的 geometry，按普通皮肤处理");
    }

    let result = {
        width: img.width, height: img.height, data: img.data,
        geometryName: geometryName, geometryData: geometryData,
        geometryEngineVersion: geometryEngineVersion
    };
    skinCache[name] = result;
    return result;
}


// ==================== URL 皮肤(下载到本地再当普通皮肤用) ====================
function isUrl(s) { return typeof s === "string" && /^https?:\/\//i.test(s); }

// 命令执行者是 OP/控制台，但 URL 还是要过滤掉能拆 shell 命令的字符，免得拼 curl 时出岔子
function isSafeUrl(s) {
    if (!isUrl(s)) return false;
    if (s.length > 1024) return false;
    return !/[\s"'`\\^<>|;]/.test(s);
}

// 按 URL 算个稳定 hash 当缓存文件名(djb2)，同一个链接每次都映射到同一个文件
function urlCacheName(url) {
    let h = 5381;
    for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
    return "u" + h.toString(16) + ".png";
}
function urlCachePath(url) { return URL_CACHE_DIR + urlCacheName(url); }

// 套上 URL 皮肤后把下载的缓存图删掉(皮肤已解码进内存 skinCache，本会话再用不到那个文件了，省磁盘)
function cleanupUrlCache(url) {
    try {
        let p = urlCachePath(url);
        if (File.exists(p)) File.delete(p);
    } catch (e) {}
}

// 确保 URL 的图已经在本地缓存：在就直接回调，不在就用 curl 下一份。cb(ok, err)
let urlInflight = {};
function ensureUrlSkin(url, cb) {
    if (!isSafeUrl(url)) { cb(false, "URL 不合法或含特殊字符"); return; }
    let dest = urlCachePath(url);
    try {
        if (File.exists(dest) && File.getFileSize(dest) > 0) { cb(true, ""); return; }
    } catch (e) {}
    if (urlInflight[url]) { urlInflight[url].push(cb); return; }
    urlInflight[url] = [cb];
    let finish = function (ok, err) {
        let list = urlInflight[url] || [];
        delete urlInflight[url];
        delete skinCache[url];   // 重新解码新下的图
        for (let i = 0; i < list.length; i++) { try { list[i](ok, err); } catch (e) {} }
    };
    // curl Win10+ / Linux 都自带，二进制下到文件最稳(走 network.httpGet 拿字符串会把 png 字节搞坏)
    let command = 'curl -L -s -A "MC-Skin/1.0" --max-time 20 -o "' + dest + '" "' + url + '"';
    let started = false;
    try {
        started = system.cmd(command, function (code, output) {
            let ok = false;
            try { ok = (File.exists(dest) && File.getFileSize(dest) > 0); } catch (e) {}
            if (ok) finish(true, "");
            else {
                try { if (File.exists(dest)) File.delete(dest); } catch (e) {}
                finish(false, "下载失败(curl code " + code + ")");
            }
        }, 25000);
    } catch (e) { finish(false, "" + e); return; }
    if (!started) finish(false, "无法启动下载进程(system.cmd)");
}

function getOnlineByXuid(xuid) {
    let players = mc.getOnlinePlayers() || [];
    for (let i = 0; i < players.length; i++) {
        if (players[i] && players[i].xuid === xuid) return players[i];
    }
    return null;
}


// ==================== 协议序列化 & 数据包 ====================
// 下面这堆是按基岩版协议手拼字节，字段顺序错一个后面全乱，别随便挪
function randomSkinId() {
    let s = "";
    for (let i = 0; i < 16; i++) {
        let b = Math.floor(Math.random() * 256).toString(16);
        s += b.length === 1 ? "0" + b : b;
    }
    return s + ".CustomSkin";
}

// GMLIB 是发包的前置依赖：所有皮肤/玩家列表/展示包都走它的二进制流，包头按版本对应，兼容性更好
let GMLIB = null;
function getGMLIB() {
    if (GMLIB) return GMLIB;
    try { GMLIB = require("./GMLIB-LegacyRemoteCallApi/lib/GMLIB_API-JS.js"); }
    catch (e) { logger.error("加载 GMLIB 失败，皮肤发包用不了: " + e); GMLIB = null; }
    return GMLIB;
}

// SerializedSkin 结构。写进 GMLIB 二进制流(write* 方法名一致)。
// 整个插件只有这一处定义皮肤格式，别处都调它，免得改一处漏一处
function writeSkinStruct(stream, skin) {
    let skinId = randomSkinId();

    stream.writeString(skinId);
    stream.writeString("");
    stream.writeString(JSON.stringify({ geometry: { default: skin.geometryName } }));

    stream.writeUnsignedInt(skin.width);
    stream.writeUnsignedInt(skin.height);

    let view = new Uint8Array(skin.data);
    stream.writeUnsignedVarInt(view.byteLength);
    for (let i = 0; i < view.byteLength; i++) stream.writeUnsignedChar(view[i]);

    stream.writeUnsignedInt(0);    // 动画数量
    stream.writeUnsignedInt(0);    // 披风宽
    stream.writeUnsignedInt(0);    // 披风高
    stream.writeUnsignedVarInt(0); // 披风数据(空)

    stream.writeString(skin.geometryData);                     // 4D 时是完整几何JSON，普通皮肤时空
    stream.writeString(skin.geometryEngineVersion || "0.0.0"); // 必须是 geometry.json 里的 format_version
    stream.writeString("");        // 动画数据
    stream.writeString("");        // 披风ID
    stream.writeString(skinId);    // Full Skin ID
    stream.writeString("wide");    // 手臂宽窄
    stream.writeString("#0");      // 皮肤颜色

    stream.writeUnsignedInt(0);    // persona piece 数量
    stream.writeUnsignedInt(0);    // tint color 数量

    stream.writeBool(false);       // premium
    stream.writeBool(false);       // persona
    stream.writeBool(false);       // persona cape on classic
    stream.writeBool(true);        // primary user
    stream.writeBool(true);        // 覆盖本体外观
}

const PKT_PLAYER_SKIN = 93;
const PKT_PLAYER_LIST = 63;

// 往 GMLIB 流里填 PlayerSkin：刷新某玩家皮肤，在线的人立即生效
function fillPlayerSkin(bs, player, skin) {
    bs.writePacketHeader(PKT_PLAYER_SKIN);
    bs.writeUuid(player.uuid);
    writeSkinStruct(bs, skin);
    bs.writeString(""); // new skin name
    bs.writeString(""); // old skin name
    bs.writeBool(true);  // trusted
}

// PlayerList REMOVE：把玩家从玩家列表里摘掉(只认 UUID)
function fillListRemove(bs, player) {
    bs.writePacketHeader(PKT_PLAYER_LIST);
    bs.writeByte(1);
    bs.writeUnsignedVarInt(1);
    bs.writeUuid(player.uuid);
}

// PlayerList ADD：带着新皮肤重新加回玩家列表，客户端据此重建外观
function fillListAdd(bs, player, skin) {
    bs.writePacketHeader(PKT_PLAYER_LIST);
    bs.writeByte(0);
    bs.writeUnsignedVarInt(1);
    bs.writeUuid(player.uuid);
    bs.writeVarInt64(Number(player.uniqueId)); // Target Actor ID
    bs.writeString(player.realName || player.name || "");
    bs.writeString(player.xuid || "");
    bs.writeString("");        // Platform Chat Id
    bs.writeSignedInt(-1);     // Build Platform
    writeSkinStruct(bs, skin);
    bs.writeBool(false);       // Is Teacher
    bs.writeBool(false);       // Is Host
    bs.writeBool(false);       // Is SubClient
    bs.writeUnsignedInt(0xFFFFFFFF); // Player Color (mce::Color)
    bs.writeBool(true);        // Trusted Skin List
}

// 建一条流、填好、发给所有在线玩家(用完销毁)
function sendAll(G, fill) {
    let bs = new G.GMLIB_BinaryStream();
    fill(bs);
    bs.sendToAll(true);
}
// 建一条流、填好、只发给某个玩家
function sendOne(G, target, fill) {
    let bs = new G.GMLIB_BinaryStream();
    fill(bs);
    bs.sendTo(target, true);
}


// ==================== 内存读「真实皮肤」(可选，默认关) ====================
// 发包换肤只改客户端、不动服务器内存，所以服务器里存的一直是玩家上传的「原皮」。
// 这里用 ila 把原皮序列化成字节，/clear 时直接发回去 => 瞬间还原原皮，不用提前存盘。
//
// !! 风险 !! 全是裸内存操作，偏移/符号错了会硬崩(0xC0000005/0xC0000409)，JS 的 try/catch
//    拦不住这种崩溃。所以默认关着，先在测试服把开关打开验证没问题，再上线。
// 内存读原皮：getLevel→getPlayerList→定位玩家→SerializedSkinImpl::write 序列化原皮，
// 再用 getString(addr,true) 以 base64 无损读出字节(ila 新增 base64 参数)，发包还原。
const ENABLE_MEM_RESTORE = true;

// 符号(MCAPI 真符号，已在本服 /skin symtest 验证可解析)。
const SYM = {
    // ll::service::getLevel() -> optional_ref<Level>  (在 LeviLamina.dll)
    getLevel: "?getLevel@bedrock@service@ll@@YA?AV?$optional_ref@VLevel@@@@XZ",
    // Level::getPlayerList() const -> unordered_map<UUID,PlayerListEntry> const&  (本服按虚函数 U 收录)
    getPlayerList: "?getPlayerList@Level@@QEBAAEBV?$unordered_map@VUUID@mce@@VPlayerListEntry@@U?$hash@VUUID@mce@@@std@@U?$equal_to@VUUID@mce@@@5@V?$allocator@U?$pair@$$CBVUUID@mce@@VPlayerListEntry@@@std@@@5@@std@@XZ",
    // SerializedSkinImpl::write(BinaryStream&) const -> void  (把皮肤序列化成线格式字节)
    skinImplWrite: "?write@SerializedSkinImpl@@QEBAXAEAVBinaryStream@@@Z",
    // BinaryStream::BinaryStream(std::string& buf, bool copyBuffer)  (让 C++ 自己设 vptr，省掉虚表)
    bsCtor: "??0BinaryStream@@QEAA@AEAV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@_N@Z"
};
// ila 的符号表里同名符号可能带 _0/_1 去重后缀，const 成员有时按虚函数(U)收录，
// 不同发行也可能挂在不同模块名下。挨个试，命中合法地址就用。
const SYM_MODULES = ["", "bedrock_server.exe", "bedrock_server.dll", "LeviLamina.dll"];
function symCandidates(sym) {
    let list = [sym, sym + "_0", sym + "_1"];
    if (sym.indexOf("QEBA") >= 0) list.push(sym.replace("QEBA", "UEBA"), sym.replace("QEBA", "UEBA") + "_0");
    return list;
}

// std::string MSVC 布局: data/SSO +0x00(16B), size +0x10, cap +0x18
const STR = { size: 0x20, dataOff: 0x00, sizeOff: 0x10, capOff: 0x18 };
// std::unordered_map(MSVC，本服已验证): 链表头指针 @+0x08, 元素数 @+0x10
//   链表结点: next @+0x00, value(pair) @+0x10
//   pair<const UUID, PlayerListEntry>: UUID 16B @+0x00, PlayerListEntry @+0x10
//   PlayerListEntry: mXUID(std::string) @+0x38, mSkin(SerializedSkinRef) @+0x80
const MAP = { listHead: 0x08, count: 0x10, nodeNext: 0x00, nodeValue: 0x10, entryOff: 0x10, xuidOff: 0x38, skinOff: 0x80 };

let ila = null;
let ilaTried = false;
function getIla() {
    if (ilaTried) return ila;
    ilaTried = true;
    try { ila = require("./iListenAttentively-LseExport/lib/iListenAttentively.js"); }
    catch (e) { ila = null; }
    return ila;
}

// 符号地址缓存，少调底层(性能)
const symCache = {};
let memWarned = false;
function memWarn(msg) { if (!memWarned) { memWarned = true; logger.warn("内存功能不可用，已回退: " + msg); } }

function looksLikePtr(p) { return typeof p === "number" && p > 0x10000 && p < 0x7FFFFFFFFFFF; }

function symAddr(I, key) {
    if (symCache[key] !== undefined) return symCache[key];
    let addr = 0;
    let cands = symCandidates(SYM[key]);
    outer:
    for (let m = 0; m < SYM_MODULES.length; m++) {
        for (let c = 0; c < cands.length; c++) {
            let got = 0;
            try {
                got = SYM_MODULES[m]
                    ? I.getAddressFromSymbol(SYM_MODULES[m], cands[c])
                    : I.getAddressFromSymbol(cands[c]);
            } catch (e) { got = 0; }
            if (looksLikePtr(got)) { addr = got; break outer; }
        }
    }
    symCache[key] = addr;
    return addr;
}

const NT = (function () { let I = getIla(); return I ? I.NativeType : null; })();

// 读一个 std::string 对象(在 strAddr)的字节，失败返回 null
function readStdBytes(I, strAddr, max) {
    let size = I.getUnsignedLongLong(strAddr + STR.sizeOff) || 0;
    let cap = I.getUnsignedLongLong(strAddr + STR.capOff) || 0;
    if (size <= 0 || size > (max || 300000)) return null;
    let dataAddr = (cap <= 15) ? (strAddr + STR.dataOff) : I.getRawAddress(strAddr + STR.dataOff);
    if (!looksLikePtr(dataAddr)) return null;
    let out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = (I.getUnsignedChar(dataAddr + i) || 0) & 0xFF;
    return out;
}
function readStdStr(I, strAddr) {
    let b = readStdBytes(I, strAddr, 256);
    if (!b) return "";
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
}

// base64 -> 字节数组(纯 JS，无损)。用于把 getString(addr,true) 读出的 base64 还原成原始字节。
let _b64lut = null;
function b64ToBytes(s) {
    if (typeof s !== "string" || !s) return null;
    s = s.replace(/[^A-Za-z0-9+/=]/g, "");
    if (!_b64lut) {
        _b64lut = new Int16Array(128).fill(-1);
        let tab = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (let i = 0; i < tab.length; i++) _b64lut[tab.charCodeAt(i)] = i;
    }
    let len = s.length;
    let pad = 0;
    if (len >= 1 && s.charCodeAt(len - 1) === 61) pad++;
    if (len >= 2 && s.charCodeAt(len - 2) === 61) pad++;
    let outLen = ((len >> 2) * 3) - pad;
    if (outLen <= 0) return null;
    let out = new Uint8Array(outLen);
    let oi = 0;
    for (let i = 0; i < len; i += 4) {
        let a = _b64lut[s.charCodeAt(i)] || 0;
        let b = _b64lut[s.charCodeAt(i + 1)] || 0;
        let c = _b64lut[s.charCodeAt(i + 2)] & 63;
        let d = _b64lut[s.charCodeAt(i + 3)] & 63;
        let n = (a << 18) | (b << 12) | (c << 6) | d;
        if (oi < outLen) out[oi++] = (n >> 16) & 0xFF;
        if (oi < outLen) out[oi++] = (n >> 8) & 0xFF;
        if (oi < outLen) out[oi++] = n & 0xFF;
    }
    return out;
}

// 用 BinaryStream(std::string& buf, false) 构造一个真流，让 C++ 自己写 vptr。
// 写出来的字节落进我们传进去的 buf。返回 { bs, buf } 两个地址，失败返回 null。
function makeStream(I) {
    let ctor = symAddr(I, "bsCtor");
    if (!looksLikePtr(ctor)) { logger.warn("makeStream: bsCtor 符号没解析出来"); return null; }
    let buf = 0, bs = 0;
    try {
        buf = I.mallocMemory(STR.size) || 0;
        bs = I.mallocMemory(0x60) || 0;
        if (!looksLikePtr(buf) || !looksLikePtr(bs)) throw new Error("malloc 返回非法地址");
        I.memsetMemory(buf, 0, STR.size); // 全 0 = 合法空 std::string
        I.memsetMemory(bs, 0, 0x60);
        // this=bs, arg1=std::string& buf, arg2=copyBuffer=false。
        // bool 参数 ila 的接受形式不确定，挨个试编码，参数校验是在真正调用前做的，失败不会动到内存。
        let attempts = [
            { t: [NT.Pointer, NT.Pointer, NT.Bool], v: [bs, buf, false] },
            { t: [NT.Pointer, NT.Pointer, NT.Bool], v: [bs, buf, 0] },
            { t: [NT.Pointer, NT.Pointer, NT.UnsignedChar], v: [bs, buf, 0] },
            { t: [NT.Pointer, NT.Pointer, NT.Int], v: [bs, buf, 0] }
        ];
        let ok = false, lastErr = null;
        for (let a = 0; a < attempts.length; a++) {
            try { I.dynamicCall(ctor, NT.Pointer, attempts[a].t, attempts[a].v); ok = true; break; }
            catch (e) { lastErr = e; }
        }
        if (!ok) throw new Error("dynamicCall 全部编码失败: " + lastErr);
        return { bs: bs, buf: buf };
    } catch (e) {
        if (bs) { try { I.freeMemory(bs); } catch (e2) {} }
        if (buf) { try { I.freeMemory(buf); } catch (e2) {} }
        return null;
    }
}

// ll::service::getLevel() -> Level*  (optional_ref<Level> 经 sret 返回，读缓冲里的唯一 Level*)
function memGetLevel(I) {
    let addr = symAddr(I, "getLevel");
    if (!looksLikePtr(addr)) return 0;
    let ret = 0, lvl = 0;
    try {
        ret = I.mallocMemory(16) || 0;
        if (!looksLikePtr(ret)) return 0;
        I.memsetMemory(ret, 0, 16);
        I.dynamicCall(addr, NT.Pointer, [NT.Pointer], [ret]);
        lvl = I.getRawAddress(ret);
    } catch (e) { lvl = 0; }
    finally { if (ret) { try { I.freeMemory(ret); } catch (e) {} } }
    return looksLikePtr(lvl) ? lvl : 0;
}

// Level::getPlayerList(this=level) -> map*
function memGetPlayerList(I, level) {
    let addr = symAddr(I, "getPlayerList");
    if (!looksLikePtr(addr) || !looksLikePtr(level)) return 0;
    let map = 0;
    try { map = I.dynamicCall(addr, NT.Pointer, [NT.Pointer], [level]); } catch (e) { map = 0; }
    return looksLikePtr(map) ? map : 0;
}

// 遍历玩家列表(unordered_map 的内部链表)，按 xuid 找到目标的 SerializedSkinImpl*(失败 0)
let MEM_DEBUG = false;
function memFindSkinImpl(I, mapPtr, xuid) {
    let head = I.getRawAddress(mapPtr + MAP.listHead);
    let count = I.getUnsignedLongLong(mapPtr + MAP.count) || 0;
    if (MEM_DEBUG) logger.warn("mem: head=" + (head ? head.toString(16) : 0) + " count=" + count + " 目标xuid=" + xuid);
    if (!looksLikePtr(head) || count <= 0 || count > 5000) return 0;
    let node = I.getRawAddress(head + MAP.nodeNext); // sentinel.next = 第一个真实结点
    let guard = 0;
    while (looksLikePtr(node) && node !== head && guard <= count + 1) {
        guard++;
        let entry = node + MAP.nodeValue + MAP.entryOff;
        let xs = readStdStr(I, entry + MAP.xuidOff);
        if (MEM_DEBUG) logger.warn("mem: 结点#" + guard + " entry=" + entry.toString(16) + " xuid='" + xs + "'");
        if (xs === xuid) {
            // entry+0x80 = SerializedSkinRef(shared_ptr)，_Ptr 即 ThreadOwner* == SerializedSkinImpl*
            let impl = I.getRawAddress(entry + MAP.skinOff);
            if (MEM_DEBUG) logger.warn("mem: 命中! impl=" + (impl ? impl.toString(16) : 0));
            return looksLikePtr(impl) ? impl : 0;
        }
        node = I.getRawAddress(node + MAP.nodeNext);
    }
    if (MEM_DEBUG) logger.warn("mem: 遍历完没匹配到 xuid");
    return 0;
}

// 诊断：把一堆候选符号挨个丢给 ila，看哪个能解析出合法地址，结果打日志。
// 用 /skin symtest 触发，把输出贴回来就能确定该用哪条符号路径。
function runSymTest(logFn) {
    let I = getIla();
    if (!I) { logFn("§c没装/没加载 iListenAttentively-LseExport"); return; }
    let probes = {
        "writeRawBytes#a": "?writeRawBytes@BinaryStream@@QEAAXVbuffer_span@@PEBD1@Z",
        "writeRawBytes#b": "?writeRawBytes@BinaryStream@@QEAAXVbuffer_span@@PEBD0@Z",
        "writeRawBytes#c": "?writeRawBytes@BinaryStream@@QEAAX?$buffer_span@$$CBD@@PEBD1@Z",
        "BinaryStream::ctor(string&,bool)": "??0BinaryStream@@QEAA@AEAV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@_N@Z"
    };
    for (let label in probes) {
        if (!Object.prototype.hasOwnProperty.call(probes, label)) continue;
        let base = probes[label];
        let cands = symCandidates(base);
        let hit = null;
        outer:
        for (let m = 0; m < SYM_MODULES.length; m++) {
            for (let c = 0; c < cands.length; c++) {
                let got = 0;
                try {
                    got = SYM_MODULES[m] ? I.getAddressFromSymbol(SYM_MODULES[m], cands[c]) : I.getAddressFromSymbol(cands[c]);
                } catch (e) { got = 0; }
                if (looksLikePtr(got)) { hit = { mod: SYM_MODULES[m] || "(default)", sym: cands[c], addr: got }; break outer; }
            }
        }
        if (hit) logFn("§a[OK] " + label + " -> " + hit.addr.toString(16) + "  @" + hit.mod + "  " + hit.sym);
        else logFn("§c[FAIL] " + label);
    }

    // 探测 GMLIB 流句柄是不是底层 BinaryStream* 指针：建流、写一个包头(1字节)，扫描偏移找 size==1
    try {
        let G = getGMLIB();
        if (G) {
            let s = new G.GMLIB_BinaryStream();
            s.writePacketHeader(93);
            let id = s.getId();
            logFn("§eGMLIB id=" + (typeof id === "number" ? id.toString(16) : id) + " looksLikePtr=" + looksLikePtr(id));
            if (looksLikePtr(id)) {
                for (let off = 0; off <= 0x40; off += 8) {
                    let v = 0; try { v = I.getUnsignedLongLong(id + off) || 0; } catch (e) { v = -1; }
                    logFn("§7  +0x" + off.toString(16) + " = " + (v === -1 ? "ERR" : v.toString(16)));
                }
            }
            try { s.destroy(); } catch (e) {}
        }
    } catch (e) { logFn("§cGMLIB 探测异常: " + e); }
}

// 读玩家当前「真实皮肤」的线格式字节(失败返回 null)。注意：开关关着时永不进内存。
function readRealSkinBytes(player) {
    if (!ENABLE_MEM_RESTORE) return null;
    let I = getIla();
    if (!I || !NT) { memWarn("没装 iListenAttentively-LseExport"); return null; }

    let writeAddr = symAddr(I, "skinImplWrite");
    if (!looksLikePtr(writeAddr)) { memWarn("符号解析失败(SerializedSkinImpl::write)"); return null; }
    if (!player || !player.xuid) return null;

    let stream = null;
    try {
        let level = memGetLevel(I);
        if (MEM_DEBUG) logger.warn("mem: level=" + (level ? level.toString(16) : 0));
        if (!level) { memWarn("getLevel 失败"); return null; }
        let map = memGetPlayerList(I, level);
        if (MEM_DEBUG) logger.warn("mem: map=" + (map ? map.toString(16) : 0));
        if (!map) { memWarn("getPlayerList 失败"); return null; }
        let impl = memFindSkinImpl(I, map, player.xuid);
        if (!impl) return null; // 没在列表里找到该玩家，或皮肤指针为空

        stream = makeStream(I);
        if (!stream) { memWarn("构造 BinaryStream 失败"); return null; }

        // SerializedSkinImpl::write(this=impl, &bs) -> 序列化原皮(字节落在外部 buf，copyBuffer=false)
        I.dynamicCall(writeAddr, NT.Void, [NT.Pointer, NT.Pointer], [impl, stream.bs]);

        // 一次调用以 base64 无损读出整个 std::string(getString 第二参 base64=true)，再纯 JS 解码成字节
        let size = I.getUnsignedLongLong(stream.buf + STR.sizeOff) || 0;
        if (size <= 0 || size > 4000000) { if (MEM_DEBUG) logger.warn("mem: size 异常=" + size); return null; }
        let b64 = I.getString(stream.buf, true);
        let bytes = b64ToBytes(b64);
        if (MEM_DEBUG) logger.warn("mem: size=" + size + " b64.len=" + (b64 ? b64.length : "null") + " 解码字节数=" + (bytes ? bytes.length : "null"));
        if (!bytes || bytes.length !== size) { if (MEM_DEBUG) logger.warn("mem: 解码字节数与 size 不符，放弃发包"); return null; }
        return bytes;
    } catch (e) {
        memWarn("" + e);
        return null;
    } finally {
        // 只释放自己 malloc 的结构块；std::string 内部若扩到堆(原皮几十 KB)那块是 MC 分配的，
        // 用 ila 的 free 跨堆释放会崩，宁可小泄漏(clear 很少触发)。
        if (stream) {
            if (stream.bs) { try { I.freeMemory(stream.bs); } catch (e) {} }
            if (stream.buf) { try { I.freeMemory(stream.buf); } catch (e) {} }
        }
    }
}

// 往 GMLIB 流里塞一段原始皮肤字节(就是 writeSkinStruct 的位置，只是改成现成的字节)
function writeRawSkin(bs, raw) {
    for (let i = 0; i < raw.length; i++) bs.writeUnsignedChar(raw[i] & 0xFF);
}
function fillPlayerSkinRaw(bs, player, raw) {
    bs.writePacketHeader(PKT_PLAYER_SKIN);
    bs.writeUuid(player.uuid);
    writeRawSkin(bs, raw);
    bs.writeString("");
    bs.writeString("");
    bs.writeBool(true);
}
function fillListAddRaw(bs, player, raw) {
    bs.writePacketHeader(PKT_PLAYER_LIST);
    bs.writeByte(0);
    bs.writeUnsignedVarInt(1);
    bs.writeUuid(player.uuid);
    bs.writeVarInt64(Number(player.uniqueId));
    bs.writeString(player.realName || player.name || "");
    bs.writeString(player.xuid || "");
    bs.writeString("");
    bs.writeSignedInt(-1);
    writeRawSkin(bs, raw);
    bs.writeBool(false);
    bs.writeBool(false);
    bs.writeBool(false);
    bs.writeUnsignedInt(0xFFFFFFFF);
    bs.writeBool(true);
}

// 读内存里的原皮 -> 发包还原(在线即时 + 玩家列表)。成功返回 true。
function restoreRealSkin(player) {
    let raw = readRealSkinBytes(player);
    if (!raw) return false;
    let G = getGMLIB();
    if (!G) return false;
    try {
        sendAll(G, function (bs) { fillPlayerSkinRaw(bs, player, raw); });
        sendAll(G, function (bs) { fillListRemove(bs, player); });
        sendAll(G, function (bs) { fillListAddRaw(bs, player, raw); });
    } catch (e) {
        logger.error("还原原皮发包失败: " + e);
        return false;
    }
    return true;
}


// ==================== 套皮肤(发包) ====================
// 给在线玩家发 PlayerSkin 立即刷新，再走一遍 PlayerList(移除+添加)把列表里的皮肤也改掉。
// 在线的人马上看到新皮肤，新玩家进服也能从玩家列表拿到正确皮肤
function applySkin(target, skinName) {
    let skin = loadSkin(skinName);
    if (!skin) return false;
    let G = getGMLIB();
    if (!G) { logger.error("没装 GMLIB，发不了皮肤包"); return false; }
    try {
        sendAll(G, function (bs) { fillPlayerSkin(bs, target, skin); });
        sendAll(G, function (bs) { fillListRemove(bs, target); });
        sendAll(G, function (bs) { fillListAdd(bs, target, skin); });
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
        let name = playerData[players[i].xuid];
        if (name) applySkin(players[i], name);
    }
}


// ==================== 进服补发 ====================
// 新人进来晚一秒(等客户端加载好)，把别人的皮肤发给他、再把他自己的皮肤广播出去
mc.listen("onJoin", function (pl) {
    setTimeout(function () {
        let G = getGMLIB();
        if (!G) return;
        let players = mc.getOnlinePlayers() || [];
        for (let i = 0; i < players.length; i++) {
            let name = playerData[players[i].xuid];
            if (!name) continue;
            let skin = loadSkin(name);
            if (!skin) continue;
            let other = players[i];
            try {
                sendOne(G, pl, function (bs) { fillListRemove(bs, other); });
                sendOne(G, pl, function (bs) { fillListAdd(bs, other, skin); });
                sendOne(G, pl, function (bs) { fillPlayerSkin(bs, other, skin); });
            } catch (e) {}
        }
        let myName = playerData[pl.xuid];
        if (myName) {
            // URL 皮肤如果本地缓存没了(换服/清过缓存)，补下一次再套
            if (isUrl(myName) && !loadSkin(myName)) {
                ensureUrlSkin(myName, function (ok) { if (ok) applySkin(pl, myName); });
            } else {
                applySkin(pl, myName);
            }
        }
    }, 1000);
});


// ==================== 假人展示(GMLIB) ====================
// 用 GMLIB 二进制流给执行命令的玩家发 AddPlayer，造一个纯客户端假人，不占服务器实体
// 给假人发个不会跟真实体撞的 id
let fakeIdCounter = 0;
function genFakeId() { fakeIdCounter++; return 1000000000 + fakeIdCounter; }

function randomUuidStr() {
    let h = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 32; i++) {
        if (i === 12) s += "4";
        else if (i === 16) s += h.charAt((Math.random() * 4 | 0) + 8);
        else s += h.charAt(Math.random() * 16 | 0);
    }
    return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20);
}

const SHOW_DURATION_MS = 20000;
// 一个玩家同时只摆一个假人，记着好回收
let activeShows = {}; // 玩家 xuid -> { uuid, id, timer }

// 把之前摆的假人收掉：发个 RemoveActor 删实体，再把它从玩家列表抹掉
function clearShow(player) {
    let info = activeShows[player.xuid];
    if (!info) return;
    delete activeShows[player.xuid];
    if (info.timer) { try { clearTimeout(info.timer); } catch (e) {} }
    let G = getGMLIB();
    if (!G) return;
    try {
        let rm = new G.GMLIB_BinaryStream();
        rm.writePacketHeader(/* RemoveActor */ 14);
        rm.writeVarInt64(info.id);
        rm.sendTo(player);

        let lr = new G.GMLIB_BinaryStream();
        lr.writePacketHeader(/* PlayerList */ 63);
        lr.writeByte(1);
        lr.writeUnsignedVarInt(1);
        lr.writeUuid(info.uuid);
        lr.sendTo(player);
    } catch (e) {}
}

function showSkin(player, skinName) {
    let skin = loadSkin(skinName);
    let G = getGMLIB();
    if (!skin || !G) return false;

    clearShow(player);

    let uuid = randomUuidStr();
    let id = genFakeId();
    let name = "§e[皮肤展示] " + skinName;

    // 算个站在玩家正前方两格、并且回头看着玩家的位置
    let pos = player.pos;
    let yaw = player.direction ? player.direction.yaw : 0;
    let yawRad = yaw * Math.PI / 180;
    let fx = pos.x - Math.sin(yawRad) * 2.0;
    let fz = pos.z + Math.cos(yawRad) * 2.0;
    let fy = pos.y;
    let faceYaw = yaw + 180;

    try {
        // 1) PlayerList ADD：先让客户端知道这个 UUID 的皮肤
        let bs = new G.GMLIB_BinaryStream();
        bs.writePacketHeader(/* PlayerList */ 63);
        bs.writeByte(0);
        bs.writeUnsignedVarInt(1);
        bs.writeUuid(uuid);
        bs.writeVarInt64(id);
        bs.writeString(name);
        bs.writeString("");        // XUID
        bs.writeString("");        // Platform Chat Id
        bs.writeSignedInt(-1);     // Build Platform
        writeSkinStruct(bs, skin);
        bs.writeBool(false);       // Is Teacher
        bs.writeBool(false);       // Is Host
        bs.writeBool(false);       // Is SubClient
        bs.writeUnsignedInt(0xFFFFFFFF); // Player Color
        bs.writeBool(true);        // Trusted Skin List
        bs.sendTo(player);

        // 2) AddPlayer：在玩家面前生成假人实体
        let ap = new G.GMLIB_BinaryStream();
        ap.writePacketHeader(/* AddPlayer */ 12);
        ap.writeUuid(uuid);
        ap.writeString(name);
        ap.writeUnsignedVarInt64(id); // Target Runtime ID
        ap.writeString("");           // Platform Chat Id
        ap.writeFloat(fx); ap.writeFloat(fy); ap.writeFloat(fz);  // Position
        ap.writeFloat(0); ap.writeFloat(0); ap.writeFloat(0);     // Velocity
        ap.writeFloat(0);             // Rotation pitch
        ap.writeFloat(faceYaw);       // Rotation yaw
        ap.writeFloat(faceYaw);       // Y-Head Rotation
        ap.writeVarInt(0);            // Carried Item：空物品
        ap.writeVarInt(0);            // Player Game Type：生存
        ap.writeUnsignedVarInt(0);    // 实体元数据：0 条
        ap.writeUnsignedVarInt(0);    // PropertySyncData：int 0 条
        ap.writeUnsignedVarInt(0);    // PropertySyncData：float 0 条
        ap.writeSignedInt64(id);      // SerializedAbilitiesData: Target Player Raw Id
        ap.writeByte(0);              // Player Permissions
        ap.writeByte(0);              // Command Permissions
        ap.writeByte(1);              // 能力层数：1
        ap.writeUnsignedShort(1);     // SerializedLayer 类型：Base
        ap.writeUnsignedInt(0);       // AbilitiesSet
        ap.writeUnsignedInt(0);       // AbilityValues
        ap.writeFloat(0.05);          // FlySpeed
        ap.writeFloat(0.05);          // VerticalFlySpeed
        ap.writeFloat(0.1);           // WalkSpeed
        ap.writeUnsignedVarInt(0);    // Actor Links：0 条
        ap.writeString("");           // Device Id
        ap.writeSignedInt(-1);        // Build Platform
        ap.sendTo(player);
    } catch (e) {
        logger.error("展示皮肤失败: " + e);
        return false;
    }

    let timer = setTimeout(function () { clearShow(player); }, SHOW_DURATION_MS);
    activeShows[player.xuid] = { uuid: uuid, id: id, timer: timer };
    return true;
}

// 玩家退出时清掉展示记录(假人随客户端断开自动消失)
mc.listen("onLeft", function (pl) {
    let info = activeShows[pl.xuid];
    if (info) {
        if (info.timer) { try { clearTimeout(info.timer); } catch (e) {} }
        delete activeShows[pl.xuid];
    }
});


// ==================== 命令 ====================
mc.listen("onServerStarted", function () {
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
    cmd.setCallback(function (_c, _ori, out, res) {
        // 命令本身已是 GameMasters 权限，这里再兜一道：玩家执行的必须是 OP，后台(无 player)放行
        let executor = _ori.player;
        if (executor && !executor.isOP()) return out.error("§c你没权限用这个命令");
        switch (res.action) {
            case "list": {
                let s = listSkins();
                return out.success("§e可用皮肤(" + s.length + ")：§f" + (s.join(", ") || "无"));
            }
            case "reload": {
                clearSkinCache();
                loadData();
                reapplyAll();
                return out.success("§a已重新扫描皮肤目录并重发");
            }
            case "set": {
                let targets = res.target;
                if (!targets || !targets.length) return out.error("§c没找到目标玩家");
                let nameOrUrl = res.skinName;
                // URL 皮肤：要先异步下载，下好了再套；命令先即时回个"下载中"
                if (isUrl(nameOrUrl)) {
                    if (!isSafeUrl(nameOrUrl)) return out.error("§cURL 不合法或含特殊字符");
                    let xuids = [];
                    for (let i = 0; i < targets.length; i++) xuids.push(targets[i].xuid);
                    out.success("§e正在下载 URL 皮肤，请稍候…");
                    ensureUrlSkin(nameOrUrl, function (ok, err) {
                        if (!ok) {
                            if (executor) { try { executor.tell("§cURL 皮肤下载失败：" + err); } catch (e) {} }
                            else logger.error("URL 皮肤下载失败：" + err);
                            return;
                        }
                        let n = 0;
                        for (let i = 0; i < xuids.length; i++) {
                            let p = getOnlineByXuid(xuids[i]);
                            if (p && applySkin(p, nameOrUrl)) { playerData[xuids[i]] = nameOrUrl; n++; }
                        }
                        saveData();
                        cleanupUrlCache(nameOrUrl);
                        let msg = "§a已给 " + n + " 个玩家设置 URL 皮肤";
                        if (executor) { try { executor.tell(msg); } catch (e) {} } else logger.info("" + msg);
                    });
                    return;
                }
                if (!loadSkin(nameOrUrl)) return out.error("§c没有这个皮肤：" + nameOrUrl);
                let n = 0;
                for (let i = 0; i < targets.length; i++) {
                    if (applySkin(targets[i], nameOrUrl)) {
                        playerData[targets[i].xuid] = nameOrUrl;
                        n++;
                    }
                }
                saveData();
                return out.success("§a已给 " + n + " 个玩家设置皮肤：" + nameOrUrl);
            }
            case "clear": {
                let targets = res.target;
                if (!targets || !targets.length) return out.error("§c没找到目标玩家");
                // 优先：开了内存功能就读原皮直接发包还原(瞬间变回原皮)；
                // 没开/读失败再退而求其次：有 skins/default 就套默认皮，否则等玩家重进。
                let hasDefault = !!loadSkin(DEFAULT_SKIN_NAME);
                let restored = 0, fellBack = 0;
                for (let i = 0; i < targets.length; i++) {
                    delete playerData[targets[i].xuid];
                    if (restoreRealSkin(targets[i])) { restored++; continue; }
                    if (hasDefault && applySkin(targets[i], DEFAULT_SKIN_NAME)) fellBack++;
                }
                saveData();
                if (restored > 0) return out.success("§a已清除，其中 " + restored + " 个发包还原了原皮，其余 " + fellBack + " 个套默认皮/等重进");
                if (hasDefault) return out.success("§a已清除并发包恢复默认皮肤(" + fellBack + "/" + targets.length + ")");
                return out.success("§a已清除记录，对应玩家重新进服后变回原皮肤(开启 ENABLE_MEM_RESTORE 可改成内存读原皮即时还原)");
            }
            case "show": {
                let player = _ori.player;
                if (!player) return out.error("§c这个命令只能玩家执行");
                if (!loadSkin(res.skinName)) return out.error("§c没有这个皮肤：" + res.skinName);
                if (!getGMLIB()) return out.error("§c没装 GMLIB，展示功能用不了");
                if (showSkin(player, res.skinName)) {
                    return out.success("§a已在你面前展示皮肤：" + res.skinName + "（约 " + (SHOW_DURATION_MS / 1000) + " 秒后消失）");
                }
                return out.error("§c展示失败，看后台日志");
            }
            case "symtest": {
                let logFn = function (s) {
                    if (executor) { try { executor.tell(s); } catch (e) {} }
                    logger.info(s.replace(/§./g, ""));
                };
                runSymTest(logFn);
                return out.success("§a符号测试完成，看聊天/后台日志，把结果贴回来");
            }
            default:
                return out.error("§c未知操作");
        }
    });
    cmd.setup();
    logger.info("/skin 命令已注册");
});


// ==================== 导出接口(命名空间 SkinAPI) ====================
// 别的插件 ll.imports("SkinAPI", "xxx") 就能调下面这些
function api_setSkin(player, skinName) {
    if (!player || !skinName) return false;
    // URL 皮肤是异步下载，这里接受请求后台下，下好自动套上并记录，返回 true 表示已受理
    if (isUrl(skinName)) {
        let xuid = player.xuid;
        ensureUrlSkin(skinName, function (ok) {
            if (!ok) return;
            let p = getOnlineByXuid(xuid);
            if (p && applySkin(p, skinName)) { playerData[xuid] = skinName; saveData(); }
            cleanupUrlCache(skinName);
        });
        return true;
    }
    if (!loadSkin(skinName)) return false;
    if (!applySkin(player, skinName)) return false;
    playerData[player.xuid] = skinName;
    saveData();
    return true;
}
function api_applySkin(player, skinName) {
    if (!player || !skinName || !loadSkin(skinName)) return false;
    return applySkin(player, skinName);
}
function api_clearSkin(player) {
    if (!player) return false;
    delete playerData[player.xuid];
    saveData();
    // 优先内存读原皮即时还原；不行再套默认皮，再不行等玩家重进
    if (restoreRealSkin(player)) return true;
    if (loadSkin(DEFAULT_SKIN_NAME)) applySkin(player, DEFAULT_SKIN_NAME);
    return true;
}
function api_showSkin(player, skinName) {
    if (!player || !skinName || !loadSkin(skinName) || !getGMLIB()) return false;
    return showSkin(player, skinName);
}
function api_listSkins() { return listSkins(); }
function api_reload() { clearSkinCache(); loadData(); return true; }

ll.exports(api_setSkin, "SkinAPI", "setSkin");
ll.exports(api_applySkin, "SkinAPI", "applySkin");
ll.exports(api_clearSkin, "SkinAPI", "clearSkin");
ll.exports(api_showSkin, "SkinAPI", "showSkin");
ll.exports(api_listSkins, "SkinAPI", "listSkins");
ll.exports(api_reload, "SkinAPI", "reload");

logger.info("皮肤管理插件已加载");
