/* =========================================================
   Book Notes (Local)
   - localStorage 저장 (개인용 / no login)
   - 첫 화면: ✅ View(리뷰) 모드 = 마크다운 렌더
   - Edit 버튼: 편집 모드 진입 (마크다운 툴바 포함)
   - 오른쪽 리스트에서 노트 클릭:
     ✅ "리뷰(View) 모드일 때"는 계속 리뷰 모드 유지
   - OCR: 이미지 파일 -> 텍스트 (Tesseract.js)
   - History: 저장할 때마다 직전 상태 스냅샷 쌓기 + ✅ 삭제 버튼
   - ✅ History 상한(MAX_HISTORY)으로 용량 폭증 완화
   - ✅ 내부 링크는 ID 전용: [[note-xxxx]] 만 이동
   ========================================================= */

const STORAGE_KEY = "bookNotes_entries_v1";
const STORAGE_ACTIVE_KEY = "bookNotes_activeId_v1";
const STORAGE_DRAFT_KEY = "bookNotes_draft_v1";

const MAX_HISTORY = 40;

/* -----------------------------
   DOM
   ----------------------------- */
const newBtn = document.getElementById("newBtn");
const saveBtn = document.getElementById("saveBtn");
const historyBtn = document.getElementById("historyBtn");
const deleteBtn = document.getElementById("deleteBtn");
const exportBtn = document.getElementById("exportBtn");
const importFile = document.getElementById("importFile");
const editIdLabel = document.getElementById("editIdLabel");

// Mode
const viewModeBtn = document.getElementById("viewModeBtn");
const editModeBtn = document.getElementById("editModeBtn");
const viewMode = document.getElementById("viewMode");
const editMode = document.getElementById("editMode");

// View targets
const renderBox = document.getElementById("renderBox");
const viewTitle = document.getElementById("viewTitle");
const viewMeta = document.getElementById("viewMeta");

// Editor
const titleInput = document.getElementById("titleInput");
const bookInput = document.getElementById("bookInput");
const pageInput = document.getElementById("pageInput");
const contentInput = document.getElementById("contentInput");

// Markdown toolbar
const mdButtons = document.querySelectorAll("[data-md]");

// OCR
const imageFile = document.getElementById("imageFile");
const imagePreview = document.getElementById("imagePreview");
const imagePlaceholder = document.getElementById("imagePlaceholder");
const runOcrBtn = document.getElementById("runOcrBtn");
const appendOcrBtn = document.getElementById("appendOcrBtn");
const ocrOutput = document.getElementById("ocrOutput");
const progressBarInner = document.getElementById("progressBarInner");
const progressText = document.getElementById("progressText");

// List
const itemsList = document.getElementById("itemsList");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const listMeta = document.getElementById("listMeta");

// History modal
const historyModal = document.getElementById("historyModal");
const historyBackdrop = document.getElementById("historyBackdrop");
const closeHistoryBtn = document.getElementById("closeHistoryBtn");
const historyList = document.getElementById("historyList");
const historyPreview = document.getElementById("historyPreview");
const restoreVersionBtn = document.getElementById("restoreVersionBtn");
const deleteVersionBtn = document.getElementById("deleteVersionBtn");

/* -----------------------------
   State
   ----------------------------- */
let entries = [];
let activeId = null;
let mode = "view"; // "view" | "edit"
let selectedHistoryIndex = null;
let currentImageFile = null;

/* -----------------------------
   Utils
   ----------------------------- */
function now() {
  return Date.now();
}

function formatTime(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function makeId() {
  return "note-" + Math.random().toString(16).slice(2, 10);
}

function clampText(s, max = 140) {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}

/* -----------------------------
   Storage
   ----------------------------- */
function loadEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    entries = (window.seedEntries || []).map((e) => ({
      ...e,
      history: Array.isArray(e.history) ? e.history : [],
    }));
    saveEntries();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    entries = (window.seedEntries || []).map((e) => ({
      ...e,
      history: Array.isArray(e.history) ? e.history : [],
    }));
    saveEntries();
  }
}

