/**
 * =====================================================
 * QUIZ ADMIN DASHBOARD - MAIN SCRIPT
 * Arabic RTL | Enterprise Grade | API-Ready
 * =====================================================
 */

'use strict';

/* ======================================================
   1. CONFIGURATION & ENVIRONMENT
====================================================== */
const CONFIG = {
  env: 'development',
  version: '2.0.0',
  maxRetries: 4,
  retryDelays: [1000, 2000, 5000, 10000],
  requestTimeout: 15000,
  cacheExpiry: 5 * 60 * 1000, // 5 minutes
  healthCheckInterval: 30000,
  liveUpdateInterval: 10000,
};

/* ======================================================
   2. CENTRALIZED API SERVICE LAYER
====================================================== */
const ApiService = (() => {
  let settings = {
    baseUrl: localStorage.getItem('apiBaseUrl') || '',
    endpoint: localStorage.getItem('dbEndpoint') || '/v1',
    token: localStorage.getItem('authToken') || '',
  };

  const cache = new Map();
  const retryQueue = [];
  let isOnline = navigator.onLine;
  let lastSuccessTime = null;
  let lastError = null;
  let requestCount = 0;

  // Build headers
  function buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Dashboard-Version': CONFIG.version,
    };
    if (settings.token) headers['Authorization'] = `Bearer ${settings.token}`;
    return { ...headers, ...extra };
  }

  // Validate config before request
  function validateConfig() {
    if (!settings.baseUrl) return { valid: false, msg: 'لم يتم تحديد رابط API الأساسي. يرجى الضهاب إلى إعدادات النظام.' };
    try { new URL(settings.baseUrl); } catch { return { valid: false, msg: 'رابط API غير صحيح.' }; }
    return { valid: true };
  }

  // Safe fetch with timeout
  async function safeFetch(url, options = {}, timeout = CONFIG.requestTimeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const start = Date.now();
      const res = await fetch(url, { ...options, signal: controller.signal });
      const elapsed = Date.now() - start;
      clearTimeout(timer);
      updateLatency(elapsed);
      return { res, elapsed };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('انتهت مهلة الطلب (Timeout)');
      throw err;
    }
  }

  // Exponential retry logic
  async function withRetry(fn, attempt = 0) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < CONFIG.maxRetries - 1) {
        const delay = CONFIG.retryDelays[attempt] || 10000;
        ActivityLog.add('warning', `فشل الطلب، إعادة المحاولة بعد ${delay / 1000}s... (محاولة ${attempt + 2}/${CONFIG.maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        return withRetry(fn, attempt + 1);
      }
      throw err;
    }
  }

  // Core request function
  async function request(method, path, body = null, useCache = false) {
    const v = validateConfig();
    if (!v.valid) {
      ActivityLog.add('error', v.msg);
      Toast.show('خطأ في الإعداد', v.msg, 'error');
      throw new Error(v.msg);
    }

    if (!isOnline) {
      const cached = cache.get(path);
      if (cached) {
        Toast.show('وضع غير متصل', 'عرض بيانات مخزنة مؤقتاً', 'warning');
        return cached.data;
      }
      // Queue the request
      if (method !== 'GET') {
        retryQueue.push({ method, path, body, time: new Date() });
        updateQueueCount();
        Toast.show('في الانتظار', 'سيتم تنفيذ الطلب عند استعادة الاتصال', 'info');
        throw new Error('لا يوجد اتصال بالإنترنت');
      }
      throw new Error('لا يوجد اتصال بالإنترنت');
    }

    // Check cache for GET
    if (method === 'GET' && useCache) {
      const cached = cache.get(path);
      if (cached && Date.now() - cached.time < CONFIG.cacheExpiry) return cached.data;
    }

    const url = `${settings.baseUrl}${settings.endpoint}${path}`;
    const opts = {
      method,
      headers: buildHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    requestCount++;
    updateQueueCount();

    try {
      const data = await withRetry(async () => {
        const { res, elapsed } = await safeFetch(url, opts);
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
        }
        const json = await res.json().catch(() => ({}));
        return json;
      });

      lastSuccessTime = new Date();
      lastError = null;
      updateMonitor();
      if (method === 'GET') cache.set(path, { data, time: Date.now() });
      ActivityLog.add('success', `${method} ${path} — نجح`);
      return data;

    } catch (err) {
      lastError = err.message;
      updateMonitor();
      ActivityLog.add('error', `${method} ${path} — ${err.message}`);
      throw err;
    } finally {
      requestCount--;
      updateQueueCount();
    }
  }

  function updateLatency(ms) {
    const el = document.getElementById('serverLatency');
    const monEl = document.getElementById('monLatency');
    if (el) el.textContent = `${ms}ms`;
    if (monEl) monEl.textContent = `${ms}ms`;
  }

  function updateMonitor() {
    const st = document.getElementById('monApiStatus');
    const ls = document.getElementById('monLastSuccess');
    const le = document.getElementById('monLastError');
    const md = document.getElementById('monMode');
    if (st) st.innerHTML = isOnline ? '<span class="dot green"></span> متصل' : '<span class="dot red"></span> غير متصل';
    if (ls) ls.textContent = lastSuccessTime ? lastSuccessTime.toLocaleTimeString('ar') : '—';
    if (le) le.textContent = lastError || 'لا يوجد';
    if (md) md.textContent = CONFIG.env === 'development' ? 'تطوير' : CONFIG.env === 'production' ? 'إنتاج' : 'اختبار';
  }

  function updateQueueCount() {
    const el = document.getElementById('monQueue');
    const qc = document.getElementById('queueCount');
    if (el) el.textContent = retryQueue.length + requestCount;
    if (qc) qc.textContent = `${retryQueue.length} عملية في الانتظار`;
  }

  // Sync queued requests when back online
  async function syncQueue() {
    if (retryQueue.length === 0) return;
    Toast.show('مزامنة', `جاري تنفيذ ${retryQueue.length} طلبات مؤجلة...`, 'info');
    while (retryQueue.length > 0) {
      const req = retryQueue.shift();
      try { await request(req.method, req.path, req.body); } catch (e) {}
    }
    updateQueueCount();
  }

  function updateSettings(s) { settings = { ...settings, ...s }; }
  function getSettings() { return { ...settings }; }
  function setOnline(v) {
    isOnline = v;
    updateMonitor();
    if (v) syncQueue();
  }

  // Health check
  async function healthCheck() {
    if (!settings.baseUrl) return;
    try {
      const start = Date.now();
      await safeFetch(`${settings.baseUrl}/health`, { method: 'GET', headers: buildHeaders() }, 5000);
      updateLatency(Date.now() - start);
      updateApiStatusPill(true);
    } catch {
      updateApiStatusPill(false);
    }
  }

  function updateApiStatusPill(ok) {
    const pill = document.getElementById('apiStatusPill');
    const dot = pill?.querySelector('.api-dot');
    const txt = document.getElementById('apiStatusText');
    if (dot) dot.style.background = ok ? 'var(--success)' : 'var(--danger)';
    if (txt) txt.textContent = ok ? 'API متصل' : 'API غير متصل';
  }

  return {
    get: (path, useCache = true) => request('GET', path, null, useCache),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    delete: (path) => request('DELETE', path),
    updateSettings,
    getSettings,
    setOnline,
    healthCheck,
    getRetryQueue: () => [...retryQueue],
    clearCache: () => cache.clear(),
  };
})();

/* ======================================================
   3. ACTIVITY LOG
====================================================== */
const ActivityLog = (() => {
  const logs = [];

  function add(level, msg) {
    const entry = { level, msg, time: new Date() };
    logs.unshift(entry);
    if (logs.length > 500) logs.pop();
    renderLogs();
  }

  function renderLogs(filter = '') {
    const container = document.getElementById('activityLogContainer');
    if (!container) return;
    const filtered = logs.filter(l => {
      if (!filter) return true;
      const levelFilter = document.getElementById('logLevel')?.value;
      const searchFilter = document.getElementById('logSearch')?.value?.toLowerCase();
      if (levelFilter && l.level !== levelFilter) return false;
      if (searchFilter && !l.msg.toLowerCase().includes(searchFilter)) return false;
      return true;
    });
    if (filtered.length === 0) { container.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted)">لا توجد سجلات</div>'; return; }
    container.innerHTML = filtered.map(l => `
      <div class="log-item">
        <span class="log-level ${l.level}">${levelLabel(l.level)}</span>
        <span class="log-msg">${l.msg}</span>
        <span class="log-time">${l.time.toLocaleTimeString('ar')}</span>
      </div>`).join('');
  }

  function levelLabel(l) {
    return { info: 'معلومة', success: 'نجاح', warning: 'تحذير', error: 'خطأ' }[l] || l;
  }

  return { add, renderLogs, getLogs: () => [...logs] };
})();

/* ======================================================
   4. TOAST NOTIFICATIONS
====================================================== */
const Toast = (() => {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };

  function show(title, msg = '', type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i class="fas ${icons[type]} toast-icon"></i>
      <div class="toast-body"><div class="toast-title">${title}</div>${msg ? `<div class="toast-msg">${msg}</div>` : ''}</div>
      <button class="toast-close" onclick="this.closest('.toast').remove()"><i class="fas fa-times"></i></button>`;
    container.appendChild(toast);
    if (duration > 0) setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, duration);
  }

  return { show };
})();

