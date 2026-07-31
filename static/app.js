/* 测试用例执行器 前端逻辑 */
(function () {
  "use strict";

  var state = {
    cases: [],
    index: 0,
    progress: { done: 0, total: 0 },
    sheets: [],              // 全部 Sheet 元信息 [{name,kind,title}]
    previews: [],            // 只读预览 [{sheet,kind,title,grid,images}]
    previewMap: {},          // sheet -> preview
    files: [],               // testing 目录文件
    selectedFile: null,      // 初始页选中的文件名
    sessionTester: "",       // 会话测试人员（用于预填）
    fileName: "",
    saveTimer: null,
    view: "setup",           // setup | exec | table | detail | preview
    expandedSheets: {},       // 详情页各分组展开状态
    detailInited: false,      // 详情页是否已做过首次默认展开
    foundTimeOriginal: "",    // 当前用例发现时间基准值（用于修改确认）
    preferTable: false,       // 可执行 Sheet 的视图偏好（表格/卡片）
    lbImages: [],             // 灯箱图片列表
    lbIndex: 0,               // 灯箱当前图片下标
    resultColumns: {},        // sheet -> 结果列表头名列表（测试轮次候选）
    selectedRound: "",        // 当前选中的结果列表头名（全局工作模式）
    filter: emptyFilter(),    // 筛选条件（激活后全局工作集收窄）
    filterOpen: false,        // 筛选面板开合状态
    autoAdvance: true,        // 标记通过/跳过后自动跳下一条（可关，跨会话记忆）
  };

  // 测试结果显示文案与样式
  var RESULT_LABEL = { PASS: "通过", FAIL: "失败", BLOCK: "阻塞", NA: "跳过" };
  var RESULT_CLASS = { PASS: "res-pass", FAIL: "res-fail", BLOCK: "res-block", NA: "res-na" };
  var KIND_LABEL = { functional: "功能", scenario: "场景", matrix: "矩阵", info: "信息" };

  // DOM 引用
  var el = {};
  var IDS = [
    "fileName", "sessionInfo", "execControls", "changeFile", "sheetFilter",
    "roundSelect", "newRoundBtn",
    "filterToggle", "filterPanel", "filterKeyword", "filterIdFrom", "filterIdTo",
    "filterStatuses", "filterRefCol", "filterPriorities", "filterModules",
    "filterSheets", "filterRisks", "filterPresets", "filterSaveBtn",
    "filterClearBtn", "filterCount", "filterEmpty",
    "saveStatus", "progressWrap", "progressFill", "progressText", "loader",
    "setupView", "stageInput", "testerInput", "uploadBtn", "uploadInput",
    "fileList", "setupHint", "startBtn",
    "card", "caseId", "kindTag", "priority", "risk", "moduleTag", "title",
    "scenario", "preconditionSection", "precondition",
    "scenarioSection", "sceneToggle", "sceneArrow", "sceneBody", "sceneDesc", "scenarioImages",
    "stepsSection", "steps", "expectedSection", "expected", "extrasSection",
    "extras", "resultButtons",
    "actual", "foundTime", "stampBtn", "clearTimeBtn", "bugId", "tester",
    "note", "prevBtn", "nextBtn", "navCounter", "jumpNext",
    "viewToggle", "tableToggle", "detailView", "sheetGroups", "detailSummary", "navbar",
    "tableView", "tableTitle", "tableSummary", "tableWrap",
    "previewView", "previewBack", "previewTitle", "previewBody",
    "readerMask", "readerPanel", "readerCol", "readerRow", "readerBody", "readerClose",
    "lightbox", "lbClose", "lbPrev", "lbNext", "lbImg", "lbCounter",
    "helpBtn", "helpOverlay", "helpClose", "moreBtn", "moreMenu",
    "dashboard", "dashTitle", "dashDonut", "dashPct", "dashStats", "dashFails",
    "clearRoundBtn", "confirmOverlay", "confirmDesc", "confirmCancel", "confirmOk",
    "autoAdvanceToggle",
  ];

  function $(id) { return document.getElementById(id); }

  function init() {
    IDS.forEach(function (id) { el[id] = $(id); });
    loadAutoAdvancePref();
    bindEvents();
    loadInitial();
  }

  // 自动跳转偏好：localStorage 跨会话记忆（"0"=关闭，缺省/异常默认开启）
  var AUTO_ADVANCE_KEY = "tcreader.autoAdvance";
  function loadAutoAdvancePref() {
    try {
      state.autoAdvance = localStorage.getItem(AUTO_ADVANCE_KEY) !== "0";
    } catch (e) { /* 隐私模式等场景静默降级 */ }
    if (el.autoAdvanceToggle) el.autoAdvanceToggle.checked = state.autoAdvance;
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    });
  }

  /* ---------- 启动 ---------- */
  function loadInitial() {
    fetchJSON("/api/cases")
      .then(function (res) {
        if (!res.ok) { showError(res.d.error || "加载失败"); return; }
        if (res.d.needsSetup) {
          state.files = res.d.files || [];
          showSetup(res.d.stage, res.d.tester);
          return;
        }
        applyPayload(res.d);
        enterAfterLoad();
      })
      .catch(function (e) { showError("网络错误: " + e.message); });
  }

  function showError(msg) {
    hideAllViews();
    el.loader.classList.remove("hidden");
    el.loader.textContent = msg;
  }

  function applyPayload(d) {
    state.cases = d.cases || [];
    state.progress = d.progress || { done: 0, total: 0 };
    state.sheets = d.sheets || [];
    state.previews = d.previews || [];
    state.previewMap = {};
    state.previews.forEach(function (p) { state.previewMap[p.sheet] = p; });
    state.sessionTester = d.tester || "";
    state.fileName = d.fileName || "";
    state.resultColumns = d.resultColumns || {};
    state.selectedRound = "";   // 换文件后重置，renderRoundSelect 取默认首列
    state.filter = emptyFilter();  // 换文件后筛选清空
    state.filterOpen = false;
    invalidateFilter();
    state.index = 0;
    state.detailInited = false;
    state.expandedSheets = {};

    el.fileName.textContent = d.fileName || "";
    var parts = [];
    if (d.stage) parts.push("阶段: " + d.stage);
    if (d.tester) parts.push("测试人员: " + d.tester);
    el.sessionInfo.textContent = parts.join("  ·  ");
    buildSheetFilter();
    renderRoundSelect();
    renderFilterPanel();
  }

  // 载入后决定进入哪个视图：有可执行用例进执行页，否则若有预览进详情页
  function enterAfterLoad() {
    if (state.cases.length > 0) { showView(state.preferTable ? "table" : "exec"); }
    else if (state.previews.length > 0) { showView("detail"); }
    else { showError("该文件未解析到可执行用例或预览内容"); }
  }

  /* ---------- 初始配置页 ---------- */
  // 测试阶段/测试人员跨会话记忆（localStorage，后端会话缺失时回填）
  var SESSION_PREF_KEY = "tcreader.sessionPrefs";
  function saveSessionPrefs(stage, tester) {
    try {
      localStorage.setItem(SESSION_PREF_KEY, JSON.stringify({ stage: stage || "", tester: tester || "" }));
    } catch (e) { /* 隐私模式等场景静默降级 */ }
  }
  function loadSessionPrefs() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_PREF_KEY)) || {};
    } catch (e) { return {}; }
  }

  function showSetup(stage, tester) {
    fetchJSON("/api/testing-files").then(function (res) {
      if (res.ok) {
        state.files = res.d.files || [];
        if (typeof stage === "undefined") stage = res.d.stage;
        if (typeof tester === "undefined") tester = res.d.tester;
      }
      if (typeof stage !== "undefined" && stage !== null && !el.stageInput.value) el.stageInput.value = stage;
      if (typeof tester !== "undefined" && tester !== null && !el.testerInput.value) el.testerInput.value = tester;
      // 后端会话为空时回填本机上次填写内容
      var prefs = loadSessionPrefs();
      if (!el.stageInput.value && prefs.stage) el.stageInput.value = prefs.stage;
      if (!el.testerInput.value && prefs.tester) el.testerInput.value = prefs.tester;
      // 默认选中当前文件或最新的一个
      if (state.files.length) {
        var cur = res.ok ? res.d.current : null;
        state.selectedFile = cur && findFile(cur) ? cur : state.files[0].name;
      } else {
        state.selectedFile = null;
      }
      renderFileList();
      showView("setup");
    });
  }

  function findFile(name) {
    for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === name) return state.files[i]; }
    return null;
  }

  function renderFileList() {
    el.fileList.innerHTML = "";
    if (!state.files.length) {
      el.setupHint.textContent = "暂无用例文件，请点击上方按钮上传 .xlsx 文件。";
      el.setupHint.className = "setup-hint warn";
      el.startBtn.disabled = true;
      return;
    }
    state.files.forEach(function (f) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "file-item" + (f.name === state.selectedFile ? " selected" : "");
      var nameSpan = document.createElement("span");
      nameSpan.className = "file-item-name";
      nameSpan.textContent = f.name;
      var meta = document.createElement("span");
      meta.className = "file-item-meta";
      meta.textContent = formatSize(f.size) + " · " + formatTime(f.mtime);
      row.appendChild(nameSpan);
      row.appendChild(meta);
      row.addEventListener("click", function () {
        state.selectedFile = f.name;
        renderFileList();
      });
      el.fileList.appendChild(row);
    });
    el.setupHint.textContent = state.selectedFile ? ("已选择：" + state.selectedFile) : "请选择一个用例文件。";
    el.setupHint.className = "setup-hint";
    el.startBtn.disabled = !state.selectedFile;
  }

  function formatSize(n) {
    if (!n) return "0 KB";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function formatTime(sec) {
    if (!sec) return "";
    var d = new Date(sec * 1000);
    function p(x) { return (x < 10 ? "0" : "") + x; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 支持上传的扩展名（非 xlsx 由后端自动转换）
  var UPLOAD_EXTS = [".xlsx", ".xlsm", ".xls", ".csv", ".md", ".xmind"];
  var UPLOAD_LABEL = "xlsx / xlsm / xls / csv / md / xmind";

  function uploadFile() {
    var f = el.uploadInput.files && el.uploadInput.files[0];
    if (!f) return;
    // 本地先校验扩展名：不兼容格式立即红色警告，不发请求
    var dot = f.name.lastIndexOf(".");
    var ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : "";
    if (UPLOAD_EXTS.indexOf(ext) < 0) {
      el.setupHint.textContent = "不支持 " + (ext || "无后缀") + " 格式，当前支持：" + UPLOAD_LABEL;
      el.setupHint.className = "setup-hint warn";
      el.uploadInput.value = "";
      return;
    }
    var fd = new FormData();
    fd.append("file", f);
    el.setupHint.textContent = ext === ".xlsx" ? "正在上传…" : "正在上传并转换为 xlsx…";
    el.setupHint.className = "setup-hint";
    fetchJSON("/api/upload", { method: "POST", body: fd })
      .then(function (res) {
        if (!res.ok) { el.setupHint.textContent = res.d.error || "上传失败"; el.setupHint.className = "setup-hint warn"; return; }
        state.files = res.d.files || [];
        state.selectedFile = res.d.uploaded || (state.files[0] && state.files[0].name);
        renderFileList();
        if (res.d.converted) {
          el.setupHint.textContent = res.d.hint || "已自动转换为 xlsx，原件已备份";
          el.setupHint.className = "setup-hint ok";
        }
      })
      .catch(function () { el.setupHint.textContent = "上传失败"; el.setupHint.className = "setup-hint warn"; })
      .then(function () { el.uploadInput.value = ""; });
  }

  function startTest() {
    if (!state.selectedFile) { el.setupHint.textContent = "请先选择用例文件"; el.setupHint.className = "setup-hint warn"; return; }
    el.startBtn.disabled = true;
    el.setupHint.textContent = "正在加载用例…";
    el.setupHint.className = "setup-hint";
    var payload = {
      fileName: state.selectedFile,
      stage: el.stageInput.value.trim(),
      tester: el.testerInput.value.trim(),
    };
    saveSessionPrefs(payload.stage, payload.tester); // 跨会话记忆（localStorage）
    fetchJSON("/api/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        el.startBtn.disabled = false;
        if (!res.ok) { el.setupHint.textContent = res.d.error || "加载失败"; el.setupHint.className = "setup-hint warn"; return; }
        applyPayload(res.d);
        enterAfterLoad();
      })
      .catch(function (e) { el.startBtn.disabled = false; el.setupHint.textContent = "网络错误: " + e.message; el.setupHint.className = "setup-hint warn"; });
  }

  /* ---------- 视图切换 ---------- */
  function hideAllViews() {
    ["setupView", "card", "tableView", "detailView", "previewView"].forEach(function (k) { el[k].classList.add("hidden"); });
    el.loader.classList.add("hidden");
    el.filterEmpty.classList.add("hidden");
    closeResultMenu();
  }

  function showView(view) {
    state.view = view;
    hideAllViews();
    var isSetup = view === "setup";
    var isExec = view === "exec";
    var isTable = view === "table";
    var isDetail = view === "detail";
    var isPreview = view === "preview";

    el.setupView.classList.toggle("hidden", !isSetup);
    el.card.classList.toggle("hidden", !isExec);
    el.tableView.classList.toggle("hidden", !isTable);
    el.detailView.classList.toggle("hidden", !isDetail);
    el.previewView.classList.toggle("hidden", !isPreview);

    // 宽屏布局：初始页保持窄幅居中，其余视图充分利用大屏宽度
    document.body.classList.toggle("wide-view", !isSetup);

    // 顶栏/进度/导航：初始页隐藏
    el.execControls.classList.toggle("hidden", isSetup);
    el.progressWrap.classList.toggle("hidden", isSetup);
    el.navbar.classList.toggle("hidden", !isExec);

    el.viewToggle.textContent = (isDetail || isPreview) ? "返回执行" : "测试详情";
    el.viewToggle.classList.toggle("active", isDetail || isPreview);
    // 表格/卡片切换仅在执行类视图可用
    el.tableToggle.classList.toggle("hidden", !isExec && !isTable);
    el.tableToggle.textContent = isTable ? "卡片视图" : "表格视图";
    el.tableToggle.classList.toggle("active", isTable);

    if (isExec) {
      // 筛选后可见工作集为空：以空态替代卡片
      if (filterActive() && !visibleIndices().length) { showFilterEmpty(); }
      else { render(); }
    }
    else if (isTable) {
      flushSave();
      if (filterActive() && !visibleIndices().length) { showFilterEmpty(); }
      else { renderTable(); }
    }
    else if (isDetail) {
      flushSave();
      if (!state.detailInited) {
        var cur = state.cases[state.index];
        if (cur) state.expandedSheets[cur.sheet] = true;
        state.detailInited = true;
      }
      renderDetail();
    }
  }

  /* ---------- 执行页渲染 ---------- */
  function render() {
    var c = state.cases[state.index];
    if (!c) return;
    var isScenario = c.kind === "scenario";

    setBadge(el.caseId, c.name || c.caseId, "");
    el.kindTag.textContent = KIND_LABEL[c.kind] || "";
    el.kindTag.className = "badge badge-kind" + (isScenario ? " badge-kind-scene" : "");
    el.kindTag.style.display = el.kindTag.textContent ? "" : "none";
    setBadge(el.priority, c.priority, priorityClass(c.priority));
    setBadge(el.risk, c.risk ? "风险:" + c.risk : "", riskClass(c.risk));
    setBadge(el.moduleTag, c.module, "badge-module");

    // 标题：优先真实用例标题，其次场景名，再次用例名（不再依赖 kind）
    el.title.textContent = c.title || c.scenario || c.name || "(无标题)";
    // 副信息：有独立标题时，把场景名作为补充展示
    el.scenario.textContent = (c.title && c.scenario) ? c.scenario : "";

    // 以下各区块均“有内容则展示”，不再按 kind 隐藏，确保字段完整呈现
    // 前置条件
    el.precondition.textContent = c.precondition || "—";
    el.preconditionSection.classList.toggle("hidden", !c.precondition);

    // 场景讲解：仅当有场景说明(desc)或示意图时展示（不再拿预期结果顶替）
    var sceneText = c.desc || "";
    var hasImgs = !!(c.images && c.images.length);
    renderSceneDesc(sceneText);
    renderScenarioImages(c.images || []);
    el.scenarioSection.classList.toggle("hidden", !sceneText && !hasImgs);
    // 切换用例时默认展开讲解面板
    el.sceneBody.classList.remove("collapsed");
    el.sceneArrow.textContent = "▲";

    // 测试步骤（有内容则展示）
    var hasSteps = !!(c.steps && String(c.steps).trim());
    el.stepsSection.classList.toggle("hidden", !hasSteps);
    if (hasSteps) renderSteps(c.steps);

    // 预期结果（有内容则展示）
    el.expected.textContent = c.expected || "—";
    el.expectedSection.classList.toggle("hidden", !c.expected);

    renderExtras(c.extras || []);

    // 执行区回显（测试结果按当前选中轮次列读取）
    setActiveResult(caseResult(c));
    el.actual.value = c.actual || "";
    el.foundTime.value = c.foundTime || "";
    state.foundTimeOriginal = el.foundTime.value; // 记录基准值用于修改确认
    el.bugId.value = c.bugId || "";
    el.bugId.classList.remove("attn"); // 切换用例时撤去失败登记高亮
    // 测试人员：为空时用会话测试人员预填（可修改）
    el.tester.value = c.tester || state.sessionTester || "";
    el.note.value = c.note || "";

    // 导航状态（筛选激活时在可见工作集内计数与禁用）
    var vis = visibleIndices();
    var pos = vis.indexOf(state.index);
    if (filterActive()) {
      el.navCounter.textContent = (pos >= 0 ? (pos + 1) : "·") + " / " + vis.length + "（筛选中）";
    } else {
      el.navCounter.textContent = (state.index + 1) + " / " + state.cases.length;
    }
    var hasPrev = false, hasNext = false;
    vis.forEach(function (i) {
      if (i < state.index) hasPrev = true;
      else if (i > state.index) hasNext = true;
    });
    el.prevBtn.disabled = !hasPrev;
    el.nextBtn.disabled = !hasNext;
    el.sheetFilter.value = c.sheet;
    updateRoundWarn();
    updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 场景说明结构化渲染：连续编号行归为有序列表，其余按段落展示（不改写原文）
  function renderSceneDesc(text) {
    el.sceneDesc.innerHTML = "";
    var lines = String(text || "").split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (!lines.length) { el.sceneDesc.classList.add("hidden"); return; }
    el.sceneDesc.classList.remove("hidden");
    var numRe = /^[\(（]?\d+[\)）]?[.、)．:：]\s*/;
    var curList = null;
    lines.forEach(function (line) {
      if (numRe.test(line)) {
        if (!curList) {
          curList = document.createElement("ol");
          curList.className = "scene-list";
          el.sceneDesc.appendChild(curList);
        }
        var li = document.createElement("li");
        li.textContent = line.replace(numRe, "");
        curList.appendChild(li);
      } else {
        curList = null;
        var p = document.createElement("p");
        p.className = "scene-para";
        p.textContent = line;
        el.sceneDesc.appendChild(p);
      }
    });
  }

  // 示意图缩略图网格：点击打开灯箱放大预览
  function renderScenarioImages(images) {
    el.scenarioImages.innerHTML = "";
    if (!images || !images.length) { el.scenarioImages.classList.add("hidden"); return; }
    el.scenarioImages.classList.remove("hidden");
    images.forEach(function (src, idx) {
      var thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "scene-thumb";
      thumb.title = "点击放大查看";
      var img = document.createElement("img");
      img.className = "scene-img";
      img.src = src;
      img.alt = "场景示意图 " + (idx + 1);
      thumb.appendChild(img);
      thumb.addEventListener("click", function () { openLightbox(images, idx); });
      el.scenarioImages.appendChild(thumb);
    });
  }

  /* ---------- 图片灯箱 ---------- */
  function openLightbox(images, idx) {
    state.lbImages = images || [];
    state.lbIndex = idx || 0;
    if (!state.lbImages.length) return;
    updateLightbox();
    el.lightbox.classList.remove("hidden");
  }

  function updateLightbox() {
    el.lbImg.src = state.lbImages[state.lbIndex];
    el.lbCounter.textContent = (state.lbIndex + 1) + " / " + state.lbImages.length;
    var multi = state.lbImages.length > 1;
    el.lbPrev.classList.toggle("hidden", !multi);
    el.lbNext.classList.toggle("hidden", !multi);
  }

  function closeLightbox() {
    el.lightbox.classList.add("hidden");
    el.lbImg.src = "";
    state.lbImages = [];
  }

  function lbStep(delta) {
    var n = state.lbImages.length;
    if (!n) return;
    state.lbIndex = (state.lbIndex + delta + n) % n;
    updateLightbox();
  }

  // 渲染未识别为核心字段的额外列（只读）：header -> value 列表
  function renderExtras(extras) {
    el.extras.innerHTML = "";
    if (!extras || !extras.length) { el.extrasSection.classList.add("hidden"); return; }
    el.extrasSection.classList.remove("hidden");
    extras.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "extra-item";
      var k = document.createElement("span");
      k.className = "extra-key";
      k.textContent = item.header;
      var v = document.createElement("div");
      v.className = "extra-val";
      v.textContent = item.value;
      row.appendChild(k);
      row.appendChild(v);
      el.extras.appendChild(row);
    });
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

  // 兼容 PASS/FAIL/NA 以及多行文本（取首个可识别关键字）
  function normalizeResult(result) {
    if (!result) return "";
    var u = String(result).toUpperCase();
    if (u.indexOf("PASS") >= 0 || u.indexOf("通过") >= 0) return "PASS";
    if (u.indexOf("FAIL") >= 0 || u.indexOf("失败") >= 0) return "FAIL";
    if (u.indexOf("BLOCK") >= 0 || u.indexOf("阻塞") >= 0) return "BLOCK";
    if (u.indexOf("NA") >= 0 || u.indexOf("跳过") >= 0) return "NA";
    return "";
  }

  /* ---------- 测试轮次（结果写入列）工作模式 ---------- */
  // 全文件结果列名并集：按 Sheet 原始顺序 + 首次出现列序去重
  function roundOptions() {
    var seen = {};
    var opts = [];
    state.sheets.forEach(function (s) {
      (state.resultColumns[s.name] || []).forEach(function (h) {
        if (!seen[h]) { seen[h] = true; opts.push(h); }
      });
    });
    return opts;
  }

  // 回退解析唯一出口：选中列在该 Sheet 存在则用之，否则回退该 Sheet 首个结果列
  function effectiveColFor(sheet) {
    var colsArr = state.resultColumns[sheet] || [];
    if (state.selectedRound && colsArr.indexOf(state.selectedRound) >= 0) {
      return { name: state.selectedRound, fallback: false };
    }
    return {
      name: colsArr.length ? colsArr[0] : "",
      fallback: !!state.selectedRound && colsArr.length > 0,
    };
  }

  // 按当前轮次读取用例结果；旧负载（无 results）兜底 c.result
  function caseResult(c) {
    var col = effectiveColFor(c.sheet).name;
    if (col && c.results && Object.prototype.hasOwnProperty.call(c.results, col)) {
      return c.results[col];
    }
    return c.result;
  }

  // 按当前轮次写本地内存（与后端 resultColumn 写盘同步）
  function setCaseResult(c, val) {
    var col = effectiveColFor(c.sheet).name;
    if (col) {
      c.results = c.results || {};
      c.results[col] = val;
    } else {
      c.result = val;
    }
    // 状态筛选激活时结果写入会改变匹配口径：仅失效缓存，不移动当前用例
    if (state.filter.statuses.length) invalidateFilter();
  }

  // 渲染顶栏轮次选择器：并集选项 + 默认首列 + 缺失警示
  function renderRoundSelect() {
    if (!el.roundSelect) return;
    var opts = roundOptions();
    var hide = opts.length === 0;
    el.roundSelect.classList.toggle("hidden", hide);
    el.newRoundBtn.classList.toggle("hidden", hide);
    if (hide) return;
    if (!state.selectedRound || opts.indexOf(state.selectedRound) < 0) {
      state.selectedRound = opts[0];
    }
    el.roundSelect.innerHTML = "";
    opts.forEach(function (h) {
      var opt = document.createElement("option");
      opt.value = h;
      opt.textContent = "结果列: " + h;
      el.roundSelect.appendChild(opt);
    });
    el.roundSelect.value = state.selectedRound;
    updateRoundWarn();
  }

  // 当前用例所在 Sheet 缺少选中列时给出黄色警示（写入回退列，不改文件）
  function updateRoundWarn() {
    if (!el.roundSelect) return;
    var c = state.cases[state.index];
    var eff = c ? effectiveColFor(c.sheet) : { name: "", fallback: false };
    el.roundSelect.classList.toggle("round-missing", eff.fallback);
    el.roundSelect.title = eff.fallback
      ? "当前 Sheet 无【" + state.selectedRound + "】列，本页写入【" + eff.name + "】"
      : "选择本轮测试结果写入列";
  }

  // 进度按当前选中列统计；筛选激活时只统计可见工作集
  function computeLocalProgress() {
    var vis = visibleIndices();
    var done = 0;
    vis.forEach(function (i) { if (caseResult(state.cases[i])) done++; });
    state.progress = { done: done, total: vis.length };
  }

  function updateProgress() {
    computeLocalProgress();
    var p = state.progress;
    var pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    el.progressFill.style.width = pct + "%";
    el.progressText.textContent = "已完成 " + p.done + " / " + p.total + " (" + pct + "%)" +
      (filterActive() ? "（筛选）" : "");
    updateFilterBar();
  }

  /* ---------- 用例筛选（筛选工作集模式，纯前端） ---------- */
  var visCache = null;   // visibleIndices 缓存（筛选条件/数据/口径变更时置空）
  var FILTER_PRESET_KEY = "tcreader.filterPresets";
  var STATUS_CHIP_DEFS = [
    { val: "PASS", label: "通过" },
    { val: "FAIL", label: "失败" },
    { val: "BLOCK", label: "阻塞" },
    { val: "NA", label: "跳过" },
    { val: "UNTESTED", label: "未测" },
  ];
  var BUILTIN_PRESETS = [
    { name: "冒烟测试(P0)", kind: "p0" },
    { name: "复测(失败+跳过)", kind: "retest" },
  ];

  function emptyFilter() {
    return { keyword: "", idFrom: "", idTo: "", statuses: [],
             refCol: "", priorities: [], modules: [], sheets: [], risks: [] };
  }

  function filterActive() {
    var f = state.filter;
    return !!(f.keyword || f.idFrom || f.idTo || f.statuses.length ||
              f.priorities.length || f.modules.length || f.sheets.length || f.risks.length);
  }

  // 激活的条件组数（顶栏按钮角标）
  function filterCondCount() {
    var f = state.filter;
    var n = 0;
    if (f.keyword) n++;
    if (f.idFrom || f.idTo) n++;
    if (f.statuses.length) n++;
    if (f.priorities.length) n++;
    if (f.modules.length) n++;
    if (f.sheets.length) n++;
    if (f.risks.length) n++;
    return n;
  }

  function invalidateFilter() { visCache = null; }

  // 某 Sheet 的全量用例数（表格摘要"筛选自 N"用）
  function countSheetCases(sheet) {
    var n = 0;
    state.cases.forEach(function (c) { if (c.sheet === sheet) n++; });
    return n;
  }

  // 状态筛选参照列取值：默认跟随当前轮次；指定列在该 Sheet 缺失时回退首个结果列
  function resultOfRef(c) {
    var ref = state.filter.refCol;
    if (!ref) return caseResult(c);
    var colsArr = state.resultColumns[c.sheet] || [];
    var col = colsArr.indexOf(ref) >= 0 ? ref : (colsArr.length ? colsArr[0] : "");
    if (col && c.results && Object.prototype.hasOwnProperty.call(c.results, col)) {
      return c.results[col];
    }
    return c.result;
  }

  // 提取字符串末尾数字（编号范围比较用），无数字返回 null
  function trailingNum(s) {
    var m = /(\d+)(?!.*\d)/.exec(String(s || ""));
    return m ? parseInt(m[1], 10) : null;
  }

  function matchesFilter(c) {
    var f = state.filter;
    if (f.sheets.length && f.sheets.indexOf(c.sheet) < 0) return false;
    if (f.modules.length && f.modules.indexOf(String(c.module || "").trim()) < 0) return false;
    if (f.priorities.length && f.priorities.indexOf(String(c.priority || "").trim()) < 0) return false;
    if (f.risks.length && f.risks.indexOf(String(c.risk || "").trim()) < 0) return false;
    if (f.statuses.length) {
      var raw = resultOfRef(c);
      var norm = normalizeResult(raw);
      var hit = norm ? f.statuses.indexOf(norm) >= 0
                     : (!String(raw || "").trim() && f.statuses.indexOf("UNTESTED") >= 0);
      if (!hit) return false;
    }
    var lo = trailingNum(f.idFrom);
    var hi = trailingNum(f.idTo);
    if (lo !== null || hi !== null) {
      var n = trailingNum(c.caseId);
      if (n === null) return false;
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
    }
    if (f.keyword) {
      var kw = f.keyword.toLowerCase();
      var hay = [c.caseId, c.title, c.scenario, c.module, c.desc,
                 c.steps, c.expected, c.note].join("\n").toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  }

  // 通过筛选的 state.cases 下标数组（无筛选时为全量），带缓存
  function visibleIndices() {
    if (visCache) return visCache;
    var out = [];
    var active = filterActive();
    state.cases.forEach(function (c, i) {
      if (!active || matchesFilter(c)) out.push(i);
    });
    visCache = out;
    return out;
  }

  // 顶栏按钮角标与面板匹配计数
  function updateFilterBar() {
    if (!el.filterToggle) return;
    var n = filterCondCount();
    el.filterToggle.textContent = n ? ("筛选·" + n) : "筛选";
    el.filterToggle.classList.toggle("active", n > 0);
    el.filterCount.textContent = filterActive()
      ? ("匹配 " + visibleIndices().length + " / " + state.cases.length + " 条")
      : ("共 " + state.cases.length + " 条");
  }

  // 筛选条件变更统一入口：冲刷编辑、失效缓存、校正当前用例、按视图重渲染
  function applyFilter() {
    flushSave();
    invalidateFilter();
    var vis = visibleIndices();
    if (vis.length && vis.indexOf(state.index) < 0) {
      state.index = vis[0];   // 新筛选下当前用例不可见：定位到首个匹配用例
    }
    updateFilterBar();
    refreshCurrentView();
  }

  function refreshCurrentView() {
    if (state.view === "exec" || state.view === "table") { showView(state.view); }
    else if (state.view === "detail") { renderDetail(); updateProgress(); }
    else { updateProgress(); }
  }

  // 筛选空态：可见工作集为空时替代卡片/表格展示
  function showFilterEmpty() {
    el.card.classList.add("hidden");
    el.tableView.classList.add("hidden");
    el.navbar.classList.add("hidden");
    el.filterEmpty.classList.remove("hidden");
    updateProgress();
  }

  /* ---------- 筛选面板渲染 ---------- */
  // 从当前用例聚合去重（保持首次出现顺序）
  function distinctValues(field) {
    var seen = {}, out = [];
    state.cases.forEach(function (c) {
      var v = String(c[field] || "").trim();
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  function toggleInArr(arr, val) {
    var i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1); else arr.push(val);
  }

  // 可切换选中态的筛选胶囊：label 展示、val 存入 selectedArr
  function appendChip(container, label, selectedArr, val) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip" + (selectedArr.indexOf(val) >= 0 ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", function () {
      toggleInArr(selectedArr, val);
      chip.classList.toggle("selected");
      applyFilter();
    });
    container.appendChild(chip);
  }

  // 值列表渲染为一组 chips；无数据时整组（外层 .filter-group）隐藏
  function fillChipGroup(container, values, selectedArr) {
    container.innerHTML = "";
    values.forEach(function (v) { appendChip(container, v, selectedArr, v); });
    container.parentElement.classList.toggle("hidden", !values.length);
  }

  function renderFilterPanel() {
    if (!el.filterPanel) return;
    var f = state.filter;
    el.filterKeyword.value = f.keyword;
    el.filterIdFrom.value = f.idFrom;
    el.filterIdTo.value = f.idTo;

    // 状态 chips（固定五项）
    el.filterStatuses.innerHTML = "";
    STATUS_CHIP_DEFS.forEach(function (d) {
      appendChip(el.filterStatuses, d.label, f.statuses, d.val);
    });

    // 参照列下拉：首项跟随当前轮次
    var rounds = roundOptions();
    if (f.refCol && rounds.indexOf(f.refCol) < 0) f.refCol = "";
    el.filterRefCol.innerHTML = "";
    var follow = document.createElement("option");
    follow.value = "";
    follow.textContent = "跟随当前轮次";
    el.filterRefCol.appendChild(follow);
    rounds.forEach(function (h) {
      var opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      el.filterRefCol.appendChild(opt);
    });
    el.filterRefCol.value = f.refCol;
    el.filterRefCol.parentElement.classList.toggle("hidden", !rounds.length);

    fillChipGroup(el.filterPriorities, distinctValues("priority"), f.priorities);
    fillChipGroup(el.filterRisks, distinctValues("risk"), f.risks);
    fillChipGroup(el.filterModules, distinctValues("module"), f.modules);

    // Sheet chips：展示 sheetTitle，值取 sheet 名
    el.filterSheets.innerHTML = "";
    var seenSheet = {};
    state.cases.forEach(function (c) {
      if (seenSheet[c.sheet]) return;
      seenSheet[c.sheet] = true;
      appendChip(el.filterSheets, c.sheetTitle || c.sheet, f.sheets, c.sheet);
    });
    el.filterSheets.parentElement.classList.toggle("hidden", !Object.keys(seenSheet).length);

    renderPresetChips();
    updateFilterBar();
    el.filterPanel.classList.toggle("hidden", !state.filterOpen);
  }

  /* ---------- 筛选预设（localStorage + 内置） ---------- */
  function loadUserPresets() {
    try { return JSON.parse(localStorage.getItem(FILTER_PRESET_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveUserPresets(list) {
    try { localStorage.setItem(FILTER_PRESET_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // 内置预设在应用时按当前文件动态解析
  function builtinFilter(kind) {
    var f = emptyFilter();
    if (kind === "p0") {
      f.priorities = distinctValues("priority").filter(function (v) {
        return v.toUpperCase().indexOf("P0") >= 0;
      });
    } else if (kind === "retest") {
      f.statuses = ["FAIL", "NA"];
    }
    return f;
  }

  // 应用已存预设：清洗掉当前文件不存在的选项值后整体替换
  function applyPresetFilter(saved) {
    var f = emptyFilter();
    Object.keys(f).forEach(function (k) {
      if (saved && typeof saved[k] !== "undefined") f[k] = saved[k];
    });
    var pri = distinctValues("priority");
    var mod = distinctValues("module");
    var rk = distinctValues("risk");
    var sheetSet = {};
    state.cases.forEach(function (c) { sheetSet[c.sheet] = true; });
    f.priorities = (f.priorities || []).filter(function (v) { return pri.indexOf(v) >= 0; });
    f.modules = (f.modules || []).filter(function (v) { return mod.indexOf(v) >= 0; });
    f.risks = (f.risks || []).filter(function (v) { return rk.indexOf(v) >= 0; });
    f.sheets = (f.sheets || []).filter(function (v) { return !!sheetSet[v]; });
    f.statuses = (f.statuses || []).filter(function (v) {
      return STATUS_CHIP_DEFS.some(function (d) { return d.val === v; });
    });
    if (roundOptions().indexOf(f.refCol) < 0) f.refCol = "";
    state.filter = f;
    renderFilterPanel();
    applyFilter();
  }

  function renderPresetChips() {
    el.filterPresets.innerHTML = "";
    BUILTIN_PRESETS.forEach(function (p) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip preset-chip preset-builtin";
      chip.textContent = p.name;
      chip.title = "应用内置预设";
      chip.addEventListener("click", function () { applyPresetFilter(builtinFilter(p.kind)); });
      el.filterPresets.appendChild(chip);
    });
    loadUserPresets().forEach(function (p, idx) {
      var wrap = document.createElement("span");
      wrap.className = "filter-chip preset-chip";
      var applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "preset-apply";
      applyBtn.textContent = p.name;
      applyBtn.title = "应用预设";
      applyBtn.addEventListener("click", function () { applyPresetFilter(p.filter); });
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "preset-del";
      delBtn.textContent = "×";
      delBtn.title = "删除预设";
      delBtn.addEventListener("click", function () {
        var list = loadUserPresets();
        list.splice(idx, 1);
        saveUserPresets(list);
        renderPresetChips();
      });
      wrap.appendChild(applyBtn);
      wrap.appendChild(delBtn);
      el.filterPresets.appendChild(wrap);
    });
  }

  function savePresetFromCurrent() {
    if (!filterActive()) { setSaveStatus("请先设置筛选条件", "error"); return; }
    var name = window.prompt("预设名称（同名将覆盖）：", "");
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    var snapshot = JSON.parse(JSON.stringify(state.filter));
    var list = loadUserPresets();
    var found = false;
    list.forEach(function (p) { if (p.name === name) { p.filter = snapshot; found = true; } });
    if (!found) list.push({ name: name, filter: snapshot });
    saveUserPresets(list);
    renderPresetChips();
    setSaveStatus("预设已保存 ✓", "ok");
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
    // 预览页（矩阵/信息）也可从下拉直达
    if (state.previews.length) {
      var group = document.createElement("optgroup");
      group.label = "场景测试与其他";
      state.previews.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = p.sheet;
        opt.textContent = p.title || p.sheet;
        group.appendChild(opt);
      });
      el.sheetFilter.appendChild(group);
    }
  }

  function jumpToSheet(sheet) {
    // 预览页（矩阵/信息）直接打开预览
    if (state.previewMap[sheet]) { flushSave(); openPreview(sheet); return; }
    // 只在可见工作集内定位该 Sheet 首个用例
    var vis = visibleIndices();
    for (var k = 0; k < vis.length; k++) {
      var i = vis[k];
      if (state.cases[i].sheet === sheet) {
        // 表格视图内切换 Sheet 时保持表格视图
        if (state.view === "table") { state.index = i; renderTable(); }
        else { openCase(i); }
        return;
      }
    }
    if (filterActive()) {
      setSaveStatus("当前筛选下该 Sheet 无匹配用例", "error");
      var cur = state.cases[state.index];
      if (cur) el.sheetFilter.value = cur.sheet;   // 下拉回弹到当前位置
    }
  }

  function jumpToNextUntested() {
    var vis = visibleIndices();
    if (!vis.length) { setSaveStatus("当前筛选下无用例", "error"); return; }
    var pos = vis.indexOf(state.index);   // 不在可见集时从头找起
    for (var k = 1; k <= vis.length; k++) {
      var i = vis[(pos + k + vis.length) % vis.length];
      if (!normalizeResult(caseResult(state.cases[i]))) {
        if (state.view === "table") { state.index = i; renderTable(); }
        else { openCase(i); }
        return;
      }
    }
    setSaveStatus(filterActive() ? "筛选内用例已全部完成 🎉" : "全部用例已完成 🎉", "ok");
  }

  /* ---------- 结果胶囊与弹出菜单（表格视图 / 矩阵预览共用） ---------- */
  var resultMenu = null;       // 共享 popover 菜单元素
  var resultMenuAnchor = null; // 当前锚点胶囊（用于外部点击判定）

  // 创建结果胶囊按钮：展示当前结果，点击弹出选择菜单
  function makeResultPill(rawResult, onSelect) {
    var pill = document.createElement("button");
    pill.type = "button";
    applyPillState(pill, rawResult);
    pill.addEventListener("click", function (e) {
      e.stopPropagation();
      openResultMenu(pill, function (val) {
        onSelect(val, pill);
      });
    });
    return pill;
  }

  // 按结果值更新胶囊文案与配色（未识别的非空文本原样展示为中性色）
  function applyPillState(pill, rawResult) {
    var norm = normalizeResult(rawResult);
    var text = norm ? RESULT_LABEL[norm] : (String(rawResult || "").trim() || "未测");
    pill.className = "result-pill " + (norm ? RESULT_CLASS[norm] : (rawResult ? "res-other" : "res-none"));
    pill.textContent = text;
    pill.title = "点击修改测试结果";
  }

  function openResultMenu(anchor, onSelect) {
    if (resultMenuAnchor === anchor) { closeResultMenu(); return; }
    closeResultMenu();
    resultMenuAnchor = anchor;
    resultMenu = document.createElement("div");
    resultMenu.className = "result-menu";
    var options = [
      { val: "PASS", label: "通过", cls: "res-pass" },
      { val: "FAIL", label: "失败", cls: "res-fail" },
      { val: "BLOCK", label: "阻塞", cls: "res-block" },
      { val: "NA", label: "跳过", cls: "res-na" },
      { val: "", label: "清除", cls: "res-none" },
    ];
    options.forEach(function (o) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "result-menu-item " + o.cls;
      item.textContent = o.label;
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        closeResultMenu();
        onSelect(o.val);
      });
      resultMenu.appendChild(item);
    });
    document.body.appendChild(resultMenu);
    // 定位到锚点下方（视口底部放不下时翻到上方）
    var rect = anchor.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + resultMenu.offsetHeight > window.innerHeight - 8) {
      top = rect.top - resultMenu.offsetHeight - 6;
    }
    var left = Math.min(rect.left, window.innerWidth - resultMenu.offsetWidth - 8);
    resultMenu.style.top = (top + window.scrollY) + "px";
    resultMenu.style.left = (left + window.scrollX) + "px";
  }

  function closeResultMenu() {
    if (resultMenu && resultMenu.parentNode) resultMenu.parentNode.removeChild(resultMenu);
    resultMenu = null;
    resultMenuAnchor = null;
  }

  /* ---------- 表格视图（当前 Sheet 用例总览） ---------- */
  function renderTable() {
    var cur = state.cases[state.index];
    if (!cur) return;
    var sheet = cur.sheet;
    // 筛选激活时只列可见用例
    var vis = visibleIndices();
    var items = [];
    vis.forEach(function (i) {
      var c = state.cases[i];
      if (c.sheet === sheet) items.push({ c: c, index: i });
    });

    el.tableTitle.textContent = cur.sheetTitle || sheet;
    var done = 0;
    items.forEach(function (it) { if (normalizeResult(caseResult(it.c))) done++; });
    el.tableSummary.textContent = "共 " + items.length + " 条用例" +
      (filterActive() ? "（筛选自 " + countSheetCases(sheet) + "）" : "") +
      " · 已完成 " + done + " · 点击编号/标题可进入卡片精确执行";

    el.tableWrap.innerHTML = "";
    var table = document.createElement("table");
    table.className = "case-table";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    // 结果列表头显示当前有效写入列名（轮次工作模式）
    var effName = effectiveColFor(sheet).name || "测试结果";
    ["编号", "标题 / 场景", "模块", "优先级", effName, "备注"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    // 编号列去重：该 Sheet 无独立编号（编号全部与标题相同）时以行号代替，避免两列重复
    var hasRealId = false;
    items.forEach(function (it) {
      var idText = it.c.caseId || it.c.name || "";
      if (idText && idText !== (it.c.title || it.c.scenario || "")) hasRealId = true;
    });
    items.forEach(function (it, seq) {
      var c = it.c;
      var tr = document.createElement("tr");
      if (it.index === state.index) tr.className = "current";
      if (!normalizeResult(caseResult(c))) tr.classList.add("untested");

      var tdId = document.createElement("td");
      tdId.className = "ct-id";
      var idBtn = document.createElement("button");
      idBtn.type = "button";
      idBtn.className = "ct-link";
      var idText = hasRealId ? (c.caseId || c.name || "(无编号)") : "#" + (seq + 1);
      idBtn.textContent = idText;
      idBtn.title = idText + " · 点击进入卡片视图执行";
      idBtn.addEventListener("click", function () { openCase(it.index); });
      tdId.appendChild(idBtn);
      tr.appendChild(tdId);

      var tdTitle = document.createElement("td");
      tdTitle.className = "ct-title";
      var titleBtn = document.createElement("button");
      titleBtn.type = "button";
      titleBtn.className = "ct-link";
      titleBtn.textContent = c.title || c.scenario || "(无标题)";
      titleBtn.title = "进入卡片视图执行该用例";
      titleBtn.addEventListener("click", function () { openCase(it.index); });
      tdTitle.appendChild(titleBtn);
      tr.appendChild(tdTitle);

      var tdModule = document.createElement("td");
      tdModule.className = "ct-module";
      tdModule.textContent = c.module || "";
      tr.appendChild(tdModule);

      var tdPri = document.createElement("td");
      tdPri.className = "ct-pri";
      tdPri.textContent = c.priority || "";
      tr.appendChild(tdPri);

      var tdRes = document.createElement("td");
      tdRes.className = "ct-res";
      var pill = makeResultPill(caseResult(c), function (val, pillEl) {
        saveCaseResult(it.index, val, pillEl, tr);
      });
      tdRes.appendChild(pill);
      tr.appendChild(tdRes);

      var tdNote = document.createElement("td");
      tdNote.className = "ct-note";
      var noteText = c.note || "";
      if (noteText.trim().length > LONG_TEXT_MIN) {
        // 长备注：与预览页同套 3 行折叠 + 全文侧栏
        fillLongTextCell(tdNote, noteText, "备注", c.caseId || c.title || c.name || "");
      } else {
        tdNote.textContent = noteText;
        tdNote.title = noteText;
      }
      tr.appendChild(tdNote);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.tableWrap.appendChild(table);

    el.sheetFilter.value = sheet;
    updateRoundWarn();
    updateProgress();
  }

  // 表格视图行内标记结果：乐观更新胶囊，失败回滚（读写均按当前轮次列）
  function saveCaseResult(caseIndex, result, pillEl, rowEl) {
    var c = state.cases[caseIndex];
    if (!c) return;
    var eff = effectiveColFor(c.sheet);
    var prev = caseResult(c);
    setCaseResult(c, result);
    applyPillState(pillEl, result);
    rowEl.classList.toggle("untested", !normalizeResult(result));
    setSaveStatus("正在保存…", "saving");
    patchCase({ sheet: c.sheet, rowIndex: c.rowIndex, expectedName: c.name,
                result: result, resultColumn: eff.name || undefined },
      function () {
        // 完成数与表格同口径（筛选激活时只统计可见用例）
        var items = [];
        visibleIndices().forEach(function (i) {
          if (state.cases[i].sheet === c.sheet) items.push(state.cases[i]);
        });
        var doneNow = 0;
        items.forEach(function (x) { if (normalizeResult(caseResult(x))) doneNow++; });
        el.tableSummary.textContent = "共 " + items.length + " 条用例" +
          (filterActive() ? "（筛选自 " + countSheetCases(c.sheet) + "）" : "") +
          " · 已完成 " + doneNow + " · 点击编号/标题可进入卡片精确执行";
      },
      function () {
        setCaseResult(c, prev);
        applyPillState(pillEl, prev);
        rowEl.classList.toggle("untested", !normalizeResult(prev));
      });
  }

  // 通用 PATCH 写回：成功后刷新进度，失败回调 onFail 回滚
  function patchCase(payload, onOk, onFail) {
    fetchJSON("/api/cases", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) {
          setSaveStatus(res.d && res.d.error ? res.d.error : "保存失败", "error");
          if (onFail) onFail();
          return;
        }
        // 进度改为前端按选中轮次列本地统计，后端 progress（主列口径）不再采用
        updateProgress();
        setSaveStatus("已保存 ✓", "ok");
        if (onOk) onOk();
      })
      .catch(function () {
        setSaveStatus("保存失败", "error");
        if (onFail) onFail();
      });
  }

  /* ---------- 测试详情页 ---------- */
  /* ---------- 轮次执行仪表盘（详情页顶部，纯前端聚合，口径=当前筛选工作集） ---------- */
  function renderDashboard() {
    var vis = visibleIndices();
    var total = vis.length;
    el.dashboard.classList.toggle("hidden", !total);
    if (!total) return;

    var counts = { PASS: 0, FAIL: 0, BLOCK: 0, NA: 0 };
    var done = 0;
    var failMods = {};
    vis.forEach(function (i) {
      var c = state.cases[i];
      var raw = caseResult(c);
      if (raw) done++; // 与进度条同口径：有任意结果值即完成
      var norm = normalizeResult(raw);
      if (norm) counts[norm]++;
      if (norm === "FAIL") {
        var m = c.module || c.sheetTitle || c.sheet || "(未分组)";
        failMods[m] = (failMods[m] || 0) + 1;
      }
    });
    var untested = total - done;

    el.dashTitle.textContent = "执行概览 · 结果列: " + (state.selectedRound || "默认") +
      (filterActive() ? "（筛选中）" : "");

    // 环形图：四态 + 未测灰，conic-gradient 纯 CSS 绘制
    var stops = [];
    var acc = 0;
    [[counts.PASS, "var(--pass)"], [counts.FAIL, "var(--fail)"],
     [counts.BLOCK, "var(--block)"], [counts.NA, "var(--na)"]].forEach(function (seg) {
      if (!seg[0]) return;
      var from = (acc / total) * 100;
      acc += seg[0];
      stops.push(seg[1] + " " + from + "% " + (acc / total) * 100 + "%");
    });
    stops.push("#e7ebf3 " + (acc / total) * 100 + "% 100%");
    el.dashDonut.style.background = "conic-gradient(" + stops.join(", ") + ")";
    el.dashPct.textContent = Math.round((done / total) * 100) + "%";

    // 四态 + 未测数量胶囊（颜色与全局结果色板一致）
    el.dashStats.innerHTML = "";
    [["通过", counts.PASS, "res-pass"], ["失败", counts.FAIL, "res-fail"],
     ["阻塞", counts.BLOCK, "res-block"], ["跳过", counts.NA, "res-na"],
     ["未测", untested, "res-none"]].forEach(function (s) {
      var chip = document.createElement("span");
      chip.className = "dash-stat " + s[2];
      chip.textContent = s[0] + " " + s[1];
      el.dashStats.appendChild(chip);
    });

    // 失败集中模块 TOP5 条形图
    el.dashFails.innerHTML = "";
    var mods = Object.keys(failMods)
      .map(function (m) { return { name: m, n: failMods[m] }; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 5);
    var ft = document.createElement("div");
    ft.className = "dash-fails-title";
    ft.textContent = mods.length ? "失败集中模块 TOP" + mods.length : "失败分布";
    el.dashFails.appendChild(ft);
    if (!mods.length) {
      var okMsg = document.createElement("div");
      okMsg.className = "dash-fails-empty";
      okMsg.textContent = "本轮暂无失败用例";
      el.dashFails.appendChild(okMsg);
    } else {
      var max = mods[0].n;
      mods.forEach(function (m) {
        var row = document.createElement("div");
        row.className = "dash-fail-row";
        var name = document.createElement("span");
        name.className = "dash-fail-name";
        name.textContent = m.name;
        name.title = m.name;
        var bar = document.createElement("span");
        bar.className = "dash-fail-bar";
        var fill = document.createElement("span");
        fill.className = "dash-fail-fill";
        fill.style.width = Math.round((m.n / max) * 100) + "%";
        bar.appendChild(fill);
        var num = document.createElement("span");
        num.className = "dash-fail-num";
        num.textContent = m.n;
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(num);
        el.dashFails.appendChild(row);
      });
    }
  }

  function renderDetail() {
    var container = el.sheetGroups;
    container.innerHTML = "";

    // 可执行用例按 Sheet 归组（筛选激活时只列可见用例，0 匹配的组自动跳过）
    var caseMap = {};
    visibleIndices().forEach(function (i) {
      var c = state.cases[i];
      if (!caseMap[c.sheet]) caseMap[c.sheet] = [];
      caseMap[c.sheet].push({ c: c, index: i });
    });

    var execGroups = 0;
    computeLocalProgress();
    var p = state.progress;
    renderDashboard();

    // 可执行组置顶（按原 Sheet 顺序）；只读预览组收在"参考资料"分区尾部
    state.sheets.forEach(function (s) {
      if (caseMap[s.name]) {
        execGroups++;
        container.appendChild(buildCaseGroup(s, caseMap[s.name]));
      }
    });
    var previewSheets = state.sheets.filter(function (s) {
      return !caseMap[s.name] && state.previewMap[s.name];
    });
    if (previewSheets.length) {
      var refTitle = document.createElement("div");
      refTitle.className = "sg-ref-title";
      refTitle.textContent = "参考资料（只读预览）";
      container.appendChild(refTitle);
      previewSheets.forEach(function (s) { container.appendChild(buildPreviewGroup(s)); });
    }

    el.detailSummary.textContent = "共 " + state.sheets.length + " 个 Sheet · 可执行 " +
      execGroups + " 组 · 已完成 " + p.done + " / " + p.total +
      (filterActive() ? "（筛选中）" : "");
  }

  function buildCaseGroup(sheetMeta, items) {
    var done = 0;
    items.forEach(function (it) { if (normalizeResult(caseResult(it.c))) done++; });
    var expanded = !!state.expandedSheets[sheetMeta.name];

    var groupEl = document.createElement("div");
    groupEl.className = "sheet-group";

    var header = document.createElement("button");
    header.type = "button";
    header.className = "sheet-group-header" + (expanded ? " expanded" : "");
    var arrow = document.createElement("span");
    arrow.className = "sg-arrow";
    arrow.textContent = expanded ? "▲" : "▼";
    var titleSpan = document.createElement("span");
    titleSpan.className = "sg-title";
    titleSpan.textContent = sheetMeta.title || sheetMeta.name;
    var countSpan = document.createElement("span");
    countSpan.className = "sg-count";
    countSpan.textContent = done + " / " + items.length;
    header.appendChild(arrow);
    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    header.addEventListener("click", function () {
      state.expandedSheets[sheetMeta.name] = !expanded;
      renderDetail();
    });
    groupEl.appendChild(header);

    if (expanded) {
      var list = document.createElement("div");
      list.className = "sg-list";
      items.forEach(function (it) {
        var norm = normalizeResult(caseResult(it.c));
        var row = document.createElement("button");
        row.type = "button";
        row.className = "sg-case" + (it.index === state.index ? " current" : "");
        var idSpan = document.createElement("span");
        idSpan.className = "sg-case-id";
        idSpan.textContent = it.c.name || it.c.caseId || "(无编号)";
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
    return groupEl;
  }

  function buildPreviewGroup(sheetMeta) {
    var groupEl = document.createElement("div");
    groupEl.className = "sheet-group";
    var header = document.createElement("button");
    header.type = "button";
    header.className = "sheet-group-header preview-group";
    var arrow = document.createElement("span");
    arrow.className = "sg-arrow";
    arrow.textContent = "»";
    var titleSpan = document.createElement("span");
    titleSpan.className = "sg-title";
    titleSpan.textContent = sheetMeta.title || sheetMeta.name;
    var tag = document.createElement("span");
    tag.className = "sg-count sg-readonly";
    tag.textContent = "只读预览 · " + (KIND_LABEL[sheetMeta.kind] || "");
    header.appendChild(arrow);
    header.appendChild(titleSpan);
    header.appendChild(tag);
    header.addEventListener("click", function () { openPreview(sheetMeta.name); });
    groupEl.appendChild(header);
    return groupEl;
  }

  /* ---------- 表格长文本：3 行折叠 + 聚焦阅读侧栏 ---------- */
  var LONG_TEXT_MIN = 60;   // 超过此长度的单元格折叠为 3 行
  var LONG_COL_MIN = 30;    // 列内最大长度超过此值视为长文本列（加宽）
  var readerFocusRow = null; // 侧栏打开时高亮的行

  // 长文本单元格：默认 3 行折叠，单击展开/收起，角标打开全文侧栏
  function fillLongTextCell(cell, text, colName, rowLabel) {
    var box = document.createElement("div");
    box.className = "pv-clamp";
    var span = document.createElement("span");
    span.className = "pv-clamp-text";
    span.textContent = text;
    box.appendChild(span);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pv-full-btn";
    btn.textContent = "⤢";
    btn.title = "查看全文";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openReader(colName, rowLabel, text, cell.parentElement);
    });
    box.appendChild(btn);
    cell.classList.add("pv-longcell");
    cell.title = "单击展开 / 收起";
    cell.addEventListener("click", function () {
      cell.classList.toggle("pv-expanded");
    });
    cell.addEventListener("dblclick", function () {
      openReader(colName, rowLabel, text, cell.parentElement);
    });
    cell.appendChild(box);
  }

  // 聚焦阅读侧栏：单焦点展示列名 + 行上下文 + 全文
  function openReader(colName, rowLabel, text, rowEl) {
    closeReader();
    el.readerCol.textContent = colName || "内容";
    el.readerRow.textContent = rowLabel || "";
    el.readerBody.textContent = text;
    el.readerMask.classList.remove("hidden");
    el.readerPanel.classList.remove("hidden");
    if (rowEl && rowEl.tagName === "TR") {
      rowEl.classList.add("row-focus");
      readerFocusRow = rowEl;
    }
  }

  function closeReader() {
    el.readerMask.classList.add("hidden");
    el.readerPanel.classList.add("hidden");
    if (readerFocusRow) { readerFocusRow.classList.remove("row-focus"); readerFocusRow = null; }
  }

  /* ---------- 预览页（矩阵各结果列可行内编辑，其余只读） ---------- */
  function openPreview(sheet) {
    var pv = state.previewMap[sheet];
    if (!pv) return;
    // 兼容旧后端负载：无 resultCols 时回退到单结果列 resultCol
    var resultCols = pv.resultCols || (pv.resultCol ? [pv.resultCol] : []);
    var editable = resultCols.length > 0;
    el.previewTitle.textContent = (pv.title || pv.sheet) + (editable ? "（结果可编辑）" : "（只读预览）");
    el.previewBody.innerHTML = "";

    var rows = pv.rows || [];
    if (rows.length) {
      var wrap = document.createElement("div");
      wrap.className = "preview-table-wrap";
      var table = document.createElement("table");
      table.className = "preview-table";
      var headerRow = pv.headerRow || (rows[0] && rows[0].r) || 1;
      // 可编辑结果列的 cells 数组下标集合（每列对应不同测试条件）
      var editIdx = {};
      resultCols.forEach(function (col) { editIdx[col - 1] = true; });

      // 扫描各列最大文本长度与表头名：长文本列加宽，避免“一字一行”
      var colMax = [];
      var colNames = [];
      rows.forEach(function (row) {
        row.cells.forEach(function (val, cIdx) {
          var len = String(val || "").length;
          if (!colMax[cIdx] || len > colMax[cIdx]) colMax[cIdx] = len;
          if (row.r <= headerRow && !colNames[cIdx] && String(val).trim()) {
            colNames[cIdx] = String(val).trim();
          }
        });
      });

      rows.forEach(function (row) {
        var isHeader = row.r <= headerRow;
        var tr = document.createElement("tr");
        // 行上下文：首个非空单元格（与写回行指纹同口径）
        var rowLabel = "";
        for (var i = 0; i < row.cells.length; i++) {
          if (String(row.cells[i]).trim()) { rowLabel = String(row.cells[i]).trim(); break; }
        }
        row.cells.forEach(function (val, cIdx) {
          var cell = document.createElement(isHeader ? "th" : "td");
          if (colMax[cIdx] > LONG_COL_MIN) cell.classList.add("pv-col-long");
          if (!isHeader && editIdx[cIdx]) {
            // 结果列：状态胶囊 + 弹出菜单行内编辑
            cell.className = "pv-res-cell";
            var pill = makeResultPill(val, function (newVal, pillEl) {
              saveMatrixResult(pv, row, cIdx, newVal, pillEl);
            });
            cell.appendChild(pill);
          } else if (!isHeader && String(val).trim().length > LONG_TEXT_MIN) {
            // 长文本：3 行折叠 + 全文侧栏
            fillLongTextCell(cell, val, colNames[cIdx], rowLabel);
          } else {
            cell.textContent = val;
            // 非编辑列中的结果关键字也着色，提升矩阵可读性
            var norm = normalizeResult(val);
            if (!isHeader && norm && String(val).trim().length <= 6) {
              cell.className = "pv-res-text " + RESULT_CLASS[norm];
            }
          }
          tr.appendChild(cell);
        });
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      el.previewBody.appendChild(wrap);

      if (editable) {
        var hint = document.createElement("div");
        hint.className = "preview-hint";
        hint.textContent = "提示：各结果列（对应不同测试条件）均可点击胶囊标记 通过 / 失败 / 阻塞 / 跳过，修改实时写回 Excel。";
        el.previewBody.appendChild(hint);
      }
    }

    var images = pv.images || [];
    if (images.length) {
      var gallery = document.createElement("div");
      gallery.className = "preview-gallery";
      var gh = document.createElement("h2");
      gh.className = "section-title";
      gh.textContent = "示意图 (" + images.length + ")";
      el.previewBody.appendChild(gh);
      var urls = images.map(function (im) { return im.dataUrl; });
      images.forEach(function (im, idx) {
        var fig = document.createElement("figure");
        fig.className = "preview-fig";
        var img = document.createElement("img");
        img.src = im.dataUrl;
        img.alt = "示意图";
        img.title = "点击放大查看";
        img.addEventListener("click", function () { openLightbox(urls, idx); });
        var cap = document.createElement("figcaption");
        cap.textContent = im.row ? ("位置 行" + im.row + " 列" + im.col) : "";
        fig.appendChild(img);
        if (cap.textContent) fig.appendChild(cap);
        gallery.appendChild(fig);
      });
      el.previewBody.appendChild(gallery);
    }

    if (!rows.length && !images.length) {
      var empty = document.createElement("div");
      empty.className = "loader";
      empty.textContent = "该 Sheet 无可展示内容";
      el.previewBody.appendChild(empty);
    }

    showView("preview");
    el.sheetFilter.value = sheet; // 下拉与当前预览页保持一致
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 矩阵页结果写回：行首个非空单元格作为行指纹防错位，失败回滚
  function saveMatrixResult(pv, row, resultIdx, result, pillEl) {
    var prev = row.cells[resultIdx];
    var fingerprint = "";
    for (var i = 0; i < row.cells.length; i++) {
      if (String(row.cells[i]).trim()) { fingerprint = String(row.cells[i]).trim(); break; }
    }
    row.cells[resultIdx] = result;
    applyPillState(pillEl, result);
    setSaveStatus("正在保存…", "saving");
    patchCase({ sheet: pv.sheet, rowIndex: row.r, expectedName: fingerprint,
                result: result, resultCol: resultIdx + 1 },
      null,
      function () {
        row.cells[resultIdx] = prev;
        applyPillState(pillEl, prev);
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
    // 同步到本地内存，切换用例时保持回显（结果写入当前轮次列）
    setCaseResult(c, fields.result);
    c.actual = fields.actual;
    c.foundTime = fields.foundTime;
    c.bugId = fields.bugId;
    c.tester = fields.tester;
    c.note = fields.note;

    // expectedName 用于后端校验目标行未因外部编辑而错位
    // resultColumn 指定本轮结果写入列（其余字段始终写原列）
    var eff = effectiveColFor(c.sheet);
    var payload = Object.assign(
      { sheet: c.sheet, rowIndex: c.rowIndex, expectedName: c.name,
        resultColumn: eff.name || undefined }, fields);
    patchCase(payload);
  }

  function setSaveStatus(text, kind) {
    el.saveStatus.textContent = text;
    el.saveStatus.className = "save-status" + (kind === "saving" ? " saving" : kind === "error" ? " error" : "");
  }

  /* ---------- 新建结果列（开启新一轮测试） ---------- */
  // 识别现有列名中的 rc 编号，建议下一轮名称（如 rc10测试结果 -> rc11测试结果）
  function suggestRoundName() {
    var maxN = 0;
    roundOptions().forEach(function (h) {
      var m = /rc\s*(\d+)/i.exec(h);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    });
    return maxN > 0 ? ("rc" + (maxN + 1) + "测试结果") : "";
  }

  function createResultColumn() {
    var name = window.prompt(
      "新建结果列名称（将在所有用例 Sheet 表头末尾统一创建）：", suggestRoundName());
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    flushSave();
    setSaveStatus("正在新建列…", "saving");
    fetchJSON("/api/result-columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    })
      .then(function (res) {
        if (!res.ok) {
          setSaveStatus(res.d && res.d.error ? res.d.error : "新建结果列失败", "error");
          return;
        }
        // 重新拉取负载（新列已落盘），保持当前位置与视图，并自动切到新列
        var keepIndex = state.index;
        var keepView = state.view === "preview" ? "detail" : state.view;
        var keepPrefer = state.preferTable;
        var keepFilter = JSON.parse(JSON.stringify(state.filter));
        var keepFilterOpen = state.filterOpen;
        return fetchJSON("/api/cases").then(function (r2) {
          if (!r2.ok || r2.d.needsSetup) { setSaveStatus("已新建列，请刷新页面", "ok"); return; }
          applyPayload(r2.d);
          state.index = Math.min(keepIndex, Math.max(0, state.cases.length - 1));
          state.preferTable = keepPrefer;
          state.selectedRound = name;
          renderRoundSelect();
          // 恢复新建列前的筛选条件与面板开合状态（applyPayload 已重置）
          state.filterOpen = keepFilterOpen;
          applyPresetFilter(keepFilter);
          showView(keepView === "setup" ? "exec" : keepView);
          setSaveStatus("已新建列 ✓", "ok");
        });
      })
      .catch(function () { setSaveStatus("网络错误", "error"); });
  }

  /* ---------- 批量清除本轮结果（危险操作，二次确认） ---------- */
  function openClearConfirm() {
    flushSave();
    var n = 0;
    state.cases.forEach(function (c) { if (caseResult(c)) n++; });
    if (!n) { setSaveStatus("本轮暂无已录结果", "ok"); return; }
    var roundName = state.selectedRound || "测试结果";
    el.confirmDesc.textContent = "将清空「" + roundName + "」列的全部 " + n +
      " 条已录结果（共 " + state.cases.length + " 条用例）。此操作不可撤销。";
    el.confirmOk.disabled = false;
    el.confirmOverlay.classList.remove("hidden");
  }

  function closeClearConfirm() {
    el.confirmOverlay.classList.add("hidden");
  }

  function doClearRound() {
    el.confirmOk.disabled = true;
    setSaveStatus("正在清除…", "saving");
    fetchJSON("/api/results/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resultColumn: state.selectedRound || "" }),
    })
      .then(function (res) {
        if (!res.ok) {
          el.confirmOk.disabled = false;
          setSaveStatus(res.d && res.d.error ? res.d.error : "清除失败", "error");
          return;
        }
        // 本地同步而非整页重载：保留筛选/索引/轮次等页面状态
        state.cases.forEach(function (c) {
          setCaseResult(c, "");
          // 回退口径下清的是首个结果列，与主结果列镜像保持一致
          var cols = state.resultColumns[c.sheet] || [];
          var eff = effectiveColFor(c.sheet).name;
          if (!eff || eff === cols[0]) c.result = "";
        });
        invalidateFilter();
        closeClearConfirm();
        if (state.view === "table") renderTable();
        else if (state.view === "detail") renderDetail();
        else if (state.view === "exec") render();
        updateProgress();
        setSaveStatus("已清除 " + res.d.cleared + " 条结果（已自动备份）", "ok");
      })
      .catch(function () {
        el.confirmOk.disabled = false;
        setSaveStatus("网络错误", "error");
      });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    // 初始页
    el.uploadBtn.addEventListener("click", function () { el.uploadInput.click(); });
    el.uploadInput.addEventListener("change", uploadFile);
    el.startBtn.addEventListener("click", startTest);
    el.changeFile.addEventListener("click", function () { flushSave(); showSetup(); });

    // 顶栏"···"更多菜单（低频全局动作）
    el.moreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      el.moreMenu.classList.toggle("hidden");
    });
    el.moreMenu.addEventListener("click", function () { el.moreMenu.classList.add("hidden"); });
    document.addEventListener("click", function () { el.moreMenu.classList.add("hidden"); });

    // 清除本轮结果：菜单入口 → 二次确认弹窗（Esc/取消/遮罩关闭）
    el.clearRoundBtn.addEventListener("click", openClearConfirm);
    el.confirmCancel.addEventListener("click", closeClearConfirm);
    el.confirmOk.addEventListener("click", doClearRound);
    el.confirmOverlay.addEventListener("click", function (e) {
      if (e.target === el.confirmOverlay) closeClearConfirm();
    });

    // 自动跳转开关：更新状态并跨会话记忆
    el.autoAdvanceToggle.addEventListener("change", function () {
      state.autoAdvance = el.autoAdvanceToggle.checked;
      try {
        localStorage.setItem(AUTO_ADVANCE_KEY, state.autoAdvance ? "1" : "0");
      } catch (e) { /* 静默降级 */ }
    });

    // 快捷键速查浮层：顶栏 ? 按钮 / 键盘 ? 开合，Esc 或点遮罩关闭
    el.helpBtn.addEventListener("click", toggleHelp);
    el.helpClose.addEventListener("click", toggleHelp);
    el.helpOverlay.addEventListener("click", function (e) {
      if (e.target === el.helpOverlay) toggleHelp();
    });

    el.resultButtons.addEventListener("click", function (e) {
      var btn = e.target.closest(".rbtn");
      if (!btn) return;
      var wasActive = btn.classList.contains("active");
      el.resultButtons.querySelectorAll(".rbtn").forEach(function (b) { b.classList.remove("active"); });
      if (!wasActive) btn.classList.add("active"); // 再次点击可取消
      var result = wasActive ? "" : btn.getAttribute("data-result");
      // 失败快捷登记流：FAIL/BLOCK 自动补发现时间、聚焦现象输入、高亮缺陷号；PASS/NA 不打扰
      if (result === "FAIL" || result === "BLOCK") {
        if (!el.foundTime.value) {
          el.foundTime.value = nowStamp();
          state.foundTimeOriginal = el.foundTime.value;
        }
        el.actual.focus();
        if (!el.bugId.value) el.bugId.classList.add("attn");
      } else {
        el.bugId.classList.remove("attn");
      }
      // 自动跳转：通过/跳过即刻推进；失败/阻塞停留配合快捷登记流；取消选择不跳
      if (state.autoAdvance && (result === "PASS" || result === "NA")) {
        setTimeout(function () { go(1); }, 300); // 留出按钮反馈时间；go() 内 flushSave 保证先存后跳
      }
      scheduleSave();
    });

    [el.actual, el.bugId, el.tester, el.note].forEach(function (node) {
      node.addEventListener("input", scheduleSave);
    });
    // 缺陷号开始录入后撤去高亮提示
    el.bugId.addEventListener("input", function () { el.bugId.classList.remove("attn"); });

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

    // 测试轮次选择器：切列前冲刷未保存编辑，随后当前视图整体重渲染
    el.roundSelect.addEventListener("change", function () {
      flushSave();
      state.selectedRound = el.roundSelect.value;
      invalidateFilter();   // 参照列"跟随当前轮次"时筛选口径随之变化
      updateRoundWarn();
      if (state.view === "exec") render();
      else if (state.view === "table") renderTable();
      else if (state.view === "detail") renderDetail();
      updateProgress();
    });
    el.newRoundBtn.addEventListener("click", createResultColumn);

    // 筛选面板
    el.filterToggle.addEventListener("click", function () {
      state.filterOpen = !state.filterOpen;
      el.filterPanel.classList.toggle("hidden", !state.filterOpen);
    });
    el.filterClearBtn.addEventListener("click", function () {
      state.filter = emptyFilter();
      renderFilterPanel();
      applyFilter();
    });
    el.filterSaveBtn.addEventListener("click", savePresetFromCurrent);
    el.filterRefCol.addEventListener("change", function () {
      state.filter.refCol = el.filterRefCol.value;
      applyFilter();
    });
    // 关键词 / 编号范围输入：200ms 防抖实时生效
    var filterInputTimer = null;
    function applyFilterInputs() {
      if (filterInputTimer) clearTimeout(filterInputTimer);
      filterInputTimer = setTimeout(function () {
        state.filter.keyword = el.filterKeyword.value.trim();
        state.filter.idFrom = el.filterIdFrom.value.trim();
        state.filter.idTo = el.filterIdTo.value.trim();
        applyFilter();
      }, 200);
    }
    [el.filterKeyword, el.filterIdFrom, el.filterIdTo].forEach(function (node) {
      node.addEventListener("input", applyFilterInputs);
    });

    el.viewToggle.addEventListener("click", function () {
      if (state.view === "detail" || state.view === "preview") {
        showView(state.preferTable ? "table" : "exec");
      } else {
        showView("detail");
      }
    });
    el.previewBack.addEventListener("click", function () { showView("detail"); });

    // 表格/卡片视图切换（偏好记入 state，切 Sheet 后保持）
    el.tableToggle.addEventListener("click", function () {
      state.preferTable = state.view !== "table";
      showView(state.preferTable ? "table" : "exec");
    });

    // 场景讲解折叠面板
    el.sceneToggle.addEventListener("click", function () {
      var collapsed = el.sceneBody.classList.toggle("collapsed");
      el.sceneArrow.textContent = collapsed ? "▼" : "▲";
    });

    // 图片灯箱
    el.lbClose.addEventListener("click", closeLightbox);
    el.lbPrev.addEventListener("click", function (e) { e.stopPropagation(); lbStep(-1); });
    el.lbNext.addEventListener("click", function (e) { e.stopPropagation(); lbStep(1); });
    el.lightbox.addEventListener("click", function (e) {
      if (e.target === el.lightbox) closeLightbox(); // 点击遮罩关闭
    });

    // 长文本阅读侧栏：关闭按钮 / 遮罩点击均退出
    el.readerClose.addEventListener("click", closeReader);
    el.readerMask.addEventListener("click", closeReader);

    // 点击菜单外部 / 页面滚动时关闭结果菜单
    document.addEventListener("click", closeResultMenu);
    window.addEventListener("scroll", closeResultMenu, true);

    document.addEventListener("keydown", onKey);
  }

  // 上一条/下一条：在可见工作集内移动；当前用例掉出筛选时找方向上最近的可见项
  function go(delta) {
    var vis = visibleIndices();
    if (!vis.length) return;
    var pos = vis.indexOf(state.index);
    var ni = -1;
    if (pos >= 0) {
      var np = pos + delta;
      if (np < 0 || np >= vis.length) return;
      ni = vis[np];
    } else if (delta > 0) {
      for (var i = 0; i < vis.length; i++) { if (vis[i] > state.index) { ni = vis[i]; break; } }
    } else {
      for (var j = vis.length - 1; j >= 0; j--) { if (vis[j] < state.index) { ni = vis[j]; break; } }
    }
    if (ni < 0) return;
    flushSave(); // 切换前立即保存（如有待保存）
    state.index = ni;
    render();
  }

  function toggleHelp() {
    el.helpOverlay.classList.toggle("hidden");
  }

  function onKey(e) {
    var tag0 = (e.target.tagName || "").toLowerCase();
    var typing0 = tag0 === "input" || tag0 === "textarea" || tag0 === "select";
    // 清除确认弹窗打开时：Esc 关闭并拦截其余按键（危险操作，最高优先）
    if (!el.confirmOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") { closeClearConfirm(); e.preventDefault(); }
      return;
    }
    // 快捷键速查浮层：打开时 Esc/? 关闭并拦截其余按键；? 在任意非初始页可打开
    if (!el.helpOverlay.classList.contains("hidden")) {
      if (e.key === "Escape" || e.key === "?") { toggleHelp(); e.preventDefault(); }
      return;
    }
    if (e.key === "?" && !typing0 && state.view !== "setup") {
      toggleHelp();
      e.preventDefault();
      return;
    }
    // 阅读侧栏打开时：Esc 关闭（单焦点，优先响应）
    if (!el.readerPanel.classList.contains("hidden")) {
      if (e.key === "Escape") { closeReader(); e.preventDefault(); }
      return;
    }
    // 灯箱打开时优先响应：Esc 关闭，左右切图
    if (!el.lightbox.classList.contains("hidden")) {
      if (e.key === "Escape") { closeLightbox(); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { lbStep(-1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { lbStep(1); e.preventDefault(); }
      return;
    }
    if (e.key === "Escape" && resultMenu) { closeResultMenu(); return; }
    if (state.view !== "exec") return; // 仅执行界面响应快捷键
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
