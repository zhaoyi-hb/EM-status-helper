# Editorial Manager 论文状态检测（Chrome / Edge 插件）

后台用你已登录的会话，定时静默抓取 Editorial Manager 的稿件页面，解析稿号与状态，
一旦发现变化就发送**桌面通知**，并在插件图标上显示角标。

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本文件夹 `em-status-checker`。

## 使用

1. 在浏览器里正常**登录** Editorial Manager。
2. 点插件图标，在输入框填入你的**作者主菜单（Main Menu）URL**，点「添加」。
   - 格式为：`https://www.editorialmanager.com/<期刊代码>/AuthorMainMenu.aspx`
     （`<期刊代码>` 替换成你投稿期刊的代码，如 `xxxx`）
   - 或登录后点左侧「Main Menu」，用「当前页」按钮自动抓取。
   - 插件会自动跟进主菜单里的所有文件夹（Revisions Being Processed、Submissions with a
     Decision、Submissions Being Processed 等）并汇总全部稿件，一个 URL 就够。
3. 设置「检测间隔」（默认 30 分钟）并保存；也可随时点「立即检测」。
4. 之后插件会在后台按间隔自动检测。状态有变化时弹桌面通知，图标出现红色角标；
   未登录/会话过期时显示黄色 `!`。

> 注意：不要只填外层的 `default2.aspx`，那只是个框架、只嵌了一个文件夹。填 `AuthorMainMenu.aspx`
> 才能覆盖全部文件夹。

## 工作原理

- `background.js`：`chrome.alarms` 定时触发，`fetch(url, {credentials:'include'})`
  带上你的登录 Cookie 抓取页面；并**自动跟进** iframe 与 `auth_*.asp` 文件夹页面（一层），
  把各文件夹的稿件汇总去重。**只跟进在审文件夹（如 Revisions Being Processed），
  自动跳过 Completed / Submissions with a Decision 等已完成文件夹**（这些稿件状态不会再变）。
- `offscreen.js`：MV3 的 Service Worker 没有 DOM，用 offscreen 文档的 `DOMParser`
  解析 HTML。按稿号正则 `[A-Z]+-D-\d{2,4}-\d{3,6}(R\d+)?` 定位每篇稿件所在表格行，
  把整行文本（稿号+标题+状态+日期）作为快照。
- 对比上次快照，任意一行文本变化 → 记为「状态变化」并通知。首次运行只建立基线不通知。

## 说明与限制

- **必须先登录**：插件复用你浏览器里的 EM 会话，不保存任何账号密码。会话过期后会提示，
  重新登录即可继续。
- **抓取的 URL 需能直接 GET 到稿件列表**。大多数 EM 作者页面登录后可直接访问；
  若某页面是通过表单 POST 才能到达、直接抓取只返回登录页，请改用登录后能直接打开的列表页 URL。
- 若「检测到的稿件」为空但你确实已登录，说明该页面的稿号格式或结构不匹配，
  可把页面 URL 换成真正的稿件列表页，或告诉我该期刊的稿号样式以便调整正则。
- 检测间隔最小 1 分钟；为减轻服务器压力，建议 30~60 分钟。
