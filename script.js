/* =========================================================
  Review Wiki
  - Public read + Google login edit
  - Title rename => new slug URL + old slug becomes #REDIRECT
  - History: keep only latest 10 per page
  - History view + revision detail + revert
  - Delete page + delete its revisions + delete its alias redirect pages
  - OCR in editor:
    이미지 선택 -> OCR 실행 -> 결과 확인 -> 본문 삽입/추가
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  addDoc,
  getDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* =========================================================
   Firebase config
========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyASuyxEO3eBSmJmPwV7ZVxG6rb109G_1nE",
  authDomain: "sunday-book-club.firebaseapp.com",
  projectId: "sunday-book-club",
  storageBucket: "sunday-book-club.firebasestorage.app",
  messagingSenderId: "884270943833",
  appId: "1:884270943833:web:0a9cb935d62fada86e2b48",
  measurementId: "G-L92TPDPBZN"
};

const WIKI_ID = "Review";

/* =========================================================
   왼쪽 카테고리 칩
========================================================= */
const CATEGORY_OPTIONS = ["미디어의 이해", "다른 방식으로 보기", "이미지란 무엇인가"];

/* =========================================================
   첫 화면에서 자동으로 여는 문서
========================================================= */
const HOME_PAGE_TITLE = "일요 독서모임은";
const HOME_PAGE_ID = toDocId(HOME_PAGE_TITLE);

/* =========================================================
   문서당 히스토리 최대 개수
========================================================= */
const MAX_REVISIONS_PER_PAGE = 10;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* =========================================================
   DOM
========================================================= */
const viewEl = document.getElementById("view");
const pageListEl = document.getElementById("page-list");
const sideSearchInput = document.getElementById("side-search-input");
const authBtn = document.getElementById("auth-btn");
const authStatus = document.getElementById("auth-status");
const chipWrap = document.getElementById("category-chips");

/* =========================================================
   State
========================================================= */
let currentUser = null;
let canEdit = false;

let pages = [];
let pagesReady = false;
let currentFilter = "all";
let sideQuery = "";

let __REFS = [];

/* =========================================================
   OCR 상태
   - worker를 매번 새로 만들지 않고 재사용
   - 사용자가 편집 모드에서 여러 이미지 OCR해도 조금 덜 무거움
========================================================= */
let ocrWorker = null;
let ocrLoggerProxy = null;