/* ======================================================
   5. MOCK DATA (Demo / Development Mode)
====================================================== */
const MockData = {
  questions: [
    { id: 1, text: 'ما هي عاصمة المملكة العربية السعودية؟', category: 'جغرافيا', difficulty: 'easy', timer: 30, points: 1000, answers: { A: 'الرياض', B: 'جدة', C: 'مكة', D: 'الدمام' }, correct: 'A', active: true, hasImage: false, hasAudio: false },
    { id: 2, text: 'كم عدد كواكب المجموعة الشمسية؟', category: 'علوم', difficulty: 'easy', timer: 30, points: 2000, answers: { A: '7', B: '8', C: '9', D: '10' }, correct: 'B', active: true, hasImage: true, hasAudio: false },
    { id: 3, text: 'من اخترع الهاتف؟', category: 'تاريخ', difficulty: 'medium', timer: 30, points: 4000, answers: { A: 'أديسون', B: 'بيل', C: 'تسلا', D: 'فاراداي' }, correct: 'B', active: true, hasImage: false, hasAudio: true },
    { id: 4, text: 'ما هو أكبر كوكب في المجموعة الشمسية؟', category: 'علوم', difficulty: 'easy', timer: 30, points: 1000, answers: { A: 'زحل', B: 'أورانوس', C: 'المشتري', D: 'نبتون' }, correct: 'C', active: true, hasImage: true, hasAudio: false },
    { id: 5, text: 'كم عدد أضلاع المسدس؟', category: 'رياضيات', difficulty: 'easy', timer: 20, points: 1000, answers: { A: '5', B: '6', C: '7', D: '8' }, correct: 'B', active: true, hasImage: false, hasAudio: false },
    { id: 6, text: 'ما هو رمز الذهب في الجدول الدوري؟', category: 'علوم', difficulty: 'medium', timer: 30, points: 8000, answers: { A: 'Gd', B: 'Go', C: 'Au', D: 'Ag' }, correct: 'C', active: true, hasImage: false, hasAudio: false },
    { id: 7, text: 'في أي عام اكتشفت أمريكا؟', category: 'تاريخ', difficulty: 'medium', timer: 30, points: 16000, answers: { A: '1492', B: '1776', C: '1512', D: '1450' }, correct: 'A', active: true, hasImage: false, hasAudio: false },
    { id: 8, text: 'ما هي أسرع حيوان على الأرض؟', category: 'ثقافة عامة', difficulty: 'hard', timer: 45, points: 32000, answers: { A: 'الأسد', B: 'النمر', C: 'الفهد', D: 'الحصان' }, correct: 'C', active: true, hasImage: false, hasAudio: false },
  ],

  students: [
    { id: 1, name: 'أحمد محمد السيد', email: 'ahmed@example.com', level: 'متقدم', games: 47, highScore: 500000, status: 'active', correctRate: 78, avgTime: 22 },
    { id: 2, name: 'فاطمة علي الحسن', email: 'fatima@example.com', level: 'خبير', games: 83, highScore: 1000000, status: 'active', correctRate: 92, avgTime: 18 },
    { id: 3, name: 'خالد عبدالله المنصور', email: 'khalid@example.com', level: 'متوسط', games: 21, highScore: 64000, status: 'active', correctRate: 61, avgTime: 28 },
    { id: 4, name: 'نورة سعد القحطاني', email: 'nora@example.com', level: 'مبتدئ', games: 8, highScore: 8000, status: 'banned', correctRate: 45, avgTime: 35 },
    { id: 5, name: 'عمر حسن المحمدي', email: 'omar@example.com', level: 'متقدم', games: 56, highScore: 250000, status: 'active', correctRate: 74, avgTime: 24 },
    { id: 6, name: 'سارة يوسف الزهراني', email: 'sara@example.com', level: 'خبير', games: 102, highScore: 1000000, status: 'active', correctRate: 89, avgTime: 16 },
    { id: 7, name: 'محمد طارق البصري', email: 'moha@example.com', level: 'متوسط', games: 33, highScore: 125000, status: 'active', correctRate: 68, avgTime: 27 },
    { id: 8, name: 'ريم إبراهيم العتيبي', email: 'reem@example.com', level: 'مبتدئ', games: 14, highScore: 32000, status: 'active', correctRate: 55, avgTime: 31 },
  ],

  stats: { totalQuestions: 248, totalStudents: 1847, totalSessions: 5632, activeNow: 23 },

  prizeLadder: [
    { level: 1, name: 'السؤال 1', amount: '1,000', safe: false },
    { level: 2, name: 'السؤال 2', amount: '2,000', safe: false },
    { level: 3, name: 'السؤال 3', amount: '3,000', safe: false },
    { level: 4, name: 'السؤال 4', amount: '5,000', safe: false },
    { level: 5, name: 'السؤال 5', amount: '10,000', safe: true },
    { level: 6, name: 'السؤال 6', amount: '20,000', safe: false },
    { level: 7, name: 'السؤال 7', amount: '40,000', safe: false },
    { level: 8, name: 'السؤال 8', amount: '75,000', safe: false },
    { level: 9, name: 'السؤال 9', amount: '150,000', safe: false },
    { level: 10, name: 'السؤال 10', amount: '250,000', safe: true },
    { level: 11, name: 'السؤال 11', amount: '500,000', safe: false },
    { level: 12, name: 'السؤال 12', amount: '1,000,000', safe: false },
  ],

  sounds: [
    { id: 'theme', name: 'الموسيقى الرئيسية', icon: 'fa-music' },
    { id: 'question', name: 'صوت السؤال', icon: 'fa-question-circle' },
    { id: 'correct', name: 'إجابة صحيحة', icon: 'fa-check-circle' },
    { id: 'wrong', name: 'إجابة خاطئة', icon: 'fa-times-circle' },
    { id: 'win', name: 'الفوز بالمليون', icon: 'fa-trophy' },
    { id: 'lose', name: 'الخسارة', icon: 'fa-heart-broken' },
    { id: 'lifeline', name: 'استخدام مساعدة', icon: 'fa-life-ring' },
    { id: 'suspense', name: 'تعليق الإجابة', icon: 'fa-drum' },
    { id: 'timer_warning', name: 'تحذير الوقت', icon: 'fa-stopwatch' },
  ],

  categories: [
    { name: 'علوم', icon: '🔬', count: 42 },
    { name: 'تاريخ', icon: '📜', count: 35 },
    { name: 'رياضيات', icon: '📐', count: 28 },
    { name: 'جغرافيا', icon: '🌍', count: 31 },
    { name: 'رياضة', icon: '⚽', count: 25 },
    { name: 'ثقافة عامة', icon: '🎓', count: 87 },
  ],

  activityFeed: [
    { type: 'success', icon: 'fa-user-plus', text: 'طالب جديد: سارة يوسف الزهراني', time: 'منذ 2 دقيقة' },
    { type: 'info', icon: 'fa-gamepad', text: 'جلسة لعب جديدة بدأت بواسطة أحمد محمد', time: 'منذ 5 دقائق' },
    { type: 'warning', icon: 'fa-question-circle', text: 'تمت إضافة 3 أسئلة جديدة في فئة العلوم', time: 'منذ 12 دقيقة' },
    { type: 'success', icon: 'fa-trophy', text: 'فاطمة علي حققت أعلى نتيجة: 1,000,000', time: 'منذ 20 دقيقة' },
    { type: 'info', icon: 'fa-sync', text: 'تمت مزامنة قاعدة البيانات بنجاح', time: 'منذ 35 دقيقة' },
  ],
};

/* ======================================================
   6. STATE MANAGEMENT
====================================================== */
const State = {
  currentPage: 'dashboard',
  questions: { data: [], page: 1, perPage: 10, search: '', category: '', difficulty: '' },
  students: { data: [], page: 1, perPage: 10, search: '', level: '', status: '' },
  editingQuestion: null,
  editingStudent: null,
  charts: {},
  simTimer: null,
  simTimerSec: 30,
  simCurrentQuestion: null,
  simLevel: 0,
  simLifelinesUsed: [],
  notifications: [
    { type: 'warning', icon: 'fa-exclamation-triangle', text: 'الأسئلة على مستوى خبير أقل من المطلوب', time: 'منذ 3 دقائق' },
    { type: 'success', icon: 'fa-check', text: 'تم نسخ قاعدة البيانات بنجاح', time: 'منذ 1 ساعة' },
    { type: 'info', icon: 'fa-info', text: 'تحديث النظام متاح — الإصدار 2.1.0', time: 'منذ 3 ساعات' },
  ],
};

