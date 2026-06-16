/**
 * 内存读「真实皮肤」(可选，默认关，见 config.ENABLE_MEM_RESTORE)。
 *
 * 发包换肤只改客户端、不动服务器内存，所以服务器里存的一直是玩家上传的「原皮」。
 * 这里用 ila 把原皮序列化成字节，/clear 时直接发回去 => 瞬间还原原皮，不用提前存盘。
 *
 * !! 风险 !! 全是裸内存操作，偏移/符号错了会硬崩(0xC0000005/0xC0000409)，JS 的 try/catch
 *    拦不住这种崩溃。所以默认关着，先在测试服把开关打开验证没问题，再上线。
 * 流程：getLevel -> getPlayerList -> 定位玩家 -> SerializedSkinImpl::write 序列化原皮，
 *      再用 getString(addr,true) 以 base64 无损读出字节(ila 新增 base64 参数)。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");
const gmlib = imp("./gmlib.js", "./skin/lib/gmlib.js");

// 符号(MCAPI 真符号，已在本服 /skin symtest 验证可解析)
const SYM = {
    // ll::service::getLevel() -> optional_ref<Level>  (在 LeviLamina.dll)
    getLevel: "?getLevel@bedrock@service@ll@@YA?AV?$optional_ref@VLevel@@@@XZ",
    // Level::getPlayerList() const -> unordered_map<UUID,PlayerListEntry> const&
    getPlayerList: "?getPlayerList@Level@@QEBAAEBV?$unordered_map@VUUID@mce@@VPlayerListEntry@@U?$hash@VUUID@mce@@@std@@U?$equal_to@VUUID@mce@@@5@V?$allocator@U?$pair@$$CBVUUID@mce@@VPlayerListEntry@@@std@@@5@@std@@XZ",
    // SerializedSkinImpl::write(BinaryStream&) const -> void
    skinImplWrite: "?write@SerializedSkinImpl@@QEBAXAEAVBinaryStream@@@Z",
    // BinaryStream::BinaryStream(std::string& buf, bool copyBuffer)  (让 C++ 自己设 vptr)
    bsCtor: "??0BinaryStream@@QEAA@AEAV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@_N@Z"
};
// ila 符号表里同名符号可能带 _0/_1 去重后缀，const 成员有时按虚函数(U)收录，
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
    try {
        try { ila = require("../../iListenAttentively-LseExport/lib/iListenAttentively.js"); }
        catch (e) { ila = require("./iListenAttentively-LseExport/lib/iListenAttentively.js"); }
    }
    catch (e) { ila = null; }
    return ila;
}

const NT = (function () { let I = getIla(); return I ? I.NativeType : null; })();

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

// base64 -> 字节数组(纯 JS，无损)。把 getString(addr,true) 读出的 base64 还原成原始字节。
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
let ctorEnc = -1; // 缓存可用的构造参数编码下标，省掉每次重试失败编码的 dynamicCall
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
        // this=bs, arg1=std::string& buf, arg2=copyBuffer=false。bool 参数 ila 接受形式不确定，挨个试编码
        let attempts = [
            { t: [NT.Pointer, NT.Pointer, NT.Bool], v: [bs, buf, false] },
            { t: [NT.Pointer, NT.Pointer, NT.Bool], v: [bs, buf, 0] },
            { t: [NT.Pointer, NT.Pointer, NT.UnsignedChar], v: [bs, buf, 0] },
            { t: [NT.Pointer, NT.Pointer, NT.Int], v: [bs, buf, 0] }
        ];
        let ok = false, lastErr = null;
        if (ctorEnc >= 0) {
            try { I.dynamicCall(ctor, NT.Pointer, attempts[ctorEnc].t, attempts[ctorEnc].v); ok = true; }
            catch (e) { ctorEnc = -1; }
        }
        for (let a = 0; !ok && a < attempts.length; a++) {
            try { I.dynamicCall(ctor, NT.Pointer, attempts[a].t, attempts[a].v); ok = true; ctorEnc = a; break; }
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
function memFindSkinImpl(I, mapPtr, xuid) {
    let head = I.getRawAddress(mapPtr + MAP.listHead);
    let count = I.getUnsignedLongLong(mapPtr + MAP.count) || 0;
    if (config.MEM_DEBUG) logger.warn("mem: head=" + (head ? head.toString(16) : 0) + " count=" + count + " 目标xuid=" + xuid);
    if (!looksLikePtr(head) || count <= 0 || count > 5000) return 0;
    let node = I.getRawAddress(head + MAP.nodeNext); // sentinel.next = 第一个真实结点
    let guard = 0;
    while (looksLikePtr(node) && node !== head && guard <= count + 1) {
        guard++;
        let entry = node + MAP.nodeValue + MAP.entryOff;
        let xs = readStdStr(I, entry + MAP.xuidOff);
        if (config.MEM_DEBUG) logger.warn("mem: 结点#" + guard + " entry=" + entry.toString(16) + " xuid='" + xs + "'");
        if (xs === xuid) {
            let impl = I.getRawAddress(entry + MAP.skinOff);
            if (config.MEM_DEBUG) logger.warn("mem: 命中! impl=" + (impl ? impl.toString(16) : 0));
            return looksLikePtr(impl) ? impl : 0;
        }
        node = I.getRawAddress(node + MAP.nodeNext);
    }
    if (config.MEM_DEBUG) logger.warn("mem: 遍历完没匹配到 xuid");
    return 0;
}

// 读玩家当前「真实皮肤」的线格式字节(失败返回 null)。开关关着时永不进内存。
function readRealSkinBytes(player) {
    if (!config.ENABLE_MEM_RESTORE) return null;
    let I = getIla();
    if (!I || !NT) { memWarn("没装 iListenAttentively-LseExport"); return null; }

    let writeAddr = symAddr(I, "skinImplWrite");
    if (!looksLikePtr(writeAddr)) { memWarn("符号解析失败(SerializedSkinImpl::write)"); return null; }
    if (!player || !player.xuid) return null;

    let stream = null;
    try {
        let level = memGetLevel(I);
        if (config.MEM_DEBUG) logger.warn("mem: level=" + (level ? level.toString(16) : 0));
        if (!level) { memWarn("getLevel 失败"); return null; }
        let map = memGetPlayerList(I, level);
        if (config.MEM_DEBUG) logger.warn("mem: map=" + (map ? map.toString(16) : 0));
        if (!map) { memWarn("getPlayerList 失败"); return null; }
        let impl = memFindSkinImpl(I, map, player.xuid);
        if (!impl) return null; // 没在列表里找到该玩家，或皮肤指针为空

        stream = makeStream(I);
        if (!stream) { memWarn("构造 BinaryStream 失败"); return null; }

        // SerializedSkinImpl::write(this=impl, &bs) -> 序列化原皮(字节落在外部 buf，copyBuffer=false)
        I.dynamicCall(writeAddr, NT.Void, [NT.Pointer, NT.Pointer], [impl, stream.bs]);

        let size = I.getUnsignedLongLong(stream.buf + STR.sizeOff) || 0;
        if (size <= 0 || size > 4000000) { if (config.MEM_DEBUG) logger.warn("mem: size 异常=" + size); return null; }
        let b64 = I.getString(stream.buf, true);
        let bytes = b64ToBytes(b64);
        if (config.MEM_DEBUG) logger.warn("mem: size=" + size + " b64.len=" + (b64 ? b64.length : "null") + " 解码字节数=" + (bytes ? bytes.length : "null"));
        if (!bytes || bytes.length !== size) { if (config.MEM_DEBUG) logger.warn("mem: 解码字节数与 size 不符，放弃发包"); return null; }
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

// 等长原地替换 SkinId：开头是 SkinId(varint长度L + L字节)。换肤要求每次 id 不同，否则客户端判重。
// 生成一个同样 L 长的新 id，原地覆盖，并扫描整段把所有相同 id 字节序列一并替换(FullSkinId 若相同也换到)。
// 不改长度、不解析复杂结构，persona/动画皮肤都安全。
function replaceSkinIdInPlace(raw) {
    let pos = 0, idLen = 0, shift = 0, lenBytes = 0;
    while (pos < raw.length) {
        let b = raw[pos++]; lenBytes++;
        idLen |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    idLen = idLen >>> 0;
    if (idLen <= 0 || idLen > 256 || lenBytes + idLen > raw.length) return raw; // 异常，原样返回
    let idStart = pos;
    let oldId = new Uint8Array(idLen);
    for (let i = 0; i < idLen; i++) oldId[i] = raw[idStart + i];
    let chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let newId = new Uint8Array(idLen);
    for (let i = 0; i < idLen; i++) newId[i] = chars.charCodeAt(Math.floor(Math.random() * chars.length));
    let out = new Uint8Array(raw.length);
    out.set(raw, 0);
    let replaced = 0;
    let i = 0;
    while (i + idLen <= out.length) {
        let m = true;
        for (let j = 0; j < idLen; j++) { if (out[i + j] !== oldId[j]) { m = false; break; } }
        if (m) {
            for (let j = 0; j < idLen; j++) out[i + j] = newId[j];
            replaced++;
            i += idLen;
        } else {
            i++;
        }
    }
    if (config.SKIN_DEBUG) logger.warn("reskin: 原地替换 idLen=" + idLen + " 替换处数=" + replaced + " len=" + out.length);
    return out;
}

// 诊断：把候选符号挨个丢给 ila，看哪个能解析出合法地址，结果回调打日志。/skin symtest 触发。
function runSymTest(logFn) {
    let I = getIla();
    if (!I) { logFn("§c没装/没加载 iListenAttentively-LseExport"); return; }
    let probes = {
        "writeRawBytes#a": "?writeRawBytes@BinaryStream@@QEAAXVbuffer_span@@PEBD1@Z",
        "writeRawBytes#b": "?writeRawBytes@BinaryStream@@QEAAXVbuffer_span@@PEBD0@Z",
        "writeRawBytes#c": "?writeRawBytes@BinaryStream@@QEAAX?$buffer_span@$$CBD@@PEBD1@Z",
        "BinaryStream::ctor(string&,bool)": SYM.bsCtor
    };
    for (let label in probes) {
        if (!Object.prototype.hasOwnProperty.call(probes, label)) continue;
        let cands = symCandidates(probes[label]);
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
        let s = gmlib.newStream();
        if (s) {
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

module.exports = {
    readRealSkinBytes: readRealSkinBytes,
    replaceSkinIdInPlace: replaceSkinIdInPlace,
    runSymTest: runSymTest
};
