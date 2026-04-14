import { useState, useMemo, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { db, firebaseConfigured } from "./firebase.js";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function fmt(n) {
  return "¥" + Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShort(n) {
  if (Math.abs(n) >= 10000) return "¥" + (n / 10000).toFixed(1) + "万";
  return "¥" + Math.round(n).toLocaleString();
}
const todayDate = new Date();
const TODAY_MONTH = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}`;

function daysUntilDue(dueDay) {
  const now = new Date();
  let due = new Date(now.getFullYear(), now.getMonth(), dueDay);
  if (due <= now) due = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
  return Math.ceil((due - now) / 86400000);
}
function daysUntilDate(dateStr) {
  if (!dateStr) return Infinity;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const due = new Date(dateStr); due.setHours(0, 0, 0, 0);
  return Math.ceil((due - now) / 86400000);
}
function calcMinimum(instTotal, spending) {
  return Math.max(instTotal, (instTotal + spending) * 0.1);
}

// ─────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────
const LS_KEY = "debt_tracker_v3";
function loadFromLocal() { try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function saveToLocal(d) { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch {} }

// ─────────────────────────────────────────────
// CREDIT CARD COMPUTE
// ─────────────────────────────────────────────
function computeInstallment(inst) {
  const principal = inst.totalAmount / inst.installmentCount;
  const fee = (inst.totalAmount * inst.feeRateMonthly) / 100;
  const monthlyTotal = principal + fee;
  const remainingCount = inst.installmentCount - inst.paidCount;
  const remainingBalance = principal * remainingCount;
  return { ...inst, principal, fee, monthlyTotal, remainingCount, remainingBalance };
}
function computeCreditCard(card) {
  const instDetails = card.installments.map(computeInstallment);
  const activeInsts = instDetails.filter(i => i.remainingCount > 0);
  const instMonthlyTotal = activeInsts.reduce((s, i) => s + i.monthlyTotal, 0);
  const totalBill = instMonthlyTotal + card.lastMonthSpending;
  const minimumPayment = calcMinimum(instMonthlyTotal, card.lastMonthSpending);
  const totalRemainingBalance = activeInsts.reduce((s, i) => s + i.remainingBalance, 0) + card.lastMonthSpending;
  return { instDetails, activeInsts, instMonthlyTotal, totalBill, minimumPayment, totalRemainingBalance };
}

// ─────────────────────────────────────────────
// PROJECTION — stacked bar chart data
// ─────────────────────────────────────────────
function buildProjection(debts, months = 14) {
  const now = new Date();
  return Array.from({ length: months }, (_, m) => {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const isFuture = d > now || (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear());
    const label = (d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}/` : "") + `${d.getMonth() + 1}月`;
    const row = { month: label, _m: m };
    debts.forEach(debt => {
      let payment = 0;
      if (debt.type === "credit_card") {
        payment = debt.installments.reduce((s, inst) => {
          const rem = inst.installmentCount - inst.paidCount - m;
          return rem > 0 ? s + computeInstallment(inst).monthlyTotal : s;
        }, 0) + (m === 0 ? debt.lastMonthSpending : 0);
      } else if (debt.loanStyle === "installment" && debt.totalPeriods > 0) {
        const rem = Math.max(0, debt.totalPeriods - (debt.paidPeriods || 0));
        payment = rem > m ? (debt.monthlyPayment || 0) : 0;
      } else if (debt.loanStyle === "lumpsum" && debt.dueDate) {
        const due = new Date(debt.dueDate);
        if (due.getFullYear() === d.getFullYear() && due.getMonth() === d.getMonth())
          payment = debt.remainingBalance || 0;
      } else if (debt.loanStyle === "flexible") {
        payment = debt.monthlyPayment || 0;
      }
      row[`d_${debt.id}`] = Math.round(payment);
    });
    return row;
  });
}

// ─────────────────────────────────────────────
// EXPORT TO EXCEL
// ─────────────────────────────────────────────
function applyHeaderStyle(ws, headers) {
  headers.forEach((_, ci) => {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c: ci });
    if (!ws[cellAddr]) return;
    ws[cellAddr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "1E40AF" } },
      alignment: { horizontal: "center" },
    };
  });
}

function setColWidths(ws, widths) {
  ws["!cols"] = widths.map(w => ({ wch: w }));
}