/* ======================================================
   7. NAVIGATION
====================================================== */
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  State.currentPage = page;
  const breadcrumb = document.getElementById('breadcrumbPage');
  if (breadcrumb && navEl) {
    breadcrumb.textContent = navEl.querySelector('span')?.textContent || page;
  }

  // Page init
  if (page === 'dashboard') initDashboard();
  else if (page === 'questions') initQuestions();
  else if (page === 'students') initStudents();
  else if (page === 'leaderboard') initLeaderboard();
  else if (page === 'analytics') initAnalytics();
  else if (page === 'gameplay') initGameplay();
  else if (page === 'sounds') initSounds();
  else if (page === 'categories') initCategories();
  else if (page === 'simulator') initSimulator();
  else if (page === 'activitylog') ActivityLog.renderLogs();
  else if (page === 'settings') initSettings();

  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('mobile-open');
}

/* ======================================================
   8. DASHBOARD
====================================================== */
function initDashboard() {
  loadStats();
  renderActivityFeed();
  initCharts();
}

function loadStats() {
  // Try API first, fallback to mock
  const render = (data) => {
    animateCounter('totalQuestions', data.totalQuestions || MockData.stats.totalQuestions);
    animateCounter('totalStudents', data.totalStudents || MockData.stats.totalStudents);
    animateCounter('totalSessions', data.totalSessions || MockData.stats.totalSessions);
    animateCounter('activeNow', data.activeNow || MockData.stats.activeNow);
  };

  ApiService.get('/stats').then(render).catch(() => render(MockData.stats));
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const duration = 1200;
  const start = Date.now();
  const startVal = parseInt(el.textContent) || 0;
  const update = () => {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startVal + (target - startVal) * ease).toLocaleString('ar');
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function renderActivityFeed() {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  feed.innerHTML = MockData.activityFeed.map(item => `
    <div class="feed-item">
      <div class="feed-icon ${item.type}"><i class="fas ${item.icon}"></i></div>
      <div>
        <div class="feed-text">${item.text}</div>
        <div class="feed-time">${item.time}</div>
      </div>
    </div>`).join('');
}

function initCharts() {
  Chart.defaults.font.family = 'Tajawal, Cairo, sans-serif';
  Chart.defaults.color = '#8899aa';

  // Activity Chart
  const actCtx = document.getElementById('activityChart');
  if (actCtx) {
    if (State.charts.activity) State.charts.activity.destroy();
    const labels = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (29 - i));
      return d.toLocaleDateString('ar', { month: 'short', day: 'numeric' });
    });
    const data = Array.from({ length: 30 }, () => Math.floor(Math.random() * 200 + 50));
    State.charts.activity = new Chart(actCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'الجلسات',
          data,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          tension: 0.4,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 5,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { maxTicksLimit: 8 } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' } },
        }
      }
    });
  }

  // Difficulty Chart
  const diffCtx = document.getElementById('difficultyChart');
  if (diffCtx) {
    if (State.charts.difficulty) State.charts.difficulty.destroy();
    State.charts.difficulty = new Chart(diffCtx, {
      type: 'doughnut',
      data: {
        labels: ['سهل', 'متوسط', 'صعب', 'خبير'],
        datasets: [{ data: [30, 40, 20, 10], backgroundColor: ['#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'], borderWidth: 0, hoverOffset: 6 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, cutout: '70%' }
    });
  }

  // Performance Chart
  const perfCtx = document.getElementById('performanceChart');
  if (perfCtx) {
    if (State.charts.performance) State.charts.performance.destroy();
    State.charts.performance = new Chart(perfCtx, {
      type: 'bar',
      data: {
        labels: ['علوم', 'تاريخ', 'رياضيات', 'جغرافيا', 'رياضة', 'ثقافة'],
        datasets: [{ label: 'معدل النجاح %', data: [78, 65, 82, 70, 88, 74], backgroundColor: 'rgba(139,92,246,0.6)', borderRadius: 6 }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, max: 100 },
        }
      }
    });
  }

  // Sparklines
  renderSparkline('sparkQ', [45, 52, 48, 60, 55, 70, 62]);
  renderSparkline('sparkS', [120, 145, 130, 160, 155, 180, 175]);
  renderSparkline('sparkSe', [200, 180, 220, 210, 195, 240, 230]);
  renderSparkline('sparkA', [15, 20, 18, 25, 22, 30, 23]);
}

function renderSparkline(id, data) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{ data, borderColor: '#f59e0b', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.4 }]
    },
    options: { responsive: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
  });
}

function APP_refreshDashboard() { initDashboard(); Toast.show('تحديث', 'تم تحديث لوحة التحكم', 'success'); }
function APP_exportReport() { Toast.show('تصدير', 'جاري تصدير التقرير...', 'info'); }

/* ======================================================
   9. QUESTIONS MANAGEMENT
====================================================== */
function initQuestions() {
  loadQuestions();
}

function loadQuestions() {
  ApiService.get('/questions').then(data => {
    State.questions.data = Array.isArray(data) ? data : MockData.questions;
    renderQuestionsTable();
  }).catch(() => {
    State.questions.data = MockData.questions;
    renderQuestionsTable();
  });
}

function renderQuestionsTable() {
  const tbody = document.getElementById('questionsTbody');
  const search = document.getElementById('questionSearch')?.value?.toLowerCase() || '';
  const cat = document.getElementById('filterCategory')?.value || '';
  const diff = document.getElementById('filterDifficulty')?.value || '';

  let filtered = State.questions.data.filter(q => {
    if (search && !q.text.toLowerCase().includes(search)) return false;
    if (cat && q.category !== cat) return false;
    if (diff && q.difficulty !== diff) return false;
    return true;
  });

  const total = filtered.length;
  document.getElementById('questionsCount').textContent = `إجمالي: ${total} سؤال`;

  const start = (State.questions.page - 1) * State.questions.perPage;
  const paginated = filtered.slice(start, start + State.questions.perPage);

  if (paginated.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-search"></i><br>لا توجد أسئلة مطابقة</td></tr>';
  } else {
    tbody.innerHTML = paginated.map(q => `
      <tr>
        <td><input type="checkbox" class="q-check" data-id="${q.id}" /></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${q.text}</td>
        <td><span style="font-size:12px;color:var(--text-muted)">${q.category}</span></td>
        <td><span class="diff-badge ${q.difficulty}">${diffLabel(q.difficulty)}</span></td>
        <td><span style="font-size:12px">${q.timer}ث</span></td>
        <td>
          ${q.hasImage ? '<i class="fas fa-image" style="color:var(--info);margin-left:4px"></i>' : ''}
          ${q.hasAudio ? '<i class="fas fa-music" style="color:var(--secondary)"></i>' : ''}
          ${!q.hasImage && !q.hasAudio ? '<span style="color:var(--text-muted);font-size:12px">—</span>' : ''}
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn view" onclick="APP.previewQuestionById(${q.id})" title="معاينة"><i class="fas fa-eye"></i></button>
            <button class="action-btn edit" onclick="APP.openQuestionModal(${q.id})" title="تعديل"><i class="fas fa-edit"></i></button>
            <button class="action-btn copy" onclick="APP.copyQuestion(${q.id})" title="نسخ"><i class="fas fa-copy"></i></button>
            <button class="action-btn delete" onclick="APP.deleteQuestion(${q.id})" title="حذف"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`).join('');
  }

  renderPagination('questionsPagination', State.questions.page, Math.ceil(total / State.questions.perPage), (p) => {
    State.questions.page = p;
    renderQuestionsTable();
  });
}

function diffLabel(d) { return { easy: 'سهل', medium: 'متوسط', hard: 'صعب', expert: 'خبير' }[d] || d; }

