// ===== popup 交互 =====
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const getUrls = async () => (await chrome.storage.local.get("urls")).urls || [];
const setUrls = (urls) => chrome.storage.local.set({ urls });

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 状态 -> 徽章配色
function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (/accept/.test(s)) return "green";
  if (/reject|declin/.test(s)) return "red";
  if (/revis|revise|major|minor/.test(s)) return "orange";
  if (/review|referee|reviewer/.test(s)) return "blue";
  if (/editor|assign/.test(s)) return "indigo";
  if (/submit|received|incomplete|new/.test(s)) return "gray";
  return "gray";
}

function relTime(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  return d.toLocaleDateString();
}

// "Jul 21, 2026" -> 距今天数
function daysSince(dateStr) {
  const t = Date.parse(dateStr);
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

const ROLE_ZH = {
  "Corresponding Author": "通讯作者",
  "Other Author": "其他作者",
  "Contributing Author": "参与作者",
  "First Author": "第一作者",
};
const roleZh = (r) => ROLE_ZH[r] || r;

// 从监控 URL 取期刊代码（editorialmanager.com/<code>/...）作为站点标识
function journalCode(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg ? seg.toUpperCase() : new URL(url).hostname;
  } catch {
    return url;
  }
}

// 未登录时的「去登录」目标：打开该期刊作者主菜单，未登录会自动跳到登录页，登录后落回主菜单
function loginUrlFor(url) {
  try {
    return new URL("AuthorMainMenu.aspx", url).href;
  } catch {
    return url;
  }
}

async function renderUrls() {
  const urls = await getUrls();
  const ul = $("urlList");
  ul.innerHTML = urls.length
    ? ""
    : '<li>尚未添加监控页面。</li>';
  urls.forEach((u, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(u)}</span><button class="del" data-i="${i}">✕</button>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async () => {
      const urls = await getUrls();
      urls.splice(Number(b.dataset.i), 1);
      await setUrls(urls);
      renderUrls();
    })
  );
}

function renderState(state) {
  const lr = state.lastResult;
  const bar = $("statusBar");
  const subsEl = $("submissions");

  // ---- 状态条 ----
  if (!lr) {
    bar.innerHTML = '<span>尚未检测</span>';
  } else {
    // 按站点分别显示登录/抓取状态（多站点时不再揉成一个）
    const pills = lr.results
      .map((r) => {
        const name = journalCode(r.url);
        if (!r.ok) return `<span class="pill err">${esc(name)} 抓取失败</span>`;
        if (!r.loggedIn) {
          const loginUrl = loginUrlFor(r.url);
          return `<button class="pill off pill-btn" data-login="${esc(loginUrl)}">${esc(name)} 未登录 · 去登录 ↗</button>`;
        }
        return `<span class="pill on">${esc(name)} 已登录</span>`;
      })
      .join("");
    bar.innerHTML = `${pills}<span>· 上次检测 ${relTime(lr.time)}</span>`;
    bar.querySelectorAll(".pill-btn").forEach((b) => {
      b.addEventListener("click", () => chrome.tabs.create({ url: b.dataset.login }));
    });
  }

  // ---- 稿件卡片 ----
  const subs = [];
  (lr ? lr.results : []).forEach((r) => (r.submissions || []).forEach((s) => subs.push(s)));
  $("subCount").textContent = subs.length ? `(${subs.length})` : "";

  if (subs.length) {
    subsEl.innerHTML = subs
      .map((s) => {
        const cls = statusClass(s.status);
        const status = s.status || "未知状态";
        const foot = [];
        if (s.submitDate) foot.push(`提交 ${esc(s.submitDate)}`);
        if (s.statusDate) {
          const days = daysSince(s.statusDate);
          const ago = days === null ? "" : days === 0 ? "（今天）" : `（${days} 天前）`;
          foot.push(`状态更新 ${esc(s.statusDate)}${ago}`);
        }
        const roleTag = s.role ? `<span class="role">${esc(roleZh(s.role))}</span>` : "";
        return `<div class="card">
          <div class="card-top">
            <span class="card-id">${esc(s.id)}${roleTag}</span>
            <span class="badge ${cls}">${esc(status)}</span>
          </div>
          <div class="card-title">${esc(s.title || s.text || "")}</div>
          ${foot.length ? `<div class="card-foot">${foot.join(" · ")}</div>` : ""}
        </div>`;
      })
      .join("");
  } else {
    // 无稿件：显示提示或调试信息
    let dbg = "";
    const r0 = lr && lr.results && lr.results.find((r) => r.ok && r.debug);
    if (r0) {
      const d = r0.debug;
      dbg = `<div class="debug">调试信息：<br>页面标题：${esc(d.title) || "(空)"}｜表格行 ${d.trCount}｜正文 ${d.bodyLen} 字<br>
        疑似编号：${d.looseTokens && d.looseTokens.length ? esc(d.looseTokens.join(", ")) : "(无)"}</div>`;
    }
    subsEl.innerHTML = `<div class="empty">${lr ? "未检测到在审稿件。" : "尚未检测。"}</div>${dbg}`;
  }

  // ---- 历史 ----
  const h = state.history || [];
  $("history").innerHTML = h.length
    ? h.slice(0, 30).map((c) => {
        const badge = statusClass(c.type === "new" ? "" : c.to);
        return `<div class="chg">
          <div class="chg-head">
            <span class="chg-id">${esc(c.id)}</span>
            <span class="badge ${badge}">${c.type === "new" ? "新增" : "更新"}</span>
            <span class="chg-time">${relTime(c.time)}</span>
          </div>
          <div class="chg-to">${esc(shortStatus(c.to))}</div>
        </div>`;
      }).join("")
    : '<div class="empty">暂无。</div>';

  if (state.intervalMinutes) $("interval").value = state.intervalMinutes;
}

// 历史里只显示状态那一段（行文本可能很长）
function shortStatus(text) {
  const m = (text || "").match(DATE_TAIL);
  return m ? m[1].trim() : (text || "").slice(0, 80);
}
const DATE_TAIL = /\d{4}\s+([^|]{2,60})$/;

async function refresh() {
  renderState((await send({ type: "getState" })) || {});
}

// ---------- 事件 ----------
$("add").addEventListener("click", async () => {
  const v = $("urlInput").value.trim();
  if (!v) return;
  const urls = await getUrls();
  if (!urls.includes(v)) urls.push(v);
  await setUrls(urls);
  $("urlInput").value = "";
  renderUrls();
});

$("capture").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) $("urlInput").value = tab.url;
});

$("saveInterval").addEventListener("click", async () => {
  await send({ type: "setInterval", minutes: Number($("interval").value) || 30 });
  const b = $("saveInterval");
  b.textContent = "已保存";
  setTimeout(() => (b.textContent = "保存"), 1200);
});

$("checkNow").addEventListener("click", async () => {
  const b = $("checkNow");
  b.textContent = "检测中…";
  b.disabled = true;
  await send({ type: "checkNow" });
  await refresh();
  b.textContent = "立即检测";
  b.disabled = false;
});

// 设置浮层开关
const overlay = $("settingsOverlay");
$("gear").addEventListener("click", () => overlay.classList.remove("hidden"));
$("settingsClose").addEventListener("click", () => overlay.classList.add("hidden"));
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) overlay.classList.add("hidden"); // 点背景关闭
});

(async () => {
  await send({ type: "clearBadge" });
  await renderUrls();
  await refresh();
})();
