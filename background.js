// ===== Editorial Manager 状态检测 - 后台 Service Worker =====
const ALARM_NAME = "em-check";
const DEFAULT_INTERVAL = 30; // 分钟

// ---------- 生命周期 ----------
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);

async function bootstrap() {
  const { intervalMinutes = DEFAULT_INTERVAL } = await chrome.storage.local.get("intervalMinutes");
  await scheduleAlarm(intervalMinutes);
}

async function scheduleAlarm(minutes) {
  const period = Math.max(1, Number(minutes) || DEFAULT_INTERVAL);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period, delayInMinutes: 0.1 });
  await chrome.storage.local.set({ intervalMinutes: period });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkAll();
});

// ---------- 与 popup 的通信 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return; // 交给 offscreen 处理
  (async () => {
    switch (msg.type) {
      case "checkNow": {
        const r = await checkAll();
        sendResponse(r);
        break;
      }
      case "setInterval": {
        await scheduleAlarm(msg.minutes);
        sendResponse({ ok: true });
        break;
      }
      case "getState": {
        const state = await chrome.storage.local.get(["lastResult", "history", "urls", "intervalMinutes"]);
        sendResponse(state);
        break;
      }
      case "clearBadge": {
        await chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // 异步 sendResponse
});

// ---------- 核心检测流程 ----------
async function checkAll() {
  const { urls = [] } = await chrome.storage.local.get("urls");
  const results = [];
  let totalChanges = 0;
  let anyNotLoggedIn = false;

  for (const url of urls) {
    try {
      // 从监控 URL 派生同期刊主菜单，一并作为爬取起点
      const seeds = [url.split("#")[0]];
      try { seeds.push(new URL("AuthorMainMenu.aspx", url).href); } catch (e) {}

      // 小范围广度爬取：起点 -> iframe/文件夹链接(auth_*.asp) -> 稿件，最多 2 层、15 次抓取
      const byId = {};
      const followed = [];
      const visited = new Set();
      const queue = seeds.map((u) => ({ u, depth: 0 }));
      let firstParsed = null;
      let fetches = 0;
      let siteLoggedIn = false;
      while (queue.length && fetches < 15) {
        const { u, depth } = queue.shift();
        const key = u.split("#")[0];
        if (visited.has(key)) continue;
        visited.add(key);
        let phtml;
        try { phtml = await fetchPage(u); } catch (e) { continue; }
        fetches++;
        const p = await parseHtml(phtml, u, depth < 2);
        if (!firstParsed) firstParsed = p;
        // 任一页面出现 Logout 链接、或抓到稿件，即视为该站点已登录
        if (p.loggedIn || p.submissions.length) siteLoggedIn = true;
        for (const s of p.submissions) byId[s.id] = s; // 稿号去重（保留完整字段）
        if (p.submissions.length) followed.push({ url: u, count: p.submissions.length });
        if (depth < 2) {
          for (const fu of p.followUrls || []) {
            if (!visited.has(fu.split("#")[0])) queue.push({ u: fu, depth: depth + 1 });
          }
        }
      }
      const submissions = Object.values(byId);
      const loggedIn = siteLoggedIn;

      const changes = await diffAndStore(url, submissions);
      totalChanges += changes.length;
      if (!loggedIn) anyNotLoggedIn = true;
      results.push({ url, ok: true, loggedIn, submissions, changes, followed, debug: firstParsed ? firstParsed.debug : null });
    } catch (e) {
      results.push({ url, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  const lastResult = { time: Date.now(), results };
  await chrome.storage.local.set({ lastResult });

  // 角标：有变化显示数字；未登录显示 !
  if (totalChanges > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: String(totalChanges) });
  } else if (anyNotLoggedIn && urls.length > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
    await chrome.action.setBadgeText({ text: "!" });
  }

  return lastResult;
}

async function fetchPage(url) {
  const resp = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

// ---------- 变化对比与通知 ----------
async function diffAndStore(url, submissions) {
  const key = "snapshot:" + url;
  const store = await chrome.storage.local.get(key);
  const prev = store[key]; // 上一次快照；undefined 表示首次
  const curr = {};
  for (const s of submissions) curr[s.id] = s.text;

  const changes = [];
  if (prev !== undefined) {
    for (const id of Object.keys(curr)) {
      if (prev[id] === undefined) {
        changes.push({ id, type: "new", to: curr[id] });
      } else if (prev[id] !== curr[id]) {
        changes.push({ id, type: "changed", from: prev[id], to: curr[id] });
      }
    }
  }

  await chrome.storage.local.set({ [key]: curr });

  // 记录历史并发通知（首次仅建立基线，不通知）
  if (changes.length) {
    const { history = [] } = await chrome.storage.local.get("history");
    for (const c of changes) {
      history.unshift({ time: Date.now(), id: c.id, type: c.type, from: c.from || "", to: c.to });
      notify(c);
    }
    await chrome.storage.local.set({ history: history.slice(0, 100) });
  }
  return changes;
}

function notify(change) {
  const title = change.type === "new" ? `新稿件：${change.id}` : `状态更新：${change.id}`;
  chrome.notifications.create("em-" + change.id + "-" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: (change.to || "").slice(0, 300),
    priority: 2,
    requireInteraction: true,
  });
}

// ---------- 通过 offscreen 文档解析 HTML（SW 无 DOMParser）----------
let creatingOffscreen;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "解析 Editorial Manager 页面 HTML 以提取稿件状态。",
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function parseHtml(html, pageUrl, follow) {
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({ target: "offscreen", type: "parse", html, pageUrl, follow });
}
