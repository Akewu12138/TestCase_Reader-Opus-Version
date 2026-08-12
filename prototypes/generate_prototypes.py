# -*- coding: utf-8 -*-
"""
生成「测试用例执行器」执行界面的 10 种设计风格原型（自包含 HTML）。
共享一套语义化 HTML 结构与基础 CSS，仅替换主题变量 / 少量修饰，保证可对比、可控落地成本。
"""
import os

OUT_DIR = r"D:\桌面\工业自动化\测试用例阅读器\prototypes"
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# 共享 HTML：同一执行界面（顶栏 + 进度 + 用例卡片左读右写 + 底部导航）
# ---------------------------------------------------------------------------
SHARED_HTML = """
<header class="topbar">
  <div class="topbar-left">
    <span class="brand">测试用例执行器</span>
    <span class="file-name">IND-1.14.2 工业 ROS 回归用例库.xlsx</span>
  </div>
  <div class="topbar-right">
    <button class="btn btn-primary">测试详情</button>
    <button class="btn">表格视图</button>
    <select class="select"><option>结果列：R3 回归</option><option>结果列：R2 冒烟</option></select>
    <button class="btn">＋新建列</button>
    <button class="btn">筛选·2</button>
    <select class="select"><option>模块：倒车入库</option></select>
    <button class="btn">下一条未测</button>
    <button class="btn">导出子任务</button>
    <button class="btn">导入结果</button>
    <button class="btn btn-icon">?</button>
    <button class="btn btn-icon">···</button>
  </div>
</header>

<div class="progress-wrap">
  <div class="progress-bar">
    <div class="progress-fill" style="width:44%"></div>
    <div class="progress-seg" style="width:30%;background:var(--pass)"></div>
    <div class="progress-seg" style="width:6%;background:var(--fail)"></div>
    <div class="progress-seg" style="width:4%;background:var(--block)"></div>
    <div class="progress-seg" style="width:4%;background:var(--na)"></div>
  </div>
  <span class="progress-text">已完成 142 / 320（44%）· 筛选中</span>
</div>

<main class="main">
  <section class="card">
    <div class="card-main">
      <div class="card-head">
        <div class="badges">
          <span class="badge badge-id">IND-1.14.2-DCRK-007</span>
          <span class="badge">功能</span>
          <span class="badge p0">P0</span>
          <span class="badge risk-high">风险:高</span>
          <span class="badge badge-module">倒车入库</span>
        </div>
        <h1 class="case-title">机器人从充电桩自主驶入倒车入库目标位并精准停靠</h1>
      </div>

      <div class="section">
        <h2 class="section-title">前置条件</h2>
        <div class="section-body precond">1. 机器人电量 ≥ 80%
2. 充电桩已归位且网络正常
3. 入库区无遮挡物，库位线清晰</div>
      </div>

      <div class="section">
        <h2 class="section-title">测试步骤</h2>
        <ol class="steps-list">
          <li>在 Web 端选择「倒车入库」任务并下发给机器人</li>
          <li>观察机器人离桩并向目标库位移动</li>
          <li>机器人执行倒车对准库位线，速度平滑无急停</li>
          <li>确认停靠后上报「入库完成」状态</li>
        </ol>
      </div>

      <div class="section">
        <h2 class="section-title">预期结果</h2>
        <div class="section-body expected">1. 机器人 8s 内离桩
2. 倒车轨迹横向偏差 ≤ 3cm
3. 最终停靠位姿误差 ≤ 2cm
4. 状态变更为「已入库」，日志无 ERROR</div>
      </div>
    </div>

    <aside class="card-side">
      <h2 class="section-title">执行结果</h2>
      <div class="result-buttons">
        <button class="rbtn pass">通过 <span class="kbd">1</span></button>
        <button class="rbtn fail active">失败 <span class="kbd">2</span></button>
        <button class="rbtn block">阻塞 <span class="kbd">3</span></button>
        <button class="rbtn na">跳过 <span class="kbd">4</span></button>
      </div>
      <label class="auto-advance"><input type="checkbox" checked> 标记通过/跳过后自动下一条</label>

      <label class="field">
        <span class="field-label">实际现象 / 结果</span>
        <textarea class="field-input" rows="3">倒车时横向偏差 6.2cm，超出 3cm 阈值；重定位后二次入库偏差 2.4cm 达标。</textarea>
      </label>

      <div class="field-row">
        <label class="field">
          <span class="field-label">发现时间</span>
          <input class="field-input" value="2026-08-12 21:14:33">
        </label>
      </div>

      <div class="field-row two-col">
        <label class="field">
          <span class="field-label">BugID</span>
          <input class="field-input attn" placeholder="关联缺陷编号" value="KT-2381">
        </label>
        <label class="field">
          <span class="field-label">测试人员</span>
          <input class="field-input" value="张工">
        </label>
      </div>

      <label class="field">
        <span class="field-label">备注 / 问题描述</span>
        <textarea class="field-input" rows="2">首次入库横向超差，疑似车位线识别置信度偏低，需研发确认标定参数。</textarea>
      </label>

      <div class="evidence">
        <div class="field-label">失败证据</div>
        <div class="evidence-actions">
          <input class="field-input" placeholder="上传截图 / 日志 / 附件">
        </div>
        <div class="evidence-list">
          <span class="evidence-item">dock_trace_007.csv · 12 KB</span>
          <span class="evidence-item">deviation_snapshot.png · 340 KB</span>
        </div>
      </div>
    </aside>
  </section>
</main>

<footer class="navbar">
  <button class="btn btn-nav">← 上一条 <span class="kbd">←</span></button>
  <span class="nav-counter">7 / 320（筛选中）</span>
  <button class="btn btn-nav">下一条 → <span class="kbd">→</span></button>
</footer>
"""