function exportToExcel(debts, projectionData) {
  const wb = XLSX.utils.book_new();
  const date = new Date().toLocaleDateString("zh-CN");

  // ── Sheet 1: 总览 ──
  const overviewRows = debts.map(d => {
    const isCard = d.type === "credit_card";
    const isLs = d.loanStyle === "lumpsum";
    const cc = isCard ? computeCreditCard(d) : null;
    const monthly = isCard ? cc.totalBill : (isLs ? 0 : (d.monthlyPayment || 0));
    const typeLabel = isCard ? "信用卡" : (d.loanStyle === "installment" ? "分期贷款" : isLs ? "一次性到期" : "灵活还款");
    return {
      "名称": d.name,
      "类型": typeLabel,
      "剩余余额 (元)": d.remainingBalance || 0,
      "月供 (元)": monthly,
      "年利率 (%)": d.interestRate || 0,
      "还款日": isLs ? d.dueDate : `每月${d.dueDay}日`,
      "还款记录条数": (d.payments || []).length,
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(overviewRows);
  applyHeaderStyle(ws1, Object.keys(overviewRows[0] || {}));
  setColWidths(ws1, [18, 10, 16, 14, 12, 16, 12]);
  XLSX.utils.book_append_sheet(wb, ws1, "总览");

  // ── Sheet 2: 信用卡分期 ──
  const cardRows = [];
  debts.filter(d => d.type === "credit_card").forEach(card => {
    card.installments.forEach(inst => {
      const r = computeInstallment(inst);
      cardRows.push({
        "信用卡名称": card.name,
        "分期项目": inst.name,
        "分期总额 (元)": inst.totalAmount,
        "总期数": inst.installmentCount,
        "已还期数": inst.paidCount,
        "剩余期数": inst.installmentCount - inst.paidCount,
        "月手续费率 (%)": inst.feeRateMonthly,
        "每月还款 (元)": Math.round(r.monthlyTotal),
        "剩余金额 (元)": Math.round(r.remainingBalance),
        "开始日期": inst.startDate || "",
      });
    });
    if ((card.lastMonthSpending || 0) > 0) {
      cardRows.push({
        "信用卡名称": card.name,
        "分期项目": "上月消费（非分期）",
        "分期总额 (元)": card.lastMonthSpending,
        "总期数": "-",
        "已还期数": "-",
        "剩余期数": "-",
        "月手续费率 (%)": "-",
        "每月还款 (元)": card.lastMonthSpending,
        "剩余金额 (元)": card.lastMonthSpending,
        "开始日期": "-",
      });
    }
  });
  if (cardRows.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(cardRows);
    applyHeaderStyle(ws2, Object.keys(cardRows[0]));
    setColWidths(ws2, [16, 18, 14, 8, 8, 8, 14, 14, 14, 12]);
    XLSX.utils.book_append_sheet(wb, ws2, "信用卡分期");
  }

  // ── Sheet 3: 贷款明细 ──
  const loanRows = debts.filter(d => d.type === "loan").map(d => ({
    "名称": d.name,
    "贷款类型": d.loanStyle === "installment" ? "分期" : d.loanStyle === "lumpsum" ? "一次性到期" : "灵活还款",
    "贷款总额 (元)": d.totalAmount || 0,
    "剩余余额 (元)": d.remainingBalance || 0,
    "总期数": d.totalPeriods || "-",
    "已还期数": d.paidPeriods || "-",
    "月供 (元)": d.monthlyPayment || "-",
    "年利率 (%)": d.interestRate || 0,
    "还款日 / 到期日": d.loanStyle === "lumpsum" ? d.dueDate : `每月${d.dueDay}日`,
  }));
  if (loanRows.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(loanRows);
    applyHeaderStyle(ws3, Object.keys(loanRows[0]));
    setColWidths(ws3, [18, 12, 14, 14, 8, 8, 12, 12, 16]);
    XLSX.utils.book_append_sheet(wb, ws3, "贷款明细");
  }

  // ── Sheet 4: 还款记录 ──
  const payRows = [];
  debts.forEach(d => {
    (d.payments || []).forEach(p => {
      payRows.push({
        "账户名称": d.name,
        "类型": d.type === "credit_card" ? "信用卡" : "贷款",
        "还款月份": p.month,
        "还款金额 (元)": p.amount,
        "还款日期": p.date ? new Date(p.date).toLocaleDateString("zh-CN") : "",
      });
    });
  });
  payRows.sort((a, b) => b["还款月份"].localeCompare(a["还款月份"]));
  if (payRows.length > 0) {
    const ws4 = XLSX.utils.json_to_sheet(payRows);
    applyHeaderStyle(ws4, Object.keys(payRows[0]));
    setColWidths(ws4, [18, 8, 12, 14, 14]);
    XLSX.utils.book_append_sheet(wb, ws4, "还款记录");
  }

  // ── Sheet 5: 月供预测 ──
  const projRows = projectionData.map(row => {
    const obj = { "月份": row.month };
    let total = 0;
    debts.forEach(d => { const v = row[`d_${d.id}`] || 0; obj[d.name] = v; total += v; });
    obj["月供合计 (元)"] = total;
    return obj;
  });
  const ws5 = XLSX.utils.json_to_sheet(projRows);
  applyHeaderStyle(ws5, Object.keys(projRows[0] || {}));
  setColWidths(ws5, [8, ...debts.map(() => 14), 14]);
  XLSX.utils.book_append_sheet(wb, ws5, "月供预测");

  XLSX.writeFile(wb, `负债记录_${date.replace(/\//g, "-")}.xlsx`);
}

// ─────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────
const DEMO_DEBTS = [
  { id: 1, type: "credit_card", name: "招商银行信用卡", color: "#ef4444", dueDay: 8, lastMonthSpending: 2800,
    installments: [
      { id: 101, name: "iPhone 16 Pro", totalAmount: 9999, installmentCount: 24, paidCount: 5, feeRateMonthly: 0.6, startDate: "2024-08" },
      { id: 102, name: "装修定金", totalAmount: 18000, installmentCount: 12, paidCount: 2, feeRateMonthly: 0.75, startDate: "2025-01" },
    ], payments: [] },
  { id: 2, type: "loan", name: "车贷（招行）", color: "#a855f7", dueDay: 20, loanStyle: "installment",
    totalAmount: 80000, remainingBalance: 62000, monthlyPayment: 2100, interestRate: 5.5,
    totalPeriods: 60, paidPeriods: 18, payments: [] },
  { id: 3, type: "loan", name: "建行消费贷", color: "#3b82f6", dueDay: 14, loanStyle: "lumpsum",
    dueDate: "2026-08-14", totalAmount: 52000, remainingBalance: 52000, interestRate: 3.65, payments: [] },
  { id: 4, type: "loan", name: "花呗分期", color: "#f97316", dueDay: 15, loanStyle: "flexible",
    totalAmount: 6000, remainingBalance: 4800, monthlyPayment: 600, interestRate: 14.6, payments: [] },
];

// ─────────────────────────────────────────────
// SHARED UI
// ─────────────────────────────────────────────
function DueBadge({ days }) {
  if (days <= 3) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">⚠ {days}天后到期</span>;
  if (days <= 7) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">{days}天后到期</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">{days}天后到期</span>;
}
function SyncBadge({ status }) {
  if (status === "synced") return <span className="text-xs text-green-400 flex items-center gap-1">☁ 已同步</span>;
  if (status === "saving") return <span className="text-xs text-blue-300 flex items-center gap-1">↑ 同步中…</span>;
  return <span className="text-xs text-gray-400 flex items-center gap-1">💾 本地</span>;
}

// ─────────────────────────────────────────────
// PROJECTION TOOLTIP
// ─────────────────────────────────────────────
function ProjectionTooltip({ active, payload, label, debts }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter(p => (p.value || 0) > 0);
  const total = items.reduce((s, p) => s + p.value, 0);
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-xs min-w-36">
      <p className="font-bold text-gray-700 mb-2">{label} 月供</p>
      {items.map(p => {
        const debt = debts.find(d => `d_${d.id}` === p.dataKey);
        return (
          <div key={p.dataKey} className="flex justify-between gap-3 mb-1">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.fill }} />
              <span className="text-gray-600 truncate max-w-24">{debt?.name || "—"}</span>
            </span>
            <span className="font-semibold text-gray-800">{fmtShort(p.value)}</span>
          </div>
        );
      })}
      {items.length > 1 && (
        <div className="flex justify-between font-bold text-gray-800 border-t border-gray-100 pt-1 mt-1">
          <span>合计</span><span>{fmtShort(total)}</span>
        </div>
      )}
      {total === 0 && <p className="text-gray-400">本月无还款</p>}
    </div>
  );
}

