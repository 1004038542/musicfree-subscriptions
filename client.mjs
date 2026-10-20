/**
 * 音源订阅器 · Folia Folium 模组
 *
 * MusicFree 插件订阅加载器：在模组设置里添加订阅链接（每行一个，如万象数据
 * https://api.vsaa.cn/api/music/index.json），自动拉取插件清单、下载插件 JS、
 * 沙箱执行后注册为 Folia 在线音源（搜索/播放/歌词）。
 *
 * 使用：
 *   设置 → 模组 → 展开「音源订阅器」→ 在设置面板粘贴订阅链接 → 保存 →
 *   音源自动出现在首页切换器（「订阅·XXX」）。
 *
 * 安全提示：第三方插件代码会在 Folia 内以 net.fetch 权限运行（仅网络请求，
 * 无文件系统/播放控制权限）。只添加你信任的订阅源。
 */

/** 音质映射：Folia 音质 → MusicFree 音质 */
const QUALITY_MAP = { standard: "standard", high: "high", lossless: "super", hires: "super" };

/** 分割歌手字符串 */
const splitArtists = (raw) =>
  String(raw || "").split(/[/、,，&＆]/).map((s) => s.trim()).filter(Boolean);

/** 插件 musicItem 精简字段（避免 id 过长） */
const PICK_FIELDS = [
  "id", "hash", "mixsongid", "songmid", "bvid", "aid", "cid",
  "title", "artist", "album", "albumId", "artwork", "coverImg", "duration",
];

const pick = (item) => {
  const out = {};
  for (const k of PICK_FIELDS) if (item?.[k] !== undefined && item[k] !== null && item[k] !== "") out[k] = item[k];
  return out;
};

/** 编码/解码：完整 musicItem 塞进 song.id，播放/歌词时还原 */
const encodeItem = (item) => "mf1." + btoa(unescape(encodeURIComponent(JSON.stringify(pick(item)))));
const decodeItem = (id) => {
  try {
    if (typeof id !== "string" || !id.startsWith("mf1.")) return null;
    return JSON.parse(decodeURIComponent(escape(atob(id.slice(4)))));
  } catch {
    return null;
  }
};

const toFoliumSong = (item) => {
  if (!item || !item.title) return null;
  const song = {
    id: encodeItem(item),
    title: String(item.title),
    artists: splitArtists(item.artist),
  };
  if (item.album) song.album = String(item.album);
  if (item.artwork || item.coverImg) song.coverUrl = String(item.artwork || item.coverImg);
  if (Number(item.duration) > 0) song.durationMs = Number(item.duration) * 1000;
  return song;
};

const slug = (s) => String(s || "music").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "music";

/** 宿主网络请求（由 activate 注入） */
let fetchHost = async () => { throw new Error("host fetch 未初始化"); };

/*
 * 沙箱全局环境：env / axios 常驻全局（插件导出的函数在沙箱执行结束后才被调用，
 * 搜索/播放时仍要解析自由变量 env/axios），module/exports/require 每次执行时
 * 临时注入、执行后清理（插件函数体不再引用它们）。
 */
const sandboxUserVariables = { key: "" };
let sandboxGlobalsInstalled = false;

