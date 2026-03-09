/* =========================================================
  Review Wiki
  - Public read + Google login edit
  - History (revisions) view + revision detail + revert
  - Keep only latest 10 revisions per page
  - ✅ Remove "처음" button next to Edit/History
  - ✅ Add "문서 삭제" button next to Edit/History
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
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-storage.js";

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
const CATEGORY_OPTIONS = ["미디어의 이해", "다른 방식으로 보기", "이미지란 무엇인가"];
const HOME_GUIDE_TITLE = "처음";
const MAX_REVISIONS_PER_PAGE = 10;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

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
let pages = [];
let images = {};
let currentFilter = "all";
let sideQuery = "";

/* One render pass */
let __REFS = [];

/* =========================
   Helpers
========================= */
function escapeHtml(s) {
  // ✅ keep ' for MediaWiki emphasis ('' / ''')
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  return /^https?:\/\//i.test(s) || /^data:image\//i.test(s);
}

/* Firestore paths */
const pagesCol = () => collection(db, "wikis", WIKI_ID, "pages");
const pageDoc = (pageId) => doc(db, "wikis", WIKI_ID, "pages", pageId);
const imagesCol = () => collection(db, "wikis", WIKI_ID, "images");
const imageDoc = (imgId) => doc(db, "wikis", WIKI_ID, "images", imgId);
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
    await setDoc(pageDoc(id), {
      title: p.title,
      content: p.content || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: currentUser?.email || "unknown"
    });

    await addRevision(id, {
      title: p.title,
      content: p.content || "",
      savedBy: currentUser?.email || "unknown",
      savedAt: Date.now(),
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

  onSnapshot(
    query(imagesCol(), orderBy("createdAt", "desc")),
    (snap) => {
      const next = {};
      snap.docs.forEach(d => next[d.id] = { id: d.id, ...d.data() });
      images = next;
      route();
    },
    (err) => console.error(err)
  );
}

/* =========================
   Front matter
========================= */
function parseFrontMatter(raw) {
  const text = raw || "";
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

function getRedirectTargetFromContent(content) {
  const { body } = parseFrontMatter(String(content || ""));
  const t = body.trim();

  // MediaWiki: #REDIRECT [[Target]]  (대소문자 무시)
  const m = t.match(/^#redirect\s*\[\[([^\]]+)\]\]/i);
  if (!m) return null;

  // [[target|label]] 형태면 target만 사용
  const inside = (m[1] || "").trim();
  const targetTitle = inside.includes("|") ? inside.split("|")[0].trim() : inside;
  if (!targetTitle) return null;

  return {
    targetTitle,
    targetId: toDocId(targetTitle)
  };
}

function isRedirectPage(page) {
  return !!getRedirectTargetFromContent(page?.content || "");
}

function getCategory(page) {
  const title = (page.title || "").trim();

  // ✅ 가이드 문서(처음)는 분류 없음으로 고정 (원하면 지워도 됨)
  if (title === HOME_GUIDE_TITLE) return "";

  const { meta } = parseFrontMatter(page.content);
  const v = (meta.category || meta.type || "").trim();

  // ✅ category/type가 비어있으면 "없음"으로 둔다 (기본값 자동부여 X)
  return v; // "" 가능
}

/* =========================
   Render helpers
========================= */
function renderImageFigure(src, caption) {
  const safeSrc = escapeHtml(src);
  const safeCap = escapeHtml(caption || "");
  const capHtml = safeCap ? `<figcaption class="wiki-caption">${safeCap}</figcaption>` : "";
  return `
    <figure class="wiki-figure">
      <a class="wiki-img-link" href="${safeSrc}" target="_blank" rel="noopener noreferrer">
        <img class="wiki-img" src="${safeSrc}" alt="${safeCap}" loading="lazy" />
      </a>
      ${capHtml}
    </figure>
  `;
}

function protectInlineCode(rawText) {
  const codes = [];
  const replaced = String(rawText || "").replace(/`([^`\n]+)`/g, (m, inner) => {
    const idx = codes.length;
    codes.push(inner);
    return `{{CODE:${idx}}}`;
  });
  return { text: replaced, codes };
}

function renderInline(text) {
  let raw = String(text || "");

  // ✅ do NOT touch code first
  const protectedResult = protectInlineCode(raw);
  raw = protectedResult.text;
  const codes = protectedResult.codes;

  // remove html comments (outside code)
  raw = raw.replace(/<!--[\s\S]*?-->/g, "");
  // normalize smart quotes
  raw = raw.replace(/[\u2018\u2019]/g, "'");

  let t = escapeHtml(raw);

  // [https://url label]
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

  // Markdown image
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const target = (url || "").trim();
    if (!target) return m;
    if (!isUrlLike(target) && images[target]?.url) return renderImageFigure(images[target].url, alt || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, alt || "");
    return m;
  });

  // Wiki image
  t = t.replace(/\[\[(?:Image|File|파일|이미지)\:([^\]|]+)(?:\|([^\]]+))?\]\]/gi, (m, targetRaw, capRaw) => {
    const target = (targetRaw || "").trim();
    const caption = (capRaw || "").trim();
    if (!target) return m;
    if (images[target]?.url) return renderImageFigure(images[target].url, caption || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, caption);
    return m;
  });

  // Markdown link
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const u = (url || "").trim();
    const l = (label || "").trim();
    if (!u) return m;
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l)}</a>`;
  });

  // Wiki link: MediaWiki rule [[target|label]]
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

  // bare URL
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

function renderWiki(body) {
  const originalLines = String(body || "").replaceAll("\r\n", "\n").split("\n");

  // 1) protect fenced code blocks first
  const extracted = extractFencedCodeBlocks(originalLines);
  let text = extracted.lines.join("\n");
  const codeBlocks = extracted.blocks;

  // 2) normalize smart quotes
  text = text.replace(/[\u2018\u2019]/g, "'");

  // 3) remove html comments (outside code blocks only)
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 4) refs (outside code blocks only)
  __REFS = [];
  text = text.replace(/<ref>([\s\S]*?)<\/ref>/gi, (m, inner) => {
    __REFS.push((inner || "").trim());
    return `{{REF:${__REFS.length}}}`;
  });

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // restore code blocks
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

    // quote
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${buf.map(l => `<p>${renderInline(l)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim()) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderParagraphWithLineBreaks(buf)}</p>`);
  }

  return out.join("\n");
}

