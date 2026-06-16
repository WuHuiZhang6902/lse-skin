/**
 * 全局常量与开关。
 * 注意：File 路径相对“服务器根目录”，require 路径相对“plugins/ 目录”(LSE-quickjs 约定)。
 */

const PLUGIN_DIR = "./plugins/skin";
const SKINS_DIR = PLUGIN_DIR + "/skins/";
const DATA_PATH = PLUGIN_DIR + "/players.json";
// URL 皮肤下载的临时图就放插件根目录，下好解码进内存后立即删，不留缓存目录
const URL_TMP_DIR = PLUGIN_DIR + "/";
// clear 时若存在这个皮肤(skins/default.png 或文件夹)，就发包套上当“恢复默认”，否则只能等玩家重进
const DEFAULT_SKIN_NAME = "default";

// 基岩版协议包 ID(随版本可能变动，集中放这便于维护)
const PKT = {
    ADD_PLAYER: 12,
    REMOVE_ACTOR: 14,
    UPDATE_BLOCK: 21,
    PLAYER_LIST: 63,
    PLAYER_SKIN: 93
};

// 假人展示存在时长
const SHOW_DURATION_MS = 20000;

// 内存读「真实皮肤」即时还原：纯裸内存操作，风险高(偏移/符号错会硬崩)，默认关。详见 memory.js
const ENABLE_MEM_RESTORE = false;
// 内存读流程的详细日志
const MEM_DEBUG = false;
// 还原流程的调试日志
const SKIN_DEBUG = false;

// 确保目录存在
try { if (!File.exists(SKINS_DIR)) File.mkdir(SKINS_DIR); } catch (e) {}

module.exports = {
    PLUGIN_DIR: PLUGIN_DIR,
    SKINS_DIR: SKINS_DIR,
    DATA_PATH: DATA_PATH,
    URL_TMP_DIR: URL_TMP_DIR,
    DEFAULT_SKIN_NAME: DEFAULT_SKIN_NAME,
    PKT: PKT,
    SHOW_DURATION_MS: SHOW_DURATION_MS,
    ENABLE_MEM_RESTORE: ENABLE_MEM_RESTORE,
    MEM_DEBUG: MEM_DEBUG,
    SKIN_DEBUG: SKIN_DEBUG
};
