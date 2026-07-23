import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCSAb4KpSgZLXk7x_IxX_E-eTD-m6om44U",
  authDomain: "abcd-a992c.firebaseapp.com",
  projectId: "abcd-a992c",
  storageBucket: "abcd-a992c.firebasestorage.app",
  messagingSenderId: "176945799338",
  appId: "1:176945799338:web:1edf67192fa462f26930d3",
  measurementId: "G-V8T7DEFZFB"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();
let currentUser = null;
let unsubscribeCloud = null;
let saveTimer = null;
let applyingCloudData = false;


const STORAGE_KEY = "salaryCalendarDataV1";

const safeClone = value => JSON.parse(JSON.stringify(value));

function sanitizeForFirestore(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) return 0;
    return item;
  }));
}


const defaultData = {
  jobs: [],
  shifts: [],
  presets: [],
  monthlyGoal: 150000
};

const COLOR_CHOICES = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
  "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
  "#ec4899", "#f43f5e", "#78716c", "#64748b", "#111827"
];

let data = loadData();
let currentDate = new Date();
currentDate.setDate(1);

const yen = value => `¥${Math.round(value).toLocaleString("ja-JP")}`;
const pad = n => String(n).padStart(2, "0");
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const compactTime = value => {
  if (!value) return "";
  const [hour, minute] = value.split(":").map(Number);
  if (minute === 0) return String(hour);
  const decimal = hour + minute / 60;
  return String(Number(decimal.toFixed(2)));
};


function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...safeClone(defaultData), ...saved } : safeClone(defaultData);
  } catch {
    return safeClone(defaultData);
  }
}

function setSyncStatus(message, type = "") {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("sync-ok", "sync-error");
  if (type) el.classList.add(type);
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  if (!currentUser || applyingCloudData) return;
  clearTimeout(saveTimer);
  setSyncStatus("保存中…");
  saveTimer = setTimeout(async () => {
    try {
      await setDoc(doc(db, "users", currentUser.uid), {
        data,
        updatedAt: serverTimestamp()
      }, { merge: true });
      setSyncStatus("同期済み", "sync-ok");
    } catch (error) {
      console.error(error);
      setSyncStatus("同期に失敗しました", "sync-error");
    }
  }, 250);
}

function getJob(jobId) {
  return data.jobs.find(job => job.id === jobId);
}

function minutesFromTime(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function isMinuteInRange(dayMinute, startMinute, endMinute) {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) return dayMinute >= startMinute && dayMinute < endMinute;
  return dayMinute >= startMinute || dayMinute < endMinute;
}

function calculateShift(shift) {
  const job = getJob(shift.jobId);
  if (!job) return { hours: 0, basePay: 0, transport: 0, total: 0, regularMinutes: 0, lateMinutes: 0 };

  let start = minutesFromTime(shift.startTime);
  let end = minutesFromTime(shift.endTime);
  if (end <= start) end += 24 * 60;

  const breakMinutes = Number(shift.breakMinutes || 0);
  const grossMinutes = Math.max(0, end - start);
  const paidMinutes = Math.max(0, grossMinutes - breakMinutes);
  const lateStart = minutesFromTime(job.lateStart || "22:00");
  const lateEnd = minutesFromTime(job.lateEnd || "05:00");
  let lateMinutes = 0;

  for (let minute = start; minute < end; minute++) {
    const dayMinute = minute % (24 * 60);
    if (isMinuteInRange(dayMinute, lateStart, lateEnd)) lateMinutes++;
  }

  if (grossMinutes > 0 && breakMinutes > 0) {
    lateMinutes = Math.max(0, lateMinutes - Math.round(breakMinutes * (lateMinutes / grossMinutes)));
  }

  lateMinutes = Math.min(lateMinutes, paidMinutes);
  const regularMinutes = paidMinutes - lateMinutes;
  const lateWage = Number(job.lateWage || Math.round(job.hourlyWage * 1.25));
  const basePay = regularMinutes / 60 * Number(job.hourlyWage) + lateMinutes / 60 * lateWage;
  const transport = Number(job.transport || 0);
  const total = basePay + transport + Number(shift.bonus || 0) - Number(shift.deduction || 0);

  return { hours: paidMinutes / 60, basePay, transport, total, regularMinutes, lateMinutes };
}

