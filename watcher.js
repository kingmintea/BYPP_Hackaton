const AUTO_REFRESH_MS = 10000;

const cardGrid = document.getElementById("cardGrid");
const emptyHint = document.getElementById("emptyHint");
const aliasInput = document.getElementById("aliasInput");
const urlInput = document.getElementById("urlInput");
const keywordInput = document.getElementById("keywordInput");
const addSiteBtn = document.getElementById("addSiteBtn");
const checkAllBtn = document.getElementById("checkAllBtn");
const autoToggleBtn = document.getElementById("autoToggleBtn");
const alertBanner = document.getElementById("alertBanner");

let autoTimer = null;
let editingId = null;
let currentSites = [];

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function faviconUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return "";
  }
}

// ---- 서버 API ----

async function apiGetSites() {
  const res = await fetch("/api/sites");
  return res.json();
}

async function apiAddSite(alias, url, keywords) {
  const res = await fetch("/api/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alias, url, keywords }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "등록 실패");
  }
  return res.json();
}

async function apiDeleteSite(id) {
  await fetch(`/api/sites/${id}`, { method: "DELETE" });
}

async function apiUpdateKeywords(id, keywords) {
  await fetch(`/api/sites/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords }),
  });
}

async function apiCheckSite(id) {
  await fetch(`/api/sites/${id}/check`, { method: "POST" });
}

async function apiClearSite(id) {
  await fetch(`/api/sites/${id}/clear`, { method: "POST" });
}

async function apiGetSettings() {
  const res = await fetch("/api/settings");
  return res.json();
}

async function apiSaveSettings(dailyCheckTime) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dailyCheckTime }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "저장 실패");
  }
  return res.json();
}

// ---- 렌더링 ----

async function refreshSites() {
  currentSites = await apiGetSites();
  render();
  refreshBanner();
}

function render() {
  cardGrid.innerHTML = "";
  emptyHint.style.display = currentSites.length ? "none" : "block";

  currentSites.forEach((site) => {
    const card = document.createElement("div");
    card.className = "site-card" + (site.triggered ? " triggered" : "");
    card.dataset.id = site.id;

    const icon = faviconUrl(site.url);
    const keywords = site.keywords || [];
    const isEditing = editingId === site.id;

    card.innerHTML = `
      <div class="row-top">
        ${icon ? `<img class="favicon" src="${icon}" onerror="this.style.display='none'">` : ""}
        <span class="alias">${escapeHtml(site.alias)}</span>
      </div>
      <div class="url">${escapeHtml(site.url)}</div>
      ${
        isEditing
          ? `
        <div class="form-row">
          <input type="text" class="keyword-edit-input" value="${escapeHtml(keywords.join(", "))}" placeholder="키워드 (쉼표로 구분, 비우면 모든 새 글 감지)">
        </div>
        <div class="card-actions">
          <button class="save-keyword-btn">저장</button>
          <button class="secondary cancel-keyword-btn">취소</button>
        </div>
      `
          : `
        <div class="keywords">${keywords.length ? "키워드: " + keywords.map(escapeHtml).join(", ") : "키워드 없음 (모든 새 글 감지)"}</div>
        <div class="status">${escapeHtml(site.status || "아직 확인 전")}</div>
        <div class="card-actions">
          <button class="check-btn">지금 확인</button>
          <button class="secondary edit-keyword-btn">키워드 수정</button>
          <button class="secondary clear-btn">알림 해제</button>
          <button class="danger delete-btn">삭제</button>
        </div>
      `
      }
    `;

    if (isEditing) {
      const input = card.querySelector(".keyword-edit-input");
      card.querySelector(".save-keyword-btn").addEventListener("click", () => saveKeywords(site.id, input.value));
      card.querySelector(".cancel-keyword-btn").addEventListener("click", () => {
        editingId = null;
        render();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveKeywords(site.id, input.value);
        if (e.key === "Escape") {
          editingId = null;
          render();
        }
      });
    } else {
      card.querySelector(".check-btn").addEventListener("click", () => checkSite(site.id));
      card.querySelector(".edit-keyword-btn").addEventListener("click", () => {
        editingId = site.id;
        render();
      });
      card.querySelector(".clear-btn").addEventListener("click", () => clearTrigger(site.id));
      card.querySelector(".delete-btn").addEventListener("click", () => deleteSite(site.id));
    }

    cardGrid.appendChild(card);
  });
}

function refreshBanner() {
  const triggeredSites = currentSites.filter((s) => s.triggered);
  if (triggeredSites.length) {
    document.body.classList.add("alert-flash");
    alertBanner.classList.add("show");
    alertBanner.textContent = "🚨 새 공지 감지: " + triggeredSites.map((s) => s.alias).join(", ");
  } else {
    document.body.classList.remove("alert-flash");
    alertBanner.classList.remove("show");
    alertBanner.textContent = "";
  }
}

// ---- 액션 ----

async function addSite() {
  const alias = aliasInput.value.trim();
  const url = urlInput.value.trim();
  const keywords = keywordInput.value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!alias || !url) {
    alert("별칭과 URL을 모두 입력해주세요.");
    return;
  }

  addSiteBtn.disabled = true;
  addSiteBtn.textContent = "URL 확인 중...";
  try {
    await apiAddSite(alias, url, keywords);
  } catch (e) {
    alert(e.message);
    return;
  } finally {
    addSiteBtn.disabled = false;
    addSiteBtn.textContent = "북마크 추가";
  }

  aliasInput.value = "";
  urlInput.value = "";
  keywordInput.value = "";
  await refreshSites();
}

async function deleteSite(id) {
  await apiDeleteSite(id);
  await refreshSites();
}

async function clearTrigger(id) {
  await apiClearSite(id);
  await refreshSites();
}

async function saveKeywords(id, value) {
  const keywords = value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  await apiUpdateKeywords(id, keywords);
  editingId = null;
  await refreshSites();
}

async function checkSite(id) {
  await apiCheckSite(id);
  await refreshSites();
}

async function checkAll() {
  for (const site of currentSites) {
    await apiCheckSite(site.id);
  }
  await refreshSites();
}

function toggleAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    autoToggleBtn.textContent = "자동 새로고침 시작 (10초)";
  } else {
    autoTimer = setInterval(refreshSites, AUTO_REFRESH_MS);
    autoToggleBtn.textContent = "자동 새로고침 중지";
    refreshSites();
  }
}

addSiteBtn.addEventListener("click", addSite);
checkAllBtn.addEventListener("click", checkAll);
autoToggleBtn.addEventListener("click", toggleAuto);

refreshSites();

// ---- WebMCP: AI Agent가 이 페이지의 기능을 직접 호출할 수 있도록 도구를 노출한다.
// Chrome의 navigator.modelContext (WebMCP, Chrome 149+ 오리진 트라이얼) 지원 브라우저에서만 동작하고,
// 지원하지 않는 브라우저에서는 그냥 아무 일도 하지 않는다(기존 화면 동작에는 영향 없음).

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function registerAgentTools() {
  if (!("modelContext" in navigator)) return;

  navigator.modelContext.registerTool({
    name: "list_watched_sites",
    description:
      "현재 등록된 모든 감시 사이트 목록을 가져온다. 각 사이트의 id, 별칭, URL, 키워드, 최근 확인 상태(status), " +
      "새 글 감지 여부(triggered)를 포함한다. 다른 도구에 site_id를 넘기기 전에 먼저 이 도구로 id를 확인해야 한다.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const sites = await apiGetSites();
      return textResult(JSON.stringify(sites));
    },
  });

  navigator.modelContext.registerTool({
    name: "register_watch_site",
    description:
      "새 공지사항 페이지를 감시 목록에 등록한다. 등록하는 즉시 서버가 해당 URL에 접속해서 유효성을 검사하고, " +
      "접속이 안 되거나 게시판 구조를 인식하지 못하면 오류를 반환한다.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "사이트를 구분할 별칭" },
        url: {
          type: "string",
          description: "감시할 공지사항 목록 페이지의 전체 URL (https://로 시작) 또는 이 서버 안의 상대 경로(예: board/index.html)",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "감지할 키워드 목록. 비우면 새로 올라오는 모든 글에 반응한다.",
        },
      },
      required: ["alias", "url"],
    },
    execute: async ({ alias, url, keywords }) => {
      try {
        const site = await apiAddSite(alias, url, keywords || []);
        await refreshSites();
        return textResult(`등록 완료: ${JSON.stringify(site)}`);
      } catch (e) {
        return textResult(`등록 실패: ${e.message}`);
      }
    },
  });

  navigator.modelContext.registerTool({
    name: "update_site_keywords",
    description: "등록된 사이트의 감지 키워드를 수정한다. site_id는 list_watched_sites로 확인한다.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: { type: "string", description: "사이트 id" },
        keywords: { type: "array", items: { type: "string" }, description: "새로 설정할 키워드 목록" },
      },
      required: ["site_id", "keywords"],
    },
    execute: async ({ site_id, keywords }) => {
      await apiUpdateKeywords(site_id, keywords || []);
      await refreshSites();
      return textResult(`키워드를 ${JSON.stringify(keywords || [])}로 수정했습니다.`);
    },
  });

  navigator.modelContext.registerTool({
    name: "check_site_now",
    description: "지정한 사이트를 지금 즉시 확인해서 새 공지가 올라왔는지 검사하고, 검사 후 상태를 반환한다.",
    inputSchema: {
      type: "object",
      properties: { site_id: { type: "string", description: "사이트 id" } },
      required: ["site_id"],
    },
    execute: async ({ site_id }) => {
      await apiCheckSite(site_id);
      await refreshSites();
      const site = currentSites.find((s) => s.id === site_id);
      return textResult(site ? JSON.stringify(site) : "해당 id의 사이트를 찾을 수 없습니다.");
    },
  });

  navigator.modelContext.registerTool({
    name: "check_all_sites_now",
    description: "등록된 모든 사이트를 지금 즉시 확인해서 새 공지가 있는지 검사하고, 전체 상태를 반환한다.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      await checkAll();
      return textResult(JSON.stringify(currentSites));
    },
  });

  navigator.modelContext.registerTool({
    name: "clear_site_alert",
    description: "사이트의 '새 글 감지' 알림 상태를 해제한다 (화면의 빨간색 표시를 끈다).",
    inputSchema: {
      type: "object",
      properties: { site_id: { type: "string", description: "사이트 id" } },
      required: ["site_id"],
    },
    execute: async ({ site_id }) => {
      await apiClearSite(site_id);
      await refreshSites();
      return textResult("알림을 해제했습니다.");
    },
  });

  navigator.modelContext.registerTool({
    name: "delete_watch_site",
    description: "등록된 감시 사이트를 목록에서 삭제한다.",
    inputSchema: {
      type: "object",
      properties: { site_id: { type: "string", description: "사이트 id" } },
      required: ["site_id"],
    },
    execute: async ({ site_id }) => {
      await apiDeleteSite(site_id);
      await refreshSites();
      return textResult("삭제했습니다.");
    },
  });

  navigator.modelContext.registerTool({
    name: "get_daily_check_schedule",
    description: "서버가 매일 자동으로 모든 사이트를 확인하는 시각(HH:MM)을 가져온다.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const settings = await apiGetSettings();
      return textResult(JSON.stringify(settings));
    },
  });

  navigator.modelContext.registerTool({
    name: "set_daily_check_schedule",
    description: "서버가 매일 자동으로 모든 사이트를 확인할 시각을 설정한다. 브라우저를 꺼둬도 서버가 이 시각에 자동 확인한다.",
    inputSchema: {
      type: "object",
      properties: {
        daily_check_time: { type: "string", description: "24시간제 HH:MM 형식 시각 (예: 09:00)" },
      },
      required: ["daily_check_time"],
    },
    execute: async ({ daily_check_time }) => {
      try {
        const settings = await apiSaveSettings(daily_check_time);
        return textResult(`자동 확인 시각을 ${settings.dailyCheckTime}로 저장했습니다.`);
      } catch (e) {
        return textResult(`저장 실패: ${e.message}`);
      }
    },
  });
}

registerAgentTools();
