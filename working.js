
// ============================================================
// PULSEFLOW - working.js  |  Uses Firebase Realtime Database
// ============================================================

// ===== FIREBASE IMPORTS (CDN) =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, push, update, query as dbQuery,
  orderByChild, equalTo, limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ===== YOUR FIREBASE CONFIG =====
const firebaseConfig = {
  apiKey: "AIzaSyAaekFkDGqbPTBwDXx2MS85MXOAafhy8Mk",
  authDomain: "pulsepro-ccb82.firebaseapp.com",
  databaseURL: "https://pulsepro-ccb82-default-rtdb.firebaseio.com",
  projectId: "pulsepro-ccb82",
  storageBucket: "pulsepro-ccb82.firebasestorage.app",
  messagingSenderId: "358833693959",
  appId: "1:358833693959:web:b6e80f40ea49abd5fd51a2"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ===== GLOBAL STATE =====
let currentUser = null;
let userProfile = null;
let timerInterval = null;
let timerSeconds = 0;
let timerRunning = false;
let todayFocusSeconds = 0;
let todaySessionCount = 0;
let lastActivityTime = Date.now();
let inactivityTimer = null;
let reminderInterval = null;
let insightFilter = "daily";
let chartInstances = {};
let breakSuggested = false;
let lastEnergyLevel = null;

// ===== AUTH STATE LISTENER =====
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    // Admin bypasses onboarding and user app entirely
    if (user.email === ADMIN_EMAIL) {
      showSection("admin-section");
      initAdminApp();
      return;
    }
    const profile = await loadUserProfile(user.uid);
    // treat as complete if onboardingComplete is true OR if they have a name (old profiles)
    if (!profile || (!profile.onboardingComplete && !profile.name)) {
      // Ensure stub exists in DB so admin can see this user
      if (!profile) {
        try {
          await set(ref(db, `users/${user.uid}`), {
            email: user.email,
            name: "",
            domain: "",
            role: "",
            goals: [],
            onboardingComplete: false,
            createdAt: new Date().toISOString()
          });
        } catch(e) { console.error("Stub write error:", e); }
      }
      showSection("onboarding-section");
    } else {
      userProfile = profile;
      // backfill onboardingComplete for old profiles
      if (profile.name && !profile.onboardingComplete) {
        await update(ref(db, `users/${user.uid}`), { onboardingComplete: true });
        userProfile.onboardingComplete = true;
      }
      initApp();
    }
  } else {
    currentUser = null;
    userProfile = null;
    showSection("auth-section");
    showView("role-select-view");
  }
});

// ===== SECTION / VIEW HELPERS =====
function showSection(id) {
  ["auth-section", "onboarding-section", "app-section", "admin-section"].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("hidden", s !== id);
  });
}

window.showView = function(id) {
  ["login-view", "signup-view", "forgot-view", "role-select-view", "admin-login-view"].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle("hidden", v !== id);
  });
  ["login-error","signup-error","forgot-error","admin-login-error"].forEach(e => {
    const el = document.getElementById(e);
    if (el) el.textContent = "";
  });
};

window.showPage = function(pageId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  const page = document.getElementById(pageId);
  if (page) page.classList.add("active");
  const nav = document.querySelector(`[data-page="${pageId}"]`);
  if (nav) nav.classList.add("active");
  // Update topbar title
  const titles = { "dashboard-page": "Dashboard", "planner-page": "📅 Planner", "focus-page": "⏱️ Focus", "insights-page": "📊 Insights", "reflect-page": "📝 Reflect" };
  const titleEl = document.getElementById("topbar-title");
  if (titleEl) titleEl.textContent = titles[pageId] || "";
  if (pageId === "insights-page") setTimeout(renderCharts, 150);
  if (pageId === "reflect-page") loadReflections();
  if (pageId === "planner-page") { plannerDate = plannerDate || todayStr(); plannerUpdateLabel(); loadTasksForDate(plannerDate); }
};

// ===== AUTH FUNCTIONS =====
window.loginUser = async function() {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!email || !pass) { errEl.textContent = "Please fill in all fields."; return; }
  // Block admin from logging in via user login
  if (email === ADMIN_EMAIL) {
    errEl.textContent = "This account does not exist as a user. Please use Admin login.";
    return;
  }
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    errEl.textContent = friendlyAuthError(e.code);
  }
};

window.signupUser = async function() {
  const email = document.getElementById("signup-email").value.trim();
  const pass = document.getElementById("signup-password").value;
  const errEl = document.getElementById("signup-error");
  errEl.textContent = "";
  if (!email || !pass) { errEl.textContent = "Please fill in all fields."; return; }
  if (pass.length < 6) { errEl.textContent = "Password must be at least 6 characters."; return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    // Save stub profile immediately so admin can see all registered users
    try {
      await set(ref(db, `users/${cred.user.uid}`), {
        email,
        name: "",
        domain: "",
        role: "",
        goals: [],
        onboardingComplete: false,
        createdAt: new Date().toISOString()
      });
    } catch (dbErr) {
      console.error("Stub profile write failed:", dbErr);
      // Don't block signup — profile will be written after onboarding
    }
  } catch (e) {
    errEl.textContent = friendlyAuthError(e.code);
  }
};

window.resetPassword = async function() {
  const email = document.getElementById("forgot-email").value.trim();
  const errEl = document.getElementById("forgot-error");
  const sucEl = document.getElementById("forgot-success");
  errEl.textContent = "";
  sucEl.classList.add("hidden");
  if (!email) { errEl.textContent = "Please enter your email."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    sucEl.classList.remove("hidden");
  } catch (e) {
    errEl.textContent = friendlyAuthError(e.code);
  }
};

window.logoutUser = async function() {
  stopTimerInternal();
  clearIntervals();
  if (adminRefreshInterval) { clearInterval(adminRefreshInterval); adminRefreshInterval = null; }
  await signOut(auth);
};

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "This email is already registered.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/weak-password": "Password is too weak.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/invalid-credential": "Invalid email or password."
  };
  return map[code] || "Something went wrong. Please try again.";
}

// ===== ADMIN EMAIL =====
const ADMIN_EMAIL = "jakkasomeswaraswamy@gmail.com";

