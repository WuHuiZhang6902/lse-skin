/// <reference path='helperlib/index.d.ts'/>

/**
 * 皮肤管理插件
 *  - /skin 命令，管理员给玩家设皮肤
 *  - 支持普通皮肤(单张 png)和 4D 皮肤(png + 自定义几何 json)
 *  - 设置会记下来，玩家重进自动补发
 *  - /skin show 用 GMLIB 在面前展示假人皮肤
 *  - /skin mem  实验性：用 ila-lseexport 直接改服务器内存里的皮肤
 *
 * @author 干物社 QQ 2063665699、子沐呀 QQ 1756150362
 */

const PLUGIN_DIR = "./plugins/skin";
const SKINS_DIR = PLUGIN_DIR + "/skins/";
const DATA_PATH = PLUGIN_DIR + "/players.json";

let UPNG = null;
try { UPNG = require("./skin/UPNG.js"); } catch (e) { logger.error("[skin] 加载 UPNG 失败: " + e); }

try { if (!File.exists(SKINS_DIR)) File.mkdir(SKINS_DIR); } catch (e) {}


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
    let img = UPNG.decode(content);
    return { width: img.width, height: img.height, data: UPNG.toRGBA8(img)[0] };
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
        logger.warn("[skin] " + name + " 目录里没找到能识别的 geometry，按普通皮肤处理");
    }

    let result = {
        width: img.width, height: img.height, data: img.data,
        geometryName: geometryName, geometryData: geometryData,
        geometryEngineVersion: geometryEngineVersion
    };
    skinCache[name] = result;
    return result;
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
    catch (e) { logger.error("[skin] 加载 GMLIB 失败，皮肤发包用不了: " + e); GMLIB = null; }
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