/* =========================================================
   Helpers
========================================================= */
function renderLoading() {
  viewEl.innerHTML = `<p class="muted">다른 방식으로 읽기 불러오는 중</p>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeSmartQuotes(s) {
  return String(s || "").replace(/[\u2018\u2019]/g, "'");
}

function formatDate(ms) {
  const d = new Date(ms || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function toDocId(title) {
  const t = (title || "").trim().replace(/\s+/g, "-");
  return encodeURIComponent(t);
}

function isUrlLike(s) {
  return /^https?:\/\//i.test(s);
}

function cleanupOcrText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* 
  본문 끝에 OCR 결과를 덧붙일 때 사용.
  기존 내용이 있으면 두 줄 띄고 추가한다.
*/
function appendBlockText(original, extra) {
  const source = String(original || "");
  const add = cleanupOcrText(extra);

  if (!add) return source;
  if (!source.trim()) return add;

  return source.replace(/\s*$/, "") + "\n\n" + add;
}

/*
  커서 위치에 텍스트 삽입.
  사용자가 본문 중간 원하는 위치에 OCR 결과를 꽂을 수 있게 해준다.
*/
function insertTextAtCursor(textarea, text) {
  if (!textarea) return;

  const insertText = String(text || "");
  const start = Number(textarea.selectionStart ?? textarea.value.length);
  const end = Number(textarea.selectionEnd ?? textarea.value.length);

  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);

  textarea.value = before + insertText + after;

  const nextPos = before.length + insertText.length;
  textarea.selectionStart = nextPos;
  textarea.selectionEnd = nextPos;
  textarea.focus();
}

/* =========================================================
   Firestore paths
========================================================= */
const pagesCol = () => collection(db, "wikis", WIKI_ID, "pages");
const pageDoc = (pageId) => doc(db, "wikis", WIKI_ID, "pages", pageId);
const revisionsCol = (pageId) => collection(db, "wikis", WIKI_ID, "pages", pageId, "revisions");

/* =========================================================
   Auth
========================================================= */
async function login() {
  const provider = new GoogleAuthProvider();

  try {
    await signInWithPopup(auth, provider);
  } catch {
    await signInWithRedirect(auth, provider);
  }
}

async function logout() {
  await signOut(auth);
}

/* =========================================================
   OCR
   - 브라우저 안에서 실행
   - Firebase Storage를 쓰지 않음
   - 이미지는 로컬 파일로만 읽고, 최종 텍스트만 저장
========================================================= */
async function getOrCreateOcrWorker(loggerCallback) {
  if (!window.Tesseract || typeof window.Tesseract.createWorker !== "function") {
    throw new Error("OCR 라이브러리를 불러오지 못했어.");
  }

  ocrLoggerProxy = typeof loggerCallback === "function" ? loggerCallback : null;

  if (ocrWorker) {
    return ocrWorker;
  }

  try {
    const { createWorker } = window.Tesseract;

    ocrWorker = await createWorker(["kor", "eng"], 1, {
      logger: (message) => {
        if (typeof ocrLoggerProxy === "function") {
          ocrLoggerProxy(message);
        }
      }
    });

    /*
      OCR 인식 보정용 파라미터
      - preserve_interword_spaces: 단어 사이 공백 보존 시도
      - user_defined_dpi: 저해상도 이미지에서 약간의 보정 효과 기대
    */
    await ocrWorker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300"
    });

    return ocrWorker;
  } catch (error) {
    ocrWorker = null;
    throw error;
  }
}

async function runOcrFromFile(file, onProgress) {
  if (!file) {
    throw new Error("OCR할 이미지 파일을 먼저 골라줘.");
  }

  const worker = await getOrCreateOcrWorker(onProgress);
  const result = await worker.recognize(file);
  return result?.data?.text || "";
}

window.addEventListener("beforeunload", async () => {
  if (ocrWorker) {
    try {
      await ocrWorker.terminate();
    } catch (error) {
      console.warn("OCR worker 종료 중 경고:", error);
    }
  }
});

/* =========================================================
   Seed
========================================================= */
async function ensureSeededOnce() {
  const snap = await getDocs(query(pagesCol(), limit(1)));
  if (!snap.empty) return;
  if (!canEdit) return;

  const seed = window.SEED_PAGES || [];
  for (const p of seed) {
    const id = toDocId(p.title);
    const now = Date.now();

    await setDoc(pageDoc(id), {
      title: p.title,
      content: p.content || "",
      createdAt: now,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown",
      aliases: []
    });

    await addRevision(id, {
      title: p.title,
      content: p.content || "",
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: "seed"
    });
  }
}

/* =========================================================
   Live listeners
========================================================= */
function startListeners() {
  onSnapshot(
    query(pagesCol(), orderBy("updatedAt", "desc")),
    (snap) => {
      pages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      pagesReady = true;
      buildChips();
      buildList();
      route();
    },
    (err) => {
      console.error(err);
      viewEl.innerHTML = `<p>데이터를 불러오지 못했어. (Rules/네트워크 확인)</p>`;
    }
  );
}

/* =========================================================
   Front matter
========================================================= */
function parseFrontMatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---\n")) return { meta: {}, body: text };

  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text };

  const header = text.slice(4, end).trim();
  const body = text.slice(end + 5);

  const meta = {};
  header.split("\n").forEach(line => {
    const idx = line.indexOf(":");
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) return;
    meta[key] = val;
  });

  return { meta, body };
}

/* =========================================================
   Redirect helpers
========================================================= */
function getRedirectTargetFromContent(content) {
  const { body } = parseFrontMatter(String(content || ""));
  const t = body.trim();

  const m = t.match(/^#redirect\s*\[\[([^\]]+)\]\]/i);
  if (!m) return null;

  const inside = (m[1] || "").trim();
  const targetTitle = inside.includes("|") ? inside.split("|")[0].trim() : inside;
  if (!targetTitle) return null;

  return { targetTitle, targetId: toDocId(targetTitle) };
}

function isRedirectPage(page) {
  return !!getRedirectTargetFromContent(page?.content || "");
}

/* =========================================================
   Category
========================================================= */
function getCategory(page) {
  if (page?.id === HOME_PAGE_ID) return "";

  const { meta } = parseFrontMatter(page.content);
  return (meta.category || meta.type || "").trim();
}

/* =========================================================
   Inline code protection
========================================================= */
function protectInlineCode(rawText) {
  const codes = [];
  const replaced = String(rawText || "").replace(/`([^`\n]+)`/g, (m, inner) => {
    const idx = codes.length;
    codes.push(inner);
    return `{{CODE:${idx}}}`;
  });
  return { text: replaced, codes };
}

/* =========================================================
   Inline render
========================================================= */
function renderInline(text) {
  let raw = normalizeSmartQuotes(String(text || ""));

  const protectedResult = protectInlineCode(raw);
  raw = protectedResult.text;
  const codes = protectedResult.codes;

  raw = raw.replace(/<!--[\s\S]*?-->/g, "");

  let t = escapeHtml(raw);

  t = t.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (m, url, label) => {
    const u = escapeHtml(url);
    const l = escapeHtml((label || url).trim());
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`;
  });

  t = t.replace(/'''''(.+?)'''''/g, "<strong><em>$1</em></strong>");
  t = t.replace(/'''(.+?)'''/g, "<strong>$1</strong>");
  t = t.replace(/''(.+?)''/g, "<em>$1</em>");

  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");

  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  });

  t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (m, alt, url) => {
    const safeUrl = escapeHtml(url);
    const safeAlt = escapeHtml(alt || "");
    return `
      <figure class="wiki-figure">
        <a class="wiki-img-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
          <img class="wiki-img" src="${safeUrl}" alt="${safeAlt}" loading="lazy" />
        </a>
        ${safeAlt ? `<figcaption class="wiki-caption">${safeAlt}</figcaption>` : ""}
      </figure>
    `;
  });

  t = t.replace(/\[\[(?:Image|File|파일|이미지)\:(https?:\/\/[^\]|]+)(?:\|([^\]]+))?\]\]/gi, (m, url, cap) => {
    const safeUrl = escapeHtml(url.trim());
    const safeCap = escapeHtml((cap || "").trim());
    return `
      <figure class="wiki-figure">
        <a class="wiki-img-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
          <img class="wiki-img" src="${safeUrl}" alt="${safeCap}" loading="lazy" />
        </a>
        ${safeCap ? `<figcaption class="wiki-caption">${safeCap}</figcaption>` : ""}
      </figure>
    `;
  });

  t = t.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
    const raw2 = (inner || "").trim();

    if (raw2.includes("|")) {
      const [targetRaw, labelRaw] = raw2.split("|");
      const target = (targetRaw || "").trim();
      const label = (labelRaw || "").trim();

      if (isUrlLike(target)) {
        return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || target)}</a>`;
      }
      return `<a href="#/page/${toDocId(target)}">${escapeHtml(label || target)}</a>`;
    }

    if (isUrlLike(raw2)) {
      return `<a href="${escapeHtml(raw2)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw2)}</a>`;
    }

    return `<a href="#/page/${toDocId(raw2)}">${escapeHtml(raw2)}</a>`;
  });

  t = t.replace(/\{\{REF:(\d+)\}\}/g, (m, n) => {
    const num = Number(n);
    return `<sup class="ref"><a href="#ref-${num}" id="refback-${num}">[${num}]</a></sup>`;
  });

  t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  t = t.replace(/\{\{CODE:(\d+)\}\}/g, (m, idxStr) => {
    const idx = Number(idxStr);
    const codeRaw = codes[idx] ?? "";
    return `<code class="inline-code">${escapeHtml(codeRaw)}</code>`;
  });

  return t;
}