// ===== ADMIN LOGIN =====
window.loginAdmin = async function() {
  const email = document.getElementById("admin-login-email").value.trim();
  const pass = document.getElementById("admin-login-password").value;
  const errEl = document.getElementById("admin-login-error");
  errEl.textContent = "";
  if (!email || !pass) { errEl.textContent = "Please fill in all fields."; return; }
  if (email !== ADMIN_EMAIL) { errEl.textContent = "You are not authorized as admin."; return; }
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    errEl.textContent = friendlyAuthError(e.code);
  }
};

// ===== ADMIN APP INIT =====
let adminRefreshInterval = null;

async function initAdminApp() {
  const adminEmail = document.getElementById("admin-topbar-email");
  if (adminEmail) adminEmail.textContent = currentUser.email;
  showAdminPage("admin-dashboard-page");
  await loadAdminPanel();
  // Auto-refresh every 30 seconds
  if (adminRefreshInterval) clearInterval(adminRefreshInterval);
  adminRefreshInterval = setInterval(loadAdminPanel, 30000);
}

window.refreshAdminPanel = async function() {
  const btn = document.getElementById("admin-refresh-btn");
  if (btn) { btn.textContent = "⟳ Refreshing..."; btn.disabled = true; }
  await loadAdminPanel();
  if (btn) { btn.textContent = "⟳ Refresh"; btn.disabled = false; }
};