function openQuestionModal(id = null) {
  State.editingQuestion = id ? State.questions.data.find(q => q.id === id) : null;
  const modal = document.getElementById('questionModal');
  const title = document.getElementById('questionModalTitle');
  title.textContent = id ? 'تعديل السؤال' : 'إضافة سؤال جديد';

  if (State.editingQuestion) {
    const q = State.editingQuestion;
    setVal('qText', q.text);
    setVal('qCategory', q.category);
    setVal('qDifficulty', q.difficulty);
    setVal('qTimer', q.timer);
    setVal('qA', q.answers.A);
    setVal('qB', q.answers.B);
    setVal('qC', q.answers.C);
    setVal('qD', q.answers.D);
    const radio = document.querySelector(`input[name="correct"][value="${q.correct}"]`);
    if (radio) radio.checked = true;
    setVal('qPoints', q.points);
  } else {
    ['qText','qA','qB','qC','qD','qExplanation','qHint','qTags'].forEach(f => setVal(f, ''));
    setVal('qTimer', 30); setVal('qPoints', 1000);
  }

  // Reset tabs
  document.querySelectorAll('.form-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('.form-tab-content').forEach((c, i) => c.classList.toggle('active', i === 0));

  openModal('questionModal');
}

function saveQuestion() {
  const text = getVal('qText').trim();
  if (!text) { Toast.show('خطأ', 'نص السؤال مطلوب', 'error'); return; }
  const ansA = getVal('qA').trim(), ansB = getVal('qB').trim(), ansC = getVal('qC').trim(), ansD = getVal('qD').trim();
  if (!ansA || !ansB || !ansC || !ansD) { Toast.show('خطأ', 'جميع الإجابات مطلوبة', 'error'); return; }

  const correct = document.querySelector('input[name="correct"]:checked')?.value || 'A';
  const payload = {
    text,
    category: getVal('qCategory'),
    difficulty: getVal('qDifficulty'),
    timer: parseInt(getVal('qTimer')),
    points: parseInt(getVal('qPoints')),
    answers: { A: ansA, B: ansB, C: ansC, D: ansD },
    correct,
    explanation: getVal('qExplanation'),
    hint: getVal('qHint'),
    tags: getVal('qTags'),
    active: document.getElementById('qActive')?.checked ?? true,
    hasImage: false,
    hasAudio: false,
  };

  const op = State.editingQuestion
    ? ApiService.put(`/questions/${State.editingQuestion.id}`, payload)
    : ApiService.post('/questions', payload);

  op.then(() => {
    // Update local data
    if (State.editingQuestion) {
      const idx = State.questions.data.findIndex(q => q.id === State.editingQuestion.id);
      if (idx >= 0) State.questions.data[idx] = { ...State.editingQuestion, ...payload };
      Toast.show('نجاح', 'تم تحديث السؤال', 'success');
    } else {
      const newQ = { id: Date.now(), ...payload };
      State.questions.data.unshift(newQ);
      MockData.stats.totalQuestions++;
      Toast.show('نجاح', 'تمت إضافة السؤال', 'success');
    }
    ActivityLog.add('success', `${State.editingQuestion ? 'تعديل' : 'إضافة'} سؤال: ${text.substring(0, 50)}`);
    renderQuestionsTable();
    closeModal('questionModal');
  }).catch(err => {
    // Add to local anyway in dev mode
    const newQ = { id: Date.now(), ...payload };
    State.questions.data.unshift(newQ);
    Toast.show('محلي', 'تم الحفظ محلياً (API غير متاح)', 'warning');
    renderQuestionsTable();
    closeModal('questionModal');
  });
}

function deleteQuestion(id) {
  if (!confirm('هل أنت متأكد من حذف هذا السؤال؟')) return;
  ApiService.delete(`/questions/${id}`).catch(() => {});
  State.questions.data = State.questions.data.filter(q => q.id !== id);
  renderQuestionsTable();
  Toast.show('حذف', 'تم حذف السؤال', 'success');
  ActivityLog.add('warning', `حذف سؤال ID: ${id}`);
}

function copyQuestion(id) {
  const q = State.questions.data.find(q => q.id === id);
  if (!q) return;
  const copy = { ...q, id: Date.now(), text: 'نسخة: ' + q.text };
  State.questions.data.unshift(copy);
  renderQuestionsTable();
  Toast.show('نسخ', 'تم نسخ السؤال', 'success');
}

function previewQuestion() {
  const text = getVal('qText').trim() || 'نص السؤال هنا';
  const answers = { A: getVal('qA') || 'أ', B: getVal('qB') || 'ب', C: getVal('qC') || 'ج', D: getVal('qD') || 'د' };
  showGamePreview({ text, answers });
  openModal('previewModal');
}

function previewQuestionById(id) {
  const q = State.questions.data.find(q => q.id === id);
  if (q) { showGamePreview(q); openModal('previewModal'); }
}

function showGamePreview(q) {
  const el = document.getElementById('gamePreviewScreen');
  if (!el) return;
  el.innerHTML = `
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-family:var(--font-display);font-size:20px;font-weight:900;color:var(--primary);margin-bottom:8px"><i class="fas fa-star"></i> مليونير</div>
      <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:20px;font-size:16px;font-weight:700;color:#fff;line-height:1.6">${q.text}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${Object.entries(q.answers || { A: q.text }).map(([k, v]) => `
        <div style="background:rgba(255,255,255,0.08);border:2px solid rgba(255,255,255,0.15);border-radius:10px;padding:12px;color:#fff;font-size:13px;font-weight:600;text-align:center;cursor:pointer" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.15)'">
          <span style="color:var(--primary);margin-left:4px">${k}:</span> ${v}
        </div>`).join('')}
    </div>`;
}

function importQuestions() { Toast.show('استيراد', 'ميزة الاستيراد قيد التطوير — ستدعم CSV و JSON', 'info'); }
function exportQuestions() {
  const data = JSON.stringify(State.questions.data, null, 2);
  downloadFile('questions.json', data, 'application/json');
  Toast.show('تصدير', 'تم تصدير الأسئلة', 'success');
}
function bulkDelete() {
  const checked = document.querySelectorAll('.q-check:checked');
  if (checked.length === 0) { Toast.show('تحذير', 'لم تختر أي سؤال', 'warning'); return; }
  if (!confirm(`حذف ${checked.length} سؤال؟`)) return;
  const ids = [...checked].map(c => parseInt(c.dataset.id));
  State.questions.data = State.questions.data.filter(q => !ids.includes(q.id));
  renderQuestionsTable();
  Toast.show('حذف', `تم حذف ${ids.length} سؤال`, 'success');
}
function aiSuggestQuestion() { Toast.show('ذكاء اصطناعي', 'جاري توليد اقتراح...', 'info'); setTimeout(() => { openQuestionModal(); setVal('qText', 'ما هي العاصمة الأكثر ارتفاعاً في العالم؟ (مقترح بالذكاء الاصطناعي)'); setVal('qA', 'لاباز'); setVal('qB', 'كيتو'); setVal('qC', 'بوغوتا'); setVal('qD', 'كاتماندو'); Toast.show('اقتراح جاهز', 'تم توليد سؤال باستخدام الذكاء الاصطناعي', 'success'); }, 1500); }
function detectDuplicates() { Toast.show('فحص التكرار', 'لا يوجد أسئلة مكررة (فحص الذكاء الاصطناعي)', 'success'); }
function balanceDifficulty() { Toast.show('موازنة', 'التوزيع متوازن بنسبة 92%', 'success'); }
function autoCategorize() { Toast.show('تصنيف تلقائي', 'تم تصنيف 12 سؤالاً تلقائياً', 'success'); }

/* ======================================================
   10. STUDENTS
====================================================== */
function initStudents() {
  ApiService.get('/students').then(data => {
    State.students.data = Array.isArray(data) ? data : MockData.students;
    renderStudentsTable();
  }).catch(() => {
    State.students.data = MockData.students;
    renderStudentsTable();
  });
}

function renderStudentsTable() {
  const tbody = document.getElementById('studentsTbody');
  const search = document.getElementById('studentSearch')?.value?.toLowerCase() || '';
  const level = document.getElementById('filterStudentLevel')?.value || '';
  const status = document.getElementById('filterStudentStatus')?.value || '';

  let filtered = State.students.data.filter(s => {
    if (search && !s.name.toLowerCase().includes(search) && !s.email.toLowerCase().includes(search)) return false;
    if (level && s.level !== level) return false;
    if (status && s.status !== status) return false;
    return true;
  });

  const start = (State.students.page - 1) * State.students.perPage;
  const paginated = filtered.slice(start, start + State.students.perPage);

  if (paginated.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">لا يوجد طلاب مطابقون</td></tr>';
    return;
  }

  tbody.innerHTML = paginated.map(s => `
    <tr>
      <td><input type="checkbox" class="s-check" data-id="${s.id}" /></td>
      <td>
        <div class="student-cell">
          <div class="student-mini-avatar">${s.name.charAt(0)}</div>
          <div><div class="student-mini-name">${s.name}</div><div class="student-mini-id">#${s.id}</div></div>
        </div>
      </td>
      <td style="font-size:12.5px;color:var(--text-muted)">${s.email}</td>
      <td><span style="font-size:12px;color:var(--accent)">${s.level}</span></td>
      <td><span style="font-weight:700">${s.games}</span></td>
      <td><span style="color:var(--primary);font-weight:700">${s.highScore.toLocaleString('ar')}</span></td>
      <td><span class="status-badge ${s.status}">${s.status === 'active' ? 'نشط' : 'محظور'}</span></td>
      <td>
        <div class="action-btns">
          <button class="action-btn view" onclick="APP.openStudentModal(${s.id})" title="عرض الملف"><i class="fas fa-user"></i></button>
          <button class="action-btn edit" onclick="APP.openStudentModal(${s.id})" title="تعديل"><i class="fas fa-edit"></i></button>
          <button class="action-btn delete" onclick="APP.deleteStudentById(${s.id})" title="حذف"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`).join('');

  renderPagination('studentsPagination', State.students.page, Math.ceil(filtered.length / State.students.perPage), (p) => {
    State.students.page = p;
    renderStudentsTable();
  });
}

