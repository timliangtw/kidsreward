import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFirestore, collection, doc, setDoc, getDocs, onSnapshot, getDoc, deleteDoc, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const APP_VERSION = "2025-12-16 23:25";

const firebaseConfig = {
    apiKey: "AIzaSyDY2SKqPdeB181tALUJE1jr9BtAHN3wUdw",
    authDomain: "familypoints-a51f1.firebaseapp.com",
    projectId: "familypoints-a51f1",
    storageBucket: "familypoints-a51f1.firebasestorage.app",
    messagingSenderId: "1087519864570",
    appId: "1:1087519864570:web:d64e17a153109664b23b43"
};

let app, db, auth;
let unsubscribeKids = null;
let unsubscribeRules = null;
let unsubscribeBackup = null;
let isDataSynced = false; // Lock flag

const dbStatusEl = document.getElementById('db-status');
const versionEl = document.getElementById('version-display');
const updateBanner = document.getElementById('update-banner');

var STORAGE_KEY = 'family_points_data_v11';
var FAMILY_ID_KEY = 'family_points_id';

var currentFamilyId = localStorage.getItem(FAMILY_ID_KEY) || null;
var backupSettings = { cycle: 7, lastBackup: 0, email: '' };

// ... Sound Generators (Same) ...
function createBeepURL(type) {
    const sampleRate = 44100;
    let duration = 0.4;
    if (type === 'coin') duration = 0.4;
    if (type === 'deduct') duration = 0.3;
    const frameCount = sampleRate * duration;
    let buffer = new Float32Array(frameCount);
    let phase = 0;
    for (let i = 0; i < frameCount; i++) {
        let t = i / sampleRate;
        let currentFreq = 440;
        let currentVol = 0.1;
        if (type === 'coin') {
            if (t < 0.06) { currentFreq = 988; currentVol = 0.1; }
            else { currentFreq = 1319; let progress = (t - 0.06) / (duration - 0.06); currentVol = 0.1 * (1 - progress); }
        } else if (type === 'deduct') {
            currentFreq = 200 * (1 - (i / frameCount));
            currentVol = 0.1 * (1 - (i / frameCount));
        }
        phase += (currentFreq * 2 * Math.PI) / sampleRate;
        buffer[i] = (Math.sin(phase) > 0 ? 1 : -1) * currentVol;
    }
    const wavBuffer = new ArrayBuffer(44 + frameCount * 2);
    const view = new DataView(wavBuffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + frameCount * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeString(view, 36, 'data'); view.setUint32(40, frameCount * 2, true);
    let offset = 44;
    for (let i = 0; i < frameCount; i++) {
        let s = Math.max(-1, Math.min(1, buffer[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, s, true);
        offset += 2;
    }
    const blob = new Blob([view], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
}
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}
const coinSoundUrl = createBeepURL('coin');
const deductSoundUrl = createBeepURL('deduct');
function playCoinSound() { new Audio(coinSoundUrl).play().catch(e => console.log("Audio play prevented")); }
function playDeductSound() { new Audio(deductSoundUrl).play().catch(e => console.log("Audio play prevented")); }
function showCoinAnimation() {
    var coin = document.getElementById('coin-effect');
    if (coin) { coin.classList.remove('animate'); void coin.offsetWidth; coin.classList.add('animate'); }
}
function showDeductAnimation() {
    var elem = document.getElementById('deduct-effect');
    if (elem) { elem.classList.remove('animate'); void elem.offsetWidth; elem.classList.add('animate'); }
}

if (versionEl) {
    let displayVer = "Ver: " + APP_VERSION;
    if (currentFamilyId) displayVer += " | ID: " + currentFamilyId;
    displayVer += "<br>系統認定今天: " + formatDateKey(new Date());
    versionEl.innerHTML = displayVer;
}

var defaultRules = [{ threshold: 3, points: 2 }, { threshold: 1, points: 1 }];
var rulesState = JSON.parse(JSON.stringify(defaultRules)); // Legacy / Fallback rules

var defaultCommonTasks = [
    { id: 'dress', name: '自己穿好衣服' },
    { id: 'hw', name: '寫完回家作業' },
    { id: 'toys', name: '睡前收玩具' }
];

var defaultKidsState = {
    leo: { key: 'leo', displayName: 'Leo', avatar: 'L', slogan: '今天一起加油 💪', theme: 'boy', totalPoints: 0, dataByWeek: {}, history: [], tasks: JSON.parse(JSON.stringify(defaultCommonTasks)), bonusTasks: [], rules: JSON.parse(JSON.stringify(defaultRules)) },
    natasha: { key: 'natasha', displayName: 'Natasha', avatar: 'N', slogan: '一起開心玩耍 🌈', theme: 'girl', totalPoints: 0, dataByWeek: {}, history: [], tasks: JSON.parse(JSON.stringify(defaultCommonTasks)), bonusTasks: [], rules: JSON.parse(JSON.stringify(defaultRules)) }
};
var kidsState = JSON.parse(JSON.stringify(defaultKidsState));
var currentKid = 'leo';
var currentViewWeekKey = getCurrentWeekKey();

// ... Update Check, Backup ...
async function checkForUpdates() {
    try {
        const url = window.location.href.split('#')[0] + '?t=' + Date.now();
        const response = await fetch(url, { cache: "no-store" });
        const text = await response.text();
        const match = text.match(/const APP_VERSION = "([^"]+)";/);
        if (match && match[1]) {
            const latestVersion = match[1];
            if (latestVersion !== APP_VERSION) {
                if (updateBanner) {
                    updateBanner.innerHTML = `🚀 發現新版本 (${latestVersion})！點此更新`;
                    updateBanner.style.display = 'block';
                }
            }
        }
    } catch (e) { }
}

var backupBtn = document.getElementById('backup-btn');
var backupCycleInput = document.getElementById('backup-cycle-input');
var backupEmailInput = document.getElementById('backup-email-input');
var restoreFileInput = document.getElementById('restore-file-input');
var lastBackupDateEl = document.getElementById('last-backup-date');
var backupOverdueMsg = document.getElementById('backup-overdue-msg');
var settingsNotification = document.getElementById('settings-notification');

function updateBackupUI() {
    if (backupCycleInput && document.activeElement !== backupCycleInput) backupCycleInput.value = backupSettings.cycle;
    if (backupEmailInput && document.activeElement !== backupEmailInput) backupEmailInput.value = backupSettings.email || '';
    if (backupSettings.lastBackup > 0) {
        var d = new Date(backupSettings.lastBackup);
        lastBackupDateEl.textContent = d.toLocaleDateString() + " " + d.toLocaleTimeString();
    } else {
        lastBackupDateEl.textContent = "尚未備份";
    }
    var now = Date.now();
    var diffDays = (now - backupSettings.lastBackup) / (1000 * 60 * 60 * 24);
    if (backupSettings.lastBackup === 0 || diffDays > backupSettings.cycle) {
        if (backupOverdueMsg) backupOverdueMsg.style.display = 'block';
        if (settingsNotification) settingsNotification.classList.add('show');
    } else {
        if (backupOverdueMsg) backupOverdueMsg.style.display = 'none';
        if (settingsNotification) settingsNotification.classList.remove('show');
    }
}

function saveBackupSettingsToCloud() {
    if (!currentFamilyId) return;
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    setDoc(doc(db, 'families', currentFamilyId, 'settings', 'backup'), backupSettings)
        .catch(err => console.error("Backup settings sync failed", err));
}

if (backupCycleInput) {
    backupCycleInput.addEventListener('change', function () {
        if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); this.value = backupSettings.cycle; return; }
        backupSettings.cycle = parseInt(this.value) || 7;
        saveBackupSettingsToCloud();
        updateBackupUI();
    });
}
if (backupEmailInput) {
    backupEmailInput.addEventListener('change', function () {
        if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); this.value = backupSettings.email; return; }
        backupSettings.email = this.value.trim();
        saveBackupSettingsToCloud();
    });
}
if (backupBtn) {
    backupBtn.addEventListener('click', async function () {
        if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
        var data = { version: APP_VERSION, exportDate: new Date().toISOString(), familyId: currentFamilyId, kids: kidsState, rules: rulesState };
        var jsonStr = JSON.stringify(data, null, 2);
        var fileName = `family-points-backup-${formatDateKey(new Date())}.json`;
        var file = new File([jsonStr], fileName, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], title: '家庭點數備份', text: `這是您的家庭點數任務板備份檔。\n建議寄送至：${backupSettings.email || '(未設定 Email)'}` }); finishBackup(); } catch (err) { }
        } else {
            var a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fileName; document.body.appendChild(a); a.click(); document.body.removeChild(a); showToast('備份檔已下載'); finishBackup();
        }
    });
}
function finishBackup() {
    backupSettings.lastBackup = Date.now();
    saveBackupSettingsToCloud();
    updateBackupUI();
    showToast('備份紀錄已更新');
}

