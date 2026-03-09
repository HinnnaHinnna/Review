/* =========================================================
  Review Wiki
  - Public read + Google login edit
  - Title rename => new slug URL + old slug becomes #REDIRECT
  - History: keep only latest 10 per page
  - History view + revision detail + revert
  - Delete page + delete its revisions + delete its alias redirect pages
  - No image upload (Storage / images collection removed)
  - Enter line breaks: newline -> <br>, blank line -> new paragraph
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

/* ✅ Firebase config */
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

/* ✅ 왼쪽 카테고리 칩 */
const CATEGORY_OPTIONS = ["미디어의 이해", "다른 방식으로 보기", "이미지란 무엇인가"];

/* ✅ 첫 화면(홈)에서 자동으로 여는 문서 제목 */
const HOME_GUIDE_TITLE = "처음";

/* ✅ 문서당 히스토리 최대 개수 */
const MAX_REVISIONS_PER_PAGE = 10;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* DOM */
const viewEl = document.getElementById("view");
const pageListEl = document.getElementById("page-list");
const sideSearchInput = document.getElementById("side-search-input");
const authBtn = document.getElementById("auth-btn");
const authStatus = document.getElementById("auth-status");
const chipWrap = document.getElementById("category-chips");

/* State */
let currentUser = null;
let canEdit = false;

let pages = [];                 // pages cache
let currentFilter = "all";      // selected category
let sideQuery = "";             // sidebar search query

/* One render pass */
let __REFS = [];

/* =========================
   Helpers
========================= */
function escapeHtml(s) {
  // keep ' for MediaWiki emphasis ('' / ''')
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

/* Firestore paths */
const pagesCol = () => collection(db, "wikis", WIKI_ID, "pages");
const pageDoc = (pageId) => doc(db, "wikis", WIKI_ID, "pages", pageId);
const revisionsCol = (pageId) => collection(db, "wikis", WIKI_ID, "pages", pageId, "revisions");

/* =========================
   Auth
========================= */
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

/* =========================
   Seed (only if empty)
========================= */
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

/* =========================
   Live listeners
========================= */
function startListeners() {
  onSnapshot(
    query(pagesCol(), orderBy("updatedAt", "desc")),
    (snap) => {
      pages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

/* =========================
   Front matter
========================= */
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

/* =========================
   Redirect helpers
========================= */
function getRedirectTargetFromContent(content) {
  const { body } = parseFrontMatter(String(content || ""));
  const t = body.trim();

  // MediaWiki: #REDIRECT [[Target]]  (case-insensitive)
  const m = t.match(/^#redirect\s*\[\[([^\]]+)\]\]/i);
  if (!m) return null;

  // if [[target|label]] => use target only
  const inside = (m[1] || "").trim();
  const targetTitle = inside.includes("|") ? inside.split("|")[0].trim() : inside;
  if (!targetTitle) return null;

  return { targetTitle, targetId: toDocId(targetTitle) };
}

function isRedirectPage(page) {
  return !!getRedirectTargetFromContent(page?.content || "");
}

/* =========================
   Category
========================= */
function getCategory(page) {
  const title = (page.title || "").trim();

  // ✅ guide page has no category
  if (title === HOME_GUIDE_TITLE) return "";

  const { meta } = parseFrontMatter(page.content);
  const v = (meta.category || meta.type || "").trim();

  // empty allowed
  return v;
}

/* =========================
   Inline code protection (`...`)
========================= */
function protectInlineCode(rawText) {
  const codes = [];
  const replaced = String(rawText || "").replace(/`([^`\n]+)`/g, (m, inner) => {
    const idx = codes.length;
    codes.push(inner);
    return `{{CODE:${idx}}}`;
  });
  return { text: replaced, codes };
}

/* =========================
   Inline render
========================= */
function renderInline(text) {
  let raw = normalizeSmartQuotes(String(text || ""));

  // 1) protect inline code first (so code won't be parsed)
  const protectedResult = protectInlineCode(raw);
  raw = protectedResult.text;
  const codes = protectedResult.codes;

  // 2) remove HTML comments outside inline code
  raw = raw.replace(/<!--[\s\S]*?-->/g, "");

  let t = escapeHtml(raw);

  // External link: [https://url label]
  t = t.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (m, url, label) => {
    const u = escapeHtml(url);
    const l = escapeHtml((label || url).trim());
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`;
  });

  // MediaWiki emphasis
  t = t.replace(/'''''(.+?)'''''/g, "<strong><em>$1</em></strong>");
  t = t.replace(/'''(.+?)'''/g, "<strong>$1</strong>");
  t = t.replace(/''(.+?)''/g, "<em>$1</em>");

  // Markdown emphasis (optional)
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Markdown link [label](url)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  });

  // Markdown image ![alt](url) (external only)
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

  // Wiki image [[Image:https://...|caption]] (external only)
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

  // Wiki link: [[target]] or [[target|label]]
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

  // ref placeholder {{REF:n}}
  t = t.replace(/\{\{REF:(\d+)\}\}/g, (m, n) => {
    const num = Number(n);
    return `<sup class="ref"><a href="#ref-${num}" id="refback-${num}">[${num}]</a></sup>`;
  });

  // bare URL autolink
  t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // restore inline code
  t = t.replace(/\{\{CODE:(\d+)\}\}/g, (m, idxStr) => {
    const idx = Number(idxStr);
    const codeRaw = codes[idx] ?? "";
    return `<code class="inline-code">${escapeHtml(codeRaw)}</code>`;
  });

  return t;
}