// ==================== 套皮肤(发包) ====================
// 给在线玩家发 PlayerSkin 立即刷新，再走一遍 PlayerList(移除+添加)把列表里的皮肤也改掉。
// 在线的人马上看到新皮肤，新玩家进服也能从玩家列表拿到正确皮肤
function applySkin(target, skinName) {
    let skin = loadSkin(skinName);
    if (!skin) return false;
    let G = getGMLIB();
    if (!G) { logger.error("[skin] 没装 GMLIB，发不了皮肤包"); return false; }
    try {
        sendAll(G, function (bs) { fillPlayerSkin(bs, target, skin); });
        sendAll(G, function (bs) { fillListRemove(bs, target); });
        sendAll(G, function (bs) { fillListAdd(bs, target, skin); });
    } catch (e) {
        logger.error("[skin] 发皮肤包失败: " + e);
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
        if (myName) applySkin(pl, myName);
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
        logger.error("[skin] 展示皮肤失败: " + e);
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


// ==================== 内存改皮肤(实验性) ====================
// 思路：玩家 -> Actor::getLevel -> Level::getPlayerList(unordered_map)
//       按 UUID 找到 PlayerListEntry -> 偏移到 mSkin(SerializedSkin*)
//       把序列化好的皮肤字节塞进手搓的 ReadOnlyBinaryStream，调 SerializedSkin::read 原地换皮
// 全程用 ila-lseexport 的符号调用 + 内存读写，跨版本只改下面 SYM/OFF。
// !!! SYM/OFF 必须用 ShrBox 核对后填好，否则不运行；偏移填错会崩服，先在测试服验证 !!!
let ila = null, ilaTried = false;
function getIla() {
    if (ilaTried) return ila;
    ilaTried = true;
    try { ila = require("plugins/iListenAttentively-LseExport/lib/iListenAttentively.js"); }
    catch (e) { logger.error("[skin] 加载 iListenAttentively 失败: " + e); ila = null; }
    return ila;
}

const MEM_SYM = {
    // ll::service::bedrock::getLevel() -> optional_ref<Level>(里面就一个 Level*，直接当 Level* 用)，自由函数无 this
    getLevel: "?getLevel@bedrock@service@ll@@YA?AV?$optional_ref@VLevel@@@@XZ_0",
    // Level::getPlayerList() -> unordered_map<mce::UUID, PlayerListEntry> const&
    getPlayerList: "?getPlayerList@Level@@QEBAAEBV?$unordered_map@VUUID@mce@@VPlayerListEntry@@U?$hash@VUUID@mce@@@std@@U?$equal_to@VUUID@mce@@@5@V?$allocator@U?$pair@$$CBVUUID@mce@@VPlayerListEntry@@@std@@@5@@std@@XZ",
    // SerializedSkinImpl::read(ReadOnlyBinaryStream&) -> Bedrock::Result<void>(返回值走 sret)
    serializedSkinRead: "?read@SerializedSkinImpl@@QEAA?AV?$Result@XVerror_code@std@@@Bedrock@@AEAVReadOnlyBinaryStream@@@Z"
};
const MEM_OFF = {
    mapListHead: 0x00,     // MSVC unordered_map 首地址就是内部 std::list 的 _Myhead(哨兵指针)
    listNodeValue: 0x10,   // list 节点 _Next(8)+_Prev(8) 之后才是 value
    pairKeyUuid: 0x00,     // pair<const mce::UUID, PlayerListEntry>：UUID 在前 16 字节(两个小端 uint64: a,b)
    pairValueEntry: 0x10,
    entryMSkin: 0x80,      // PlayerListEntry.mSkin，里面是 shared_ptr，*(entry+0x80) 直接就是 SerializedSkinImpl*
    robsSize: 0x40,        // 手搓 ReadOnlyBinaryStream 的内存大小
    robsViewData: 0x20,    // string_view.data
    robsViewSize: 0x28,    // string_view.size
    robsReadPtr: 0x38,     // mReadPointer
    resultSize: 0x20       // Bedrock::Result<void> 的 sret 返回缓冲(给宽点够用)
};

// 三个符号没填齐就别动内存，免得瞎跑崩服
function memSymbolsReady() {
    return MEM_SYM.getLevel && MEM_SYM.getPlayerList && MEM_SYM.serializedSkinRead;
}

// 一个写进 JS 字节数组的“流”，方法名跟原生 BinaryStream 对齐，直接复用 writeSkinStruct
function byteStream() {
    let buf = [];
    return {
        buf: buf,
        writeUnsignedVarInt: function (v) {
            v = v >>> 0;
            while (v >= 0x80) { buf.push((v & 0x7F) | 0x80); v >>>= 7; }
            buf.push(v);
        },
        writeUnsignedInt: function (v) {
            v = v >>> 0;
            buf.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
        },
        writeUnsignedChar: function (v) { buf.push(v & 0xFF); },
        writeBool: function (b) { buf.push(b ? 1 : 0); },
        writeString: function (s) {
            s = s || "";
            let tmp = [];
            for (let i = 0; i < s.length; i++) {
                let c = s.charCodeAt(i);
                if (c < 0x80) tmp.push(c);
                else if (c < 0x800) tmp.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
                else tmp.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
            }
            this.writeUnsignedVarInt(tmp.length);
            for (let i = 0; i < tmp.length; i++) buf.push(tmp[i]);
        }
    };
}

function serializeSkinBytes(skin) {
    let s = byteStream();
    writeSkinStruct(s, skin);
    // 注意：完整 SerializedSkin::read 末尾可能还有 TrustedSkinFlag(enum)，
    // 如果 read 解析越界，就在这里补一个字节：s.buf.push(1);
    return s.buf;
}

// ll::service::bedrock::getLevel()，自由函数无 this，返回值就是 Level*
function memGetLevel(I) {
    let addr = I.getAddressFromSymbol(MEM_SYM.getLevel);
    if (!addr) { logger.error("[skin] 找不到符号: getLevel"); return 0; }
    return I.dynamicCall(addr, I.NativeType.Pointer, [], []) || 0;
}

// Level::getPlayerList()，this = Level，返回 unordered_map 地址
function memGetPlayerList(I, level) {
    let addr = I.getAddressFromSymbol(MEM_SYM.getPlayerList);
    if (!addr) { logger.error("[skin] 找不到符号: getPlayerList"); return 0; }
    return I.dynamicCall(addr, I.NativeType.Pointer, [I.NativeType.Pointer], [level]) || 0;
}

// 把 uuid 字符串转成 mce::UUID 在内存里的 16 字节(两个小端 uint64: 前半=a，后半=b)
function uuidToMemBytes(uuid) {
    let hex = uuid.replace(/-/g, "");
    function le8(h) {
        let b = [];
        for (let i = 0; i < 8; i++) b.push(parseInt(h.substr(i * 2, 2), 16));
        b.reverse(); // 小端
        return b;
    }
    return le8(hex.slice(0, 16)).concat(le8(hex.slice(16, 32)));
}

// 在 map 里按 UUID 找到 PlayerListEntry 首地址。64 位读会丢精度，所以逐字节比
function memFindEntry(I, mapPtr, uuidBytes) {
    let head = I.getUnsignedLongLong(mapPtr + MEM_OFF.mapListHead);
    if (!head) return 0;
    let node = I.getUnsignedLongLong(head);
    let guard = 0;
    while (node && node !== head && guard < 100000) {
        guard++;
        let value = node + MEM_OFF.listNodeValue;
        let match = true;
        for (let i = 0; i < 16; i++) {
            if ((I.getUnsignedChar(value + MEM_OFF.pairKeyUuid + i) & 0xFF) !== uuidBytes[i]) { match = false; break; }
        }
        if (match) return value + MEM_OFF.pairValueEntry;
        node = I.getUnsignedLongLong(node);
    }
    return 0;
}

// 把 skin 写进某玩家服务器端的 mSkin。成功返回 null，失败返回错误说明
function applySkinByRead(player, skin) {
    let I = getIla();
    if (!I) return "iListenAttentively 没装/没加载";
    if (!memSymbolsReady()) return "skin.js 里的 MEM_SYM 还没填(用 ShrBox 核对)";

    let level = memGetLevel(I);
    if (!level) return "getLevel 失败";
    let map = memGetPlayerList(I, level);
    if (!map) return "getPlayerList 失败";

    let entry = memFindEntry(I, map, uuidToMemBytes(player.uuid));
    if (!entry) return "玩家列表里没找到这个 UUID";

    // *(entry+0x80) 直接是 SerializedSkinImpl*，当 read 的 this
    let skinPtr = I.getUnsignedLongLong(entry + MEM_OFF.entryMSkin);
    if (!skinPtr) return "取 SerializedSkinImpl 指针失败";

    let readAddr = I.getAddressFromSymbol(MEM_SYM.serializedSkinRead);
    if (!readAddr) return "找不到 SerializedSkinImpl::read 符号";

    let bytes = serializeSkinBytes(skin);
    let dataAddr = I.mallocMemory(bytes.length);
    if (!dataAddr) return "分配皮肤内存失败";
    let robs = 0, ret = 0;
    try {
        for (let i = 0; i < bytes.length; i++) I.setUnsignedChar(dataAddr + i, bytes[i] & 0xFF);

        // 手搓一个 ReadOnlyBinaryStream：清零(空 owned string + 各种 0)，再把 string_view 指向皮肤字节
        robs = I.mallocMemory(MEM_OFF.robsSize);
        if (!robs) return "分配流内存失败";
        I.memsetMemory(robs, 0, MEM_OFF.robsSize);
        I.setUnsignedLongLong(robs + MEM_OFF.robsViewData, dataAddr);
        I.setUnsignedLongLong(robs + MEM_OFF.robsViewSize, bytes.length);
        I.setUnsignedLongLong(robs + MEM_OFF.robsReadPtr, 0);

        // read 返回 Bedrock::Result<void>(>8字节)，MSVC 走 sret：第一个参数是隐藏返回指针
        ret = I.mallocMemory(MEM_OFF.resultSize);
        if (!ret) return "分配返回缓冲失败";
        I.memsetMemory(ret, 0, MEM_OFF.resultSize);
        I.dynamicCall(readAddr, I.NativeType.Pointer,
            [I.NativeType.Pointer, I.NativeType.Pointer, I.NativeType.Pointer],
            [ret, skinPtr, robs]);
    } catch (e) {
        return "read 调用异常: " + e;
    } finally {
        try { if (ret) I.freeMemory(ret); } catch (e) {}
        try { if (robs) I.freeMemory(robs); } catch (e) {}
        try { I.freeMemory(dataAddr); } catch (e) {}
    }

    // 服务器端皮肤已改，再给在线玩家发包刷新一下，让大家立刻看到
    try {
        let G = getGMLIB();
        if (G) {
            sendAll(G, function (bs) { fillPlayerSkin(bs, player, skin); });
            sendAll(G, function (bs) { fillListRemove(bs, player); });
            sendAll(G, function (bs) { fillListAdd(bs, player, skin); });
        }
    } catch (e) {}
    return null;
}


// ==================== 命令 ====================
mc.listen("onServerStarted", function () {
    let cmd = mc.newCommand("skin", "皮肤管理", PermType.GameMasters);
    cmd.setEnum("ActSet", ["set"]);
    cmd.setEnum("ActClear", ["clear"]);
    cmd.setEnum("ActList", ["list"]);
    cmd.setEnum("ActReload", ["reload"]);
    cmd.setEnum("ActShow", ["show"]);
    cmd.setEnum("ActMem", ["mem"]);
    cmd.mandatory("action", ParamType.Enum, "ActSet", 1);
    cmd.mandatory("action", ParamType.Enum, "ActClear", 1);
    cmd.mandatory("action", ParamType.Enum, "ActList", 1);
    cmd.mandatory("action", ParamType.Enum, "ActReload", 1);
    cmd.mandatory("action", ParamType.Enum, "ActShow", 1);
    cmd.mandatory("action", ParamType.Enum, "ActMem", 1);
    cmd.mandatory("target", ParamType.Player);
    cmd.mandatory("skinName", ParamType.RawText);
    cmd.overload(["ActSet", "target", "skinName"]);
    cmd.overload(["ActClear", "target"]);
    cmd.overload(["ActList"]);
    cmd.overload(["ActReload"]);
    cmd.overload(["ActShow", "skinName"]);
    cmd.overload(["ActMem", "target", "skinName"]);
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
                if (!loadSkin(res.skinName)) return out.error("§c没有这个皮肤：" + res.skinName);
                let n = 0;
                for (let i = 0; i < targets.length; i++) {
                    if (applySkin(targets[i], res.skinName)) {
                        playerData[targets[i].xuid] = res.skinName;
                        n++;
                    }
                }
                saveData();
                return out.success("§a已给 " + n + " 个玩家设置皮肤：" + res.skinName);
            }
            case "clear": {
                let targets = res.target;
                if (!targets || !targets.length) return out.error("§c没找到目标玩家");
                for (let i = 0; i < targets.length; i++) delete playerData[targets[i].xuid];
                saveData();
                return out.success("§a已清除记录，对应玩家重新进服后恢复原皮肤");
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
            case "mem": {
                let targets = res.target;
                if (!targets || !targets.length) return out.error("§c没找到目标玩家");
                let skin = loadSkin(res.skinName);
                if (!skin) return out.error("§c没有这个皮肤：" + res.skinName);
                let n = 0, lastErr = null;
                for (let i = 0; i < targets.length; i++) {
                    let err = applySkinByRead(targets[i], skin);
                    if (err) lastErr = err; else n++;
                }
                if (n > 0) return out.success("§a内存改皮肤成功 " + n + " 个" + (lastErr ? "（部分失败：" + lastErr + "）" : ""));
                return out.error("§c失败：" + (lastErr || "未知"));
            }
            default:
                return out.error("§c未知操作");
        }
    });
    cmd.setup();
    logger.info("[skin] /skin 命令已注册");
});