if (restoreFileInput) {
    restoreFileInput.addEventListener('change', function (e) {
        if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); this.value = ''; return; }
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = async function (e) {
            try {
                var data = JSON.parse(e.target.result);
                if (!data.kids) throw new Error("格式錯誤");
                if (confirm(`確定要還原備份嗎？`)) {
                    kidsState = data.kids;
                    // rulesState fallback
                    if (data.rules) rulesState = data.rules;

                    const uploadPromises = Object.values(kidsState).map(kid => setDoc(doc(db, 'families', currentFamilyId, 'kids', kid.key), kid));
                    // No longer saving global rules to cloud actively, but we can restore it for legacy
                    const rulesPromise = setDoc(doc(db, 'families', currentFamilyId, 'settings', 'rules'), { list: rulesState });
                    await Promise.all([...uploadPromises, rulesPromise]);
                    alert("還原成功！");
                    window.location.reload();
                }
            } catch (err) { alert("還原失敗"); }
        };
        reader.readAsText(file);
        restoreFileInput.value = '';
    });
}

// Bulk Action Logic
var bulkPointsInput = document.getElementById('bulk-points-input');
var bulkNoteInput = document.getElementById('bulk-note-input');

function handleBulkAction(multiplier) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var kid = kidsState[currentKid];
    var pointsStr = bulkPointsInput.value;
    var points = parseInt(pointsStr);
    var note = bulkNoteInput.value.trim();

    if (!pointsStr || isNaN(points) || points <= 0) { alert('請輸入有效的數字'); return; }

    var delta = points * multiplier;
    kid.totalPoints += delta;
    kid.history.push({ id: Date.now().toString(), date: formatDateKey(new Date()), item: multiplier > 0 ? '大量加點' : '大量扣點', delta: delta, note: note || (multiplier > 0 ? '表現優異' : '違規扣點') });

    var count = Math.min(points, 15);
    var interval = 150;
    for (let i = 0; i < count; i++) { setTimeout(() => { if (multiplier > 0) playCoinSound(); else playDeductSound(); }, i * interval); }
    if (multiplier > 0) showCoinAnimation(); else showDeductAnimation();

    bulkPointsInput.value = '';
    bulkNoteInput.value = '';
    saveData('kid', currentKid);
    renderAll();
    showToast(multiplier > 0 ? `已加 ${points} 點！` : `已扣 ${points} 點`);
}

// --- INIT APP (Optimistic Load) ---
async function initApp() {
    checkForUpdates();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdates(); });

    if (!currentFamilyId) {
        showLoginModal();
        return;
    }

    // 1. Optimistic Load First!
    loadLocalDataOnly();
    renderAll();
    isDataSynced = false; // Lock UI
    updateConnectionStatus('syncing');

    // 2. Start Firebase Init
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        try { await enableIndexedDbPersistence(db); } catch (err) { }

        auth = getAuth(app);
        await signInAnonymously(auth);

        updateConnectionStatus(navigator.onLine ? 'syncing' : 'offline');
        window.addEventListener('online', () => updateConnectionStatus('syncing'));
        window.addEventListener('offline', () => updateConnectionStatus('offline'));

        await checkAndMigrateData();
        setupRealtimeListeners();
    } catch (e) {
        updateConnectionStatus('offline');
        console.error("Init failed", e);
    }
}

const loginModal = document.getElementById('login-modal');
const loginBtn = document.getElementById('login-btn');
const loginInput = document.getElementById('login-family-id');

function showLoginModal() { loginModal.classList.add('open'); loginModal.onclick = null; }

if (loginBtn) {
    loginBtn.addEventListener('click', function () {
        const val = loginInput.value.trim();
        if (val.length < 3) { alert("代號太短"); return; }
        if (!/^[a-zA-Z0-9-]+$/.test(val)) { alert("格式錯誤"); return; }
        currentFamilyId = val;
        localStorage.setItem(FAMILY_ID_KEY, currentFamilyId);
        loginModal.classList.remove('open');
        initApp();
    });
}

