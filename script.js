/* =========================================================
  Review Wiki
  - 공개 읽기 + 로그인 편집(여러 사람 가능)
  - 미디어위키 호환 문법(일부) 지원:
    == 제목 ==, '''굵게''', ''기울임'',
    [https://url label], <!--주석-->,
    <ref>...</ref> + <references/>,
    * / # 목록
  - 카테고리 칩은 JS 상단 CATEGORY_OPTIONS에서 변경
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDocs, addDoc, getDoc,
  deleteDoc, query, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-storage.js";

/* ✅ 너 config (너가 올려준 값 그대로) */
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

/* ✅ 여기만 바꾸면 카테고리/칩 전체가 바뀜 */
const CATEGORY_OPTIONS = [
  "미디어의 이해",
  "다른 방식으로 보기",
  "이미지란 무엇인가"
];

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
const newBtn = document.getElementById("new-btn");
const chipWrap = document.getElementById("category-chips");

/* State */
let currentUser = null;
let canEdit = false;

let pages = [];       // [{id,title,content,createdAt,updatedAt,updatedBy}]
let images = {};      // { [id]: {id,name,url,storagePath,createdAt,updatedAt,uploadedBy} }

let currentFilter = "all";
let sideQuery = "";

/* 각주(렌더링 1회 동안 공유) */
let __REFS = [];

/* Helpers */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

/* ===== Seed: 컬렉션 비어있을 때만 1회 생성 ===== */
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
    // seed도 최초 버전으로 기록 남김
    await addRevision(id, {
      title: p.title,
      content: p.content || "",
      savedBy: currentUser?.email || "unknown",
      savedAt: Date.now(),
      note: "seed"
    });
  }
}

/* ===== Login / Logout ===== */
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

