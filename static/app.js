/* 测试用例执行器 前端逻辑 */
(function () {
  "use strict";

  var state = {
    cases: [],
    index: 0,
    progress: { done: 0, total: 0 },
    saveTimer: null,
    view: "exec",            // "exec" 执行界面 | "detail" 测试详情
    expandedSheets: {},       // 详情页各分组展开状态
    detailInited: false,      // 详情页是否已做过首次默认展开
    foundTimeOriginal: "",    // 当前用例发现时间基准值（用于修改确认）
  };

  // 测试结果显示文案与样式
  var RESULT_LABEL = { PASS: "通过", FAIL: "失败", BLOCK: "阻塞", NA: "跳过" };
  var RESULT_CLASS = { PASS: "res-pass", FAIL: "res-fail", BLOCK: "res-block", NA: "res-na" };

  // DOM 引用
  var el = {};
  var IDS = [
    "fileName", "sheetFilter", "saveStatus", "progressFill", "progressText",
    "loader", "card", "caseId", "priority", "risk", "moduleTag", "title",
    "scenario", "precondition", "steps", "expected", "resultButtons",
    "actual", "foundTime", "stampBtn", "clearTimeBtn", "bugId", "tester",
    "note", "prevBtn", "nextBtn", "navCounter", "jumpNext",
    "viewToggle", "detailView", "sheetGroups", "detailSummary", "navbar",
  ];

  function $(id) { return document.getElementById(id); }

  function init() {
    IDS.forEach(function (id) { el[id] = $(id); });
    bindEvents();
    loadCases();
  }

  /* ---------- 数据加载 ---------- */
  function loadCases() {
    fetch("/api/cases")
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { showError(res.d.error || "加载失败"); return; }
        state.cases = res.d.cases || [];
        state.progress = res.d.progress || { done: 0, total: 0 };
        el.fileName.textContent = res.d.fileName || "";
        if (state.cases.length === 0) { showError("未找到测试用例"); return; }
        buildSheetFilter();
        el.loader.classList.add("hidden");
        showView("exec");
      })
      .catch(function (e) { showError("网络错误: " + e.message); });
  }

  function showError(msg) {
    el.loader.classList.remove("hidden");
    el.card.classList.add("hidden");
    el.loader.textContent = msg;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var c = state.cases[state.index];
    if (!c) return;

    setBadge(el.caseId, c.caseId, "");
    setBadge(el.priority, c.priority, priorityClass(c.priority));
    setBadge(el.risk, c.risk ? "风险:" + c.risk : "", riskClass(c.risk));
    setBadge(el.moduleTag, c.module, "badge-module");

    el.title.textContent = c.title || "(无标题)";
    el.scenario.textContent = c.scenario || "";
    el.precondition.textContent = c.precondition || "—";
    el.expected.textContent = c.expected || "—";
    renderSteps(c.steps);

    // 执行区回显
    setActiveResult(c.result);
    el.actual.value = c.actual || "";
    el.foundTime.value = c.foundTime || "";
    state.foundTimeOriginal = el.foundTime.value; // 记录基准值用于修改确认
    el.bugId.value = c.bugId || "";
    el.tester.value = c.tester || "";
    el.note.value = c.note || "";

    // 导航状态
    el.navCounter.textContent = (state.index + 1) + " / " + state.cases.length;
    el.prevBtn.disabled = state.index === 0;
    el.nextBtn.disabled = state.index === state.cases.length - 1;
    el.sheetFilter.value = c.sheet;
    updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setBadge(node, text, cls) {
    node.className = "badge" + (cls ? " " + cls : "");
    if (node === el.caseId) node.className = "badge badge-id";
    node.textContent = text || "";
    node.style.display = text ? "" : "none";
  }

  function priorityClass(p) {
    if (!p) return "";
    var u = String(p).toUpperCase();
    if (u.indexOf("P0") >= 0) return "badge-p0";
    if (u.indexOf("P1") >= 0) return "badge-p1";
    if (u.indexOf("P2") >= 0) return "badge-p2";
    return "";
  }
  function riskClass(r) {
    if (!r) return "";
    if (r.indexOf("高") >= 0) return "badge-risk-high";
    if (r.indexOf("中") >= 0) return "badge-risk-mid";
    if (r.indexOf("低") >= 0) return "badge-risk-low";
    return "";
  }

  function renderSteps(steps) {
    el.steps.innerHTML = "";
    var lines = (steps || "").split(/\r?\n/).map(function (s) {
      return s.replace(/^\s*\d+[.、)]\s*/, "").trim();
    }).filter(function (s) { return s.length > 0; });
    if (lines.length === 0) {
      var li = document.createElement("li");
      li.textContent = "—";
      el.steps.appendChild(li);
      return;
    }
    lines.forEach(function (line) {
      var li = document.createElement("li");
      li.textContent = line;
      el.steps.appendChild(li);
    });
  }

  function setActiveResult(result) {
    var norm = normalizeResult(result);
    var btns = el.resultButtons.querySelectorAll(".rbtn");
    btns.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-result") === norm);
    });
  }

  // 兼容原有 PASS/FAIL/NA 以及多行文本（取首个可识别关键字）
  function normalizeResult(result) {
    if (!result) return "";
    var u = String(result).toUpperCase();
    if (u.indexOf("PASS") >= 0 || u.indexOf("通过") >= 0) return "PASS";
    if (u.indexOf("FAIL") >= 0 || u.indexOf("失败") >= 0) return "FAIL";
    if (u.indexOf("BLOCK") >= 0 || u.indexOf("阻塞") >= 0) return "BLOCK";
    if (u.indexOf("NA") >= 0 || u.indexOf("跳过") >= 0) return "NA";
    return "";
  }

  function updateProgress() {
    var p = state.progress;
    var pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    el.progressFill.style.width = pct + "%";
    el.progressText.textContent = "已完成 " + p.done + " / " + p.total + " (" + pct + "%)";
  }

  /* ---------- Sheet 过滤/跳转 ---------- */
  function buildSheetFilter() {
    var seen = {};
    var opts = [];
    state.cases.forEach(function (c) {
      if (!seen[c.sheet]) { seen[c.sheet] = true; opts.push({ sheet: c.sheet, title: c.sheetTitle || c.sheet }); }
    });
    el.sheetFilter.innerHTML = "";
    opts.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.sheet;
      opt.textContent = o.title;
      el.sheetFilter.appendChild(opt);
    });
  }

  function jumpToSheet(sheet) {
    for (var i = 0; i < state.cases.length; i++) {
      if (state.cases[i].sheet === sheet) { openCase(i); return; }
    }
  }

  function jumpToNextUntested() {
    var start = state.index;
    for (var k = 1; k <= state.cases.length; k++) {
      var i = (start + k) % state.cases.length;
      if (!normalizeResult(state.cases[i].result)) { openCase(i); return; }
    }
    setSaveStatus("全部用例已完成 🎉", "ok");
  }

  /* ---------- 视图切换 / 测试详情页 ---------- */
  function showView(view) {
    state.view = view;
    var isDetail = view === "detail";
    el.card.classList.toggle("hidden", isDetail);
    el.detailView.classList.toggle("hidden", !isDetail);
    el.navbar.classList.toggle("hidden", isDetail);
    el.viewToggle.textContent = isDetail ? "返回执行" : "测试详情";
    el.viewToggle.classList.toggle("active", isDetail);
    if (isDetail) {
      flushSave();
      // 首次进入详情页时默认展开当前用例所在分组，其余收起
      if (!state.detailInited) {
        var cur = state.cases[state.index];
        if (cur) state.expandedSheets[cur.sheet] = true;
        state.detailInited = true;
      }
      renderDetail();
    } else {
      render();
    }
  }

  function renderDetail() {
    var container = el.sheetGroups;
    container.innerHTML = "";

    // 按 Sheet 分组，保持原始顺序
    var groups = [];
    var map = {};
    state.cases.forEach(function (c, i) {
      var key = c.sheet;
      if (!map[key]) { map[key] = { sheet: key, title: c.sheetTitle || key, items: [] }; groups.push(map[key]); }
      map[key].items.push({ c: c, index: i });
    });

    var p = state.progress;
    el.detailSummary.textContent = "共 " + groups.length + " 个分组 · 已完成 " + p.done + " / " + p.total;

    groups.forEach(function (g) {
      var done = 0;
      g.items.forEach(function (it) { if (normalizeResult(it.c.result)) done++; });
      var expanded = !!state.expandedSheets[g.sheet];

      var groupEl = document.createElement("div");
      groupEl.className = "sheet-group";

      var header = document.createElement("button");
      header.type = "button";
      header.className = "sheet-group-header" + (expanded ? " expanded" : "");
      var arrow = document.createElement("span");
      arrow.className = "sg-arrow";
      arrow.textContent = expanded ? "▲" : "▼"; // 收起用向上箭头，展开用向下箭头
      var titleSpan = document.createElement("span");
      titleSpan.className = "sg-title";
      titleSpan.textContent = g.title;
      var countSpan = document.createElement("span");
      countSpan.className = "sg-count";
      countSpan.textContent = done + " / " + g.items.length;
      header.appendChild(arrow);
      header.appendChild(titleSpan);
      header.appendChild(countSpan);
      header.addEventListener("click", function () {
        state.expandedSheets[g.sheet] = !expanded;
        renderDetail();
      });
      groupEl.appendChild(header);

      if (expanded) {
        var list = document.createElement("div");
        list.className = "sg-list";
        g.items.forEach(function (it) {
          var norm = normalizeResult(it.c.result);
          var row = document.createElement("button");
          row.type = "button";
          row.className = "sg-case" + (it.index === state.index ? " current" : "");
          var idSpan = document.createElement("span");
          idSpan.className = "sg-case-id";
          idSpan.textContent = it.c.caseId || "(无编号)";
          var resSpan = document.createElement("span");
          resSpan.className = "sg-case-res " + (RESULT_CLASS[norm] || "res-none");
          resSpan.textContent = norm ? RESULT_LABEL[norm] : "未测";
          row.appendChild(idSpan);
          row.appendChild(resSpan);
          row.addEventListener("click", function () { openCase(it.index); });
          list.appendChild(row);
        });
        groupEl.appendChild(list);
      }
      container.appendChild(groupEl);
    });
  }

  // 打开指定用例的执行界面
  function openCase(index) {
    flushSave();
    state.index = index;
    showView("exec");
  }

  /* ---------- 自动保存 ---------- */
  function collectFields() {
    var active = el.resultButtons.querySelector(".rbtn.active");
    return {
      result: active ? active.getAttribute("data-result") : "",
      actual: el.actual.value,
      foundTime: el.foundTime.value,
      bugId: el.bugId.value,
      tester: el.tester.value,
      note: el.note.value,
    };
  }

  function scheduleSave() {
    setSaveStatus("正在保存…", "saving");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 800);
  }

  // 立即冲刷待保存的改动（切换视图/用例前调用）
  function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; save(); }
  }

  function save() {
    var c = state.cases[state.index];
    if (!c) return;
    var fields = collectFields();
    // 同步到本地内存，切换用例时保持回显
    c.result = fields.result;
    c.actual = fields.actual;
    c.foundTime = fields.foundTime;
    c.bugId = fields.bugId;
    c.tester = fields.tester;
    c.note = fields.note;

    var payload = Object.assign({ sheet: c.sheet, rowIndex: c.rowIndex }, fields);
    fetch("/api/cases", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { setSaveStatus("保存失败", "error"); return; }
        if (res.d.progress) { state.progress = res.d.progress; updateProgress(); }
        setSaveStatus("已保存 ✓", "ok");
      })
      .catch(function () { setSaveStatus("保存失败", "error"); });
  }

  function setSaveStatus(text, kind) {
    el.saveStatus.textContent = text;
    el.saveStatus.className = "save-status" + (kind === "saving" ? " saving" : kind === "error" ? " error" : "");
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    el.resultButtons.addEventListener("click", function (e) {
      var btn = e.target.closest(".rbtn");
      if (!btn) return;
      var wasActive = btn.classList.contains("active");
      el.resultButtons.querySelectorAll(".rbtn").forEach(function (b) { b.classList.remove("active"); });
      if (!wasActive) btn.classList.add("active"); // 再次点击可取消
      var result = wasActive ? "" : btn.getAttribute("data-result");
      // 仅"失败(FAIL)"在无时间时自动记录时间戳；PASS/BLOCK/NA 不再自动记录
      if (result === "FAIL" && !el.foundTime.value) {
        el.foundTime.value = nowStamp();
        state.foundTimeOriginal = el.foundTime.value;
      }
      scheduleSave();
    });

    [el.actual, el.bugId, el.tester, el.note].forEach(function (node) {
      node.addEventListener("input", scheduleSave);
    });

    // 发现时间：支持手动输入/修改；修改已有时间需二次确认
    el.foundTime.addEventListener("focus", function () {
      state.foundTimeOriginal = el.foundTime.value;
    });
    el.foundTime.addEventListener("change", function () {
      var orig = state.foundTimeOriginal || "";
      var val = el.foundTime.value;
      if (orig && val !== orig) {
        if (!window.confirm("是否确认修改发现时间？")) {
          el.foundTime.value = orig; // 取消则还原
          return;
        }
      }
      state.foundTimeOriginal = el.foundTime.value;
      scheduleSave();
    });

    // "记录当前时间"按钮：主动记录；若已有时间则确认修改
    el.stampBtn.addEventListener("click", function () {
      if (el.foundTime.value && !window.confirm("是否确认修改发现时间？")) return;
      el.foundTime.value = nowStamp();
      state.foundTimeOriginal = el.foundTime.value;
      scheduleSave();
    });
    el.clearTimeBtn.addEventListener("click", function () {
      el.foundTime.value = "";
      state.foundTimeOriginal = "";
      scheduleSave();
    });

    el.prevBtn.addEventListener("click", function () { go(-1); });
    el.nextBtn.addEventListener("click", function () { go(1); });
    el.jumpNext.addEventListener("click", jumpToNextUntested);
    el.sheetFilter.addEventListener("change", function () { jumpToSheet(el.sheetFilter.value); });
    el.viewToggle.addEventListener("click", function () {
      showView(state.view === "detail" ? "exec" : "detail");
    });

    document.addEventListener("keydown", onKey);
  }

  function go(delta) {
    var ni = state.index + delta;
    if (ni < 0 || ni >= state.cases.length) return;
    // 切换前立即保存（如有待保存）
    flushSave();
    state.index = ni;
    render();
  }

  function onKey(e) {
    if (state.view === "detail") return; // 详情页不响应执行界面快捷键
    var tag = (e.target.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "ArrowLeft" && !typing) { go(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight" && !typing) { go(1); e.preventDefault(); }
    else if (!typing && ["1", "2", "3", "4"].indexOf(e.key) >= 0) {
      var map = { "1": "PASS", "2": "FAIL", "3": "BLOCK", "4": "NA" };
      var btn = el.resultButtons.querySelector('[data-result="' + map[e.key] + '"]');
      if (btn) btn.click();
      e.preventDefault();
    }
  }

  function nowStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