async function checkAndMigrateData() {
    if (!currentFamilyId) return;
    try {
        const kidsRef = collection(db, 'families', currentFamilyId, 'kids');
        const snapshot = await getDocs(kidsRef);
        if (snapshot.empty) {
            // If cloud is empty, we unlock and upload local data
            loadLocalDataOnly();
            const uploadPromises = Object.values(kidsState).map(kid => setDoc(doc(db, 'families', currentFamilyId, 'kids', kid.key), kid));
            const rulesPromise = setDoc(doc(db, 'families', currentFamilyId, 'settings', 'rules'), { list: rulesState });
            await Promise.all([...uploadPromises, rulesPromise]);
            showToast("家庭資料初始化完成");
            isDataSynced = true; // Unlock
            updateConnectionStatus('online');
        }
    } catch (e) { }
}

function setupRealtimeListeners() {
    if (!currentFamilyId) return;
    if (unsubscribeKids) { unsubscribeKids(); unsubscribeKids = null; }
    if (unsubscribeRules) { unsubscribeRules(); unsubscribeRules = null; }
    if (unsubscribeBackup) { unsubscribeBackup(); unsubscribeBackup = null; }

    unsubscribeKids = onSnapshot(collection(db, 'families', currentFamilyId, 'kids'), (snapshot) => {
        if (snapshot.empty && !Object.keys(kidsState).length) return;
        const newKidsState = {};
        snapshot.forEach(doc => { newKidsState[doc.id] = doc.data(); });

        // Merge logic
        kidsState = newKidsState;
        if (!kidsState[currentKid]) {
            const keys = Object.keys(kidsState);
            if (keys.length > 0) currentKid = keys[0];
            else currentKid = null;
        }

        // Unlock & Cache
        isDataSynced = true;
        saveLocalCache();

        renderAll();
        highlightTodayColumn();
        updateConnectionStatus('online');
    }, (error) => updateConnectionStatus('offline'));

    // Keep listening to global rules for fallback or backward compatibility
    unsubscribeRules = onSnapshot(doc(db, 'families', currentFamilyId, 'settings', 'rules'), (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.list) {
                rulesState = data.list;
                saveLocalCache();
                renderAll(); // Re-render in case some kids fallback to this
            }
        }
    });

    unsubscribeBackup = onSnapshot(doc(db, 'families', currentFamilyId, 'settings', 'backup'), (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            backupSettings = { ...backupSettings, ...data };
            updateBackupUI();
        }
    });
}

function loadLocalDataOnly() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
        try {
            var data = JSON.parse(raw);
            if (data.kids) kidsState = data.kids;
            if (data.rules) rulesState = data.rules;
        } catch (e) { }
    }
}

// New helper to save cache
function saveLocalCache() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kids: kidsState, rules: rulesState }));
}

function updateConnectionStatus(status) {
    if (dbStatusEl) {
        let className = 'connection-dot ' + status;
        dbStatusEl.className = className;
        if (status === 'online') dbStatusEl.title = "已連線";
        else if (status === 'syncing') dbStatusEl.title = "同步中";
        else dbStatusEl.title = "離線";
    }
}

// UI Interaction Guards
document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', function (event) { if (event.touches.length > 1) { event.preventDefault(); } }, { passive: false });

function showToast(msg) {
    var toast = document.getElementById('toast-msg');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-msg';
        toast.style.position = 'fixed';
        toast.style.bottom = '80px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = 'rgba(0,0,0,0.8)';
        toast.style.color = '#fff';
        toast.style.padding = '10px 20px';
        toast.style.borderRadius = '20px';
        toast.style.zIndex = '9999';
        toast.style.fontSize = '14px';
        toast.style.transition = 'opacity 0.5s';
        toast.style.opacity = '0';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(function () { toast.style.opacity = '0'; }, 2000);
}

var navItems = document.querySelectorAll('.nav-item');
var pages = document.querySelectorAll('.tab-page');
navItems.forEach(function (item) {
    item.addEventListener('click', function () {
        var target = item.getAttribute('data-tab-target');
        navItems.forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        pages.forEach(function (page) {
            if (page.getAttribute('data-tab') === target) page.classList.add('active');
            else page.classList.remove('active');
        });
        if (target === 'today') setTimeout(highlightTodayColumn, 100);
    });
});

function parseLocalYMD(dateStr) {
    if (!dateStr) return new Date();
    var p = dateStr.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
}