function saveEntries() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.error(e);
    alert(
      "저장 실패(용량 초과 가능).\n\n" +
      "해결 방법:\n" +
      "1) 오래된 노트/히스토리 정리\n" +
      "2) Export로 백업 후 localStorage 정리 → Import 복원\n" +
      "3) 필요하면 IndexedDB로 이전(용량 여유 큼)"
    );
  }
}

function loadActiveId() {
  const saved = localStorage.getItem(STORAGE_ACTIVE_KEY);
  return saved || (entries[0]?.id ?? null);
}

function saveActiveId(id) {
  localStorage.setItem(STORAGE_ACTIVE_KEY, id);
}

function getEntryById(id) {
  return entries.find((e) => e.id === id) || null;
}

/* -----------------------------
   Editor sync
   ----------------------------- */
function setEditorFromEntry(entry) {
  titleInput.value = entry?.title ?? "";
  bookInput.value = entry?.book ?? "";
  pageInput.value = entry?.page ?? "";
  contentInput.value = entry?.content ?? "";
  if (editIdLabel) editIdLabel.textContent = `id ${entry?.id ?? ""}`;

}

function getEditorSnapshot() {
  return {
    title: titleInput.value.trim(),
    book: bookInput.value.trim(),
    page: pageInput.value.trim(),
    content: contentInput.value,
  };
}

/* -----------------------------
   Draft
   ----------------------------- */
function saveDraft() {
  const snap = getEditorSnapshot();
  localStorage.setItem(
    STORAGE_DRAFT_KEY,
    JSON.stringify({
      activeId,
      ...snap,
      savedAt: now(),
    })
  );
}

function loadDraftIfAny() {
  const raw = localStorage.getItem(STORAGE_DRAFT_KEY);
  if (!raw) return;

  try {
    const d = JSON.parse(raw);
    if (d?.activeId && d.activeId === activeId) {
      titleInput.value = d.title ?? titleInput.value;
      bookInput.value = d.book ?? bookInput.value;
      pageInput.value = d.page ?? pageInput.value;
      contentInput.value = d.content ?? contentInput.value;
    }
  } catch (_) { }
}

function clearDraft() {
  localStorage.removeItem(STORAGE_DRAFT_KEY);
}

/* -----------------------------
   List
   ----------------------------- */