function monthShifts() {
  return data.shifts.filter(shift => {
    const d = new Date(`${shift.date}T00:00:00`);
    return d.getFullYear() === currentDate.getFullYear() && d.getMonth() === currentDate.getMonth();
  });
}

function renderAll() {
  renderCalendar();
  renderSummary();
  renderJobOptions();
  renderPaydayCalendar();
  renderPresetOptions();
}

function renderCalendar() {
  const title = `${currentDate.getFullYear()}年 ${currentDate.getMonth() + 1}月`;
  document.getElementById("monthTitle").textContent = title;

  const calendar = document.getElementById("calendar");
  calendar.innerHTML = "";

  const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  const today = dateKey(new Date());

  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = dateKey(day);

    const cell = document.createElement("div");
    cell.className = "day";
    if (day.getMonth() !== currentDate.getMonth()) cell.classList.add("outside");
    if (key === today) cell.classList.add("today");

    const number = document.createElement("div");
    number.className = "day-number";
    number.textContent = day.getDate();
    cell.appendChild(number);

    data.shifts
      .filter(shift => shift.date === key)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .forEach(shift => {
        const job = getJob(shift.jobId);
        if (!job) return;

        const chip = document.createElement("div");
        chip.className = "shift-chip";
        chip.style.background = job.color;
        chip.innerHTML = `
          <b>${job.name}</b>
          <span class="shift-time-vertical">
            <span>${shift.startTime}</span>
            <i></i>
            <span>${shift.endTime}</span>
          </span>
        `;
        chip.addEventListener("click", e => {
          e.stopPropagation();
          openShiftDetail(shift);
        });
        cell.appendChild(chip);
      });

    cell.addEventListener("click", () => openShiftModal(null, key));
    calendar.appendChild(cell);
  }
}

