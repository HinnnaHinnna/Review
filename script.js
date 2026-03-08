/* =========================================================
  Review 위키: 공개 읽기 + 로그인 편집(여러 사람 가능)
  - Firestore: wikis/Review/pages , wikis/Review/images
  - Storage : wikis/Review/images/...
  - 읽기는 누구나, 쓰기/업로드는 로그인한 사람만
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDocs, deleteDoc,
  query, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-storage.js";

/* ✅ 너의 Firebase 콘솔에서 복사한 firebaseConfig로 교체 */
const firebaseConfig = {
  apiKey: "AIzaSyASuyxEO3eBSmJmPwV7ZVxG6rb109G_1nE",
  authDomain: "sunday-book-club.firebaseapp.com",
  projectId: "sunday-book-club",
  storageBucket: "sunday-book-club.firebasestorage.app",
  messagingSenderId: "884270943833",
  appId: "1:884270943833:web:0a9cb935d62fada86e2b48",
  measurementId: "G-L92TPDPBZN"
};

const WIKI_ID = "Review"; // Firestore/Storage 규칙과 동일하게!

/* Firebase init */
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

/* State */
let currentUser = null;
let canEdit = false;

let pages = [];       // [{id,title,content,createdAt,updatedAt}]
let images = {};      // { [id]: {id,name,url,storagePath,createdAt,updatedAt,uploadedBy} }

let currentFilter = "all";
let sideQuery = "";

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
const imagesCol = () => collection(db, "wikis", WIKI_ID, "images");

/* Seed (처음 한 번만, “첫 로그인한 편집자”가 올림) */
async function ensureSeededOnce() {
  const snap = await getDocs(query(pagesCol(), limit(1)));
  if (!snap.empty) return;
  if (!canEdit) return;

  const seed = window.SEED_PAGES || [];
  for (const p of seed) {
    const id = toDocId(p.title);
    await setDoc(doc(db, "wikis", WIKI_ID, "pages", id), {
      title: p.title,
      content: p.content || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: currentUser?.email || "unknown"
    });
  }
}

/* Login / Logout */
async function login() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    // 팝업 차단/모바일 대비
    await signInWithRedirect(auth, provider);
  }
}
async function logout() {
  await signOut(auth);
}

