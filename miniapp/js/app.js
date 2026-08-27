/**
 * RocketCash Mini App — Frontend Application
 * All user features happen inside this Mini App.
 * Never trusts balance/userId from frontend — all come from server.
 */

const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.enableClosingConfirmation();

// ─── STATE ────────────────────────────────────────────────────
const state = {
  sessionToken: null,
  user: null,
  wallet: null,
  config: null,
  currentPage: 'home',
  spinStatus: null,
  spinRotation: 0,
  isSpinning: false,
};

// ─── API CLIENT ───────────────────────────────────────────────
const API_BASE = '/api';

async function apiRequest(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.sessionToken) headers['Authorization'] = `Bearer ${state.sessionToken}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'Request failed'), { status: res.status, code: data.error });
    return data;
  } catch (err) {
    if (!err.status) throw new Error('Network error — check connection');
    throw err;
  }
}

const api = {
  auth: (initData, signals) => apiRequest('POST', '/auth/telegram', { initData, signals }),
  me: () => apiRequest('GET', '/me'),
  config: () => apiRequest('GET', '/config'),
  wallet: () => apiRequest('GET', '/wallet'),
  spinStatus: () => apiRequest('GET', '/spins/status'),
  playSpin: () => apiRequest('POST', '/spins/play'),
  tasks: () => apiRequest('GET', '/tasks'),
  startTask: (id) => apiRequest('POST', `/tasks/${id}/start`),
  referral: () => apiRequest('GET', '/referral'),
  history: (limit, offset) => apiRequest('GET', `/history?limit=${limit}&offset=${offset}`),
  withdrawals: () => apiRequest('GET', '/withdrawals'),
  createWithdrawal: (data) => apiRequest('POST', '/withdrawals', data),
  ifscSearch: (ifsc) => apiRequest('GET', `/ifsc/search?ifsc=${encodeURIComponent(ifsc)}`),
  validateUPI: (upiId) => apiRequest('POST', '/payment/validate-upi', { upiId }),
};

// ─── INIT ─────────────────────────────────────────────────────
async function init() {
  try {
    const initData = tg.initData;
    if (!initData) { showError('Open via Telegram Bot to use RocketCash.'); return; }

    const signals = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      screenInfo: `${screen.width}x${screen.height}`,
      installationId: getInstallationId(),
    };

    const authResult = await api.auth(initData, signals);
    state.sessionToken = authResult.sessionToken;

    // Load user data and config in parallel
    const [meData, configData] = await Promise.all([api.me(), api.config()]);
    state.user = meData;
    state.wallet = meData.wallet;
    state.config = configData;

    if (configData.maintenanceMode) {
      showMaintenance();
      return;
    }

    showApp();
    setupNavigation();
    navigateTo('home');

  } catch (err) {
    console.error('Init failed:', err);
    showError(`Unable to connect to RocketCash.\n${err.message}`);
  }
}

function getInstallationId() {
  let id = localStorage.getItem('rc_install_id');
  if (!id) { id = Math.random().toString(36).substr(2, 16); localStorage.setItem('rc_install_id', id); }
  return id;
}

// ─── UI CONTROL ───────────────────────────────────────────────
function showApp() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
}

function showMaintenance() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('maintenance-screen').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('loading-screen').innerHTML = `
    <div style="text-align:center;padding:32px;color:#fff">
      <div style="font-size:52px;margin-bottom:16px">😓</div>
      <h2>Something went wrong</h2>
      <p style="color:#9999BB;margin-top:12px;white-space:pre-line;font-size:14px">${msg}</p>
      <button onclick="location.reload()" style="margin-top:24px;padding:12px 28px;background:#FF6B35;color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Retry</button>
    </div>`;
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> <span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function showModal(title, content, actions = []) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  box.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div class="modal-title">${title}</div>
    <div class="modal-content">${content}</div>
    ${actions.map(a => `<button class="btn ${a.class || 'btn-secondary'}" style="margin-top:10px" onclick="${a.onclick}">${a.label}</button>`).join('')}
  `;
  overlay.classList.remove('hidden');
}