/* =========================================================
   Code blocks
========================================================= */
function extractFencedCodeBlocks(lines) {
  const blocks = [];
  const outLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.trim().match(/^(```|~~~)/);
    if (!m) {
      outLines.push(line);
      continue;
    }

    const fence = m[1];
    const codeLines = [];
    i++;

    while (i < lines.length && !lines[i].trim().startsWith(fence)) {
      codeLines.push(lines[i]);
      i++;
    }

    const id = blocks.length;
    blocks.push(codeLines.join("\n"));
    outLines.push(`{{CODEBLOCK:${id}}}`);
  }

  return { lines: outLines, blocks };
}

function protectInlineCodeWholeText(text) {
  const codes = [];
  const out = String(text || "").replace(/`([^`\n]+)`/g, (m, inner) => {
    const idx = codes.length;
    codes.push(inner);
    return `{{INLINECODE:${idx}}}`;
  });
  return { text: out, codes };
}

function restoreInlineCodeWholeText(text, codes) {
  return String(text || "").replace(/\{\{INLINECODE:(\d+)\}\}/g, (m, n) => {
    const idx = Number(n);
    const inner = codes[idx] ?? "";
    return "`" + inner + "`";
  });
}

/* =========================================================
   MediaWiki list
========================================================= */
function consumeMwList(lines, startIndex) {
  let i = startIndex;
  const out = [];
  const stack = [];
  let openLiDepth = 0;

  function typeOf(ch) { return ch === "*" ? "ul" : "ol"; }

  function closeLiIfNeeded(targetDepth) {
    if (openLiDepth > 0 && targetDepth <= openLiDepth) {
      out.push("</li>");
      openLiDepth = 0;
    }
  }

  function closeListsTo(commonDepth) {
    while (stack.length > commonDepth) {
      if (openLiDepth === stack.length) {
        out.push("</li>");
        openLiDepth = 0;
      }
      out.push(`</${stack.pop()}>`);
    }
  }

  function openListsFrom(commonDepth, targetTypes) {
    for (let d = commonDepth; d < targetTypes.length; d++) {
      out.push(`<${targetTypes[d]}>`);
      stack.push(targetTypes[d]);
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([*#]+)\s+(.*)$/);
    if (!m) break;

    const prefix = m[1];
    const itemText = m[2];
    const targetTypes = prefix.split("").map(typeOf);

    let common = 0;
    while (common < stack.length && common < targetTypes.length && stack[common] === targetTypes[common]) {
      common++;
    }

    closeLiIfNeeded(targetTypes.length);
    closeListsTo(common);
    openListsFrom(common, targetTypes);

    if (openLiDepth === targetTypes.length) {
      out.push("</li>");
      openLiDepth = 0;
    }

    out.push(`<li>${renderInline(itemText)}`);
    openLiDepth = targetTypes.length;

    i++;
  }

  if (openLiDepth > 0) out.push("</li>");
  while (stack.length > 0) out.push(`</${stack.pop()}>`);

  return { html: out.join(""), nextIndex: i };
}

function renderParagraphWithLineBreaks(linesBuf) {
  return linesBuf.map(line => renderInline(line)).join("<br>");
}

/* =========================================================
   Wiki render
========================================================= */
function renderWiki(body) {
  const originalLines = normalizeSmartQuotes(String(body || ""))
    .replaceAll("\r\n", "\n")
    .split("\n");

  const extracted = extractFencedCodeBlocks(originalLines);
  let text = extracted.lines.join("\n");
  const codeBlocks = extracted.blocks;

  const inlineProtected = protectInlineCodeWholeText(text);
  text = inlineProtected.text;
  const inlineCodes = inlineProtected.codes;

  text = text.replace(/<!--[\s\S]*?-->/g, "");

  __REFS = [];
  text = text.replace(/<ref>([\s\S]*?)<\/ref>/gi, (m, inner) => {
    __REFS.push((inner || "").trim());
    return `{{REF:${__REFS.length}}}`;
  });

  text = text.replace(
    /\{\{\s*숨김\s*시작\s*\|\s*제목\s*=\s*([^}]+?)\s*\}\}/g,
    (m, titleRaw) => `\n{{HIDE_START:${encodeURIComponent(String(titleRaw).trim())}}}\n`
  );
  text = text.replace(/\{\{\s*숨김\s*끝\s*\}\}/g, "\n{{HIDE_END}}\n");

  text = restoreInlineCodeWholeText(text, inlineCodes);

  const lines = text.split("\n");

  function renderFromLines(localLines) {
    const out = [];
    let i = 0;

    while (i < localLines.length) {
      const line = localLines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      const cb = line.trim().match(/^\{\{CODEBLOCK:(\d+)\}\}$/);
      if (cb) {
        const idx = Number(cb[1]);
        const codeText = codeBlocks[idx] ?? "";
        out.push(`<pre class="code-block"><code>${escapeHtml(codeText)}</code></pre>`);
        i++;
        continue;
      }

      const hs = line.trim().match(/^\{\{HIDE_START:(.+)\}\}$/);
      if (hs) {
        const title = decodeURIComponent(hs[1] || "");
        i++;

        const inner = [];
        let depth = 1;

        while (i < localLines.length) {
          const l = localLines[i];
          const hs2 = l.trim().match(/^\{\{HIDE_START:(.+)\}\}$/);
          const he2 = l.trim() === "{{HIDE_END}}";

          if (hs2) {
            depth++;
            inner.push(l);
            i++;
            continue;
          }
          if (he2) {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
            inner.push(l);
            i++;
            continue;
          }

          inner.push(l);
          i++;
        }

        const innerHtml = renderFromLines(inner);
        out.push(`
          <details class="mw-hide">
            <summary>${escapeHtml(title)}</summary>
            <div class="mw-hide-body">${innerHtml}</div>
          </details>
        `);
        continue;
      }

      if (line.trim() === "{{HIDE_END}}") {
        i++;
        continue;
      }

      if (/^<references\s*\/\s*>$/i.test(line.trim())) {
        if (!__REFS.length) {
          out.push(`<p class="muted">각주가 아직 없습니다.</p>`);
        } else {
          const items = __REFS.map((refText, idx) => {
            const n = idx + 1;
            return `<li id="ref-${n}">${renderInline(refText)} <a href="#refback-${n}">↩︎</a></li>`;
          }).join("");
          out.push(`<ol class="reflist">${items}</ol>`);
        }
        i++;
        continue;
      }

      const mwHeading = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
      if (mwHeading) {
        const level = Math.min(6, Math.max(2, mwHeading[1].length));
        out.push(`<h${level}>${renderInline(mwHeading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (line.trim() === "---") {
        out.push("<hr />");
        i++;
        continue;
      }

      if (/^[*#]+\s+/.test(line)) {
        const { html, nextIndex } = consumeMwList(localLines, i);
        out.push(html);
        i = nextIndex;
        continue;
      }

      if (line.startsWith(">")) {
        const buf = [];
        while (i < localLines.length && localLines[i].startsWith(">")) {
          buf.push(localLines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${buf.map(l => `<p>${renderInline(l)}</p>`).join("")}</blockquote>`);
        continue;
      }

      const buf = [];
      while (i < localLines.length && localLines[i].trim()) {
        buf.push(localLines[i]);
        i++;
      }
      out.push(`<p>${renderParagraphWithLineBreaks(buf)}</p>`);
    }

    return out.join("\n");
  }

  return renderFromLines(lines);
}

/* =========================================================
   History
========================================================= */
async function pruneRevisions(pageId) {
  try {
    const snap = await getDocs(query(revisionsCol(pageId), orderBy("savedAt", "desc")));
    const docs = snap.docs;
    if (docs.length <= MAX_REVISIONS_PER_PAGE) return;

    const toDelete = docs.slice(MAX_REVISIONS_PER_PAGE);
    for (const d of toDelete) {
      await deleteDoc(d.ref);
    }
  } catch (e) {
    console.warn("pruneRevisions failed:", e);
  }
}

async function addRevision(pageId, { title, content, savedBy, savedAt, note }) {
  if (!canEdit) return;

  await addDoc(revisionsCol(pageId), {
    title,
    content,
    savedBy: savedBy || "unknown",
    savedAt: savedAt || Date.now(),
    note: note || ""
  });

  await pruneRevisions(pageId);
}

/* =========================================================
   Delete page
========================================================= */
async function deleteAllRevisions(pageId) {
  while (true) {
    const snap = await getDocs(query(revisionsCol(pageId), limit(50)));
    if (snap.empty) break;
    for (const d of snap.docs) await deleteDoc(d.ref);
  }
}

async function deletePageCompletely(pageId) {
  if (!canEdit) {
    alert("삭제하려면 로그인해야 해.");
    return;
  }

  const page = pages.find(p => p.id === pageId);
  const title = page?.title || pageId;

  const ok = confirm(
    `정말 삭제할까?\n\n- 문서: ${title}\n- 히스토리(리비전)도 함께 삭제됨\n\n되돌리기 어렵다.`
  );
  if (!ok) return;

  try {
    const aliasIds = Array.isArray(page?.aliases) ? page.aliases : [];
    for (const aliasId of aliasIds) {
      await deleteAllRevisions(aliasId);
      await deleteDoc(pageDoc(aliasId));
    }

    await deleteAllRevisions(pageId);
    await deleteDoc(pageDoc(pageId));

    location.hash = "#/";
  } catch (e) {
    console.error(e);
    alert("삭제 실패(권한/네트워크/Rules 확인)");
  }
}

/* =========================================================
   Chips UI
========================================================= */
function buildChips() {
  chipWrap.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `chip ${currentFilter === "all" ? "is-active" : ""}`;
  allBtn.textContent = "전체";
  allBtn.addEventListener("click", () => {
    currentFilter = "all";
    buildChips();
    buildList();
  });
  chipWrap.appendChild(allBtn);

  CATEGORY_OPTIONS.forEach(cat => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip ${currentFilter === cat ? "is-active" : ""}`;
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      currentFilter = cat;
      buildChips();
      buildList();
    });
    chipWrap.appendChild(btn);
  });
}

/* =========================================================
   Sidebar list
========================================================= */
function buildList() {
  const qText = sideQuery.trim().toLowerCase();

  let list = [...pages];
  list = list.filter(p => !isRedirectPage(p));

  if (currentFilter !== "all") {
    list = list.filter(p => getCategory(p) === currentFilter);
  }

  if (qText) {
    list = list.filter(p => (p.title || "").toLowerCase().includes(qText));
  }

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  pageListEl.innerHTML = list.map(p => {
    const cat = getCategory(p);
    const hint = `${cat ? cat + " · " : ""}${formatDate(p.updatedAt || p.createdAt)}`;
    return `
      <li class="page-item" data-slug="${escapeHtml(p.id)}">
        <div class="t">${escapeHtml(p.title)}</div>
        <div class="m">${escapeHtml(hint)}</div>
      </li>
    `;
  }).join("");

  pageListEl.querySelectorAll(".page-item").forEach(li => {
    li.addEventListener("click", () => {
      location.hash = `#/page/${li.getAttribute("data-slug")}`;
    });
  });
}

/* =========================================================
   Routing
========================================================= */
function route() {
  if (!pagesReady) {
    renderLoading();
    return;
  }

  const hash = location.hash || "#/";
  const [path, qs] = hash.replace("#", "").split("?");

  if (path === "/") return renderGuideHome();
  if (path === "/recent") return renderRecent();

  if (path === "/search") {
    const params = new URLSearchParams(qs || "");
    return renderSearch((params.get("q") || "").trim());
  }

  if (path === "/new") return renderEditor({ mode: "new" });
  if (path.startsWith("/page/")) return renderPage(path.replace("/page/", ""));
  if (path.startsWith("/edit/")) return renderEditor({ mode: "edit", slug: path.replace("/edit/", "") });
  if (path.startsWith("/history/")) return renderHistory(path.replace("/history/", ""));

  if (path.startsWith("/revision/")) {
    const rest = path.replace("/revision/", "");
    const [pageId, revId] = rest.split("/");
    return renderRevision(pageId, revId);
  }

  location.hash = "#/";
}

function renderGuideHome() {
  const exists = pages.some(p => p.id === HOME_PAGE_ID);
  if (exists) return renderPage(HOME_PAGE_ID);
  return renderRecent();
}

function renderRecent() {
  const recent = [...pages]
    .filter(p => !isRedirectPage(p))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 10);

  viewEl.innerHTML = `
    <h2 class="page-title">최근</h2>
    <ul>
      ${recent.map(p => `<li><a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a></li>`).join("")}
    </ul>
  `;
}

/* =========================================================
   Page view
========================================================= */
function renderPage(pageId) {
  const page = pages.find(p => p.id === pageId);

  if (!page) {
    viewEl.innerHTML = `<h2 class="page-title">없음</h2><p>문서를 찾지 못했어.</p>`;
    return;
  }

  const redirect = getRedirectTargetFromContent(page.content);
  if (redirect) {
    viewEl.innerHTML = `
      <h2 class="page-title">${escapeHtml(page.title)}</h2>
      <p class="muted">
        이 문서는 <a href="#/page/${escapeHtml(redirect.targetId)}">${escapeHtml(redirect.targetTitle)}</a> 로 이동했습니다. 이동 중…
      </p>
      <div class="tools-row">
        <button class="tool-link" type="button" id="go-btn">이동</button>
        <button class="tool-link" type="button" id="stay-btn">여기 머물기</button>
        <button class="tool-link" type="button" id="history-direct-btn">히스토리</button>
      </div>
    `;

    const timer = setTimeout(() => {
      location.hash = `#/page/${redirect.targetId}`;
    }, 200);

    document.getElementById("go-btn").addEventListener("click", () => {
      clearTimeout(timer);
      location.hash = `#/page/${redirect.targetId}`;
    });

    document.getElementById("stay-btn").addEventListener("click", () => {
      clearTimeout(timer);
    });

    document.getElementById("history-direct-btn").addEventListener("click", () => {
      clearTimeout(timer);
      location.hash = `#/history/${pageId}`;
    });

    return;
  }

  const { meta, body } = parseFrontMatter(page.content);
  const metaBits = [];
  if (meta.category) metaBits.push(`category: ${meta.category}`);
  if (meta.tags) metaBits.push(`tags: ${meta.tags}`);

  viewEl.innerHTML = `
    <h2 class="page-title">${escapeHtml(page.title)}</h2>

    <div class="meta-row">
      <span>최종 편집: ${escapeHtml(formatDate(page.updatedAt || page.createdAt))}</span>
      ${page.updatedBy ? `<span>·</span><span>by ${escapeHtml(page.updatedBy)}</span>` : ""}
      ${metaBits.length ? `<span>·</span><span>${escapeHtml(metaBits.join(" · "))}</span>` : ""}
    </div>

    <hr />

    <div class="doc">${renderWiki(body)}</div>

    <div class="tools-row">
      <button class="tool-link" type="button" id="edit-btn">편집</button>
      <button class="tool-link" type="button" id="history-btn">히스토리</button>
      ${canEdit ? `<button class="tool-link" type="button" id="delete-btn">문서 삭제</button>` : ""}
    </div>
  `;

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (!canEdit) return alert("편집하려면 로그인해야 해.");
    location.hash = `#/edit/${pageId}`;
  });

  document.getElementById("history-btn").addEventListener("click", () => {
    location.hash = `#/history/${pageId}`;
  });

  const delBtn = document.getElementById("delete-btn");
  if (delBtn) {
    delBtn.addEventListener("click", () => deletePageCompletely(pageId));
  }
}