function renderSummary() {
  const shifts = monthShifts();
  const totals = shifts.reduce((acc, shift) => {
    const calc = calculateShift(shift);
    acc.hours += calc.hours;
    acc.pay += calc.total;
    return acc;
  }, { hours: 0, pay: 0 });

  document.getElementById("totalHours").textContent = `${totals.hours.toFixed(1)}時間`;
  document.getElementById("totalPay").textContent = yen(totals.pay);

  const grouped = {};
  shifts.forEach(shift => {
    const job = getJob(shift.jobId);
    if (!job) return;
    const calc = calculateShift(shift);
    if (!grouped[job.id]) grouped[job.id] = {
      job, hours: 0, total: 0
    };
    grouped[job.id].hours += calc.hours;
    grouped[job.id].total += calc.total;
  });

  const body = document.getElementById("summaryBody");
  body.innerHTML = "";

  Object.values(grouped).forEach(row => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="color-dot" style="background:${row.job.color}"></span>${row.job.name}</td>
      <td><strong>${yen(row.total)}</strong></td>
      <td>${row.hours.toFixed(1)}時間</td>
    `;
    body.appendChild(tr);
  });

  if (!Object.keys(grouped).length) {
    body.innerHTML = `<tr><td colspan="3" class="empty">この月の勤務はありません</td></tr>`;
  }

  document.getElementById("summaryFoot").innerHTML = `
    <tr>
      <td>全部の合計</td>
      <td>${yen(totals.pay)}</td>
      <td>${totals.hours.toFixed(1)}時間</td>
    </tr>
  `;
}

function renderShiftList() {
  const list = document.getElementById("shiftList");
  if (!list) return;
  const shifts = monthShifts().sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  list.innerHTML = "";

  if (!shifts.length) {
    list.innerHTML = `<div class="empty">勤務を登録するとここに一覧表示されます</div>`;
    return;
  }

  shifts.forEach(shift => {
    const job = getJob(shift.jobId);
    if (!job) return;
    const calc = calculateShift(shift);
    const row = document.createElement("div");
    row.className = "shift-row";
    row.innerHTML = `
      <div><strong>${shift.date}</strong><br>${shift.startTime}–${shift.endTime}</div>
      <div class="shift-main">
        <strong><span class="color-dot" style="background:${job.color}"></span>${job.name}</strong>
        <small>${calc.hours.toFixed(1)}時間${shift.memo ? `・${shift.memo}` : ""}</small>
      </div>
      <strong>${yen(calc.total)}</strong>
    `;
    row.addEventListener("click", () => openShiftModal(shift));
    list.appendChild(row);
  });
}

function renderColorPalette(selected = document.getElementById("jobColor").value || COLOR_CHOICES[0]) {
  const palette = document.getElementById("colorPalette");
  palette.innerHTML = "";
  COLOR_CHOICES.forEach(color => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `color-choice${color === selected ? " selected" : ""}`;
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => {
      document.getElementById("jobColor").value = color;
      renderColorPalette(color);
    });
    palette.appendChild(btn);
  });
}

function renderPresetOptions() {
  const jobOptions = data.jobs.length
    ? data.jobs.map(job => `<option value="${job.id}">${job.name}</option>`).join("")
    : `<option value="">先にバイト先を登録してください</option>`;
  document.getElementById("presetJob").innerHTML = jobOptions;

  const manage = document.getElementById("presetManageList");
  manage.innerHTML = data.presets.length ? "<strong>登録済み</strong>" : "";
  data.presets.forEach(preset => {
    const job = getJob(preset.jobId);
    if (!job) return;
    const item = document.createElement("div");
    item.className = "manage-job";
    item.innerHTML = `<span><span class="color-dot" style="background:${job.color}"></span>${preset.name}（${preset.startTime}–${preset.endTime}）</span><button type="button" class="secondary">編集</button>`;
    item.querySelector("button").addEventListener("click", () => openPresetModal(preset));
    manage.appendChild(item);
  });

  const shiftList = document.getElementById("shiftPresetList");
  if (shiftList) {
    shiftList.innerHTML = "";
    data.presets.forEach(preset => shiftList.appendChild(createPresetButton(preset)));
    if (!data.presets.length) {
      shiftList.innerHTML = `<span class="field-note">プリセットを登録するとここに表示されます</span>`;
    }
  }
}

function createPresetButton(preset) {
  const job = getJob(preset.jobId);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-button";
  btn.innerHTML = `<span><span class="color-dot" style="background:${job?.color || '#64748b'}"></span>${preset.name}</span><small>${preset.startTime}–${preset.endTime}</small>`;

  btn.addEventListener("click", () => {
    const selectedDate = document.getElementById("shiftDate").value;
    if (!selectedDate) {
      alert("先に日付を選んでください。");
      return;
    }

    const shift = {
      id: crypto.randomUUID(),
      date: selectedDate,
      jobId: preset.jobId,
      startTime: preset.startTime,
      endTime: preset.endTime,
      breakMinutes: Number(preset.breakMinutes || 0)
    };

    data.shifts.push(shift);
    saveData();
    renderAll();
    document.getElementById("shiftModal").close();
  });

  return btn;
}

function applyPresetToShiftForm(preset) {
  document.getElementById("shiftJob").value = preset.jobId;
  renderShiftJobChoices(preset.jobId);
  document.getElementById("startTime").value = preset.startTime;
  document.getElementById("endTime").value = preset.endTime;
  document.getElementById("breakMinutes").value = preset.breakMinutes || 0;
  updatePreview();
}

function renderShiftJobChoices(selectedJobId = "") {
  const container = document.getElementById("shiftJobChoices");
  const hiddenInput = document.getElementById("shiftJob");
  if (!container || !hiddenInput) return;

  const selected = selectedJobId || hiddenInput.value || data.jobs[0]?.id || "";
  hiddenInput.value = selected;
  container.innerHTML = "";

  data.jobs.forEach(job => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `job-choice${job.id === selected ? " selected" : ""}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", job.id === selected ? "true" : "false");
    button.innerHTML = `<span class="color-dot" style="background:${job.color}"></span><span>${job.name}</span>`;
    button.addEventListener("click", () => {
      hiddenInput.value = job.id;
      renderShiftJobChoices(job.id);
      updatePreview();
    });
    container.appendChild(button);
  });
}