function getMonday(d) {
    d = new Date(d);
    var day = d.getDay();
    var diff = d.getDate() - day + (day == 0 ? -6 : 1);
    var monday = new Date(d.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday;
}
function formatDateKey(d) {
    var year = d.getFullYear();
    var month = (d.getMonth() + 1).toString().padStart(2, '0');
    var day = d.getDate().toString().padStart(2, '0');
    return year + '-' + month + '-' + day;
}
function getCurrentWeekKey() {
    return formatDateKey(getMonday(new Date()));
}
function getWeekRangeString(mondayStr) {
    var monday = parseLocalYMD(mondayStr);
    var sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return (monday.getMonth() + 1) + '/' + monday.getDate() + " ～ " + (sunday.getMonth() + 1) + '/' + sunday.getDate();
}

async function saveData(type, id) {
    if (!currentFamilyId) return;
    triggerSaveIndicator();
    try {
        if (type === 'kid' && id) {
            const kidData = kidsState[id];
            if (kidData) await setDoc(doc(db, 'families', currentFamilyId, 'kids', id), kidData);
        } else if (type === 'delete_kid' && id) {
            await deleteDoc(doc(db, 'families', currentFamilyId, 'kids', id));
        } else if (type === 'rules') {
            // Legacy support: still save global rules just in case
            await setDoc(doc(db, 'families', currentFamilyId, 'settings', 'rules'), { list: rulesState });
        }
    } catch (e) {
        updateConnectionStatus('offline');
    }
}

function triggerSaveIndicator() {
    var badge = document.getElementById('save-badge');
    if (badge) {
        badge.classList.add('show');
        setTimeout(function () { badge.classList.remove('show'); }, 1500);
    }
}

function calculateDailyScoreDetail(kid, weekKey, dayIndex) {
    var weekData = getWeekData(kid, weekKey);
    if (!weekData.ruleScores) weekData.ruleScores = [0, 0, 0, 0, 0, 0, 0];
    var dayStatus = weekData.status[dayIndex] || {};

    var checkedNormalCount = 0;
    kid.tasks.forEach(t => { if (dayStatus[t.id] === 'checked') checkedNormalCount++; });

    var ruleScore = 0;
    var maxPoints = 0;
    var matched = false;

    // --- NEW LOGIC: Use kid's rules first, fallback to global ---
    var activeRules = kid.rules || rulesState;

    activeRules.forEach(function (rule) {
        if (checkedNormalCount >= rule.threshold) {
            if (rule.points > maxPoints) { maxPoints = rule.points; matched = true; }
        }
    });
    if (matched) ruleScore = maxPoints;

    var bonusScore = 0;
    if (kid.bonusTasks) {
        kid.bonusTasks.forEach(bt => { if (dayStatus[bt.id] === 'checked') bonusScore++; });
    }

    var manualPoints = weekData.summary[dayIndex] || 0;

    return {
        ruleScore: ruleScore,
        bonusScore: bonusScore,
        manualPoints: manualPoints,
        total: ruleScore + bonusScore + manualPoints
    };
}

function calculateDailyTotal(kid, weekKey, dayIndex) {
    return calculateDailyScoreDetail(kid, weekKey, dayIndex).total;
}

function performReset() {
    if (confirm('確定要登出並清除本機紀錄嗎？\n(您的雲端資料仍會保留在該家庭代號下)')) {
        localStorage.removeItem(FAMILY_ID_KEY);
        localStorage.removeItem(STORAGE_KEY);
        window.location.reload();
    }
}

function getFrequentNotes(kid, limit = 5) {
    const defaults = ["主動幫忙", "收玩具", "沒禮貌"];
    if (!kid.history || kid.history.length === 0) return defaults;
    const counts = {};
    kid.history.forEach(item => { if (item.note && item.note.trim() !== '') { counts[item.note] = (counts[item.note] || 0) + 1; } });
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return [...new Set([...sorted, ...defaults])].slice(0, limit);
}

function renderSmartChips() {
    if (!kidsState[currentKid]) return;
    var kid = kidsState[currentKid];
    var notes = getFrequentNotes(kid);
    renderChipsToContainer(notes, document.getElementById('quick-note-chips'), 'quick-note-input');
    renderDatalist(notes, document.getElementById('quick-note-list'));
    renderChipsToContainer(notes, document.getElementById('bulk-note-chips'), 'bulk-note-input');
    renderDatalist(notes, document.getElementById('bulk-note-list'));
}

function renderChipsToContainer(notes, container, inputId) {
    if (!container) return;
    container.innerHTML = '';
    notes.forEach(note => {
        var btn = document.createElement('div');
        btn.className = 'chip-btn';
        btn.textContent = note;
        btn.onclick = function () {
            var input = document.getElementById(inputId);
            if (input) { input.value = note; input.focus(); }
        };
        container.appendChild(btn);
    });
}

function renderDatalist(notes, datalist) {
    if (!datalist) return;
    datalist.innerHTML = '';
    notes.forEach(note => { var opt = document.createElement('option'); opt.value = note; datalist.appendChild(opt); });
}

function renderAll() {
    renderCurrentKid();
    renderWeekTable();
    renderHistoryList();
    renderSettingsTaskList();
    renderSettingsBonusTaskList();
    renderSettingsKidList();
    renderSettingsRulesList();
    renderSmartChips();
}

var appEl = document.querySelector('.app');
var switchBtn = document.querySelector('.switch-btn');
var kidNameEl = document.querySelector('.kid-name');
var avatarEl = document.querySelector('.avatar');
var kidSubEl = document.querySelector('.kid-sub');
var totalPointsEl = document.getElementById('total-points');
var weeklyPointsEl = document.getElementById('weekly-points');
var dateChipEl = document.getElementById('date-chip');
var viewLabelEl = document.getElementById('viewing-week-label');
var historyWeekLabel = document.getElementById('history-week-label');
var settingsTaskKidLabel = document.getElementById('settings-task-kid-label');
var settingsRulesHeaderLabel = document.getElementById('settings-rules-header-label');

var redeemKidNameEl = document.getElementById('redeem-kid-name');
var redeemKidPointsEl = document.getElementById('redeem-kid-points');
var redeemNameInput = document.getElementById('redeem-name-input');
var redeemPointsInput = document.getElementById('redeem-points-input');
var redeemNoteInput = document.getElementById('redeem-note-input');
var redeemConfirmBtn = document.getElementById('redeem-confirm-btn');

var quickNoteInput = document.getElementById('quick-note-input');
var historyCard = document.getElementById('points-history-card');

var settingsTaskListEl = document.getElementById('settings-task-list');
var settingsNewTaskInput = document.getElementById('settings-new-task-input');
var settingsNewTaskBtn = document.getElementById('settings-new-task-btn');
var settingsKidListEl = document.getElementById('settings-kid-list');
var settingsBonusTaskListEl = document.getElementById('settings-bonus-task-list');
var settingsNewBonusTaskInput = document.getElementById('settings-new-bonus-task-input');
var settingsNewBonusTaskBtn = document.getElementById('settings-new-bonus-task-btn');
var settingsRulesListEl = document.getElementById('settings-rules-list');
var ruleThresholdInput = document.getElementById('rule-threshold-input');
var rulePointsInput = document.getElementById('rule-points-input');
var btnAddRule = document.getElementById('btn-add-rule');
var editKidModal = document.getElementById('edit-kid-modal');
var editKidKeyInput = document.getElementById('edit-kid-key');
var editKidNameInput = document.getElementById('edit-kid-name');
var editKidPointsInput = document.getElementById('edit-kid-points');
var btnCancelEdit = document.getElementById('btn-cancel-edit');
var btnSaveEdit = document.getElementById('btn-save-edit');
var resetDataBtn = document.getElementById('reset-data-btn');
var weekSelectModal = document.getElementById('week-select-modal');
var weekListContainer = document.getElementById('week-list-container');
var editTaskModal = document.getElementById('edit-task-modal');
var editTaskIdInput = document.getElementById('edit-task-id');
var editTaskTypeInput = document.getElementById('edit-task-type');
var editTaskNameInput = document.getElementById('edit-task-name');
var btnCancelTaskEdit = document.getElementById('btn-cancel-task-edit');
var btnSaveTaskEdit = document.getElementById('btn-save-task-edit');

if (resetDataBtn) resetDataBtn.addEventListener('click', performReset);

function getTodayColumnIndex() {
    var d = new Date().getDay();
    return (d === 0) ? 6 : d - 1;
}

function getWeekData(kid, weekKey) {
    if (!kid.dataByWeek[weekKey]) {
        kid.dataByWeek[weekKey] = {
            status: [{}, {}, {}, {}, {}, {}, {}],
            summary: [0, 0, 0, 0, 0, 0, 0],
            ruleScores: [0, 0, 0, 0, 0, 0, 0]
        };
    }
    return kid.dataByWeek[weekKey];
}

function calculateWeeklyGridPoints(kid, weekKey) {
    let total = 0;
    for (let i = 0; i < 7; i++) {
        total += calculateDailyTotal(kid, weekKey, i);
    }
    return total;
}

function renderCurrentKid() {
    if (!kidsState[currentKid]) {
        if (Object.keys(kidsState).length > 0) currentKid = Object.keys(kidsState)[0];
        else return;
    }
    var kid = kidsState[currentKid];
    if (!kid.bonusTasks) kid.bonusTasks = [];

    kidNameEl.textContent = kid.displayName;
    if (currentFamilyId) {
        var idTag = document.createElement('span');
        idTag.className = 'family-id-tag';
        idTag.textContent = currentFamilyId;
    }

    var firstChild = avatarEl.firstChild;
    if (firstChild && firstChild.nodeType === 3) firstChild.textContent = kid.avatar;
    else if (!firstChild) avatarEl.prepend(document.createTextNode(kid.avatar));

    kidSubEl.textContent = kid.slogan;
    appEl.classList.remove('boy', 'girl');
    appEl.classList.add(kid.theme);

    totalPointsEl.innerHTML = '<span>⭐</span><span>' + (kid.totalPoints * 10) + ' 點</span>';

    const weeklyScore = calculateWeeklyGridPoints(kid, currentViewWeekKey);
    weeklyPointsEl.textContent = `本週：${weeklyScore * 10} 點`;

    dateChipEl.textContent = '週次：' + getWeekRangeString(currentViewWeekKey);
    var thisWeek = getCurrentWeekKey();
    if (currentViewWeekKey === thisWeek) {
        viewLabelEl.textContent = "(本週)";
        viewLabelEl.style.color = "#2e7d32";
        historyWeekLabel.textContent = "(本週)";
    } else {
        viewLabelEl.textContent = "(歷史紀錄)";
        viewLabelEl.style.color = "#c62828";
        historyWeekLabel.textContent = `(${getWeekRangeString(currentViewWeekKey)})`;
    }

    redeemKidNameEl.textContent = kid.displayName;
    redeemKidPointsEl.textContent = kid.totalPoints * 10;

    if (settingsTaskKidLabel) settingsTaskKidLabel.textContent = "(管理對象：" + kid.displayName + ")";
    if (settingsRulesHeaderLabel) settingsRulesHeaderLabel.textContent = "(管理對象：" + kid.displayName + ")";
}

function renderWeekTable() {
    if (!kidsState[currentKid]) return;
    var kid = kidsState[currentKid];
    var table = document.getElementById('week-table');
    table.innerHTML = '';
    var weekData = getWeekData(kid, currentViewWeekKey);

    var days = ['一', '二', '三', '四', '五', '六', '日'];
    var todayIdx = getTodayColumnIndex();
    var isCurrentWeek = (currentViewWeekKey === getCurrentWeekKey());

    var headerRow = document.createElement('div');
    headerRow.className = 'week-header';

    var corner = document.createElement('div');
    corner.className = 'task-name-header';
    corner.textContent = '任務 / 星期';
    headerRow.appendChild(corner);

    var mondayDate = parseLocalYMD(currentViewWeekKey);

    days.forEach(function (d, i) {
        var cell = document.createElement('div');
        cell.className = 'day-header';
        if (isCurrentWeek && i === todayIdx) cell.classList.add('today-col');
        var thisDay = new Date(mondayDate);
        thisDay.setDate(mondayDate.getDate() + i);
        var dateStr = (thisDay.getMonth() + 1) + '/' + thisDay.getDate();
        cell.innerHTML = `<div>${d}</div><div class="date-label">${dateStr}</div>`;
        headerRow.appendChild(cell);
    });
    table.appendChild(headerRow);

    function getVisibleTasks(taskList) {
        return taskList.filter(function (t) {
            if (!t.deleted) return true;
            var hasDataInWeek = weekData.status.some(function (dayStatus) {
                return dayStatus && (dayStatus[t.id] === 'checked' || dayStatus[t.id] === 'crossed');
            });
            return hasDataInWeek;
        });
    }

    var normalTasks = getVisibleTasks(kid.tasks);
    normalTasks.forEach(function (task) { renderTaskRow(task, 'normal', weekData, todayIdx); });

    var bonusTasks = getVisibleTasks(kid.bonusTasks || []);
    if (bonusTasks.length > 0) {
        var sep = document.createElement('div');
        sep.className = 'bonus-separator';
        sep.textContent = '⭐ BONUS 任務區 ⭐';
        table.appendChild(sep);
    }

    bonusTasks.forEach(function (task) { renderTaskRow(task, 'bonus', weekData, todayIdx); });

    var sumRow = document.createElement('div');
    sumRow.className = 'day-summary-row';
    var sumTitle = document.createElement('div');
    sumTitle.className = 'task-name-summary';
    sumTitle.textContent = '本日小計';
    sumRow.appendChild(sumTitle);

    for (var i = 0; i < 7; i++) {
        var cell = document.createElement('div');
        cell.className = 'day-summary-cell';
        if (isCurrentWeek && i === todayIdx) cell.classList.add('today-col');
        var dailyTotal = calculateDailyTotal(kid, currentViewWeekKey, i);
        var scoreSpan = document.createElement('span');
        scoreSpan.textContent = (dailyTotal > 0 ? '+' : '') + dailyTotal;
        if (dailyTotal > 0) scoreSpan.className = 'day-summary-cell-positive';
        if (dailyTotal < 0) scoreSpan.className = 'day-summary-cell-negative';
        cell.appendChild(scoreSpan);
        sumRow.appendChild(cell);
    }
    table.appendChild(sumRow);
}

function renderTaskRow(task, type, weekData, todayIdx) {
    var table = document.getElementById('week-table');
    var row = document.createElement('div');
    row.className = 'task-row ' + (type === 'bonus' ? 'bonus-row' : '');

    var nameCell = document.createElement('div');
    nameCell.className = 'task-name';
    if (task.deleted) {
        nameCell.textContent = task.name + " (已封存)";
        nameCell.style.color = "#999";
        nameCell.style.fontStyle = "italic";
    } else {
        nameCell.textContent = task.name;
        var pressTimer;
        nameCell.addEventListener('touchstart', function () {
            pressTimer = setTimeout(function () {
                if (confirm(`要刪除任務「${task.name}」嗎？(歷史紀錄保留)`)) deleteTask(task.id, type);
            }, 800);
        });
        nameCell.addEventListener('touchend', function () { clearTimeout(pressTimer); });
    }
    row.appendChild(nameCell);

    for (var i = 0; i < 7; i++) {
        var cellWrapper = document.createElement('div');
        cellWrapper.className = 'day-cell-wrapper';
        if (currentViewWeekKey === getCurrentWeekKey() && i === todayIdx) cellWrapper.classList.add('today-col');

        var check = document.createElement('div');
        var status = (weekData.status[i] && weekData.status[i][task.id]) ? weekData.status[i][task.id] : '';
        check.className = 'custom-check ' + (status === 'checked' ? 'checked' : (status === 'crossed' ? 'crossed' : ''));
        check.textContent = status === 'checked' ? '✔' : (status === 'crossed' ? '⭕' : '');

        (function (dIndex, taskId, tType) {
            check.onclick = function () { toggleCheck(dIndex, taskId, tType); };
        })(i, task.id, type);

        cellWrapper.appendChild(check);
        row.appendChild(cellWrapper);
    }
    table.appendChild(row);
}

function toggleCheck(dayIndex, taskId, type) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var kid = kidsState[currentKid];
    var detailsBefore = calculateDailyScoreDetail(kid, currentViewWeekKey, dayIndex);
    var oldTotal = detailsBefore.total;
    var weekData = getWeekData(kid, currentViewWeekKey);

    var current = (weekData.status[dayIndex] && weekData.status[dayIndex][taskId]) ? weekData.status[dayIndex][taskId] : '';
    var next = '';
    if (current === '') next = 'checked';
    else if (current === 'checked') next = 'crossed';
    else next = '';

    if (!weekData.status[dayIndex]) weekData.status[dayIndex] = {};
    weekData.status[dayIndex][taskId] = next;

    var detailsAfter = calculateDailyScoreDetail(kid, currentViewWeekKey, dayIndex);
    var newTotal = detailsAfter.total;
    weekData.ruleScores[dayIndex] = newTotal;

    var diff = newTotal - oldTotal;
    if (diff !== 0) {
        kid.totalPoints += diff;
        if (diff > 0) { showCoinAnimation(); playCoinSound(); }
        else { showDeductAnimation(); playDeductSound(); }
    }
    saveData('kid', currentKid);
    renderCurrentKid();
    renderWeekTable();
}