/* ===== Live listeners (읽기: 누구나) ===== */
function startListeners() {
  onSnapshot(
    query(pagesCol(), orderBy("updatedAt", "desc")),
    (snap) => {
      pages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      buildChips();   // 혹시 categories가 바뀌어도 UI 유지
      buildList();
      route();
    },
    (err) => {
      console.error(err);
      viewEl.innerHTML = `<p>데이터를 불러오지 못했어. (Firestore Rules/프로젝트 설정 확인)</p>`;
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

/* ===== front matter ===== */
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

  if (meta.tags) meta.tagsList = meta.tags.split(",").map(s => s.trim()).filter(Boolean);
  else meta.tagsList = [];
  return { meta, body };
}

/* ✅ 카테고리 읽기: category: 를 우선, 없으면 type: 를 fallback */
function getCategory(page) {
  const { meta } = parseFrontMatter(page.content);
  const v = (meta.category || meta.type || "").trim();
  // 기존 문서가 전시/책/노트라면, 기본값으로 첫 카테고리로 보내는 것도 가능
  return v || CATEGORY_OPTIONS[0];
}

/* ===== Wiki image render ===== */
function renderImageFigure(src, caption) {
  const safeSrc = escapeHtml(src);
  const safeCap = escapeHtml(caption || "");
  const cap = safeCap ? `<figcaption class="wiki-caption">${safeCap}</figcaption>` : "";
  return `
    <figure class="wiki-figure">
      <a class="wiki-img-link" href="${safeSrc}" target="_blank" rel="noopener noreferrer">
        <img class="wiki-img" src="${safeSrc}" alt="${safeCap}" loading="lazy" />
      </a>
      ${cap}
    </figure>
  `;
}

/* ===== Inline render (미디어위키 일부 + 기존 문법) ===== */
function renderInline(text) {
  // 0) 화면에 안 보이는 주석 제거
  const raw = String(text || "").replace(/<!--[\s\S]*?-->/g, "");

  let t = escapeHtml(raw);

  // 1) 위키피디아식 외부 링크: [https://url label]
  t = t.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (m, url, label) => {
    const u = escapeHtml(url);
    const l = escapeHtml((label || url).trim());
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`;
  });

  // 2) 위키피디아식 강조 (5개→3개→2개 순서)
  t = t.replace(/'''''(.+?)'''''/g, "<strong><em>$1</em></strong>");
  t = t.replace(/'''(.+?)'''/g, "<strong>$1</strong>");
  t = t.replace(/''(.+?)''/g, "<em>$1</em>");

  // 3) 마크다운 굵게/기울임도 허용
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 4) 마크다운 이미지
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const target = (url || "").trim();
    if (!target) return m;
    if (!isUrlLike(target) && images[target]?.url) return renderImageFigure(images[target].url, alt || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, alt || "");
    return m;
  });

  // 5) 위키 이미지
  t = t.replace(/\[\[(?:Image|File|파일|이미지)\:([^\]|]+)(?:\|([^\]]+))?\]\]/gi, (m, targetRaw, capRaw) => {
    const target = (targetRaw || "").trim();
    const caption = (capRaw || "").trim();
    if (!target) return m;

    if (images[target]?.url) return renderImageFigure(images[target].url, caption || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, caption);
    return m;
  });

  // 6) 마크다운 링크 [text](url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const u = (url || "").trim();
    const l = (label || "").trim();
    if (!u) return m;
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l)}</a>`;
  });

  // 7) 위키 링크 [[...]]
  t = t.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
    const raw2 = (inner || "").trim();

    if (raw2.includes("|")) {
      const [labelRaw, targetRaw] = raw2.split("|");
      const label = (labelRaw || "").trim();
      const target = (targetRaw || "").trim();

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

  // 8) 각주 placeholder {{REF:n}} → 위첨자
  t = t.replace(/\{\{REF:(\d+)\}\}/g, (m, n) => {
    const num = Number(n);
    return `<sup class="ref"><a href="#ref-${num}" id="refback-${num}">[${num}]</a></sup>`;
  });

  // 9) bare URL 자동 링크
  t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  return t;
}

/* ===== 미디어위키 리스트(* #) 파서 ===== */
function consumeMwList(lines, startIndex) {
  // 연속된 리스트 라인만 먹는다:  * item / ## item / *# item ...
  let i = startIndex;
  const out = [];

  // stack에는 현재 열린 리스트 타입("ul" or "ol")이 depth별로 들어감
  const stack = [];
  let openLiDepth = 0; // 현재 열려 있는 <li>가 몇 depth에 속하는지 (0이면 없음)

  function typeOf(ch) { return ch === "*" ? "ul" : "ol"; }

  function closeLiIfNeeded(targetDepth) {
    // 다음 항목이 같은/상위 depth로 오면 현재 li를 닫아야 함
    if (openLiDepth > 0 && targetDepth <= openLiDepth) {
      out.push("</li>");
      openLiDepth = 0;
    }
  }

  function closeListsTo(commonDepth) {
    // 리스트를 줄여야 할 때 (depth 감소)
    while (stack.length > commonDepth) {
      // 리스트 닫기 전에, 그 depth의 li가 열려있다면 닫는다
      if (openLiDepth === stack.length) {
        out.push("</li>");
        openLiDepth = 0;
      }
      out.push(`</${stack.pop()}>`);
    }
  }

  function openListsFrom(commonDepth, targetTypes) {
    // 필요한 만큼 리스트 열기 (depth 증가)
    for (let d = commonDepth; d < targetTypes.length; d++) {
      out.push(`<${targetTypes[d]}>`);
      stack.push(targetTypes[d]);
      // 새 리스트는 보통 부모 li 안에 들어감 (이게 중첩 구조)
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([*#]+)\s+(.*)$/);
    if (!m) break;

    const prefix = m[1];
    const itemText = m[2];

    const targetTypes = prefix.split("").map(typeOf);

    // 공통 depth 찾기(타입까지 동일한 범위)
    let common = 0;
    while (
      common < stack.length &&
      common < targetTypes.length &&
      stack[common] === targetTypes[common]
    ) common++;

    // 1) 같은/상위로 가면 li 닫기
    closeLiIfNeeded(targetTypes.length);

    // 2) 타입 불일치 or depth 감소면 리스트 닫기
    closeListsTo(common);

    // 3) depth 증가면 리스트 열기
    openListsFrom(common, targetTypes);

    // 4) 같은 depth의 다음 항목이면 직전 li 닫기
    // (단, 더 깊어지는 경우는 닫지 않음 — 부모 li 안에 중첩 리스트를 넣기 위해)
    if (openLiDepth === targetTypes.length) {
      out.push("</li>");
      openLiDepth = 0;
    }

    // 5) 새 li 열기
    out.push(`<li>${renderInline(itemText)}`);
    openLiDepth = targetTypes.length;

    i++;
  }

  // 끝 정리: 열려있는 li 닫기 + 리스트 닫기
  if (openLiDepth > 0) out.push("</li>");
  while (stack.length > 0) out.push(`</${stack.pop()}>`);

  return { html: out.join(""), nextIndex: i };
}

/* ===== Block render (미디어위키 제목/각주/리스트 포함) ===== */
function renderWiki(body) {
  // 0) 주석 제거(전체 본문에서)
  let text = String(body || "").replace(/<!--[\s\S]*?-->/g, "");

  // 1) 각주 추출: <ref>...</ref> -> {{REF:n}}
  __REFS = [];
  text = text.replace(/<ref>([\s\S]*?)<\/ref>/gi, (m, inner) => {
    __REFS.push((inner || "").trim());
    return `{{REF:${__REFS.length}}}`;
  });

  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 2) <references/>
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

    // 3) 미디어위키 제목: == 제목 ==
    const mwHeading = line.match(/^(={2,6})\s*(.+?)\s*\1$/);
    if (mwHeading) {
      const level = Math.min(6, Math.max(2, mwHeading[1].length));
      out.push(`<h${level}>${renderInline(mwHeading[2])}</h${level}>`);
      i++;
      continue;
    }

    // 4) 구분선
    if (line.trim() === "---") {
      out.push("<hr />");
      i++;
      continue;
    }

    // 5) 미디어위키 리스트 (* / #)
    if (/^[*#]+\s+/.test(line)) {
      const { html, nextIndex } = consumeMwList(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // 6) 기존 인용
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${buf.map(l => `<p>${renderInline(l)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // 7) 기존 - 리스트도 허용(예전 문서 호환)
    if (line.trim().startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(`<li>${renderInline(lines[i].trim().slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // 8) 문단
    const buf = [];
    while (i < lines.length && lines[i].trim()) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

/* ===== UI: 카테고리 칩 ===== */
function buildChips() {
  // 칩은 매번 다시 그려도 부담 없음
  chipWrap.innerHTML = "";

  // 전체 칩
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

  // 카테고리 칩
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

/* ===== List build ===== */
function buildList() {
  const qText = sideQuery.trim().toLowerCase();
  let list = [...pages];

  if (currentFilter !== "all") list = list.filter(p => getCategory(p) === currentFilter);
  if (qText) list = list.filter(p => (p.title || "").toLowerCase().includes(qText));

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  pageListEl.innerHTML = list.map(p => {
    const cat = getCategory(p);
    const hint = `${cat} · ${formatDate(p.updatedAt || p.createdAt)}`;
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

/* ===== Routing ===== */
function route() {
  const hash = location.hash || "#/";
  const [path, qs] = hash.replace("#", "").split("?");

  if (path === "/") return renderHome();
  if (path === "/search") {
    const params = new URLSearchParams(qs || "");
    return renderSearch((params.get("q") || "").trim());
  }
  if (path === "/new") return renderEditor({ mode: "new" });
  if (path.startsWith("/page/")) return renderPage(path.replace("/page/", ""));
  if (path.startsWith("/edit/")) return renderEditor({ mode: "edit", slug: path.replace("/edit/", "") });

  // ✅ 역사 보기
  if (path.startsWith("/history/")) return renderHistory(path.replace("/history/", ""));

  // ✅ 특정 리비전 보기
  if (path.startsWith("/revision/")) {
    const rest = path.replace("/revision/", "");
    const [pageId, revId] = rest.split("/");
    return renderRevision(pageId, revId);
  }

  location.hash = "#/";
}

function renderHome() {
  const recent = [...pages].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
  viewEl.innerHTML = `
    <h2 class="page-title">처음</h2>
    <p class="muted">읽기는 누구나. 편집/업로드는 로그인한 사람 누구나.</p>
    <hr />
    <h3 id="recent-anchor">최근</h3>
    <ul>
      ${recent.map(p => `<li><a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a> <span class="muted">(${escapeHtml(formatDate(p.updatedAt || p.createdAt))})</span></li>`).join("")}
    </ul>
  `;
}

function renderPage(slug) {
  const page = pages.find(p => p.id === slug);
  if (!page) {
    viewEl.innerHTML = `<h2 class="page-title">없음</h2><p>문서를 찾지 못했어.</p>`;
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
      <button class="tool-link" type="button" onclick="location.hash='#/'">처음</button>
    </div>
  `;

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (!canEdit) return alert("편집하려면 로그인해야 해.");
    location.hash = `#/edit/${slug}`;
  });

  document.getElementById("history-btn").addEventListener("click", () => {
    location.hash = `#/history/${slug}`;
  });
}

function renderSearch(q) {
  const queryText = (q || "").trim();
  const normalized = queryText.toLowerCase();

  const results = queryText
    ? pages.filter(p => ((p.title || "") + "\n" + (p.content || "")).toLowerCase().includes(normalized))
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

/* ===== Revision(역사) ===== */
async function addRevision(pageId, { title, content, savedBy, savedAt, note }) {
  // revisions는 공개 읽기 + 로그인 쓰기 룰이 적용되므로,
  // canEdit(로그인)일 때만 생성하도록 한다.
  if (!canEdit) return;
  await addDoc(revisionsCol(pageId), {
    title,
    content,
    savedBy: savedBy || "unknown",
    savedAt: savedAt || Date.now(),
    note: note || ""
  });
}

async function renderHistory(pageId) {
  // 누구나 읽을 수 있게 만들어둠
  viewEl.innerHTML = `
    <h2 class="page-title">히스토리</h2>
    <p class="muted">불러오는 중...</p>
  `;

  try {
    const snap = await getDocs(query(revisionsCol(pageId), orderBy("savedAt", "desc"), limit(50)));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!rows.length) {
      viewEl.innerHTML = `
        <h2 class="page-title">히스토리</h2>
        <p>아직 기록이 없어.</p>
        <div class="tools-row">
          <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
        </div>
      `;
      return;
    }

    viewEl.innerHTML = `
      <h2 class="page-title">히스토리</h2>
      <p class="muted">최신 50개 리비전</p>
      <ul>
        ${rows.map(r => {
      const who = r.savedBy ? ` · ${escapeHtml(r.savedBy)}` : "";
      const note = r.note ? ` · ${escapeHtml(r.note)}` : "";
      return `
            <li>
              <a href="#/revision/${escapeHtml(pageId)}/${escapeHtml(r.id)}">${escapeHtml(formatDate(r.savedAt))}</a>
              <span class="muted">${who}${note}</span>
            </li>
          `;
    }).join("")}
      </ul>

      <div class="tools-row">
        <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
      </div>
    `;
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = `
      <h2 class="page-title">히스토리</h2>
      <p>히스토리를 불러오지 못했어. (Rules/네트워크 확인)</p>
      <div class="tools-row">
        <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
      </div>
    `;
  }
}

async function renderRevision(pageId, revId) {
  viewEl.innerHTML = `
    <h2 class="page-title">리비전</h2>
    <p class="muted">불러오는 중...</p>
  `;

  try {
    const snap = await getDoc(doc(db, "wikis", WIKI_ID, "pages", pageId, "revisions", revId));
    if (!snap.exists()) {
      viewEl.innerHTML = `<h2 class="page-title">리비전 없음</h2>`;
      return;
    }
    const r = snap.data();

    viewEl.innerHTML = `
      <h2 class="page-title">${escapeHtml(r.title || "리비전")}</h2>
      <div class="meta-row">
        <span>${escapeHtml(formatDate(r.savedAt))}</span>
        ${r.savedBy ? `<span>·</span><span>${escapeHtml(r.savedBy)}</span>` : ""}
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
        const ok = confirm("현재 문서를 이 리비전 내용으로 되돌릴까? (되돌리기도 새 리비전으로 기록됨)");
        if (!ok) return;

        const now = Date.now();
        await setDoc(pageDoc(pageId), {
          title: r.title || "(no title)",
          content: r.content || "",
          createdAt: pages.find(p => p.id === pageId)?.createdAt || now,
          updatedAt: now,
          updatedBy: currentUser?.email || "unknown"
        });
        await addRevision(pageId, {
          title: r.title || "(no title)",
          content: r.content || "",
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

/* ===== cursor insert ===== */
function insertAtCursor(textarea, textToInsert) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + textToInsert + value.slice(end);
  const newPos = start + textToInsert.length;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = newPos;
}

/* ===== image upload ===== */
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

/* ===== save page (+ revision 자동 기록) ===== */
async function savePage({ mode, oldId, title, content }) {
  if (!canEdit) throw new Error("not logged in");

  const now = Date.now();
  const newId = toDocId(title);

  // 문서 저장
  await setDoc(pageDoc(newId), {
    title,
    content,
    createdAt: mode === "edit" ? (pages.find(p => p.id === oldId)?.createdAt || now) : now,
    updatedAt: now,
    updatedBy: currentUser?.email || "unknown"
  });

  // ✅ 버전 기록 저장
  await addRevision(newId, {
    title,
    content,
    savedBy: currentUser?.email || "unknown",
    savedAt: now,
    note: mode
  });

  // 제목 변경(문서ID 변경) 시: 예전 문서는 “삭제” 대신 “리다이렉트”로 유지하면 위키적이다.
  if (mode === "edit" && oldId && oldId !== newId) {
    await setDoc(pageDoc(oldId), {
      title: `(redirect)`,
      content: `#REDIRECT [[${title}]]`,
      createdAt: pages.find(p => p.id === oldId)?.createdAt || now,
      updatedAt: now,
      updatedBy: currentUser?.email || "unknown"
    });
    await addRevision(oldId, {
      title: `(redirect)`,
      content: `#REDIRECT [[${title}]]`,
      savedBy: currentUser?.email || "unknown",
      savedAt: now,
      note: `redirect-to:${newId}`
    });
  }

  return newId;
}

/* ===== editor ===== */
function renderEditor({ mode, slug }) {
  if (!canEdit) {
    viewEl.innerHTML = `
      <h2 class="page-title">편집하려면 로그인</h2>
      <p class="muted">읽기는 누구나 가능하지만, 편집은 로그인 후에만 가능해.</p>
      <div class="tools-row">
        <button class="tool-link" type="button" id="login-now">로그인</button>
        <button class="tool-link" type="button" onclick="location.hash='#/'">처음</button>
      </div>
    `;
    document.getElementById("login-now").addEventListener("click", login);
    return;
  }

  const editing = mode === "edit" ? pages.find(p => p.id === slug) : null;
  const titleValue = editing ? editing.title : "";
  const contentValue = editing ? editing.content : `---\ncategory: ${CATEGORY_OPTIONS[0]}\ntags: \n---\n\n== 제목 ==\n내용...\n\n* 점 목록\n# 번호 목록\n\n주석: <!-- 안 보이는 메모 -->\n각주: 문장.<ref>출처</ref>\n== 각주 ==\n<references/>\n`;

  viewEl.innerHTML = `
    <h2 class="page-title">${mode === "edit" ? "편집" : "새 문서"}</h2>

    <div class="editor">
      <label>제목</label>
      <input id="edit-title" type="text" value="${escapeHtml(titleValue)}" placeholder="문서 제목" />

      <label>내용</label>
      <textarea id="edit-content" spellcheck="false">${escapeHtml(contentValue)}</textarea>

      <div class="editor-actions">
        <button class="btn primary" type="button" id="save-btn">저장</button>
        <button class="btn" type="button" id="cancel-btn">취소</button>
        <button class="btn" type="button" id="upload-img-btn">이미지 업로드</button>
        <input id="upload-img-input" type="file" accept="image/*" style="display:none" />
      </div>

      <div class="image-lib" id="image-lib"></div>
      <p class="muted">저장할 때마다 “히스토리(리비전)”가 자동으로 남습니다.</p>
    </div>
  `;

  const titleInput = document.getElementById("edit-title");
  const contentInput = document.getElementById("edit-content");

  // 이미지 라이브러리
  const imageLibEl = document.getElementById("image-lib");
  const arr = Object.values(images).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (arr.length) {
    imageLibEl.innerHTML = `
      <label>이미지</label>
      ${arr.map(img => `
        <div class="image-card">
          <img class="image-thumb" src="${escapeHtml(img.url)}" alt="${escapeHtml(img.name || img.id)}" />
          <div class="image-meta">
            <div class="image-name">${escapeHtml(img.name || img.id)}</div>
            <div class="image-sub">${escapeHtml(img.id)} · ${escapeHtml(formatDate(img.createdAt))}</div>
          </div>
          <div class="image-actions">
            <button class="btn" type="button" data-insert="${escapeHtml(img.id)}">삽입</button>
            <button class="btn" type="button" data-del="${escapeHtml(img.id)}">삭제</button>
          </div>
        </div>
      `).join("")}
    `;

    imageLibEl.querySelectorAll("[data-insert]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-insert");
        const item = images[id];
        if (!item) return;
        insertAtCursor(contentInput, `[[Image:${id}|${item.name || "이미지"}]]`);
      });
    });

    imageLibEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-del");
        const item = images[id];
        if (!item) return;

        const ok = confirm("삭제하면 문서에 남은 참조는 깨질 수 있어. 삭제할까?");
        if (!ok) return;

        try {
          if (item.storagePath) await deleteObject(storageRef(storage, item.storagePath));
          await deleteDoc(imageDoc(id));
        } catch (e) {
          console.error(e);
          alert("삭제 실패(권한/네트워크 확인).");
        }
      });
    });
  }

  // 업로드
  const uploadBtn = document.getElementById("upload-img-btn");
  const uploadInput = document.getElementById("upload-img-input");
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    uploadInput.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("이미지 파일만 가능해.");

    try {
      const uploaded = await uploadImage(file);
      insertAtCursor(contentInput, `[[Image:${uploaded.id}|${uploaded.name}]]`);
    } catch (err) {
      console.error(err);
      alert("업로드 실패. (Storage Rules / 로그인 확인)");
    }
  });

  // 저장
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
      alert("저장 실패(중복 제목/권한/네트워크).");
    }
  });

  // 취소
  document.getElementById("cancel-btn").addEventListener("click", () => {
    if (mode === "edit" && editing) location.hash = `#/page/${editing.id}`;
    else location.hash = "#/";
  });
}

/* ===== UI bind ===== */
function bindUI() {
  document.querySelectorAll(".nav-btn[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");
      if (nav === "recent") location.hash = "#/";
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
      alert("로그인/로그아웃 오류. (Authorized domains 확인)");
    }
  });

  sideSearchInput.addEventListener("input", () => {
    sideQuery = sideSearchInput.value;
    buildList();
  });

  window.addEventListener("hashchange", route);
}

/* ===== Auth boot ===== */
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