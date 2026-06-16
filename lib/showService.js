/**
 * 假人皮肤展示：用 GMLIB 给执行命令的玩家发 AddPlayer，造一个纯客户端假人(不占服务器实体)，
 * 站在玩家正前方两格、回头看着他，过一会自动收掉。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");
const proto = imp("./protocol.js", "./skin/lib/protocol.js");
const skins = imp("./skins.js", "./skin/lib/skins.js");
const PKT = config.PKT;

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

// 一个玩家同时只摆一个假人，记着好回收
let activeShows = {}; // 玩家 xuid -> { uuid, id, timer, light }

// 算最亮 light_block(光照15) 的 runtimeId，取一次缓存住。
// 带光照值取不到就退回不带值的(部分版本只认无参)，跟 DynamicLights 一样兜一层
let lightRid = null;
function getLightRid() {
    if (lightRid !== null) return lightRid;
    let g = gmlib.get();
    lightRid = 0;
    try {
        if (g && g.Minecraft) {
            lightRid = g.Minecraft.getBlockRuntimeId("minecraft:light_block", 15)
                || g.Minecraft.getBlockRuntimeId("minecraft:light_block") || 0;
        }
    } catch (e) { lightRid = 0; logger.warn("取 light_block runtimeId 失败: " + e); }
    if (!lightRid) logger.warn("light_block runtimeId=0，光源方块发不出去(可能 GMLIB 版本不支持)");
    return lightRid;
}

// 给某玩家发一个 UpdateBlock 包(纯客户端可视，不动服务器真实方块)。
// 用 LSE 原生 BinaryStream + sendPacket，跟 DynamicLights 一致(已验证可用)
function sendBlock(player, x, y, z, runtimeId) {
    try {
        let bs = new BinaryStream();
        bs.writeVarInt(x);
        bs[mc.getServerProtocolVersion() >= 944 ? "writeVarInt" : "writeUnsignedVarInt"](y);
        bs.writeVarInt(z);
        bs.writeUnsignedVarInt(Number(runtimeId));
        bs.writeUnsignedVarInt(0); // layer: Standard
        bs.writeUnsignedVarInt(0); // updateFlags: None
        player.sendPacket(bs.createPacket(0x15)); // UpdateBlock
    } catch (e) { logger.warn("发光源方块失败: " + e); }
}

// 把之前摆的假人收掉：发 RemoveActor 删实体，再把它从玩家列表抹掉
function clearShow(player) {
    let info = activeShows[player.xuid];
    if (!info) return;
    delete activeShows[player.xuid];
    if (info.timer) { try { clearTimeout(info.timer); } catch (e) {} }
    if (!gmlib.get()) return;
    try {
        let rm = gmlib.newStream();
        rm.writePacketHeader(PKT.REMOVE_ACTOR);
        rm.writeVarInt64(info.id);
        rm.sendTo(player);

        let lr = gmlib.newStream();
        proto.writeListRemove(lr, info.uuid);
        lr.sendTo(player);

        // 把临时光源方块还原回原来的方块
        if (info.light) {
            try { sendBlock(player, info.light.x, info.light.y, info.light.z, info.light.rid); } catch (e) {}
        }
    } catch (e) {}
}

function showSkin(player, skinName) {
    let skin = skins.loadSkin(skinName);
    if (!skin || !gmlib.get()) return false;

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
    // player.pos 是视线(眼睛)高度，AddPlayer 的 Position 当作假人脚底，差一个站立眼高(≈1.62)，
    // 不减的话假人脚底会落在玩家眼睛处，看着比玩家高
    let fy = pos.y - 1.62;
    let faceYaw = yaw + 180;

    try {
        // 1) PlayerList ADD：先让客户端知道这个 UUID 的皮肤
        let bs = gmlib.newStream();
        proto.writeListAdd(bs, { uuid: uuid, actorId: id, name: name, xuid: "" }, function (s) { proto.writeSkinStruct(s, skin); });
        bs.sendTo(player);

        // 2) AddPlayer：在玩家面前生成假人实体
        let ap = gmlib.newStream();
        ap.writePacketHeader(PKT.ADD_PLAYER);
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

    // 在假人身体处放一个临时光源方块，把皮肤照亮(只发给该玩家，不改服务器真实方块)
    let light = null;
    let rid = getLightRid();
    if (rid) {
        let bx = Math.floor(fx), by = Math.floor(fy) + 1, bz = Math.floor(fz);
        let origRid = rid;
        try {
            let dim = (pos.dimid !== undefined) ? pos.dimid : 0;
            let blk = mc.getBlock(mc.newIntPos(bx, by, bz, dim));
            let g = gmlib.get();
            if (blk && g && g.Minecraft) origRid = g.Minecraft.getBlockRuntimeId(blk.type, blk.tileData || 0);
        } catch (e) {}
        try { sendBlock(player, bx, by, bz, rid); light = { x: bx, y: by, z: bz, rid: origRid }; } catch (e) {}
    }

    let timer = setTimeout(function () { clearShow(player); }, config.SHOW_DURATION_MS);
    activeShows[player.xuid] = { uuid: uuid, id: id, timer: timer, light: light };
    return true;
}

// 玩家退出时清掉展示记录(假人随客户端断开自动消失)
function onPlayerLeft(pl) {
    let info = activeShows[pl.xuid];
    if (info) {
        if (info.timer) { try { clearTimeout(info.timer); } catch (e) {} }
        delete activeShows[pl.xuid];
    }
}

module.exports = {
    showSkin: showSkin,
    clearShow: clearShow,
    onPlayerLeft: onPlayerLeft
};