# ---------------------------------------------------------------------------
# 基础 CSS（结构，全部使用变量；不在此写死任何主题色值）
# ---------------------------------------------------------------------------
BASE_CSS = """
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: 15px;
  line-height: 1.62;
  padding-bottom: 80px;
  -webkit-font-smoothing: antialiased;
}
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 22px; background: var(--card); border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.topbar-left { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.brand { font-weight: 700; font-size: 18px; white-space: nowrap; }
.file-name { color: var(--text-soft); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.topbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn {
  padding: 8px 13px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px);
  background: var(--card); color: var(--text); font-size: 13px; cursor: pointer; font-family: inherit; white-space: nowrap;
}
.btn:hover { opacity: .88; }
.btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.btn-icon { padding: 8px 12px; font-weight: 700; }
.select {
  padding: 7px 10px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px);
  background: var(--card); font-size: 13px; color: var(--text); max-width: 170px; font-family: inherit;
}
.progress-wrap { display: flex; align-items: center; gap: 12px; padding: 10px 22px; max-width: 1180px; margin: 0 auto; }
.progress-bar { flex: 1; height: 10px; background: var(--border); border-radius: 999px; overflow: hidden; position: relative; display: flex; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--pass)); }
.progress-seg { height: 100%; }
.progress-text { font-size: 13px; color: var(--text-soft); white-space: nowrap; }
.main { max-width: 1180px; margin: 0 auto; padding: 14px 22px 40px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 26px 30px; }
.card-head { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 6px; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); }
.badge-id { font-family: var(--font-mono); }
.badge-module { background: var(--bg); color: var(--text-soft); }
.badge.p0 { background: var(--fail-soft); color: var(--fail); }
.badge.p1 { background: var(--block-soft); color: var(--block); }
.badge.risk-high { background: var(--fail-soft); color: var(--fail); }
.case-title { font-size: 24px; line-height: 1.35; margin: 6px 0; }
.section { padding: 16px 0; border-bottom: 1px dashed var(--border); }
.section-title { font-size: 14px; font-weight: 700; color: var(--primary); margin: 0 0 10px; letter-spacing: .3px; }
.section-body { white-space: pre-wrap; font-size: 15px; }
.precond { background: var(--primary-soft); border-left: 3px solid var(--primary); padding: 12px 16px; border-radius: 8px; }
.expected { background: var(--pass-soft); border-left: 3px solid var(--pass); padding: 12px 16px; border-radius: 8px; }
.steps-list { margin: 0; padding-left: 22px; font-size: 15px; }
.steps-list li { margin: 7px 0; }
.result-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
.rbtn {
  padding: 14px 10px; font-size: 15px; font-weight: 700; border: 1.5px solid var(--border);
  border-radius: calc(var(--radius) - 2px); background: var(--card); color: var(--text-soft); cursor: pointer; text-align: center;
}
.rbtn .kbd { font-size: 11px; opacity: .6; border: 1px solid currentColor; border-radius: 4px; padding: 0 5px; margin-left: 4px; }
.rbtn.pass.active { background: var(--pass); color: #fff; border-color: var(--pass); }
.rbtn.fail.active { background: var(--fail); color: #fff; border-color: var(--fail); }
.rbtn.block.active { background: var(--block); color: #fff; border-color: var(--block); }
.rbtn.na.active { background: var(--na); color: #fff; border-color: var(--na); }
.auto-advance { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-soft); margin: -6px 0 16px; cursor: pointer; }
.field { display: block; margin-bottom: 14px; }
.field-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-soft); margin-bottom: 6px; }
.field-input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px);
  font-size: 14px; font-family: inherit; color: var(--text); background: var(--card); resize: vertical;
}
.field-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field-input.attn { border-color: var(--fail); box-shadow: 0 0 0 3px var(--fail-soft); }
.field-row.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.evidence { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border); }
.evidence-actions { display: flex; gap: 8px; }
.evidence-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.evidence-item { color: var(--primary); font-size: 13px; }
.navbar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 20;
  display: flex; align-items: center; justify-content: center; gap: 20px; padding: 12px 20px;
  background: var(--card); border-top: 1px solid var(--border);
}
.btn-nav { background: var(--primary); color: #fff; border: none; font-size: 15px; padding: 11px 20px; border-radius: calc(var(--radius) - 4px); cursor: pointer; font-family: inherit; }
.nav-counter { font-size: 14px; color: var(--text-soft); }
.btn-nav .kbd, .navbar .kbd { font-size: 11px; opacity: .75; border: 1px solid rgba(255,255,255,.5); border-radius: 4px; padding: 0 4px; }
@media (min-width: 1100px) {
  .card { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 0 36px; align-items: start; }
  .card-side { position: sticky; top: 74px; border-left: 1px solid var(--border); padding-left: 30px; max-height: calc(100vh - 160px); overflow: auto; }
}
@media (max-width: 1099px) {
  .card-side { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 18px; }
}
"""