/* =========================================================
   Search
========================================================= */
function renderSearch(q) {
  const queryText = (q || "").trim();
  const normalized = queryText.toLowerCase();

  const searchable = pages.filter(p => !isRedirectPage(p));
  const results = queryText
    ? searchable.filter(p => ((p.title || "") + "\n" + (p.content || "")).toLowerCase().includes(normalized))
    : [];

  viewEl.innerHTML = `
    <h2 class="page-title">검색</h2>
    <div class="editor">
      <label>검색어</label>
      <input id="search-input" type="text" value="${escapeHtml(queryText)}" placeholder="검색어..." />
    </div>
    <hr />
    ${queryText
      ? (results.length
        ? `<ul>${results.map(p => `<li><a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a></li>`).join("")}</ul>`
        : `<p>결과가 없어.</p>`)
      : `<p>검색어를 입력해줘.</p>`
    }
  `;

  const input = document.getElementById("search-input");
  input.addEventListener("input", () => {
    const val = input.value.trim();
    location.hash = val ? `#/search?q=${encodeURIComponent(val)}` : "#/search";
  });
}

/* =========================================================
   History view
========================================================= */
async function renderHistory(pageId) {
  viewEl.innerHTML = `<h2 class="page-title">히스토리</h2><p class="muted">불러오는 중...</p>`;

  try {
    const snap = await getDocs(
      query(revisionsCol(pageId), orderBy("savedAt", "desc"), limit(MAX_REVISIONS_PER_PAGE))
    );
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    viewEl.innerHTML = `
      <h2 class="page-title">히스토리</h2>
      <p class="muted">최신 ${MAX_REVISIONS_PER_PAGE}개</p>

      ${rows.length ? `
        <ul>
          ${rows.map(r => `
            <li>
              <a href="#/revision/${escapeHtml(pageId)}/${escapeHtml(r.id)}">
                ${escapeHtml(formatDate(r.savedAt))}
              </a>
              <span class="muted"> · ${escapeHtml(r.savedBy || "")}${r.note ? ` · ${escapeHtml(r.note)}` : ""}</span>
            </li>
          `).join("")}
        </ul>
      ` : `<p>아직 기록이 없어.</p>`}

      <div class="tools-row">
        <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
      </div>
    `;
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = `<h2 class="page-title">히스토리</h2><p>불러오지 못했어.</p>`;
  }
}