function renderJobOptions() {
  const manage = document.getElementById("jobManageList");
  manage.innerHTML = data.jobs.length ? "<strong>登録済み</strong>" : "";
  data.jobs.forEach(job => {
    const item = document.createElement("div");
    item.className = "manage-job";
    item.innerHTML = `
      <span><span class="color-dot" style="background:${job.color}"></span>${job.name}（時給${yen(job.hourlyWage)}）</span>
      <button type="button" class="secondary">編集</button>
    `;
    item.querySelector("button").addEventListener("click", () => fillJobForm(job));
    manage.appendChild(item);
  });

  const presetJob = document.getElementById("presetJob");
  if (presetJob) {
    const currentValue = presetJob.value;
    presetJob.innerHTML = data.jobs.length
      ? data.jobs.map(job => `<option value="${job.id}">${job.name}</option>`).join("")
      : `<option value="">先にバイト先を登録してください</option>`;
    if (data.jobs.some(job => job.id === currentValue)) {
      presetJob.value = currentValue;
    }
  }

  renderShiftJobChoices(document.getElementById("shiftJob")?.value || "");
}

function openJobModal(job = null) {
  document.getElementById("jobForm").reset();
  document.getElementById("jobColor").value = COLOR_CHOICES[12];
  document.getElementById("lateStart").value = "22:00";
  document.getElementById("lateEnd").value = "05:00";
  document.getElementById("transport").value = 0;
  document.getElementById("cutoffDay").value = "end";
  document.getElementById("paydayDay").value = "25";
  document.getElementById("paydayOffset").value = "1";
  renderColorPalette(COLOR_CHOICES[12]);
  document.getElementById("jobId").value = "";
  document.getElementById("deleteJobBtn").classList.add("hidden");
  if (job) fillJobForm(job);
  renderJobOptions();
  document.getElementById("jobModal").showModal();
}

function fillJobForm(job) {
  document.getElementById("jobId").value = job.id;
  document.getElementById("jobName").value = job.name;
  document.getElementById("hourlyWage").value = job.hourlyWage;
  document.getElementById("lateWage").value = job.lateWage || "";
  document.getElementById("lateStart").value = job.lateStart || "22:00";
  document.getElementById("lateEnd").value = job.lateEnd || "05:00";
  document.getElementById("transport").value = job.transport || 0;
  document.getElementById("cutoffDay").value = job.cutoffDay || "end";
  document.getElementById("paydayDay").value = String(job.paydayDay || 25);
  document.getElementById("paydayOffset").value = String(job.paydayOffset ?? 1);
  document.getElementById("jobColor").value = job.color;
  renderColorPalette(job.color);
  document.getElementById("deleteJobBtn").classList.remove("hidden");
}

function openPresetModal(preset = null) {
  renderJobOptions();
  if (!data.jobs.length) { alert("先にバイト先を登録してください。"); openJobModal(); return; }
  document.getElementById("presetForm").reset();
  document.getElementById("presetId").value = "";
  document.getElementById("presetBreak").value = 0;
  document.getElementById("deletePresetBtn").classList.add("hidden");
  renderPresetOptions();
  if (preset) fillPresetForm(preset);
  document.getElementById("presetModal").showModal();
}

function fillPresetForm(preset) {
  document.getElementById("presetId").value = preset.id;
  document.getElementById("presetName").value = preset.name;
  document.getElementById("presetJob").value = preset.jobId;
  document.getElementById("presetStart").value = preset.startTime;
  document.getElementById("presetEnd").value = preset.endTime;
  document.getElementById("presetBreak").value = preset.breakMinutes || 0;
  document.getElementById("deletePresetBtn").classList.remove("hidden");
}

let detailShiftId = null;

function openShiftDetail(shift) {
  const job = getJob(shift.jobId);
  if (!job) return;

  detailShiftId = shift.id;
  const calc = calculateShift(shift);
  document.getElementById("shiftDetailBody").innerHTML = `
    <div class="shift-detail-card">
      <div class="shift-detail-job">
        <span class="color-dot" style="background:${job.color}"></span>
        <strong>${job.name}</strong>
      </div>
      <div class="shift-detail-list">
        <div>
          <span>時刻</span>
          <strong>${shift.startTime}-${shift.endTime}</strong>
        </div>
        <div>
          <span>労働時間</span>
          <strong>${calc.hours.toFixed(1)}時間</strong>
        </div>
        <div>
          <span>給料</span>
          <strong>${yen(calc.total)}</strong>
        </div>
      </div>
    </div>
  `;
  document.getElementById("shiftDetailModal").showModal();
}