function renderParagraphWithLineBreaks(linesBuf) {
  // ✅ 엔터 1번은 <br>, 빈 줄은 renderWiki가 이미 문단을 나눔
  return linesBuf
    .map(line => renderInline(line))
    .join("<br>");
}

/* =========================
   History: keep only latest 10
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

/* ✅ 문서 삭제: 문서 + 해당 문서의 revisions 전부 삭제 */
async function deleteAllRevisions(pageId) {
  // Firestore는 subcollection 자동 삭제가 없어서 직접 지워야 함
  // (현재는 최대 10개만 유지하지만, 혹시 기존 데이터가 많을 수도 있어서 반복 삭제)
  while (true) {
    const snap = await getDocs(query(revisionsCol(pageId), limit(50)));
    if (snap.empty) break;
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
    }
  }
}

async function deletePageCompletely(pageId) {
  if (!canEdit) {
    alert("삭제하려면 로그인해야 한답니다.");
    return;
  }

  const page = pages.find(p => p.id === pageId);
  const title = page?.title || pageId;

  const ok = confirm(`정말로 삭제할까유?\n\n- 문서: ${title}\n- 히스토리도 함께 삭제되지요`);
  if (!ok) return;

  try {
    await deleteAllRevisions(pageId);
    await deleteDoc(pageDoc(pageId));

    // 화면 이동: 가이드 홈(또는 최근)
    location.hash = "#/";
  } catch (e) {
    console.error(e);
    alert("삭제 실패(권한/네트워크/Rules 확인)");
  }
}