const sandboxAxios = {
  async request(config = {}) {
    const url = new URL(config.url || "");
    const params = config.params || {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const init = { timeoutMs: config.timeout || 30000 };
    if (config.headers) init.headers = config.headers;
    const res = await fetchHost(url.toString(), init);
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { data: body, status: res.status };
  },
  async get(url, config = {}) { return this.request({ ...config, url, method: "get" }); },
  async post(url, config = {}) { return this.request({ ...config, url, method: "post" }); },
};

const sandboxEnv = {
  getUserVariables: () => sandboxUserVariables,
  getEnv: () => ({ platform: "folia" }),
  env: {},
};

const sandboxRequire = (name) => {
  if (name === "axios") return sandboxAxios;
  if (name === "querystring") {
    return {
      stringify: (o) => new URLSearchParams(o).toString(),
      parse: (s) => Object.fromEntries(new URLSearchParams(s)),
    };
  }
  if (name === "crypto" || name === "node:crypto") {
    return { createHash: () => ({ update: () => ({ digest: () => "" }) }) };
  }
  throw new Error(`插件依赖未支持: ${name}`);
};

/** 安装/更新沙箱全局（activate 时调用一次） */
const installSandboxGlobals = (apiKey) => {
  sandboxUserVariables.key = apiKey || "";
  if (sandboxGlobalsInstalled) return;
  globalThis.require = sandboxRequire;
  globalThis.env = sandboxEnv;
  globalThis.axios = sandboxAxios;
  sandboxGlobalsInstalled = true;
};

/** 移除沙箱全局（dispose 时调用） */
const uninstallSandboxGlobals = () => {
  if (!sandboxGlobalsInstalled) return;
  delete globalThis.require;
  delete globalThis.env;
  delete globalThis.axios;
  sandboxGlobalsInstalled = false;
};

/**
 * 沙箱执行插件 JS（CommonJS 风格）。module/exports/require 临时注入全局
 * （而非函数参数，避免与插件内部 `const axios = require(...)` 声明冲突），
 * 执行后清理；env/axios 常驻（插件导出的函数之后调用时仍需要）。
 */
const runPluginCode = (code) => {
  const moduleBox = { exports: {} };
  const TEMP_KEYS = ["module", "exports", "require"];
  const saved = {};
  for (const k of TEMP_KEYS) {
    saved[k] = k in globalThis ? globalThis[k] : undefined;
    delete globalThis[k];
  }
  globalThis.module = moduleBox;
  globalThis.exports = moduleBox.exports;
  globalThis.require = sandboxRequire;

  try {
    const factory = new Function(`${code}\n;return module.exports;`);
    const result = factory();
    return result && typeof result === "object" ? result : moduleBox.exports;
  } finally {
    for (const k of TEMP_KEYS) {
      delete globalThis[k];
      if (saved[k] !== undefined) globalThis[k] = saved[k];
    }
  }
};

/**
 * 判断插件种类：万象类订阅会把「音乐」与「听书/有声书」混在同一个清单里。
 * - 音乐插件 url 形如 .../api/music/{id}/index.js，返回的是歌曲对象，Folia 音乐源 schema 兼容
 * - 听书插件 url 形如 .../api/book/{id}/index.js，搜索返回的是专辑/有声书对象，
 *   与 Folia 的 omni.providers（音乐源）schema 不兼容，一旦注册为音乐源会在渲染层
 *   抛出未捕获异常 → 黑屏/加载中断。故需识别并默认排除。
 */
const detectPluginKind = (p) =>
  /\/api\/book\//i.test(String(p.url || "")) ? "book" : "music";

/**
 * 从插件 URL 提取英文注册 id：如 .../api/music/kugou/index.js → kugou，.../kugou.js → kugou。
 * 万象类插件 URL 形如 .../api/music/{platform}/index.js，真正的平台名在「倒数第二段」，
 * 末尾通常是 index.js 这类文件名段，不能直接取最后一段，否则 8 个平台会全部变成相同 id。
 * Folia 要求 omni.providers 的 id 必须匹配 /^[a-z0-9][a-z0-9-]*$/（纯英文小写/数字/连字符），
 * 中文平台名不能进 id，故用 URL 路径里的稳定英文标识，而不是中文展示名。
 * 提取失败时退化为 fallback，保证仍为合法且唯一的 id。
 */
const platformIdFromUrl = (url, fallback) => {
  try {
    const path = new URL(url).pathname;
    const segs = path.split("/").filter(Boolean);
    // 从后往前找第一个不含扩展名、且非 index/main/app 等占位名的段，作为平台名
    for (let i = segs.length - 1; i >= 0; i--) {
      const raw = segs[i];
      const noExt = raw.replace(/\.js$/i, "");
      if (!/\.[a-z0-9]+$/i.test(raw) && !/^(index|main|app|music|book|api)$/i.test(noExt)) {
        if (/^[a-z0-9][a-z0-9-]*$/i.test(noExt)) return noExt.toLowerCase();
      }
    }
  } catch { /* 解析失败走 fallback */ }
  return fallback;
};

/** 解析订阅清单：返回插件定义数组 [{name, url, kind, id}] */
const fetchSubscription = async (subscriptionUrl, subKey) => {
  const res = await fetchHost(subscriptionUrl, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest = await res.json();
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return plugins
    .filter((p) => p && typeof p.url === "string")
    .map((p) => ({
      name: p.name || "",
      url: p.url,
      kind: detectPluginKind(p),
      id: platformIdFromUrl(p.url, `${subKey}-${Math.random().toString(36).slice(2, 8)}`),
    }));
};

/** 清洗平台名：去掉 "卍-" 等符号前缀，只留可读名称 */
const cleanPlatform = (raw) => String(raw || "music").replace(/^[卍\u534d·\-\s]+/, "").trim() || "music";

/** 构建一个 MusicFree 插件的 Folia provider
 *  @param {string} id 英文注册 id（来自插件 URL 路径，满足 Folia 对 id 的正则要求） */
const makeProvider = (plugin, id) => {
  const platform = cleanPlatform(plugin.platform || plugin.name || "music");
  const def = {
    id: id || slug(platform),
    displayName: `订阅·${platform}`,
    shortName: platform,
    async search(query, page) {
      let data = [];
      try {
        const pageNo = Math.floor((page.offset || 0) / (page.limit || 20)) + 1;
        const res = await plugin.search(query, pageNo, "music");
        data = Array.isArray(res?.data) ? res.data : [];
      } catch {
        /* 平台异常：返回空结果，绝不向外抛，避免渲染层崩溃 */
        data = [];
      }
      const items = data.map(toFoliumSong).filter(Boolean);
      return { items, hasMore: false };
    },
    async getSong(id) {
      const item = decodeItem(id);
      if (!item) return null;
      try {
        const info = typeof plugin.getMusicInfo === "function" ? await plugin.getMusicInfo(item) : null;
        return info ? toFoliumSong(info) : null;
      } catch {
        return null;
      }
    },
    async getAudioUrl(song, quality) {
      const item = decodeItem(song?.id);
      if (!item) throw new Error("无法识别的歌曲");
      if (typeof plugin.getMediaSource !== "function") throw new Error("插件不支持播放");
      let src = null;
      try {
        src = await plugin.getMediaSource(item, QUALITY_MAP[quality] || "standard");
      } catch (e) {
        throw new Error(`获取播放链接失败: ${e?.message || ""}`);
      }
      if (!src || typeof src.url !== "string") throw new Error("获取播放链接失败");
      const out = { url: src.url };
      if (Number.isFinite(src.expiresAt)) out.expiresAt = Number(src.expiresAt);
      return out;
    },
    async getLyrics(song) {
      const item = decodeItem(song?.id);
      if (!item) return null;
      if (typeof plugin.getLyric !== "function") return null;
      try {
        const res = await plugin.getLyric(item);
        if (!res || !res.rawLrc) return null;
        return {
          main: {
            format: "lrc",
            text: String(res.rawLrc),
            ...(res.translation ? { translationText: String(res.translation) } : {}),
          },
        };
      } catch {
        return null;
      }
    },
  };
  return def;
};

/** 加载全部订阅并注册音源；返回 {ok, errors, handles}
 *  @param {boolean} enableBooks 是否同时把「听书类」插件注册为音源（默认关，易黑屏） */
const loadAllSubscriptions = async (folium, subscriptionsText, enableBooks = false) => {
  const providers = folium.experimental["omni.providers"];
  const errors = [];
  const handles = [];
  const skippedBooks = [];
  const urls = String(subscriptionsText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  for (const url of urls) {
    let subKey = "sub";
    try {
      subKey = slug(new URL(url).hostname) || "sub";
    } catch {
      /* URL 非法时保持默认 key */
    }
    try {
      const plugins = await fetchSubscription(url, subKey);
      for (const p of plugins) {
        // 听书类插件默认跳过，避免注册为音乐源导致渲染崩溃/黑屏
        if (p.kind === "book" && !enableBooks) {
          skippedBooks.push(`${subKey}/${p.name}`);
          continue;
        }
        try {
          const res = await fetchHost(p.url, { timeoutMs: 30000 });
          if (!res.ok) throw new Error(`插件 HTTP ${res.status}`);
          const code = await res.text();
          let plugin;
          try {
            plugin = runPluginCode(code);
          } catch (e) {
            errors.push(`${subKey}/${p.name}: 执行失败 ${e.message}`);
            continue;
          }
          if (!plugin || typeof plugin.search !== "function") {
            errors.push(`${subKey}/${p.name}: 不是有效音源插件`);
            continue;
          }
          const handle = providers.register(makeProvider(plugin, p.id));
          handles.push({ handle, name: plugin.platform || p.name });
        } catch (e) {
          errors.push(`${subKey}/${p.name}: ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  return { ok: handles, errors, skippedBooks };
};

/** 创建/更新模组里的音源（reload 用） */
let currentHandles = [];

/**
 * 模组入口
 * @param {import('../folium').FoliumClientApi} folium
 */
export default function activate(folium) {
  fetchHost = (url, init) => folium.net.fetch(url, init);
  const providers = folium.experimental["omni.providers"];

  // —— 模组设置区块（含自绘设置面板）——
  const settingsHandle = folium.registries.settingsSections.register({
    id: "subscriptions",
    label: "音源订阅",
    description: "添加 MusicFree 插件订阅链接，每行一个；保存后自动加载为 Folia 音源。",
    settings: [
      {
        key: "subscriptions",
        type: "text",
        label: "订阅链接",
        description: "每行一个 MusicFree 插件订阅链接（返回 {plugins:[{name,url}]} 的清单）。",
        placeholder: "https://api.vsaa.cn/api/music/index.json",
        defaultValue: "https://api.vsaa.cn/api/music/index.json",
      },
      {
        key: "apiKey",
        type: "text",
        label: "通用 API Key（可选）",
        description: "作为插件用户变量 key 传入。万象数据插件必填；留空则用插件自带密钥。",
        placeholder: "sk-xxxxxxxx",
        defaultValue: "sk-bc0f63c5814aaa34b3c507b9c4879e62",
      },
      {
        key: "enableBooks",
        type: "boolean",
        label: "启用听书类音源（实验，可能黑屏）",
        description: "万象清单里除了音乐还混有听书/有声书插件，其数据结构与音乐源不兼容，注册可能导致界面黑屏。默认关闭，仅加载音乐。",
        defaultValue: false,
      },
    ],
    settingsPanel: mountSettingsPanel,
  });

  const reload = async () => {
    for (const h of currentHandles) {
      try { h.handle.unregister(); } catch { /* 已注销 */ }
    }
    currentHandles = [];
    const vals = settingsHandle.params.get();
    installSandboxGlobals(String(vals.apiKey || ""));
    const result = await loadAllSubscriptions(
      folium,
      String(vals.subscriptions || ""),
      Boolean(vals.enableBooks),
    );
    currentHandles = result.ok;
    lastLoad = {
      at: Date.now(),
      ok: result.ok.length,
      errors: result.errors,
      skippedBooks: result.skippedBooks || [],
      enableBooks: Boolean(vals.enableBooks),
    };
    notifyPanel();
  };

  // 订阅设置变化 → 自动重载（防抖）
  const unsubSettings = settingsHandle.params.subscribe(() => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reload(), 400);
  });

  // —— 命令：手动重载 ——
  const commandHandle = folium.registries.commands.register({
    id: "reload-subscriptions",
    label: "重新加载音源订阅",
    run: async () => {
      await reload();
      const msg = lastLoad
        ? `已加载 ${lastLoad.ok} 个音源${lastLoad.errors.length ? `，${lastLoad.errors.length} 个失败` : ""}`
        : "无订阅";
      folium.ui.toast(msg);
    },
  });

  // 启动即加载
  void reload();

  return () => {
    clearTimeout(reloadTimer);
    unsubSettings();
    try { commandHandle.unregister(); } catch { /* noop */ }
    try { settingsHandle.unregister(); } catch { /* noop */ }
    for (const h of currentHandles) {
      try { h.handle.unregister(); } catch { /* noop */ }
    }
    currentHandles = [];
    uninstallSandboxGlobals();
    fetchHost = async () => { throw new Error("host fetch 未初始化"); };
  };
}

/** 面板状态 */
let reloadTimer = 0;
let lastLoad = null;
let notifyPanel = () => {};

/** 自绘设置面板 */
function mountSettingsPanel(container, ctx) {
  const { params } = ctx;
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;gap:10px;padding:12px 0;";
  el.innerHTML = `
    <style>
      .mf-row{display:flex;flex-direction:column;gap:6px}
      .mf-label{font-size:12px;font-weight:600;color:var(--folium-text,inherit)}
      .mf-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:10px;border:1px solid var(--folium-border,rgba(128,128,128,.35));background:var(--folium-input-bg,rgba(128,128,128,.12));color:var(--folium-text,inherit);font-size:13px;outline:none}
      .mf-input:focus{border-color:var(--folium-accent,#4f8cff)}
      .mf-textarea{min-height:96px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6}
      .mf-btn{padding:8px 16px;border:none;border-radius:999px;background:var(--folium-accent,#4f8cff);color:#fff;font-size:13px;font-weight:600;cursor:pointer}
      .mf-btn:hover{opacity:.9}
      .mf-chk{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--folium-text,inherit);cursor:pointer}
      .mf-note{font-size:11px;opacity:.55;line-height:1.5}
      .mf-status{font-size:11px;opacity:.7;white-space:pre-wrap}
      .mf-err{color:var(--folium-danger,#e5534b);font-size:11px;white-space:pre-wrap}
    </style>
    <div class="mf-row">
      <span class="mf-label">订阅链接</span>
      <textarea class="mf-input mf-textarea mf-sub" placeholder="https://api.vsaa.cn/api/music/index.json"></textarea>
      <span class="mf-note">每行一个订阅链接。清单格式：{&quot;plugins&quot;:[{&quot;name&quot;:&quot;xxx&quot;,&quot;url&quot;:&quot;https://.../index.js&quot;}]}。个别平台（如万象 B站）因防盗链可能无法播放。</span>
    </div>
    <div class="mf-row">
      <span class="mf-label">通用 API Key（可选）</span>
      <input class="mf-input mf-key" type="text" placeholder="sk-xxxxxxxx" />
      <span class="mf-note">作为插件用户变量 key 传入；万象数据插件必填（已预填公共 key）。</span>
    </div>
    <div class="mf-row">
      <label class="mf-chk"><input type="checkbox" class="mf-books" /> 启用听书类音源（实验，可能黑屏）</label>
      <span class="mf-note">万象清单混有听书/有声书插件，结构不兼容音乐源，默认跳过以防黑屏。</span>
    </div>
    <div class="mf-row">
      <button class="mf-btn mf-save" type="button">保存并加载</button>
      <span class="mf-note">保存后立即拉取并注册音源，随后在首页切换器选择「订阅·XXX」使用。</span>
    </div>
    <div class="mf-status mf-status-box"></div>
    <div class="mf-err mf-err-box"></div>
  `;
  container.appendChild(el);

  const subInput = el.querySelector(".mf-sub");
  const keyInput = el.querySelector(".mf-key");
  const booksInput = el.querySelector(".mf-books");
  const statusBox = el.querySelector(".mf-status-box");
  const errBox = el.querySelector(".mf-err-box");
  const saveBtn = el.querySelector(".mf-save");

  const initial = params.get();
  subInput.value = String(initial.subscriptions || "");
  keyInput.value = String(initial.apiKey || "");
  booksInput.checked = Boolean(initial.enableBooks);

  saveBtn.addEventListener("click", () => {
    params.set({ subscriptions: subInput.value, apiKey: keyInput.value, enableBooks: booksInput.checked });
  });

  notifyPanel = () => {
    if (!lastLoad) return;
    statusBox.textContent = `最近加载：${new Date(lastLoad.at).toLocaleTimeString()} · ${lastLoad.ok} 个音源成功`;
    if (!lastLoad.enableBooks && lastLoad.skippedBooks?.length) {
      statusBox.textContent += `\n已跳过 ${lastLoad.skippedBooks.length} 个听书音源（听书开关已关）`;
    }
    errBox.textContent = lastLoad.errors.length ? `失败：\n${lastLoad.errors.join("\n")}` : "";
  };

  // 面板关闭/重挂时停止 notify
  return () => {
    notifyPanel = () => {};
    el.remove();
  };
}