function getFilteredSortedEntries() {
  const q = searchInput.value.trim().toLowerCase();
  let list = entries.slice();

  if (q) {
    list = list.filter((e) => {
      const hay = `${e.id}\n${e.title}\n${e.book}\n${e.page}\n${e.content}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const sortMode = sortSelect.value;
  list.sort((a, b) => {
    if (sortMode === "updatedDesc") return (b.updatedAt || 0) - (a.updatedAt || 0);
    if (sortMode === "createdDesc") return (b.createdAt || 0) - (a.createdAt || 0);
    if (sortMode === "titleAsc") return (a.title || "").localeCompare(b.title || "", "ko");
    return 0;
  });

  return list;
}

function renderList() {
  const list = getFilteredSortedEntries();
  listMeta.textContent = `총 ${entries.length}개 · 현재 표시 ${list.length}개`;
  itemsList.innerHTML = "";

  list.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "item" + (entry.id === activeId ? " is-active" : "");

    const title = document.createElement("h4");
    title.className = "item__title";
    title.textContent = entry.title || "(제목 없음)";

    const meta = document.createElement("div");
    meta.className = "item__meta";
    const book = entry.book ? entry.book : "책 미입력";
    const page = entry.page ? entry.page : "쪽/위치 미입력";
    // ✅ ID를 메타에 노출(복사해서 [[id]] 만들기 쉬움)
    meta.textContent = `${book} · ${page} · id ${entry.id} · 수정 ${formatTime(entry.updatedAt || entry.createdAt || now())}`;

    const snip = document.createElement("div");
    snip.className = "item__snippet";
    snip.textContent = clampText(entry.content, 220);

    div.appendChild(title);
    div.appendChild(meta);
    div.appendChild(snip);

    div.addEventListener("click", () => {
      const prevMode = mode;
      switchActiveEntry(entry.id);

      // ✅ 사용자가 요청한 정책:
      // "리뷰(View) 모드에서 리스트 클릭하면 항상 리뷰 유지"
      if (prevMode === "view") {
        setMode("view");
      }
      // edit 중이었다면 edit 유지(작성 흐름 유지)
    });

    itemsList.appendChild(div);
  });
}

/* -----------------------------
   Mode
   ----------------------------- */
function setMode(nextMode) {
  mode = nextMode;
  // ✅ 현재 모드를 body에 기록 (CSS에서 배경 바꾸기 위함)
  document.body.dataset.mode = mode;

  if (mode === "view") {
    viewMode.classList.remove("mode-hidden");
    editMode.classList.add("mode-hidden");

    if (saveBtn) saveBtn.disabled = true;
    renderCurrentView();
  } else {
    viewMode.classList.add("mode-hidden");
    editMode.classList.remove("mode-hidden");

    if (saveBtn) saveBtn.disabled = false;
  }
}
// ✅ 모드에 따라 버튼 강조(Primary=파란색)
if (editModeBtn) {
  editModeBtn.classList.toggle("btn--primary", mode === "edit");
}

/* -----------------------------
   View render (Markdown)
   - ✅ [[note-xxxx]]를 hash 링크로 변환 (#internal=...)
   - ✅ ID 전용 이동
   ----------------------------- */
function preprocessInternalLinks(md) {
  return (md || "").replace(/\[\[([^\]]+)\]\]/g, (_, token) => {
    const t = String(token).trim();
    // ✅ DOMPurify가 지우지 않는 hash 링크로 변환
    return `[[${t}]](#internal=${encodeURIComponent(t)})`;
  });
}

/**
 * ✅ ID 전용 해석:
 * token이 "note-xxxx" 같은 id일 때만 이동
 * (제목 매칭은 아예 제거)
 */
function resolveInternalTargetId(token) {
  const q = (token || "").trim();
  if (!q) return null;

  // ✅ id 완전 일치만 허용
  const byId = entries.find(e => e.id === q);
  return byId ? byId.id : null;
}


function renderCurrentView() {
  if (!activeId) return;
  const entry = getEntryById(activeId);
  if (!entry) return;

  viewTitle.textContent = entry.title || "(제목 없음)";

  // ✅ meta에 id를 항상 포함(내부링크용)
  const metaParts = [];
  if (entry.book) metaParts.push(escapeHtml(entry.book));
  if (entry.page) metaParts.push(escapeHtml(entry.page));

  // ✅ id만 클릭 가능한 span으로 만들기
  metaParts.push(`<span class="id-copy" data-copy-id="${entry.id}">id ${entry.id}</span>`);

  metaParts.push(`수정 ${escapeHtml(formatTime(entry.updatedAt || entry.createdAt || now()))}`);

  viewMeta.innerHTML = metaParts.join(" · ");


  const md = preprocessInternalLinks(entry.content || "");

  if (window.marked?.setOptions) {
    window.marked.setOptions({ breaks: true, gfm: true });
  }

  const html = window.marked ? window.marked.parse(md) : md;
  renderBox.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
}

// ✅ View에서 [[id]] 클릭하면 이동
if (renderBox) {
  renderBox.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;

    const href = (a.getAttribute("href") || "").trim();

    let token = null;

    // ✅ 1) 정석: #internal=note-xxxx
    if (href.startsWith("#internal=")) {
      token = decodeURIComponent(href.slice("#internal=".length));
    }

    // ✅ 2) 사용자가 note-xxxx만 써도 내부 이동으로 처리
    else if (/^note-[a-z0-9]+$/i.test(href)) {
      token = href;
    }

    // 이 앱이 처리할 링크가 아니면 종료
    else {
      return;
    }

    e.preventDefault();

    const targetId = resolveInternalTargetId(token);

    if (!targetId) {
      alert(`내부 링크 대상(id)를 찾지 못했어: [[${token}]]`);
      return;
    }

    switchActiveEntry(targetId);
    setMode("view"); // ✅ 이동 후에도 리뷰 모드 유지
  });
}