function renderRecentUsers() {
  const container = document.getElementById("admin-recent-users");
  if (!container) return;
  const recent = adminAllUsers
    .filter(u => u.createdAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  if (!recent.length) { container.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem">No users yet.</p>`; return; }
  container.innerHTML = recent.map(u => `
    <div style="display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1rem;flex-shrink:0">
        ${escHtml((u.name || "?")[0].toUpperCase())}
      </div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:0.9rem">${escHtml(u.name || "(signup only)")}</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${escHtml(u.email || "–")} · ${escHtml(u.domain || "–")} · ${escHtml(u.role || "–")}</div>
      </div>
      <div style="font-size:0.75rem;color:var(--text-muted)">${u.createdAt ? u.createdAt.split("T")[0] : "–"}</div>
      <button class="btn btn-sm btn-secondary" onclick="openUserDetail('${u.uid}')">View</button>
    </div>`).join("");
}

window.showAdminPage = function(pageId) {
  document.querySelectorAll(".admin-page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".admin-nav-item").forEach(n => n.classList.remove("active"));
  const page = document.getElementById(pageId);
  if (page) page.classList.add("active");
  const nav = document.querySelector(`[data-admin-page="${pageId}"]`);
  if (nav) nav.classList.add("active");
  const titles = {
    "admin-dashboard-page": "🛡️ Dashboard",
    "admin-users-page": "👥 Registered Users",
    "admin-trends-page": "📈 Registration Trends"
  };
  const titleEl = document.getElementById("admin-topbar-title");
  if (titleEl) titleEl.textContent = titles[pageId] || "Admin";
  if (pageId === "admin-trends-page") setTimeout(renderAdminCharts, 150);
};

// ===== ADMIN PANEL =====
let adminAllUsers = [];

async function loadAdminPanel() {
  const tbody = document.getElementById("admin-user-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px">Loading...</td></tr>`;
  try {
    const usersSnap = await get(ref(db, "users"));
    if (!usersSnap.exists()) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px">No users found.</td></tr>`;
      updateAdminDashStats([], []);
      return;
    }
    const today = todayStr();
    adminAllUsers = [];
    usersSnap.forEach(child => {
      const val = child.val();
      console.log("user entry:", child.key, val);
      adminAllUsers.push({ uid: child.key, ...val });
    });
    console.log("total adminAllUsers before fetch:", adminAllUsers.length);

    const userData = await Promise.all(adminAllUsers.map(async u => {
      const [sessions, logs, tasks, reflections] = await Promise.all([
        dbGetAll(`sessions/${u.uid}`),
        dbGetAll(`energyLogs/${u.uid}`),
        dbGetAll(`tasks/${u.uid}`),
        dbGetAll(`reflections/${u.uid}`)
      ]);
      return normalizeProfile({ ...u, sessions, logs, tasks, reflections });
    }));
    adminAllUsers = userData;

    try { renderAdminTable(adminAllUsers, today); } catch(e) { console.error("renderAdminTable error:", e); }
    try { updateAdminDashStats(adminAllUsers, today); } catch(e) { console.error("updateAdminDashStats error:", e); }
    try { renderAdminNotifications(adminAllUsers, today); } catch(e) { console.error("renderAdminNotifications error:", e); }
    try { renderRecentUsers(); } catch(e) { console.error("renderRecentUsers error:", e); }
  } catch (e) {
    console.error("Admin panel error:", e);
  }
}

function updateAdminDashStats(users, today) {
  today = today || todayStr();
  let activeToday = 0, highRisk = 0, totalFocus = 0;
  users.forEach(u => {
    const { sessions = [], logs = [] } = u;
    const ts = sessions.filter(s => s.date === today);
    const focusH = ts.reduce((s, x) => s + (x.duration || 0), 0) / 3600;
    totalFocus += focusH;
    if (ts.length > 0 || logs.filter(l => l.date === today).length > 0 || u.lastSeen === today) activeToday++;
    const todayLogs = logs.filter(l => l.date === today);
    const lowRatio = todayLogs.length > 0 ? todayLogs.filter(l => l.energyLevel === "Low").length / todayLogs.length : 0;
    let score = 0;
    if (focusH > 8) score += 3; else if (focusH > 6) score += 2; else if (focusH > 4) score += 1;
    if (lowRatio > 0.6) score += 2;
    if (ts.length > 6) score += 1;
    if (score > 3) highRisk++;
  });
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("admin-stat-users", users.length);
  set("admin-stat-active", activeToday);
  set("admin-stat-burnout", highRisk);
  set("admin-stat-focus", totalFocus.toFixed(1) + "h");

  // Recent signups (last 7 days)
  const recent = users.filter(u => {
    if (!u.createdAt) return false;
    const d = new Date(u.createdAt);
    const diff = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= 7;
  });
  set("admin-stat-new", recent.length);
}

function renderAdminNotifications(users, today) {
  const container = document.getElementById("admin-notifications");
  if (!container) return;
  const notes = [];

  users.forEach(u => {
    const { sessions = [], logs = [] } = u;
    const ts = sessions.filter(s => s.date === today);
    const focusH = ts.reduce((s, x) => s + (x.duration || 0), 0) / 3600;
    const todayLogs = logs.filter(l => l.date === today);
    const lowRatio = todayLogs.length > 0 ? todayLogs.filter(l => l.energyLevel === "Low").length / todayLogs.length : 0;
    let score = 0;
    if (focusH > 8) score += 3; else if (focusH > 6) score += 2; else if (focusH > 4) score += 1;
    if (lowRatio > 0.6) score += 2;
    if (ts.length > 6) score += 1;
    if (score > 3) notes.push({ type: "danger", msg: `🔴 ${escHtml(u.name || u.email)} is at high burnout risk today.` });
    else if (score > 1) notes.push({ type: "warning", msg: `🟡 ${escHtml(u.name || u.email)} shows warning signs of burnout.` });

    // New signup in last 24h
    if (u.createdAt) {
      const diff = (Date.now() - new Date(u.createdAt).getTime()) / (1000 * 60 * 60);
      if (diff <= 24) notes.push({ type: "success", msg: `🆕 ${escHtml(u.name || u.email)} just joined PulseFlow.` });
    }
  });

  if (notes.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem">No alerts right now. All users look good.</p>`;
    return;
  }
  container.innerHTML = notes.map(n => `
    <div class="admin-notif ${n.type}">${n.msg}</div>
  `).join("");
}

function normalizeProfile(u) {
  // Handle old profiles: goal (string) → goals (array), missing email/onboardingComplete
  const goals = u.goals
    ? (Array.isArray(u.goals) ? u.goals : [u.goals])
    : (u.goal ? [u.goal] : []);
  const onboardingComplete = u.onboardingComplete !== undefined
    ? u.onboardingComplete
    : !!(u.name); // old profiles with name are considered complete
  return { ...u, goals, onboardingComplete };
}

function renderAdminTable(users, today) {
  today = today || todayStr();
  const rows = [];
  for (const u of users) {
    const { sessions = [], logs = [], tasks = [], reflections = [] } = u;
    const todaySessions = sessions.filter(s => s.date === today);
    const focusH = +(todaySessions.reduce((s, x) => s + (x.duration || 0), 0) / 3600).toFixed(1);
    const totalFocusAllTime = +(sessions.reduce((s, x) => s + (x.duration || 0), 0) / 3600).toFixed(1);
    const todayLogs = logs.filter(l => l.date === today);
    const doneTasks = tasks.filter(t => t.date === today && t.completed).length;
    const totalDoneTasks = tasks.filter(t => t.completed).length;
    const lowRatio = todayLogs.length > 0 ? todayLogs.filter(l => l.energyLevel === "Low").length / todayLogs.length : 0;
    let score = 0;
    if (focusH > 8) score += 3; else if (focusH > 6) score += 2; else if (focusH > 4) score += 1;
    if (lowRatio > 0.6) score += 2;
    if (todaySessions.length > 6) score += 1;
    const burnoutState = score <= 1 ? "healthy" : score <= 3 ? "warning" : "high-risk";
    const joined = u.createdAt ? u.createdAt.split("T")[0] : "–";
    const statusBadge = u.onboardingComplete
      ? `<span style="font-size:0.72rem;background:#f0fdf4;color:#16a34a;padding:2px 8px;border-radius:10px;font-weight:600">✅ Active</span>`
      : `<span style="font-size:0.72rem;background:#fffbeb;color:#d97706;padding:2px 8px;border-radius:10px;font-weight:600">⏳ Signup only</span>`;
    rows.push(`<tr style="cursor:pointer" onclick="openUserDetail('${u.uid}')">
      <td><strong>${escHtml(u.name || "–")}</strong> ${statusBadge}</td>
      <td style="font-size:0.8rem">${escHtml(u.email || "–")}</td>
      <td>${escHtml(u.domain || "–")}</td>
      <td>${escHtml(u.role || "–")}</td>
      <td>${joined}</td>
      <td>${focusH}h <span style="color:var(--text-muted);font-size:0.75rem">(${totalFocusAllTime}h total)</span></td>
      <td>${todaySessions.length} <span style="color:var(--text-muted);font-size:0.75rem">(${sessions.length} total)</span></td>
      <td>${doneTasks} <span style="color:var(--text-muted);font-size:0.75rem">(${totalDoneTasks} total)</span></td>
      <td>${reflections.length}</td>
      <td><span class="burnout-pill ${burnoutState}">${burnoutState === "healthy" ? "🟢 Healthy" : burnoutState === "warning" ? "🟡 Warning" : "🔴 High Risk"}</span></td>
      <td><button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();openUserDetail('${u.uid}')">View</button></td>
    </tr>`);
  }
  const tbody = document.getElementById("admin-user-tbody");
  if (tbody) tbody.innerHTML = rows.join("") || `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px">No users found.</td></tr>`;
}

window.adminSearch = function() {
  const q = (document.getElementById("admin-search-input").value || "").toLowerCase();
  const filtered = q ? adminAllUsers.filter(u =>
    (u.name || "").toLowerCase().includes(q) ||
    (u.email || "").toLowerCase().includes(q) ||
    (u.domain || "").toLowerCase().includes(q) ||
    (u.role || "").toLowerCase().includes(q)
  ) : adminAllUsers;
  renderAdminTable(filtered);
};

// ===== ADMIN CHARTS =====
async function renderAdminCharts() {
  if (!adminAllUsers.length) await loadAdminPanel();
  if (!adminAllUsers.length) return;
  // Signups per day (last 14 days)
  const labels = [], signupData = [], activeData = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    signupData.push(adminAllUsers.filter(u => u.createdAt && u.createdAt.startsWith(dateStr)).length);
    activeData.push(adminAllUsers.filter(u =>
      (u.sessions || []).some(s => s.date === dateStr) ||
      (u.logs || []).some(l => l.date === dateStr)
    ).length);
  }
  makeChart("chart-admin-signups", "bar", labels, signupData, "New Signups", "#4f8ef7");
  makeChart("chart-admin-active", "line", labels, activeData, "Active Users", "#6ee7b7");

  // Domain distribution
  const domainCount = {};
  adminAllUsers.forEach(u => { const d = u.domain || "Other"; domainCount[d] = (domainCount[d] || 0) + 1; });
  const domainLabels = Object.keys(domainCount);
  const domainData = Object.values(domainCount);
  const colors = ["#4f8ef7","#6ee7b7","#f59e42","#ef4444","#a78bfa","#34d399","#fb923c","#60a5fa"];
  const canvas = document.getElementById("chart-admin-domains");
  if (canvas) {
    if (chartInstances["chart-admin-domains"]) chartInstances["chart-admin-domains"].destroy();
    chartInstances["chart-admin-domains"] = new Chart(canvas, {
      type: "doughnut",
      data: { labels: domainLabels, datasets: [{ data: domainData, backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
    });
  }
}

// ===== USER DETAIL MODAL =====
window.openUserDetail = function(uid) {
  const u = adminAllUsers.find(x => x.uid === uid);
  if (!u) return;
  const { sessions = [], logs = [], tasks = [], reflections = [] } = u;
  const today = todayStr();
  const goalList = Array.isArray(u.goals) ? u.goals : (u.goals ? [u.goals] : []);
  const joined = u.createdAt ? u.createdAt.split("T")[0] : "–";

  const sessionsByDate = {};
  sessions.forEach(s => {
    if (!sessionsByDate[s.date]) sessionsByDate[s.date] = 0;
    sessionsByDate[s.date] += s.duration || 0;
  });
  const historyRows = Object.entries(sessionsByDate)
    .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)
    .map(([date, secs]) => {
      const h = +(secs / 3600).toFixed(1);
      const dayTasks = tasks.filter(t => t.date === date && t.completed).length;
      const dayLogs = logs.filter(l => l.date === date);
      const lastEnergy = dayLogs.length > 0 ? dayLogs[dayLogs.length - 1].energyLevel : "–";
      return `<tr><td>${date}</td><td>${h}h</td><td>${dayTasks}</td><td>${lastEnergy}</td></tr>`;
    }).join("") || `<tr><td colspan="4" style="color:var(--text-muted);text-align:center">No activity yet</td></tr>`;

  const reflectionRows = reflections.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5)
    .map(r => `<div style="border-bottom:1px solid var(--border);padding:10px 0">
      <p style="font-size:0.75rem;color:var(--text-muted)">${r.date}</p>
      <p style="font-size:0.85rem;margin-top:4px"><strong>Drained:</strong> ${escHtml(r.drained)}</p>
      <p style="font-size:0.85rem;margin-top:2px"><strong>Energized:</strong> ${escHtml(r.energized)}</p>
    </div>`).join("") || `<p style="color:var(--text-muted);font-size:0.85rem">No reflections yet.</p>`;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };
  set("udm-name", escHtml(u.name || "–"));
  set("udm-email", escHtml(u.email || "–"));
  set("udm-domain", escHtml(u.domain || "–"));
  set("udm-role", escHtml(u.role || "–"));
  set("udm-joined", joined);
  set("udm-goals", goalList.map(g => `<span class="badge">${escHtml(g)}</span>`).join(" ") || "–");
  set("udm-total-focus", +(sessions.reduce((s, x) => s + (x.duration || 0), 0) / 3600).toFixed(1) + "h");
  set("udm-total-sessions", sessions.length);
  set("udm-total-tasks", tasks.filter(t => t.completed).length);
  set("udm-total-reflections", reflections.length);
  set("udm-history-tbody", historyRows);
  set("udm-reflections", reflectionRows);
  document.getElementById("user-detail-modal").classList.remove("hidden");
};

window.closeUserDetail = function() {
  document.getElementById("user-detail-modal").classList.add("hidden");
};

// ===== ONBOARDING =====
window.saveOnboarding = async function() {
  const name = document.getElementById("ob-name").value.trim();
  const domain = document.getElementById("ob-domain").value;
  const role = document.getElementById("ob-role").value;
  const goalEls = document.querySelectorAll('input[name="ob-goal"]:checked');
  const errEl = document.getElementById("ob-error");
  errEl.textContent = "";
  if (!name || !domain || !role || goalEls.length === 0) {
    errEl.textContent = "Please fill in all fields and select at least one goal.";
    return;
  }
  const goals = Array.from(goalEls).map(el => el.value);
  try {
    // Preserve original createdAt from stub if it exists
    const existing = await loadUserProfile(currentUser.uid);
    const createdAt = (existing && existing.createdAt) ? existing.createdAt : new Date().toISOString();
    const profile = { name, domain, role, goals, email: currentUser.email, createdAt, onboardingComplete: true };
    await set(ref(db, `users/${currentUser.uid}`), profile);
    userProfile = profile;
    initApp();
  } catch (e) {
    errEl.textContent = "Failed to save. Please try again.";
    console.error(e);
  }
};

async function loadUserProfile(uid) {
  try {
    const snap = await get(ref(db, `users/${uid}`));
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    console.error("Profile load error:", e);
    return null;
  }
}

// ===== INIT APP =====
async function initApp() {
  showSection("app-section");
  renderProfile();
  updateGreeting();

  // Mark user as active today
  if (currentUser) {
    await update(ref(db, `users/${currentUser.uid}`), { lastSeen: todayStr() });
  }

  // Show admin nav only for admin
  const isAdmin = currentUser && currentUser.email === ADMIN_EMAIL;
  document.querySelectorAll(".admin-nav").forEach(el => el.classList.toggle("hidden", !isAdmin));

  await loadTodayStats();
  loadTasks();
  startActivityDetection();
  startReminderCheck();
  requestNotificationPermission();
  updateBurnoutIndicator();

  if (isAdmin) loadAdminPanel();
}

function renderProfile() {
  if (!userProfile) return;
  const { name, domain, role, goals } = userProfile;
  const initial = name ? name[0].toUpperCase() : "?";

  // Topbar avatar
  const topbarAvatar = document.getElementById("topbar-avatar");
  if (topbarAvatar) {
    if (userProfile.photoURL) {
      topbarAvatar.innerHTML = `<img src="${userProfile.photoURL}" alt="${name}" />`;
    } else {
      topbarAvatar.textContent = initial;
    }
  }

  // Sidebar
  const sidebarAvatar = document.getElementById("sidebar-avatar");
  if (sidebarAvatar) {
    if (userProfile.photoURL) {
      sidebarAvatar.innerHTML = `<img src="${userProfile.photoURL}" alt="${name}" />`;
    } else {
      sidebarAvatar.textContent = initial;
    }
  }
  const sidebarName = document.getElementById("sidebar-name");
  if (sidebarName) sidebarName.textContent = name;
  const sidebarRole = document.getElementById("sidebar-role");
  if (sidebarRole) sidebarRole.textContent = role;

  // Dropdown
  const ddInitials = document.getElementById("dropdown-initials");
  const ddPic = document.getElementById("dropdown-pic");
  if (userProfile.photoURL) {
    if (ddPic) { ddPic.src = userProfile.photoURL; ddPic.style.display = "block"; }
    if (ddInitials) ddInitials.style.display = "none";
  } else {
    if (ddInitials) { ddInitials.textContent = initial; ddInitials.style.display = "flex"; }
    if (ddPic) ddPic.style.display = "none";
  }
  const ddName = document.getElementById("dropdown-name");
  if (ddName) ddName.textContent = name;
  const ddEmail = document.getElementById("dropdown-email");
  if (ddEmail) ddEmail.textContent = currentUser ? currentUser.email : "";
  const ddDomain = document.getElementById("dropdown-domain");
  if (ddDomain) ddDomain.textContent = domain;
  const ddRole = document.getElementById("dropdown-role");
  if (ddRole) ddRole.textContent = role;
  const ddGoals = document.getElementById("dropdown-goals");
  if (ddGoals) {
    const goalList = Array.isArray(goals) ? goals : (goals ? [goals] : []);
    ddGoals.innerHTML = goalList.map(g => `<span class="badge" style="margin-bottom:4px;display:inline-block">${g}</span>`).join(" ");
  }
}

function updateGreeting() {
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning \u2600\ufe0f" : h < 17 ? "Good afternoon \ud83c\udf24\ufe0f" : "Good evening \ud83c\udf19";
  document.getElementById("dash-greeting").textContent = userProfile ? `${greet}, ${userProfile.name}` : greet;
  document.getElementById("dash-date").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
}

// ===== REALTIME DB HELPERS =====
// Push a record under a path and return the key
async function dbPush(path, data) {
  const newRef = push(ref(db, path));
  await set(newRef, { ...data, _key: newRef.key });
  return newRef.key;
}

// Get all children of a path as an array
async function dbGetAll(path) {
  const snap = await get(ref(db, path));
  if (!snap.exists()) return [];
  const result = [];
  snap.forEach(child => result.push({ id: child.key, ...child.val() }));
  return result;
}

// ===== LOAD TODAY STATS =====
async function loadTodayStats() {
  if (!currentUser) return;
  const today = todayStr();
  const uid = currentUser.uid;

  // Sessions
  const sessions = await dbGetAll(`sessions/${uid}`);
  const todaySessions = sessions.filter(s => s.date === today);
  todayFocusSeconds = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  todaySessionCount = todaySessions.length;
  updateTimerStats();

  // Last energy
  const logs = await dbGetAll(`energyLogs/${uid}`);
  const todayLogs = logs.filter(l => l.date === today).sort((a, b) => b.timestamp - a.timestamp);
  if (todayLogs.length > 0) {
    lastEnergyLevel = todayLogs[0].energyLevel;
    document.getElementById("stat-energy").textContent = lastEnergyLevel;
    showSuggestions(lastEnergyLevel);
  }
}

// ===== PLANNER DATE STATE =====
let plannerDate = todayStr();

function plannerUpdateLabel() {
  const d = new Date(plannerDate + "T00:00:00");
  const today = todayStr();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split("T")[0];
  let label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (plannerDate === today) label += " (Today)";
  else if (plannerDate === yStr) label += " (Yesterday)";
  const el = document.getElementById("planner-date-label");
  if (el) el.textContent = label;
  const inp = document.getElementById("planner-date-input");
  if (inp) inp.value = plannerDate;
  // Hide add forms for past dates
  const isPast = plannerDate < today;
  ["morning","afternoon","evening"].forEach(p => {
    const f = document.getElementById(`add-form-${p}`);
    if (f) f.style.display = isPast ? "none" : "";
  });
}

window.plannerChangeDate = function(delta) {
  const d = new Date(plannerDate + "T00:00:00");
  d.setDate(d.getDate() + delta);
  plannerDate = d.toISOString().split("T")[0];
  plannerUpdateLabel();
  loadTasksForDate(plannerDate);
};

window.plannerGoToDate = function(val) {
  if (!val) return;
  plannerDate = val;
  plannerUpdateLabel();
  loadTasksForDate(plannerDate);
};

window.plannerGoToToday = function() {
  plannerDate = todayStr();
  plannerUpdateLabel();
  loadTasksForDate(plannerDate);
};

// ===== TASK MANAGEMENT =====
async function loadTasks() {
  plannerDate = todayStr();
  plannerUpdateLabel();
  await loadTasksForDate(plannerDate);
}

async function loadTasksForDate(dateStr) {
  const uid = currentUser.uid;
  const tasks = await dbGetAll(`tasks/${uid}`);
  const dateTasks = tasks.filter(t => t.date === dateStr);
  renderTasks(dateTasks);
  if (dateStr === todayStr()) updateTaskStat(dateTasks);
}

function renderTasks(tasks) {
  ["morning", "afternoon", "evening"].forEach(period => {
    const list = document.getElementById(`tasks-${period}`);
    if (!list) return;
    list.innerHTML = "";
    tasks.filter(t => t.period === period).forEach(task => list.appendChild(createTaskEl(task)));
  });
}

function createTaskEl(task) {
  const li = document.createElement("li");
  li.className = `task-item${task.completed ? " done" : ""}`;
  li.dataset.id = task.id;
  li.innerHTML = `
    <input type="checkbox" ${task.completed ? "checked" : ""} onchange="toggleTask('${task.id}', this.checked)" />
    <span class="task-name">${escHtml(task.title)}</span>
    <div class="task-meta">
      <span>${task.scheduledTime || ""}</span>
      <span class="energy-tag ${(task.energyLevel||"medium").toLowerCase()}">${task.energyLevel}</span>
    </div>
  `;
  return li;
}

window.addTask = async function(period) {
  const nameEl = document.getElementById(`task-name-${period}`);
  const timeEl = document.getElementById(`task-time-${period}`);
  const energyEl = document.getElementById(`task-energy-${period}`);
  const title = nameEl.value.trim();
  if (!title) { showToast("Task name required", "", "warning"); return; }
  const task = {
    userId: currentUser.uid,
    title,
    scheduledTime: timeEl.value || "",
    energyLevel: energyEl.value,
    period,
    completed: false,
    date: plannerDate,
    timestamp: Date.now()
  };
  try {
    const key = await dbPush(`tasks/${currentUser.uid}`, task);
    task.id = key;
    document.getElementById(`tasks-${period}`).appendChild(createTaskEl(task));
    nameEl.value = ""; timeEl.value = "";
    showToast("Task added", task.title, "success");
    updateTaskStat();
  } catch (e) {
    showToast("Error adding task", e.message, "danger");
  }
};

window.toggleTask = async function(taskId, completed) {
  try {
    if (!currentUser) return;
    const taskRef = ref(db, `tasks/${currentUser.uid}/${taskId}`);
    await update(taskRef, { completed });
    const li = document.querySelector(`li[data-id="${taskId}"]`);
    if (li) {
      li.classList.toggle("done", completed);
      const cb = li.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = completed;
    }
    updateTaskStat();
  } catch (e) {
    console.error("Toggle task error:", e);
    showToast("Error", "Could not update task.", "danger");
  }
};

async function updateTaskStat(tasks) {
  if (!tasks) {
    const all = await dbGetAll(`tasks/${currentUser.uid}`);
    tasks = all.filter(t => t.date === todayStr());
  }
  const done = tasks.filter(t => t.completed).length;
  const el = document.getElementById("stat-tasks");
  if (el) el.textContent = done;
}

// ===== FOCUS TIMER =====
window.startTimer = function() {
  if (timerRunning) return;
  timerRunning = true;
  breakSuggested = false;
  document.getElementById("timer-start-btn").classList.add("hidden");
  document.getElementById("timer-stop-btn").classList.remove("hidden");
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
    if (timerSeconds === 3600 && !breakSuggested) {
      breakSuggested = true;
      showBreakSuggestion();
    }
  }, 1000);
};