/* =========================
   UI: chips + list
========================= */
function buildChips() {
  if (!chipWrap) return;
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

function buildList() {
  const qText = sideQuery.trim().toLowerCase();
  let list = [...pages];
  list = list.filter(p => !isRedirectPage(p)); // ✅ 리다이렉트는 목록에서 숨김

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
    li.addEventListener("click", () => location.hash = `#/page/${li.getAttribute("data-slug")}`);
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
  const recent = [...pages].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
  viewEl.innerHTML = `
    <h2 class="page-title">최근</h2>
    <ul>
      ${recent.map(p => `<li><a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a></li>`).join("")}
    </ul>
  `;
}

function renderPage(pageId) {
  const page = pages.find(p => p.id === pageId);

  // ✅ 1) 먼저 존재 체크
  if (!page) {
    viewEl.innerHTML = `<h2 class="page-title">없음</h2><p>문서를 찾지 못했답니다.</p>`;
    return;
  }

  // ✅ 2) 그 다음 리다이렉트 체크
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
        <button class="tool-link" type="button" onclick="location.hash='#/history/${escapeHtml(pageId)}'">히스토리</button>
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

    return;
  }

  // ✅ 3) 리다이렉트가 아니면 기존 렌더 계속
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

}

document.getElementById("edit-btn").addEventListener("click", () => {
  if (!canEdit) return alert("편집하려면 로그인해야 함다.");
  location.hash = `#/edit/${pageId}`;
});

document.getElementById("history-btn").addEventListener("click", () => {
  location.hash = `#/history/${pageId}`;
});

if (canEdit) {
  document.getElementById("delete-btn").addEventListener("click", () => {
    deletePageCompletely(pageId);
  });
}
}

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
        : `<p>결과가 없슴다.</p>`)
      : `<p>검색어를 입력해주소서.</p>`
    }
  `;

  const input = document.getElementById("search-input");
  input.addEventListener("input", () => {
    const val = input.value.trim();
    location.hash = val ? `#/search?q=${encodeURIComponent(val)}` : "#/search";
  });
}

/* =========================
   History + Revision detail + Revert
========================= */
async function renderHistory(pageId) {
  viewEl.innerHTML = `<h2 class="page-title">히스토리</h2><p class="muted">불러오는 중이지요...</p>`;

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
      ` : `<p>아직 기록이 없지요.</p>`}

      <div class="tools-row">
        <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
      </div>
    `;
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = `<h2 class="page-title">히스토리</h2><p>불러오지 못했어.</p>`;
  }
}

async function renderRevision(pageId, revId) {
  viewEl.innerHTML = `<h2 class="page-title">리비전</h2><p class="muted">불러오는 중이지요...</p>`;

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
        const ok = confirm("현재 문서를 이 리비전으로 되돌릴까유? (되돌리기도 히스토리에 기록됨다)");
        if (!ok) return;

        const current = pages.find(p => p.id === pageId);
        const createdAt = current?.createdAt || Date.now();
        const title = current?.title || "(untitled)";
        const now = Date.now();

        await setDoc(pageDoc(pageId), {
          title,
          content: String(r.content || ""),
          createdAt,
          updatedAt: now,
          updatedBy: currentUser?.email || "unknown"
        });

        await addRevision(pageId, {
          title,
          content: String(r.content || ""),
          savedBy: currentUser?.email || "unknown",
          savedAt: now,
          note: `revert:${revId}`
        });

        location.hash = `#/page/${pageId}`;
      });
    }
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = `<h2 class="page-title">리비전 오류</h2><p>불러오지 못했슴다.</p>`;
  }
}

/* =========================
   Editor + Save + Upload
========================= */
function insertAtCursor(textarea, textToInsert) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + textToInsert + value.slice(end);
  const newPos = start + textToInsert.length;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = newPos;
}