/* -----------------------------
   Switch entry
   ----------------------------- */
function switchActiveEntry(id) {
  saveDraft();

  activeId = id;
  saveActiveId(id);

  const entry = getEntryById(id);
  if (!entry) return;

  setEditorFromEntry(entry);
  renderList();

  if (mode === "view") renderCurrentView();
}

/* -----------------------------
   CRUD
   ----------------------------- */
function createNewEntry() {
  const id = makeId();
  const ts = now();

  const entry = {
    id,
    title: "새 노트",
    book: "",
    page: "",
    content: "",
    createdAt: ts,
    updatedAt: ts,
    history: [],
  };

  entries.unshift(entry);
  saveEntries();

  switchActiveEntry(id);

  // 새 노트는 작성이 목적이니 edit로
  setMode("edit");
  contentInput.focus();
}

function saveActiveEntry() {
  if (!activeId) return;
  const entry = getEntryById(activeId);
  if (!entry) return;

  const snap = getEditorSnapshot();

  entry.history = Array.isArray(entry.history) ? entry.history : [];
  entry.history.unshift({
    timestamp: now(),
    title: entry.title,
    book: entry.book,
    page: entry.page,
    content: entry.content,
  });

  // ✅ 히스토리 캡
  entry.history = entry.history.slice(0, MAX_HISTORY);

  entry.title = snap.title || "(제목 없음)";
  entry.book = snap.book;
  entry.page = snap.page;
  entry.content = snap.content;
  entry.updatedAt = now();

  saveEntries();
  clearDraft();

  renderList();
  if (mode === "view") renderCurrentView();
}

function deleteActiveEntry() {
  if (!activeId) return;
  const entry = getEntryById(activeId);
  if (!entry) return;

  const ok = confirm(`삭제할까?\n- ${entry.title}\n(삭제하면 복구가 어려워)`);
  if (!ok) return;

  entries = entries.filter((e) => e.id !== activeId);
  saveEntries();

  const nextId = entries[0]?.id ?? null;
  activeId = nextId;
  saveActiveId(nextId || "");

  if (nextId) {
    setEditorFromEntry(getEntryById(nextId));
  } else {
    titleInput.value = "";
    bookInput.value = "";
    pageInput.value = "";
    contentInput.value = "";
  }

  renderList();
  if (mode === "view") renderCurrentView();
}

/* -----------------------------
   Export / Import
   ----------------------------- */