// ─────────────────────────────────────────────
// ADD / EDIT INSTALLMENT MODAL
// ─────────────────────────────────────────────
function InstallmentModal({ cardName, initial, onSave, onClose }) {
  const isEdit = !!initial;
  const [form, setForm] = useState({
    name: initial?.name || "",
    totalAmount: initial ? String(initial.totalAmount) : "",
    installmentCount: initial ? String(initial.installmentCount) : "12",
    feeRateMonthly: initial ? String(initial.feeRateMonthly) : "0.6",
    feeRateAnnual: initial ? String((initial.feeRateMonthly * 12).toFixed(2)) : "7.2",
    paidCount: initial ? String(initial.paidCount) : "0",
    rateMode: "monthly",
  });

  const monthlyRate = form.rateMode === "annual"
    ? Number(form.feeRateAnnual) / 12
    : Number(form.feeRateMonthly);
  const totalCount = Number(form.installmentCount);
  const paidCount = Math.min(Number(form.paidCount) || 0, Math.max(0, totalCount - 1));
  const remainCount = totalCount - paidCount;
  const preview = form.totalAmount
    ? { principal: Number(form.totalAmount) / totalCount, fee: (Number(form.totalAmount) * monthlyRate) / 100 }
    : null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto py-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-1">{isEdit ? "✏️ 编辑分期" : "➕ 新增分期"}</h2>
        <p className="text-xs text-gray-400 mb-4">{cardName}</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">分期名称</label>
            <input className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="如：iPhone 16 Pro"
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500">分期总金额</label>
              <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                value={form.totalAmount} onChange={e => setForm({ ...form, totalAmount: e.target.value })} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500">总期数</label>
              <select className="w-full border rounded-lg p-2 mt-1 text-sm"
                value={form.installmentCount} onChange={e => setForm({ ...form, installmentCount: e.target.value })}>
                {[3,6,9,12,18,24,36].map(n => <option key={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500">当前已还期数</label>
            <div className="flex items-center gap-3 mt-1">
              <div className="flex items-center border rounded-lg overflow-hidden">
                <button className="px-3 py-2 bg-gray-50 text-gray-600 hover:bg-gray-100 text-sm font-bold"
                  onClick={() => setForm({ ...form, paidCount: String(Math.max(0, paidCount - 1)) })}>−</button>
                <span className="px-4 py-2 text-sm font-semibold text-gray-800 min-w-12 text-center">{paidCount}</span>
                <button className="px-3 py-2 bg-gray-50 text-gray-600 hover:bg-gray-100 text-sm font-bold"
                  onClick={() => setForm({ ...form, paidCount: String(Math.min(totalCount - 1, paidCount + 1)) })}>＋</button>
              </div>
              <span className="text-xs text-gray-400">共{totalCount}期，剩 <span className="font-bold text-blue-600">{remainCount}</span> 期</span>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-500">手续费率</label>
              <div className="flex gap-1">
                {[["monthly","月费率"],["annual","年化利率"]].map(([k,l]) => (
                  <button key={k} className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${form.rateMode===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-500"}`}
                    onClick={() => setForm({ ...form, rateMode: k })}>{l}</button>
                ))}
              </div>
            </div>
            {form.rateMode === "monthly" ? (
              <div className="flex items-center gap-2">
                <input type="number" step="0.01" className="flex-1 border rounded-lg p-2 text-sm" placeholder="如：0.6"
                  value={form.feeRateMonthly}
                  onChange={e => setForm({ ...form, feeRateMonthly: e.target.value, feeRateAnnual: String((Number(e.target.value)*12).toFixed(2)) })} />
                <span className="text-sm text-gray-400">%/月</span>
                {form.feeRateMonthly && <span className="text-xs text-gray-400">≈年化{(Number(form.feeRateMonthly)*12).toFixed(1)}%</span>}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input type="number" step="0.1" className="flex-1 border rounded-lg p-2 text-sm" placeholder="如：7.2"
                  value={form.feeRateAnnual}
                  onChange={e => setForm({ ...form, feeRateAnnual: e.target.value, feeRateMonthly: String((Number(e.target.value)/12).toFixed(4)) })} />
                <span className="text-sm text-gray-400">%/年</span>
                {form.feeRateAnnual && <span className="text-xs text-gray-400">≈月{(Number(form.feeRateAnnual)/12).toFixed(2)}%</span>}
              </div>
            )}
            <p className="text-xs text-gray-400 mt-0.5">账单上显示年化就选「年化利率」；不确定填 0</p>
          </div>
          {preview && (
            <div className="bg-blue-50 rounded-xl p-3 text-sm">
              <p className="text-xs font-semibold text-blue-700 mb-1">每月还款预览</p>
              <div className="flex justify-between text-gray-600"><span>本金</span><span>{fmt(preview.principal)}</span></div>
              <div className="flex justify-between text-gray-600"><span>手续费</span><span>{monthlyRate > 0 ? fmt(preview.fee) : "—"}</span></div>
              <div className="flex justify-between font-bold text-blue-700 border-t border-blue-200 mt-1 pt-1">
                <span>月供合计</span><span>{fmt(preview.principal + preview.fee)}</span>
              </div>
              <div className="flex justify-between text-gray-500 text-xs mt-1">
                <span>剩余{remainCount}期本金</span><span>{fmt(preview.principal * remainCount)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-3 mt-4">
          <button className="flex-1 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
            onClick={() => {
              if (!form.name || !form.totalAmount) return alert("请填写名称和金额");
              onSave({
                id: initial?.id || Date.now(),
                name: form.name,
                totalAmount: Number(form.totalAmount),
                installmentCount: totalCount,
                paidCount,
                feeRateMonthly: Number(monthlyRate.toFixed(4)),
                startDate: initial?.startDate || TODAY_MONTH,
              });
              onClose();
            }}>{isEdit ? "保存" : "确认"}</button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ADD / EDIT DEBT MODAL
// ─────────────────────────────────────────────
const PERIOD_OPTIONS = [1,2,3,6,9,12,18,24,36,48,60];
const COLORS_PALETTE = ["#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#a855f7","#ec4899","#14b8a6"];

function DebtModal({ initial, onSave, onClose }) {
  const isEdit = !!initial;
  const initType = initial?.type || "credit_card";
  const initStyle = initial?.loanStyle || "installment";
  const [type, setType] = useState(initType);
  const [form, setForm] = useState({
    name: initial?.name || "",
    color: initial?.color || "#3b82f6",
    dueDay: initial?.dueDay ? String(initial.dueDay) : "",
    dueDate: initial?.dueDate || "",
    lastMonthSpending: initial ? String(initial.lastMonthSpending || 0) : "0",
    totalAmount: initial ? String(initial.totalAmount || "") : "",
    remainingBalance: initial ? String(initial.remainingBalance || "") : "",
    monthlyPayment: initial ? String(initial.monthlyPayment || "") : "",
    interestRate: initial ? String(initial.interestRate || "") : "",
    loanStyle: initStyle,
    totalPeriods: initial ? String(initial.totalPeriods || 12) : "12",
    paidPeriods: initial ? String(initial.paidPeriods || 0) : "0",
  });

  const totalP = Number(form.totalPeriods) || 0;
  const paidP = Math.min(Number(form.paidPeriods) || 0, Math.max(0, totalP - 1));
  const remainP = totalP - paidP;
  const autoMonthly = form.remainingBalance && remainP > 0 && !form.monthlyPayment
    ? (Number(form.remainingBalance) / remainP).toFixed(0) : form.monthlyPayment;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto py-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-4">{isEdit ? "✏️ 编辑负债" : "➕ 新增负债"}</h2>
        {!isEdit && (
          <div className="flex gap-2 mb-4">
            {[["credit_card","💳 信用卡"],["loan","📋 贷款/网贷"]].map(([k,l]) => (
              <button key={k} className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${type===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-600"}`}
                onClick={() => setType(k)}>{l}</button>
            ))}
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">名称</label>
            <input className="w-full border rounded-lg p-2 mt-1 text-sm"
              placeholder={type==="credit_card"?"如：工商银行信用卡":"如：车贷 / 花呗 / 某某网贷"}
              value={form.name} onChange={e => setForm({...form,name:e.target.value})} />
          </div>

          {/* 信用卡 */}
          {type === "credit_card" && (
            <>
              <div>
                <label className="text-xs text-gray-500">还款日（每月几号）</label>
                <input type="number" min="1" max="31" className="w-full border rounded-lg p-2 mt-1 text-sm"
                  value={form.dueDay} onChange={e => setForm({...form,dueDay:e.target.value})} />
              </div>
              <div>
                <label className="text-xs text-gray-500">本期账单新消费（非分期部分）</label>
                <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥ 0"
                  value={form.lastMonthSpending} onChange={e => setForm({...form,lastMonthSpending:e.target.value})} />
                <p className="text-xs text-gray-400 mt-0.5">分期账单可展开后单独添加</p>
              </div>
            </>
          )}

          {/* 贷款 */}
          {type === "loan" && (
            <>
              {/* 还款方式 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">还款方式</label>
                <div className="flex gap-1">
                  {[["installment","📅 等额月供"],["flexible","💸 随时还清"],["lumpsum","📌 一次性到期"]].map(([k,l]) => (
                    <button key={k} className={`flex-1 py-1.5 rounded-xl text-xs font-semibold transition-colors ${form.loanStyle===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-600"}`}
                      onClick={() => setForm({...form,loanStyle:k})}>{l}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {form.loanStyle==="installment" && "固定月供，有还清期数（车贷、房贷、分期网贷）"}
                  {form.loanStyle==="flexible" && "无固定月供，随时可多还（部分网贷、个人借款）"}
                  {form.loanStyle==="lumpsum" && "到期前无需每月还款，到期一次性还清"}
                </p>
              </div>

              {/* 一次性到期：全日期 */}
              {form.loanStyle === "lumpsum" && (
                <div className="bg-orange-50 rounded-xl p-3">
                  <label className="text-xs font-semibold text-orange-700 block mb-2">📌 到期还款日</label>
                  <input type="date" className="w-full border rounded-lg p-2 text-sm bg-white"
                    value={form.dueDate} onChange={e => setForm({...form,dueDate:e.target.value})} />
                  {form.dueDate && (
                    <p className="text-xs text-orange-600 mt-1 font-medium">
                      距到期还有 {daysUntilDate(form.dueDate)} 天
                    </p>
                  )}
                </div>
              )}

              {/* 还款日（等额 / 随时） */}
              {form.loanStyle !== "lumpsum" && (
                <div>
                  <label className="text-xs text-gray-500">还款日（每月几号）</label>
                  <input type="number" min="1" max="31" className="w-full border rounded-lg p-2 mt-1 text-sm"
                    value={form.dueDay} onChange={e => setForm({...form,dueDay:e.target.value})} />
                </div>
              )}

              {/* 金额 */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500">当前剩余欠款</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                    value={form.remainingBalance} onChange={e => setForm({...form,remainingBalance:e.target.value})} />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500">原始借款总额</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥（可选）"
                    value={form.totalAmount} onChange={e => setForm({...form,totalAmount:e.target.value})} />
                </div>
              </div>

              {/* 等额月供：期数 */}
              {form.loanStyle === "installment" && (
                <div className="bg-blue-50 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-semibold text-blue-700">期数设置</p>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500">总期数</label>
                      <select className="w-full border rounded-lg p-2 mt-1 text-sm bg-white"
                        value={form.totalPeriods} onChange={e => setForm({...form,totalPeriods:e.target.value})}>
                        {PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n}期 {n>=12?`(${(n/12).toFixed(1)}年)`:""}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500">已还期数</label>
                      <input type="number" min="0" max={totalP-1} className="w-full border rounded-lg p-2 mt-1 text-sm bg-white"
                        placeholder="0" value={form.paidPeriods} onChange={e => setForm({...form,paidPeriods:e.target.value})} />
                    </div>
                  </div>
                  <p className="text-xs text-blue-600 font-medium">
                    → 剩余 <span className="font-bold">{remainP}</span> 期，约
                    {remainP>=12?` ${(remainP/12).toFixed(1)}年`:` ${remainP}个月`}还清
                  </p>
                </div>
              )}

              {/* 月还款 & 利率（一次性还清不需要月还款） */}
              {form.loanStyle !== "lumpsum" && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-500">{form.loanStyle==="installment"?"月还款额":"月还款（可选）"}</label>
                    <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                      value={form.monthlyPayment} onChange={e => setForm({...form,monthlyPayment:e.target.value})} />
                    {form.loanStyle==="installment" && !form.monthlyPayment && Number(autoMonthly)>0 && (
                      <p className="text-xs text-gray-400 mt-0.5">估算 ≈ ¥{Number(autoMonthly).toLocaleString()}/月</p>
                    )}
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-500">年利率（%）</label>
                    <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="如：5.5"
                      value={form.interestRate} onChange={e => setForm({...form,interestRate:e.target.value})} />
                  </div>
                </div>
              )}
              {form.loanStyle === "lumpsum" && (
                <div>
                  <label className="text-xs text-gray-500">年利率（%，可选）</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="如：3.65"
                    value={form.interestRate} onChange={e => setForm({...form,interestRate:e.target.value})} />
                </div>
              )}
            </>
          )}

          {/* 颜色 */}
          <div>
            <label className="text-xs text-gray-500">颜色标记</label>
            <div className="flex gap-2 mt-1 flex-wrap">
              {COLORS_PALETTE.map(c => (
                <button key={c} className="w-7 h-7 rounded-full border-2 transition-transform"
                  style={{backgroundColor:c,borderColor:form.color===c?"#1e293b":"transparent",transform:form.color===c?"scale(1.3)":"scale(1)"}}
                  onClick={() => setForm({...form,color:c})} />
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-4">
          <button className="flex-1 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
            onClick={() => {
              if (!form.name) return alert("请填写名称");
              if (type === "loan" && !form.remainingBalance) return alert("请填写剩余欠款");
              if (type === "loan" && form.loanStyle === "lumpsum" && !form.dueDate) return alert("请填写到期还款日");
              if (type !== "loan" || form.loanStyle !== "lumpsum") {
                if (!form.dueDay) return alert("请填写还款日");
              }
              const base = { id: initial?.id || Date.now(), name: form.name, color: form.color, payments: initial?.payments || [] };
              if (type === "credit_card") {
                onSave({ ...base, type: "credit_card", dueDay: Number(form.dueDay),
                  lastMonthSpending: Number(form.lastMonthSpending || 0),
                  installments: initial?.installments || [] });
              } else {
                const monthly = Number(form.monthlyPayment) || Number(autoMonthly) || 0;
                const dueDayFinal = form.loanStyle === "lumpsum"
                  ? new Date(form.dueDate).getDate() : Number(form.dueDay);
                onSave({ ...base, type: "loan", dueDay: dueDayFinal,
                  loanStyle: form.loanStyle,
                  dueDate: form.loanStyle === "lumpsum" ? form.dueDate : undefined,
                  totalAmount: Number(form.totalAmount || form.remainingBalance),
                  remainingBalance: Number(form.remainingBalance),
                  monthlyPayment: monthly,
                  interestRate: Number(form.interestRate || 0),
                  totalPeriods: form.loanStyle === "installment" ? totalP : 0,
                  paidPeriods: form.loanStyle === "installment" ? paidP : 0 });
              }
              onClose();
            }}>{isEdit ? "保存修改" : "确认添加"}</button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PAYMENT MODAL
// ─────────────────────────────────────────────
function PaymentModal({ debt, onPay, onClose }) {
  const isCc = debt.type === "credit_card";
  const isLumpsum = debt.loanStyle === "lumpsum";
  const cc = isCc ? computeCreditCard(debt) : null;
  const suggested = isCc ? cc.totalBill : (isLumpsum ? debt.remainingBalance : debt.monthlyPayment);
  const [amount, setAmount] = useState(String(Math.round(suggested)));
  const [month, setMonth] = useState(TODAY_MONTH);
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-1">💰 {isLumpsum ? "记录还清" : "记录还款"}</h2>
        <p className="text-xs text-gray-400 mb-4">{debt.name}</p>
        {isCc && (
          <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">分期月供合计</span><span className="font-medium">{fmt(cc.instMonthlyTotal)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">上月新消费</span><span className="font-medium">{fmt(debt.lastMonthSpending)}</span></div>
            <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
              <span className="text-gray-500">应还总额</span><span className="font-bold">{fmt(cc.totalBill)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">最低还款额</span><span className="font-medium text-orange-600">{fmt(cc.minimumPayment)}</span>
            </div>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">还款月份</label>
            <input type="month" className="w-full border rounded-lg p-2 mt-1 text-sm" value={month} onChange={e => setMonth(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">本次还款金额</label>
            <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" value={amount} onChange={e => setAmount(e.target.value)} />
            {isCc && (
              <div className="flex gap-2 mt-2">
                <button className="flex-1 py-1 text-xs rounded-lg bg-blue-50 text-blue-700 font-medium hover:bg-blue-100"
                  onClick={() => setAmount(String(Math.round(cc.totalBill)))}>全额 {fmtShort(cc.totalBill)}</button>
                <button className="flex-1 py-1 text-xs rounded-lg bg-orange-50 text-orange-700 font-medium hover:bg-orange-100"
                  onClick={() => setAmount(String(Math.round(cc.minimumPayment)))}>最低 {fmtShort(cc.minimumPayment)}</button>
                <button className="flex-1 py-1 text-xs rounded-lg bg-gray-50 text-gray-700 font-medium hover:bg-gray-100"
                  onClick={() => setAmount(String(Math.round(cc.instMonthlyTotal)))}>仅分期 {fmtShort(cc.instMonthlyTotal)}</button>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3 mt-4">
          <button className="flex-1 py-2 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700"
            onClick={() => { const n = Number(amount); if (!n) return alert("请输入金额"); onPay(debt.id, n, month); onClose(); }}>
            ✓ 确认
          </button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CREDIT CARD CARD
// ─────────────────────────────────────────────
function CreditCardCard({ card, onAddInstallment, onEditInstallment, onDeleteInstallment, onPay, onEdit, onDelete, onUpdateSpending }) {
  const cc = computeCreditCard(card);
  const [expanded, setExpanded] = useState(false);
  const [editSpending, setEditSpending] = useState(false);
  const [spendingInput, setSpendingInput] = useState(String(card.lastMonthSpending));
  const [showInstModal, setShowInstModal] = useState(false);
  const [editingInst, setEditingInst] = useState(null);
  const [confirmDeleteInst, setConfirmDeleteInst] = useState(null);
  const days = daysUntilDue(card.dueDay);
  const paidThisMonth = card.payments.some(p => p.month === TODAY_MONTH);

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: card.color }} />
            <div>
              <h3 className="font-bold text-gray-800 text-sm">{card.name}</h3>
              <span className="text-xs text-gray-400">信用卡 · 每月{card.dueDay}日</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {paidThisMonth && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✓ 已还</span>}
            <button className="text-gray-400 hover:text-blue-500 text-xs px-1.5 py-0.5 rounded border border-gray-200 hover:border-blue-300"
              onClick={e => { e.stopPropagation(); onEdit(card); }}>编辑</button>
            <button className="text-gray-300 hover:text-red-400 text-lg leading-none" onClick={e => { e.stopPropagation(); onDelete(card.id); }}>×</button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center mb-3">
          <div className="bg-red-50 rounded-xl p-2"><p className="text-xs text-red-400">本期应还</p><p className="text-sm font-bold text-red-700">{fmtShort(cc.totalBill)}</p></div>
          <div className="bg-orange-50 rounded-xl p-2"><p className="text-xs text-orange-400">最低还款</p><p className="text-sm font-bold text-orange-600">{fmtShort(cc.minimumPayment)}</p></div>
          <div className="bg-blue-50 rounded-xl p-2"><p className="text-xs text-blue-400">分期月供</p><p className="text-sm font-bold text-blue-700">{fmtShort(cc.instMonthlyTotal)}</p></div>
        </div>
        <div className="flex items-center justify-between">
          <DueBadge days={days} />
          <span className="text-xs text-gray-400">{expanded ? "收起 ▲" : "展开明细 ▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-3">
          {/* 分期明细 */}
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">分期明细</p>
            {cc.instDetails.map(inst => {
              const active = inst.remainingCount > 0;
              return (
                <div key={inst.id} className={`bg-white rounded-xl p-3 mb-2 ${!active ? "opacity-40" : ""}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{inst.name}</p>
                      <p className="text-xs text-gray-400">共{inst.installmentCount}期 · 已还{inst.paidCount}期 · 剩{inst.remainingCount}期
                        {inst.feeRateMonthly > 0 && ` · ${inst.feeRateMonthly}%/月`}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button className="text-xs text-gray-400 hover:text-blue-500 px-1.5 py-0.5 rounded border border-gray-200 hover:border-blue-300"
                        onClick={() => { setEditingInst(inst); setShowInstModal(true); }}>编辑</button>
                      <button className="text-gray-300 hover:text-red-400 text-base leading-none px-1"
                        onClick={() => setConfirmDeleteInst(inst.id)}>×</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                    <div><p className="text-gray-400">月本金</p><p className="font-semibold text-gray-700">{fmt(inst.principal)}</p></div>
                    <div><p className="text-gray-400">手续费</p><p className="font-semibold text-gray-700">{inst.feeRateMonthly > 0 ? fmt(inst.fee) : "—"}</p></div>
                    <div><p className="text-gray-400">月供小计</p><p className="font-bold text-blue-700">{fmt(inst.monthlyTotal)}</p></div>
                  </div>
                  {active && (
                    <>
                      <div className="mb-2">
                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                          <span>进度 {Math.round((inst.paidCount/inst.installmentCount)*100)}%</span>
                          <span>剩余本金 {fmtShort(inst.remainingBalance)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-blue-400" style={{ width: `${(inst.paidCount/inst.installmentCount)*100}%` }} />
                        </div>
                      </div>
                      {/* 已还期数步进器 */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">已还期数</span>
                        <div className="flex items-center border rounded-lg overflow-hidden">
                          <button className="px-2.5 py-1 bg-gray-50 text-gray-600 hover:bg-gray-100 text-sm font-bold"
                            onClick={() => onEditInstallment(card.id, { ...inst, paidCount: Math.max(0, inst.paidCount - 1) })}>−</button>
                          <span className="px-3 py-1 text-sm font-semibold text-gray-800">{inst.paidCount}</span>
                          <button className="px-2.5 py-1 bg-gray-50 text-gray-600 hover:bg-gray-100 text-sm font-bold"
                            onClick={() => onEditInstallment(card.id, { ...inst, paidCount: Math.min(inst.installmentCount, inst.paidCount + 1) })}>＋</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            <button className="w-full text-xs text-blue-600 font-semibold border border-blue-200 rounded-xl py-2 hover:bg-blue-50"
              onClick={() => { setEditingInst(null); setShowInstModal(true); }}>+ 新增分期账单</button>
          </div>

          {/* 上月新消费 */}
          <div className="bg-white rounded-xl p-3">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm font-semibold text-gray-800">上月新消费（非分期）</p>
                <p className="text-xs text-gray-400">本期需还清或计入最低还款</p>
              </div>
              {!editSpending ? (
                <div className="text-right">
                  <p className="font-bold text-gray-800">{fmt(card.lastMonthSpending)}</p>
                  <button className="text-xs text-blue-500 hover:text-blue-700"
                    onClick={e => { e.stopPropagation(); setEditSpending(true); }}>修改</button>
                </div>
              ) : (
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <input type="number" className="w-24 border rounded-lg p-1 text-sm text-right"
                    value={spendingInput} onChange={e => setSpendingInput(e.target.value)} />
                  <button className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg"
                    onClick={() => { onUpdateSpending(card.id, Number(spendingInput)); setEditSpending(false); }}>确认</button>
                </div>
              )}
            </div>
          </div>

          {/* 还款 */}
          {!paidThisMonth
            ? <button className="w-full py-2.5 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 text-sm" onClick={() => onPay(card)}>💰 记录本月还款</button>
            : <button className="w-full py-2.5 bg-gray-100 text-gray-500 font-semibold rounded-xl hover:bg-gray-200 text-sm" onClick={() => onPay(card)}>重新记录还款</button>
          }

          {/* 历史 */}
          {card.payments.length > 0 && (
            <details>
              <summary className="text-xs text-gray-400 cursor-pointer">历史还款记录 ({card.payments.length}笔)</summary>
              <div className="mt-2 space-y-1">
                {[...card.payments].reverse().slice(0,6).map((p,i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-500 py-1 border-b border-gray-100">
                    <span>{p.month}</span><span className="font-medium text-green-600">-{fmt(p.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* 分期模态框 */}
      {showInstModal && (
        <InstallmentModal cardName={card.name} initial={editingInst}
          onSave={inst => editingInst ? onEditInstallment(card.id, inst) : onAddInstallment(card.id, inst)}
          onClose={() => { setShowInstModal(false); setEditingInst(null); }} />
      )}

      {/* 删除分期确认 */}
      {confirmDeleteInst && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-xs mx-4 text-center">
            <p className="font-bold text-gray-800 mb-2">删除这笔分期？</p>
            <p className="text-sm text-gray-500 mb-5">操作不可撤销</p>
            <div className="flex gap-3">
              <button className="flex-1 py-2 rounded-lg bg-red-500 text-white font-semibold"
                onClick={() => { onDeleteInstallment(card.id, confirmDeleteInst); setConfirmDeleteInst(null); }}>删除</button>
              <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold"
                onClick={() => setConfirmDeleteInst(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// LOAN CARD
// ─────────────────────────────────────────────
function LoanCard({ loan, onPay, onEdit, onDelete }) {
  const isInstallment = loan.loanStyle === "installment" && loan.totalPeriods > 0;
  const isLumpsum = loan.loanStyle === "lumpsum";
  const paidPeriods = loan.paidPeriods || 0;
  const totalPeriods = loan.totalPeriods || 0;
  const remainPeriods = Math.max(0, totalPeriods - paidPeriods);
  const lumpsumDays = isLumpsum ? daysUntilDate(loan.dueDate) : null;
  const lumpsumPast = isLumpsum && lumpsumDays !== null && lumpsumDays < 0;
  const paidRatio = isInstallment
    ? (totalPeriods > 0 ? paidPeriods / totalPeriods : 0)
    : (loan.totalAmount > 0 ? Math.max(0, (loan.totalAmount - loan.remainingBalance) / loan.totalAmount) : 0);
  const days = isLumpsum ? null : daysUntilDue(loan.dueDay);
  const paidThisMonth = loan.payments.some(p => p.month === TODAY_MONTH);
  const monthlyInterest = loan.interestRate > 0 ? (loan.remainingBalance * loan.interestRate) / 100 / 12 : 0;
  const isSettled = loan.remainingBalance <= 0;

  return (
    <div className={`bg-white rounded-2xl shadow-sm p-4 ${isSettled ? "opacity-50" : ""}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: loan.color }} />
          <div className="min-w-0">
            <h3 className="font-bold text-gray-800 text-sm">{loan.name}</h3>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {isLumpsum ? (
                <>
                  <span className="text-xs text-gray-400">一次性还清</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    lumpsumPast ? "bg-red-100 text-red-600" : lumpsumDays <= 30 ? "bg-orange-100 text-orange-600" : "bg-gray-100 text-gray-500"
                  }`}>{lumpsumPast ? `⚠ 已逾期${Math.abs(lumpsumDays)}天` : `到期 ${loan.dueDate} · 剩${lumpsumDays}天`}</span>
                </>
              ) : (
                <>
                  <span className="text-xs text-gray-400">{loan.loanStyle==="flexible"?"随时还清":"等额月供"} · 每月{loan.dueDay}日</span>
                  {isInstallment && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full font-medium">剩{remainPeriods}期</span>}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          {isSettled && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">✓ 还清</span>}
          {!isSettled && paidThisMonth && !isLumpsum && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">✓ 已还</span>}
          <button className="text-gray-400 hover:text-blue-500 text-xs px-1.5 py-0.5 rounded border border-gray-200 hover:border-blue-300"
            onClick={() => onEdit(loan)}>编辑</button>
          <button className="text-gray-300 hover:text-red-400 text-lg leading-none" onClick={() => onDelete(loan.id)}>×</button>
        </div>
      </div>

      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          {isInstallment
            ? <><span>已还 {paidPeriods}/{totalPeriods} 期（{Math.round(paidRatio*100)}%）</span><span>剩余 {fmtShort(loan.remainingBalance)}</span></>
            : isLumpsum
            ? <><span>一次性到期还款</span><span>应还 {fmtShort(loan.remainingBalance)}</span></>
            : <><span>已还 {Math.round(paidRatio*100)}%</span><span>剩余 {fmtShort(loan.remainingBalance)}</span></>
          }
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${isLumpsum ? 0 : paidRatio*100}%`, backgroundColor: loan.color }} />
        </div>
        {isInstallment && remainPeriods > 0 && (
          <p className="text-xs text-gray-400 mt-1">
            预计还清：约{remainPeriods>=12?` ${Math.floor(remainPeriods/12)}年${remainPeriods%12>0?remainPeriods%12+"月":""}`:` ${remainPeriods}个月`}后
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">{isLumpsum?"到期应还":"月还款"}</p>
          <p className="text-sm font-bold text-gray-700">{isLumpsum ? fmtShort(loan.remainingBalance) : (loan.monthlyPayment>0 ? fmtShort(loan.monthlyPayment) : "—")}</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">年利率</p>
          <p className="text-sm font-bold text-gray-700">{loan.interestRate>0 ? loan.interestRate+"%" : "—"}</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">月利息约</p>
          <p className="text-sm font-bold text-gray-700">{monthlyInterest>0 ? fmtShort(monthlyInterest) : "—"}</p>
        </div>
      </div>

      {!isSettled && (
        <div className="flex items-center justify-between">
          {isLumpsum
            ? <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${lumpsumDays<=7?"bg-red-100 text-red-600":lumpsumDays<=30?"bg-orange-100 text-orange-600":"bg-gray-100 text-gray-500"}`}>
                {lumpsumDays>0?`${lumpsumDays}天后到期`:lumpsumPast?"已逾期":"今天到期"}
              </span>
            : <DueBadge days={days} />
          }
          <button className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700" onClick={() => onPay(loan)}>
            {isLumpsum?"💰 记录还清":"💰 记录还款"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function App() {
  const [debts, setDebts] = useState(() => loadFromLocal() || DEMO_DEBTS);
  const [syncStatus, setSyncStatus] = useState(firebaseConfigured ? "synced" : "local");
  const [activeTab, setActiveTab] = useState("dashboard");
  const [showDebtModal, setShowDebtModal] = useState(false);
  const [editingDebt, setEditingDebt] = useState(null);
  const [payingDebt, setPayingDebt] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [loading, setLoading] = useState(firebaseConfigured);

  // Firebase sync
  useEffect(() => {
    if (!firebaseConfigured || !db) return;
    const ref = doc(db, "users", "main", "data", "debts");
    const unsub = onSnapshot(ref, snap => {
      if (snap.exists()) { const d = snap.data().list; if (d) { setDebts(d); saveToLocal(d); } }
      setLoading(false); setSyncStatus("synced");
    }, () => { setLoading(false); setSyncStatus("local"); });
    return unsub;
  }, []);

  const persistDebts = useCallback(async newDebts => {
    saveToLocal(newDebts);
    if (!firebaseConfigured || !db) return;
    setSyncStatus("saving");
    try { await setDoc(doc(db, "users", "main", "data", "debts"), { list: newDebts }); setSyncStatus("synced"); }
    catch { setSyncStatus("local"); }
  }, []);

  const updateDebts = useCallback(updater => {
    setDebts(prev => { const next = typeof updater === "function" ? updater(prev) : updater; persistDebts(next); return next; });
  }, [persistDebts]);

  // Totals
  const totals = useMemo(() => {
    let monthlyDue = 0, minimumDue = 0, totalRemaining = 0;
    debts.forEach(d => {
      if (d.type === "credit_card") {
        const cc = computeCreditCard(d);
        monthlyDue += cc.totalBill; minimumDue += cc.minimumPayment; totalRemaining += cc.totalRemainingBalance;
      } else {
        if (d.loanStyle !== "lumpsum") { monthlyDue += d.monthlyPayment || 0; minimumDue += d.monthlyPayment || 0; }
        totalRemaining += d.remainingBalance;
      }
    });
    return { monthlyDue, minimumDue, totalRemaining };
  }, [debts]);

  // Projection data for stacked bar chart
  const projectionData = useMemo(() => buildProjection(debts, 14), [debts]);

  // Upcoming (include lumpsum within 30 days)
  const upcomingDue = useMemo(() => {
    return [...debts].filter(d => {
      if (d.remainingBalance <= 0) return false;
      if (d.loanStyle === "lumpsum") return daysUntilDate(d.dueDate) <= 30;
      return daysUntilDue(d.dueDay) <= 10 && !d.payments.some(p => p.month === TODAY_MONTH);
    }).sort((a, b) => {
      const da = a.loanStyle === "lumpsum" ? daysUntilDate(a.dueDate) : daysUntilDue(a.dueDay);
      const db2 = b.loanStyle === "lumpsum" ? daysUntilDate(b.dueDate) : daysUntilDue(b.dueDay);
      return da - db2;
    });
  }, [debts]);

  const sorted = [...debts].sort((a, b) => a.dueDay - b.dueDay);

  // Handlers
  const handleSaveDebt = d => {
    updateDebts(prev => prev.find(x => x.id === d.id) ? prev.map(x => x.id === d.id ? d : x) : [...prev, d]);
    setEditingDebt(null); setShowDebtModal(false);
  };
  const handleDeleteDebt = id => { updateDebts(p => p.filter(d => d.id !== id)); setDeletingId(null); };
  const handlePay = (debtId, amount, month) => updateDebts(p => p.map(d => {
    if (d.id !== debtId) return d;
    const payments = [...d.payments, { month, amount, date: new Date().toISOString() }];
    if (d.type === "loan") {
      const newBalance = Math.max(0, d.remainingBalance - amount);
      const newPaid = d.loanStyle==="installment" && d.totalPeriods>0 ? Math.min((d.paidPeriods||0)+1, d.totalPeriods) : (d.paidPeriods||0);
      return { ...d, remainingBalance: newBalance, paidPeriods: newPaid, payments };
    }
    return { ...d, payments };
  }));
  const handleAddInstallment = (cardId, inst) => updateDebts(p => p.map(d => d.id===cardId ? {...d, installments:[...d.installments, inst]} : d));
  const handleEditInstallment = (cardId, inst) => updateDebts(p => p.map(d => d.id===cardId ? {...d, installments: d.installments.map(i => i.id===inst.id ? inst : i)} : d));
  const handleDeleteInstallment = (cardId, instId) => updateDebts(p => p.map(d => d.id===cardId ? {...d, installments: d.installments.filter(i => i.id!==instId)} : d));
  const handleUpdateSpending = (cardId, amount) => updateDebts(p => p.map(d => d.id===cardId ? {...d, lastMonthSpending: amount} : d));

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-500 text-sm">正在同步数据…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-800 to-blue-700 text-white px-4 pt-8 pb-16">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-bold">💳 负债管理工具</h1>
          <div className="flex items-center gap-2">
            <button
              title="导出 Excel"
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white bg-opacity-15 hover:bg-opacity-25 transition text-xs font-medium"
              onClick={() => exportToExcel(debts, projectionData)}
            >
              ⬇ 导出
            </button>
            <SyncBadge status={syncStatus} />
          </div>
        </div>
        <p className="text-blue-200 text-xs">信用卡分期 · 贷款 · 全览</p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[["总剩余负债",fmtShort(totals.totalRemaining),"text-white"],["月供合计",fmtShort(totals.monthlyDue),"text-yellow-300"],["最低还款",fmtShort(totals.minimumDue),"text-orange-300"]].map(([l,v,c]) => (
            <div key={l} className="bg-white bg-opacity-10 rounded-xl p-3 text-center">
              <p className="text-xs text-blue-200">{l}</p>
              <p className={`text-base font-bold mt-1 ${c}`}>{v}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 -mt-8">
        <div className="bg-white rounded-2xl shadow-lg p-1 flex gap-1">
          {[["dashboard","📊 本月"],["debts","📋 账单"],["trend","📈 趋势"]].map(([k,l]) => (
            <button key={k} className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${activeTab===k?"bg-blue-600 text-white":"text-gray-500 hover:bg-gray-100"}`}
              onClick={() => setActiveTab(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="px-4 py-4 pb-28">

        {/* ── DASHBOARD ── */}
        {activeTab === "dashboard" && (
          <div className="space-y-4">
            {upcomingDue.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <h3 className="text-sm font-bold text-red-700 mb-2">⏰ 近期还款提醒</h3>
                {upcomingDue.map(d => {
                  const isCard = d.type === "credit_card";
                  const isLs = d.loanStyle === "lumpsum";
                  const cc = isCard ? computeCreditCard(d) : null;
                  const amt = isCard ? cc.totalBill : d.remainingBalance;
                  const daysLeft = isLs ? daysUntilDate(d.dueDate) : daysUntilDue(d.dueDay);
                  return (
                    <div key={d.id} className="flex items-center justify-between py-2 border-b border-red-100 last:border-0">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        <div>
                          <span className="text-sm font-medium text-gray-800">{d.name}</span>
                          {isLs && <span className="text-xs text-orange-500 ml-1">一次性到期</span>}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-red-600">{fmtShort(amt)}</p>
                        <DueBadge days={daysLeft} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3">本月还款计划</h3>
              {sorted.filter(d => d.remainingBalance > 0).map(d => {
                const isCard = d.type === "credit_card";
                const isLs = d.loanStyle === "lumpsum";
                const cc = isCard ? computeCreditCard(d) : null;
                const paid = d.payments.some(p => p.month === TODAY_MONTH);
                const displayAmt = isCard ? cc.totalBill : (isLs ? 0 : (d.monthlyPayment||0));
                return (
                  <div key={d.id} className={`py-3 border-b border-gray-100 last:border-0 ${paid && !isLs ? "opacity-40" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ backgroundColor: d.color }}>
                          {isLs ? "📌" : d.dueDay}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{d.name}</p>
                          {isCard
                            ? <p className="text-xs text-gray-400">分期 {fmtShort(cc.instMonthlyTotal)} + 消费 {fmtShort(d.lastMonthSpending)}</p>
                            : isLs
                            ? <p className="text-xs text-orange-500">到期日 {d.dueDate}（一次性还清）</p>
                            : <p className="text-xs text-gray-400">{d.interestRate>0?`年利率 ${d.interestRate}%`:"贷款"}</p>
                          }
                        </div>
                      </div>
                      <div className="text-right">
                        {isLs
                          ? <p className="text-sm font-bold text-orange-600">{fmtShort(d.remainingBalance)}</p>
                          : <p className="text-sm font-bold text-gray-800">{fmtShort(displayAmt)}</p>
                        }
                        {isCard && <p className="text-xs text-orange-500">最低 {fmtShort(cc.minimumPayment)}</p>}
                        {paid && !isLs ? <span className="text-xs text-green-600">✓ 已还</span> : (!isLs && <DueBadge days={daysUntilDue(d.dueDay)} />)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── DEBTS ── */}
        {activeTab === "debts" && (
          <div className="space-y-3">
            {sorted.map(d =>
              d.type === "credit_card"
                ? <CreditCardCard key={d.id} card={d}
                    onAddInstallment={handleAddInstallment}
                    onEditInstallment={handleEditInstallment}
                    onDeleteInstallment={handleDeleteInstallment}
                    onPay={c => setPayingDebt(c)}
                    onEdit={c => { setEditingDebt(c); setShowDebtModal(true); }}
                    onDelete={id => setDeletingId(id)}
                    onUpdateSpending={handleUpdateSpending} />
                : <LoanCard key={d.id} loan={d}
                    onPay={l => setPayingDebt(l)}
                    onEdit={l => { setEditingDebt(l); setShowDebtModal(true); }}
                    onDelete={id => setDeletingId(id)} />
            )}
            {debts.length === 0 && <div className="text-center py-16 text-gray-400"><p className="text-4xl mb-3">🎉</p><p className="font-semibold">暂无负债</p></div>}
          </div>
        )}

        {/* ── TREND ── */}
        {activeTab === "trend" && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-1">📊 未来月供变化预测</h3>
              <p className="text-xs text-gray-400 mb-1">每种颜色代表一笔负债；某笔还清后，对应颜色从柱子中消失，月供随之下降</p>
              {/* 图例 */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 mb-4">
                {debts.map(d => (
                  <span key={d.id} className="flex items-center gap-1 text-xs text-gray-500">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: d.color }} />
                    {d.name.length > 6 ? d.name.slice(0,6)+"…" : d.name}
                  </span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={projectionData} barSize={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v >= 10000 ? `${(v/10000).toFixed(0)}万` : `${v}`} width={40} />
                  <Tooltip content={<ProjectionTooltip debts={debts} />} />
                  {debts.map((d, i) => (
                    <Bar key={d.id} dataKey={`d_${d.id}`} name={d.name} stackId="a" fill={d.color}
                      radius={i === debts.length - 1 ? [3,3,0,0] : [0,0,0,0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-gray-400 mt-2 text-center">柱子高度 = 当月月供总额；柱子降低 = 某笔负债还清</p>
            </div>

            {/* 各账户当前月供 */}
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3">当前月供构成</h3>
              {debts.filter(d => d.remainingBalance > 0).map(d => {
                const isCard = d.type === "credit_card";
                const cc = isCard ? computeCreditCard(d) : null;
                const monthly = isCard ? cc.totalBill : (d.loanStyle==="lumpsum" ? 0 : (d.monthlyPayment||0));
                const total = debts.filter(x=>x.remainingBalance>0).reduce((s,x) => {
                  const c = x.type==="credit_card" ? computeCreditCard(x).totalBill : (x.loanStyle==="lumpsum"?0:(x.monthlyPayment||0));
                  return s + c;
                }, 0);
                return (
                  <div key={d.id} className="mb-3">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="font-medium text-gray-700">{d.name}</span>
                        {d.loanStyle==="lumpsum" && <span className="text-orange-500">（到期一次性还清）</span>}
                      </span>
                      <span className="text-gray-500">{d.loanStyle==="lumpsum" ? fmtShort(d.remainingBalance) : fmtShort(monthly)}</span>
                    </div>
                    {d.loanStyle !== "lumpsum" && total > 0 && (
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(monthly/total)*100}%`, backgroundColor: d.color }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* FAB */}
      <div className="fixed bottom-6 right-5">
        <button className="w-14 h-14 rounded-full bg-blue-600 text-white text-2xl shadow-xl hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center"
          onClick={() => { setEditingDebt(null); setShowDebtModal(true); }}>+</button>
      </div>

      {/* Modals */}
      {showDebtModal && (
        <DebtModal initial={editingDebt} onSave={handleSaveDebt} onClose={() => { setShowDebtModal(false); setEditingDebt(null); }} />
      )}
      {payingDebt && <PaymentModal debt={payingDebt} onPay={handlePay} onClose={() => setPayingDebt(null)} />}
      {deletingId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-xs mx-4 text-center">
            <p className="text-lg font-bold text-gray-800 mb-2">确认删除？</p>
            <p className="text-sm text-gray-500 mb-5">该账户及所有记录将被移除</p>
            <div className="flex gap-3">
              <button className="flex-1 py-2 rounded-lg bg-red-500 text-white font-semibold" onClick={() => handleDeleteDebt(deletingId)}>删除</button>
              <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={() => setDeletingId(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