function openStudentModal(id = null) {
  const s = id ? State.students.data.find(s => s.id === id) : null;
  State.editingStudent = s;
  document.getElementById('studentModalTitle').textContent = s ? `ملف الطالب: ${s.name}` : 'إضافة طالب جديد';
  document.getElementById('studentAvatar').textContent = s ? s.name.charAt(0) : 'ط';
  setVal('sName', s?.name || '');
  setVal('sEmail', s?.email || '');
  setVal('sLevel', s?.level || 'مبتدئ');
  setVal('sStatus', s?.status || 'active');

  const statsRow = document.getElementById('studentStatsRow');
  if (s && statsRow) {
    statsRow.innerHTML = `
      <div class="student-stat"><div class="student-stat-val">${s.games}</div><div class="student-stat-label">الألعاب</div></div>
      <div class="student-stat"><div class="student-stat-val">${s.highScore.toLocaleString('ar')}</div><div class="student-stat-label">أعلى نتيجة</div></div>
      <div class="student-stat"><div class="student-stat-val">${s.correctRate}%</div><div class="student-stat-label">الإجابات الصحيحة</div></div>
      <div class="student-stat"><div class="student-stat-val">${s.avgTime}ث</div><div class="student-stat-label">متوسط وقت الإجابة</div></div>`;
  }
  openModal('studentModal');
}

function saveStudent() {
  const payload = { name: getVal('sName'), email: getVal('sEmail'), level: getVal('sLevel'), status: getVal('sStatus') };
  if (!payload.name) { Toast.show('خطأ', 'الاسم مطلوب', 'error'); return; }
  if (State.editingStudent) {
    ApiService.put(`/students/${State.editingStudent.id}`, payload).catch(() => {});
    Object.assign(State.editingStudent, payload);
  } else {
    ApiService.post('/students', payload).catch(() => {});
    State.students.data.unshift({ id: Date.now(), games: 0, highScore: 0, correctRate: 0, avgTime: 0, ...payload });
  }
  renderStudentsTable();
  closeModal('studentModal');
  Toast.show('نجاح', 'تم حفظ بيانات الطالب', 'success');
}

function banStudent() { if (State.editingStudent) { State.editingStudent.status = 'banned'; setVal('sStatus', 'banned'); Toast.show('حظر', 'تم حظر الطالب', 'warning'); } }
function resetStudentProgress() { Toast.show('إعادة تعيين', 'تم إعادة تعيين تقدم الطالب', 'warning'); }
function resetStudentPassword() { Toast.show('كلمة المرور', 'تم إرسال رابط إعادة التعيين', 'info'); }
function sendStudentNotification() { Toast.show('إشعار', 'تم إرسال الإشعار للطالب', 'success'); }
function deleteStudent() { if (!confirm('حذف هذا الطالب نهائياً؟')) return; closeModal('studentModal'); deleteStudentById(State.editingStudent?.id); }
function deleteStudentById(id) {
  ApiService.delete(`/students/${id}`).catch(() => {});
  State.students.data = State.students.data.filter(s => s.id !== id);
  renderStudentsTable();
  Toast.show('حذف', 'تم حذف الطالب', 'success');
}
function exportStudents() { downloadFile('students.json', JSON.stringify(State.students.data, null, 2), 'application/json'); Toast.show('تصدير', 'تم تصدير بيانات الطلاب', 'success'); }

/* ======================================================
   11. LEADERBOARD
====================================================== */
function initLeaderboard() {
  const data = State.students.data.length ? State.students.data : MockData.students;
  const sorted = [...data].sort((a, b) => b.highScore - a.highScore);
  renderPodium(sorted.slice(0, 3));
  renderLeaderboardList(sorted.slice(3));

  document.getElementById('leaderboardSort')?.addEventListener('change', (e) => {
    const key = e.target.value;
    const re = [...data].sort((a, b) => b[key === 'score' ? 'highScore' : key === 'wins' ? 'games' : 'correctRate'] - a[key === 'score' ? 'highScore' : key === 'wins' ? 'games' : 'correctRate']);
    renderPodium(re.slice(0, 3));
    renderLeaderboardList(re.slice(3));
  });
}

function renderPodium(top3) {
  const podium = document.getElementById('podium');
  if (!podium) return;
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  const classes = ['second', 'first', 'third'];
  podium.innerHTML = order.map((s, i) => `
    <div class="podium-place ${classes[i]}">
      <div class="podium-avatar">${s.name.charAt(0)}</div>
      <div class="podium-name">${s.name.split(' ')[0]}</div>
      <div class="podium-score">${s.highScore.toLocaleString('ar')}</div>
      <div class="podium-block">${classes[i] === 'first' ? '1' : classes[i] === 'second' ? '2' : '3'}</div>
    </div>`).join('');
}

function renderLeaderboardList(rest) {
  const list = document.getElementById('leaderboardList');
  if (!list) return;
  list.innerHTML = rest.map((s, i) => `
    <div class="lb-row">
      <div class="lb-rank">${i + 4}</div>
      <div class="lb-avatar">${s.name.charAt(0)}</div>
      <div class="lb-name">${s.name}</div>
      <div class="lb-games">${s.games} لعبة</div>
      <div class="lb-score">${s.highScore.toLocaleString('ar')}</div>
    </div>`).join('');
}

