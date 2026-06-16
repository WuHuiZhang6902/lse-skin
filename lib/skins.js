/**
 * 皮肤加载与 URL 工具。
 *  - 单张 png        => 普通 2D 皮肤
 *  - 文件夹(png+json) => 4D 皮肤(带自定义几何)
 *  - http(s) URL     => 下载到 .urlcache/ 后当普通 2D 皮肤读
 * 读过的皮肤缓存住，别每次发包都翻硬盘。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const config = imp("./config.js", "./skin/lib/config.js");

let UPNG = null;
try { UPNG = imp("../UPNG.js", "./skin/UPNG.js"); } catch (e) { logger.error("加载 UPNG 失败: " + e); }

const cache = {};

function clearCache() {
    for (let k in cache) {
        if (Object.prototype.hasOwnProperty.call(cache, k)) delete cache[k];
    }
}
// 让某个皮肤下次重新从磁盘读(URL 重新下载后用)
function invalidate(name) { delete cache[name]; }

// ==================== URL 工具 ====================
function isUrl(s) { return typeof s === "string" && /^https?:\/\//i.test(s); }

// 命令执行者是 OP/控制台，但 URL 还是要过滤掉能拆 shell 命令的字符，免得拼 curl 时出岔子
function isSafeUrl(s) {
    if (!isUrl(s)) return false;
    if (s.length > 1024) return false;
    return !/[\s"'`\\^<>|;]/.test(s);
}

// 按 URL 算个稳定 hash 当临时文件名(djb2)，扩展名用 .urltmp 避免被 listSkins 当成皮肤列出
function urlCacheName(url) {
    let h = 5381;
    for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
    return ".urltmp_" + h.toString(16) + ".urltmp";
}
function urlCachePath(url) { return config.URL_TMP_DIR + urlCacheName(url); }

// 套上 URL 皮肤后把下载的临时图删掉(皮肤已解码进内存 cache，不留缓存)
function cleanupUrlCache(url) {
    try {
        let p = urlCachePath(url);
        if (File.exists(p)) File.delete(p);
    } catch (e) {}
}

// ==================== PNG / 几何 ====================
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
        let d = obj["minecraft:geometry"][0].description;
        if (d.identifier) return { name: d.identifier, data: JSON.stringify(obj), engineVersion: fmt || "1.12.0", texW: d.texture_width || 0, texH: d.texture_height || 0 };
    }
    for (let k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && k.indexOf("geometry.") === 0) {
            let geo = obj[k] || {};
            return { name: k.split(":")[0], data: JSON.stringify(obj), engineVersion: fmt || "0.0.0", texW: geo.texturewidth || 0, texH: geo.textureheight || 0 };
        }
    }
    return null;
}

// ==================== 列举 / 加载 ====================
// 看看 skins/ 目录里有啥能用：一张 png 算一个，一个文件夹也算一个(4D 皮肤)
function listSkins() {
    let result = [];
    let entries;
    try { entries = File.getFilesList(config.SKINS_DIR); } catch (e) { entries = []; }
    if (!entries) return result;
    for (let i = 0; i < entries.length; i++) {
        let e = entries[i];
        if (!e) continue;
        if (e.toLowerCase().endsWith(".png")) result.push(e.slice(0, -4));
        else if (File.checkIsDir(config.SKINS_DIR + e)) result.push(e);
    }
    return result;
}

// 返回 { width, height, data, geometryName, geometryData, geometryEngineVersion }，失败 null
function loadSkin(name) {
    if (!name) return null;
    if (cache[name]) return cache[name];

    // URL 皮肤：图已经下到 .urlcache/ 了，当普通 2D 皮肤读；没下好就返回 null，让调用方先去下
    if (isUrl(name)) {
        let img = decodePng(urlCachePath(name));
        if (!img) return null;
        let r = {
            width: img.width, height: img.height, data: img.data,
            geometryName: "geometry.humanoid.custom", geometryData: "", geometryEngineVersion: "0.0.0"
        };
        cache[name] = r;
        return r;
    }

    let texturePath = null;
    let jsonPaths = [];
    let folder = config.SKINS_DIR + name + "/";
    if (File.exists(folder) && File.checkIsDir(folder)) {
        let files = File.getFilesList(folder) || [];
        for (let i = 0; i < files.length; i++) {
            let lf = files[i].toLowerCase();
            if (lf.endsWith(".png")) texturePath = folder + files[i];
            else if (lf.endsWith(".json")) jsonPaths.push(folder + files[i]);
        }
    } else if (File.exists(config.SKINS_DIR + name + ".png")) {
        texturePath = config.SKINS_DIR + name + ".png";
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
        if (g) {
            geometryName = g.name; geometryData = g.data; geometryEngineVersion = g.engineVersion || "0.0.0";
            // geometry 声明的贴图尺寸必须和实际 png 一致，否则客户端会拒绝整张皮肤(显示史蒂夫)
            if (g.texW && g.texH && (g.texW !== img.width || g.texH !== img.height)) {
                logger.warn("皮肤 " + name + " 尺寸不匹配：png 是 " + img.width + "x" + img.height +
                    "，但 geometry 声明 " + g.texW + "x" + g.texH + "，客户端可能拒绝。请把 png 调成 " + g.texW + "x" + g.texH);
            }
            break;
        }
    }
    if (jsonPaths.length && geometryData === "") {
        logger.warn("" + name + " 目录里没找到能识别的 geometry，按普通皮肤处理");
    }

    let result = {
        width: img.width, height: img.height, data: img.data,
        geometryName: geometryName, geometryData: geometryData,
        geometryEngineVersion: geometryEngineVersion
    };
    cache[name] = result;
    return result;
}

module.exports = {
    clearCache: clearCache,
    invalidate: invalidate,
    isUrl: isUrl,
    isSafeUrl: isSafeUrl,
    urlCacheName: urlCacheName,
    urlCachePath: urlCachePath,
    cleanupUrlCache: cleanupUrlCache,
    decodePng: decodePng,
    parseGeometry: parseGeometry,
    listSkins: listSkins,
    loadSkin: loadSkin
};