function exportJSON() {
  const data = { exportedAt: now(), version: 1, entries };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `book-notes-export-${formatTime(now()).replace(/[: ]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

async function importJSON(file) {
  const text = await file.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    alert("Import 실패: JSON이 깨졌어.");
    return;
  }

  const incoming = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(incoming)) {
    alert("Import 실패: entries 배열을 찾을 수 없어.");
    return;
  }

  const existingIds = new Set(entries.map((e) => e.id));
  const normalized = incoming.map((e) => {
    const safe = {
      id: String(e.id || makeId()),
      title: String(e.title || "(제목 없음)"),
      book: String(e.book || ""),
      page: String(e.page || ""),
      content: String(e.content || ""),
      createdAt: Number(e.createdAt || now()),
      updatedAt: Number(e.updatedAt || e.createdAt || now()),
      history: Array.isArray(e.history) ? e.history.slice(0, MAX_HISTORY) : [],
    };

    if (existingIds.has(safe.id)) safe.id = makeId();
    existingIds.add(safe.id);

    return safe;
  });

  entries = normalized.concat(entries);
  saveEntries();

  activeId = entries[0]?.id ?? null;
  if (activeId) saveActiveId(activeId);

  setEditorFromEntry(getEntryById(activeId));
  clearDraft();

  renderList();
  if (mode === "view") renderCurrentView();
}

/* -----------------------------
   OCR
   ----------------------------- */
function resetOcrUI() {
  progressBarInner.style.width = "0%";
  progressText.textContent = "대기 중";
}

function setProgress(pct, label) {
  const v = Math.max(0, Math.min(100, pct));
  progressBarInner.style.width = `${v}%`;
  progressText.textContent = label ? `${label} (${v.toFixed(0)}%)` : `${v.toFixed(0)}%`;
}

if (imageFile) {
  imageFile.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    currentImageFile = file;

    const url = URL.createObjectURL(file);
    imagePreview.src = url;
    imagePreview.style.display = "block";
    imagePlaceholder.style.display = "none";

    resetOcrUI();
  });
}

if (runOcrBtn) {
  runOcrBtn.addEventListener("click", async () => {
    if (!currentImageFile) {
      alert("먼저 이미지 파일을 선택해줘.");
      return;
    }

    ocrOutput.value = "";
    setProgress(1, "준비");

    try {
      const result = await Tesseract.recognize(currentImageFile, "kor+eng", {
        logger: (m) => {
          if (typeof m.progress === "number") {
            setProgress(m.progress * 100, m.status);
          } else {
            progressText.textContent = m.status || "처리 중";
          }
        },
      });

      const text = result?.data?.text || "";
      ocrOutput.value = text.trim();
      setProgress(100, "완료");
    } catch (err) {
      console.error(err);
      alert("OCR 실패. 콘솔을 확인해줘.");
      resetOcrUI();
    }
  });
}

if (appendOcrBtn) {
  appendOcrBtn.addEventListener("click", () => {
    const t = ocrOutput.value.trim();
    if (!t) {
      alert("추출된 텍스트가 없어.");
      return;
    }

    const current = contentInput.value;
    const sep = current.trim().length ? "\n\n" : "";
    contentInput.value = current + sep + t;

    saveDraft();
  });
}

/* -----------------------------
   Markdown toolbar
   ----------------------------- */
function focusEditor() {
  contentInput.focus();
}

function wrapSelection(before, after) {
  focusEditor();
  const ta = contentInput;

  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);

  const insert = before + (selected || "") + after;
  ta.setRangeText(insert, start, end, "end");

  if (selected) {
    const newStart = start + before.length;
    const newEnd = newStart + selected.length;
    ta.setSelectionRange(newStart, newEnd);
  }

  saveDraft();
}

function prefixLines(prefix) {
  focusEditor();
  const ta = contentInput;
  const value = ta.value;

  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const safeLineEnd = lineEnd === -1 ? value.length : lineEnd;

  const blockStart = lineStart;
  const blockEnd = safeLineEnd;

  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n").map((l) => (l.startsWith(prefix) ? l : prefix + l));
  const next = lines.join("\n");

  ta.setRangeText(next, blockStart, blockEnd, "end");
  saveDraft();
}

function codeBlock() {
  focusEditor();
  const ta = contentInput;

  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);

  const before = "```text\n";
  const after = "\n```\n";
  const insert = before + (selected || "") + after;

  ta.setRangeText(insert, start, end, "end");

  const cursor = start + before.length + (selected ? selected.length : 0);
  ta.setSelectionRange(cursor, cursor);

  saveDraft();
}