/* =========================================================
   Revision detail + revert
========================================================= */
async function renderRevision(pageId, revId) {
  viewEl.innerHTML = `<h2 class="page-title">리비전</h2><p class="muted">불러오는 중...</p>`;

  try {
    const snap = await getDoc(doc(db, "wikis", WIKI_ID, "pages", pageId, "revisions", revId));
    if (!snap.exists()) {
      viewEl.innerHTML = `<h2 class="page-title">리비전 없음</h2>`;
      return;
    }

    const r = snap.data();

    viewEl.innerHTML = `
      <h2 class="page-title">리비전</h2>
      <div class="meta-row">
        <span>${escapeHtml(formatDate(r.savedAt))}</span>
        ${r.savedBy ? `<span>·</span><span>${escapeHtml(r.savedBy)}</span>` : ""}
        ${r.note ? `<span>·</span><span>${escapeHtml(r.note)}</span>` : ""}
      </div>

      <div class="doc">${renderWiki(String(r.content || ""))}</div>

      <div class="tools-row">
        <button class="tool-link" type="button" onclick="location.hash='#/history/${escapeHtml(pageId)}'">히스토리로</button>
        <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
        ${canEdit ? `<button class="tool-link" type="button" id="revert-btn">이 버전으로 되돌리기</button>` : ""}
      </div>
    `;

    if (canEdit) {
      document.getElementById("revert-btn").addEventListener("click", async () => {
        const ok = confirm("현재 문서를 이 리비전으로 되돌릴까? (되돌리기도 히스토리에 기록됨)");
        if (!ok) return;

        const current = pages.find(p => p.id === pageId);
        const createdAt = current?.createdAt || Date.now();
        const title = current?.title || "(untitled)";
        const now = Date.now();
        const nextContent = String(r.content || "");

        await setDoc(pageDoc(pageId), {
          title,
          content: nextContent,
          createdAt,
          updatedAt: now,
          updatedBy: currentUser?.email || "unknown",
          aliases: Array.isArray(current?.aliases) ? current.aliases : []
        });

        await addRevision(pageId, {
          title,
          content: nextContent,
          savedBy: currentUser?.email || "unknown",
          savedAt: now,
          note: `revert:${revId}`
        });

        location.hash = `#/page/${pageId}`;
      });
    }
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = `<h2 class="page-title">리비전 오류</h2><p>불러오지 못했어.</p>`;
  }
}