window.stopTimer = async function() {
  if (!timerRunning) return;
  const duration = timerSeconds;
  stopTimerInternal();
  if (duration > 0) await saveSession(duration);
};

function stopTimerInternal() {
  timerRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
  timerSeconds = 0;
  updateTimerDisplay();
  const startBtn = document.getElementById("timer-start-btn");
  const stopBtn = document.getElementById("timer-stop-btn");
  if (startBtn) startBtn.classList.remove("hidden");
  if (stopBtn) stopBtn.classList.add("hidden");
}

function updateTimerDisplay() {
  const h = Math.floor(timerSeconds / 3600);
  const m = Math.floor((timerSeconds % 3600) / 60);
  const s = timerSeconds % 60;
  const el = document.getElementById("timer-display");
  if (el) el.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function updateTimerStats() {
  const totalMins = Math.floor(todayFocusSeconds / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const displayStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const focusEl = document.getElementById("timer-total-today");
  if (focusEl) focusEl.textContent = displayStr;
  const sessEl = document.getElementById("timer-sessions-today");
  if (sessEl) sessEl.textContent = todaySessionCount;
  const statFocus = document.getElementById("stat-focus");
  if (statFocus) statFocus.textContent = h > 0 ? `${h}h` : `${m}m`;
  const statSess = document.getElementById("stat-sessions");
  if (statSess) statSess.textContent = todaySessionCount;
  checkBoundaryGuard();
}

async function saveSession(duration) {
  try {
    await dbPush(`sessions/${currentUser.uid}`, {
      userId: currentUser.uid,
      duration,
      date: todayStr(),
      timestamp: Date.now()
    });
    todayFocusSeconds += duration;
    todaySessionCount++;
    updateTimerStats();
    updateBurnoutIndicator();
    showToast("Session saved", `${Math.floor(duration/60)} min logged`, "success");
  } catch (e) {
    console.error("Save session error:", e);
  }
}

function showBreakSuggestion() {
  const el = document.getElementById("break-banner");
  if (el) el.classList.remove("hidden");
  const breakEl = document.getElementById("break-suggestions");
  if (breakEl) {
    breakEl.innerHTML = `
      <div class="suggestion-card">
        <strong>\ud83e\uddd8 Time for a break!</strong><br><br>
        \ud83e\uddd8 <strong>Stretch</strong> – Stand up and stretch for 2 minutes<br>
        \ud83d\udc41\ufe0f <strong>Eye rest (20-20-20)</strong> – Look 20ft away for 20 seconds<br>
        \ud83d\udeb6 <strong>Short walk</strong> – Step outside for 5 minutes
      </div>`;
  }
  showToast("Break time!", "60+ minutes of work. Take a short break.", "warning");
}

window.dismissBreak = function() {
  const el = document.getElementById("break-banner");
  if (el) el.classList.add("hidden");
};

// ===== ENERGY CHECK-IN =====
window.logEnergy = async function(level) {
  document.querySelectorAll(".energy-btn").forEach(b => {
    b.classList.toggle("selected", b.textContent.includes(level));
  });
  lastEnergyLevel = level;
  document.getElementById("stat-energy").textContent = level;
  showSuggestions(level);
  try {
    await dbPush(`energyLogs/${currentUser.uid}`, {
      userId: currentUser.uid,
      energyLevel: level,
      date: todayStr(),
      timestamp: Date.now()
    });
    showToast("Energy logged", `Feeling ${level.toLowerCase()} energy`, "success");
    updateBurnoutIndicator();
  } catch (e) {
    console.error("Log energy error:", e);
  }
};

// ===== SMART SUGGESTIONS =====
function showSuggestions(level) {
  const container = document.getElementById("suggestions-container");
  if (!container) return;
  const map = {
    Low: {
      msg: "Your energy is low. Stick to lighter tasks and be kind to yourself.",
      tasks: ["\ud83d\udcac Reply to emails", "\ud83d\udcdd Review notes", "\ud83d\udcc1 Organize files", "\ud83d\udcca Update reports", "\ud83d\udcda Light reading"]
    },
    Medium: {
      msg: "Good energy! A solid time for regular work.",
      tasks: ["\ud83d\udcbb Regular dev tasks", "\ud83e\udd1d Attend meetings", "\ud83d\udcdd Write content", "\ud83d\udd0d Code reviews", "\ud83d\udcca Data analysis"]
    },
    High: {
      msg: "You're in the zone! Use this time for your hardest tasks.",
      tasks: ["\ud83d\ude80 Tackle your hardest problem", "\ud83e\udde0 Deep work / architecture", "\u270d\ufe0f Write that difficult proposal", "\ud83d\udd27 Build new features", "\ud83c\udfaf Focus on top priority"]
    }
  };
  const { msg, tasks } = map[level] || map.Medium;
  container.innerHTML = `<div class="suggestion-card">${msg}</div>${tasks.map(t => `<div class="suggestion-card">${t}</div>`).join("")}`;
}

// ===== BURNOUT INDICATOR =====
async function updateBurnoutIndicator() {
  if (!currentUser) return;
  try {
    const today = todayStr();
    const logs = await dbGetAll(`energyLogs/${currentUser.uid}`);
    const todayLogs = logs.filter(l => l.date === today);
    const focusHours = todayFocusSeconds / 3600;
    const lowCount = todayLogs.filter(l => l.energyLevel === "Low").length;
    const total = todayLogs.length;

    let score = 0;
    if (focusHours > 8) score += 3;
    else if (focusHours > 6) score += 2;
    else if (focusHours > 4) score += 1;
    if (total > 0 && lowCount / total > 0.6) score += 2;
    if (todaySessionCount > 6) score += 1;

    const states = {
      healthy: { label: "\ud83d\udfe2 Healthy", detail: "Keep it up! You're maintaining a healthy work rhythm.", cls: "healthy" },
      warning: { label: "\ud83d\udfe1 Warning", detail: "Watch your pace. Consider taking breaks.", cls: "warning" },
      "high-risk": { label: "\ud83d\udd34 High Risk", detail: "Signs of burnout detected. Please rest and take breaks.", cls: "high-risk" }
    };
    const state = score <= 1 ? "healthy" : score <= 3 ? "warning" : "high-risk";
    const { label, detail, cls } = states[state];

    const ind = document.getElementById("burnout-indicator");
    if (ind) ind.className = `burnout-indicator ${cls}`;
    const lbl = document.getElementById("burnout-label");
    if (lbl) lbl.textContent = label;
    const det = document.getElementById("burnout-detail");
    if (det) det.textContent = detail;
  } catch (e) {
    console.error("Burnout error:", e);
  }
}

function checkBoundaryGuard() {
  const hours = todayFocusSeconds / 3600;
  const card = document.getElementById("boundary-guard-card");
  if (card && hours >= 8) {
    card.classList.remove("hidden");
    showToast("Boundary Alert", "You've worked 8+ hours today. Consider logging off.", "danger");
  }
}

// ===== ACTIVITY DETECTION =====
function startActivityDetection() {
  const reset = () => { lastActivityTime = Date.now(); };
  document.addEventListener("mousemove", reset);
  document.addEventListener("keydown", reset);
  document.addEventListener("click", reset);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reset(); });
  inactivityTimer = setInterval(() => {
    const mins = (Date.now() - lastActivityTime) / 60000;
    if (mins >= 5) {
      const modal = document.getElementById("inactive-modal");
      if (modal && modal.classList.contains("hidden")) modal.classList.remove("hidden");
    }
  }, 60000);
}