function insertLink() {
  focusEditor();
  const ta = contentInput;

  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || "링크텍스트";

  let url = prompt("URL 또는 내부노트 id(note-xxxx)를 입력해줘");
  if (!url) return;

  url = url.trim();

  // ✅ 사용자가 'id note-xxxx'라고 넣어도 정리
  url = url.replace(/^id\s+/i, "");

  // ✅ 사용자가 note-xxxx만 넣으면 자동으로 내부링크로 보정
  if (/^note-[a-z0-9]+$/i.test(url)) {
    url = `#internal=${url}`;
  }

  const md = `[${selected}](${url})`;

  ta.setRangeText(md, start, end, "end");

  const newStart = start + 1;
  const newEnd = newStart + selected.length;
  ta.setSelectionRange(newStart, newEnd);

  saveDraft();
}

/**
 * ✅ 내부 링크 삽입: [[note-xxxx]] (id 전용)
 * - 선택 텍스트가 있으면 그것을 id로 사용
 * - 없으면 prompt로 id 입력
 */

mdButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.md;

    if (type === "h1") return prefixLines("# ");
    if (type === "h2") return prefixLines("## ");
    if (type === "bold") return wrapSelection("**", "**");
    if (type === "italic") return wrapSelection("*", "*");
    if (type === "quote") return prefixLines("> ");
    if (type === "ul") return prefixLines("- ");
    if (type === "code") return wrapSelection("`", "`");
    if (type === "codeblock") return codeBlock();
    if (type === "link") return insertLink();
  });
});

/* -----------------------------
   History modal
   ----------------------------- */