function openShiftModal(shift = null, selectedDate = null) {
  if (!data.jobs.length) {
    alert("先にバイト先を登録してください。");
    openJobModal();
    return;
  }

  document.getElementById("shiftForm").reset();
  document.getElementById("shiftId").value = "";
  document.getElementById("shiftDate").value = selectedDate || dateKey(new Date());
  document.getElementById("breakMinutes").value = 0;
  document.getElementById("deleteShiftBtn").classList.add("hidden");

  const selectedJobId = shift?.jobId || data.jobs[0].id;
  document.getElementById("shiftJob").value = selectedJobId;

  if (shift) {
    document.getElementById("shiftId").value = shift.id;
    document.getElementById("shiftDate").value = shift.date;
    document.getElementById("startTime").value = shift.startTime;
    document.getElementById("endTime").value = shift.endTime;
    document.getElementById("breakMinutes").value = shift.breakMinutes || 0;
    document.getElementById("deleteShiftBtn").classList.remove("hidden");
  }

  renderShiftJobChoices(selectedJobId);
  updatePreview();
  document.getElementById("shiftModal").showModal();
}

function getShiftFormData() {
  return {
    id: document.getElementById("shiftId").value || crypto.randomUUID(),
    date: document.getElementById("shiftDate").value,
    jobId: document.getElementById("shiftJob").value,
    startTime: document.getElementById("startTime").value,
    endTime: document.getElementById("endTime").value,
    breakMinutes: Number(document.getElementById("breakMinutes").value || 0)
  };
}

function updatePreview() {
  const shift = getShiftFormData();
  const preview = document.getElementById("calcPreview");
  if (!shift.jobId || !shift.startTime || !shift.endTime) {
    preview.textContent = "勤務時間と給料がここに表示されます";
    return;
  }
  const calc = calculateShift(shift);
  preview.textContent = `労働 ${calc.hours.toFixed(1)}時間 ／ 予想給料 ${yen(calc.total)}`;
}

document.getElementById("presetForm").addEventListener("submit", e => {
  const selectedPresetJob = document.getElementById("presetJob").value;
  if (!selectedPresetJob) {
    e.preventDefault();
    alert("先にバイト先を登録してください。");
    return;
  }
  e.preventDefault();
  const id = document.getElementById("presetId").value || crypto.randomUUID();
  const preset = {
    id,
    name: document.getElementById("presetName").value.trim(),
    jobId: document.getElementById("presetJob").value,
    startTime: document.getElementById("presetStart").value,
    endTime: document.getElementById("presetEnd").value,
    breakMinutes: Number(document.getElementById("presetBreak").value || 0)
  };
  const index = data.presets.findIndex(p => p.id === id);
  if (index >= 0) data.presets[index] = preset; else data.presets.push(preset);
  saveData(); renderAll(); document.getElementById("presetModal").close();
});

document.getElementById("deletePresetBtn").addEventListener("click", () => {
  const id = document.getElementById("presetId").value;
  if (!id || !confirm("このプリセットを削除しますか？")) return;
  data.presets = data.presets.filter(p => p.id !== id);
  saveData(); renderAll(); document.getElementById("presetModal").close();
});

document.getElementById("jobForm").addEventListener("submit", e => {
  e.preventDefault();
  const id = document.getElementById("jobId").value || crypto.randomUUID();
  const job = {
    id,
    name: document.getElementById("jobName").value.trim(),
    hourlyWage: Number(document.getElementById("hourlyWage").value),
    lateWage: Number(document.getElementById("lateWage").value || 0),
    lateStart: document.getElementById("lateStart").value || "22:00",
    lateEnd: document.getElementById("lateEnd").value || "05:00",
    transport: Number(document.getElementById("transport").value || 0),
    cutoffDay: document.getElementById("cutoffDay").value || "end",
    paydayDay: Number(document.getElementById("paydayDay").value || 25),
    paydayOffset: Number(document.getElementById("paydayOffset").value || 1),
    color: document.getElementById("jobColor").value
  };

  const index = data.jobs.findIndex(j => j.id === id);
  if (index >= 0) data.jobs[index] = job;
  else data.jobs.push(job);

  saveData();
  renderAll();
  document.getElementById("jobModal").close();
});