/* =========================================================
   Save page
========================================================= */
async function savePage({ mode, oldId, title, content }) {
  if (!canEdit) throw new Error("not logged in");

  const now = Date.now();
  const isEdit = mode === "edit" && !!oldId;

  const newId = toDocId(title);

  const prev = isEdit ? pages.find(p => p.id === oldId) : null;
  const prevCreatedAt = prev?.createdAt || now;
  const prevAliases = Array.isArray(prev?.aliases) ? prev.aliases : [];

  const dest = pages.find(p => p.id === newId) || null;
  const existsNew = !!dest;

  if (!isEdit && existsNew) {
    throw new Error("이미 같은 제목(슬러그)의 문서가 존재합니다.");
  }

  if (isEdit && newId === oldId) {
    await setDoc(pageDoc(oldId), {
      title,
      content,
      createdAt: prevCreatedAt,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown",
      aliases: prevAliases
    });

    await addRevision(oldId, {
      title,
      content,
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: "edit"
    });

    return oldId;
  }

  if (isEdit && oldId && oldId !== newId && existsNew) {
    const destAliases = Array.isArray(dest.aliases) ? dest.aliases : [];

    await addRevision(newId, {
      title: dest.title || title,
      content: String(dest.content || ""),
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `backup-before-overwrite-from:${oldId}`
    });

    const destCreatedAt = typeof dest.createdAt === "number" ? dest.createdAt : now;
    const createdAt = Math.min(destCreatedAt, prevCreatedAt);

    const mergedAliases = Array.from(new Set([...destAliases, ...prevAliases, oldId]));

    await setDoc(pageDoc(newId), {
      title,
      content,
      createdAt,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown",
      aliases: mergedAliases
    });

    await addRevision(newId, {
      title,
      content,
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `overwrite-from:${oldId}`
    });

    const oldTitle = prev?.title || oldId;
    const redirectContent =
      `---
redirect: true
---
#REDIRECT [[${title}]]`;

    await setDoc(pageDoc(oldId), {
      title: oldTitle,
      content: redirectContent,
      createdAt: prevCreatedAt,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown"
    });

    await addRevision(oldId, {
      title: oldTitle,
      content: redirectContent,
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `redirect-to:${newId}`
    });

    return newId;
  }

  const aliases = isEdit ? Array.from(new Set([...prevAliases, oldId])) : [];

  await setDoc(pageDoc(newId), {
    title,
    content,
    createdAt: prevCreatedAt,
    updatedAt: now,
    updatedBy: currentUser?.email || "unknown",
    aliases
  });

  await addRevision(newId, {
    title,
    content,
    savedBy: currentUser?.email || "unknown",
    savedAt: now,
    note: isEdit ? `rename-from:${oldId}` : "new"
  });

  if (isEdit && oldId && oldId !== newId) {
    const oldTitle = prev?.title || oldId;
    const redirectContent =
      `---
redirect: true
---
#REDIRECT [[${title}]]`;

    await setDoc(pageDoc(oldId), {
      title: oldTitle,
      content: redirectContent,
      createdAt: prevCreatedAt,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown"
    });

    await addRevision(oldId, {
      title: oldTitle,
      content: redirectContent,
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `redirect-to:${newId}`
    });
  }

  return newId;
}