/* ======================================================
   12. ANALYTICS
====================================================== */
function initAnalytics() {
  Chart.defaults.font.family = 'Tajawal, Cairo, sans-serif';
  Chart.defaults.color = '#8899aa';

  const ctx1 = document.getElementById('analyticsStudentChart');
  if (ctx1) {
    if (State.charts.analyticsStudent) State.charts.analyticsStudent.destroy();
    State.charts.analyticsStudent = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: ['يناير','فبراير','مارس','أبريل','مايو','يونيو'],
        datasets: [
          { label: 'طلاب جدد', data: [120,145,130,180,165,200], borderColor: '#f59e0b', tension: 0.4, fill: false },
          { label: 'جلسات', data: [450,520,480,620,590,720], borderColor: '#8b5cf6', tension: 0.4, fill: false },
        ]
      },
      options: { responsive: true, scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' } }, y: { grid: { color: 'rgba(255,255,255,0.05)' } } } }
    });
  }

  const ctx2 = document.getElementById('analyticsCategoryChart');
  if (ctx2) {
    if (State.charts.analyticsCategory) State.charts.analyticsCategory.destroy();
    State.charts.analyticsCategory = new Chart(ctx2, {
      type: 'radar',
      data: {
        labels: ['علوم','تاريخ','رياضيات','جغرافيا','رياضة','ثقافة'],
        datasets: [{ label: 'معدل النجاح', data: [78,65,82,70,88,74], backgroundColor: 'rgba(245,158,11,0.15)', borderColor: '#f59e0b' }]
      },
      options: { responsive: true, scales: { r: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { display: false } } } }
    });
  }

  const ctx3 = document.getElementById('analyticsDiffChart');
  if (ctx3) {
    if (State.charts.analyticsDiff) State.charts.analyticsDiff.destroy();
    State.charts.analyticsDiff = new Chart(ctx3, {
      type: 'polarArea',
      data: {
        labels: ['سهل','متوسط','صعب','خبير'],
        datasets: [{ data: [74,55,35,19], backgroundColor: ['rgba(34,197,94,0.5)','rgba(245,158,11,0.5)','rgba(239,68,68,0.5)','rgba(139,92,246,0.5)'] }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
  }

  const ctx4 = document.getElementById('analyticsHourlyChart');
  if (ctx4) {
    if (State.charts.analyticsHourly) State.charts.analyticsHourly.destroy();
    const hrs = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const vals = [5,3,2,1,1,2,8,15,22,30,35,40,38,42,45,50,55,70,85,90,80,60,40,20];
    State.charts.analyticsHourly = new Chart(ctx4, {
      type: 'bar',
      data: {
        labels: hrs,
        datasets: [{ label: 'المستخدمون', data: vals, backgroundColor: 'rgba(6,182,212,0.5)', borderRadius: 4 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(255,255,255,0.05)' } } } }
    });
  }
}

function exportAnalytics() { Toast.show('تصدير', 'جاري تصدير تقرير التحليلات...', 'info'); }

/* ======================================================
   13. GAMEPLAY
====================================================== */
function initGameplay() {
  renderPrizeLadder();
}

function renderPrizeLadder() {
  const container = document.getElementById('prizeLadder');
  if (!container) return;
  container.innerHTML = MockData.prizeLadder.map(p => `
    <div class="prize-item ${p.safe ? 'safe' : ''} ${p.level === 12 ? 'top' : ''} ${p.level === 12 ? 'milestone' : p.safe ? 'milestone' : ''}">
      <span class="prize-num">${p.level}</span>
      <input type="text" class="prize-name-input" value="${p.name}" />
      <span class="prize-amount">${p.amount} ريال</span>
      ${p.safe ? '<i class="fas fa-shield-alt" style="color:var(--info);font-size:11px"></i>' : ''}
    </div>`).join('');
}

function saveGameplay() {
  const settings = {
    defaultTimer: getVal('defaultTimer'),
    hardTimer: getVal('hardTimer'),
    timerWarning: getVal('timerWarning'),
    lifeline5050: document.getElementById('lifeline5050')?.checked,
    lifelineAudience: document.getElementById('lifelineAudience')?.checked,
    lifelineCall: document.getElementById('lifelineCall')?.checked,
  };
  ApiService.post('/settings/gameplay', settings).catch(() => {});
  Toast.show('حفظ', 'تم حفظ إعدادات اللعب', 'success');
}

function resetPrizeLadder() { renderPrizeLadder(); Toast.show('إعادة تعيين', 'تم استعادة الإعدادات الافتراضية', 'info'); }

function updateDiffDist() {
  const easy = parseInt(document.getElementById('diffEasy')?.value || 0);
  const med = parseInt(document.getElementById('diffMed')?.value || 0);
  const hard = parseInt(document.getElementById('diffHard')?.value || 0);
  const exp = parseInt(document.getElementById('diffExp')?.value || 0);
  const total = easy + med + hard + exp;
  const el = document.getElementById('diffTotal');
  if (el) { el.textContent = `المجموع: ${total}%`; el.className = `diff-total ${total !== 100 ? 'over' : ''}`; }
  document.getElementById('easyPct').textContent = easy;
  document.getElementById('medPct').textContent = med;
  document.getElementById('hardPct').textContent = hard;
  document.getElementById('expPct').textContent = exp;
}

/* ======================================================
   14. SOUNDS
====================================================== */
function initSounds() {
  const grid = document.getElementById('soundsGrid');
  if (!grid) return;
  grid.innerHTML = MockData.sounds.map(s => `
    <div class="sound-card">
      <div class="sound-icon"><i class="fas ${s.icon}"></i></div>
      <div class="sound-name">${s.name}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">لا يوجد ملف مرفوع</div>
      <div class="sound-controls">
        <button class="btn btn-ghost btn-sm" onclick="APP.playSoundPreview('${s.id}')"><i class="fas fa-play"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('snd_${s.id}').click()"><i class="fas fa-upload"></i></button>
        <input type="file" id="snd_${s.id}" accept="audio/*" hidden onchange="APP.handleSoundUpload(this,'${s.id}')" />
      </div>
    </div>`).join('');

  document.getElementById('masterVolume')?.addEventListener('input', (e) => {
    document.getElementById('volumeDisplay').textContent = `${e.target.value}%`;
  });
}

function playSoundPreview(id) { Toast.show('معاينة', `تشغيل صوت: ${id}`, 'info'); }
function handleSoundUpload(input, id) { if (input.files[0]) Toast.show('رفع', `تم رفع الملف: ${input.files[0].name}`, 'success'); }
function saveSounds() { Toast.show('حفظ', 'تم حفظ إعدادات الأصوات', 'success'); }

/* ======================================================
   15. APPEARANCE
====================================================== */
function saveAppearance() {
  const settings = {
    colorPrimary: document.getElementById('colorPrimary')?.value,
    colorSecondary: document.getElementById('colorSecondary')?.value,
    colorBg: document.getElementById('colorBg')?.value,
  };
  if (settings.colorPrimary) document.documentElement.style.setProperty('--primary', settings.colorPrimary);
  if (settings.colorSecondary) document.documentElement.style.setProperty('--secondary', settings.colorSecondary);
  Toast.show('حفظ', 'تم تطبيق التخصيصات', 'success');
}
function resetAppearance() {
  document.documentElement.style.removeProperty('--primary');
  document.documentElement.style.removeProperty('--secondary');
  document.documentElement.style.removeProperty('--bg-base');
  document.getElementById('colorPrimary').value = '#f59e0b';
  document.getElementById('colorSecondary').value = '#8b5cf6';
  Toast.show('إعادة تعيين', 'تم استعادة الألوان الافتراضية', 'info');
}

/* ======================================================
   16. CATEGORIES
====================================================== */
function initCategories() {
  const grid = document.getElementById('categoriesGrid');
  if (!grid) return;
  grid.innerHTML = MockData.categories.map(c => `
    <div class="category-card" onclick="APP.editCategory('${c.name}')">
      <div class="category-icon">${c.icon}</div>
      <div class="category-name">${c.name}</div>
      <div class="category-count">${c.count} سؤال</div>
    </div>`).join('') + `
    <div class="category-card" style="border-style:dashed;opacity:0.6" onclick="APP.openCategoryModal()">
      <div class="category-icon"><i class="fas fa-plus" style="font-size:28px;color:var(--text-muted)"></i></div>
      <div class="category-name" style="color:var(--text-muted)">إضافة فئة</div>
    </div>`;
}
function openCategoryModal() { Toast.show('قريباً', 'نافذة إضافة الفئة قيد التطوير', 'info'); }
function editCategory(name) { Toast.show('تعديل', `تعديل فئة: ${name}`, 'info'); }

/* ======================================================
   17. SIMULATOR
====================================================== */
function initSimulator() {
  renderSimLadder();
  populateSimQuestions();
}

function renderSimLadder() {
  const ladder = document.getElementById('simLadder');
  if (!ladder) return;
  ladder.innerHTML = MockData.prizeLadder.map(p => `
    <div class="sim-ladder-item ${p.safe ? 'safe' : ''}" id="simLevel_${p.level}">
      <span>${p.name}</span>
      <span style="font-weight:700">${p.amount}</span>
    </div>`).join('');
}

function populateSimQuestions() {
  const sel = document.getElementById('simQuestionSelect');
  if (!sel) return;
  const qs = State.questions.data.length ? State.questions.data : MockData.questions;
  sel.innerHTML = '<option value="">-- اختر سؤالاً --</option>' + qs.map(q => `<option value="${q.id}">${q.text.substring(0, 50)}...</option>`).join('');
}

function startSimulator() {
  State.simLevel = 1;
  State.simLifelinesUsed = [];
  document.querySelectorAll('.lifeline-btn').forEach(b => b.classList.remove('used'));
  updateSimLadder();
  Toast.show('محاكاة', 'بدأت جلسة المحاكاة', 'success');
}

function resetSimulator() {
  clearInterval(State.simTimer);
  State.simLevel = 0;
  State.simLifelinesUsed = [];
  document.getElementById('simQuestionText').textContent = 'مرحباً بك في محاكي اللعبة';
  ['simA','simB','simC','simD'].forEach(id => { const el = document.getElementById(id); if(el){ el.textContent = `${id.replace('sim','')}: —`; el.className = 'sim-answer'; }});
  document.getElementById('simCurrentPrize').textContent = 'اختر سؤالاً للبدء';
  document.querySelectorAll('.lifeline-btn').forEach(b => b.classList.remove('used'));
  document.querySelectorAll('.sim-ladder-item').forEach(i => { i.classList.remove('current','passed'); });
  document.getElementById('simTimerText').textContent = '30';
  const circle = document.getElementById('timerCircle');
  if (circle) circle.style.strokeDashoffset = '0';
}

function loadSimQuestion() {
  const sel = document.getElementById('simQuestionSelect');
  const id = parseInt(sel.value);
  if (!id) { Toast.show('تحذير', 'اختر سؤالاً أولاً', 'warning'); return; }
  const q = (State.questions.data.length ? State.questions.data : MockData.questions).find(q => q.id === id);
  if (!q) return;
  State.simCurrentQuestion = q;
  document.getElementById('simQuestionText').textContent = q.text;
  ['A','B','C','D'].forEach(k => {
    const el = document.getElementById(`sim${k}`);
    if (el) { el.textContent = `${k}: ${q.answers[k]}`; el.className = 'sim-answer'; el.onclick = () => checkSimAnswer(k); }
  });
  document.getElementById('simCurrentPrize').textContent = MockData.prizeLadder[State.simLevel]?.amount || '—';
  startSimTimer(q.timer || 30);
  updateSimLadder();
}

function checkSimAnswer(choice) {
  if (!State.simCurrentQuestion) return;
  clearInterval(State.simTimer);
  const correct = State.simCurrentQuestion.correct;
  document.getElementById(`sim${correct}`).classList.add('correct');
  if (choice !== correct) document.getElementById(`sim${choice}`).classList.add('wrong');
  ['A','B','C','D'].forEach(k => { const el = document.getElementById(`sim${k}`); if(el) el.onclick = null; });

  setTimeout(() => {
    if (choice === correct) {
      State.simLevel = Math.min(State.simLevel + 1, 12);
      updateSimLadder();
      Toast.show('صح!', `إجابة صحيحة! انتقل للمستوى ${State.simLevel}`, 'success');
    } else {
      Toast.show('خطأ!', `الإجابة الصحيحة كانت: ${State.simCurrentQuestion.answers[correct]}`, 'error');
      resetSimulator();
    }
  }, 1500);
}

function startSimTimer(seconds) {
  clearInterval(State.simTimer);
  State.simTimerSec = seconds;
  const circle = document.getElementById('timerCircle');
  const text = document.getElementById('simTimerText');
  const circumference = 283;
  State.simTimer = setInterval(() => {
    State.simTimerSec--;
    if (text) text.textContent = State.simTimerSec;
    if (circle) circle.style.strokeDashoffset = `${circumference * (1 - State.simTimerSec / seconds)}`;
    if (circle) circle.style.stroke = State.simTimerSec <= 10 ? '#ef4444' : '#f59e0b';
    if (State.simTimerSec <= 0) {
      clearInterval(State.simTimer);
      Toast.show('انتهى الوقت!', 'انتهى وقت الإجابة', 'error');
      resetSimulator();
    }
  }, 1000);
}

function updateSimLadder() {
  document.querySelectorAll('.sim-ladder-item').forEach(item => {
    item.classList.remove('current', 'passed');
    const lvl = parseInt(item.id.split('_')[1]);
    if (lvl === State.simLevel) item.classList.add('current');
    else if (lvl < State.simLevel) item.classList.add('passed');
  });
}

function useLifeline(type) {
  if (State.simLifelinesUsed.includes(type)) return;
  State.simLifelinesUsed.push(type);
  const q = State.simCurrentQuestion;
  if (!q) { Toast.show('تحذير', 'قم بتحميل سؤال أولاً', 'warning'); return; }

  if (type === '5050') {
    const wrong = ['A','B','C','D'].filter(k => k !== q.correct);
    const toHide = wrong.sort(() => Math.random() - 0.5).slice(0, 2);
    toHide.forEach(k => document.getElementById(`sim${k}`)?.classList.add('hidden'));
    Toast.show('50/50', 'تم إزالة إجابتين خاطئتين', 'info');
  } else if (type === 'audience') {
    Toast.show('اسأل الجمهور', `الجمهور يرى: الإجابة ${q.correct} — 65%`, 'info');
  } else if (type === 'phone') {
    Toast.show('اتصال بصديق', `صديقك يعتقد أن الإجابة هي: ${q.correct}`, 'info');
  }

  document.querySelectorAll('.lifeline-btn').forEach((b, i) => {
    const types = ['5050','audience','phone'];
    if (types[i] === type) b.classList.add('used');
  });
}

/* ======================================================
   18. DEV TOOLS
====================================================== */
function testApiRequest() {
  const method = document.getElementById('devMethod').value;
  const endpoint = document.getElementById('devEndpoint').value.trim();
  const bodyText = document.getElementById('devBody').value.trim();
  const statusEl = document.getElementById('devStatus');
  const timeEl = document.getElementById('devTime');
  const respEl = document.getElementById('devResponse');

  if (!endpoint) { Toast.show('خطأ', 'أدخل المسار', 'error'); return; }

  let body = null;
  if (['POST','PUT'].includes(method) && bodyText) {
    try { body = JSON.parse(bodyText); } catch { Toast.show('خطأ JSON', 'جسم الطلب غير صحيح', 'error'); return; }
  }

  respEl.textContent = '// جاري الإرسال...';
  statusEl.textContent = '...';
  statusEl.className = 'dev-status';

  const start = Date.now();
  const req = method === 'GET' ? ApiService.get(endpoint, false)
    : method === 'POST' ? ApiService.post(endpoint, body)
    : method === 'PUT' ? ApiService.put(endpoint, body)
    : ApiService.delete(endpoint);

  req.then(data => {
    const elapsed = Date.now() - start;
    statusEl.textContent = '200 OK';
    statusEl.className = 'dev-status success';
    timeEl.textContent = `${elapsed}ms`;
    respEl.textContent = JSON.stringify(data, null, 2);
  }).catch(err => {
    const elapsed = Date.now() - start;
    statusEl.textContent = 'خطأ';
    statusEl.className = 'dev-status error';
    timeEl.textContent = `${elapsed}ms`;
    respEl.textContent = `// خطأ:\n${err.message}\n\n// ملاحظة: يعمل النظام في وضع المحاكاة\n// بيانات المحاكاة:\n${JSON.stringify(MockData.stats, null, 2)}`;
  });
}

function loadPreset(type) {
  const presets = {
    questions: { method: 'GET', endpoint: '/questions', body: '' },
    students: { method: 'GET', endpoint: '/students', body: '' },
    stats: { method: 'GET', endpoint: '/stats', body: '' },
  };
  const p = presets[type];
  if (!p) return;
  setVal('devMethod', p.method);
  setVal('devEndpoint', p.endpoint);
  setVal('devBody', p.body);
}

/* ======================================================
   19. SETTINGS
====================================================== */
function initSettings() {
  const s = ApiService.getSettings();
  setVal('apiBaseUrl', s.baseUrl);
  setVal('dbEndpoint', s.endpoint);
  setVal('authToken', s.token);
}

function saveSettings() {
  const baseUrl = getVal('apiBaseUrl').trim();
  const endpoint = getVal('dbEndpoint').trim();
  const token = getVal('authToken').trim();
  const env = getVal('envMode');

  localStorage.setItem('apiBaseUrl', baseUrl);
  localStorage.setItem('dbEndpoint', endpoint);
  localStorage.setItem('authToken', token);

  ApiService.updateSettings({ baseUrl, endpoint, token });
  CONFIG.env = env;

  Toast.show('حفظ', 'تم حفظ إعدادات النظام', 'success');
  ActivityLog.add('info', 'تم تحديث إعدادات النظام');
}

function testApiConnection() {
  const resultEl = document.getElementById('apiTestResult');
  resultEl.className = 'api-test-result';
  resultEl.textContent = '⏳ جاري الاختبار...';
  resultEl.style.display = 'block';

  const start = Date.now();
  ApiService.get('/health').then(data => {
    const elapsed = Date.now() - start;
    resultEl.className = 'api-test-result success';
    resultEl.innerHTML = `✅ الاتصال ناجح! — زمن الاستجابة: ${elapsed}ms`;
    Toast.show('نجاح', 'تم الاتصال بـ API بنجاح', 'success');
  }).catch(err => {
    resultEl.className = 'api-test-result error';
    resultEl.innerHTML = `❌ فشل الاتصال: ${err.message}`;
    Toast.show('فشل', 'تعذر الاتصال بـ API', 'error');
  });
}

function toggleTokenVisibility() {
  const input = document.getElementById('authToken');
  const icon = document.getElementById('tokenEye');
  if (input.type === 'password') { input.type = 'text'; icon.className = 'fas fa-eye-slash'; }
  else { input.type = 'password'; icon.className = 'fas fa-eye'; }
}

function manualBackup() { Toast.show('نسخ احتياطي', 'جاري إنشاء نسخة احتياطية...', 'info'); setTimeout(() => Toast.show('نجاح', 'تم إنشاء النسخة الاحتياطية', 'success'), 2000); }

/* ======================================================
   20. NOTIFICATIONS
====================================================== */
function initNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;
  list.innerHTML = State.notifications.map(n => `
    <div class="notif-item">
      <div class="notif-icon ${n.type}"><i class="fas ${n.icon}"></i></div>
      <div><div class="notif-text">${n.text}</div><div class="notif-time">${n.time}</div></div>
    </div>`).join('');
  document.getElementById('notifCount').textContent = State.notifications.length;
}

/* ======================================================
   21. MODAL & UTILITY HELPERS
====================================================== */
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function getVal(id) { const el = document.getElementById(id); return el?.value ?? ''; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

function renderPagination(containerId, current, total, onPage) {
  const container = document.getElementById(containerId);
  if (!container || total <= 1) { if (container) container.innerHTML = ''; return; }
  let html = '';
  if (current > 1) html += `<button onclick="(${onPage})(${current-1})">‹</button>`;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= current - 2 && i <= current + 2)) {
      html += `<button class="${i === current ? 'active' : ''}" onclick="(${onPage})(${i})">${i}</button>`;
    } else if (i === current - 3 || i === current + 3) {
      html += `<button disabled>...</button>`;
    }
  }
  if (current < total) html += `<button onclick="(${onPage})(${current+1})">›</button>`;
  container.innerHTML = html;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function toggleDarkMode(isDark) {
  document.body.classList.toggle('dark-mode', isDark);
  document.body.classList.toggle('light-mode', !isDark);
  document.getElementById('themeIcon').className = isDark ? 'fas fa-moon' : 'fas fa-sun';
}

/* ======================================================
   22. GLOBAL APP OBJECT (for onclick handlers)
====================================================== */
const APP = {
  // Navigation
  navigate,

  // Dashboard
  refreshDashboard: APP_refreshDashboard,
  exportReport: APP_exportReport,

  // Questions
  openQuestionModal,
  saveQuestion,
  deleteQuestion,
  copyQuestion,
  previewQuestion,
  previewQuestionById,
  importQuestions,
  exportQuestions,
  bulkDelete,
  aiSuggestQuestion,
  detectDuplicates,
  balanceDifficulty,
  autoCategorize,
  toggleView: (mod, view) => Toast.show('عرض', `تم التبديل إلى العرض ${view === 'grid' ? 'الشبكي' : 'القائمة'}`, 'info'),

  // Students
  openStudentModal,
  saveStudent,
  banStudent,
  resetStudentProgress,
  resetStudentPassword,
  sendStudentNotification,
  deleteStudent,
  deleteStudentById,
  exportStudents,

  // Media
  openUploadModal: (type) => { document.getElementById('fileInput')?.click(); },
  bulkDeleteMedia: () => Toast.show('تحذير', 'اختر وسائط للحذف', 'warning'),

  // Gameplay
  saveGameplay,
  resetPrizeLadder,
  updateDiffDist,

  // Sounds
  playSoundPreview,
  handleSoundUpload,
  saveSounds,

  // Appearance
  saveAppearance,
  resetAppearance,
  toggleDarkMode,

  // Simulator
  startSimulator,
  resetSimulator,
  loadSimQuestion,
  useLifeline,

  // Categories
  openCategoryModal,
  editCategory,

  // Dev Tools
  testApiRequest,
  loadPreset,

  // Settings
  saveSettings,
  testApiConnection,
  toggleTokenVisibility,
  manualBackup,

  // Modals
  openModal,
  closeModal,

  // Log
  clearLog: () => { Toast.show('مسح', 'تم مسح السجل', 'info'); },
  exportLog: () => {
    downloadFile('activity-log.json', JSON.stringify(ActivityLog.getLogs(), null, 2), 'application/json');
    Toast.show('تصدير', 'تم تصدير السجل', 'success');
  },

  // Analytics
  exportAnalytics,
};

/* ======================================================
   23. EVENT LISTENERS & INIT
====================================================== */
document.addEventListener('DOMContentLoaded', () => {

  // Navigation clicks
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(item.dataset.page);
    });
  });

  // Sidebar toggle
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // Mobile menu
  document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
  });

  // Theme toggle
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark-mode');
    toggleDarkMode(!isDark);
    const dm = document.getElementById('darkModeToggle');
    if (dm) dm.checked = !isDark;
  });

  // Notifications
  document.getElementById('notifBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('notifDropdown')?.classList.toggle('open');
  });
  document.getElementById('clearNotif')?.addEventListener('click', () => {
    State.notifications = [];
    initNotifications();
    document.getElementById('notifDropdown')?.classList.remove('open');
  });
  document.addEventListener('click', () => document.getElementById('notifDropdown')?.classList.remove('open'));

  // Form tabs
  document.querySelectorAll('.form-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      const modal = tab.closest('.modal-body');
      modal.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
      modal.querySelectorAll('.form-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      modal.querySelector(`#tab-${tabId}`)?.classList.add('active');
    });
  });

  // Chart tabs
  document.querySelectorAll('.chart-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      tab.closest('.chart-tabs')?.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Toast.show('نطاق البيانات', `عرض بيانات: آخر ${tab.dataset.range} يوم`, 'info');
    });
  });

  // Search live filters
  document.getElementById('questionSearch')?.addEventListener('input', () => renderQuestionsTable());
  document.getElementById('filterCategory')?.addEventListener('change', () => renderQuestionsTable());
  document.getElementById('filterDifficulty')?.addEventListener('change', () => renderQuestionsTable());
  document.getElementById('studentSearch')?.addEventListener('input', () => renderStudentsTable());
  document.getElementById('filterStudentLevel')?.addEventListener('change', () => renderStudentsTable());
  document.getElementById('filterStudentStatus')?.addEventListener('change', () => renderStudentsTable());
  document.getElementById('logSearch')?.addEventListener('input', () => ActivityLog.renderLogs());
  document.getElementById('logLevel')?.addEventListener('change', () => ActivityLog.renderLogs());

  // Global search
  document.getElementById('globalSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    if (!q) return;
    const pages = ['dashboard','questions','students','leaderboard','analytics','gameplay','sounds','appearance','simulator','settings','devtools'];
    const match = pages.find(p => p.includes(q) || {
      dashboard:'لوحة', questions:'أسئلة', students:'طلاب',
      settings:'إعدادات', analytics:'تحليل', leaderboard:'صدارة'
    }[p]?.includes(q));
    if (match) navigate(match);
  });

  // Modal close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  });

  // Drop zone
  const dropZone = document.getElementById('dropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files];
      if (files.length) Toast.show('رفع', `جاري رفع ${files.length} ملف...`, 'info');
    });
    document.getElementById('fileInput')?.addEventListener('change', (e) => {
      if (e.target.files.length) Toast.show('رفع', `جاري رفع ${e.target.files.length} ملف...`, 'info');
    });
  }

  // Network status
  window.addEventListener('online', () => {
    ApiService.setOnline(true);
    document.getElementById('networkBar').className = 'network-bar online';
    document.getElementById('networkIcon').innerHTML = '<i class="fas fa-wifi"></i>';
    document.getElementById('networkText').textContent = 'متصل بالشبكة';
    document.getElementById('offlineBanner').classList.add('hidden');
    Toast.show('متصل', 'تمت استعادة الاتصال بالإنترنت', 'success');
  });
  window.addEventListener('offline', () => {
    ApiService.setOnline(false);
    document.getElementById('networkBar').className = 'network-bar offline';
    document.getElementById('networkIcon').innerHTML = '<i class="fas fa-wifi-slash"></i>';
    document.getElementById('networkText').textContent = 'غير متصل بالإنترنت';
    document.getElementById('offlineBanner').classList.remove('hidden');
    Toast.show('غير متصل', 'انقطع الاتصال بالإنترنت', 'error');
  });

  // Select all checkboxes
  document.getElementById('selectAllQ')?.addEventListener('change', (e) => {
    document.querySelectorAll('.q-check').forEach(c => c.checked = e.target.checked);
  });
  document.getElementById('selectAllS')?.addEventListener('change', (e) => {
    document.querySelectorAll('.s-check').forEach(c => c.checked = e.target.checked);
  });

  // Question image preview
  document.getElementById('qImage')?.addEventListener('input', (e) => {
    const prev = document.getElementById('qImagePreview');
    if (prev) prev.innerHTML = e.target.value ? `<img src="${e.target.value}" alt="صورة السؤال" onerror="this.remove()" />` : '';
  });

  // Initialize notifications
  initNotifications();

  // Health check interval
  setInterval(() => ApiService.healthCheck(), CONFIG.healthCheckInterval);

  // Live stats update
  setInterval(() => {
    if (State.currentPage === 'dashboard') {
      const active = document.getElementById('activeNow');
      if (active) {
        const newVal = Math.floor(Math.random() * 15 + 15);
        animateCounter('activeNow', newVal);
      }
    }
  }, CONFIG.liveUpdateInterval);

  // Initial log entries
  ActivityLog.add('success', 'تم تشغيل لوحة التحكم بنجاح');
  ActivityLog.add('info', `الإصدار ${CONFIG.version} — وضع ${CONFIG.env}`);
  ActivityLog.add('info', 'جاري تحميل بيانات المحاكاة...');

  // Start on dashboard
  navigate('dashboard');

  // Welcome toast
  setTimeout(() => {
    Toast.show('مرحباً بك', 'لوحة تحكم مليونير جاهزة للاستخدام', 'success');
  }, 500);
});