function handleQuickAdd(val) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var kid = kidsState[currentKid];
    var note = quickNoteInput.value.trim();

    kid.totalPoints += val;
    var today = new Date();
    var dayIdx = getTodayColumnIndex();
    var thisWeekKey = getCurrentWeekKey();
    var weekData = getWeekData(kid, thisWeekKey);

    if (!weekData.summary) weekData.summary = [0, 0, 0, 0, 0, 0, 0];
    weekData.summary[dayIdx] = (weekData.summary[dayIdx] || 0) + val;

    kid.history.push({
        id: Date.now().toString(),
        date: formatDateKey(today), // Local YYYY-MM-DD
        item: '快速加扣',
        delta: val,
        note: note || (val > 0 ? '手動加點' : '手動扣點')
    });

    quickNoteInput.value = '';
    if (val > 0) { showCoinAnimation(); playCoinSound(); showToast('加點成功！(已計入本日小計)'); }
    else { showDeductAnimation(); playDeductSound(); showToast('已扣點 (已計入本日小計)'); }
    saveData('kid', currentKid);
    renderAll();
}

redeemConfirmBtn.addEventListener('click', function () {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var name = redeemNameInput.value.trim();
    var pts = parseInt(redeemPointsInput.value);
    var note = redeemNoteInput.value.trim();
    var kid = kidsState[currentKid];

    if (!name || isNaN(pts) || pts <= 0) { alert('請輸入有效的兌換名稱和點數'); return; }
    if (kid.totalPoints < pts) { if (!confirm('點數不足，確定要兌換並變成負分嗎？')) return; }

    kid.totalPoints -= pts;
    kid.history.push({
        id: Date.now().toString(),
        date: formatDateKey(new Date()),
        item: '兌換：' + name,
        delta: -pts,
        note: note
    });

    redeemNameInput.value = '';
    redeemPointsInput.value = '';
    redeemNoteInput.value = '';
    showDeductAnimation();
    playDeductSound();
    showToast('兌換成功！');
    saveData('kid', currentKid);
    renderAll();
});