/* =========================================================
   Editor
   - 여기서 OCR UI를 함께 렌더링한다.
========================================================= */
function renderEditor({ mode, slug }) {
  if (!canEdit) {
    viewEl.innerHTML = `
      <h2 class="page-title">편집하려면 로그인</h2>
      <div class="tools-row">
        <button class="tool-link" type="button" id="login-now">로그인</button>
        <button class="tool-link" type="button" onclick="location.hash='#/'">닫기</button>
      </div>
    `;
    document.getElementById("login-now").addEventListener("click", login);
    return;
  }

  const editing = mode === "edit" ? pages.find(p => p.id === slug) : null;
  const titleValue = editing ? editing.title : "";
  const contentValue = editing
    ? editing.content
    : `---\ncategory: ${CATEGORY_OPTIONS[0]}\ntags:\n---\n\n== 제목 ==\n내용...\n`;

  viewEl.innerHTML = `
    <h2 class="page-title">${mode === "edit" ? "편집" : "새 문서"}</h2>

    <div class="editor">
      <label>제목</label>
      <input id="edit-title" type="text" value="${escapeHtml(titleValue)}" />

      <label>내용</label>
      <textarea id="edit-content" spellcheck="false">${escapeHtml(contentValue)}</textarea>

      <!-- =====================================================
           OCR UI
           - 파일 선택
           - OCR 실행
           - 결과 확인
           - 본문에 삽입 / 본문 끝에 추가
      ====================================================== -->
      <div class="ocr-panel">
        <div class="ocr-head">
          <div class="ocr-title">OCR</div>
          <div class="ocr-help">이미지 속 글자를 추출해서 본문에 넣을 수 있어</div>
        </div>

        <div class="ocr-actions">
          <input
            id="ocr-file"
            class="ocr-file-input"
            type="file"
            accept="image/*"
          />
          <button class="btn" type="button" id="ocr-run-btn">이미지에서 텍스트 추출</button>
          <button class="btn" type="button" id="ocr-insert-btn" disabled>커서 위치에 삽입</button>
          <button class="btn" type="button" id="ocr-append-btn" disabled>본문 끝에 추가</button>
        </div>

        <div class="ocr-status" id="ocr-status">
          이미지를 선택한 뒤 "이미지에서 텍스트 추출"을 눌러줘.
        </div>

        <div class="ocr-progress" aria-hidden="true">
          <span class="ocr-progress-bar" id="ocr-progress-bar"></span>
        </div>

        <img id="ocr-preview" class="ocr-preview" alt="OCR 미리보기" hidden />

        <div class="ocr-result-wrap">
          <div class="ocr-result-label">추출 결과 (필요하면 여기서 직접 정리한 뒤 본문에 넣어도 됨)</div>
          <textarea
            id="ocr-result"
            class="ocr-result"
            spellcheck="false"
            placeholder="OCR 결과가 여기 표시돼."
          ></textarea>
        </div>
      </div>

      <div class="editor-actions">
        <button class="btn primary" type="button" id="save-btn">저장</button>
        <button class="btn" type="button" id="cancel-btn">취소</button>
      </div>
    </div>
  `;

  const titleInput = document.getElementById("edit-title");
  const contentInput = document.getElementById("edit-content");

  /* OCR 관련 DOM */
  const ocrFileInput = document.getElementById("ocr-file");
  const ocrRunBtn = document.getElementById("ocr-run-btn");
  const ocrInsertBtn = document.getElementById("ocr-insert-btn");
  const ocrAppendBtn = document.getElementById("ocr-append-btn");
  const ocrStatus = document.getElementById("ocr-status");
  const ocrProgressBar = document.getElementById("ocr-progress-bar");
  const ocrPreview = document.getElementById("ocr-preview");
  const ocrResult = document.getElementById("ocr-result");

  let previewUrl = "";

  function setOcrStatus(message) {
    ocrStatus.textContent = message;
  }

  function setOcrProgress(percent) {
    const value = Math.max(0, Math.min(100, Number(percent || 0)));
    ocrProgressBar.style.width = `${value}%`;
  }

  function resetOcrResultState() {
    ocrResult.value = "";
    ocrInsertBtn.disabled = true;
    ocrAppendBtn.disabled = true;
    setOcrProgress(0);
  }

  /*
    파일이 선택되면:
    - 이전 결과 비움
    - 새 이미지 미리보기 보여줌
  */
  ocrFileInput.addEventListener("change", () => {
    const file = ocrFileInput.files?.[0];
    resetOcrResultState();

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }

    if (!file) {
      ocrPreview.hidden = true;
      ocrPreview.removeAttribute("src");
      setOcrStatus('이미지를 선택한 뒤 "이미지에서 텍스트 추출"을 눌러줘.');
      return;
    }

    previewUrl = URL.createObjectURL(file);
    ocrPreview.src = previewUrl;
    ocrPreview.hidden = false;
    setOcrStatus(`선택된 파일: ${file.name}`);
  });

  /*
    OCR 실행:
    - 처음 한 번은 worker와 언어 데이터를 준비하느라 느릴 수 있음
    - 결과는 먼저 아래 별도 textarea에 넣음
  */
  ocrRunBtn.addEventListener("click", async () => {
    const file = ocrFileInput.files?.[0];

    if (!file) {
      alert("OCR할 이미지 파일을 먼저 선택해줘.");
      return;
    }

    ocrRunBtn.disabled = true;
    ocrInsertBtn.disabled = true;
    ocrAppendBtn.disabled = true;
    setOcrProgress(0);
    setOcrStatus("OCR 준비 중이야... 처음 한 번은 조금 걸릴 수 있어.");

    try {
      const text = await runOcrFromFile(file, (message) => {
        const status = String(message?.status || "");
        const progress = typeof message?.progress === "number"
          ? Math.round(message.progress * 100)
          : 0;

        setOcrProgress(progress);

        if (status) {
          setOcrStatus(`OCR 진행 중: ${status.replaceAll("_", " ")} ${progress ? `(${progress}%)` : ""}`);
        }
      });

      const cleanedText = cleanupOcrText(text);
      ocrResult.value = cleanedText;

      if (cleanedText) {
        ocrInsertBtn.disabled = false;
        ocrAppendBtn.disabled = false;
        setOcrProgress(100);
        setOcrStatus("OCR이 끝났어. 결과를 확인한 뒤 본문에 넣어줘.");
      } else {
        setOcrStatus("문자를 거의 찾지 못했어. 해상도가 더 높은 이미지로 다시 시도해봐.");
      }
    } catch (error) {
      console.error(error);
      setOcrStatus("OCR 중 오류가 났어.");
      alert(error?.message || "OCR 실행 중 오류가 났어.");
    } finally {
      ocrRunBtn.disabled = false;
    }
  });

  /*
    OCR 결과를 현재 커서 위치에 삽입
  */
  ocrInsertBtn.addEventListener("click", () => {
    const text = cleanupOcrText(ocrResult.value);
    if (!text) {
      alert("삽입할 OCR 결과가 없어.");
      return;
    }

    insertTextAtCursor(contentInput, text);
    setOcrStatus("OCR 결과를 커서 위치에 삽입했어.");
  });

  /*
    OCR 결과를 본문 끝에 덧붙이기
  */
  ocrAppendBtn.addEventListener("click", () => {
    const text = cleanupOcrText(ocrResult.value);
    if (!text) {
      alert("추가할 OCR 결과가 없어.");
      return;
    }

    contentInput.value = appendBlockText(contentInput.value, text);
    contentInput.focus();
    contentInput.selectionStart = contentInput.selectionEnd = contentInput.value.length;
    setOcrStatus("OCR 결과를 본문 끝에 추가했어.");
  });

  document.getElementById("save-btn").addEventListener("click", async () => {
    const newTitle = titleInput.value.trim();
    const newContent = contentInput.value;

    if (!newTitle) {
      alert("제목을 입력해줘.");
      return;
    }

    try {
      const newId = await savePage({
        mode,
        oldId: editing?.id || null,
        title: newTitle,
        content: newContent
      });
      location.hash = `#/page/${newId}`;
    } catch (e) {
      console.error(e);
      alert(e?.message || "저장 실패(권한/네트워크/중복 제목).");
    }
  });

  document.getElementById("cancel-btn").addEventListener("click", () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }

    if (mode === "edit" && editing) location.hash = `#/page/${editing.id}`;
    else location.hash = "#/";
  });
}