window.dismissInactive = function() {
  const modal = document.getElementById("inactive-modal");
  if (modal) modal.classList.add("hidden");
  lastActivityTime = Date.now();
};

// ===== SMART REMINDERS =====
function startReminderCheck() {
  reminderInterval = setInterval(checkUpcomingTasks, 5 * 60 * 1000);
  setTimeout(checkUpcomingTasks, 4000);
}

async function checkUpcomingTasks() {
  if (!currentUser) return;
  try {
    const today = todayStr();
    const tasks = await dbGetAll(`tasks/${currentUser.uid}`);
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    tasks.filter(t => t.date === today && !t.completed && t.scheduledTime).forEach(task => {
      const [th, tm] = task.scheduledTime.split(":").map(Number);
      const diff = (th * 60 + tm) - nowMins;
      if (diff > 0 && diff <= 30) {
        showToast(`Upcoming task in ${diff} min`, task.title, "warning");
        sendBrowserNotification(`Upcoming task in ${diff} minutes`, task.title);
      }
    });
  } catch (e) {
    console.error("Reminder error:", e);
  }
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendBrowserNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// ===== WEEKLY REFLECTION =====
window.saveReflection = async function() {
  const drained = document.getElementById("reflect-drained").value.trim();
  const energized = document.getElementById("reflect-energized").value.trim();
  const errEl = document.getElementById("reflect-error");
  errEl.textContent = "";
  if (!drained || !energized) { errEl.textContent = "Please fill in both fields."; return; }
  try {
    await dbPush(`reflections/${currentUser.uid}`, {
      userId: currentUser.uid,
      drained,
      energized,
      date: todayStr(),
      timestamp: Date.now()
    });
    document.getElementById("reflect-drained").value = "";
    document.getElementById("reflect-energized").value = "";
    showToast("Reflection saved", "Great job checking in with yourself.", "success");
    loadReflections();
  } catch (e) {
    errEl.textContent = "Failed to save. Please try again.";
  }
};

async function loadReflections() {
  if (!currentUser) return;
  try {
    const all = await dbGetAll(`reflections/${currentUser.uid}`);
    const sorted = all.sort((a, b) => b.timestamp - a.timestamp);
    const container = document.getElementById("past-reflections");
    if (!container) return;
    if (sorted.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem">No reflections yet.</p>';
      return;
    }
    container.innerHTML = sorted.map(r => `
      <div style="border-bottom:1px solid var(--border);padding:12px 0">
        <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px">${r.date}</p>
        <p style="font-size:0.88rem;margin-bottom:4px"><strong>Drained by:</strong> ${escHtml(r.drained)}</p>
        <p style="font-size:0.88rem"><strong>Energized by:</strong> ${escHtml(r.energized)}</p>
      </div>`).join("");
  } catch (e) {
    console.error("Load reflections error:", e);
  }
}

// ===== INSIGHTS / CHARTS =====
window.setInsightFilter = function(filter, btn) {
  insightFilter = filter;
  document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderCharts();
};

async function renderCharts() {
  if (!currentUser) return;
  try {
    const days = insightFilter === "daily" ? 7 : insightFilter === "weekly" ? 28 : 90;
    const labels = [], energyData = [], tasksData = [], burnoutData = [], focusData = [];

    const allTasks = await dbGetAll(`tasks/${currentUser.uid}`);
    const allLogs = await dbGetAll(`energyLogs/${currentUser.uid}`);
    const allSessions = await dbGetAll(`sessions/${currentUser.uid}`);

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));

      const dayLogs = allLogs.filter(l => l.date === dateStr);
      const energySum = dayLogs.reduce((s, l) => s + (l.energyLevel === "High" ? 3 : l.energyLevel === "Medium" ? 2 : 1), 0);
      energyData.push(dayLogs.length > 0 ? +(energySum / dayLogs.length).toFixed(1) : 0);

      tasksData.push(allTasks.filter(t => t.date === dateStr && t.completed).length);

      const daySessions = allSessions.filter(s => s.date === dateStr);
      const focusSecs = daySessions.reduce((s, sess) => s + (sess.duration || 0), 0);
      // Use minutes for chart so short sessions show up
      focusData.push(+(focusSecs / 60).toFixed(1));

      const focusMins = focusSecs / 60;
      const lowRatio = dayLogs.length > 0 ? dayLogs.filter(l => l.energyLevel === "Low").length / dayLogs.length : 0;
      // Burnout: based on focus mins + low energy ratio + session count
      let bScore = 0;
      if (focusMins > 480) bScore += 3; else if (focusMins > 360) bScore += 2; else if (focusMins > 240) bScore += 1;
      if (lowRatio > 0.6) bScore += 3; else if (lowRatio > 0.3) bScore += 1;
      if (daySessions.length > 6) bScore += 1;
      burnoutData.push(+Math.min(10, bScore).toFixed(1));
    }

    makeChart("chart-energy", "line", labels, energyData, "Energy", "#4f8ef7");
    makeChart("chart-tasks", "bar", labels, tasksData, "Tasks Done", "#6ee7b7");
    makeChart("chart-burnout", "line", labels, burnoutData, "Burnout Score", "#ef4444");
    makeChart("chart-focus", "bar", labels, focusData, "Focus (mins)", "#f59e42");
  } catch (e) {
    console.error("Chart error:", e);
  }
}