function renderHistoryList() {
    if (!kidsState[currentKid]) return;
    var kid = kidsState[currentKid];
    historyCard.innerHTML = '';

    var viewMonday = parseLocalYMD(currentViewWeekKey);
    var viewNextMonday = new Date(viewMonday);
    viewNextMonday.setDate(viewMonday.getDate() + 7);

    var filteredHistory = kid.history.filter(function (item) {
        // Safe Date Parsing
        var itemDate = parseLocalYMD(item.date);
        return itemDate.getTime() >= viewMonday.getTime() &&
            itemDate.getTime() < viewNextMonday.getTime();
    });

    var list = filteredHistory.sort(function (a, b) { return b.id - a.id; });
    if (list.length === 0) { historyCard.innerHTML = '<div class="empty-state">本週尚無額外紀錄</div>'; return; }

    list.forEach(function (h) {
        var row = document.createElement('div');
        row.className = 'history-item';

        var left = document.createElement('div');
        left.className = 'history-main';
        var titleDiv = document.createElement('div');
        titleDiv.style.fontWeight = '600';
        titleDiv.textContent = h.item;

        var metaDiv = document.createElement('div');
        metaDiv.className = 'history-date';
        var metaText = h.date;
        if (h.note) metaText += ' · ' + h.note;
        metaDiv.textContent = metaText;

        left.appendChild(titleDiv);
        left.appendChild(metaDiv);

        var right = document.createElement('div');
        right.style.textAlign = 'right';
        var deltaDiv = document.createElement('div');
        deltaDiv.className = 'history-delta';
        deltaDiv.textContent = (h.delta > 0 ? '+' : '') + h.delta;
        deltaDiv.style.color = h.delta > 0 ? '#2e7d32' : '#c62828';

        var delBtn = document.createElement('button');
        delBtn.className = 'history-delete-btn';
        delBtn.textContent = '刪除';
        delBtn.onclick = function () {
            if (confirm('確定刪除這條紀錄？點數會復原。')) {
                deleteHistoryItem(h.id, h.delta);
            }
        };

        right.appendChild(deltaDiv);
        right.appendChild(delBtn);
        row.appendChild(left);
        row.appendChild(right);
        historyCard.appendChild(row);
    });
}

