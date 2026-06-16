/**
 * 基岩版协议序列化。下面这堆是按协议手拼字节，字段顺序错一个后面全乱，别随便挪。
 * 皮肤结构(SerializedSkin)只在这里定义一次，PlayerSkin / PlayerList ADD 都复用，免得改一处漏一处。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");
const PKT = config.PKT;

function randomSkinId() {
    let s = "";
    for (let i = 0; i < 16; i++) {
        let b = Math.floor(Math.random() * 256).toString(16);
        s += b.length === 1 ? "0" + b : b;
    }
    return s + ".CustomSkin";
}

// 写一个完整 SerializedSkin(来自皮肤对象)，SkinId/FullSkinId 用同一个新随机值
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

// 写一段现成的 SerializedSkin 原始字节(内存读出来的原皮用)
function writeRawSkinBytes(stream, raw) {
    for (let i = 0; i < raw.length; i++) stream.writeUnsignedChar(raw[i] & 0xFF);
}

// PlayerSkin：刷新某玩家皮肤，在线的人立即生效。writeSkin(bs) 负责写 SerializedSkin
function writePlayerSkin(bs, uuid, writeSkin) {
    bs.writePacketHeader(PKT.PLAYER_SKIN);
    bs.writeUuid(uuid);
    writeSkin(bs);
    bs.writeString(""); // new skin name
    bs.writeString(""); // old skin name
    bs.writeBool(true);  // trusted
}

// PlayerList REMOVE：把某 UUID 从玩家列表里摘掉
function writeListRemove(bs, uuid) {
    bs.writePacketHeader(PKT.PLAYER_LIST);
    bs.writeByte(1);
    bs.writeUnsignedVarInt(1);
    bs.writeUuid(uuid);
}

// PlayerList ADD：带着皮肤重新加回玩家列表，客户端据此重建外观。
// entry = { uuid, actorId, name, xuid }；writeSkin(bs) 负责写 SerializedSkin
function writeListAdd(bs, entry, writeSkin) {
    bs.writePacketHeader(PKT.PLAYER_LIST);
    bs.writeByte(0);
    bs.writeUnsignedVarInt(1);
    bs.writeUuid(entry.uuid);
    bs.writeVarInt64(entry.actorId);     // Target Actor ID
    bs.writeString(entry.name || "");
    bs.writeString(entry.xuid || "");
    bs.writeString("");        // Platform Chat Id
    bs.writeSignedInt(-1);     // Build Platform
    writeSkin(bs);
    bs.writeBool(false);       // Is Teacher
    bs.writeBool(false);       // Is Host
    bs.writeBool(false);       // Is SubClient
    bs.writeUnsignedInt(0xFFFFFFFF); // Player Color (mce::Color)
    bs.writeBool(true);        // Trusted Skin List
}

// 由玩家对象生成 PlayerList ADD 所需的字段
function entryOfPlayer(player) {
    return {
        uuid: player.uuid,
        actorId: Number(player.uniqueId),
        name: player.realName || player.name || "",
        xuid: player.xuid || ""
    };
}

module.exports = {
    randomSkinId: randomSkinId,
    writeSkinStruct: writeSkinStruct,
    writeRawSkinBytes: writeRawSkinBytes,
    writePlayerSkin: writePlayerSkin,
    writeListRemove: writeListRemove,
    writeListAdd: writeListAdd,
    entryOfPlayer: entryOfPlayer
};