/* =========================
   Fenced code blocks extractor (``` / ~~~)
   - protects code blocks from ref/comment parsing
========================= */
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
    i++; // start reading inside block

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

/* =========================
   Protect inline code across whole text (so <!-- --> / <ref> won't touch it)
========================= */
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

/* =========================
   MediaWiki list (* / #)
========================= */
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
    while (common < stack.length && common < targetTypes.length && stack[common] === targetTypes[common]) common++;

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

/* =========================
   Paragraph line breaks:
   - newline => <br>
   - blank line => new paragraph (handled by renderWiki loop)
========================= */
function renderParagraphWithLineBreaks(linesBuf) {
  return linesBuf.map(line => renderInline(line)).join("<br>");
}

/* =========================
   Block render (with code protection)
========================= */
function renderWiki(body) {
  const originalLines = normalizeSmartQuotes(String(body || "")).replaceAll("\r\n", "\n").split("\n");

  // 1) protect fenced code blocks first
  const extracted = extractFencedCodeBlocks(originalLines);
  let text = extracted.lines.join("\n");
  const codeBlocks = extracted.blocks;

  // 2) protect inline code across whole text
  const inlineProtected = protectInlineCodeWholeText(text);
  text = inlineProtected.text;
  const inlineCodes = inlineProtected.codes;

  // 3) remove html comments (outside code blocks & outside inline code)
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 4) refs (outside code blocks & outside inline code)
  __REFS = [];
  text = text.replace(/<ref>([\s\S]*?)<\/ref>/gi, (m, inner) => {
    __REFS.push((inner || "").trim());
    return `{{REF:${__REFS.length}}}`;
  });

  // 5) restore inline code tokens back to `...` before parsing lines
  text = restoreInlineCodeWholeText(text, inlineCodes);

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // restore code blocks (no parsing inside)
    const cb = line.trim().match(/^\{\{CODEBLOCK:(\d+)\}\}$/);
    if (cb) {
      const idx = Number(cb[1]);
      const codeText = codeBlocks[idx] ?? "";
      out.push(`<pre class="code-block"><code>${escapeHtml(codeText)}</code></pre>`);
      i++;
      continue;
    }

    // <references/>
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

    // headings == ==
    const mwHeading = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
    if (mwHeading) {
      const level = Math.min(6, Math.max(2, mwHeading[1].length));
      out.push(`<h${level}>${renderInline(mwHeading[2])}</h${level}>`);
      i++;
      continue;
    }

    // HR
    if (line.trim() === "---") {
      out.push("<hr />");
      i++;
      continue;
    }

    // lists
    if (/^[*#]+\s+/.test(line)) {
      const { html, nextIndex } = consumeMwList(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // quote >
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${buf.map(l => `<p>${renderInline(l)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // paragraph (collect until blank line)
    const buf = [];
    while (i < lines.length && lines[i].trim()) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderParagraphWithLineBreaks(buf)}</p>`);
  }

  return out.join("\n");
}

/* =========================
   History: keep only latest N
========================= */
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

/* =========================
   Delete page + revisions + alias redirect pages
========================= */
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
    // 1) delete alias redirect pages too (if main page has aliases)
    const aliasIds = Array.isArray(page?.aliases) ? page.aliases : [];
    for (const aliasId of aliasIds) {
      await deleteAllRevisions(aliasId);
      await deleteDoc(pageDoc(aliasId));
    }

    // 2) delete this page's revisions + page
    await deleteAllRevisions(pageId);
    await deleteDoc(pageDoc(pageId));

    location.hash = "#/";
  } catch (e) {
    console.error(e);
    alert("삭제 실패(권한/네트워크/Rules 확인)");
  }
}

/* =========================
   Chips UI
========================= */
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