function deleteHistoryItem(id, delta) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var kid = kidsState[currentKid];
    var targetItem = kid.history.find(x => x.id === id);

    if (targetItem && targetItem.item === '快速加扣') {
        var itemDate = parseLocalYMD(targetItem.date);
        var itemWeekKey = formatDateKey(getMonday(itemDate));

        if (kid.dataByWeek[itemWeekKey] && kid.dataByWeek[itemWeekKey].summary) {
            var dayIdx = (itemDate.getDay() === 0) ? 6 : itemDate.getDay() - 1;
            var currentVal = kid.dataByWeek[itemWeekKey].summary[dayIdx] || 0;
            kid.dataByWeek[itemWeekKey].summary[dayIdx] = currentVal - delta;
        }
    }

    kid.history = kid.history.filter(x => x.id !== id);
    kid.totalPoints -= delta;

    saveData('kid', currentKid);
    renderAll();
    showToast('紀錄已刪除');
}

function renderSettingsTaskList() { renderGenericTaskList(settingsTaskListEl, 'normal'); }
function renderSettingsBonusTaskList() { renderGenericTaskList(settingsBonusTaskListEl, 'bonus'); }

function renderGenericTaskList(container, type) {
    if (!kidsState[currentKid]) return;
    var kid = kidsState[currentKid];
    var list = (type === 'normal') ? kid.tasks : (kid.bonusTasks || []);

    container.innerHTML = '';
    list.forEach(function (t) {
        if (t.deleted) return;
        var item = document.createElement('div');
        item.className = 'settings-item';
        var nameDiv = document.createElement('div');
        nameDiv.textContent = t.name;
        if (type === 'bonus') nameDiv.style.color = '#e65100';
        item.appendChild(nameDiv);

        var btnDiv = document.createElement('div');
        btnDiv.style.display = 'flex';
        btnDiv.style.gap = '8px';

        var editBtn = document.createElement('button');
        editBtn.className = 'settings-btn';
        editBtn.textContent = '編輯';
        editBtn.onclick = function () { openEditTaskModal(t.id, t.name, type); };
        btnDiv.appendChild(editBtn);

        var delBtn = document.createElement('button');
        delBtn.className = 'settings-btn delete-task-btn';
        delBtn.textContent = '刪除';
        delBtn.onclick = function () { if (confirm('確定刪除「' + t.name + '」？(歷史紀錄保留)')) deleteTask(t.id, type); };
        btnDiv.appendChild(delBtn);

        item.appendChild(btnDiv);
        container.appendChild(item);
    });
}

function deleteTask(taskId, type) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var kid = kidsState[currentKid];
    var list = (type === 'bonus') ? kid.bonusTasks : kid.tasks;
    var task = list.find(t => t.id === taskId);
    if (task) {
        task.deleted = true;
        saveData('kid', currentKid);
        renderAll();
        showToast('任務已封存');
    }
}

function openEditTaskModal(id, name, type) {
    editTaskIdInput.value = id;
    editTaskNameInput.value = name;
    editTaskTypeInput.value = type;
    editTaskModal.classList.add('open');
}

if (btnCancelTaskEdit) btnCancelTaskEdit.onclick = function () { editTaskModal.classList.remove('open'); };
if (btnSaveTaskEdit) btnSaveTaskEdit.onclick = function () {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var id = editTaskIdInput.value;
    var type = editTaskTypeInput.value;
    var newName = editTaskNameInput.value.trim();
    if (!newName) return;
    var kid = kidsState[currentKid];
    var list = (type === 'bonus') ? kid.bonusTasks : kid.tasks;
    var task = list.find(t => t.id === id);
    if (task) {
        task.name = newName;
        saveData('kid', currentKid);
        renderAll();
        showToast('任務名稱已更新');
    }
    editTaskModal.classList.remove('open');
};

settingsNewTaskBtn.addEventListener('click', function () {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var val = settingsNewTaskInput.value.trim();
    if (!val) return;
    var kid = kidsState[currentKid];
    kid.tasks.push({ id: 't' + Date.now(), name: val, createdAt: new Date().toISOString() });
    settingsNewTaskInput.value = '';
    saveData('kid', currentKid);
    renderAll();
    showToast('任務已新增');
});

if (settingsNewBonusTaskBtn) {
    settingsNewBonusTaskBtn.addEventListener('click', function () {
        if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
        var val = settingsNewBonusTaskInput.value.trim();
        if (!val) return;
        var kid = kidsState[currentKid];
        if (!kid.bonusTasks) kid.bonusTasks = [];
        kid.bonusTasks.push({ id: 'b' + Date.now(), name: val, createdAt: new Date().toISOString() });
        settingsNewBonusTaskInput.value = '';
        saveData('kid', currentKid);
        renderAll();
        showToast('Bonus 任務已新增');
    });
}

function renderSettingsKidList() {
    settingsKidListEl.innerHTML = '';
    Object.values(kidsState).forEach(function (k) {
        var item = document.createElement('div');
        item.className = 'settings-item';
        var infoDiv = document.createElement('div');

        // MODIFICATION: Kid List Points Display x10
        infoDiv.innerHTML = '<span style="font-weight:600">' + k.displayName + '</span> <span style="font-size:12px;color:#888">(' + (k.totalPoints * 10) + '點)</span>';

        var btnDiv = document.createElement('div');
        btnDiv.style.display = 'flex';
        btnDiv.style.gap = '8px';
        var editBtn = document.createElement('button');
        editBtn.className = 'settings-btn';
        editBtn.textContent = '編輯';
        editBtn.onclick = function () { openEditKidModal(k.key); };
        btnDiv.appendChild(editBtn);
        if (Object.keys(kidsState).length > 1) {
            var delBtn = document.createElement('button');
            delBtn.className = 'settings-btn delete-task-btn';
            delBtn.textContent = '刪除';
            delBtn.onclick = function () { if (confirm('確定要刪除小孩「' + k.displayName + '」的所有資料？無法復原！')) deleteKid(k.key); };
            btnDiv.appendChild(delBtn);
        }
        item.appendChild(infoDiv);
        item.appendChild(btnDiv);
        settingsKidListEl.appendChild(item);
    });
    var addDiv = document.createElement('div');
    addDiv.className = 'settings-item';
    addDiv.style.justifyContent = 'center';
    var addBtn = document.createElement('button');
    addBtn.className = 'settings-btn';
    addBtn.style.width = '100%';
    addBtn.style.color = '#1565c0';
    addBtn.style.fontWeight = '600';
    addBtn.textContent = '+ 新增小孩';
    addBtn.onclick = addNewKid;
    addDiv.appendChild(addBtn);
    settingsKidListEl.appendChild(addDiv);
}