/* =========================================================
   Nav + Auth boot
========================================================= */
function bindUI() {
  document.querySelectorAll(".nav-btn[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");

      if (nav === "recent") location.hash = "#/recent";
      if (nav === "search") location.hash = "#/search";
      if (nav === "new") {
        if (!canEdit) return alert("새 문서는 로그인 후에 만들 수 있어.");
        location.hash = "#/new";
      }
    });
  });

  authBtn.addEventListener("click", async () => {
    try {
      if (currentUser) await logout();
      else await login();
    } catch (e) {
      console.error(e);
      alert("로그인 오류(Authorized domains / Rules 확인)");
    }
  });

  sideSearchInput.addEventListener("input", () => {
    sideQuery = sideSearchInput.value;
    buildList();
  });

  window.addEventListener("hashchange", route);
}

async function bootAuth() {
  try {
    await getRedirectResult(auth);
  } catch { }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    canEdit = !!user;

    if (user) {
      authBtn.textContent = "로그아웃";
      authStatus.textContent = `편집 모드: ${user.email || "로그인"}`;
      await ensureSeededOnce();
    } else {
      authBtn.textContent = "로그인";
      authStatus.textContent = "읽기 모드";
    }

    route();
  });
}

/* =========================================================
   start
========================================================= */
bindUI();
buildChips();
startListeners();
route();
bootAuth();