document.getElementById("shiftForm").addEventListener("submit", e => {
  e.preventDefault();
  const shift = getShiftFormData();
  if (!shift.startTime || !shift.endTime) return;

  const index = data.shifts.findIndex(s => s.id === shift.id);
  if (index >= 0) data.shifts[index] = shift;
  else data.shifts.push(shift);

  saveData();
  renderAll();
  document.getElementById("shiftModal").close();
});

document.getElementById("deleteJobBtn").addEventListener("click", () => {
  const id = document.getElementById("jobId").value;
  if (!id) return;
  if (!confirm("このバイト先を削除しますか？関連する勤務記録も削除されます。")) return;
  data.jobs = data.jobs.filter(j => j.id !== id);
  data.shifts = data.shifts.filter(s => s.jobId !== id);
  data.presets = data.presets.filter(p => p.jobId !== id);
  saveData();
  renderAll();
  document.getElementById("jobModal").close();
});

document.getElementById("deleteShiftBtn").addEventListener("click", () => {
  const id = document.getElementById("shiftId").value;
  if (!id || !confirm("この勤務記録を削除しますか？")) return;
  data.shifts = data.shifts.filter(s => s.id !== id);
  saveData();
  renderAll();
  document.getElementById("shiftModal").close();
});

["startTime", "endTime", "breakMinutes"].forEach(id => {
  document.getElementById(id).addEventListener("input", updatePreview);
});


document.getElementById("prevMonthBtn").addEventListener("click", () => {
  currentDate.setMonth(currentDate.getMonth() - 1);
  renderAll();
});

document.getElementById("nextMonthBtn").addEventListener("click", () => {
  currentDate.setMonth(currentDate.getMonth() + 1);
  renderAll();
});

document.getElementById("todayBtn").addEventListener("click", () => {
  currentDate = new Date();
  currentDate.setDate(1);
  renderAll();
});

document.getElementById("openJobModalBtn").addEventListener("click", () => openJobModal());
document.getElementById("openPresetModalBtn").addEventListener("click", () => openPresetModal());
document.getElementById("openShiftModalBtn").addEventListener("click", () => openShiftModal());

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => document.getElementById(btn.dataset.close).close());
});

document.getElementById("backupBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `salary-calendar-backup-${dateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("restoreInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const restored = JSON.parse(await file.text());
    if (!restored.jobs || !restored.shifts) throw new Error();
    data = { ...defaultData, ...restored };
    saveData();
    renderAll();
    alert("データを復元しました。");
  } catch {
    alert("このファイルは読み込めませんでした。");
  }
  e.target.value = "";
});



let paydayDate = new Date(); paydayDate.setDate(1);

function initDaySelects() {
  const cutoff = document.getElementById("cutoffDay");
  for (let i=1;i<=28;i++) cutoff.insertAdjacentHTML("beforeend", `<option value="${i}">${i}日</option>`);
  const payday = document.getElementById("paydayDay");
  for (let i=1;i<=28;i++) payday.insertAdjacentHTML("beforeend", `<option value="${i}">${i}日</option>`);
  payday.value = "25";
}

function clampDay(year, month, day) {
  return Math.min(day, new Date(year, month + 1, 0).getDate());
}

function getPaydayForShift(shift, job) {
  const d = new Date(`${shift.date}T00:00:00`);
  let cy = d.getFullYear(), cm = d.getMonth();
  if (job.cutoffDay && job.cutoffDay !== "end") {
    const cutoff = Number(job.cutoffDay);
    if (d.getDate() > cutoff) { cm++; if (cm > 11) { cm=0; cy++; } }
  }
  let py = cy, pm = cm + Number(job.paydayOffset ?? 1);
  while (pm > 11) { pm -= 12; py++; }
  const pd = clampDay(py, pm, Number(job.paydayDay || 25));
  return new Date(py, pm, pd);
}