/* =========================
   Sidebar list
========================= */
function buildList() {
  const qText = sideQuery.trim().toLowerCase();

  let list = [...pages];

  // ✅ hide redirect pages from list
  list = list.filter(p => !isRedirectPage(p));

  if (currentFilter !== "all") list = list.filter(p => getCategory(p) === currentFilter);
  if (qText) list = list.filter(p => (p.title || "").toLowerCase().includes(qText));

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

/* =========================
   Routing
========================= */
function pickGuidePage() {
  return pages.find(p => (p.title || "").trim() === HOME_GUIDE_TITLE) || null;
}

function route() {
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
  const guide = pickGuidePage();
  if (guide) return renderPage(guide.id);
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

/* =========================
   Page view (includes redirect handling)
========================= */
function renderPage(pageId) {
  const page = pages.find(p => p.id === pageId);

  if (!page) {
    viewEl.innerHTML = `<h2 class="page-title">없음</h2><p>문서를 찾지 못했어.</p>`;
    return;
  }

  // ✅ redirect?
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

    <div class="doc">${renderWiki(body)}</div>

    <div class="tools-row">
      <button class="tool-link" type="button" id="edit-btn">편집</button>
      <button class="tool-link" type="button" id="history-btn">히스토리</button>
      ${canEdit ? `<button class="tool-link" type="button" id="delete-btn">문서 삭제</button>` : ""}
    </div>
  `;

  // ✅ bind after DOM exists
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

/* =========================
   Search (hide redirect pages)
========================= */
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

/* =========================
   History view (latest N)
========================= */
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

/* =========================
   Revision detail + revert
========================= */
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

/* =========================
   Save page (new / edit / rename => redirect)
========================= */
async function savePage({ mode, oldId, title, content }) {
  if (!canEdit) throw new Error("not logged in");

  const now = Date.now();
  const isEdit = mode === "edit" && !!oldId;

  const newId = toDocId(title);

  const prev = isEdit ? pages.find(p => p.id === oldId) : null;
  const prevCreatedAt = prev?.createdAt || now;
  const prevAliases = Array.isArray(prev?.aliases) ? prev.aliases : [];

  const dest = pages.find(p => p.id === newId) || null; // ✅ 충돌 대상 문서(있으면 덮어씀)
  const existsNew = !!dest;

  // ✅ 새 문서(new) 만들 때는 여전히 안전하게 막음 (원하면 이것도 덮어쓰게 바꿀 수 있음)
  if (!isEdit && existsNew) {
    throw new Error("이미 같은 제목(슬러그)의 문서가 존재합니다.");
  }

  // ✅ 1) 편집인데 슬러그가 그대로면: 기존 문서 업데이트
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

  // ✅ 2) 편집 중 제목 변경(= 이동)인데, 목적지(newId)가 이미 존재하면: 덮어쓰기(OVERWRITE)
  if (isEdit && oldId && oldId !== newId && existsNew) {
    const destAliases = Array.isArray(dest.aliases) ? dest.aliases : [];

    // (2-0) 덮어쓰기 전에 목적지 문서의 기존 내용을 "백업 리비전"으로 남김
    //       (히스토리 10개 제한이 있어서 오래된 건 밀릴 수 있지만,
    //        최소한 직전 상태는 히스토리에 남게 됨)
    await addRevision(newId, {
      title: dest.title || title,
      content: String(dest.content || ""),
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `backup-before-overwrite-from:${oldId}`
    });

    // createdAt은 둘 중 더 오래된(더 작은) 값을 유지
    const destCreatedAt = typeof dest.createdAt === "number" ? dest.createdAt : now;
    const createdAt = Math.min(destCreatedAt, prevCreatedAt);

    // aliases는 목적지/원본/oldId 모두 합쳐서 유지
    const mergedAliases = Array.from(new Set([...destAliases, ...prevAliases, oldId]));

    // (2-1) 목적지 문서(newId)를 "지금 편집한 내용"으로 덮어쓰기
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

    // (2-2) 원래 문서(oldId)는 리다이렉트로 바꿈
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

    return newId; // ✅ URL도 새 슬러그로 이동
  }

  // ✅ 3) (충돌 없음) 새 문서 OR 편집 중 정상 이동(rename)
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

  // 이동이면 oldId를 리다이렉트로
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

/* =========================
   Editor
========================= */
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

      <div class="editor-actions">
        <button class="btn primary" type="button" id="save-btn">저장</button>
        <button class="btn" type="button" id="cancel-btn">취소</button>
      </div>


    </div>
  `;

  const titleInput = document.getElementById("edit-title");
  const contentInput = document.getElementById("edit-content");

  document.getElementById("save-btn").addEventListener("click", async () => {
    const newTitle = titleInput.value.trim();
    const newContent = contentInput.value;
    if (!newTitle) return alert("제목을 입력해줘.");

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
    if (mode === "edit" && editing) location.hash = `#/page/${editing.id}`;
    else location.hash = "#/";
  });
}

/* =========================
   Nav + Auth boot
========================= */
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
  try { await getRedirectResult(auth); } catch { }

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

/* start */
bindUI();
buildChips();
startListeners();
route();
bootAuth();