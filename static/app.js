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
  ];

  function $(id) { return document.getElementById(id); }

  function init() {
    IDS.forEach(function (id) { el[id] = $(id); });
    bindEvents();
    loadInitial();
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
  }

  // 载入后决定进入哪个视图：有可执行用例进执行页，否则若有预览进详情页
  function enterAfterLoad() {
    if (state.cases.length > 0) { showView(state.preferTable ? "table" : "exec"); }
    else if (state.previews.length > 0) { showView("detail"); }
    else { showError("该文件未解析到可执行用例或预览内容"); }
  }

  /* ---------- 初始配置页 ---------- */
  function showSetup(stage, tester) {
    fetchJSON("/api/testing-files").then(function (res) {
      if (res.ok) {
        state.files = res.d.files || [];
        if (typeof stage === "undefined") stage = res.d.stage;
        if (typeof tester === "undefined") tester = res.d.tester;
      }
      if (typeof stage !== "undefined" && stage !== null && !el.stageInput.value) el.stageInput.value = stage;
      if (typeof tester !== "undefined" && tester !== null && !el.testerInput.value) el.testerInput.value = tester;
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

    if (isExec) { render(); }
    else if (isTable) { flushSave(); renderTable(); }
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
    // 测试人员：为空时用会话测试人员预填（可修改）
    el.tester.value = c.tester || state.sessionTester || "";
    el.note.value = c.note || "";

    // 导航状态
    el.navCounter.textContent = (state.index + 1) + " / " + state.cases.length;
    el.prevBtn.disabled = state.index === 0;
    el.nextBtn.disabled = state.index === state.cases.length - 1;
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

  // 进度按当前选中列本地统计（done=该列非空的用例数，与后端主列口径一致）
  function computeLocalProgress() {
    var done = 0;
    state.cases.forEach(function (c) { if (caseResult(c)) done++; });
    state.progress = { done: done, total: state.cases.length };
  }

  function updateProgress() {
    computeLocalProgress();
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
    for (var i = 0; i < state.cases.length; i++) {
      if (state.cases[i].sheet === sheet) {
        // 表格视图内切换 Sheet 时保持表格视图
        if (state.view === "table") { state.index = i; renderTable(); }
        else { openCase(i); }
        return;
      }
    }
  }

  function jumpToNextUntested() {
    var start = state.index;
    for (var k = 1; k <= state.cases.length; k++) {
      var i = (start + k) % state.cases.length;
      if (!normalizeResult(caseResult(state.cases[i]))) {
        if (state.view === "table") { state.index = i; renderTable(); }
        else { openCase(i); }
        return;
      }
    }
    setSaveStatus("全部用例已完成 🎉", "ok");
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
    var items = [];
    state.cases.forEach(function (c, i) {
      if (c.sheet === sheet) items.push({ c: c, index: i });
    });

    el.tableTitle.textContent = cur.sheetTitle || sheet;
    var done = 0;
    items.forEach(function (it) { if (normalizeResult(caseResult(it.c))) done++; });
    el.tableSummary.textContent = "共 " + items.length + " 条用例 · 已完成 " + done +
      " · 点击编号/标题可进入卡片精确执行";

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
    items.forEach(function (it) {
      var c = it.c;
      var tr = document.createElement("tr");
      if (it.index === state.index) tr.className = "current";
      if (!normalizeResult(caseResult(c))) tr.classList.add("untested");

      var tdId = document.createElement("td");
      tdId.className = "ct-id";
      var idBtn = document.createElement("button");
      idBtn.type = "button";
      idBtn.className = "ct-link";
      idBtn.textContent = c.caseId || c.name || "(无编号)";
      idBtn.title = "进入卡片视图执行该用例";
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
        var doneNow = 0;
        var items = state.cases.filter(function (x) { return x.sheet === c.sheet; });
        items.forEach(function (x) { if (normalizeResult(caseResult(x))) doneNow++; });
        el.tableSummary.textContent = "共 " + items.length + " 条用例 · 已完成 " + doneNow +
          " · 点击编号/标题可进入卡片精确执行";
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
  function renderDetail() {
    var container = el.sheetGroups;
    container.innerHTML = "";

    // 可执行用例按 Sheet 归组
    var caseMap = {};
    state.cases.forEach(function (c, i) {
      if (!caseMap[c.sheet]) caseMap[c.sheet] = [];
      caseMap[c.sheet].push({ c: c, index: i });
    });

    var execGroups = 0;
    computeLocalProgress();
    var p = state.progress;

    // 按原始 Sheet 顺序渲染：可执行组 + 只读预览组
    state.sheets.forEach(function (s) {
      if (caseMap[s.name]) {
        execGroups++;
        container.appendChild(buildCaseGroup(s, caseMap[s.name]));
      } else if (state.previewMap[s.name]) {
        container.appendChild(buildPreviewGroup(s));
      }
    });

    el.detailSummary.textContent = "共 " + state.sheets.length + " 个 Sheet · 可执行 " +
      execGroups + " 组 · 已完成 " + p.done + " / " + p.total;
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
        return fetchJSON("/api/cases").then(function (r2) {
          if (!r2.ok || r2.d.needsSetup) { setSaveStatus("已新建列，请刷新页面", "ok"); return; }
          applyPayload(r2.d);
          state.index = Math.min(keepIndex, Math.max(0, state.cases.length - 1));
          state.preferTable = keepPrefer;
          state.selectedRound = name;
          renderRoundSelect();
          showView(keepView === "setup" ? "exec" : keepView);
          setSaveStatus("已新建列 ✓", "ok");
        });
      })
      .catch(function () { setSaveStatus("网络错误", "error"); });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    // 初始页
    el.uploadBtn.addEventListener("click", function () { el.uploadInput.click(); });
    el.uploadInput.addEventListener("change", uploadFile);
    el.startBtn.addEventListener("click", startTest);
    el.changeFile.addEventListener("click", function () { flushSave(); showSetup(); });

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

    // 测试轮次选择器：切列前冲刷未保存编辑，随后当前视图整体重渲染
    el.roundSelect.addEventListener("change", function () {
      flushSave();
      state.selectedRound = el.roundSelect.value;
      updateRoundWarn();
      if (state.view === "exec") render();
      else if (state.view === "table") renderTable();
      else if (state.view === "detail") renderDetail();
      updateProgress();
    });
    el.newRoundBtn.addEventListener("click", createResultColumn);

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

  function go(delta) {
    var ni = state.index + delta;
    if (ni < 0 || ni >= state.cases.length) return;
    flushSave(); // 切换前立即保存（如有待保存）
    state.index = ni;
    render();
  }

  function onKey(e) {
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