function getPaydayEntries() {
  const grouped = {};
  data.shifts.forEach(shift => {
    const job = getJob(shift.jobId); if (!job) return;
    const payday = getPaydayForShift(shift, job);
    const key = `${dateKey(payday)}__${job.id}`;
    if (!grouped[key]) grouped[key] = { date: dateKey(payday), job, total: 0, hours: 0, count: 0 };
    const calc = calculateShift(shift);
    grouped[key].total += calc.total; grouped[key].hours += calc.hours; grouped[key].count++;
  });
  return Object.values(grouped);
}

function openPaydayDetail(date, entries) {
  const modal = document.getElementById("paydayDetailModal");
  document.getElementById("paydayDetailTitle").textContent = `${date.replaceAll("-", "/")}の給料`;
  const body = document.getElementById("paydayDetailBody");
  body.innerHTML = entries.map(entry => `
    <div class="payday-detail-row">
      <div>
        <span class="color-dot" style="background:${entry.job.color}"></span>
        <strong>${entry.job.name}</strong>
      </div>
      <strong>${yen(entry.total)}</strong>
    </div>
  `).join("");
  modal.showModal();
}

function renderPaydayCalendar() {
  const cal = document.getElementById("paydayCalendar");
  if (!cal) return;

  document.getElementById("payMonthTitle").textContent =
    `${paydayDate.getFullYear()}年 ${paydayDate.getMonth() + 1}月`;

  const entries = getPaydayEntries().filter(entry => {
    const date = new Date(`${entry.date}T00:00:00`);
    return date.getFullYear() === paydayDate.getFullYear()
      && date.getMonth() === paydayDate.getMonth();
  });

  document.getElementById("paydayMonthTotal").textContent =
    yen(entries.reduce((sum, entry) => sum + entry.total, 0));
  document.getElementById("paydayCount").textContent = `${entries.length}件`;

  cal.innerHTML = "";
  const first = new Date(paydayDate.getFullYear(), paydayDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = dateKey(day);
    const dayEntries = entries.filter(entry => entry.date === key);

    const cell = document.createElement("div");
    cell.className = "day";
    if (day.getMonth() !== paydayDate.getMonth()) cell.classList.add("outside");
    if (dayEntries.length) cell.classList.add("has-payday");
    cell.innerHTML = `<div class="day-number">${day.getDate()}</div>`;

    if (dayEntries.length) {
      dayEntries.forEach(entry => {
        const marker = document.createElement("button");
        marker.type = "button";
        marker.className = "payday-marker";
        marker.style.background = entry.job.color;
        marker.innerHTML = `<span>${entry.job.name}</span><strong>${yen(entry.total)}</strong>`;
        marker.addEventListener("click", event => {
          event.stopPropagation();
          openPaydayDetail(key, [entry]);
        });
        cell.appendChild(marker);
      });
      cell.addEventListener("click", () => openPaydayDetail(key, dayEntries));
    }

    cal.appendChild(cell);
  }

  const list = document.getElementById("paydayList");
  list.innerHTML = "";
  entries
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(entry => {
      const row = document.createElement("div");
      row.className = "payday-row";
      row.innerHTML = `
        <div>
          <strong>${entry.date}</strong>
          <small>${entry.count}勤務・${entry.hours.toFixed(1)}時間</small>
        </div>
        <div>
          <span class="color-dot" style="background:${entry.job.color}"></span>${entry.job.name}
        </div>
        <strong>${yen(entry.total)}</strong>
      `;
      row.addEventListener("click", () => openPaydayDetail(entry.date, [entry]));
      list.appendChild(row);
    });

  if (!entries.length) {
    list.innerHTML = '<div class="empty">この月に入る給料はありません</div>';
  }
}

document.getElementById("editShiftFromDetailBtn").addEventListener("click", () => {
  const shift = data.shifts.find(item => item.id === detailShiftId);
  if (!shift) return;
  document.getElementById("shiftDetailModal").close();
  openShiftModal(shift);
});