# ---------------------------------------------------------------------------
# 10 个主题：变量 + 可选修饰
# ---------------------------------------------------------------------------
THEMES = [
    {
        "slug": "01-apple-minimal",
        "name": "极简留白 · Apple",
        "desc": "大留白、弱边框、柔和阴影。信息层级靠排版而非色块，长时间阅读无疲劳。",
        "vars": {
            "--bg": "#f5f5f7", "--card": "#ffffff", "--text": "#1d1d1f", "--text-soft": "#6e6e73",
            "--border": "#e6e6ea", "--primary": "#0071e3", "--primary-soft": "#e8f1fd",
            "--pass": "#34c759", "--fail": "#ff3b30", "--block": "#ff9f0a", "--na": "#8e8e93",
            "--pass-soft": "#e7f8ec", "--fail-soft": "#ffeceb", "--block-soft": "#fff3e0", "--na-soft": "#f0f0f2",
            "--shadow": "0 4px 24px rgba(0,0,0,.06)", "--radius": "14px",
            "--font": "-apple-system, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            "--font-mono": "ui-monospace, 'SF Mono', Menlo, monospace",
        },
        "extra": "body{font-size:15px;} .case-title{font-size:25px;font-weight:600;} .section{ border-bottom:1px solid #efeff2;}",
    },
    {
        "slug": "02-ant-enterprise",
        "name": "企业级 · Ant Design",
        "desc": "清晰栅格、克制蓝色、实边框。结构严谨、可预期，适合功能密集的 B 端工具。",
        "vars": {
            "--bg": "#f0f2f5", "--card": "#ffffff", "--text": "#1f2329", "--text-soft": "#646a73",
            "--border": "#dee0e3", "--primary": "#1677ff", "--primary-soft": "#e8f1ff",
            "--pass": "#52c41a", "--fail": "#ff4d4f", "--block": "#faad14", "--na": "#8c9099",
            "--pass-soft": "#f0fbe9", "--fail-soft": "#fff1f0", "--block-soft": "#fff7e6", "--na-soft": "#f2f3f5",
            "--shadow": "0 2px 10px rgba(0,0,0,.05)", "--radius": "8px",
            "--font": "PingFang SC', 'Microsoft YaHei', -apple-system, system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".btn{border-radius:6px;} .rbtn{border-radius:6px;} .card{border:1px solid #e3e6eb;}",
    },
    {
        "slug": "03-linear-dark",
        "name": "暗色高效 · Linear",
        "desc": "近黑底 + 靛蓝强调，高对比、紧凑。为长时间盯屏的执行场景降低眩光。",
        "vars": {
            "--bg": "#0d0e12", "--card": "#18191f", "--text": "#e6e7ea", "--text-soft": "#9b9fac",
            "--border": "#2a2c34", "--primary": "#7c83ff", "--primary-soft": "#23253a",
            "--pass": "#4cc38a", "--fail": "#ff6b6b", "--block": "#f5a623", "--na": "#6b7280",
            "--pass-soft": "#1b2a24", "--fail-soft": "#2e1f22", "--block-soft": "#2c2415", "--na-soft": "#1c1e24",
            "--shadow": "0 4px 22px rgba(0,0,0,.4)", "--radius": "10px",
            "--font": "PingFang SC', 'Inter', -apple-system, system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".select,.field-input{background:#1f2128;color:#e6e7ea;} .btn{background:#1f2128;color:#e6e7ea;}",
    },
    {
        "slug": "04-stripe-saas",
        "name": "清新 SaaS · Stripe",
        "desc": "紫蓝渐变点缀、圆角亲和、轻飘。现代 SaaS 质感，专业而不冰冷。",
        "vars": {
            "--bg": "#f6f9fc", "--card": "#ffffff", "--text": "#1a1f36", "--text-soft": "#697386",
            "--border": "#e6ebf1", "--primary": "#635bff", "--primary-soft": "#ecebff",
            "--pass": "#0a9d6e", "--fail": "#e04666", "--block": "#f5a623", "--na": "#8792a2",
            "--pass-soft": "#e6f7f0", "--fail-soft": "#fdeef1", "--block-soft": "#fdf3e2", "--na-soft": "#eef1f5",
            "--shadow": "0 6px 26px rgba(99,91,255,.10)", "--radius": "12px",
            "--font": "Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".progress-fill{background:linear-gradient(90deg,#635bff,#0a9d6e);} .btn-primary{box-shadow:0 2px 8px rgba(99,91,255,.35);}",
    },
    {
        "slug": "05-notion-doc",
        "name": "文档协作 · Notion",
        "desc": "中性灰、近无边框、强排版。把用例当作文档来读，弱化工具感、强化内容。",
        "vars": {
            "--bg": "#ffffff", "--card": "#ffffff", "--text": "#37352f", "--text-soft": "#787774",
            "--border": "#ebeae8", "--primary": "#2383e2", "--primary-soft": "#eaf3fb",
            "--pass": "#44825b", "--fail": "#d44c47", "--block": "#cb912f", "--na": "#9b9a97",
            "--pass-soft": "#edf5ef", "--fail-soft": "#fbecea", "--block-soft": "#faf2e3", "--na-soft": "#f1f0ee",
            "--shadow": "0 1px 3px rgba(15,15,15,.06)", "--radius": "6px",
            "--font": "PingFang SC', 'Microsoft YaHei', -apple-system, 'Segoe UI', sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".card{border:1px solid #ededec;box-shadow:none;} .section{border-bottom:1px solid #f1f0ee;} .topbar{border-bottom:1px solid #ededec;}",
    },
    {
        "slug": "06-supabase-dev",
        "name": "开发者暗 · Supabase",
        "desc": "深灰底 + 品牌绿强调，等宽编号。技术气质、数据可读，贴近研发协作语境。",
        "vars": {
            "--bg": "#1c1c1c", "--card": "#1f1f1f", "--text": "#e6e6e6", "--text-soft": "#a0a0a0",
            "--border": "#333333", "--primary": "#3ecf8e", "--primary-soft": "#16332a",
            "--pass": "#3ecf8e", "--fail": "#ff5a5f", "--block": "#f5a623", "--na": "#7a7a7a",
            "--pass-soft": "#16332a", "--fail-soft": "#33212a", "--block-soft": "#2e2415", "--na-soft": "#222222",
            "--shadow": "0 4px 20px rgba(0,0,0,.45)", "--radius": "8px",
            "--font": "PingFang SC', 'Inter', -apple-system, system-ui, sans-serif",
            "--font-mono": "ui-monospace, 'SF Mono', Menlo, monospace",
        },
        "extra": ".select,.field-input{background:#262626;color:#e6e6e6;} .btn{background:#262626;color:#e6e6e6;} .badge{background:#16332a;color:#3ecf8e;} .section-title{color:#3ecf8e;}",
    },
    {
        "slug": "07-jira-dense",
        "name": "高密度 · Jira",
        "desc": "小字号、紧凑间距、锐角、强状态色。单位屏幕信息量最高，适合批量扫读。",
        "vars": {
            "--bg": "#f4f5f7", "--card": "#ffffff", "--text": "#172b4d", "--text-soft": "#5e6c84",
            "--border": "#dfe1e6", "--primary": "#0052cc", "--primary-soft": "#deebff",
            "--pass": "#36b37e", "--fail": "#de350b", "--block": "#ff991f", "--na": "#8993a4",
            "--pass-soft": "#e3fcef", "--fail-soft": "#ffebe6", "--block-soft": "#fffae6", "--na-soft": "#ebecf0",
            "--shadow": "0 1px 2px rgba(9,30,66,.18)", "--radius": "4px",
            "--font": "PingFang SC', 'Microsoft YaHei', -apple-system, system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": "body{font-size:14px;} .case-title{font-size:21px;} .section{padding:12px 0;} .badge{font-size:11px;} .rbtn{font-size:14px;padding:11px 8px;} .btn{border-radius:3px;} .rbtn{border-radius:3px;}",
    },
    {
        "slug": "08-glass-frosted",
        "name": "玻璃拟态 · Glassmorphism",
        "desc": "彩色渐变背景 + 毛玻璃卡片，半透明层叠。视觉轻盈通透，适合演示与汇报场景。",
        "vars": {
            "--bg": "#a78bfa", "--card": "rgba(255,255,255,.55)", "--text": "#1f2330", "--text-soft": "#555a6b",
            "--border": "rgba(255,255,255,.65)", "--primary": "#7c3aed", "--primary-soft": "rgba(124,58,237,.16)",
            "--pass": "#0ea371", "--fail": "#e11d48", "--block": "#ea8c1b", "--na": "#7c8295",
            "--pass-soft": "rgba(14,163,113,.16)", "--fail-soft": "rgba(225,29,72,.16)", "--block-soft": "rgba(234,140,27,.18)", "--na-soft": "rgba(124,130,149,.18)",
            "--shadow": "0 10px 40px rgba(80,60,160,.25)", "--radius": "18px",
            "--font": "PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": """
body{ background: linear-gradient(135deg,#a78bfa 0%,#6366f1 42%,#22d3ee 100%); min-height:100vh; }
.topbar,.navbar{ background: rgba(255,255,255,.45); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.card{ backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px); border:1px solid rgba(255,255,255,.6); }
.select,.field-input,.btn{ background: rgba(255,255,255,.7); }
.badge{ background: rgba(255,255,255,.65); }
""",
    },
    {
        "slug": "09-vercel-geometric",
        "name": "几何现代 · Vercel",
        "desc": "黑白单色、锐角、强对比、网格感。极简克制、品牌感强，去装饰化。",
        "vars": {
            "--bg": "#ffffff", "--card": "#ffffff", "--text": "#000000", "--text-soft": "#666666",
            "--border": "#eaeaea", "--primary": "#000000", "--primary-soft": "#f2f2f2",
            "--pass": "#0070f3", "--fail": "#e00b1f", "--block": "#f5a623", "--na": "#999999",
            "--pass-soft": "#e8f1fe", "--fail-soft": "#fdecee", "--block-soft": "#fdf3e2", "--na-soft": "#f2f2f2",
            "--shadow": "0 0 0 1px #eaeaea", "--radius": "2px",
            "--font": "Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".topbar{border-bottom:1px solid #000;} .navbar{border-top:1px solid #000;} .btn-primary{background:#000;color:#fff;} .btn-nav{background:#000;} .section-title{color:#000;letter-spacing:.5px;}",
    },
    {
        "slug": "10-clay-warm",
        "name": "暖色人文 · Clay",
        "desc": "暖米底 + 珊瑚强调、大圆角、柔和大阴影。亲和治愈，缓解测试疲劳与焦虑。",
        "vars": {
            "--bg": "#fdf6f0", "--card": "#fffdfb", "--text": "#3a2f2a", "--text-soft": "#8a7b72",
            "--border": "#f0e2d8", "--primary": "#e0734f", "--primary-soft": "#fbe7dd",
            "--pass": "#5aa469", "--fail": "#d65745", "--block": "#e0a13a", "--na": "#a08e84",
            "--pass-soft": "#e6f1e8", "--fail-soft": "#fbe6e1", "--block-soft": "#fbf0dd", "--na-soft": "#f3ece6",
            "--shadow": "0 8px 28px rgba(180,120,90,.12)", "--radius": "16px",
            "--font": "PingFang SC', 'Microsoft YaHei', -apple-system, system-ui, sans-serif",
            "--font-mono": "ui-monospace, Menlo, monospace",
        },
        "extra": ".case-title{font-weight:600;} .btn-primary{box-shadow:0 3px 12px rgba(224,115,79,.3);} .rbtn{border-radius:14px;}",
    },
]

# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------
def build_css(theme):
    var_block = ":root {\n" + "\n".join("  %s: %s;" % (k, v) for k, v in theme["vars"].items()) + "\n}\n"
    return var_block + BASE_CSS + "\n" + (theme.get("extra", "") or "")

def build_html(theme):
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n" \
           "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n" \
           "<title>测试用例执行器 · %s</title>\n<style>\n%s\n</style>\n</head>\n<body>\n%s\n</body>\n</html>\n" % (
        theme["name"], build_css(theme), SHARED_HTML)

for t in THEMES:
    path = os.path.join(OUT_DIR, t["slug"] + ".html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(build_html(t))
    print("written:", t["slug"])

# ---------------------------------------------------------------------------
# 画廊页：10 个风格并排预览，便于横向对比与选择
# ---------------------------------------------------------------------------
def build_gallery(themes):
    cards = []
    for i, t in enumerate(themes, 1):
        cards.append("""
    <article class="g-card">
      <div class="g-preview"><iframe src="%s.html" loading="lazy" title="%s"></iframe></div>
      <div class="g-meta">
        <div class="g-no">%02d</div>
        <div class="g-text">
          <h3>%s</h3>
          <p>%s</p>
        </div>
        <a class="g-open" href="%s.html" target="_blank" rel="noopener">打开 ↗</a>
      </div>
    </article>""" % (t["slug"], t["name"], i, t["name"], t["desc"], t["slug"]))
    grid = "\n".join(cards)
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>测试用例执行器 · 十种风格原型画廊</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: "PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:#0f1115; color:#e8eaf0; padding:36px 28px 60px; }
  .g-head { max-width:1280px; margin:0 auto 26px; }
  .g-head h1 { font-size:26px; margin:0 0 8px; }
  .g-head p { color:#9aa3b2; margin:0; font-size:14px; line-height:1.7; }
  .g-grid { max-width:1280px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(380px,1fr)); gap:22px; }
  .g-card { background:#171a21; border:1px solid #272c38; border-radius:14px; overflow:hidden; display:flex; flex-direction:column; transition:transform .15s ease, border-color .15s ease; }
  .g-card:hover { transform:translateY(-3px); border-color:#3b4252; }
  .g-preview { position:relative; height:300px; overflow:hidden; background:#fff; border-bottom:1px solid #272c38; }
  .g-preview iframe { position:absolute; top:0; left:0; width:1280px; height:860px; border:0; transform:scale(.39); transform-origin:0 0; pointer-events:none; }
  .g-meta { padding:14px 16px 16px; display:flex; align-items:flex-start; gap:12px; }
  .g-no { flex:none; width:30px; height:30px; border-radius:8px; background:#2a3140; color:#cdd3e0; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:center; }
  .g-text { flex:1; min-width:0; }
  .g-text h3 { margin:2px 0 6px; font-size:16px; }
  .g-text p { margin:0; font-size:13px; color:#9aa3b2; line-height:1.6; }
  .g-open { flex:none; align-self:center; padding:8px 12px; border-radius:8px; background:#4f6ef7; color:#fff; text-decoration:none; font-size:13px; font-weight:600; }
  .g-open:hover { opacity:.9; }
</style>
</head>
<body>
  <div class="g-head">
    <h1>测试用例执行器 · 十种风格原型</h1>
    <p>同一执行界面（顶栏 + 进度 + 用例卡片左读右写 + 底部导航），10 种设计语言。点击任意卡片「打开」查看全尺寸交互版；选定方向后我可据此落地为完整设计规范（DESIGN.md）。</p>
  </div>
  <div class="g-grid">%s</div>
</body>
</html>
""" % grid

with open(os.path.join(OUT_DIR, "index.html"), "w", encoding="utf-8") as f:
    f.write(build_gallery(THEMES))
print("written: index.html")

print("DONE", len(THEMES))
