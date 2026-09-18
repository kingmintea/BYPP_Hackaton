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
const dailyTimeInput = document.getElementById("dailyTimeInput");
const saveTimeBtn = document.getElementById("saveTimeBtn");
const dailyTimeStatus = document.getElementById("dailyTimeStatus");

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

// ---- 자동 확인 시각 설정 ----

async function loadDailyTime() {
  const settings = await apiGetSettings();
  dailyTimeInput.value = settings.dailyCheckTime;
  dailyTimeStatus.textContent = `서버가 매일 ${settings.dailyCheckTime}에 등록된 모든 사이트를 자동으로 확인합니다 (브라우저를 꺼둬도 동작해요).`;
}

async function saveDailyTime() {
  if (!dailyTimeInput.value) {
    alert("시각을 선택해주세요.");
    return;
  }
  try {
    const settings = await apiSaveSettings(dailyTimeInput.value);
    dailyTimeStatus.textContent = `서버가 매일 ${settings.dailyCheckTime}에 등록된 모든 사이트를 자동으로 확인합니다 (브라우저를 꺼둬도 동작해요).`;
  } catch (e) {
    alert(e.message);
  }
}

addSiteBtn.addEventListener("click", addSite);
checkAllBtn.addEventListener("click", checkAll);
autoToggleBtn.addEventListener("click", toggleAuto);
saveTimeBtn.addEventListener("click", saveDailyTime);

refreshSites();
loadDailyTime();