window.closeModal = () => document.getElementById('modal-overlay').classList.add('hidden');

// ─── NAVIGATION ───────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
}

function navigateTo(page) {
  state.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const pages = { home: renderHome, tasks: renderTasks, spin: renderSpin, invite: renderInvite, cashout: renderCashout };
  const render = pages[page];
  if (render) { const el = document.getElementById('page-content'); el.innerHTML = ''; render(); }
}

function setContent(html) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="page-enter">${html}</div>`;
}

function fmt(paise) {
  const r = Math.floor(paise / 100), p = paise % 100;
  return `₹${r}.${String(p).padStart(2, '0')}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── HOME PAGE ────────────────────────────────────────────────
async function renderHome() {
  const w = state.wallet;
  const u = state.user;

  setContent(`
    <div class="balance-card">
      <div class="balance-label">Total Balance</div>
      <div class="balance-amount" id="home-balance">${fmt(w.balance)}</div>
      <div class="balance-sub">
        <div class="balance-sub-item">Today: <span id="home-today">${fmt(w.todayEarned)}</span></div>
        <div class="balance-sub-item">Pending: <span>${fmt(w.pendingRewards)}</span></div>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">📈</div>
        <div class="stat-label">Total Earned</div>
        <div class="stat-value">${fmt(w.totalEarned)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📤</div>
        <div class="stat-label">Withdrawn</div>
        <div class="stat-value">${fmt(w.totalWithdrawn)}</div>
      </div>
    </div>
    <div class="section-header">
      <div class="section-title">Quick Actions</div>
    </div>
    <div class="action-grid">
      <button class="action-btn" onclick="navigateTo('tasks')">
        <span class="action-btn-icon">🎯</span>
        <span class="action-btn-label">EARN NOW</span>
      </button>
      <button class="action-btn" onclick="navigateTo('spin')">
        <span class="action-btn-icon">🎡</span>
        <span class="action-btn-label">SPIN</span>
      </button>
      <button class="action-btn" onclick="navigateTo('cashout')">
        <span class="action-btn-icon">💰</span>
        <span class="action-btn-label">CASH OUT</span>
      </button>
    </div>
    <div class="section-header" style="margin-top:20px">
      <div class="section-title">📜 Recent Activity</div>
      <span class="section-action" onclick="showHistoryModal()">See All</span>
    </div>
    <div id="recent-tx">
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
    </div>
  `);

  // Load recent transactions
  api.history(5, 0).then(data => {
    const el = document.getElementById('recent-tx');
    if (!el) return;
    if (!data.transactions.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">No transactions yet</div><div class="empty-desc">Complete tasks or spin to earn!</div></div>`;
      return;
    }
    el.innerHTML = data.transactions.map(tx => renderTxItem(tx)).join('');
  }).catch(() => {});
}

function renderTxItem(tx) {
  const isCredit = !tx.type.includes('HOLD') && !tx.type.includes('DEBIT');
  const icons = { TASK_REWARD: '🎯', SURVEY_REWARD: '📋', SPIN_REWARD: '🎡', REFERRAL_REWARD: '👥', SIGNUP_BONUS: '🎁', WITHDRAWAL_HOLD: '💸', WITHDRAWAL_DEBIT: '🏦', WITHDRAWAL_REVERSAL: '↩️', ADMIN_CREDIT: '💰' };
  const icon = icons[tx.type] || '💫';
  const labels = { TASK_REWARD: 'Task Reward', SURVEY_REWARD: 'Survey Reward', SPIN_REWARD: 'Spin Reward', REFERRAL_REWARD: 'Referral Bonus', SIGNUP_BONUS: 'Welcome Bonus', WITHDRAWAL_HOLD: 'Withdrawal Pending', WITHDRAWAL_DEBIT: 'Withdrawal', WITHDRAWAL_REVERSAL: 'Refund' };
  return `
    <div class="tx-item">
      <div class="tx-left">
        <div class="tx-icon ${isCredit ? 'credit' : 'debit'}">${icon}</div>
        <div>
          <div class="tx-desc">${labels[tx.type] || tx.type}</div>
          <div class="tx-date">${formatDate(tx.createdAt)}</div>
        </div>
      </div>
      <div>
        <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">${isCredit ? '+' : '-'}${tx.amountFormatted}</div>
        <div class="tx-status">${tx.status}</div>
      </div>
    </div>`;
}