document.getElementById("workTabBtn").addEventListener("click",()=>{document.getElementById("workView").classList.remove("hidden");document.getElementById("paydayView").classList.add("hidden");document.getElementById("workTabBtn").classList.add("active");document.getElementById("paydayTabBtn").classList.remove("active");});
document.getElementById("paydayTabBtn").addEventListener("click",()=>{document.getElementById("workView").classList.add("hidden");document.getElementById("paydayView").classList.remove("hidden");document.getElementById("paydayTabBtn").classList.add("active");document.getElementById("workTabBtn").classList.remove("active");renderPaydayCalendar();});
document.getElementById("payPrevMonthBtn").addEventListener("click",()=>{paydayDate.setMonth(paydayDate.getMonth()-1);renderPaydayCalendar();});
document.getElementById("payNextMonthBtn").addEventListener("click",()=>{paydayDate.setMonth(paydayDate.getMonth()+1);renderPaydayCalendar();});
document.getElementById("payTodayBtn").addEventListener("click",()=>{paydayDate=new Date();paydayDate.setDate(1);renderPaydayCalendar();});

initDaySelects();


async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  try {
    setSyncStatus("ログイン中…");

    if (isIOS || isSafari) {
      await signInWithRedirect(auth, provider);
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (error) {
    console.error("Google login failed:", error);
    const code = error?.code || "unknown";
    alert(`Googleログインに失敗しました。
エラー: ${code}`);
    setSyncStatus(`ログイン失敗: ${code}`, "sync-error");
  }
}

async function connectUserCloud(user) {
  if (!user?.uid) {
    throw new Error("ログインユーザー情報を取得できませんでした。");
  }

  if (unsubscribeCloud) unsubscribeCloud();

  const userRef = doc(db, "users", user.uid);
  let first;

  try {
    first = await getDoc(userRef);
  } catch (error) {
    console.error("Firestore read failed:", error);
    throw error;
  }

  if (!first.exists()) {
    const cleanData = sanitizeForFirestore(data);
    try {
      await setDoc(
        userRef,
        {
          data: cleanData,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Firestore initial write failed:", error);
      throw error;
    }
  } else {
    const cloud = first.data()?.data;
    if (cloud && typeof cloud === "object") {
      applyingCloudData = true;
      data = { ...safeClone(defaultData), ...cloud };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderAll();
      applyingCloudData = false;
    }
  }

  unsubscribeCloud = onSnapshot(
    userRef,
    snap => {
      const cloud = snap.data()?.data;
      if (!cloud || typeof cloud !== "object") return;

      applyingCloudData = true;
      data = { ...safeClone(defaultData), ...cloud };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderAll();
      applyingCloudData = false;
      setSyncStatus("同期済み", "sync-ok");
    },
    error => {
      console.error("Firestore snapshot failed:", error);
      const code = error?.code || "unknown";
      setSyncStatus(`同期エラー: ${code}`, "sync-error");
    }
  );
}

document.getElementById("loginBtn")?.addEventListener("click", loginWithGoogle);
document.getElementById("overlayLoginBtn")?.addEventListener("click", loginWithGoogle);
document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

getRedirectResult(auth).catch(error => {
  console.error("Google redirect result failed:", error);
  const code = error?.code || "unknown";
  if (code !== "auth/no-auth-event") {
    alert(`Googleログインの完了処理に失敗しました。\nエラー: ${code}`);
  }
});
onAuthStateChanged(auth, async user => {
  currentUser = user;
  const overlay = document.getElementById("loginOverlay");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userLabel = document.getElementById("userLabel");

  if (!user) {
    if (unsubscribeCloud) unsubscribeCloud();
    unsubscribeCloud = null;
    overlay.classList.remove("hidden");
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
    userLabel.textContent = "未ログイン";
    setSyncStatus("ログイン待ち");
    renderAll();
    return;
  }

  overlay.classList.add("hidden");
  loginBtn.classList.add("hidden");
  logoutBtn.classList.remove("hidden");
  userLabel.textContent = user.displayName || user.email || "ログイン中";
  setSyncStatus("クラウドに接続中…");
  try {
    await connectUserCloud(user);
  } catch (error) {
    console.error(error);
    const code = error?.code || "unknown";
    const message = error?.message || "詳細不明";
    alert(`Firebaseへの接続に失敗しました。\nエラー: ${code}\n${message}`);
    setSyncStatus(`接続失敗: ${code}`, "sync-error");
  }
});

renderAll();

