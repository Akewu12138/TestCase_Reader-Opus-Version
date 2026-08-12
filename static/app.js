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
    library: [],
    fileFingerprint: null,
    etag: "",
    activity: {},
    runId: "",
    preflight: null,
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
    selectedRows: {},         // 表格批量操作选中的行键
    undoStack: [],            // 最近结果标记快照
    compareMode: "all",
    taskId: "",
    evidenceKey: "",
    caseOpenedAt: 0,
    timings: {},
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
    "saveStatus", "progressWrap", "progressFill", "progressDistribution", "progressText", "loader",
    "setupView", "stageInput", "testerInput", "versionInput", "buildInput",
    "deviceInput", "environmentInput", "scopeInput", "ownerInput",
    "uploadBtn", "uploadInput", "fileList", "librarySearch", "setupHint", "startBtn",
    "card", "caseId", "kindTag", "priority", "risk", "moduleTag", "title",
    "scenario", "preconditionSection", "precondition",
    "scenarioSection", "sceneToggle", "sceneArrow", "sceneBody", "sceneDesc", "scenarioImages",
    "stepsSection", "steps", "expectedSection", "expected", "extrasSection",
    "extras", "resultButtons",
    "actual", "foundTime", "stampBtn", "clearTimeBtn", "bugId", "bugLink", "tester",
    "note", "evidenceSection", "evidenceInput", "evidenceHint", "evidenceList",
    "prevBtn", "nextBtn", "navCounter", "jumpNext",
    "viewToggle", "tableToggle", "detailView", "sheetGroups", "detailSummary", "navbar",
    "tableView", "tableTitle", "tableSummary", "tableWrap", "batchBar", "batchSelectAll",
    "batchCount", "batchPass", "batchNa", "batchClear",
    "previewView", "previewBack", "previewTitle", "previewBody", "compareView", "compareMode",
    "compareSummary", "compareBody",
    "readerMask", "readerPanel", "readerCol", "readerRow", "readerBody", "readerClose",
    "lightbox", "lbClose", "lbPrev", "lbNext", "lbImg", "lbCounter",
    "helpBtn", "helpOverlay", "helpClose", "moreBtn", "moreMenu",
    "dashboard", "dashTitle", "dashDonut", "dashPct", "dashStats", "dashFails",
    "clearRoundBtn", "confirmOverlay", "confirmDesc", "confirmCancel", "confirmOk",
    "autoAdvanceToggle",
    "backupBtn", "backupModal", "backupHint", "backupList", "backupClose",
    "retryPendingBtn",
    "compareBtn", "reportBtn", "taskBtn", "settingsBtn",
    "reportModal", "reportClose", "reportStats", "reportBody", "reportCopy", "reportDownload",
    "reportHtml",
    "taskModal", "taskClose", "taskHint", "taskList",
    "settingsModal", "settingsClose", "settingsCancel", "settingsSave", "bugUrlInput", "darkModeToggle",
    "commandModal", "commandClose", "commandInput", "commandList",
    "preflightModal", "preflightSummary", "preflightSheets", "preflightWarnings",
    "preflightChanges", "preflightCancel", "preflightOk",
    "exportSubtaskBtn", "importResultsBtn",
    "subtaskExportModal", "subtaskExportDesc", "subtaskExportSheets",
    "subtaskTesterInput", "subtaskDueInput", "subtaskTaskNote", "subtaskExportHint", "subtaskExportCancel", "subtaskExportOk",
    "subtaskImportModal", "subtaskImportBody", "subtaskFileInput", "subtaskUploadBtn",
    "subtaskImportHint", "subtaskPreview", "subtaskStats", "subtaskDiffBody",
    "subtaskOnlyEmptyBtn", "subtaskSelectAllBtn", "subtaskSelectNoneBtn",
    "subtaskMergeCancel", "subtaskMergeOk", "subtaskMergeResult",
  ];

  function $(id) { return document.getElementById(id); }

  function init() {
    IDS.forEach(function (id) { el[id] = $(id); });
    loadAutoAdvancePref();
    loadTheme();
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
      if (r.status === 304) return { ok: true, notModified: true, d: {}, headers: r.headers };
      return r.json().then(function (d) { return { ok: r.ok, d: d, headers: r.headers }; });
    });
  }

  function fetchCases() {
    var opts = { headers: {} };
    if (state.etag) opts.headers["If-None-Match"] = state.etag;
    return fetchJSON("/api/cases", opts).then(function (res) {
      if (res.headers) {
        var tag = res.headers.get("ETag");
        if (tag) state.etag = tag;
      }
      return res;
    });
  }

  /* ---------- 启动 ---------- */
  function loadInitial() {
    fetchCases()
      .then(function (res) {
        if (res.notModified && state.cases.length) { enterAfterLoad(); return; }
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
    state.fileFingerprint = d.fileFingerprint || null;
    state.activity = d.activity || {};
    state.runId = d.runId || "";
    state.preflight = null;
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
    if (state.activity.version) parts.push("版本: " + state.activity.version);
    if (state.activity.device) parts.push("设备: " + state.activity.device);
    el.sessionInfo.textContent = parts.join("  ·  ");
    buildSheetFilter();
    renderRoundSelect();
    renderFilterPanel();
    restorePendingDrafts();
    restoreCheckpoint();
  }

  var CHECKPOINT_PREFIX = "tcreader.checkpoint:";
  function checkpointKey() {
    return CHECKPOINT_PREFIX + encodeURIComponent(state.fileName || "");
  }
  function saveCheckpoint() {
    if (!state.fileName || !state.fileFingerprint) return;
    var data = {
      fileFingerprint: state.fileFingerprint,
      selectedRound: state.selectedRound || "",
      filter: JSON.parse(JSON.stringify(state.filter || emptyFilter())),
      index: state.index,
      savedAt: Date.now(),
    };
    try { localStorage.setItem(checkpointKey(), JSON.stringify(data)); } catch (e) {}
  }
  function restoreCheckpoint() {
    if (!state.fileName || !state.fileFingerprint) return;
    var data = null;
    try { data = JSON.parse(localStorage.getItem(checkpointKey()) || "null"); } catch (e) { data = null; }
    if (!data || !data.fileFingerprint) return;
    var currentHash = state.fileFingerprint.sha256 || "";
    var savedHash = data.fileFingerprint.sha256 || "";
    if (!currentHash || currentHash !== savedHash) {
      setSaveStatus("文件已变化，未恢复上次断点", "error");
      return;
    }
    var savedIndex = Number(data.index);
    var hasPosition = Number.isFinite(savedIndex) && savedIndex > 0;
    var savedFilter = data.filter || {};
    var hasFilter = !!(savedFilter.keyword || savedFilter.idFrom || savedFilter.idTo ||
      (savedFilter.statuses || []).length || (savedFilter.priorities || []).length ||
      (savedFilter.modules || []).length || (savedFilter.sheets || []).length || (savedFilter.risks || []).length);
    if (!hasPosition && !hasFilter && !data.selectedRound) return;
    if (!window.confirm("检测到上次未结束的执行进度，是否继续？")) return;
    if (data.selectedRound && roundOptions().indexOf(data.selectedRound) >= 0) {
      state.selectedRound = data.selectedRound;
      renderRoundSelect();
    }
    var base = emptyFilter();
    Object.keys(base).forEach(function (key) {
      if (Array.isArray(base[key])) base[key] = Array.isArray(savedFilter[key]) ? savedFilter[key].slice() : [];
      else base[key] = String(savedFilter[key] || "");
    });
    state.filter = base;
    invalidateFilter();
    renderFilterPanel();
    state.index = Math.max(0, Math.min(state.cases.length - 1, savedIndex || 0));
    setSaveStatus("已恢复上次执行进度", "ok");
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
  function saveSessionPrefs(stage, tester, context) {
    try {
      var value = { stage: stage || "", tester: tester || "" };
      ["version", "build", "device", "environment", "scope", "owner"].forEach(function (key) {
        value[key] = context && context[key] ? context[key] : "";
      });
      localStorage.setItem(SESSION_PREF_KEY, JSON.stringify(value));
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
      ["version", "build", "device", "environment", "scope", "owner"].forEach(function (key) {
        var input = el[key + "Input"];
        if (input && !input.value && prefs[key]) input.value = prefs[key];
      });
      // 默认选中当前文件或最新的一个
      if (state.files.length) {
        var cur = res.ok ? res.d.current : null;
        state.selectedFile = cur && findFile(cur) ? cur : state.files[0].name;
      } else {
        state.selectedFile = null;
      }
      renderFileList();
      showView("setup");
      refreshLibrary();
    });
  }

  function refreshLibrary() {
    fetchJSON("/api/library").then(function (res) {
      if (!res.ok) return;
      state.library = res.d.files || [];
      state.files = state.library.filter(function (item) { return !item.archived; });
      if (state.selectedFile && !findFile(state.selectedFile)) state.selectedFile = state.files.length ? state.files[0].name : null;
      renderFileList();
    }).catch(function () {});
  }

  function findFile(name) {
    for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === name) return state.files[i]; }
    return null;
  }

  function renderFileList() {
    el.fileList.innerHTML = "";
    var query = el.librarySearch ? el.librarySearch.value.trim().toLowerCase() : "";
    var items = (state.library.length ? state.library : state.files).filter(function (item) {
      return !query || item.name.toLowerCase().indexOf(query) >= 0;
    });
    if (!items.length) {
      el.setupHint.textContent = "暂无用例文件，请点击上方按钮上传 .xlsx 文件。";
      el.setupHint.className = "setup-hint warn";
      el.startBtn.disabled = true;
      return;
    }
    items.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "file-item" + (f.name === state.selectedFile && !f.archived ? " selected" : "") + (f.archived ? " archived" : "");
      var nameSpan = document.createElement("span");
      nameSpan.className = "file-item-name";
      nameSpan.textContent = f.name;
      var meta = document.createElement("span");
      meta.className = "file-item-meta";
      meta.textContent = formatSize(f.size) + " · " + formatTime(f.mtime);
      row.appendChild(nameSpan);
      row.appendChild(meta);
      if (!f.archived) {
        row.addEventListener("click", function () { state.selectedFile = f.name; renderFileList(); });
      }
      var actions = document.createElement("span");
      actions.className = "file-item-actions";
      [
        { label: "重命名", action: function () {
          var nextName = window.prompt("新的文件名：", f.name);
          if (nextName && nextName.trim() !== f.name) libraryPatch({ fileName: f.name, newName: nextName.trim(), archived: !!f.archived });
        } },
        { label: f.archived ? "恢复" : "归档", action: function () {
          libraryPatch({ fileName: f.name, archived: !!f.archived, archive: !f.archived });
        } },
        { label: "删除", action: function () {
          if (window.confirm("文件将移入回收区，确认删除吗？")) libraryDelete(f);
        } },
      ].forEach(function (item) {
        var button = document.createElement("button");
        button.className = "btn btn-small " + (item.label === "删除" ? "btn-danger" : "btn-ghost");
        button.textContent = item.label;
        button.addEventListener("click", function (event) { event.stopPropagation(); item.action(); });
        actions.appendChild(button);
      });
      row.appendChild(actions);
      el.fileList.appendChild(row);
    });
    el.setupHint.textContent = state.selectedFile ? ("已选择：" + state.selectedFile) : "请选择一个用例文件。";
    el.setupHint.className = "setup-hint";
    el.startBtn.disabled = !state.selectedFile;
  }

  function libraryPatch(payload) {
    fetchJSON("/api/library", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload) }).then(function (res) {
      if (!res.ok) { el.setupHint.textContent = res.d.error || "文件操作失败"; el.setupHint.className = "setup-hint warn"; return; }
      refreshLibrary();
    }).catch(function () { el.setupHint.textContent = "文件操作失败"; el.setupHint.className = "setup-hint warn"; });
  }
  function libraryDelete(item) {
    fetchJSON("/api/library/" + encodeURIComponent(item.name) + "?archived=" + (item.archived ? "1" : "0"), { method: "DELETE" })
      .then(function (res) {
        if (!res.ok) { el.setupHint.textContent = res.d.error || "文件删除失败"; el.setupHint.className = "setup-hint warn"; return; }
        if (state.selectedFile === item.name) state.selectedFile = null;
        refreshLibrary();
      }).catch(function () { el.setupHint.textContent = "文件删除失败"; el.setupHint.className = "setup-hint warn"; });
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
        state.library = state.files.slice();
        renderFileList();
        refreshLibrary();
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
    el.setupHint.textContent = "正在执行解析预检…";
    el.setupHint.className = "setup-hint";
    var payload = collectActivity();
    payload.fileName = state.selectedFile;
    saveSessionPrefs(payload.stage, payload.tester, payload); // 跨会话记忆（localStorage）
    fetchJSON("/api/workbook/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: state.selectedFile }),
    })
      .then(function (res) {
        if (!res.ok) {
          el.startBtn.disabled = false;
          el.setupHint.textContent = res.d.error || "预检失败";
          el.setupHint.className = "setup-hint warn";
          return;
        }
        state.preflight = res.d;
        renderPreflight(res.d);
        el.preflightModal.classList.remove("hidden");
      })
      .catch(function (e) {
        el.startBtn.disabled = false;
        el.setupHint.textContent = "网络错误: " + e.message;
        el.setupHint.className = "setup-hint warn";
      });
  }

  function collectActivity() {
    var data = {};
    ["stage", "tester", "version", "build", "device", "environment", "scope", "owner"].forEach(function (key) {
      var input = el[key + "Input"];
      data[key] = input ? input.value.trim() : "";
    });
    return data;
  }

  function renderPreflight(d) {
    el.preflightSummary.textContent = d.fileName + " · " + formatSize(d.fileSize) +
      " · " + d.sheetCount + " 个 Sheet · " + d.executableCaseCount + " 条可执行用例";
    el.preflightSheets.innerHTML = "";
    (d.sheets || []).forEach(function (sheet) {
      var row = document.createElement("div");
      row.className = "preflight-sheet";
      var mapped = (sheet.fieldMappings || []).filter(function (m) { return m.status === "matched"; }).length;
      row.textContent = sheet.name + " · " + (KIND_LABEL[sheet.kind] || sheet.kind) +
        " · " + (sheet.caseCount || 0) + " 条用例 · 已识别 " + mapped + " 个字段";
      el.preflightSheets.appendChild(row);
    });
    el.preflightWarnings.innerHTML = "";
    (d.warnings || []).forEach(function (warning) {
      var row = document.createElement("div");
      row.className = "preflight-warning " + (warning.level || "info");
      row.textContent = warning.message;
      el.preflightWarnings.appendChild(row);
    });
    if (!d.warnings || !d.warnings.length) el.preflightWarnings.textContent = "未发现解析风险";
    el.preflightChanges.innerHTML = "";
    if ((d.changes || []).length) {
      var title = document.createElement("strong");
      title.textContent = "确认后将写入：";
      el.preflightChanges.appendChild(title);
      (d.changes || []).forEach(function (change) {
        var row = document.createElement("div");
        row.textContent = change.sheet + " · 新增列「" + change.header + "」";
        el.preflightChanges.appendChild(row);
      });
    } else {
      el.preflightChanges.textContent = "不会新增表头列";
    }
    el.preflightOk.disabled = (d.executableCaseCount || 0) === 0;
  }

  function closePreflight() {
    el.preflightModal.classList.add("hidden");
    state.preflight = null;
    el.startBtn.disabled = false;
  }

  function confirmPreflight() {
    if (!state.preflight) return;
    el.preflightOk.disabled = true;
    el.setupHint.textContent = "正在加载用例…";
    var payload = collectActivity();
    payload.fileName = state.selectedFile;
    payload.fileFingerprint = state.preflight.fingerprint;
    fetchJSON("/api/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) {
        el.preflightOk.disabled = false;
        el.setupHint.textContent = res.d.error || "加载失败";
        el.setupHint.className = "setup-hint warn";
        return;
      }
      closePreflight();
      el.startBtn.disabled = false;
      applyPayload(res.d);
      enterAfterLoad();
    }).catch(function (e) {
      el.preflightOk.disabled = false;
      el.setupHint.textContent = "网络错误: " + e.message;
      el.setupHint.className = "setup-hint warn";
    });
  }

  /* ---------- 备份恢复中心 ---------- */
  function openBackups() {
    el.backupModal.classList.remove("hidden");
    el.backupHint.textContent = "正在读取当前文件的备份…";
    el.backupList.innerHTML = "";
    fetchJSON("/api/backups?fileName=" + encodeURIComponent(state.fileName || ""))
      .then(function (res) {
        if (!res.ok) {
          el.backupHint.textContent = res.d.error || "读取备份失败";
          return;
        }
        var list = res.d.backups || [];
        el.backupHint.textContent = list.length ?
          ("共 " + list.length + " 个备份，恢复前会自动备份当前文件") : "当前文件暂无可恢复备份";
        list.forEach(function (backup) {
          var row = document.createElement("div");
          row.className = "backup-item";
          var info = document.createElement("div");
          info.className = "backup-info";
          var name = document.createElement("strong");
          name.textContent = backup.createdAt || backup.name;
          var meta = document.createElement("span");
          meta.textContent = formatSize(backup.size) + " · " + backup.name;
          info.appendChild(name);
          info.appendChild(meta);
          var button = document.createElement("button");
          button.className = "btn btn-small btn-danger";
          button.textContent = "恢复";
          button.title = "恢复前会自动备份当前文件";
          button.addEventListener("click", function () { restoreBackup(backup); });
          row.appendChild(info);
          row.appendChild(button);
          el.backupList.appendChild(row);
        });
      }).catch(function () { el.backupHint.textContent = "网络错误，无法读取备份"; });
  }

  function closeBackups() { el.backupModal.classList.add("hidden"); }

  function restoreBackup(backup) {
    if (!window.confirm("确定恢复 " + (backup.createdAt || backup.name) + "？当前文件会先自动备份。")) return;
    el.backupHint.textContent = "正在恢复…";
    fetchJSON("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupId: backup.id, fileName: state.fileName,
                             fileFingerprint: state.fileFingerprint }),
    }).then(function (res) {
      if (!res.ok) { el.backupHint.textContent = res.d.error || "恢复失败"; return; }
      closeBackups();
      applyPayload(res.d.payload);
      enterAfterLoad();
      setSaveStatus("已恢复备份 ✓", "ok");
    }).catch(function () { el.backupHint.textContent = "网络错误，恢复失败"; });
  }

  /* ---------- 视图切换 ---------- */
  function hideAllViews() {
    ["setupView", "card", "tableView", "detailView", "previewView", "compareView"].forEach(function (k) { el[k].classList.add("hidden"); });
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
    var isCompare = view === "compare";

    el.setupView.classList.toggle("hidden", !isSetup);
    el.card.classList.toggle("hidden", !isExec);
    el.tableView.classList.toggle("hidden", !isTable);
    el.detailView.classList.toggle("hidden", !isDetail);
    el.previewView.classList.toggle("hidden", !isPreview);
    el.compareView.classList.toggle("hidden", !isCompare);

    // 宽屏布局：初始页保持窄幅居中，其余视图充分利用大屏宽度
    document.body.classList.toggle("wide-view", !isSetup);

    // 顶栏/进度/导航：初始页隐藏
    el.execControls.classList.toggle("hidden", isSetup);
    el.progressWrap.classList.toggle("hidden", isSetup);
    el.navbar.classList.toggle("hidden", !isExec);

    el.viewToggle.textContent = (isDetail || isPreview || isCompare) ? "返回执行" : "测试详情";
    el.viewToggle.classList.toggle("active", isDetail || isPreview || isCompare);
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
    else if (isCompare) {
      flushSave();
      renderCompare();
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
    updateBugLink(c.bugId);
    el.bugId.classList.remove("attn"); // 切换用例时撤去失败登记高亮
    // 测试人员：为空时用会话测试人员预填（可修改）
    el.tester.value = c.tester || state.sessionTester || "";
    el.note.value = c.note || "";
    var caseKey = c.sheet + ":" + c.rowIndex;
    if (state.evidenceKey !== caseKey) {
      state.evidenceKey = caseKey;
      state.caseOpenedAt = Date.now();
      loadEvidence(c);
    }

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
    saveCheckpoint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  var BUG_URL_KEY = "tcreader.bugUrlTemplate";
  function bugUrlTemplate() {
    try { return localStorage.getItem(BUG_URL_KEY) || ""; } catch (e) { return ""; }
  }
  function updateBugLink(value) {
    var id = String(value || "").trim();
    var template = bugUrlTemplate();
    if (!el.bugLink) return;
    if (!id || !template || template.indexOf("{id}") < 0) {
      el.bugLink.classList.add("hidden");
      el.bugLink.removeAttribute("href");
      el.bugLink.textContent = "";
      return;
    }
    el.bugLink.href = template.split("{id}").join(encodeURIComponent(id));
    el.bugLink.textContent = "打开缺陷";
    el.bugLink.classList.remove("hidden");
  }

  function renderEvidence(items) {
    if (!el.evidenceList) return;
    el.evidenceList.innerHTML = "";
    if (!items || !items.length) {
      el.evidenceHint.textContent = "支持截图、日志和其他附件";
      return;
    }
    el.evidenceHint.textContent = items.length + " 个证据文件";
    items.forEach(function (item) {
      var link = document.createElement("a");
      link.className = "evidence-item";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = item.name + " · " + formatSize(item.size);
      el.evidenceList.appendChild(link);
    });
  }

  function loadEvidence(c) {
    if (!c || !el.evidenceList) return;
    fetchJSON("/api/attachments?sheet=" + encodeURIComponent(c.sheet) + "&rowIndex=" + c.rowIndex)
      .then(function (res) { if (res.ok) renderEvidence(res.d.attachments || []); })
      .catch(function () { renderEvidence([]); });
  }

  function uploadEvidence(file) {
    var c = state.cases[state.index];
    if (!file || !c) return;
    var fd = new FormData();
    fd.append("file", file);
    fd.append("sheet", c.sheet);
    fd.append("rowIndex", String(c.rowIndex));
    fd.append("fileName", state.fileName || "");
    fd.append("fileFingerprint", JSON.stringify(state.fileFingerprint || {}));
    el.evidenceHint.textContent = "正在上传证据…";
    fetchJSON("/api/attachments", { method: "POST", body: fd })
      .then(function (res) {
        if (!res.ok) { el.evidenceHint.textContent = res.d.error || "证据上传失败"; return; }
        loadEvidence(c);
      }).catch(function () { el.evidenceHint.textContent = "网络错误，证据上传失败"; });
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
      img.loading = "lazy";   // 独立端点惰性加载
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

  function snapshotCase(c) {
    var fields = {
      result: caseResult(c) || "",
      actual: c.actual || "",
      foundTime: c.foundTime || "",
      bugId: c.bugId || "",
      tester: c.tester || "",
      note: c.note || "",
    };
    if (c === state.cases[state.index] && el.resultButtons) {
      var current = collectFields();
      fields = current;
    }
    return {
      sheet: c.sheet,
      rowIndex: c.rowIndex,
      resultColumn: effectiveColFor(c.sheet).name || "",
      fields: fields,
      createdAt: Date.now(),
    };
  }
  function pushUndoSnapshot(c) {
    if (!c) return;
    state.undoStack.push(snapshotCase(c));
    if (state.undoStack.length > 20) state.undoStack.shift();
  }
  function findCase(sheet, rowIndex) {
    return state.cases.find(function (candidate) {
      return candidate.sheet === sheet && candidate.rowIndex === rowIndex;
    });
  }
  function applySnapshot(snapshot) {
    var c = findCase(snapshot.sheet, snapshot.rowIndex);
    if (!c) return null;
    var fields = snapshot.fields || {};
    setCaseResult(c, fields.result || "");
    ["actual", "foundTime", "bugId", "tester", "note"].forEach(function (key) {
      c[key] = fields[key] || "";
    });
    return c;
  }
  function undoLast() {
    if (!state.undoStack.length) {
      setSaveStatus("没有可撤销的结果标记", "ok");
      return;
    }
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    var snapshot = state.undoStack.pop();
    var c = applySnapshot(snapshot);
    if (!c) return;
    if (c === state.cases[state.index] && state.view === "exec") render();
    else if (state.view === "table") renderTable();
    else updateProgress();
    var eff = effectiveColFor(c.sheet);
    patchCase({ sheet: c.sheet, rowIndex: c.rowIndex, expectedName: c.name,
      result: snapshot.fields.result || "", resultColumn: eff.name || undefined,
      actual: snapshot.fields.actual || "", foundTime: snapshot.fields.foundTime || "",
      bugId: snapshot.fields.bugId || "", tester: snapshot.fields.tester || "",
      note: snapshot.fields.note || "" });
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
    renderProgressDistribution();
    updateFilterBar();
  }

  function renderProgressDistribution() {
    if (!el.progressDistribution) return;
    var counts = { PASS: 0, FAIL: 0, BLOCK: 0, NA: 0, UNTESTED: 0 };
    visibleIndices().forEach(function (i) {
      var norm = normalizeResult(caseResult(state.cases[i]));
      counts[norm || "UNTESTED"]++;
    });
    var total = visibleIndices().length || 1;
    el.progressDistribution.innerHTML = "";
    [["PASS", "通过", "var(--pass)"], ["FAIL", "失败", "var(--fail)"],
     ["BLOCK", "阻塞", "var(--block)"], ["NA", "跳过", "var(--na)"],
     ["UNTESTED", "未测", "#e7ebf3"]].forEach(function (item) {
      var n = counts[item[0]];
      if (!n) return;
      var part = document.createElement("span");
      part.className = "progress-segment";
      part.style.width = (n / total * 100) + "%";
      part.style.background = item[2];
      part.title = item[1] + " " + n;
      el.progressDistribution.appendChild(part);
    });
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
  function rowKey(c) { return c.sheet + ":" + c.rowIndex; }
  function updateBatchBar(items) {
    if (!el.batchBar || state.view !== "table") return;
    var selected = items ? items.filter(function (it) { return !!state.selectedRows[rowKey(it.c)]; }) : [];
    el.batchBar.classList.toggle("hidden", !items || !items.length);
    el.batchCount.textContent = selected.length ? ("已选 " + selected.length + " 条") : "未选择用例";
    el.batchPass.disabled = !selected.length;
    el.batchNa.disabled = !selected.length;
    el.batchSelectAll.checked = !!items && items.length > 0 && selected.length === items.length;
    el.batchSelectAll.indeterminate = !!selected.length && selected.length < (items ? items.length : 0);
  }
  function selectedTableItems() {
    var cur = state.cases[state.index];
    if (!cur) return [];
    var result = [];
    visibleIndices().forEach(function (index) {
      var c = state.cases[index];
      if (c.sheet === cur.sheet && state.selectedRows[rowKey(c)]) result.push({ c: c, index: index });
    });
    return result;
  }
  function batchMark(result) {
    if (["PASS", "NA"].indexOf(result) < 0) return;
    var items = selectedTableItems();
    if (!items.length) return;
    if (!window.confirm("将把选中的 " + items.length + " 条用例标记为“" + (RESULT_LABEL[result] || result) + "”，是否继续？")) return;
    setSaveStatus("正在批量保存…", "saving");
    var failed = 0;
    function next(pos) {
      if (pos >= items.length) {
        items.forEach(function (it) { delete state.selectedRows[rowKey(it.c)]; });
        renderTable();
        setSaveStatus(failed ? ("批量完成，" + failed + " 条待重试") : "批量保存完成 ✓", failed ? "error" : "ok");
        return;
      }
      var c = items[pos].c;
      var previous = snapshotCase(c);
      pushUndoSnapshot(c);
      setCaseResult(c, result);
      patchCase({ sheet: c.sheet, rowIndex: c.rowIndex, expectedName: c.name,
        result: result, resultColumn: effectiveColFor(c.sheet).name || undefined }, function () {
        next(pos + 1);
      }, function () {
        applySnapshot(previous);
        failed++;
        next(pos + 1);
      });
    }
    next(0);
  }
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
    var selectTh = document.createElement("th");
    selectTh.className = "ct-select";
    selectTh.textContent = "选择";
    htr.appendChild(selectTh);
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
    function buildRow(it, seq) {
      var c = it.c;
      var tr = document.createElement("tr");
      if (it.index === state.index) tr.className = "current";
      if (!normalizeResult(caseResult(c))) tr.classList.add("untested");

      var tdSelect = document.createElement("td");
      tdSelect.className = "ct-select";
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!state.selectedRows[rowKey(c)];
      checkbox.setAttribute("aria-label", "选择 " + (c.name || c.title || "用例"));
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) state.selectedRows[rowKey(c)] = true;
        else delete state.selectedRows[rowKey(c)];
        updateBatchBar(items);
      });
      tdSelect.appendChild(checkbox);
      tr.appendChild(tdSelect);

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

      return tr;
    }

    // 分批渲染：首屏同步渲染一批，其余 requestAnimationFrame 逐批追加，
    // 大 Sheet（数百上千行）不再一次性构建 DOM 阻塞交互
    var CHUNK = 150;
    var token = renderTable._token = (renderTable._token || 0) + 1;
    function appendChunk(start) {
      if (token !== renderTable._token) return;  // 已被新一次渲染取代
      var end = Math.min(start + CHUNK, items.length);
      for (var i = start; i < end; i++) tbody.appendChild(buildRow(items[i], i));
      if (end < items.length) {
        window.requestAnimationFrame(function () { appendChunk(end); });
      }
    }
    appendChunk(0);
    table.appendChild(tbody);
    el.tableWrap.appendChild(table);

    updateBatchBar(items);
    saveCheckpoint();

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
    pushUndoSnapshot(c);
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

  /* ---------- 本机待提交草稿（仅保存最小字段，7 天自动清理） ---------- */
  var PENDING_KEY = "tcreader.pendingChanges";
  var PENDING_TTL = 7 * 24 * 3600 * 1000;
  function loadPending() {
    var now = Date.now();
    var list = [];
    try { list = JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (e) { list = []; }
    list = list.filter(function (item) { return item.createdAt && now - item.createdAt < PENDING_TTL; });
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e2) {}
    return list;
  }
  function pendingId(item) {
    return [item.fileName, item.sheet, item.rowIndex,
      item.resultColumn || item.resultCol || ""].join("|");
  }
  function queuePending(payload, error) {
    var list = loadPending();
    var item = {
      fileName: payload.fileName || state.fileName,
      fileFingerprint: payload.fileFingerprint || state.fileFingerprint,
      sheet: payload.sheet,
      rowIndex: payload.rowIndex,
      expectedName: payload.expectedName || "",
      resultColumn: payload.resultColumn || "",
      resultCol: payload.resultCol || null,
      fields: {},
      createdAt: Date.now(),
      retryCount: 0,
      lastError: error || "保存失败",
    };
    ["result", "bugId", "tester", "note", "actual", "foundTime"].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) item.fields[key] = payload[key];
    });
    var id = pendingId(item);
    var found = false;
    list = list.map(function (old) {
      if (pendingId(old) !== id) return old;
      found = true;
      item.retryCount = (old.retryCount || 0) + 1;
      return item;
    });
    if (!found) list.push(item);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) {}
    return list.length;
  }
  function removePending(payload) {
    var list = loadPending();
    var id = pendingId({ fileName: state.fileName, sheet: payload.sheet,
      rowIndex: payload.rowIndex, resultColumn: payload.resultColumn,
      resultCol: payload.resultCol });
    list = list.filter(function (item) { return pendingId(item) !== id; });
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function restorePendingDrafts() {
    if (!state.fileName || !state.fileFingerprint) return;
    var list = loadPending().filter(function (item) {
      return item.fileName === state.fileName && item.fileFingerprint &&
        item.fileFingerprint.sha256 === state.fileFingerprint.sha256;
    });
    list.forEach(function (item) {
      var c = state.cases.find(function (candidate) {
        return candidate.sheet === item.sheet && candidate.rowIndex === item.rowIndex;
      });
      if (!c) return;
      var fields = item.fields || {};
      if (Object.prototype.hasOwnProperty.call(fields, "result")) {
        if (item.resultColumn && c.results) c.results[item.resultColumn] = fields.result;
        else c.result = fields.result;
      }
      ["bugId", "tester", "note", "actual", "foundTime"].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) c[key] = fields[key];
      });
    });
    if (list.length) setSaveStatus("有 " + list.length + " 项待重试", "error");
  }
  function pendingForCurrent() {
    return loadPending().filter(function (item) {
      return item.fileName === state.fileName;
    });
  }
  function retryPending() {
    var list = pendingForCurrent();
    if (!list.length) { setSaveStatus("没有待提交草稿", "ok"); return; }
    setSaveStatus("正在重试 " + list.length + " 项…", "saving");
    function next(pos) {
      if (pos >= list.length) {
        var remain = pendingForCurrent().length;
        setSaveStatus(remain ? ("仍有 " + remain + " 项待重试") : "待提交已全部保存 ✓",
          remain ? "error" : "ok");
        return;
      }
      var item = list[pos];
      var payload = Object.assign({ sheet: item.sheet, rowIndex: item.rowIndex,
        expectedName: item.expectedName, resultColumn: item.resultColumn || undefined,
        resultCol: item.resultCol || undefined, fileName: state.fileName,
        fileFingerprint: state.fileFingerprint }, item.fields || {});
      patchCase(payload, function () { next(pos + 1); }, function () { next(pos + 1); });
    }
    next(0);
  }

  // 通用 PATCH 写回：串行发送，确保每次请求都使用上一次写回后的最新文件指纹。
  // 自动跳转会在前一个请求返回前触发下一条保存，直接并发发送会让后端把后续请求判为外部修改。
  var patchQueue = [];
  var patchBusy = false;

  function invokePatchCallback(callback) {
    if (!callback) return;
    try { callback(); } catch (e) { /* 单条回调异常不能阻塞后续写回 */ }
  }

  function patchCase(payload, onOk, onFail) {
    var queuedPayload = Object.assign({}, payload);
    // 固定请求所属文件；同一文件内的指纹在真正发送时再取最新值。
    if (!queuedPayload.fileName) queuedPayload.fileName = state.fileName || undefined;
    if (!queuedPayload.fileFingerprint) queuedPayload.fileFingerprint = state.fileFingerprint || undefined;
    patchQueue.push({
      payload: queuedPayload,
      onOk: onOk,
      onFail: onFail,
    });
    drainPatchQueue();
  }

  function drainPatchQueue() {
    if (patchBusy || !patchQueue.length) return;
    patchBusy = true;
    var job = patchQueue.shift();
    // 会话隔离：声明页面所属文件；文件指纹必须在真正发请求时取最新值。
    var sameFile = !job.payload.fileName || !state.fileName ||
      job.payload.fileName === state.fileName;
    var requestPayload = Object.assign({}, job.payload, {
      fileName: job.payload.fileName || state.fileName || undefined,
      fileFingerprint: sameFile
        ? (state.fileFingerprint || job.payload.fileFingerprint || undefined)
        : job.payload.fileFingerprint,
    });
    fetchJSON("/api/cases", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    })
      .then(function (res) {
        if (!res.ok) {
          var message = res.d && res.d.error ? res.d.error : "保存失败";
          var pendingCount = queuePending(requestPayload, message);
          setSaveStatus(message + " · 待重试 " + pendingCount + " 项", "error");
          invokePatchCallback(job.onFail);
          return;
        }
        // 进度改为前端按选中轮次列本地统计，后端 progress（主列口径）不再采用
        updateProgress();
        removePending(requestPayload);
        if (res.d.fileFingerprint) state.fileFingerprint = res.d.fileFingerprint;
        setSaveStatus("已保存 ✓", "ok");
        invokePatchCallback(job.onOk);
      })
      .catch(function () {
        var pendingCount = queuePending(requestPayload, "网络错误");
        setSaveStatus("保存失败 · 待重试 " + pendingCount + " 项", "error");
        invokePatchCallback(job.onFail);
      })
      .then(function () {
        patchBusy = false;
        drainPatchQueue();
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

  /* ---------- 轮次对比与回归分析 ---------- */
  function resultForColumn(c, column) {
    if (column && c.results && Object.prototype.hasOwnProperty.call(c.results, column)) {
      return c.results[column] || "";
    }
    return column === effectiveColFor(c.sheet).name ? c.result || "" : "";
  }
  function isFailure(raw) { return ["FAIL", "BLOCK"].indexOf(normalizeResult(raw)) >= 0; }
  function compareMatches(c, current, previous) {
    var mode = state.compareMode || "all";
    var now = normalizeResult(resultForColumn(c, current));
    var before = normalizeResult(resultForColumn(c, previous));
    if (mode === "regression") return ["PASS", "NA"].indexOf(before) >= 0 && isFailure(now);
    if (mode === "newFail") return isFailure(now) && !isFailure(before);
    if (mode === "continuousFail") return isFailure(now) && isFailure(before);
    if (mode === "fixed") return ["PASS", "NA"].indexOf(now) >= 0 && isFailure(before);
    return true;
  }
  function resultBadge(raw) {
    var norm = normalizeResult(raw);
    var span = document.createElement("span");
    span.className = "sg-case-res " + (RESULT_CLASS[norm] || "res-none");
    span.textContent = norm ? RESULT_LABEL[norm] : "未测";
    return span;
  }
  function renderCompare() {
    var options = roundOptions();
    var current = state.selectedRound || options[options.length - 1] || "";
    var currentIndex = options.indexOf(current);
    var previous = currentIndex > 0 ? options[currentIndex - 1] : "";
    el.compareMode.value = state.compareMode || "all";
    el.compareSummary.textContent = current + (previous ? " 对比 " + previous : "（暂无上一轮，显示当前轮次）") +
      (filterActive() ? " · 当前筛选工作集" : "");
    el.compareBody.innerHTML = "";
    if (!options.length) {
      el.compareBody.textContent = "当前文件没有可比较的结果列";
      return;
    }
    var table = document.createElement("table");
    table.className = "compare-table";
    var head = document.createElement("tr");
    ["用例", "模块", previous || "上一轮", current || "当前轮", "变化"].forEach(function (text) {
      var th = document.createElement("th"); th.textContent = text; head.appendChild(th);
    });
    var thead = document.createElement("thead"); thead.appendChild(head); table.appendChild(thead);
    var body = document.createElement("tbody");
    var count = 0;
    visibleIndices().forEach(function (index) {
      var c = state.cases[index];
      if (!compareMatches(c, current, previous)) return;
      count++;
      var beforeRaw = resultForColumn(c, previous);
      var nowRaw = resultForColumn(c, current);
      var before = normalizeResult(beforeRaw), now = normalizeResult(nowRaw);
      var change = before === now ? "无变化" : (before || "未测") + " → " + (now || "未测");
      var tr = document.createElement("tr");
      var name = document.createElement("button"); name.type = "button"; name.className = "ct-link";
      name.textContent = c.name || c.title || c.caseId || "(未命名)";
      name.addEventListener("click", function () { openCase(index); });
      var tdName = document.createElement("td"); tdName.appendChild(name); tr.appendChild(tdName);
      var tdModule = document.createElement("td"); tdModule.textContent = c.module || c.sheetTitle || ""; tr.appendChild(tdModule);
      var tdBefore = document.createElement("td"); tdBefore.appendChild(resultBadge(beforeRaw)); tr.appendChild(tdBefore);
      var tdNow = document.createElement("td"); tdNow.appendChild(resultBadge(nowRaw)); tr.appendChild(tdNow);
      var tdChange = document.createElement("td"); tdChange.textContent = change; tr.appendChild(tdChange);
      body.appendChild(tr);
    });
    table.appendChild(body); el.compareBody.appendChild(table);
    if (!count) el.compareBody.textContent = "当前筛选和对比条件下没有匹配用例";
  }

  /* ---------- 报告 ---------- */
  var COMMAND_ACTIONS = [
    { label: "轮次对比", action: function () { closeCommandPalette(); showView("compare"); } },
    { label: "测试报告", action: function () { closeCommandPalette(); openReport(); } },
    { label: "任务中心", action: function () { closeCommandPalette(); openTasks(); } },
    { label: "备份与恢复", action: function () { closeCommandPalette(); openBackups(); } },
    { label: "设置", action: function () { closeCommandPalette(); openSettings(); } },
  ];
  function renderCommandList() {
    var query = (el.commandInput.value || "").trim().toLowerCase();
    el.commandList.innerHTML = "";
    COMMAND_ACTIONS.filter(function (item) { return !query || item.label.toLowerCase().indexOf(query) >= 0; })
      .forEach(function (item) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "command-item command-action";
        button.textContent = item.label;
        button.addEventListener("click", item.action);
        el.commandList.appendChild(button);
      });
    if (!query && !state.cases.length) return;
    var found = 0;
    state.cases.forEach(function (c, index) {
      if (found >= 30) return;
      var haystack = [c.caseId, c.name, c.title, c.scenario, c.module, c.sheet].join(" ").toLowerCase();
      if (query && haystack.indexOf(query) < 0) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "command-item";
      button.textContent = (c.caseId || c.name || "用例") + "  " + (c.title || c.scenario || "") + (c.module ? "  ·  " + c.module : "");
      button.addEventListener("click", function () { closeCommandPalette(); openCase(index); });
      el.commandList.appendChild(button);
      found++;
    });
    if (!el.commandList.children.length) el.commandList.textContent = "没有匹配项";
  }
  function openCommandPalette() {
    el.commandModal.classList.remove("hidden");
    el.commandInput.value = "";
    renderCommandList();
    el.commandInput.focus();
  }
  function closeCommandPalette() { el.commandModal.classList.add("hidden"); }

  function reportData() {
    var counts = { PASS: 0, FAIL: 0, BLOCK: 0, NA: 0, UNTESTED: 0 };
    var failed = [], modules = {};
    var totalTime = 0;
    visibleIndices().forEach(function (i) {
      var c = state.cases[i], norm = normalizeResult(caseResult(c));
      counts[norm || "UNTESTED"]++;
      var mod = c.module || c.sheetTitle || c.sheet || "未分组";
      if (!modules[mod]) modules[mod] = { total: 0, done: 0, fail: 0 };
      modules[mod].total++;
      if (norm) modules[mod].done++;
      if (isFailure(norm)) { modules[mod].fail++; failed.push(c); }
      totalTime += state.timings[rowKey(c)] || 0;
    });
    return { counts: counts, failed: failed, modules: modules, total: visibleIndices().length,
      totalTime: totalTime, averageTime: totalTime / Math.max(1, visibleIndices().length) };
  }
  function buildReportMarkdown() {
    var data = reportData(), activity = state.activity || {};
    var lines = ["# 测试执行报告", "", "- 文件：" + state.fileName,
      "- 记录用时：" + Math.round(data.totalTime / 1000) + " 秒，平均 " + Math.round(data.averageTime / 1000) + " 秒/条",
      "- 结果列：" + (state.selectedRound || "默认"),
      "- 版本：" + (activity.version || "未填写"),
      "- 构建：" + (activity.build || "未填写"),
      "- 设备：" + (activity.device || "未填写"),
      "- 环境：" + (activity.environment || "未填写"),
      "- 测试人员：" + (state.sessionTester || "未填写"), "",
      "## 总体结果", "", "| 状态 | 数量 |", "| --- | ---: |",
      "| 通过 | " + data.counts.PASS + " |", "| 失败 | " + data.counts.FAIL + " |",
      "| 阻塞 | " + data.counts.BLOCK + " |", "| 跳过 | " + data.counts.NA + " |",
      "| 未测 | " + data.counts.UNTESTED + " |", "", "## 模块分布", "",
      "| 模块 | 用例数 | 已完成 | 失败 |", "| --- | ---: | ---: | ---: |"];
    Object.keys(data.modules).forEach(function (name) {
      var m = data.modules[name]; lines.push("| " + name.replace(/\|/g, "\\|") + " | " + m.total + " | " + m.done + " | " + m.fail + " |");
    });
    lines.push("", "## 失败与阻塞", "");
    if (!data.failed.length) lines.push("暂无失败或阻塞用例");
    data.failed.forEach(function (c) {
      lines.push("- **" + (c.name || c.title || "未命名") + "** · BugID: " + (c.bugId || "未填写") +
        " · 测试人员: " + (c.tester || state.sessionTester || "未填写"));
      if (c.actual) lines.push("  - 实际现象：" + c.actual.replace(/\n/g, " "));
      if (c.note) lines.push("  - 备注：" + c.note.replace(/\n/g, " "));
    });
    return lines.join("\n");
  }
  function openReport() {
    flushSave();
    var data = reportData();
    el.reportStats.textContent = "当前工作集 " + data.total + " 条 · 通过 " + data.counts.PASS +
      " · 失败 " + data.counts.FAIL + " · 阻塞 " + data.counts.BLOCK + " · 未测 " + data.counts.UNTESTED;
    el.reportBody.textContent = buildReportMarkdown();
    el.reportModal.classList.remove("hidden");
  }
  function closeReport() { el.reportModal.classList.add("hidden"); }
  function downloadReport() {
    var blob = new Blob([el.reportBody.textContent], { type: "text/markdown;charset=utf-8" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = (state.fileName || "测试报告").replace(/\.xlsx$/i, "") + "_报告.md";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function downloadHtmlReport() {
    var text = el.reportBody.textContent;
    var escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var html = "<!doctype html><meta charset=\"utf-8\"><title>测试执行报告</title>" +
      "<style>body{font:14px/1.6 Arial,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#202733}pre{white-space:pre-wrap;background:#f5f7fb;padding:16px;border-radius:8px}</style>" +
      "<pre>" + escaped + "</pre>";
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = (state.fileName || "测试报告").replace(/\.xlsx$/i, "") + "_报告.html";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  /* ---------- 任务中心 ---------- */
  function renderTasks(tasks) {
    el.taskList.innerHTML = "";
    if (!tasks.length) { el.taskList.textContent = "当前文件暂无分发任务"; return; }
    tasks.forEach(function (task) {
      var row = document.createElement("div"); row.className = "task-item";
      var info = document.createElement("div"); info.className = "task-info";
      var title = document.createElement("strong"); title.textContent = (task.tester || "未分配") + " · " + task.targetCount + " 条用例";
      var meta = document.createElement("span"); meta.textContent = "创建 " + (task.createdAt || "") + (task.dueAt ? " · 截止 " + task.dueAt : "");
      info.appendChild(title); info.appendChild(meta);
      var select = document.createElement("select"); select.className = "sheet-select task-status";
      ["待执行", "执行中", "待回传", "待合入", "已完成", "导出失败"].forEach(function (status) {
        var option = document.createElement("option"); option.value = status; option.textContent = status; select.appendChild(option);
      });
      select.value = task.status || "待执行";
      select.addEventListener("change", function () { updateTask(task.taskId, select.value); });
      row.appendChild(info); row.appendChild(select); el.taskList.appendChild(row);
    });
  }
  function openTasks() {
    el.taskModal.classList.remove("hidden"); el.taskHint.textContent = "正在读取任务…";
    fetchJSON("/api/tasks").then(function (res) {
      if (!res.ok) { el.taskHint.textContent = res.d.error || "读取任务失败"; return; }
      el.taskHint.textContent = "任务状态保存在当前 Excel 文件的隐藏任务页";
      renderTasks(res.d.tasks || []);
    }).catch(function () { el.taskHint.textContent = "网络错误"; });
  }
  function closeTasks() { el.taskModal.classList.add("hidden"); }
  function updateTask(taskId, status) {
    fetchJSON("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: taskId, status: status, fileName: state.fileName,
        fileFingerprint: state.fileFingerprint }) }).then(function (res) {
      if (!res.ok) setSaveStatus(res.d.error || "任务更新失败", "error");
      else { state.fileFingerprint = res.d.fileFingerprint || state.fileFingerprint; setSaveStatus("任务状态已更新", "ok"); }
    }).catch(function () { setSaveStatus("任务更新失败", "error"); });
  }

  /* ---------- 本机设置与主题 ---------- */
  var THEME_KEY = "tcreader.darkMode";
  function applyTheme(enabled) {
    document.body.classList.toggle("dark-mode", !!enabled);
    try { localStorage.setItem(THEME_KEY, enabled ? "1" : "0"); } catch (e) {}
  }
  function loadTheme() {
    var enabled = false;
    try { enabled = localStorage.getItem(THEME_KEY) === "1"; } catch (e) {}
    applyTheme(enabled);
  }
  function openSettings() {
    el.bugUrlInput.value = bugUrlTemplate();
    el.darkModeToggle.checked = document.body.classList.contains("dark-mode");
    el.settingsModal.classList.remove("hidden");
  }
  function closeSettings() { el.settingsModal.classList.add("hidden"); }
  function saveSettings() {
    try { localStorage.setItem(BUG_URL_KEY, el.bugUrlInput.value.trim()); } catch (e) {}
    applyTheme(el.darkModeToggle.checked);
    updateBugLink(el.bugId.value);
    closeSettings();
    setSaveStatus("设置已保存", "ok");
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
      var urls = images.map(function (im) { return im.src; });
      images.forEach(function (im, idx) {
        var fig = document.createElement("figure");
        fig.className = "preview-fig";
        var img = document.createElement("img");
        img.src = im.src;
        img.loading = "lazy";   // 独立端点惰性加载，滚动到可视区才请求
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
    state.saveTimer = null;
    if (state.caseOpenedAt) {
      state.timings[rowKey(c)] = (state.timings[rowKey(c)] || 0) + Math.max(0, Date.now() - state.caseOpenedAt);
      state.caseOpenedAt = Date.now();
    }
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
      body: JSON.stringify({ name: name, fileName: state.fileName || undefined,
                             fileFingerprint: state.fileFingerprint || undefined }),
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
      body: JSON.stringify({ resultColumn: state.selectedRound || "",
                             fileName: state.fileName || undefined,
                             fileFingerprint: state.fileFingerprint || undefined }),
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
         if (res.d.fileFingerprint) state.fileFingerprint = res.d.fileFingerprint;
         setSaveStatus("已清除 " + res.d.cleared + " 条结果（已自动备份）", "ok");
      })
      .catch(function () {
        el.confirmOk.disabled = false;
        setSaveStatus("网络错误", "error");
      });
  }

  /* ---------- 子任务：导出 / 合入（团队协作测试） ---------- */
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var SUBTASK_FIELD_LABEL = {
    result: "测试结果", actual: "实际现象", bugId: "BugID",
    note: "备注", foundTime: "发现时间",
  };
  var subtaskPreviewState = null; // { importId, resultHeader, items, selections }

  // 从响应头解析下载文件名：优先 UTF-8 编码名（filename*=UTF-8''），
  // 其次 ASCII 兜底名（filename=）；解析失败返回空串由调用方兜底。
  function subtaskFileName(resp) {
    var cd = resp.headers.get("Content-Disposition") || "";
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ||
            /filename="?([^";]+)"?/i.exec(cd);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1].trim());
    } catch (e) {
      return m[1].trim();
    }
  }

  // 导出模态：展示数量与 sheet 分布，可选填分发给的测试人员
  function openExportSubtask() {
    flushSave();
    var vis = visibleIndices();
    if (!state.cases.length) { setSaveStatus("当前没有可导出的用例", "error"); return; }
    if (!vis.length) {
      if (!window.confirm("当前筛选条件下没有匹配用例，将导出全部 " +
          state.cases.length + " 条用例，是否继续？")) return;
      vis = state.cases.map(function (_, i) { return i; });
    }
    var sheetCount = {};
    vis.forEach(function (i) {
      var s = state.cases[i].sheet;
      sheetCount[s] = (sheetCount[s] || 0) + 1;
    });
    var parts = [];
    Object.keys(sheetCount).forEach(function (s) {
      parts.push(s + " " + sheetCount[s] + " 条");
    });
    var effName = vis.length ? effectiveColFor(state.cases[vis[0]].sheet).name : "";
    el.subtaskExportDesc.textContent = "将导出当前范围 " + vis.length +
      " 条用例，来自 " + parts.length + " 个工作表。";
    el.subtaskExportSheets.textContent = parts.join(" · ");
    el.subtaskTesterInput.value = state.sessionTester || "";
    el.subtaskExportHint.textContent = "子文件仅保留结果列「" + (effName || "测试结果") +
      "」，并附带行级匹配元数据；若填写分发给，将写入主文件\"测试人员\"列。";
    el.subtaskExportOk.disabled = false;
    el.subtaskExportModal.classList.remove("hidden");
    el.subtaskTesterInput.focus();
  }

  function closeExportSubtask() {
    el.subtaskExportModal.classList.add("hidden");
  }

  function doExportSubtask() {
    var vis = visibleIndices();
    if (!vis.length) {
      vis = state.cases.map(function (_, i) { return i; });
    }
    var targets = vis.map(function (i) {
      var c = state.cases[i];
      return { sheet: c.sheet, rowIndex: c.rowIndex };
    });
    el.subtaskExportOk.disabled = true;
    setSaveStatus("正在导出子任务…", "saving");
    fetch("/api/subtask/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: targets,
        tester: el.subtaskTesterInput.value.trim() || "",
        resultHeader: state.selectedRound || undefined,
        fileName: state.fileName || undefined,
        fileFingerprint: state.fileFingerprint || undefined,
        createTask: true,
        dueAt: el.subtaskDueInput.value || "",
        taskNote: el.subtaskTaskNote.value.trim() || "",
      }),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (d) {
            el.subtaskExportOk.disabled = false;
            setSaveStatus(d.error || "导出失败", "error");
          });
        }
        return r.blob().then(function (blob) {
          state.taskId = r.headers.get("X-Task-Id") || "";
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = subtaskFileName(r) || "子任务.xlsx";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // 延迟撤销对象 URL：立即 revoke 在部分浏览器（Chrome/Edge 新版、
          // 大文件/慢下载）会中断下载，导致"点击后无文件落地"
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          el.subtaskExportOk.disabled = false;
          closeExportSubtask();
          setSaveStatus("子任务已导出（主文件测试人员已更新）", "ok");
          reloadAfterSubtask();
        });
      })
      .catch(function () {
        el.subtaskExportOk.disabled = false;
        setSaveStatus("网络错误", "error");
      });
  }

  // 合入/导出写主文件后重拉负载，尽量保留页面状态
  function reloadAfterSubtask() {
    var keepIndex = state.index;
    var keepView = state.view;
    var keepFilter = JSON.parse(JSON.stringify(state.filter));
    var keepFilterOpen = state.filterOpen;
    fetchJSON("/api/cases").then(function (r2) {
      if (!r2.ok || r2.d.needsSetup) return;
      applyPayload(r2.d);
      state.index = Math.min(keepIndex, Math.max(0, state.cases.length - 1));
      state.filterOpen = keepFilterOpen;
      applyPresetFilter(keepFilter);
      showView(keepView === "setup" ? "exec" : keepView);
    });
  }

  // 导入模态：上传子文件 → 预览（三态差异表）→ 勾选确认合入
  function openImportResults() {
    flushSave();
    subtaskPreviewState = null;
    el.subtaskFileInput.value = "";
    el.subtaskImportHint.textContent = "选择辅助人员回传的子任务文件（.xlsx）后上传预览。";
    el.subtaskImportHint.classList.remove("subtask-err");
    el.subtaskPreview.classList.add("hidden");
    el.subtaskMergeResult.classList.add("hidden");
    el.subtaskMergeOk.disabled = true;
    el.subtaskImportModal.classList.remove("hidden");
  }

  function closeImportResults() {
    el.subtaskImportModal.classList.add("hidden");
  }

  function uploadSubtaskFile() {
    var file = el.subtaskFileInput.files && el.subtaskFileInput.files[0];
    if (!file) { el.subtaskImportHint.textContent = "请先选择子任务文件。"; return; }
    if (!/\.xlsx$/i.test(file.name)) {
      el.subtaskImportHint.textContent = "仅支持 .xlsx 子任务文件。";
      return;
    }
    var fd = new FormData();
    fd.append("file", file);
    fd.append("fileName", state.fileName || "");
    fd.append("fileFingerprint", JSON.stringify(state.fileFingerprint || {}));
    el.subtaskUploadBtn.disabled = true;
    el.subtaskImportHint.textContent = "正在解析并匹配…";
    el.subtaskImportHint.classList.remove("subtask-err");
    fetch("/api/subtask/import-preview", { method: "POST", body: fd })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        el.subtaskUploadBtn.disabled = false;
        if (!res.ok) {
          el.subtaskImportHint.textContent = res.d.error || "解析失败";
          el.subtaskImportHint.classList.add("subtask-err");
          return;
        }
        subtaskPreviewState = {
          importId: res.d.importId,
          resultHeader: res.d.resultHeader || "",
          items: res.d.items || [],
          selections: {},
        };
        renderSubtaskPreview(res.d);
      })
      .catch(function () {
        el.subtaskUploadBtn.disabled = false;
        el.subtaskImportHint.textContent = "网络错误";
        el.subtaskImportHint.classList.add("subtask-err");
      });
  }

  function renderSubtaskPreview(data) {
    var items = data.items || [];
    var stats = [];
    var exact = items.filter(function (it) { return it.status === "exact"; }).length;
    var fuzzy = items.filter(function (it) {
      return ["caseid", "title", "steps"].indexOf(it.status) >= 0;
    }).length;
    var conflicted = (data.conflicts || []).length;
    var unmatched = (data.unmatched || []).length;
    if (exact) stats.push('<span class="st st-ok">精确命中 ' + exact + "</span>");
    if (fuzzy) stats.push('<span class="st st-warn">模糊匹配 ' + fuzzy + "</span>");
    if (conflicted) stats.push('<span class="st st-err">冲突 ' + conflicted + "</span>");
    if (unmatched) stats.push('<span class="st st-gray">未匹配 ' + unmatched + "</span>");
    stats.push('<span class="st st-gray">结果列：' +
      escHtml(data.resultHeader || "测试结果") + "</span>");
    if (data.warning) {
      stats.push('<span class="st st-err">该子文件来源与当前主文件不一致，已按内容模糊匹配</span>');
    }
    el.subtaskStats.innerHTML = stats.join("");

    // 默认勾选：主文件为空且子文件有值
    var selections = {};
    items.forEach(function (it, idx) {
      var sel = {};
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) {
        sel[f] = !it.main[f] && !!it.sub[f];
      });
      selections[idx] = sel;
    });
    subtaskPreviewState.selections = selections;

    var html = "";
    var first = true;
    items.forEach(function (it, idx) {
      var rowClass = it.status === "unmatched" ? "row-gray" : "";
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) {
        var mainV = it.main[f] || "";
        var subV = it.sub[f] || "";
        var isConflict = it.conflicts.indexOf(f) >= 0;
        var isGap = !mainV && !!subV;
        var cellClass = isConflict ? "cell-conflict" : (isGap ? "cell-gap" : "");
        var disabled = it.status === "unmatched" || !subV;
        var checked = !disabled && !!selections[idx][f];
        html += '<tr class="' + rowClass + '">' +
          '<td class="td-case">' + (first ? escHtml(it.title || it.caseId || "(未命名)") : "") + "</td>" +
          '<td class="td-field">' + SUBTASK_FIELD_LABEL[f] + "</td>" +
          '<td class="td-val">' + escHtml(mainV) + "</td>" +
          '<td class="td-val ' + cellClass + '"><label class="subtask-check">' +
          '<input type="checkbox" data-idx="' + idx + '" data-field="' + f + '"' +
          (checked ? " checked" : "") + (disabled ? " disabled" : "") + "> " +
          escHtml(subV) + "</label></td></tr>";
        first = false;
      });
    });
    el.subtaskDiffBody.innerHTML = html ||
      '<tr><td colspan="4" class="td-empty">子文件没有可合入的条目</td></tr>';
    updateMergeButton();
    el.subtaskPreview.classList.remove("hidden");
    el.subtaskMergeResult.classList.add("hidden");
  }

  function onSubtaskCheckChange() {
    if (!subtaskPreviewState) return;
    el.subtaskDiffBody.querySelectorAll('input[type="checkbox"]:not(:disabled)')
      .forEach(function (cb) {
        var idx = parseInt(cb.getAttribute("data-idx"), 10);
        var f = cb.getAttribute("data-field");
        if (subtaskPreviewState.selections[idx]) {
          subtaskPreviewState.selections[idx][f] = cb.checked;
        }
      });
    updateMergeButton();
  }

  function countSelected() {
    if (!subtaskPreviewState) return 0;
    var n = 0;
    Object.keys(subtaskPreviewState.selections).forEach(function (idx) {
      var sel = subtaskPreviewState.selections[idx];
      Object.keys(sel).forEach(function (f) { if (sel[f]) n++; });
    });
    return n;
  }

  function updateMergeButton() {
    var n = countSelected();
    el.subtaskMergeOk.textContent = "确认合入（" + n + " 项）";
    el.subtaskMergeOk.disabled = n === 0;
  }

  // 把 selections 同步回表格 checkbox（供批量按钮）
  function syncChecks() {
    el.subtaskDiffBody.querySelectorAll('input[type="checkbox"]:not(:disabled)')
      .forEach(function (cb) {
        var idx = parseInt(cb.getAttribute("data-idx"), 10);
        var f = cb.getAttribute("data-field");
        cb.checked = !!(subtaskPreviewState.selections[idx] &&
                        subtaskPreviewState.selections[idx][f]);
      });
  }

  function selectOnlyEmpty() {
    if (!subtaskPreviewState) return;
    subtaskPreviewState.items.forEach(function (it, idx) {
      var sel = subtaskPreviewState.selections[idx] || {};
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) {
        sel[f] = !it.main[f] && !!it.sub[f];
      });
    });
    syncChecks();
    updateMergeButton();
  }

  function selectAll() {
    if (!subtaskPreviewState) return;
    subtaskPreviewState.items.forEach(function (it, idx) {
      if (it.status === "unmatched") return;
      var sel = subtaskPreviewState.selections[idx] || {};
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) {
        sel[f] = !!it.sub[f];
      });
    });
    syncChecks();
    updateMergeButton();
  }

  function selectNone() {
    if (!subtaskPreviewState) return;
    subtaskPreviewState.items.forEach(function (it, idx) {
      var sel = subtaskPreviewState.selections[idx] || {};
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) { sel[f] = false; });
    });
    syncChecks();
    updateMergeButton();
  }

  function doMergeSubtask() {
    if (!subtaskPreviewState) return;
    var approvals = [];
    subtaskPreviewState.items.forEach(function (it, idx) {
      if (it.status === "unmatched" || !it.mainRow) return;
      var fields = {};
      var sel = subtaskPreviewState.selections[idx] || {};
      Object.keys(SUBTASK_FIELD_LABEL).forEach(function (f) {
        if (sel[f]) fields[f] = it.sub[f] || "";
      });
      if (Object.keys(fields).length) {
        approvals.push({ sheet: it.sheet, mainRowIndex: it.mainRow, fields: fields });
      }
    });
    if (!approvals.length) { setSaveStatus("未勾选任何可合入的字段", "error"); return; }
    el.subtaskMergeOk.disabled = true;
    setSaveStatus("正在合入…", "saving");
    fetchJSON("/api/subtask/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        importId: subtaskPreviewState.importId,
        approvals: approvals,
        fileName: state.fileName || undefined,
        fileFingerprint: state.fileFingerprint || undefined,
        taskId: state.taskId || undefined,
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          el.subtaskMergeOk.disabled = false;
          setSaveStatus(res.d && res.d.error ? res.d.error : "合入失败", "error");
          return;
        }
        var d = res.d;
        var lines = ["合入完成：成功写入 " + d.merged + " 项" +
          (d.skipped ? "，无变化跳过 " + d.skipped + " 项" : "") +
          (d.failures && d.failures.length ? "，失败 " + d.failures.length + " 项" : "") + "。"];
        (d.failures || []).forEach(function (f) {
          lines.push("· " + (f.title || "?") + "：" + f.reason);
        });
        el.subtaskMergeResult.innerHTML = lines.map(function (l) {
          return '<div class="merge-line">' + escHtml(l) + "</div>";
        }).join("");
        el.subtaskMergeResult.classList.remove("hidden");
        el.subtaskPreview.classList.add("hidden");
        setSaveStatus("已合入 " + d.merged + " 项（已自动备份）", "ok");
        reloadAfterSubtask();
      })
      .catch(function () {
        el.subtaskMergeOk.disabled = false;
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
    el.preflightCancel.addEventListener("click", closePreflight);
    el.preflightOk.addEventListener("click", confirmPreflight);
    el.preflightModal.addEventListener("click", function (e) {
      if (e.target === el.preflightModal) closePreflight();
    });
    el.backupBtn.addEventListener("click", openBackups);
    el.backupClose.addEventListener("click", closeBackups);
    el.retryPendingBtn.addEventListener("click", retryPending);
    el.backupModal.addEventListener("click", function (e) {
      if (e.target === el.backupModal) closeBackups();
    });

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

    // 子任务：导出（含测试人员分发）与导入合入（预览三态 + 勾选确认）
    el.exportSubtaskBtn.addEventListener("click", openExportSubtask);
    el.subtaskExportCancel.addEventListener("click", closeExportSubtask);
    el.subtaskExportOk.addEventListener("click", doExportSubtask);
    el.subtaskExportModal.addEventListener("click", function (e) {
      if (e.target === el.subtaskExportModal) closeExportSubtask();
    });
    el.importResultsBtn.addEventListener("click", openImportResults);
    el.subtaskUploadBtn.addEventListener("click", uploadSubtaskFile);
    el.subtaskFileInput.addEventListener("change", function () {
      if (el.subtaskFileInput.files && el.subtaskFileInput.files[0]) {
        el.subtaskImportHint.textContent = "已选择文件，点击「上传预览」开始匹配。";
      }
    });
    el.subtaskDiffBody.addEventListener("change", onSubtaskCheckChange);
    el.subtaskOnlyEmptyBtn.addEventListener("click", selectOnlyEmpty);
    el.subtaskSelectAllBtn.addEventListener("click", selectAll);
    el.subtaskSelectNoneBtn.addEventListener("click", selectNone);
    el.subtaskMergeCancel.addEventListener("click", closeImportResults);
    el.subtaskMergeOk.addEventListener("click", doMergeSubtask);
    el.subtaskImportModal.addEventListener("click", function (e) {
      if (e.target === el.subtaskImportModal) closeImportResults();
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
      pushUndoSnapshot(state.cases[state.index]);
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
    el.compareBtn.addEventListener("click", function () { showView("compare"); });
    el.reportBtn.addEventListener("click", openReport);
    el.taskBtn.addEventListener("click", openTasks);
    el.settingsBtn.addEventListener("click", openSettings);
    el.compareMode.addEventListener("change", function () {
      state.compareMode = el.compareMode.value;
      renderCompare();
    });
    el.reportClose.addEventListener("click", closeReport);
    el.reportCopy.addEventListener("click", function () {
      var text = el.reportBody.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { setSaveStatus("报告已复制", "ok"); });
      }
    });
    el.reportDownload.addEventListener("click", downloadReport);
    el.reportHtml.addEventListener("click", downloadHtmlReport);
    el.reportModal.addEventListener("click", function (e) { if (e.target === el.reportModal) closeReport(); });
    el.taskClose.addEventListener("click", closeTasks);
    el.taskModal.addEventListener("click", function (e) { if (e.target === el.taskModal) closeTasks(); });
    el.settingsClose.addEventListener("click", closeSettings);
    el.settingsCancel.addEventListener("click", closeSettings);
    el.settingsSave.addEventListener("click", saveSettings);
    el.settingsModal.addEventListener("click", function (e) { if (e.target === el.settingsModal) closeSettings(); });
    el.evidenceInput.addEventListener("change", function () {
      if (el.evidenceInput.files && el.evidenceInput.files[0]) uploadEvidence(el.evidenceInput.files[0]);
      el.evidenceInput.value = "";
    });
    el.bugId.addEventListener("input", function () {
      el.bugId.classList.remove("attn");
      updateBugLink(el.bugId.value);
    });
    el.batchSelectAll.addEventListener("change", function () {
      var cur = state.cases[state.index];
      if (!cur) return;
      visibleIndices().forEach(function (index) {
        var c = state.cases[index];
        if (c.sheet !== cur.sheet) return;
        if (el.batchSelectAll.checked) state.selectedRows[rowKey(c)] = true;
        else delete state.selectedRows[rowKey(c)];
      });
      renderTable();
    });
    el.batchPass.addEventListener("click", function () { batchMark("PASS"); });
    el.batchNa.addEventListener("click", function () { batchMark("NA"); });
    el.batchClear.addEventListener("click", function () {
      selectedTableItems().forEach(function (it) { delete state.selectedRows[rowKey(it.c)]; });
      renderTable();
    });
    el.librarySearch.addEventListener("input", renderFileList);
    el.commandClose.addEventListener("click", closeCommandPalette);
    el.commandInput.addEventListener("input", renderCommandList);
    el.commandModal.addEventListener("click", function (e) { if (e.target === el.commandModal) closeCommandPalette(); });

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
    saveCheckpoint();
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
    if (!el.preflightModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closePreflight(); e.preventDefault(); }
      return;
    }
    if (!el.backupModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeBackups(); e.preventDefault(); }
      return;
    }
    // 子任务模态打开时：Esc 关闭并拦截其余按键
    if (!el.subtaskExportModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeExportSubtask(); e.preventDefault(); }
      return;
    }
    if (!el.subtaskImportModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeImportResults(); e.preventDefault(); }
      return;
    }
    // 快捷键速查浮层：打开时 Esc/? 关闭并拦截其余按键；? 在任意非初始页可打开
    if (!el.commandModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeCommandPalette(); e.preventDefault(); }
      return;
    }
    if (!el.reportModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeReport(); e.preventDefault(); }
      return;
    }
    if (!el.taskModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeTasks(); e.preventDefault(); }
      return;
    }
    if (!el.settingsModal.classList.contains("hidden")) {
      if (e.key === "Escape") { closeSettings(); e.preventDefault(); }
      return;
    }
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
    if (e.ctrlKey && e.key.toLowerCase() === "z" && !typing0) {
      undoLast();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "k" && !typing0) {
      openCommandPalette();
      e.preventDefault();
      return;
    }
    if (!typing0 && e.key.toLowerCase() === "f" && state.view !== "setup") {
      state.filterOpen = !state.filterOpen;
      el.filterPanel.classList.toggle("hidden", !state.filterOpen);
      e.preventDefault();
      return;
    }
    if (!typing0 && e.key.toLowerCase() === "v" && (state.view === "exec" || state.view === "table")) {
      state.preferTable = state.view !== "table";
      showView(state.preferTable ? "table" : "exec");
      e.preventDefault();
      return;
    }
    if (!typing0 && e.key.toLowerCase() === "n" && state.view === "exec") {
      jumpToNextUntested();
      e.preventDefault();
      return;
    }
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
