/* =========================================================
  Review Wiki
  - Google login edit for multiple editors
  - Firestore live sync
  - History / revision / revert
  - Renderer and layout updated to match note.html style
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
    import {
      getAuth,
      GoogleAuthProvider,
      signInWithPopup,
      signOut,
      onAuthStateChanged
    } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
    import {
      getFirestore,
      collection,
      doc,
      getDoc,
      getDocs,
      setDoc,
      deleteDoc,
      onSnapshot,
      query,
      orderBy,
      limit,
      writeBatch
    } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

    const CATEGORY_OPTIONS = ["미디어의 이해", "다른 방식으로 보기", "이미지란 무엇인가"];
    const HOME_PAGE_TITLE = "일요 독서모임은";
    const MAX_REVISIONS = 10;

    const firebaseConfig = {
      apiKey: "AIzaSyASuyxEO3eBSmJmPwV7ZVxG6rb109G_1nE",
      authDomain: "sunday-book-club.firebaseapp.com",
      projectId: "sunday-book-club",
      storageBucket: "sunday-book-club.firebasestorage.app",
      messagingSenderId: "884270943833",
      appId: "1:884270943833:web:0a9cb935d62fada86e2b48",
      measurementId: "G-L92TPDPBZN"
    };

    const OWNER_EMAIL = "";
    const OWNER_UID = "";
    const WIKI_ID = "Review";

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const googleProvider = new GoogleAuthProvider();

    /*
      Review 사이트의 Firestore 저장 위치.
      기존 Review.zip의 구조와 동일하게 wikis/Review/pages 아래에 문서를 저장한다.
    */
    const pagesCol = () => collection(db, "wikis", WIKI_ID, "pages");
    const pageDoc = (pageId) => doc(db, "wikis", WIKI_ID, "pages", pageId);
    const revisionsCol = (pageId) => collection(db, "wikis", WIKI_ID, "pages", pageId, "revisions");


    const viewEl = document.getElementById("view");
    const pageListEl = document.getElementById("page-list");
    const sideSearchInput = document.getElementById("side-search-input");
    const authBtn = document.getElementById("auth-btn");
    const authStatus = document.getElementById("auth-status");
    const chipWrap = document.getElementById("category-chips");

    let pages = [];
    let revisions = {};
    let pagesReady = false;
    let currentFilter = "all";
    let sideQuery = "";
    let canEdit = false;

    let currentUser = null;
    let unsubscribePages = null;
    let hasAttemptedSeed = false;


    function ownerEmailNormalized() {
      return String(OWNER_EMAIL || "").trim().toLowerCase();
    }

    function isOwnerUser(user) {
      // Review는 여러 사람이 로그인해서 함께 편집하는 위키이므로,
      // 특정 오너 계정만 허용하지 않고 로그인한 사용자는 모두 편집 가능하게 둔다.
      return !!user;
    }

    function getActorLabel() {
      return currentUser?.email || currentUser?.displayName || "editor";
    }

    function makeOwnerFields() {
      return {
        lastEditorUid: currentUser?.uid || null,
        lastEditorEmail: currentUser?.email || null
      };
    }

    function getVisibility(page) {
      return page?.visibility === "private" ? "private" : "public";
    }

    function canReadPage(page) {
      if (!page) return false;
      if (getVisibility(page) === "public") return true;
      return canEdit;
    }

    function normalizePageDoc(id, data) {
      return {
        id,
        title: data?.title || id,
        content: data?.content || "",
        createdAt: Number(data?.createdAt || Date.now()),
        updatedAt: Number(data?.updatedAt || data?.createdAt || Date.now()),
        updatedBy: data?.updatedBy || "",
        aliases: Array.isArray(data?.aliases) ? data.aliases : [],
        visibility: data?.visibility === "private" ? "private" : "public"
      };
    }

    function updateAuthUI() {
      if (canEdit) {
        authBtn.textContent = "로그아웃";
        authStatus.textContent = currentUser?.email || "편집 모드";
      } else {
        authBtn.textContent = "로그인";
        authStatus.textContent = "읽기 모드";
      }
      route();
    }

    async function login() {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        console.error(error);
        alert("구글 로그인에 실패했어. Firebase 설정과 승인된 도메인을 다시 확인해줘.");
      }
    }

    async function logout() {
      try {
        await signOut(auth);
      } catch (error) {
        console.error(error);
        alert("로그아웃에 실패했어.");
      }
    }

    async function ensureSeedPages() {
      if (!canEdit || hasAttemptedSeed) return;
      hasAttemptedSeed = true;

      try {
        const snap = await getDocs(pagesCol());
        if (!snap.empty) return;

        const seed = Array.isArray(window.SEED_PAGES) ? window.SEED_PAGES : [];
        if (!seed.length) return;

        const now = Date.now();
        const batch = writeBatch(db);
        seed.forEach((p) => {
          const id = toDocId(p.title);
          batch.set(pageDoc(id), {
            id,
            title: p.title,
            content: p.content || "",
            createdAt: now,
            updatedAt: now,
            updatedBy: getActorLabel(),
            aliases: [],
            visibility: p.visibility === "private" ? "private" : "public",
            ...makeOwnerFields()
          }, { merge: true });
        });
        await batch.commit();
      } catch (error) {
        hasAttemptedSeed = false;
        throw error;
      }
    }

    function subscribePages() {
      if (unsubscribePages) unsubscribePages();

      const pagesRef = pagesCol();

      const q = query(pagesRef, orderBy("updatedAt", "desc"));

      unsubscribePages = onSnapshot(q, async (snapshot) => {
        if (snapshot.empty && canEdit) {
          await ensureSeedPages();
          return;
        }

        pages = snapshot.docs.map((d) => normalizePageDoc(d.id, d.data()));
        pagesReady = true;
        buildList();
        route();
      }, (error) => {
        console.error(error);
        pagesReady = true;

        const msg =
          error?.code === "permission-denied"
            ? "읽기 권한이 없어. Firestore Rules를 확인해줘."
            : error?.code === "failed-precondition"
              ? "문서 목록 정렬에 필요한 Firestore 인덱스가 아직 없거나 빌드 중이야."
              : `문서를 불러오는 중 오류가 났어: ${error?.message || error?.code || "unknown error"}`;

        viewEl.innerHTML = `<p class="muted">${msg}</p>`;
      });
    }

    async function backfillVisibilityToPublic() {
      if (!canEdit) return;

      const snap = await getDocs(pagesCol());
      const batch = writeBatch(db);
      let count = 0;

      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (!("visibility" in data)) {
          batch.set(docSnap.ref, { visibility: "public" }, { merge: true });
          count++;
        }
      });

      if (count > 0) {
        await batch.commit();
        console.log(`visibility 없는 문서 ${count}개를 public으로 채웠어.`);
      } else {
        console.log("visibility 없는 문서가 없어서 아무것도 안 바꿨어.");
      }
    }

    function loadAll() {
      subscribePages();
    }

    function savePages() {
    }

    function saveRevisions() {
    }

    async function initFirebase() {
      onAuthStateChanged(auth, async (user) => {
        if (user && !isOwnerUser(user)) {
          alert("이 구글 계정은 편집 권한이 없어. 오너 계정으로 다시 로그인해줘.");
          await signOut(auth);
          currentUser = null;
          canEdit = false;
          updateAuthUI();
          loadAll();
          return;
        }

        currentUser = user || null;
        canEdit = !!currentUser && isOwnerUser(currentUser);
        updateAuthUI();

        if (canEdit) {
          try {
            await ensureSeedPages();
            await backfillVisibilityToPublic();
          } catch (error) {
            console.error(error);
          }
        }

        loadAll();
      });
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
      return encodeURIComponent((title || "").trim().replace(/\s+/g, "-"));
    }

    function isUrlLike(s) {
      return /^https?:\/\//i.test(s)
    }


    function getGoogleDriveFileId(url) {
      const raw = String(url || "").trim();
      if (!raw) return "";

      const filePathMatch = raw.match(/drive\.google\.com\/file\/d\/([^/]+)/i);
      if (filePathMatch) return decodeURIComponent(filePathMatch[1]);

      const queryIdMatch = raw.match(/[?&]id=([^&]+)/i);
      if (queryIdMatch) return decodeURIComponent(queryIdMatch[1]);

      return "";
    }

    function normalizeImageSrc(rawUrl) {
      const url = String(rawUrl || "").trim();
      if (!url) return "";

      /*
        Google Drive의 공유 링크는 그 자체가 이미지 파일 주소가 아니라
        "미리보기 페이지 주소"인 경우가 많다.
        그래서 이미지 태그의 src에 들어갈 수 있도록 thumbnail 주소로 바꾼다.

        예:
        https://drive.google.com/file/d/파일ID/view?usp=drive_link
        → https://drive.google.com/thumbnail?id=파일ID&sz=w1600
      */
      if (/^https?:\/\/drive\.google\.com\//i.test(url)) {
        const fileId = getGoogleDriveFileId(url);
        if (fileId) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
      }

      return url;
    }

    function isAllowedImageUrl(rawUrl) {
      const url = String(rawUrl || "").trim();
      if (!url) return false;

      if (/^https?:\/\//i.test(url)) return true;
      if (/^(\/|\.\/|\.\.\/)/.test(url)) return true;

      return /^[^<>"']+\.(png|jpe?g|gif|webp|svg|avif)(\?[^<>"']*)?(#[^<>"']*)?$/i.test(url);
    }

    function sanitizeImageWidth(value) {
      const raw = String(value || "").trim();
      if (!raw) return "";

      // 숫자만 쓰면 px 단위로 처리한다.
      // 예: width:300 → 300px
      if (/^\d+$/.test(raw)) return `${raw}px`;

      // 자주 쓰는 CSS 길이 단위만 허용한다.
      // 이상한 문자열이 style 속성 안에 들어가지 않도록 제한하기 위함이다.
      if (/^\d+(?:\.\d+)?(px|%|vw|vh|rem|em)$/.test(raw)) return raw;

      return "";
    }

    function parseImageSpec(value) {
      const raw = String(value || "").trim();
      const result = {
        url: raw,
        width: ""
      };

      // 이미지 주소 뒤에 옵션이 없으면 그대로 사용한다.
      // 예: ![설명](https://example.com/a.png)
      if (!raw.includes("|")) return result;

      const parts = raw.split("|");
      result.url = parts.shift().trim();
      const optionText = parts.join("|");

      // 지원 문법:
      // ![설명](image.png | width:300px)
      // ![설명](image.png | width:50%)
      // ![설명](image.png | width:40vw)
      const widthMatch = optionText.match(/(?:^|\|)\s*width\s*:\s*([^|\s]+)\s*/i)
        || optionText.match(/(?:^|\s)width\s*:\s*([^|\s]+)\s*/i);

      if (widthMatch) {
        result.width = sanitizeImageWidth(widthMatch[1]);
      }

      return result;
    }

    function makeImageWidthStyle(width) {
      const safeWidth = sanitizeImageWidth(width);
      return safeWidth ? ` style="width:${escapeHtml(safeWidth)};"` : "";
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

    function stripHtmlComments(value) {
      const open = "<" + "!--";
      const close = "--" + ">";
      return String(value || "").replace(new RegExp(open + "[\\s\\S]*?" + close, "g"), "");
    }

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
        if (key) meta[key] = val;
      });
      return { meta, body };
    }


    function getRedirectTarget(content) {
      const { body } = parseFrontMatter(String(content || ""));
      const m = body.trim().match(/^#redirect\s*\[\[([^\]]+)\]\]/i);
      if (!m) return null;
      const inside = (m[1] || "").trim();
      const targetTitle = inside.includes("|") ? inside.split("|")[0].trim() : inside;
      return targetTitle ? { targetTitle, targetId: toDocId(targetTitle) } : null;
    }

    function isRedirectPage(page) {
      return !!getRedirectTarget(page?.content || "");
    }


    function getCategory(page) {
      const { meta } = parseFrontMatter(page.content);
      return (meta.category || meta.type || "").trim();
    }


    function protectInlineCode(rawText) {
      const codes = [];
      const replaced = String(rawText || "").replace(/`([^`\n]+)`/g, (m, inner) => {
        codes.push(inner);
        return `{{CODE:${codes.length - 1}}}`;
      });
      return { text: replaced, codes };
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
        blocks.push(codeLines.join("\n"));
        outLines.push(`{{CODEBLOCK:${blocks.length - 1}}}`);
      }
      return { lines: outLines, blocks };
    }

    function protectInlineCodeAll(text) {
      const codes = [];
      const out = String(text || "").replace(/`([^`\n]+)`/g, (m, inner) => {
        codes.push(inner);
        return `{{INLINECODE:${codes.length - 1}}}`;
      });
      return { text: out, codes };
    }

    function restoreInlineCodeAll(text, codes) {
      return String(text || "").replace(/\{\{INLINECODE:(\d+)\}\}/g, (m, n) => {
        return "`" + (codes[Number(n)] ?? "") + "`";
      });
    }


    function sanitizeEmbedSize(value, fallback) {
      const raw = String(value || "").trim();
      if (!raw) return fallback;

      if (/^\d+$/.test(raw)) return `${raw}px`;
      if (/^\d+(?:\.\d+)?(px|%|vw|vh)$/.test(raw)) return raw;

      return fallback;
    }

    function parseIframeEmbed(line) {
      const trimmed = String(line || "").trim();
      const match = trimmed.match(/^\(iframe:\s*(https:\/\/[^\s)]+)([\s\S]*?)\)$/i);
      if (!match) return null;

      const url = match[1].trim();
      const options = match[2] || "";

      const widthMatch = options.match(/(?:^|\s)width:\s*([^\s)]+)/i);
      const heightMatch = options.match(/(?:^|\s)height:\s*([^\s)]+)/i);

      return {
        url,
        width: sanitizeEmbedSize(widthMatch?.[1], "100%"),
        height: sanitizeEmbedSize(heightMatch?.[1], "560px")
      };
    }

    function renderIframeEmbed(embed) {
      if (!embed?.url) return "";

      const safeUrl = escapeHtml(embed.url);
      const safeWidth = escapeHtml(embed.width || "100%");
      const safeHeight = escapeHtml(embed.height || "560px");

      return `
        <div class="wiki-embed">
          <iframe
            class="wiki-embed-frame"
            src="${safeUrl}"
            title="Embedded content"
            loading="lazy"
            referrerpolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            allowfullscreen
            style="width:${safeWidth}; height:${safeHeight};"
          ></iframe>
        </div>`;
    }

    function scrollToFootnoteTarget(targetId) {
      const id = String(targetId || "").trim();
      if (!id) return;

      const target = document.getElementById(id);
      if (!target) return;

      target.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

      target.classList.remove("footnote-target-flash");
      void target.offsetWidth;
      target.classList.add("footnote-target-flash");

      window.setTimeout(() => {
        target.classList.remove("footnote-target-flash");
      }, 1400);
    }

    function renderInline(text) {
      let raw = normalizeSmartQuotes(String(text || ""));
      const { text: protected1, codes } = protectInlineCode(raw);
      raw = protected1;

      raw = stripHtmlComments(raw);
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

      /*
        링크 이미지 문법을 먼저 처리한다.

        사용 예:
        [![2권 중](삼백초2권원문_2.png)](https://drive.google.com/file/d/문서ID/view)

        중요한 점:
        - 이 문법은 이미지 문법과 링크 문법이 겹쳐 있다.
        - 그래서 일반 이미지 ![...](...)보다 먼저 처리해야 한다.
        - 이미지 주소는 https:// 주소뿐 아니라 같은 폴더의 png, jpg, gif, webp, svg 파일명도 허용한다.
      */
      t = t.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\((https?:\/\/[^)]+)\)/g, (m, alt, imgUrl, linkUrl) => {
        const imageSpec = parseImageSpec(imgUrl);
        const rawImgUrl = imageSpec.url;
        const rawLinkUrl = String(linkUrl || "").trim();

        if (!isAllowedImageUrl(rawImgUrl)) return m;

        const imageSrc = normalizeImageSrc(rawImgUrl);
        const su = escapeHtml(imageSrc);
        const href = escapeHtml(rawLinkUrl);
        const sa = escapeHtml(alt || "");
        const widthStyle = makeImageWidthStyle(imageSpec.width);

        return `
          <figure class="wiki-figure">
            <a class="wiki-img-link" href="${href}" target="_blank" rel="noopener noreferrer">
              <img class="wiki-img" src="${su}" alt="${sa}" loading="lazy"${widthStyle} />
            </a>
            ${sa ? `<figcaption class="wiki-caption">${sa}</figcaption>` : ""}
          </figure>`;
      });

      /*
        일반 이미지 문법
        사용 예:
        ![이미지 설명](image.png)
        ![이미지 설명](https://example.com/image.png)
      */
      t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
        const imageSpec = parseImageSpec(url);
        const rawUrl = imageSpec.url;

        if (!isAllowedImageUrl(rawUrl)) return m;

        const imageSrc = normalizeImageSrc(rawUrl);
        const su = escapeHtml(imageSrc);
        const href = escapeHtml(rawUrl);
        const sa = escapeHtml(alt || "");
        const widthStyle = makeImageWidthStyle(imageSpec.width);

        return `
    <figure class="wiki-figure">
      <a class="wiki-img-link" href="${href}" target="_blank" rel="noopener noreferrer">
        <img class="wiki-img" src="${su}" alt="${sa}" loading="lazy"${widthStyle} />
      </a>
      ${sa ? `<figcaption class="wiki-caption">${sa}</figcaption>` : ""}
    </figure>`;
      });

      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      });

      t = t.replace(/\[\[(?:Image|File|파일|이미지):(https?:\/\/[^\]|]+|[^\]|]+\.(?:png|jpe?g|gif|webp|svg|avif))(?:\|([^\]]+))?\]\]/gi, (m, url, cap) => {
        const rawUrl = String(url || "").trim();
        if (!isAllowedImageUrl(rawUrl)) return m;

        const optionText = String(cap || "");
        const widthMatch = optionText.match(/(?:^|\|)\s*width\s*:\s*([^|\s]+)\s*/i);
        const widthStyle = makeImageWidthStyle(widthMatch?.[1] || "");
        const captionText = optionText
          .split("|")
          .map(part => part.trim())
          .filter(part => part && !/^width\s*:/i.test(part))
          .join(" | ");

        const imageSrc = normalizeImageSrc(rawUrl);
        const su = escapeHtml(imageSrc);
        const href = escapeHtml(rawUrl);
        const sc = escapeHtml(captionText);

        return `
          <figure class="wiki-figure">
            <a class="wiki-img-link" href="${href}" target="_blank" rel="noopener noreferrer">
              <img class="wiki-img" src="${su}" alt="${sc}" loading="lazy"${widthStyle} />
            </a>
            ${sc ? `<figcaption class="wiki-caption">${sc}</figcaption>` : ""}
          </figure>`;
      });

      t = t.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
        const raw2 = (inner || "").trim();
        if (raw2.includes("|")) {
          const [targetRaw, labelRaw] = raw2.split("|");
          const target = (targetRaw || "").trim();
          const label = (labelRaw || "").trim();
          if (isUrlLike(target)) return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || target)}</a>`;
          return `<a href="#/page/${toDocId(target)}">${escapeHtml(label || target)}</a>`;
        }
        if (isUrlLike(raw2)) return `<a href="${escapeHtml(raw2)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw2)}</a>`;
        return `<a href="#/page/${toDocId(raw2)}">${escapeHtml(raw2)}</a>`;
      });

      t = t.replace(/\{\{REF:(\d+)\}\}/g, (m, n) => {
        const num = Number(n);
        return `<sup class="ref" id="refback-${num}"><button type="button" class="footnote-link" data-footnote-target="ref-${num}" aria-label="각주 ${num}번으로 이동">[${num}]</button></sup>`;
      });

      t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g,
        (m, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      );

      t = t.replace(/\{\{CODE:(\d+)\}\}/g, (m, idxStr) => {
        return `<code class="inline-code">${escapeHtml(codes[Number(idxStr)] ?? "")}</code>`;
      });

      return t;
    }

    function consumeMwList(lines, startIndex) {
      let i = startIndex;
      const out = [];
      const stack = [];
      let openLiDepth = 0;

      const typeOf = ch => ch === "*" ? "ul" : "ol";

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
        const prefix = m[1], itemText = m[2];
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

    /*
      마크다운 표 문법을 처리하기 위한 보조 함수들
      사용 예:
      | 이름 | 설명 |
      | --- | --- |
      | A | 첫 번째 데이터 |
      | B | 두 번째 데이터 |

      규칙:
      - | 문자로 열을 나눈다.
      - 첫 줄은 헤더 행이다.
      - 두 번째 줄은 구분 행이며, 각 칸은 최소 3개 이상의 하이픈(---)을 포함해야 한다.
      - 구분 행에는 선택적으로 정렬 문법도 사용할 수 있다.
        :---  왼쪽 정렬
        :---: 가운데 정렬
        ---:  오른쪽 정렬
    */
    function splitMarkdownTableRow(line) {
      let raw = String(line || "").trim();

      // 표의 맨 앞/맨 뒤에 붙는 | 는 장식에 가까우므로 제거한다.
      // 예: | 이름 | 설명 | → 이름 | 설명
      if (raw.startsWith("|")) raw = raw.slice(1);
      if (raw.endsWith("|")) raw = raw.slice(0, -1);

      const cells = [];
      let current = "";
      let isEscaped = false;

      for (const ch of raw) {
        // \|처럼 백슬래시로 이스케이프한 파이프는 열 구분자로 보지 않는다.
        if (isEscaped) {
          current += ch;
          isEscaped = false;
          continue;
        }

        if (ch === "\\") {
          isEscaped = true;
          continue;
        }

        if (ch === "|") {
          cells.push(current.trim());
          current = "";
          continue;
        }

        current += ch;
      }

      cells.push(current.trim());
      return cells;
    }

    function isMarkdownTableSeparator(line) {
      if (!String(line || "").includes("|")) return false;

      const cells = splitMarkdownTableRow(line);
      if (!cells.length) return false;

      return cells.every(cell => {
        const trimmed = cell.trim();
        // --- / :--- / ---: / :---: 형태를 허용한다.
        return /^:?-{3,}:?$/.test(trimmed);
      });
    }

    function isMarkdownTableStart(localLines, index) {
      const headerLine = localLines[index] || "";
      const separatorLine = localLines[index + 1] || "";

      if (!headerLine.includes("|")) return false;
      if (!isMarkdownTableSeparator(separatorLine)) return false;

      const headerCells = splitMarkdownTableRow(headerLine);
      const separatorCells = splitMarkdownTableRow(separatorLine);

      // 표는 최소 두 개 이상의 열이 있을 때만 표로 처리한다.
      // 한 줄 안에 우연히 | 문자가 들어간 문장을 표로 오해하지 않게 하기 위함이다.
      if (headerCells.length < 2) return false;

      // 헤더 칸 수와 구분 칸 수가 크게 어긋나면 표가 아닌 일반 문장으로 둔다.
      if (separatorCells.length < headerCells.length) return false;

      return true;
    }

    function getMarkdownTableAlign(separatorCell) {
      const cell = String(separatorCell || "").trim();

      if (/^:-{3,}:$/.test(cell)) return "center";
      if (/^-{3,}:$/.test(cell)) return "right";
      if (/^:-{3,}$/.test(cell)) return "left";

      return "";
    }

    function renderMarkdownTable(localLines, startIndex) {
      const headerCells = splitMarkdownTableRow(localLines[startIndex]);
      const separatorCells = splitMarkdownTableRow(localLines[startIndex + 1]);
      const aligns = separatorCells.map(getMarkdownTableAlign);

      const rows = [];
      let i = startIndex + 2;

      while (i < localLines.length) {
        const line = localLines[i];

        // 빈 줄을 만나면 표가 끝난 것으로 본다.
        if (!line.trim()) break;

        // | 가 없는 줄을 만나면 표가 끝난 것으로 본다.
        if (!line.includes("|")) break;

        // 다른 표의 구분 행만 단독으로 다시 나오면 표가 끝난 것으로 본다.
        if (isMarkdownTableSeparator(line)) break;

        rows.push(splitMarkdownTableRow(line));
        i++;
      }

      const columnCount = Math.max(
        headerCells.length,
        separatorCells.length,
        ...rows.map(row => row.length)
      );

      function renderCell(tagName, cellText, columnIndex) {
        const align = aligns[columnIndex] || "";
        const alignAttr = align ? ` style="text-align:${align};"` : "";
        return `<${tagName}${alignAttr}>${renderInline(cellText || "")}</${tagName}>`;
      }

      const thead = `
        <thead>
          <tr>
            ${Array.from({ length: columnCount }, (_, idx) => {
        return renderCell("th", headerCells[idx] || "", idx);
      }).join("")}
          </tr>
        </thead>`;

      const tbody = rows.length
        ? `
        <tbody>
          ${rows.map(row => `
            <tr>
              ${Array.from({ length: columnCount }, (_, idx) => {
          return renderCell("td", row[idx] || "", idx);
        }).join("")}
            </tr>`).join("")}
        </tbody>`
        : "";

      return {
        html: `
          <div class="wiki-table-wrap">
            <table class="wiki-table">
              ${thead}
              ${tbody}
            </table>
          </div>`,
        nextIndex: i
      };
    }

    function renderParagraphBr(linesBuf) {
      return linesBuf.map(l => renderInline(l)).join("<br>");
    }

    let __REFS = [];

    function renderWiki(body) {
      __REFS = [];

      const originalLines = normalizeSmartQuotes(String(body || ""))
        .replaceAll("\r\n", "\n").split("\n");

      const { lines: extracted, blocks: codeBlocks } = extractFencedCodeBlocks(originalLines);
      const { text: iProtected, codes: iCodes } = protectInlineCodeAll(extracted.join("\n"));
      let text = iProtected;

      text = stripHtmlComments(text);

      text = text.replace(/<ref>([\s\S]*?)<\/ref>/gi, (m, inner) => {
        __REFS.push((inner || "").trim());
        return `{{REF:${__REFS.length}}}`;
      });

      // 본문에서 각주 번호 바로 앞에 생기는 빈칸을 제거한다.
      // 예: "문장 <ref>각주</ref>" → "문장[1]"처럼 붙어서 보이게 한다.
      text = text.replace(/[ \t]+\{\{REF:/g, "{{REF:");

      text = text.replace(
        /\{\{\s*숨김\s*시작\s*\|\s*제목\s*=\s*([^}]+?)\s*\}\}/g,
        (m, titleRaw) => `\n{{HIDE_START:${encodeURIComponent(String(titleRaw).trim())}}}\n`
      );
      text = text.replace(/\{\{\s*숨김\s*끝\s*\}\}/g, "\n{{HIDE_END}}\n");

      text = restoreInlineCodeAll(text, iCodes);

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

          const cbMatch = line.trim().match(/^\{\{CODEBLOCK:(\d+)\}\}$/);
          if (cbMatch) {
            const codeText = codeBlocks[Number(cbMatch[1])] ?? "";
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
              if (l.trim().match(/^\{\{HIDE_START:/)) {
                depth++;
                inner.push(l);
                i++;
                continue;
              }
              if (l.trim() === "{{HIDE_END}}") {
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
            out.push(`
              <details class="mw-hide">
                <summary>${escapeHtml(title)}</summary>
                <div class="mw-hide-body">${renderFromLines(inner)}</div>
              </details>`);
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
              const items = __REFS.map((ref, idx) => {
                const n = idx + 1;
                return `
                  <li id="ref-${n}">
                    ${renderInline(ref)}
                    <button
                      type="button"
                      class="footnote-link"
                      data-footnote-target="refback-${n}"
                      aria-label="본문의 각주 ${n}번 위치로 돌아가기"
                    >↩︎</button>
                  </li>`;
              }).join("");
              out.push(`<ol class="reflist">${items}</ol>`);
            }
            i++;
            continue;
          }

          const iframeEmbed = parseIframeEmbed(line);
          if (iframeEmbed) {
            out.push(renderIframeEmbed(iframeEmbed));
            i++;
            continue;
          }

          const mwH = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
          if (mwH) {
            const level = Math.min(6, Math.max(2, mwH[1].length));
            out.push(`<h${level}>${renderInline(mwH[2])}</h${level}>`);
            i++;
            continue;
          }

          if (line.startsWith("### ")) {
            out.push(`<h4>${renderInline(line.slice(4))}</h4>`);
            i++;
            continue;
          }
          if (line.startsWith("## ")) {
            out.push(`<h3>${renderInline(line.slice(3))}</h3>`);
            i++;
            continue;
          }
          if (line.startsWith("# ")) {
            out.push(`<h2>${renderInline(line.slice(2))}</h2>`);
            i++;
            continue;
          }

          if (isMarkdownTableStart(localLines, i)) {
            const { html, nextIndex } = renderMarkdownTable(localLines, i);
            out.push(html);
            i = nextIndex;
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
            /*
              문단을 모으는 중간에 표 시작 행을 만나면 문단을 끊는다.
              이렇게 해야 아래처럼 빈 줄 없이 이어 써도 표가 적용된다.

              설명 문장
              | 이름 | 설명 |
              | --- | --- |
              | A | B |
            */
            if (buf.length > 0 && isMarkdownTableStart(localLines, i)) break;

            buf.push(localLines[i]);
            i++;
          }
          out.push(`<p>${renderParagraphBr(buf)}</p>`);
        }

        return out.join("\n");
      }

      return renderFromLines(lines);
    }


    async function fetchRevisions(pageId) {
      const q = query(
        revisionsCol(pageId),
        orderBy("savedAt", "desc"),
        limit(MAX_REVISIONS)
      );
      const snap = await getDocs(q);
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      revisions[pageId] = rows;
      return rows;
    }

    async function trimOldRevisions(pageId) {
      const q = query(revisionsCol(pageId), orderBy("savedAt", "desc"));
      const snap = await getDocs(q);
      if (snap.size <= MAX_REVISIONS) return;

      const batch = writeBatch(db);
      snap.docs.slice(MAX_REVISIONS).forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
    }

    async function addRevision(pageId, { title, content, savedBy, savedAt, note }) {
      if (!canEdit) throw new Error("로그인해야 히스토리를 저장할 수 있어.");

      const ref = doc(revisionsCol(pageId));
      await setDoc(ref, {
        id: ref.id,
        title,
        content,
        visibility: pages.find(p => p.id === pageId)?.visibility || "public",
        savedBy: savedBy || getActorLabel(),
        savedAt: Number(savedAt || Date.now()),
        note: note || ""
      });

      await trimOldRevisions(pageId);
      await fetchRevisions(pageId);
    }


    function buildChips() {
      chipWrap.innerHTML = "";

      const makeChip = (label, filter) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `chip ${currentFilter === filter ? "is-active" : ""}`;
        btn.textContent = label;
        btn.addEventListener("click", () => {
          currentFilter = filter;
          buildChips();
          buildList();
        });
        chipWrap.appendChild(btn);
      };

      makeChip("전체", "all");
      CATEGORY_OPTIONS.forEach(cat => makeChip(cat, cat));
    }


    function buildList() {
      const q = sideQuery.trim().toLowerCase();
      let list = [...pages].filter(p => !isRedirectPage(p) && canReadPage(p));

      if (currentFilter !== "all") list = list.filter(p => getCategory(p) === currentFilter);
      if (q) list = list.filter(p => (p.title || "").toLowerCase().includes(q));
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      pageListEl.innerHTML = list.map(p => {
        const cat = getCategory(p);
        const visibilityText = getVisibility(p) === "private" ? "비공개" : "공개";
        const hint = `${cat ? cat + " · " : ""}${visibilityText} · ${formatDate(p.updatedAt || p.createdAt)}`;
        return `
          <li class="page-item" data-id="${escapeHtml(p.id)}">
            <div class="t">${escapeHtml(p.title)}</div>
            <div class="m">${escapeHtml(hint)}</div>
          </li>`;
      }).join("");

      pageListEl.querySelectorAll(".page-item").forEach(li => {
        li.addEventListener("click", () => {
          location.hash = `#/page/${li.getAttribute("data-id")}`;
        });
      });
    }


    function route() {
      if (!pagesReady) {
        viewEl.innerHTML = `<p class="muted">불러오는 중...</p>`;
        return;
      }

      const hash = location.hash || "#/";
      const [path, qs] = hash.replace("#", "").split("?");

      if (path === "/") return renderGuideHome();
      if (path === "/recent") return renderRecent();
      if (path === "/search") return renderSearch((new URLSearchParams(qs || "")).get("q") || "");
      if (path === "/new") return renderEditor({ mode: "new" });
      if (path.startsWith("/page/")) return renderPage(path.replace("/page/", ""));
      if (path.startsWith("/edit/")) return renderEditor({ mode: "edit", slug: path.replace("/edit/", "") });
      if (path.startsWith("/history/")) return renderHistory(path.replace("/history/", ""));
      if (path.startsWith("/revision/")) {
        const [pageId, revId] = path.replace("/revision/", "").split("/");
        return renderRevision(pageId, revId);
      }

      location.hash = "#/";
    }

    function renderGuideHome() {
      const homeId = toDocId(HOME_PAGE_TITLE);
      const homePage = pages.find(p => p.id === homeId);

      if (!homePage || !canReadPage(homePage)) {
        return renderRecent();
      }

      const redirect = getRedirectTarget(homePage.content);
      if (redirect) {
        return renderPage(redirect.targetId);
      }

      return renderPage(homeId);
    }

    function renderRecent() {
      const recent = [...pages]
        .filter(p => !isRedirectPage(p) && canReadPage(p))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 10);

      viewEl.innerHTML = `
        <h2 class="page-title">최근</h2>
        <ul>
          ${recent.map(p => `
            <li>
              <a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a>
              <span class="muted"> · ${escapeHtml(getVisibility(p) === "private" ? "비공개" : "공개")}</span>
            </li>
          `).join("")}
        </ul>`;
    }


    function renderPage(pageId) {
      const page = pages.find(p => p.id === pageId);

      if (!canReadPage(page)) {
        viewEl.innerHTML = `
          <h2 class="page-title">비공개 문서</h2>
          <p>이 문서는 아직 공개되지 않았어.</p>
          <div class="tools-row">
            <button class="tool-link" type="button" onclick="location.hash='#/'">홈으로</button>
          </div>`;
        return;
      }

      const redirect = getRedirectTarget(page.content);
      if (redirect) {
        viewEl.innerHTML = `
          <h2 class="page-title">${escapeHtml(page.title)}</h2>
          <p class="muted">
            이 문서는 <a href="#/page/${escapeHtml(redirect.targetId)}">${escapeHtml(redirect.targetTitle)}</a>로 이동했습니다. 이동 중…
          </p>
          <div class="meta-row">
            <span>공개 상태: ${escapeHtml(getVisibility(page) === "private" ? "비공개" : "공개")}</span>
          </div>
          <div class="tools-row">
            <button class="tool-link" type="button" id="go-btn">이동</button>
            <button class="tool-link" type="button" id="stay-btn">여기 머물기</button>
            <button class="tool-link" type="button" id="history-direct-btn">히스토리</button>
          </div>`;

        const timer = setTimeout(() => {
          location.hash = `#/page/${redirect.targetId}`;
        }, 200);

        document.getElementById("go-btn").addEventListener("click", () => {
          clearTimeout(timer);
          location.hash = `#/page/${redirect.targetId}`;
        });
        document.getElementById("stay-btn").addEventListener("click", () => clearTimeout(timer));
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
      metaBits.push(`visibility: ${getVisibility(page) === "private" ? "비공개" : "공개"}`);

      const renderPageMetaRow = (extraClass = "") => `
        <div class="meta-row${extraClass ? ` ${extraClass}` : ""}">
          <span>최종 편집: ${escapeHtml(formatDate(page.updatedAt || page.createdAt))}</span>
          ${page.updatedBy ? `<span>·</span><span>by ${escapeHtml(page.updatedBy)}</span>` : ""}
          ${metaBits.length ? `<span>·</span><span>${escapeHtml(metaBits.join(" · "))}</span>` : ""}
        </div>`;

      const pageToolsRow = `
        <div class="tools-row page-top-tools">
          <button class="tool-link" type="button" id="edit-btn">편집</button>
          <button class="tool-link" type="button" id="history-btn">히스토리</button>
          ${canEdit ? `<button class="tool-link" type="button" id="delete-btn">문서 삭제</button>` : ""}
        </div>`;

      viewEl.innerHTML = `
        <h2 class="page-title">${escapeHtml(page.title)}</h2>

        ${renderPageMetaRow()}

        ${pageToolsRow}

        <hr />

        <div class="doc">${renderWiki(body)}</div>`;

      document.getElementById("edit-btn").addEventListener("click", () => {
        if (!canEdit) return alert("편집하려면 로그인해야 해.");
        location.hash = `#/edit/${pageId}`;
      });
      document.getElementById("history-btn").addEventListener("click", () => {
        location.hash = `#/history/${pageId}`;
      });
      document.getElementById("delete-btn")?.addEventListener("click", () => deletePageCompletely(pageId));
    }


    function renderSearch(q) {
      const queryText = (q || "").trim();
      const results = queryText
        ? pages.filter(p =>
          !isRedirectPage(p) &&
          canReadPage(p) &&
          (p.title + "\n" + p.content).toLowerCase().includes(queryText.toLowerCase())
        )
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
            ? `<ul>${results.map(p => `
                  <li>
                    <a href="#/page/${escapeHtml(p.id)}">${escapeHtml(p.title)}</a>
                    <span class="muted"> · ${escapeHtml(getVisibility(p) === "private" ? "비공개" : "공개")}</span>
                  </li>
                `).join("")}</ul>`
            : `<p>결과가 없어.</p>`)
          : `<p>검색어를 입력해줘.</p>`}`;

      const input = document.getElementById("search-input");
      input.addEventListener("input", () => {
        const val = input.value.trim();
        location.hash = val ? `#/search?q=${encodeURIComponent(val)}` : "#/search";
      });
    }


    async function renderHistory(pageId) {
      const page = pages.find(p => p.id === pageId);

      if (!page || !canReadPage(page)) {
        viewEl.innerHTML = `
          <h2 class="page-title">히스토리</h2>
          <p>이 문서의 히스토리를 볼 수 없어.</p>
          <div class="tools-row">
            <button class="tool-link" type="button" onclick="location.hash='#/'">홈으로</button>
          </div>`;
        return;
      }

      const rows = await fetchRevisions(pageId);
      viewEl.innerHTML = `
        <h2 class="page-title">히스토리</h2>
        <p class="muted">
          최신 ${MAX_REVISIONS}개 보관 · ${escapeHtml(page?.title || pageId)}
          · ${escapeHtml(getVisibility(page) === "private" ? "비공개" : "공개")}
        </p>

        ${rows.length ? `
          <ul>
            ${rows.map(r => `
              <li>
                <a href="#/revision/${escapeHtml(pageId)}/${escapeHtml(r.id)}">
                  ${escapeHtml(formatDate(r.savedAt))}
                </a>
                <span class="muted">
                  · ${escapeHtml(r.savedBy || "")}
                  ${r.note ? ` · ${escapeHtml(r.note)}` : ""}
                </span>
              </li>`).join("")}
          </ul>` : `<p>아직 기록이 없어.</p>`}

        <div class="tools-row">
          <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
        </div>`;
    }


    async function renderRevision(pageId, revId) {
      const page = pages.find(p => p.id === pageId);

      if (!page || !canReadPage(page)) {
        viewEl.innerHTML = `
          <h2 class="page-title">리비전 없음</h2>
          <p>이 문서의 리비전을 볼 수 없어.</p>`;
        return;
      }

      const pageRevs = revisions[pageId]?.length ? revisions[pageId] : await fetchRevisions(pageId);
      const r = pageRevs.find(rv => rv.id === revId);

      if (!r) {
        viewEl.innerHTML = `<h2 class="page-title">리비전 없음</h2>`;
        return;
      }

      viewEl.innerHTML = `
        <h2 class="page-title">리비전</h2>
        <div class="meta-row">
          <span>${escapeHtml(formatDate(r.savedAt))}</span>
          ${r.savedBy ? `<span>·</span><span>${escapeHtml(r.savedBy)}</span>` : ""}
          ${r.note ? `<span>·</span><span>${escapeHtml(r.note)}</span>` : ""}
          ${r.visibility ? `<span>·</span><span>${escapeHtml(r.visibility === "private" ? "비공개" : "공개")}</span>` : ""}
        </div>

        <div class="doc">${renderWiki(String(r.content || ""))}</div>

        <div class="tools-row">
          <button class="tool-link" type="button" onclick="location.hash='#/history/${escapeHtml(pageId)}'">히스토리로</button>
          <button class="tool-link" type="button" onclick="location.hash='#/page/${escapeHtml(pageId)}'">문서로</button>
          ${canEdit ? `<button class="tool-link" type="button" id="revert-btn">이 버전으로 되돌리기</button>` : ""}
        </div>`;

      if (canEdit) {
        document.getElementById("revert-btn")?.addEventListener("click", async () => {
          if (!confirm("현재 문서를 이 리비전으로 되돌릴까? (되돌리기도 히스토리에 기록됨)")) return;

          const current = pages.find(p => p.id === pageId) || (await getDoc(pageDoc(pageId))).data();
          if (!current) return;

          const now = Date.now();
          await setDoc(pageDoc(pageId), {
            ...normalizePageDoc(pageId, current),
            content: String(r.content || ""),
            visibility: r.visibility === "private" ? "private" : "public",
            updatedAt: now,
            updatedBy: getActorLabel(),
            ...makeOwnerFields()
          }, { merge: true });

          await addRevision(pageId, {
            title: current.title || pageId,
            content: String(r.content || ""),
            savedBy: getActorLabel(),
            savedAt: now,
            note: `revert:${revId}`
          });

          buildList();
          location.hash = `#/page/${pageId}`;
        });
      }
    }


    async function savePage({ mode, oldId, title, content, visibility }) {
      if (!canEdit) throw new Error("로그인해야 저장할 수 있어.");

      const now = Date.now();
      const newId = toDocId(title);
      const isEdit = mode === "edit" && !!oldId;
      const prev = isEdit ? pages.find(p => p.id === oldId) : null;
      const prevCreatedAt = Number(prev?.createdAt || now);
      const prevAliases = Array.isArray(prev?.aliases) ? prev.aliases : [];
      const dest = pages.find(p => p.id === newId);
      const destExists = !!dest;
      const actor = getActorLabel();

      const finalVisibility = visibility === "private" ? "private" : "public";

      if (!isEdit && destExists) throw new Error("같은 제목(슬러그)의 문서가 이미 있어.");

      const batch = writeBatch(db);
      const queueUpsertPage = (id, data) => {
        batch.set(pageDoc(id), {
          id,
          ...data,
          ...makeOwnerFields()
        }, { merge: true });
      };

      if (isEdit && newId === oldId) {
        queueUpsertPage(oldId, {
          title,
          content,
          visibility: finalVisibility,
          updatedAt: now,
          updatedBy: actor
        });
        await batch.commit();
        await addRevision(oldId, { title, content, savedBy: actor, savedAt: now, note: "edit" });
        return oldId;
      }

      if (isEdit && oldId !== newId && destExists) {
        const destAliases = Array.isArray(dest.aliases) ? dest.aliases : [];
        await addRevision(newId, {
          title: dest.title,
          content: String(dest.content || ""),
          savedBy: actor,
          savedAt: now,
          note: `backup-before-overwrite-from:${oldId}`
        });

        const mergedAliases = Array.from(new Set([...destAliases, ...prevAliases, oldId].filter(Boolean)));
        queueUpsertPage(newId, {
          title,
          content,
          visibility: finalVisibility,
          createdAt: Math.min(Number(dest.createdAt || now), prevCreatedAt),
          updatedAt: now,
          updatedBy: actor,
          aliases: mergedAliases
        });

        const rContent = `---
redirect: true
---
#REDIRECT [[${title}]]`;
        queueUpsertPage(oldId, {
          title: prev?.title || oldId,
          content: rContent,
          visibility: prev?.visibility === "private" ? "private" : finalVisibility,
          updatedAt: now,
          updatedBy: actor,
          aliases: prevAliases
        });

        await batch.commit();
        await addRevision(newId, { title, content, savedBy: actor, savedAt: now, note: `overwrite-from:${oldId}` });
        await addRevision(oldId, {
          title: prev?.title || oldId,
          content: rContent,
          savedBy: actor,
          savedAt: now,
          note: `redirect-to:${newId}`
        });
        return newId;
      }

      const aliases = isEdit ? Array.from(new Set([...prevAliases, oldId].filter(Boolean))) : [];
      queueUpsertPage(newId, {
        title,
        content,
        visibility: finalVisibility,
        createdAt: prevCreatedAt,
        updatedAt: now,
        updatedBy: actor,
        aliases
      });

      if (isEdit && oldId && oldId !== newId) {
        const rContent = `---
redirect: true
---
#REDIRECT [[${title}]]`;
        queueUpsertPage(oldId, {
          title: prev?.title || oldId,
          content: rContent,
          visibility: prev?.visibility === "private" ? "private" : finalVisibility,
          updatedAt: now,
          updatedBy: actor,
          aliases: prevAliases
        });
      }

      await batch.commit();
      await addRevision(newId, { title, content, savedBy: actor, savedAt: now, note: isEdit ? `rename-from:${oldId}` : "new" });

      if (isEdit && oldId && oldId !== newId) {
        const rContent = `---
redirect: true
---
#REDIRECT [[${title}]]`;
        await addRevision(oldId, {
          title: prev?.title || oldId,
          content: rContent,
          savedBy: actor,
          savedAt: now,
          note: `redirect-to:${newId}`
        });
      }

      return newId;
    }


    async function deletePageCompletely(pageId) {
      if (!canEdit) return alert("삭제하려면 로그인해야 해.");
      const page = pages.find(p => p.id === pageId);
      if (!confirm(`정말 삭제할까?

- 문서: ${page?.title || pageId}
- 히스토리(리비전)도 함께 삭제됨`)) return;

      const aliasIds = Array.isArray(page?.aliases) ? page.aliases : [];
      const toRemove = Array.from(new Set([pageId, ...aliasIds]));
      const batch = writeBatch(db);

      for (const id of toRemove) {
        const revSnap = await getDocs(revisionsCol(id));
        revSnap.forEach((docSnap) => batch.delete(docSnap.ref));
        batch.delete(pageDoc(id));
        delete revisions[id];
      }

      await batch.commit();
      buildList();
      location.hash = "#/";
    }


    function renderEditor({ mode, slug }) {
      if (!canEdit) {
        viewEl.innerHTML = `
          <h2 class="page-title">편집하려면 로그인</h2>
          <div class="tools-row">
            <button class="tool-link" type="button" id="login-now">로그인</button>
            <button class="tool-link" type="button" onclick="location.hash='#/'">닫기</button>
          </div>`;
        document.getElementById("login-now").addEventListener("click", async () => {
          await login();
          route();
        });
        return;
      }

      const editing = mode === "edit" ? pages.find(p => p.id === slug) : null;
      const titleValue = editing ? editing.title : "";
      const contentValue = editing
        ? editing.content
        : `---\ncategory: ${CATEGORY_OPTIONS[0]}\ntags:\n---\n\n== 제목 ==\n내용...\n`;

      const visibilityValue = editing ? getVisibility(editing) : "public";

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

            <div class="visibility-toggle-wrap">
              <span class="visibility-toggle-label" id="visibility-label">
                ${visibilityValue === "public" ? "공개" : "비공개"}
              </span>

              <label class="visibility-switch" for="visibility-toggle">
                <input
                  type="checkbox"
                  id="visibility-toggle"
                  ${visibilityValue === "public" ? "checked" : ""}
                />
                <span class="visibility-slider"></span>
              </label>
            </div>
          </div>
        </div>`;

      const titleInput = document.getElementById("edit-title");
      const contentInput = document.getElementById("edit-content");
      const visibilityToggle = document.getElementById("visibility-toggle");
      const visibilityLabel = document.getElementById("visibility-label");


      function syncVisibilityLabel() {
        visibilityLabel.textContent = visibilityToggle.checked ? "공개" : "비공개";
      }

      syncVisibilityLabel();
      visibilityToggle.addEventListener("change", syncVisibilityLabel);

      document.getElementById("save-btn").addEventListener("click", async () => {
        const newTitle = titleInput.value.trim();
        const newContent = contentInput.value;
        const newVisibility = visibilityToggle.checked ? "public" : "private";

        if (!newTitle) return alert("제목을 입력해줘.");

        try {
          const newId = await savePage({
            mode,
            oldId: editing?.id || null,
            title: newTitle,
            content: newContent,
            visibility: newVisibility
          });
          buildList();
          location.hash = `#/page/${newId}`;
        } catch (e) {
          alert(e?.message || "저장 실패.");
        }
      });

      document.getElementById("cancel-btn").addEventListener("click", () => {
        location.hash = (mode === "edit" && editing) ? `#/page/${editing.id}` : "#/";
      });
    }

    function bindUI() {
      document.querySelectorAll(".nav-btn[data-nav]").forEach(btn => {
        btn.addEventListener("click", () => {
          const nav = btn.getAttribute("data-nav");
          if (nav === "recent") {
            location.hash = "#/recent";
            return;
          }
          if (nav === "search") {
            location.hash = "#/search";
            return;
          }
          if (nav === "new") {
            if (!canEdit) return alert("새 문서는 로그인 후에 만들 수 있어.");
            location.hash = "#/new";
          }
        });
      });

      authBtn.addEventListener("click", async () => {
        if (canEdit) await logout();
        else await login();
      });

      sideSearchInput.addEventListener("input", () => {
        sideQuery = sideSearchInput.value;
        buildList();
      });

      viewEl.addEventListener("click", (event) => {
        const trigger = event.target.closest("[data-footnote-target]");
        if (!trigger) return;

        event.preventDefault();
        scrollToFootnoteTarget(trigger.getAttribute("data-footnote-target"));
      });

      window.addEventListener("hashchange", route);
    }

    bindUI();
    buildChips();
    buildList();
    route();
    initFirebase();