function makeChart(id, type, labels, data, label, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (chartInstances[id]) chartInstances[id].destroy();
  chartInstances[id] = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{ label, data, backgroundColor: color + "33", borderColor: color, borderWidth: 2, tension: 0.4, fill: type === "line" }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, grid: { color: "#f0f0f0" } }, x: { grid: { display: false } } }
    }
  });
}

// ===== TOAST =====
function showToast(title, msg, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const icons = { info: "\u2139\ufe0f", success: "\u2705", warning: "\u26a0\ufe0f", danger: "\ud83d\udd34" };
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || "\u2139\ufe0f"}</span>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escHtml(msg)}</div>` : ""}
    </div>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity 0.4s"; }, 3500);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 4000);
}

// ===== UTILITIES =====
function todayStr() { return new Date().toISOString().split("T")[0]; }

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function clearIntervals() {
  if (inactivityTimer) { clearInterval(inactivityTimer); inactivityTimer = null; }
  if (reminderInterval) { clearInterval(reminderInterval); reminderInterval = null; }
}

window.addEventListener("beforeunload", () => {
  if (timerRunning) stopTimerInternal();
  clearIntervals();
});

// ===== PROFILE MENU =====
window.toggleProfileMenu = function() {
  const dd = document.getElementById("profile-dropdown");
  if (dd) dd.classList.toggle("hidden");
};

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  const wrap = document.querySelector(".profile-menu-wrap");
  const dd = document.getElementById("profile-dropdown");
  if (dd && wrap && !wrap.contains(e.target)) dd.classList.add("hidden");
});

// ===== PROFILE PICTURE UPLOAD =====
window.uploadProfilePic = function(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataURL = e.target.result;
    try {
      await update(ref(db, `users/${currentUser.uid}`), { photoURL: dataURL });
      userProfile.photoURL = dataURL;
      renderProfile();
      showToast("Photo updated", "Profile picture saved.", "success");
    } catch (err) {
      showToast("Error", "Could not save photo.", "danger");
    }
  };
  reader.readAsDataURL(file);
};

// ===== EXPOSE ALL FUNCTIONS TO GLOBAL SCOPE =====
// Required because type="module" isolates scope from inline onclick handlers
window.toggleProfileMenu = window.toggleProfileMenu || toggleProfileMenu;
window.uploadProfilePic = window.uploadProfilePic || uploadProfilePic;
window.loginUser = window.loginUser || loginUser;
window.signupUser = window.signupUser || signupUser;
window.resetPassword = window.resetPassword || resetPassword;
window.logoutUser = window.logoutUser || logoutUser;
window.saveOnboarding = window.saveOnboarding || saveOnboarding;
window.showView = showView;
window.showPage = showPage;
window.addTask = window.addTask || addTask;
window.toggleTask = window.toggleTask || toggleTask;
window.startTimer = window.startTimer || startTimer;
window.stopTimer = window.stopTimer || stopTimer;
window.logEnergy = window.logEnergy || logEnergy;
window.dismissBreak = window.dismissBreak || dismissBreak;
window.dismissInactive = window.dismissInactive || dismissInactive;
window.saveReflection = window.saveReflection || saveReflection;
window.setInsightFilter = window.setInsightFilter || setInsightFilter;
window.loginAdmin = window.loginAdmin || loginAdmin;
window.adminSearch = window.adminSearch || adminSearch;
window.openUserDetail = window.openUserDetail || openUserDetail;
window.closeUserDetail = window.closeUserDetail || closeUserDetail;
window.showAdminPage = window.showAdminPage || showAdminPage;
window.refreshAdminPanel = window.refreshAdminPanel || refreshAdminPanel;
window.plannerChangeDate = window.plannerChangeDate || plannerChangeDate;
window.plannerGoToDate = window.plannerGoToDate || plannerGoToDate;
window.plannerGoToToday = window.plannerGoToToday || plannerGoToToday;