// ==================== 导出接口(命名空间 SkinAPI) ====================
// 别的插件 ll.imports("SkinAPI", "xxx") 就能调下面这些
function api_setSkin(player, skinName) {
    if (!player || !skinName || !loadSkin(skinName)) return false;
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
    return true;
}
function api_showSkin(player, skinName) {
    if (!player || !skinName || !loadSkin(skinName) || !getGMLIB()) return false;
    return showSkin(player, skinName);
}
function api_setSkinByMemory(player, skinName) {
    let skin = loadSkin(skinName);
    if (!player || !skin) return "参数错误或皮肤不存在";
    return applySkinByRead(player, skin) || "";
}
function api_listSkins() { return listSkins(); }
function api_reload() { clearSkinCache(); loadData(); return true; }

ll.exports(api_setSkin, "SkinAPI", "setSkin");
ll.exports(api_applySkin, "SkinAPI", "applySkin");
ll.exports(api_clearSkin, "SkinAPI", "clearSkin");
ll.exports(api_showSkin, "SkinAPI", "showSkin");
ll.exports(api_setSkinByMemory, "SkinAPI", "setSkinByMemory");
ll.exports(api_listSkins, "SkinAPI", "listSkins");
ll.exports(api_reload, "SkinAPI", "reload");

logger.info("[skin] 皮肤管理插件已加载");