async function showHistoryModal() {
  showModal('📜 Transaction History', '<div id="history-modal-content"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>');
  const data = await api.history(30, 0).catch(() => ({ transactions: [] }));
  const el = document.getElementById('history-modal-content');
  if (!el) return;
  el.innerHTML = data.transactions.length
    ? data.transactions.map(renderTxItem).join('')
    : '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">No transactions yet</div></div>';
}

// ─── TASKS PAGE ───────────────────────────────────────────────
async function renderTasks() {
  setContent(`
    <div class="section-header">
      <div class="section-title">🎯 Available Tasks</div>
    </div>
    <p style="color:var(--text2);font-size:13px;margin-bottom:16px">Complete real surveys and offers to earn rewards. Rewards are credited after verified completion.</p>
    <div id="tasks-list">
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-line"></div>
    </div>
  `);

  try {
    const data = await api.tasks();
    const el = document.getElementById('tasks-list');
    if (!el) return;

    if (data.surveyUrl) {
      el.innerHTML = `
        <div class="card card-glass" style="margin-bottom:16px">
          <div style="font-size:22px;margin-bottom:8px">📋 Surveys Available</div>
          <p style="color:var(--text2);font-size:13px;margin-bottom:14px">Take real surveys and earn cash rewards. New surveys added daily!</p>
          <button class="btn btn-primary" onclick="openSurveys('${data.surveyUrl}')">🎯 Start Earning</button>
        </div>
        ${(data.tasks || []).slice(0, 5).map(task => `
          <div class="task-card">
            <div class="task-icon">📝</div>
            <div class="task-info">
              <div class="task-title">${task.title || 'Survey'}</div>
              <div class="task-reward">${task.value ? fmt(Math.round(parseFloat(task.value) * 100)) : 'Variable'}</div>
              <div class="task-meta">${task.type || 'Survey'}</div>
            </div>
            <button class="task-btn" onclick="openSurveys('${data.surveyUrl}')">Start</button>
          </div>
        `).join('')}
      `;
    } else {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔌</div><div class="empty-title">Tasks Coming Soon</div><div class="empty-desc">Task provider is being configured. Check back soon!</div></div>`;
    }
  } catch {
    document.getElementById('tasks-list').innerHTML = `<div class="empty-state"><div class="empty-icon">😓</div><div class="empty-title">Failed to load tasks</div></div>`;
  }
}

window.openSurveys = (url) => {
  tg.openLink(url);
};

// ─── SPIN PAGE ────────────────────────────────────────────────
async function renderSpin() {
  setContent(`
    <div class="spin-container">
      <div>
        <h2 style="text-align:center;font-size:22px;font-weight:800">🎡 Daily Spin</h2>
        <p style="color:var(--text2);font-size:13px;text-align:center;margin-top:6px">Spin the wheel for a chance to win!</p>
      </div>
      <div class="spin-wheel-wrapper">
        <div class="spin-pointer">▼</div>
        <div class="spin-wheel" id="spin-wheel">
          <div class="spin-center">🚀</div>
        </div>
      </div>
      <div class="spin-info">
        <div id="spin-status-text" class="spin-count">Loading...</div>
      </div>
      <button id="spin-btn" class="btn btn-primary" onclick="doSpin()" disabled style="max-width:260px;width:100%">
        🎡 SPIN NOW
      </button>
      <div id="spin-result" style="text-align:center;min-height:60px"></div>
    </div>
  `);

  try {
    const status = await api.spinStatus();
    state.spinStatus = status;
    updateSpinUI(status);
  } catch {
    document.getElementById('spin-status-text').textContent = 'Failed to load spin status';
  }
}

function updateSpinUI(status) {
  const btn = document.getElementById('spin-btn');
  const txt = document.getElementById('spin-status-text');
  if (!btn || !txt) return;

  if (!status.enabled) {
    txt.textContent = '🎡 Spin temporarily unavailable.';
    btn.disabled = true;
    btn.textContent = '🚫 Unavailable';
    return;
  }

  if (status.spinsLeft <= 0) {
    txt.innerHTML = `<strong>Aaj ke spins khatam 🎯</strong><br><span style="font-size:12px;color:var(--text2)">Resets at midnight IST</span>`;
    btn.disabled = true;
    btn.textContent = '⏰ Come Back Tomorrow';
    return;
  }

  txt.innerHTML = `Spins Left Today: <strong>${status.spinsLeft} / ${status.dailyLimit}</strong>`;
  btn.disabled = false;
  btn.textContent = '🎡 SPIN NOW';
}

async function doSpin() {
  if (state.isSpinning) return;
  state.isSpinning = true;

  const btn = document.getElementById('spin-btn');
  const resultEl = document.getElementById('spin-result');
  const wheel = document.getElementById('spin-wheel');
  btn.disabled = true;
  btn.textContent = '🎡 Spinning...';
  if (resultEl) resultEl.innerHTML = '';

  // Animate wheel
  const extraSpins = (Math.floor(Math.random() * 5) + 5) * 360;
  const finalAngle = state.spinRotation + extraSpins + Math.floor(Math.random() * 360);
  state.spinRotation = finalAngle;
  if (wheel) wheel.style.transform = `rotate(${finalAngle}deg)`;

  try {
    // Wait for animation then get result
    await new Promise(r => setTimeout(r, 3200));
    const result = await api.playSpin();

    // Update wallet state
    state.wallet = { ...state.wallet, balance: result.balancePaise };

    if (resultEl) {
      resultEl.innerHTML = `
        <div style="animation:slideUp 0.5s ease">
          <div style="font-size:36px;font-weight:800;color:var(--accent)">+${result.rewardFormatted}</div>
          <div style="color:var(--text2);font-size:13px;margin-top:4px">Balance: ${result.balanceFormatted}</div>
        </div>`;
    }

    showToast(`🎉 You won ${result.rewardFormatted}!`, 'success');

    // Update spin status
    const status = await api.spinStatus();
    state.spinStatus = status;
    updateSpinUI(status);

  } catch (err) {
    if (wheel) { wheel.style.transform = `rotate(${state.spinRotation - extraSpins}deg)`; state.spinRotation -= extraSpins; }
    if (err.code === 'DAILY_LIMIT_REACHED') {
      showToast('Aaj ke spins khatam 🎯', 'warning');
      updateSpinUI({ ...state.spinStatus, spinsLeft: 0 });
    } else if (err.code === 'SPIN_DISABLED') {
      showToast('Spin temporarily unavailable', 'error');
    } else {
      showToast(err.message || 'Spin failed', 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = '🎡 SPIN NOW'; }
  }

  state.isSpinning = false;
}

// ─── INVITE PAGE ──────────────────────────────────────────────
async function renderInvite() {
  setContent(`<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div>`);

  try {
    const data = await api.referral();

    if (!data.eligible) {
      setContent(`
        <div class="empty-state">
          <div class="empty-icon">🔒</div>
          <div class="empty-title">Referral Unavailable</div>
          <div class="empty-desc">${data.reason || 'Referral feature is unavailable for this account.'}</div>
        </div>
      `);
      return;
    }

    const s = data.stats;
    setContent(`
      <div class="section-header">
        <div class="section-title">👥 Invite Friends</div>
      </div>
      <div class="referral-code-box">
        <div style="font-size:13px;color:var(--text2)">Your Referral Code</div>
        <div class="ref-code">${data.referralCode}</div>
        <div style="font-size:12px;color:var(--text2)">Share your link to earn rewards</div>
      </div>
      <button class="btn btn-primary" style="margin-bottom:10px" onclick="copyReferralLink('${data.referralLink}')">
        🔗 COPY REFERRAL LINK
      </button>
      <button class="btn btn-secondary" style="margin-bottom:20px" onclick="shareReferral('${data.referralLink}')">
        📤 SHARE
      </button>
      <div class="ref-stats">
        <div class="ref-stat">
          <div class="ref-stat-label">Total</div>
          <div class="ref-stat-value">${s.total_referrals || 0}</div>
        </div>
        <div class="ref-stat">
          <div class="ref-stat-label">Valid</div>
          <div class="ref-stat-value">${s.valid_referrals || 0}</div>
        </div>
        <div class="ref-stat">
          <div class="ref-stat-label">Earned</div>
          <div class="ref-stat-value">${fmt(parseInt(s.total_earnings_paise || 0))}</div>
        </div>
      </div>
      <div class="card" style="margin-top:8px">
        <div style="font-size:14px;color:var(--text2);line-height:1.7">
          💡 <strong>How it works:</strong><br>
          1. Share your referral link<br>
          2. Friend joins RocketCash<br>
          3. They complete a qualifying activity<br>
          4. You earn ${fmt(state.config?.referralRewardPaise || 5000)}!
        </div>
      </div>
      ${data.recentReferrals?.length ? `
        <div class="section-header" style="margin-top:16px">
          <div class="section-title">Recent Referrals</div>
        </div>
        ${data.recentReferrals.map(r => `
          <div class="tx-item">
            <div class="tx-left">
              <div class="tx-icon credit">👤</div>
              <div>
                <div class="tx-desc">${r.first_name}${r.username ? ' @' + r.username : ''}</div>
                <div class="tx-date">${formatDate(r.created_at)}</div>
              </div>
            </div>
            <div><span class="badge ${r.is_valid ? 'badge-success' : 'badge-warning'}">${r.is_valid ? '✅ Valid' : '⏳ Pending'}</span></div>
          </div>`).join('')}
      ` : ''}
    `);
  } catch (err) {
    setContent(`<div class="empty-state"><div class="empty-icon">😓</div><div class="empty-title">Failed to load</div><div class="empty-desc">${err.message}</div></div>`);
  }
}

window.copyReferralLink = async (link) => {
  try { await navigator.clipboard.writeText(link); showToast('✅ Referral link copied!', 'success'); }
  catch { showToast('Copy: ' + link, 'info'); }
};

window.shareReferral = (link) => {
  tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join RocketCash and earn rewards! 🚀')}`);
};

// ─── CASHOUT PAGE ─────────────────────────────────────────────
async function renderCashout() {
  setContent(`<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div>`);

  try {
    const [walletData, wdData] = await Promise.all([api.wallet(), api.withdrawals()]);
    const s = wdData.settings;

    setContent(`
      <div class="cashout-balance">
        <div class="label">Available Balance</div>
        <div class="amount">${fmt(walletData.balancePaise)}</div>
      </div>
      <div class="withdrawal-limit-info">
        <div class="limit-item">
          <div class="limit-label">Today's Used</div>
          <div class="limit-value">${s.todayCount} / ${s.dailyLimit}</div>
        </div>
        <div class="limit-item">
          <div class="limit-label">Min</div>
          <div class="limit-value">${fmt(s.minPaise)}</div>
        </div>
        <div class="limit-item">
          <div class="limit-label">Max</div>
          <div class="limit-value">${fmt(s.maxPaise)}</div>
        </div>
      </div>
      ${!s.withdrawalEnabled ? '<div class="card" style="text-align:center;color:var(--text2)">💤 Withdrawals are currently disabled.</div>' : s.spaceLeft <= 0 ? '<div class="card" style="text-align:center;color:var(--warning)">⚠️ Daily withdrawal limit reached. Try again tomorrow.</div>' : `
        <div class="method-tabs">
          ${s.bankEnabled ? '<button class="method-tab active" id="tab-bank" onclick="switchTab(\'bank\')">🏦 Bank</button>' : ''}
          ${s.upiEnabled ? '<button class="method-tab ${!s.bankEnabled ? 'active' : ''}" id="tab-upi" onclick="switchTab(\'upi\')">📱 UPI</button>' : ''}
        </div>
        <div id="bank-form">${s.bankEnabled ? renderBankForm(s) : ''}</div>
        <div id="upi-form" class="hidden">${s.upiEnabled ? renderUPIForm(s) : ''}</div>
      `}
      ${wdData.withdrawals.length ? `
        <div class="section-header" style="margin-top:20px">
          <div class="section-title">Recent Withdrawals</div>
        </div>
        ${wdData.withdrawals.slice(0, 5).map(renderWithdrawalItem).join('')}
      ` : ''}
    `);
  } catch (err) {
    setContent(`<div class="empty-state"><div class="empty-icon">😓</div><div class="empty-title">Failed to load</div><div class="empty-desc">${err.message}</div></div>`);
  }
}

function renderBankForm(s) {
  return `
    <div id="bank-form-inner">
      <div class="form-group">
        <label class="form-label">Account Holder Name</label>
        <input type="text" class="form-input" id="holder-name" placeholder="Full name as on bank account" />
      </div>
      <div class="form-group">
        <label class="form-label">Bank Account Number</label>
        <input type="text" class="form-input" id="account-number" placeholder="Enter account number" inputmode="numeric" />
      </div>
      <div class="form-group">
        <label class="form-label">Confirm Account Number</label>
        <input type="text" class="form-input" id="confirm-account" placeholder="Re-enter account number" inputmode="numeric" />
      </div>
      <div class="form-group">
        <label class="form-label">IFSC Code</label>
        <div style="display:flex;gap:8px">
          <input type="text" class="form-input" id="ifsc-code" placeholder="e.g. SBIN0001234" style="text-transform:uppercase;flex:1" oninput="this.value=this.value.toUpperCase()" />
          <button class="btn btn-secondary" style="width:auto;padding:13px 14px" onclick="verifyIFSC()">Verify</button>
        </div>
        <div id="ifsc-result" style="font-size:12px;color:var(--success);margin-top:4px"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Account Type</label>
        <select class="form-select" id="account-type">
          <option value="SAVINGS">Savings</option>
          <option value="CURRENT">Current</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Amount</label>
        <div style="position:relative">
          <span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:18px;color:var(--text2)">₹</span>
          <input type="number" class="form-input" id="bank-amount" placeholder="0.00" min="${s.minPaise/100}" max="${s.maxPaise/100}" step="1" style="padding-left:36px" inputmode="decimal" />
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Min: ${fmt(s.minPaise)} · Max: ${fmt(s.maxPaise)}</div>
      </div>
      <button class="btn btn-primary" onclick="submitBankWithdrawal()">💸 WITHDRAW</button>
    </div>`;
}

function renderUPIForm(s) {
  return `
    <div id="upi-form-inner">
      <div class="form-group">
        <label class="form-label">UPI ID</label>
        <div style="display:flex;gap:8px">
          <input type="text" class="form-input" id="upi-id" placeholder="yourname@upi" style="flex:1" />
          <button class="btn btn-secondary" style="width:auto;padding:13px 14px" onclick="verifyUPI()">Verify</button>
        </div>
        <div id="upi-result" style="font-size:12px;margin-top:4px"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Amount</label>
        <div style="position:relative">
          <span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:18px;color:var(--text2)">₹</span>
          <input type="number" class="form-input" id="upi-amount" placeholder="0.00" min="${s.minPaise/100}" max="${s.maxPaise/100}" step="1" style="padding-left:36px" inputmode="decimal" />
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Min: ${fmt(s.minPaise)} · Max: ${fmt(s.maxPaise)}</div>
      </div>
      <button class="btn btn-primary" onclick="submitUPIWithdrawal()">💸 WITHDRAW</button>
    </div>`;
}

function renderWithdrawalItem(w) {
  const statusBadge = { PENDING: 'badge-warning', PROCESSING: 'badge-info', SUCCESS: 'badge-success', FAILED: 'badge-danger', REVERSED: 'badge-warning', REJECTED: 'badge-danger' };
  const dest = w.method === 'BANK' ? `🏦 ••••${w.accountLast4}` : `📱 ${w.upiId}`;
  return `
    <div class="tx-item">
      <div class="tx-left">
        <div class="tx-icon debit">💸</div>
        <div>
          <div class="tx-desc">${dest}</div>
          <div class="tx-date">${formatDate(w.createdAt)}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="tx-amount debit">-${w.amountFormatted}</div>
        <span class="badge ${statusBadge[w.status] || 'badge-info'}">${w.status}</span>
      </div>
    </div>`;
}

window.switchTab = (tab) => {
  document.getElementById('bank-form')?.classList.toggle('hidden', tab !== 'bank');
  document.getElementById('upi-form')?.classList.toggle('hidden', tab !== 'upi');
  document.getElementById('tab-bank')?.classList.toggle('active', tab === 'bank');
  document.getElementById('tab-upi')?.classList.toggle('active', tab === 'upi');
};

window.verifyIFSC = async () => {
  const code = document.getElementById('ifsc-code')?.value?.toUpperCase();
  if (!code || code.length < 11) { showToast('Enter complete IFSC code', 'warning'); return; }
  const el = document.getElementById('ifsc-result');
  el.textContent = 'Verifying...'; el.style.color = 'var(--text2)';
  try {
    const r = await api.ifscSearch(code);
    if (r.valid) { el.textContent = `✅ ${r.bank} — ${r.branch}`; el.style.color = 'var(--success)'; }
    else { el.textContent = '❌ Invalid IFSC code'; el.style.color = 'var(--danger)'; }
  } catch { el.textContent = '⚠️ Could not verify — proceed manually'; el.style.color = 'var(--warning)'; }
};

window.verifyUPI = async () => {
  const id = document.getElementById('upi-id')?.value;
  const el = document.getElementById('upi-result');
  el.textContent = 'Verifying...'; el.style.color = 'var(--text2)';
  try {
    const r = await api.validateUPI(id);
    if (r.valid) { el.textContent = '✅ Valid UPI format'; el.style.color = 'var(--success)'; }
    else { el.textContent = '❌ Invalid UPI ID format'; el.style.color = 'var(--danger)'; }
  } catch { el.textContent = '⚠️ Could not verify'; }
};

window.submitBankWithdrawal = async () => {
  const btn = document.querySelector('#bank-form-inner .btn-primary');
  const holderName = document.getElementById('holder-name')?.value?.trim();
  const accountNumber = document.getElementById('account-number')?.value?.trim();
  const confirmAccount = document.getElementById('confirm-account')?.value?.trim();
  const ifscCode = document.getElementById('ifsc-code')?.value?.trim()?.toUpperCase();
  const accountType = document.getElementById('account-type')?.value;
  const amountRupees = parseFloat(document.getElementById('bank-amount')?.value);

  if (!holderName || !accountNumber || !confirmAccount || !ifscCode || isNaN(amountRupees)) { showToast('Fill all fields', 'warning'); return; }
  if (accountNumber !== confirmAccount) { showToast('Account numbers do not match', 'error'); return; }

  const amountPaise = Math.round(amountRupees * 100);

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processing...'; }
  try {
    await api.createWithdrawal({ method: 'BANK', holderName, accountNumber, confirmAccountNumber: confirmAccount, ifscCode, accountType, amountPaise });
    showToast('✅ Withdrawal request submitted!', 'success');
    await renderCashout();
  } catch (err) {
    showToast(err.message || 'Withdrawal failed', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💸 WITHDRAW'; }
  }
};

window.submitUPIWithdrawal = async () => {
  const btn = document.querySelector('#upi-form-inner .btn-primary');
  const upiId = document.getElementById('upi-id')?.value?.trim();
  const amountRupees = parseFloat(document.getElementById('upi-amount')?.value);

  if (!upiId || isNaN(amountRupees)) { showToast('Fill all fields', 'warning'); return; }
  const amountPaise = Math.round(amountRupees * 100);

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processing...'; }
  try {
    await api.createWithdrawal({ method: 'UPI', upiId, amountPaise });
    showToast('✅ Withdrawal request submitted!', 'success');
    await renderCashout();
  } catch (err) {
    showToast(err.message || 'Withdrawal failed', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💸 WITHDRAW'; }
  }
};

// ─── START ─────────────────────────────────────────────────────
init();