function openHistoryModal() {
  if (!activeId) return;
  const entry = getEntryById(activeId);
  if (!entry) return;

  selectedHistoryIndex = null;
  restoreVersionBtn.disabled = true;
  deleteVersionBtn.disabled = true;
  historyPreview.textContent = "";
  historyList.innerHTML = "";

  const hist = Array.isArray(entry.history) ? entry.history : [];

  if (!hist.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "아직 히스토리가 없어. Save를 하면 쌓이기 시작해.";
    empty.style.cursor = "default";
    historyList.appendChild(empty);
  } else {
    hist.forEach((h, idx) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div style="font-family: var(--mono); font-size: 12px; color: rgba(255,255,255,0.85);">
          ${formatTime(h.timestamp)}
        </div>
        <div style="font-family: var(--mono); font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 6px;">
          ${(h.title || "(제목 없음)") + " · " + (h.book || "책 미입력")}
        </div>
      `;

      item.addEventListener("click", () => {
        [...historyList.children].forEach((el) => el.classList.remove("is-selected"));
        item.classList.add("is-selected");

        selectedHistoryIndex = idx;
        restoreVersionBtn.disabled = false;
        deleteVersionBtn.disabled = false;

        historyPreview.textContent =
          `제목: ${h.title || ""}\n` +
          `책: ${h.book || ""}\n` +
          `쪽/위치: ${h.page || ""}\n` +
          `-------------------------\n` +
          (h.content || "");
      });

      historyList.appendChild(item);
    });
  }

  historyModal.classList.remove("hidden");
}

function closeHistoryModal() {
  historyModal.classList.add("hidden");
}

restoreVersionBtn.addEventListener("click", () => {
  if (selectedHistoryIndex === null) return;

  const entry = getEntryById(activeId);
  if (!entry) return;

  const hist = Array.isArray(entry.history) ? entry.history : [];
  const h = hist[selectedHistoryIndex];
  if (!h) return;

  titleInput.value = h.title ?? "";
  bookInput.value = h.book ?? "";
  pageInput.value = h.page ?? "";
  contentInput.value = h.content ?? "";

  saveDraft();
  closeHistoryModal();
  setMode("edit");
});

deleteVersionBtn.addEventListener("click", () => {
  if (selectedHistoryIndex === null) return;

  const entry = getEntryById(activeId);
  if (!entry) return;

  const hist = Array.isArray(entry.history) ? entry.history : [];
  const h = hist[selectedHistoryIndex];
  if (!h) return;

  const ok = confirm(`이 버전을 삭제할까?\n- ${formatTime(h.timestamp)}\n(노트 본문은 그대로 유지됨)`);
  if (!ok) return;

  hist.splice(selectedHistoryIndex, 1);
  entry.history = hist;
  saveEntries();

  openHistoryModal();
});

/* -----------------------------
   Events
   ----------------------------- */
newBtn.addEventListener("click", createNewEntry);
saveBtn.addEventListener("click", saveActiveEntry);
deleteBtn.addEventListener("click", deleteActiveEntry);
historyBtn.addEventListener("click", openHistoryModal);
exportBtn.addEventListener("click", exportJSON);

importFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  await importJSON(f);
  importFile.value = "";
});

historyBackdrop.addEventListener("click", closeHistoryModal);
closeHistoryBtn.addEventListener("click", closeHistoryModal);

searchInput.addEventListener("input", renderList);
sortSelect.addEventListener("change", renderList);

if (viewModeBtn) viewModeBtn.addEventListener("click", () => setMode("view"));
if (editModeBtn) editModeBtn.addEventListener("click", () => setMode("edit"));

// Draft debounce
let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft(), 400);
}
titleInput.addEventListener("input", scheduleDraftSave);
bookInput.addEventListener("input", scheduleDraftSave);
pageInput.addEventListener("input", scheduleDraftSave);
contentInput.addEventListener("input", scheduleDraftSave);

// Ctrl/Cmd + S
window.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

  if (cmdOrCtrl && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (mode === "edit") saveActiveEntry();
  }
});

/* -----------------------------
   Boot
   ----------------------------- */
function boot() {
  loadEntries();

  activeId = loadActiveId();
  if (!getEntryById(activeId)) activeId = entries[0]?.id ?? null;

  if (!activeId) {
    createNewEntry();
    return;
  }

  setEditorFromEntry(getEntryById(activeId));
  loadDraftIfAny();
  renderList();
  resetOcrUI();

  setMode("view"); // ✅ 첫 화면은 리뷰
}

boot();

// ✅ Edit 화면 id 클릭하면 복사
if (editIdLabel) {
  editIdLabel.addEventListener("click", async () => {
    const id = activeId; // 현재 노트 id
    if (!id) return;

    const original = editIdLabel.textContent;

    try {
      // 최신 브라우저(https 또는 localhost에서 동작)
      await navigator.clipboard.writeText(id);
      editIdLabel.textContent = `copied: ${id}`;
      setTimeout(() => {
        // activeId가 바뀌었을 수도 있으니 현재 상태로 복구
        if (editIdLabel) editIdLabel.textContent = `id ${activeId || ""}`;
      }, 900);
    } catch (err) {
      // 예외: 권한/환경 문제일 때 fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        ta.remove();

        editIdLabel.textContent = `copied: ${id}`;
        setTimeout(() => {
          if (editIdLabel) editIdLabel.textContent = `id ${activeId || ""}`;
        }, 900);
      } catch (_) {
        alert("복사 실패. 브라우저 권한을 확인해줘.");
      }
    }
  });
}

// ✅ View 모드: 메타 안의 "id ..." 클릭하면 복사
if (viewMeta) {
  viewMeta.addEventListener("click", async (e) => {
    const target = e.target.closest(".id-copy");
    if (!target) return;

    const id = target.dataset.copyId || activeId;
    if (!id) return;

    const original = target.textContent;

    try {
      await navigator.clipboard.writeText(id);
      target.textContent = `copied: ${id}`;
      setTimeout(() => {
        // 현재 노트 메타를 다시 그려서 원상복구
        renderCurrentView();
      }, 900);
    } catch (err) {
      // fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        ta.remove();

        target.textContent = `copied: ${id}`;
        setTimeout(() => renderCurrentView(), 900);
      } catch (_) {
        alert("복사 실패. 브라우저 권한을 확인해줘.");
      }
    }
  });
}