function addNewKid() {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var newKey = 'kid_' + Date.now();
    kidsState[newKey] = {
        key: newKey,
        displayName: '新寶貝',
        avatar: '🙂',
        slogan: '快樂每一天',
        theme: 'boy',
        totalPoints: 0,
        dataByWeek: {},
        history: [],
        tasks: JSON.parse(JSON.stringify(defaultCommonTasks)),
        bonusTasks: [],
        rules: JSON.parse(JSON.stringify(defaultRules)) // Initialize with default rules
    };
    saveData('kid', newKey);
    renderAll();
    showToast('已新增小孩，請到編輯修改資料');
}

function deleteKid(key) {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    delete kidsState[key];
    if (currentKid === key) {
        const keys = Object.keys(kidsState);
        if (keys.length > 0) currentKid = keys[0];
        else currentKid = null;
    }
    saveData('delete_kid', key);
    renderAll();
}

function openEditKidModal(key) {
    var kid = kidsState[key];
    editKidKeyInput.value = key;
    editKidNameInput.value = kid.displayName;
    editKidPointsInput.value = kid.totalPoints;
    var radios = document.getElementsByName('edit-kid-theme');
    radios.forEach(r => { if (r.value === kid.theme) r.checked = true; });
    editKidModal.classList.add('open');
}

btnCancelEdit.onclick = function () { editKidModal.classList.remove('open'); };
btnSaveEdit.onclick = function () {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var key = editKidKeyInput.value;
    var kid = kidsState[key];
    if (!kid) return;
    kid.displayName = editKidNameInput.value.trim() || 'No Name';
    kid.avatar = kid.displayName.charAt(0).toUpperCase();
    kid.totalPoints = parseInt(editKidPointsInput.value) || 0;
    var radios = document.getElementsByName('edit-kid-theme');
    radios.forEach(r => { if (r.checked) kid.theme = r.value; });
    saveData('kid', key);
    renderAll();
    editKidModal.classList.remove('open');
    showToast('資料已更新');
};

function renderSettingsRulesList() {
    if (!kidsState[currentKid]) return;
    var kid = kidsState[currentKid];

    // --- NEW LOGIC: Use kid rules OR global rules ---
    var activeRules = kid.rules || rulesState;

    settingsRulesListEl.innerHTML = '';

    // Sort active rules by threshold
    var sortedRules = [...activeRules].sort((a, b) => b.threshold - a.threshold);

    sortedRules.forEach((rule) => {
        // We need to find the original index in activeRules to delete correctly
        var originalIdx = activeRules.indexOf(rule);

        var row = document.createElement('div');
        row.className = 'settings-item';
        row.innerHTML = `
            <div>
               <span style="font-weight:600">完成 ${rule.threshold} 項</span>
               <span style="margin:0 8px">→</span>
               <span style="color:#2e7d32; font-weight:600">+${rule.points} 點</span>
            </div>
        `;
        var delBtn = document.createElement('button');
        delBtn.className = 'settings-btn delete-task-btn';
        delBtn.textContent = '刪除';
        delBtn.onclick = function () {
            if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }

            // --- FORK LOGIC ---
            // If kid doesn't have own rules yet, copy global rules first
            if (!kid.rules) kid.rules = JSON.parse(JSON.stringify(rulesState));

            // Find index again in the *newly created* kid.rules array
            // We use findIndex because object references might change after stringify/parse
            var idxToDelete = kid.rules.findIndex(r => r.threshold === rule.threshold && r.points === rule.points);
            if (idxToDelete !== -1) {
                kid.rules.splice(idxToDelete, 1);
                saveData('kid', currentKid); // Save KID doc, not rules doc
                renderAll();
                showToast('規則已刪除');
            }
        };
        row.appendChild(delBtn);
        settingsRulesListEl.appendChild(row);
    });
}

btnAddRule.addEventListener('click', function () {
    if (!isDataSynced) { showToast("☁️ 資料同步中，請稍候..."); return; }
    var t = parseInt(ruleThresholdInput.value);
    var p = parseInt(rulePointsInput.value);
    if (isNaN(t) || isNaN(p)) return;

    var kid = kidsState[currentKid];

    // --- FORK LOGIC ---
    // Create kid.rules if missing
    if (!kid.rules) kid.rules = JSON.parse(JSON.stringify(rulesState));

    kid.rules.push({ threshold: t, points: p });

    ruleThresholdInput.value = '';
    rulePointsInput.value = '';

    saveData('kid', currentKid); // Save KID doc
    renderAll();
    showToast('規則已新增');
});

switchBtn.addEventListener('click', function () {
    var keys = Object.keys(kidsState);
    if (keys.length === 0) return;
    var idx = keys.indexOf(currentKid);
    var nextIdx = (idx + 1) % keys.length;
    currentKid = keys[nextIdx];
    renderAll();
});

function openWeekSelectModal() {
    if (!kidsState[currentKid]) return;
    weekListContainer.innerHTML = '';
    var kid = kidsState[currentKid];
    var weeks = Object.keys(kid.dataByWeek).sort().reverse();
    var thisWeek = getCurrentWeekKey();
    if (!weeks.includes(thisWeek)) weeks.unshift(thisWeek);
    weeks = [...new Set(weeks)].sort().reverse();
    weeks.forEach(function (wk) {
        var div = document.createElement('div');
        div.className = 'week-list-item ' + (wk === currentViewWeekKey ? 'active' : '');
        var label = getWeekRangeString(wk);
        if (wk === thisWeek) label += " (本週)";
        div.onclick = function () {
            currentViewWeekKey = wk;
            closeWeekSelectModal();
            renderAll();
        };
        div.textContent = label;
        weekListContainer.appendChild(div);
    });
    weekSelectModal.classList.add('open');
}
function closeWeekSelectModal() { weekSelectModal.classList.remove('open'); }
function highlightTodayColumn() {
    setTimeout(() => {
        const todayCols = document.querySelectorAll('.today-col');
        if (todayCols.length > 0) {
            const target = todayCols[0];
            target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }, 300);
}

window.handleQuickAdd = handleQuickAdd;
window.handleBulkAction = handleBulkAction;
window.openWeekSelectModal = openWeekSelectModal;
window.closeWeekSelectModal = closeWeekSelectModal;

initApp();