async function uploadImage(file) {
  if (!canEdit) throw new Error("not logged in");

  const id = `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const safeName = (file.name || "image").replace(/[^\w.\-]+/g, "_");
  const path = `wikis/${WIKI_ID}/images/${id}_${safeName}`;

  const ref = storageRef(storage, path);
  await uploadBytes(ref, file);
  const url = await getDownloadURL(ref);

  await setDoc(imageDoc(id), {
    name: file.name,
    url,
    storagePath: path,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploadedBy: currentUser?.email || "unknown"
  });

  return { id, name: file.name, url, storagePath: path };
}

async function savePage({ mode, oldId, title, content }) {
  if (!canEdit) throw new Error("not logged in");

  const now = Date.now();
  const isEdit = mode === "edit" && !!oldId;

  // 새 제목에서 새 슬러그
  const newId = toDocId(title);

  // 편집이면 기존 문서 찾아서 createdAt/aliases 유지
  const prev = isEdit ? pages.find(p => p.id === oldId) : null;
  const createdAt = prev?.createdAt || now;
  const prevAliases = Array.isArray(prev?.aliases) ? prev.aliases : [];

  // ✅ (1) 편집인데 제목이 바뀌지 않았다 → 기존 ID 그대로 업데이트
  if (isEdit && newId === oldId) {
    await setDoc(pageDoc(oldId), {
      title,
      content,
      createdAt,
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

  // ✅ (2) 새 문서이거나, 편집 중 제목이 바뀌어서 “이동”이 필요한 경우
  // 새 문서의 aliases는:
  // - 새 문서(new): []
  // - 이동(rename): 기존 aliases + oldId 누적
  const aliases = isEdit
    ? Array.from(new Set([...prevAliases, oldId]))
    : [];

  // (2-1) 새 ID(newId)에 본문 저장
  await setDoc(pageDoc(newId), {
    title,
    content,
    createdAt,
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

  // (2-2) 편집 중 제목 변경(=이동)이라면, oldId 문서를 리다이렉트로 바꿈
  if (isEdit && oldId && oldId !== newId) {
    const oldTitle = prev?.title || oldId;
    const redirectContent =
      `---
redirect: true
---
#REDIRECT [[${title}]]`;

    await setDoc(pageDoc(oldId), {
      title: oldTitle,           // ✅ 예전 문서 제목 유지(깔끔)
      content: redirectContent,
      createdAt,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown",
      // (선택) 디버깅/관리용
      redirectTo: newId
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
  const contentValue = editing ? editing.content : `---\ncategory: ${CATEGORY_OPTIONS[0]}\n---\n\n== 제목 ==\n내용...\n`;

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
        <input id="upload-img-input" type="file" accept="image/*" style="display:none" />
      </div>
    </div>
  `;

  const titleInput = document.getElementById("edit-title");
  const contentInput = document.getElementById("edit-content");

  document.getElementById("save-btn").addEventListener("click", async () => {
    const newTitle = titleInput.value.trim();
    const newContent = contentInput.value;
    if (!newTitle) return alert("제목을 입력해 주소서.");

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
      alert("저장 실패(권한/네트워크/중복 제목).");
    }
  });

  document.getElementById("cancel-btn").addEventListener("click", () => {
    if (mode === "edit" && editing) location.hash = `#/page/${editing.id}`;
    else location.hash = "#/";
  });

  const uploadBtn = document.getElementById("upload-img-btn");
  const uploadInput = document.getElementById("upload-img-input");
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    uploadInput.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("이미지 파일만 가능하지.");

    try {
      const uploaded = await uploadImage(file);
      insertAtCursor(contentInput, `[[Image:${uploaded.id}|${uploaded.name}]]`);
    } catch (err) {
      console.error(err);
      alert("업로드 실패(로그인/Storage Rules 확인).");
    }
  });
}

/* =========================
   Bind UI + Auth boot
========================= */
function bindUI() {
  document.querySelectorAll(".nav-btn[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");
      if (nav === "recent") location.hash = "#/recent";
      if (nav === "search") location.hash = "#/search";
      if (nav === "new") {
        if (!canEdit) return alert("새 문서는 로그인 후에 만들 수 있소.");
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
      alert("로그인 오류(Authorized domains 확인).");
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