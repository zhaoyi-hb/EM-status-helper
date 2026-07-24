// ===== offscreen 文档：用 DOMParser 解析 EM 页面 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "parse") {
    try {
      sendResponse(parse(msg.html, msg.pageUrl, msg.follow !== false));
    } catch (e) {
      sendResponse({ loggedIn: true, submissions: [], followUrls: [], title: "", error: String(e) });
    }
  }
  return true;
});

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// 从行文本里提取「标题」「当前状态」「状态日期」，供 UI 展示
// 同时支持两种 EM 日期格式：May 29, 2026（月在前）/ 29 May 2026（日在前）
const DATE_RE = /(?:\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})|(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/g;
function extractFields(id, text) {
  let rest = text.split(id).slice(1).join(id).trim(); // 稿号之后的部分
  rest = rest.replace(/^R\d+\b/, "").trim(); // 去掉可能残留的修回后缀
  // 先取出作者角色，再从标题里去掉
  const roleMatch = rest.match(/\b(Corresponding Author|Other Author|Contributing Author|First Author)\b/);
  const role = roleMatch ? roleMatch[1] : "";
  rest = rest.replace(/\b(Corresponding Author|Other Author|Contributing Author|First Author)\b/g, " ").trim();
  const dates = rest.match(DATE_RE) || [];
  let title = rest;
  let status = "";
  if (dates.length) {
    const firstDate = rest.indexOf(dates[0]);
    title = normalize(rest.slice(0, firstDate));
    const lastDate = dates[dates.length - 1];
    status = normalize(rest.slice(rest.lastIndexOf(lastDate) + lastDate.length));
  }
  // 去掉标题里残留的操作链接词
  title = title.replace(/\b(View Submission|Send E-mail|View Decision Letter|Action Links|Collapse Action Links|Similar Articles|Details)\b/g, " ").trim();
  status = status.replace(/\|.*$/, "").trim(); // 去掉合并的多行残留
  return {
    title: normalize(title),
    status: normalize(status),
    role,
    submitDate: dates.length ? dates[0] : "", // Date Submission Began
    statusDate: dates.length ? dates[dates.length - 1] : "", // Status Date
  };
}

// EM 稿号形如 ABCD-D-24-01234、XY-D-2024-00567，带修回后缀 R1/R3
const MS_SRC = "\\b[A-Z][A-Z0-9]{1,10}-D-\\d{2,4}-\\d{3,6}(?:R\\d+)?\\b";

// EM 作者文件夹页面（可直接 GET 抓取），如 auth_RevisionsBeingProcessed.asp
// 跳过已完成/有决定的文件夹（这些稿件状态不会再变）：Submissions with a Decision 等
const EXCLUDE_FOLDER = /comp(leted)?|decision|accept|reject/i;
function collectFollowUrls(doc, pageUrl) {
  const out = new Set();
  const abs = (href) => {
    try { return new URL(href, pageUrl).href; } catch { return null; }
  };
  // iframe（default2.aspx 会把文件夹嵌在 iframe 里）
  doc.querySelectorAll("iframe[src]").forEach((f) => {
    const u = abs(f.getAttribute("src"));
    if (u && !EXCLUDE_FOLDER.test(u)) out.add(u);
  });
  // 主菜单里的作者文件夹链接（跳过已完成/有决定的文件夹）
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (/auth_[A-Za-z]+\.aspx?/i.test(href) && !EXCLUDE_FOLDER.test(href)) {
      const u = abs(href);
      if (u) out.add(u);
    }
  });
  // 仅保留 editorialmanager 同站，去掉自身
  return [...out].filter(
    (u) => /:\/\/[^/]*editorialmanager\.com\//i.test(u) && u.split("#")[0] !== (pageUrl || "").split("#")[0]
  );
}

function parse(html, pageUrl, follow) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 登录判定：用「正向信号」——页面有 Logout 链接才算登录。
  // 不能用「没有密码框」判断：未登录的 default2.aspx 外壳页也没有密码框（只有 Login/Register）。
  const hasPassword = !!doc.querySelector('input[type="password"]');
  const hasLogout = !!doc.querySelector('a[href*="logout" i]');
  const loggedIn = hasLogout && !hasPassword;

  const subs = {}; // id -> 合并后的行文本
  const re = new RegExp(MS_SRC, "g");

  // 优先按表格行提取（EM 稿件列表是 <tr>），行文本含稿号+标题+状态+日期
  doc.querySelectorAll("tr").forEach((tr) => {
    const t = normalize(tr.textContent);
    const m = t.match(re);
    if (m) {
      const id = m[0];
      subs[id] = subs[id] ? subs[id] + " | " + t : t;
    }
  });

  // 兜底：非表格结构时，在正文里按稿号截取上下文
  if (Object.keys(subs).length === 0 && doc.body) {
    const body = normalize(doc.body.textContent);
    let m;
    const re2 = new RegExp(MS_SRC, "g");
    while ((m = re2.exec(body))) {
      const id = m[0];
      subs[id] = normalize(body.slice(Math.max(0, m.index - 20), Math.min(body.length, m.index + 220)));
    }
  }

  // 调试信息
  const bodyText = normalize(doc.body ? doc.body.textContent : "");
  const looseTokens = [];
  const looseRe = /\b[0-9A-Za-z][0-9A-Za-z.]*-[0-9A-Za-z-]*\d{2,}\b/g;
  let lm;
  while ((lm = looseRe.exec(bodyText)) && looseTokens.length < 15) {
    if (!looseTokens.includes(lm[0])) looseTokens.push(lm[0]);
  }

  return {
    loggedIn,
    title: normalize(doc.title),
    submissions: Object.entries(subs).map(([id, text]) => ({ id, text, ...extractFields(id, text) })),
    followUrls: follow ? collectFollowUrls(doc, pageUrl) : [],
    debug: { title: normalize(doc.title), trCount: doc.querySelectorAll("tr").length, bodyLen: bodyText.length, sample: bodyText.slice(0, 400), looseTokens },
  };
}
