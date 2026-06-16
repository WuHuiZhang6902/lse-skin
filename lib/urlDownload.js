/**
 * URL 皮肤下载：用 curl 把图下到本地 .urlcache/，下好后让皮肤缓存失效以便重新解码。
 * curl Win10+ / Linux 都自带，二进制下到文件最稳(走 http 拿字符串会把 png 字节搞坏)。
 */

function imp(a, b) { try { return require(a); } catch (e) { return require(b); } }
const skins = imp("./skins.js", "./skin/lib/skins.js");

// 同一 URL 并发请求合并，避免重复下载
let inflight = {};

// cb(ok, err)
function ensureUrlSkin(url, cb) {
    if (!skins.isSafeUrl(url)) { cb(false, "URL 不合法或含特殊字符"); return; }
    let dest = skins.urlCachePath(url);
    try {
        if (File.exists(dest) && File.getFileSize(dest) > 0) { cb(true, ""); return; }
    } catch (e) {}

    if (inflight[url]) { inflight[url].push(cb); return; }
    inflight[url] = [cb];

    let finish = function (ok, err) {
        let list = inflight[url] || [];
        delete inflight[url];
        skins.invalidate(url); // 重新解码新下的图
        for (let i = 0; i < list.length; i++) { try { list[i](ok, err); } catch (e) {} }
    };

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

module.exports = {
    ensureUrlSkin: ensureUrlSkin
};