/* Live listeners (읽기: 누구나) */
function startListeners() {
  // pages
  onSnapshot(
    query(pagesCol(), orderBy("updatedAt", "desc")),
    (snap) => {
      pages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      buildList();
      route(); // 현재 화면 재렌더(실시간 반영)
    },
    (err) => {
      console.error(err);
      viewEl.innerHTML = `<p>데이터를 불러오지 못했어. (Firestore Rules/프로젝트 설정을 확인해줘)</p>`;
    }
  );

  // images
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

/* front matter */
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
function getMetaType(page) {
  const { meta } = parseFrontMatter(page.content);
  return (meta.type || "note").trim();
}

/* wiki image render */
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

/* inline render (links + wiki links + images) */
function renderInline(text) {
  let t = escapeHtml(text);

  // Markdown image: ![cap](url or imageId)
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const target = (url || "").trim();
    if (!target) return m;
    if (!isUrlLike(target) && images[target]?.url) return renderImageFigure(images[target].url, alt || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, alt || "");
    return m;
  });

  // Wiki image: [[Image:target|caption]]
  t = t.replace(/\[\[(?:Image|File|파일|이미지)\:([^\]|]+)(?:\|([^\]]+))?\]\]/gi, (m, targetRaw, capRaw) => {
    const target = (targetRaw || "").trim();
    const caption = (capRaw || "").trim();
    if (!target) return m;
    if (images[target]?.url) return renderImageFigure(images[target].url, caption || images[target].name || "");
    if (isUrlLike(target)) return renderImageFigure(target, caption);
    return m;
  });

  // bold / italic
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // markdown link [text](url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const u = (url || "").trim();
    const l = (label || "").trim();
    if (!u) return m;
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l)}</a>`;
  });

  // wiki link [[...]]
  t = t.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
    const raw = (inner || "").trim();

    // [[label|target]]
    if (raw.includes("|")) {
      const [labelRaw, targetRaw] = raw.split("|");
      const label = (labelRaw || "").trim();
      const target = (targetRaw || "").trim();

      if (isUrlLike(target)) {
        return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || target)}</a>`;
      }
      return `<a href="#/page/${toDocId(target)}">${escapeHtml(label || target)}</a>`;
    }

    // [[https://...]]
    if (isUrlLike(raw)) {
      return `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
    }

    // [[문서]]
    return `<a href="#/page/${toDocId(raw)}">${escapeHtml(raw)}</a>`;
  });

  // bare url
  t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  return t;
}

/* block render */
function renderWiki(body) {
  const lines = (body || "").replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.trim() === "---") { out.push("<hr />"); i++; continue; }

    if (line.startsWith("### ")) { out.push(`<h3>${renderInline(line.slice(4))}</h3>`); i++; continue; }
    if (line.startsWith("## ")) { out.push(`<h2>${renderInline(line.slice(3))}</h2>`); i++; continue; }
    if (line.startsWith("# ")) { out.push(`<h2>${renderInline(line.slice(2))}</h2>`); i++; continue; }

    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${buf.map(l => `<p>${renderInline(l)}</p>`).join("")}</blockquote>`);
      continue;
    }

    if (line.trim().startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(`<li>${renderInline(lines[i].trim().slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim()) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

/* list build */
function buildList() {
  const qText = sideQuery.trim().toLowerCase();
  let list = [...pages];

  if (currentFilter !== "all") list = list.filter(p => getMetaType(p) === currentFilter);
  if (qText) list = list.filter(p => (p.title || "").toLowerCase().includes(qText));

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  pageListEl.innerHTML = list.map(p => {
    const type = getMetaType(p);
    const hint = `${type} · ${formatDate(p.updatedAt || p.createdAt)}`;
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

/* routing */
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

  location.hash = "#/";
}

function renderHome() {
  if (!pages.length) {
    viewEl.innerHTML = `
      <h2 class="page-title">Review</h2>
      <p>아직 클라우드에 문서가 없어. 로그인한 편집자가 한 번 들어와서 seed를 생성하면 시작돼.</p>
      <div class="tools-row">
        <button class="tool-link" type="button" id="login-seed">로그인</button>
      </div>
    `;
    document.getElementById("login-seed").addEventListener("click", login);
    return;
  }

  const recent = [...pages].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
  viewEl.innerHTML = `
    <h2 class="page-title">처음</h2>
    <p>읽기는 누구나. 편집/업로드는 로그인한 사람 누구나.</p>
    <hr />
    <h3 id="recent-anchor">최근</h3>
    <ul>
      ${recent.map(p => `<li><a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a> <span class="m">(${escapeHtml(formatDate(p.updatedAt || p.createdAt))})</span></li>`).join("")}
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
  if (meta.type) metaBits.push(`type: ${meta.type}`);
  if (meta.date) metaBits.push(`date: ${meta.date}`);
  if (meta.venue) metaBits.push(`venue: ${meta.venue}`);
  if (meta.tags) metaBits.push(`tags: ${meta.tags}`);

  viewEl.innerHTML = `
    <h2 class="page-title">${escapeHtml(page.title)}</h2>
    <div class="meta-row">
      <span>최종 편집: ${escapeHtml(formatDate(page.updatedAt || page.createdAt))}</span>
      ${metaBits.length ? `<span>·</span><span>${escapeHtml(metaBits.join(" · "))}</span>` : ""}
      ${page.updatedBy ? `<span>·</span><span>by ${escapeHtml(page.updatedBy)}</span>` : ""}
    </div>

    <div class="doc">${renderWiki(body)}</div>

    <div class="tools-row">
      <button class="tool-link" type="button" id="edit-btn">편집</button>
      <button class="tool-link" type="button" onclick="location.hash='#/'">처음</button>
    </div>
  `;

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (!canEdit) return alert("편집하려면 로그인해야 해.");
    location.hash = `#/edit/${slug}`;
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

/* cursor insert */
function insertAtCursor(textarea, textToInsert) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + textToInsert + value.slice(end);
  const newPos = start + textToInsert.length;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = newPos;
}

/* image upload */
async function uploadImage(file) {
  if (!canEdit) throw new Error("not logged in");

  const id = `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const safeName = (file.name || "image").replace(/[^\w.\-]+/g, "_");
  const path = `wikis/${WIKI_ID}/images/${id}_${safeName}`;

  const ref = storageRef(storage, path);
  await uploadBytes(ref, file);
  const url = await getDownloadURL(ref);

  await setDoc(doc(db, "wikis", WIKI_ID, "images", id), {
    name: file.name,
    url,
    storagePath: path,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploadedBy: currentUser?.email || "unknown"
  });

  return { id, name: file.name, url, storagePath: path };
}

/* save page */
async function savePage({ mode, oldId, title, content }) {
  if (!canEdit) throw new Error("not logged in");

  const now = Date.now();
  const newId = toDocId(title);

  await setDoc(doc(db, "wikis", WIKI_ID, "pages", newId), {
    title,
    content,
    createdAt: mode === "edit" ? (pages.find(p => p.id === oldId)?.createdAt || now) : now,
    updatedAt: now,
    updatedBy: currentUser?.email || "unknown"
  });

  // rename: delete old
  if (mode === "edit" && oldId && oldId !== newId) {
    await deleteDoc(doc(db, "wikis", WIKI_ID, "pages", oldId));
  }

  return newId;
}

/* editor */
function renderEditor({ mode, slug }) {
  if (!canEdit) {
    viewEl.innerHTML = `
      <h2 class="page-title">편집하려면 로그인</h2>
      <p>이 위키는 공개 읽기, 로그인 편집이야.</p>
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
  const contentValue = editing ? editing.content : `---\ntype: note\ntags: \n---\n\n여기에 내용을 입력...\n`;

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
    </div>
  `;

  const titleInput = document.getElementById("edit-title");
  const contentInput = document.getElementById("edit-content");

  // image library
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
          await deleteDoc(doc(db, "wikis", WIKI_ID, "images", id));
        } catch (e) {
          console.error(e);
          alert("삭제 실패(권한/네트워크 확인).");
        }
      });
    });
  }

  // upload
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
      alert("업로드 실패. (Storage Rules / Authorized domains / 로그인 확인)");
    }
  });

  // save
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

  // cancel
  document.getElementById("cancel-btn").addEventListener("click", () => {
    if (mode === "edit" && editing) location.hash = `#/page/${editing.id}`;
    else location.hash = "#/";
  });
}

/* UI bind */
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

  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentFilter = chip.getAttribute("data-filter");
      buildList();
    });
  });

  sideSearchInput.addEventListener("input", () => {
    sideQuery = sideSearchInput.value;
    buildList();
  });

  window.addEventListener("hashchange", route);
}

/* Auth boot */
async function bootAuth() {
  try { await getRedirectResult(auth); } catch { }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    canEdit = !!user;

    if (user) {
      authBtn.textContent = "로그아웃";
      authStatus.textContent = `편집 모드: ${user.email || "로그인"}`;
      // seed (컬렉션 비어있으면 1회 생성)
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
startListeners();
route();
bootAuth();