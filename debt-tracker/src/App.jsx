import { useState, useMemo, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend,
} from "recharts";
import { db, firebaseConfigured } from "./firebase.js";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function fmt(n) {
  return "¥" + Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShort(n) {
  if (n >= 10000) return "¥" + (n / 10000).toFixed(1) + "万";
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

function calcMinimum(instTotal, spending) {
  const total = instTotal + spending;
  return Math.max(instTotal, total * 0.1);
}

// ─────────────────────────────────────────────
// PERSISTENCE — Firebase or localStorage fallback
// ─────────────────────────────────────────────
const LS_KEY = "debt_tracker_v2";

function loadFromLocal() {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function saveToLocal(debts) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(debts)); } catch {}
}

// ─────────────────────────────────────────────
// INITIAL DEMO DATA
// ─────────────────────────────────────────────
const DEMO_DEBTS = [
  {
    id: 1, type: "credit_card", name: "招商银行信用卡", color: "#ef4444",
    dueDay: 8, lastMonthSpending: 2800,
    installments: [
      { id: 101, name: "iPhone 16 Pro", totalAmount: 9999, installmentCount: 24, paidCount: 5, feeRateMonthly: 0.6, startDate: "2024-08" },
      { id: 102, name: "装修定金", totalAmount: 18000, installmentCount: 12, paidCount: 2, feeRateMonthly: 0.75, startDate: "2025-01" },
    ],
    payments: [],
  },
  {
    id: 2, type: "credit_card", name: "建设银行龙卡", color: "#3b82f6",
    dueDay: 18, lastMonthSpending: 1200,
    installments: [
      { id: 201, name: "MacBook Air", totalAmount: 8499, installmentCount: 12, paidCount: 3, feeRateMonthly: 0.55, startDate: "2024-10" },
    ],
    payments: [],
  },
  {
    id: 3, type: "loan", name: "车贷（招行）", color: "#a855f7",
    dueDay: 20, totalAmount: 80000, remainingBalance: 62000, monthlyPayment: 2100, interestRate: 5.5, payments: [],
  },
  {
    id: 4, type: "loan", name: "花呗分期", color: "#f97316",
    dueDay: 15, totalAmount: 6000, remainingBalance: 4800, monthlyPayment: 600, interestRate: 14.6, payments: [],
  },
];

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
  const activeInsts = instDetails.filter((i) => i.remainingCount > 0);
  const instMonthlyTotal = activeInsts.reduce((s, i) => s + i.monthlyTotal, 0);
  const totalBill = instMonthlyTotal + card.lastMonthSpending;
  const minimumPayment = calcMinimum(instMonthlyTotal, card.lastMonthSpending);
  const totalRemainingBalance = activeInsts.reduce((s, i) => s + i.remainingBalance, 0) + card.lastMonthSpending;
  return { instDetails, activeInsts, instMonthlyTotal, totalBill, minimumPayment, totalRemainingBalance };
}

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────
function DueBadge({ days }) {
  if (days <= 3) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">⚠ {days}天后到期</span>;
  if (days <= 7) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">{days}天后到期</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">{days}天后到期</span>;
}

function SyncBadge({ status }) {
  if (status === "synced") return <span className="text-xs text-green-500 flex items-center gap-1">☁ 已同步</span>;
  if (status === "saving") return <span className="text-xs text-blue-400 flex items-center gap-1">↑ 同步中…</span>;
  if (status === "local") return <span className="text-xs text-gray-400 flex items-center gap-1">💾 本地存储</span>;
  return null;
}

function AddInstallmentModal({ cardName, onAdd, onClose }) {
  const [form, setForm] = useState({
    name: "", totalAmount: "", installmentCount: "12",
    feeRateMonthly: "0.6", feeRateAnnual: "7.2",
    paidCount: "0", rateMode: "monthly", // "monthly" | "annual"
  });

  // 利率换算：年化 / 12 = 月费率（银行分期手续费的计算方式）
  const monthlyRate = form.rateMode === "annual"
    ? (Number(form.feeRateAnnual) / 12)
    : Number(form.feeRateMonthly);

  const preview = form.totalAmount && form.installmentCount
    ? {
        principal: Number(form.totalAmount) / Number(form.installmentCount),
        fee: (Number(form.totalAmount) * monthlyRate) / 100,
      }
    : null;

  const totalCount = Number(form.installmentCount);
  const paidCount = Math.min(Number(form.paidCount) || 0, totalCount - 1);
  const remainingCount = totalCount - paidCount;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto py-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-1">➕ 新增分期</h2>
        <p className="text-xs text-gray-400 mb-4">{cardName}</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">分期名称</label>
            <input className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="如：iPhone 16 Pro"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500">分期总金额</label>
              <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                value={form.totalAmount} onChange={(e) => setForm({ ...form, totalAmount: e.target.value })} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500">总期数</label>
              <select className="w-full border rounded-lg p-2 mt-1 text-sm"
                value={form.installmentCount} onChange={(e) => setForm({ ...form, installmentCount: e.target.value })}>
                {[3, 6, 9, 12, 18, 24, 36].map((n) => <option key={n}>{n}</option>)}
              </select>
            </div>
          </div>

          {/* 已还期数 */}
          <div>
            <label className="text-xs text-gray-500">当前已还期数</label>
            <div className="flex items-center gap-3 mt-1">
              <input type="number" min="0" max={totalCount - 1}
                className="w-24 border rounded-lg p-2 text-sm"
                placeholder="0"
                value={form.paidCount}
                onChange={(e) => setForm({ ...form, paidCount: e.target.value })} />
              <span className="text-xs text-gray-400">
                → 剩余 <span className="font-semibold text-blue-600">{remainingCount}</span> 期待还
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">从第1期开始，已经还过几期了</p>
          </div>

          {/* 手续费率 — 支持月费率和年化利率切换 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-500">手续费率</label>
              <div className="flex gap-1">
                {[["monthly","月费率"],["annual","年化利率"]].map(([k,l]) => (
                  <button key={k}
                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${form.rateMode===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-500"}`}
                    onClick={() => setForm({ ...form, rateMode: k })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {form.rateMode === "monthly" ? (
              <div className="flex items-center gap-2">
                <input type="number" step="0.01" className="flex-1 border rounded-lg p-2 text-sm" placeholder="如：0.6"
                  value={form.feeRateMonthly}
                  onChange={(e) => setForm({ ...form, feeRateMonthly: e.target.value, feeRateAnnual: String((Number(e.target.value) * 12).toFixed(2)) })} />
                <span className="text-sm text-gray-400">% / 月</span>
                {form.feeRateMonthly && <span className="text-xs text-gray-400">≈ 年化 {(Number(form.feeRateMonthly) * 12).toFixed(1)}%</span>}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input type="number" step="0.1" className="flex-1 border rounded-lg p-2 text-sm" placeholder="如：7.2"
                  value={form.feeRateAnnual}
                  onChange={(e) => setForm({ ...form, feeRateAnnual: e.target.value, feeRateMonthly: String((Number(e.target.value) / 12).toFixed(4)) })} />
                <span className="text-sm text-gray-400">% / 年</span>
                {form.feeRateAnnual && <span className="text-xs text-gray-400">≈ 月 {(Number(form.feeRateAnnual) / 12).toFixed(2)}%</span>}
              </div>
            )}
            <p className="text-xs text-gray-400 mt-0.5">账单上显示年化利率就选「年化利率」；不知道填 0</p>
          </div>

          {/* 预览 */}
          {preview && (
            <div className="bg-blue-50 rounded-xl p-3 text-sm">
              <p className="text-xs font-semibold text-blue-700 mb-2">预览</p>
              <div className="flex justify-between text-gray-600"><span>每月本金</span><span>{fmt(preview.principal)}</span></div>
              <div className="flex justify-between text-gray-600"><span>每月手续费</span><span>{monthlyRate > 0 ? fmt(preview.fee) : "—"}</span></div>
              <div className="flex justify-between font-bold text-blue-700 border-t border-blue-200 mt-1 pt-1">
                <span>月供合计</span><span>{fmt(preview.principal + preview.fee)}</span>
              </div>
              <div className="flex justify-between text-gray-500 text-xs mt-1">
                <span>还剩 {remainingCount} 期，剩余本金</span>
                <span>{fmt(preview.principal * remainingCount)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-4">
          <button className="flex-1 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
            onClick={() => {
              if (!form.name || !form.totalAmount) return alert("请填写名称和金额");
              onAdd({
                id: Date.now(),
                name: form.name,
                totalAmount: Number(form.totalAmount),
                installmentCount: totalCount,
                paidCount,
                feeRateMonthly: Number(monthlyRate.toFixed(4)),
                startDate: TODAY_MONTH,
              });
              onClose();
            }}>确认</button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

const PERIOD_OPTIONS = [1,2,3,6,9,12,18,24,36,48,60];

function AddDebtModal({ onAdd, onClose }) {
  const [type, setType] = useState("credit_card");
  // loanStyle: "installment"=等额月供  "flexible"=随时还清/一次性
  const [form, setForm] = useState({
    name: "", color: "#3b82f6", dueDay: "", lastMonthSpending: "0",
    totalAmount: "", remainingBalance: "", monthlyPayment: "", interestRate: "",
    loanStyle: "installment", totalPeriods: "12", paidPeriods: "0",
  });
  const COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#a855f7","#ec4899","#14b8a6"];

  const totalP = Number(form.totalPeriods) || 0;
  const paidP  = Math.min(Number(form.paidPeriods) || 0, Math.max(0, totalP - 1));
  const remainP = totalP - paidP;

  // 预览：月供 = 剩余欠款 / 剩余期数（如果没填月供）
  const autoMonthly = form.remainingBalance && remainP > 0 && !form.monthlyPayment
    ? (Number(form.remainingBalance) / remainP).toFixed(0)
    : form.monthlyPayment;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto py-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-4">➕ 新增负债</h2>
        <div className="flex gap-2 mb-4">
          {[["credit_card","💳 信用卡"],["loan","📋 贷款/网贷"]].map(([k,l]) => (
            <button key={k} className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${type===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-600"}`}
              onClick={() => setType(k)}>{l}</button>
          ))}
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">名称</label>
            <input className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder={type==="credit_card"?"如：工商银行信用卡":"如：车贷 / 花呗 / 某某网贷"}
              value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} />
          </div>
          <div>
            <label className="text-xs text-gray-500">还款日（每月几号）</label>
            <input type="number" min="1" max="31" className="w-full border rounded-lg p-2 mt-1 text-sm"
              value={form.dueDay} onChange={(e) => setForm({...form,dueDay:e.target.value})} />
          </div>

          {type === "credit_card" && (
            <div>
              <label className="text-xs text-gray-500">本期账单中的新消费（非分期部分）</label>
              <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥ 0"
                value={form.lastMonthSpending} onChange={(e) => setForm({...form,lastMonthSpending:e.target.value})} />
              <p className="text-xs text-gray-400 mt-0.5">分期账单可稍后单独添加</p>
            </div>
          )}

          {type === "loan" && (
            <>
              {/* 还款方式 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">还款方式</label>
                <div className="flex gap-2">
                  {[["installment","📅 等额月供"],["flexible","💸 随时还清"]].map(([k,l]) => (
                    <button key={k} className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-colors ${form.loanStyle===k?"bg-blue-600 text-white":"bg-gray-100 text-gray-600"}`}
                      onClick={() => setForm({...form,loanStyle:k})}>{l}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {form.loanStyle==="installment" ? "每月固定还款，有明确还清日期（车贷、房贷、分期网贷）" : "无固定月供，随时可以多还或一次性还清（部分网贷、借款）"}
                </p>
              </div>

              {/* 金额 */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500">当前剩余欠款</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                    value={form.remainingBalance} onChange={(e) => setForm({...form,remainingBalance:e.target.value})} />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500">原始借款总额</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥（可选）"
                    value={form.totalAmount} onChange={(e) => setForm({...form,totalAmount:e.target.value})} />
                </div>
              </div>

              {/* 等额月供：期数 */}
              {form.loanStyle === "installment" && (
                <div className="bg-blue-50 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-semibold text-blue-700">期数设置</p>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500">总期数（月）</label>
                      <select className="w-full border rounded-lg p-2 mt-1 text-sm bg-white"
                        value={form.totalPeriods} onChange={(e) => setForm({...form,totalPeriods:e.target.value})}>
                        {PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n}期（{n >= 12 ? (n/12).toFixed(1)+"年" : n+"月"}）</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500">已还期数</label>
                      <input type="number" min="0" max={totalP - 1} className="w-full border rounded-lg p-2 mt-1 text-sm bg-white"
                        placeholder="0"
                        value={form.paidPeriods} onChange={(e) => setForm({...form,paidPeriods:e.target.value})} />
                    </div>
                  </div>
                  <p className="text-xs text-blue-600 font-medium">
                    → 剩余 <span className="font-bold">{remainP}</span> 期，
                    约 {remainP >= 12 ? (remainP/12).toFixed(1)+"年" : remainP+"个月"} 还清
                  </p>
                </div>
              )}

              {/* 月还款 & 利率 */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500">
                    {form.loanStyle==="installment" ? "月还款额" : "月还款额（可选）"}
                  </label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="¥"
                    value={form.monthlyPayment} onChange={(e) => setForm({...form,monthlyPayment:e.target.value})} />
                  {form.loanStyle==="installment" && !form.monthlyPayment && form.remainingBalance && remainP > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">按剩余欠款估算 ≈ ¥{Number(autoMonthly).toLocaleString()}/月</p>
                  )}
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500">年利率（%）</label>
                  <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" placeholder="如：5.5"
                    value={form.interestRate} onChange={(e) => setForm({...form,interestRate:e.target.value})} />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="text-xs text-gray-500">颜色</label>
            <div className="flex gap-2 mt-1 flex-wrap">
              {COLORS.map(c => (
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
              if (!form.name || !form.dueDay) return alert("请填写名称和还款日");
              const base = { id: Date.now(), name: form.name, color: form.color, dueDay: Number(form.dueDay), payments: [] };
              if (type === "credit_card") {
                onAdd({ ...base, type: "credit_card", lastMonthSpending: Number(form.lastMonthSpending || 0), installments: [] });
              } else {
                const monthly = Number(form.monthlyPayment) || Number(autoMonthly) || 0;
                onAdd({
                  ...base, type: "loan",
                  loanStyle: form.loanStyle,
                  totalAmount: Number(form.totalAmount || form.remainingBalance),
                  remainingBalance: Number(form.remainingBalance),
                  monthlyPayment: monthly,
                  interestRate: Number(form.interestRate || 0),
                  // 期数信息（仅等额月供有意义）
                  totalPeriods: form.loanStyle === "installment" ? totalP : 0,
                  paidPeriods:  form.loanStyle === "installment" ? paidP  : 0,
                });
              }
              onClose();
            }}>确认</button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({ debt, onPay, onClose }) {
  const isCc = debt.type === "credit_card";
  const cc = isCc ? computeCreditCard(debt) : null;
  const [amount, setAmount] = useState(String(Math.round(isCc ? cc.totalBill : debt.monthlyPayment)));
  const [month, setMonth] = useState(TODAY_MONTH);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-1">💰 记录还款</h2>
        <p className="text-xs text-gray-400 mb-4">{debt.name}</p>
        {isCc && (
          <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">分期月供合计</span><span className="font-medium">{fmt(cc.instMonthlyTotal)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">上月新消费</span><span className="font-medium">{fmt(debt.lastMonthSpending)}</span></div>
            <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
              <span className="text-gray-500">应还总额</span><span className="font-bold text-gray-800">{fmt(cc.totalBill)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">最低还款额</span><span className="font-medium text-orange-600">{fmt(cc.minimumPayment)}</span>
            </div>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500">还款月份</label>
            <input type="month" className="w-full border rounded-lg p-2 mt-1 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">本次还款金额</label>
            <input type="number" className="w-full border rounded-lg p-2 mt-1 text-sm" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
            ✓ 确认还款
          </button>
          <button className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 font-semibold" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function CreditCardCard({ card, onAddInstallment, onPay, onDelete, onUpdateSpending, onDeleteInstallment, onMarkInstallmentPaid }) {
  const cc = computeCreditCard(card);
  const [expanded, setExpanded] = useState(false);
  const [editSpending, setEditSpending] = useState(false);
  const [spendingInput, setSpendingInput] = useState(String(card.lastMonthSpending));
  const [showAddInst, setShowAddInst] = useState(false);
  const days = daysUntilDue(card.dueDay);
  const paidThisMonth = card.payments.some((p) => p.month === TODAY_MONTH);

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
            <button className="text-gray-300 hover:text-red-400 text-lg leading-none" onClick={(e) => { e.stopPropagation(); onDelete(card.id); }}>×</button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center mb-3">
          <div className="bg-red-50 rounded-xl p-2">
            <p className="text-xs text-red-400">本期应还</p>
            <p className="text-sm font-bold text-red-700">{fmtShort(cc.totalBill)}</p>
          </div>
          <div className="bg-orange-50 rounded-xl p-2">
            <p className="text-xs text-orange-400">最低还款</p>
            <p className="text-sm font-bold text-orange-600">{fmtShort(cc.minimumPayment)}</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-2">
            <p className="text-xs text-blue-400">分期月供</p>
            <p className="text-sm font-bold text-blue-700">{fmtShort(cc.instMonthlyTotal)}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <DueBadge days={days} />
          <span className="text-xs text-gray-400">{expanded ? "收起 ▲" : "展开明细 ▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-4">
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">分期明细</p>
            {cc.instDetails.map((inst) => {
              const active = inst.remainingCount > 0;
              return (
                <div key={inst.id} className={`bg-white rounded-xl p-3 mb-2 ${!active ? "opacity-40" : ""}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{inst.name}</p>
                      <p className="text-xs text-gray-400">
                        共{inst.installmentCount}期 · 已还{inst.paidCount}期 · 剩{inst.remainingCount}期
                        {inst.feeRateMonthly > 0 && ` · ${inst.feeRateMonthly}%/月`}
                      </p>
                    </div>
                    <button className="text-xs text-gray-300 hover:text-red-400" onClick={() => onDeleteInstallment(card.id, inst.id)}>×</button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                    <div><p className="text-gray-400">本月本金</p><p className="font-semibold text-gray-700">{fmt(inst.principal)}</p></div>
                    <div><p className="text-gray-400">手续费</p><p className="font-semibold text-gray-700">{inst.feeRateMonthly > 0 ? fmt(inst.fee) : "—"}</p></div>
                    <div><p className="text-gray-400">月供小计</p><p className="font-bold text-blue-700">{fmt(inst.monthlyTotal)}</p></div>
                  </div>
                  {active && (
                    <>
                      <div className="mb-1">
                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                          <span>还款进度 {Math.round((inst.paidCount / inst.installmentCount) * 100)}%</span>
                          <span>剩余本金 {fmtShort(inst.remainingBalance)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-blue-400" style={{ width: `${(inst.paidCount / inst.installmentCount) * 100}%` }} />
                        </div>
                      </div>
                      <button className="text-xs text-blue-500 hover:text-blue-700 font-medium"
                        onClick={() => onMarkInstallmentPaid(card.id, inst.id)}>✓ 标记本期已还（+1期）</button>
                    </>
                  )}
                </div>
              );
            })}
            <button className="w-full text-xs text-blue-600 font-semibold border border-blue-200 rounded-xl py-2 hover:bg-blue-50"
              onClick={() => setShowAddInst(true)}>+ 新增分期账单</button>
          </div>

          <div className="bg-white rounded-xl p-3">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm font-semibold text-gray-800">上月新消费（非分期）</p>
                <p className="text-xs text-gray-400">本期需还清或计入最低还款</p>
              </div>
              {!editSpending ? (
                <div className="text-right">
                  <p className="font-bold text-gray-800">{fmt(card.lastMonthSpending)}</p>
                  <button className="text-xs text-blue-500 hover:text-blue-700" onClick={(e) => { e.stopPropagation(); setEditSpending(true); }}>修改</button>
                </div>
              ) : (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input type="number" className="w-24 border rounded-lg p-1 text-sm text-right"
                    value={spendingInput} onChange={(e) => setSpendingInput(e.target.value)} />
                  <button className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg"
                    onClick={() => { onUpdateSpending(card.id, Number(spendingInput)); setEditSpending(false); }}>确认</button>
                </div>
              )}
            </div>
          </div>

          {!paidThisMonth ? (
            <button className="w-full py-2.5 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 text-sm"
              onClick={() => onPay(card)}>💰 记录本月还款</button>
          ) : (
            <button className="w-full py-2.5 bg-gray-100 text-gray-500 font-semibold rounded-xl hover:bg-gray-200 text-sm"
              onClick={() => onPay(card)}>重新记录还款</button>
          )}

          {card.payments.length > 0 && (
            <details>
              <summary className="text-xs text-gray-400 cursor-pointer">历史还款记录 ({card.payments.length}笔)</summary>
              <div className="mt-2 space-y-1">
                {[...card.payments].reverse().slice(0, 6).map((p, i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-500 py-1 border-b border-gray-100">
                    <span>{p.month}</span>
                    <span className="font-medium text-green-600">-{fmt(p.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {showAddInst && (
        <AddInstallmentModal cardName={card.name}
          onAdd={(inst) => onAddInstallment(card.id, inst)}
          onClose={() => setShowAddInst(false)} />
      )}
    </div>
  );
}

function LoanCard({ loan, onPay, onDelete }) {
  const isInstallment = loan.loanStyle === "installment" && loan.totalPeriods > 0;
  const paidPeriods  = loan.paidPeriods  || 0;
  const totalPeriods = loan.totalPeriods || 0;
  const remainPeriods = Math.max(0, totalPeriods - paidPeriods);

  // 进度：有期数用期数，否则用金额
  const paidRatio = isInstallment
    ? (totalPeriods > 0 ? paidPeriods / totalPeriods : 0)
    : (loan.totalAmount > 0 ? Math.max(0, (loan.totalAmount - loan.remainingBalance) / loan.totalAmount) : 0);

  const paidThisMonth = loan.payments.some((p) => p.month === TODAY_MONTH);
  const days = daysUntilDue(loan.dueDay);
  const monthlyInterest = loan.interestRate > 0 ? (loan.remainingBalance * loan.interestRate) / 100 / 12 : 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: loan.color }} />
          <div>
            <h3 className="font-bold text-gray-800 text-sm">{loan.name}</h3>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-xs text-gray-400">
                {loan.loanStyle === "flexible" ? "随时还清" : "等额月供"} · 每月{loan.dueDay}日
              </span>
              {isInstallment && (
                <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full font-medium">
                  剩 {remainPeriods} 期
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {paidThisMonth && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">✓ 已还</span>}
          <button className="text-gray-300 hover:text-red-400 text-lg" onClick={() => onDelete(loan.id)}>×</button>
        </div>
      </div>

      {/* 进度条 */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          {isInstallment ? (
            <>
              <span>已还 {paidPeriods}/{totalPeriods} 期（{Math.round(paidRatio * 100)}%）</span>
              <span>剩余 {fmtShort(loan.remainingBalance)}</span>
            </>
          ) : (
            <>
              <span>已还 {Math.round(paidRatio * 100)}%</span>
              <span>剩余 {fmtShort(loan.remainingBalance)}</span>
            </>
          )}
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${paidRatio * 100}%`, backgroundColor: loan.color }} />
        </div>
        {isInstallment && remainPeriods > 0 && (
          <p className="text-xs text-gray-400 mt-1">
            预计还清：约 {remainPeriods >= 12
              ? `${Math.floor(remainPeriods/12)}年${remainPeriods%12 > 0 ? remainPeriods%12+"个月" : ""}`
              : `${remainPeriods}个月`}后
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">月还款</p>
          <p className="text-sm font-bold text-gray-700">{loan.monthlyPayment > 0 ? fmtShort(loan.monthlyPayment) : "—"}</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">年利率</p>
          <p className="text-sm font-bold text-gray-700">{loan.interestRate > 0 ? loan.interestRate + "%" : "—"}</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-2">
          <p className="text-xs text-gray-400">月利息约</p>
          <p className="text-sm font-bold text-gray-700">{monthlyInterest > 0 ? fmtShort(monthlyInterest) : "—"}</p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <DueBadge days={days} />
        {!paidThisMonth
          ? <button className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700" onClick={() => onPay(loan)}>💰 记录还款</button>
          : <button className="px-4 py-1.5 bg-gray-100 text-gray-500 text-xs font-semibold rounded-lg" onClick={() => onPay(loan)}>重新记录</button>
        }
      </div>
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
  const [showAddDebt, setShowAddDebt] = useState(false);
  const [payingDebt, setPayingDebt] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [loading, setLoading] = useState(firebaseConfigured);

  // ── Firebase sync ──
  useEffect(() => {
    if (!firebaseConfigured || !db) return;
    const ref = doc(db, "users", "main", "data", "debts");
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        const data = snap.data().list;
        if (data) {
          setDebts(data);
          saveToLocal(data);
        }
      }
      setLoading(false);
      setSyncStatus("synced");
    }, () => {
      setLoading(false);
      setSyncStatus("local");
    });
    return unsub;
  }, []);

  // ── Save to Firebase or localStorage whenever debts change ──
  const persistDebts = useCallback(async (newDebts) => {
    saveToLocal(newDebts);
    if (!firebaseConfigured || !db) return;
    setSyncStatus("saving");
    try {
      await setDoc(doc(db, "users", "main", "data", "debts"), { list: newDebts });
      setSyncStatus("synced");
    } catch {
      setSyncStatus("local");
    }
  }, []);

  const updateDebts = useCallback((updater) => {
    setDebts((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      persistDebts(next);
      return next;
    });
  }, [persistDebts]);

  // ── Totals ──
  const totals = useMemo(() => {
    let monthlyDue = 0, minimumDue = 0, totalRemaining = 0;
    debts.forEach((d) => {
      if (d.type === "credit_card") {
        const cc = computeCreditCard(d);
        monthlyDue += cc.totalBill; minimumDue += cc.minimumPayment; totalRemaining += cc.totalRemainingBalance;
      } else {
        monthlyDue += d.monthlyPayment; minimumDue += d.monthlyPayment; totalRemaining += d.remainingBalance;
      }
    });
    return { monthlyDue, minimumDue, totalRemaining };
  }, [debts]);

  // ── Trend ──
  const trendData = useMemo(() =>
    Array.from({ length: 12 }, (_, i) => {
      const offset = i - 3;
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth() + offset, 1);
      return {
        label: `${d.getMonth() + 1}月`,
        预计剩余负债: Math.round(Math.max(0, totals.totalRemaining - totals.minimumDue * offset)),
      };
    }), [totals]);

  const upcomingDue = useMemo(() =>
    [...debts]
      .filter((d) => daysUntilDue(d.dueDay) <= 10 && !d.payments.some((p) => p.month === TODAY_MONTH))
      .sort((a, b) => daysUntilDue(a.dueDay) - daysUntilDue(b.dueDay)),
    [debts]);

  const sorted = [...debts].sort((a, b) => a.dueDay - b.dueDay);

  // ── Handlers ──
  const handleAddDebt = (d) => updateDebts((p) => [...p, d]);
  const handleDeleteDebt = (id) => { updateDebts((p) => p.filter((d) => d.id !== id)); setDeletingId(null); };
  const handlePay = (debtId, amount, month) => updateDebts((p) => p.map((d) => {
    if (d.id !== debtId) return d;
    const payments = [...d.payments, { month, amount, date: new Date().toISOString() }];
    if (d.type === "loan") {
      const newBalance = Math.max(0, d.remainingBalance - amount);
      // 等额月供：每次还款自动推进1期（已还期数+1，不超过总期数）
      const newPaidPeriods = d.loanStyle === "installment" && d.totalPeriods > 0
        ? Math.min((d.paidPeriods || 0) + 1, d.totalPeriods)
        : d.paidPeriods || 0;
      return { ...d, remainingBalance: newBalance, paidPeriods: newPaidPeriods, payments };
    }
    return { ...d, payments };
  }));
  const handleAddInstallment = (cardId, inst) => updateDebts((p) => p.map((d) => d.id === cardId ? { ...d, installments: [...d.installments, inst] } : d));
  const handleDeleteInstallment = (cardId, instId) => updateDebts((p) => p.map((d) => d.id === cardId ? { ...d, installments: d.installments.filter((i) => i.id !== instId) } : d));
  const handleMarkInstallmentPaid = (cardId, instId) => updateDebts((p) => p.map((d) => {
    if (d.id !== cardId) return d;
    return { ...d, installments: d.installments.map((i) => i.id !== instId ? i : { ...i, paidCount: Math.min(i.paidCount + 1, i.installmentCount) }) };
  }));
  const handleUpdateSpending = (cardId, amount) => updateDebts((p) => p.map((d) => d.id === cardId ? { ...d, lastMonthSpending: amount } : d));

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">正在同步数据…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-800 to-blue-700 text-white px-4 pt-8 pb-16">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-bold">💳 负债管理工具</h1>
          <SyncBadge status={syncStatus} />
        </div>
        <p className="text-blue-200 text-xs">信用卡分期 · 贷款 · 全览</p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[["总剩余负债", fmtShort(totals.totalRemaining), "text-white"], ["本月应还", fmtShort(totals.monthlyDue), "text-yellow-300"], ["最低还款", fmtShort(totals.minimumDue), "text-orange-300"]].map(([l, v, c]) => (
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

        {/* DASHBOARD */}
        {activeTab === "dashboard" && (
          <div className="space-y-4">
            {upcomingDue.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <h3 className="text-sm font-bold text-red-700 mb-2">⏰ 近期还款提醒</h3>
                {upcomingDue.map((d) => {
                  const isCard = d.type === "credit_card";
                  const cc = isCard ? computeCreditCard(d) : null;
                  return (
                    <div key={d.id} className="flex items-center justify-between py-2 border-b border-red-100 last:border-0">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        <div>
                          <span className="text-sm font-medium text-gray-800">{d.name}</span>
                          {isCard && <span className="text-xs text-gray-400 ml-1">({cc.activeInsts.length}笔分期+消费)</span>}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-red-600">{isCard ? fmtShort(cc.totalBill) : fmtShort(d.monthlyPayment)}</p>
                        <DueBadge days={daysUntilDue(d.dueDay)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3">本月还款计划</h3>
              {sorted.map((d) => {
                const isCard = d.type === "credit_card";
                const cc = isCard ? computeCreditCard(d) : null;
                const paid = d.payments.some((p) => p.month === TODAY_MONTH);
                return (
                  <div key={d.id} className={`py-3 border-b border-gray-100 last:border-0 ${paid ? "opacity-40" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ backgroundColor: d.color }}>{d.dueDay}</div>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{d.name}</p>
                          {isCard
                            ? <p className="text-xs text-gray-400">分期 {fmtShort(cc.instMonthlyTotal)} + 消费 {fmtShort(d.lastMonthSpending)}</p>
                            : <p className="text-xs text-gray-400">{d.interestRate > 0 ? `年利率 ${d.interestRate}%` : "贷款"}</p>}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-gray-800">{isCard ? fmtShort(cc.totalBill) : fmtShort(d.monthlyPayment)}</p>
                        {isCard && <p className="text-xs text-orange-500">最低 {fmtShort(cc.minimumPayment)}</p>}
                        {paid ? <span className="text-xs text-green-600">✓ 已还</span> : <DueBadge days={daysUntilDue(d.dueDay)} />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* DEBTS */}
        {activeTab === "debts" && (
          <div className="space-y-3">
            {sorted.map((d) =>
              d.type === "credit_card"
                ? <CreditCardCard key={d.id} card={d} onAddInstallment={handleAddInstallment} onPay={(c) => setPayingDebt(c)} onDelete={(id) => setDeletingId(id)} onUpdateSpending={handleUpdateSpending} onDeleteInstallment={handleDeleteInstallment} onMarkInstallmentPaid={handleMarkInstallmentPaid} />
                : <LoanCard key={d.id} loan={d} onPay={(l) => setPayingDebt(l)} onDelete={(id) => setDeletingId(id)} />
            )}
            {debts.length === 0 && <div className="text-center py-16 text-gray-400"><p className="text-4xl mb-3">🎉</p><p className="font-semibold">暂无负债</p></div>}
          </div>
        )}

        {/* TREND */}
        {activeTab === "trend" && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-1">负债预测趋势</h3>
              <p className="text-xs text-gray-400 mb-4">按最低还款额估算剩余走势</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `¥${(v/10000).toFixed(0)}万`} />
                  <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  <Line type="monotone" dataKey="预计剩余负债" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-4">各账户月供构成</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={debts.map((d) => {
                  if (d.type === "credit_card") { const cc = computeCreditCard(d); return { name: d.name.slice(0,4), 分期月供: Math.round(cc.instMonthlyTotal), 当月消费: d.lastMonthSpending }; }
                  return { name: d.name.slice(0,4), 月供: d.monthlyPayment, 月利息: Math.round((d.remainingBalance * d.interestRate) / 100 / 12) };
                })}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `¥${v}`} />
                  <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="分期月供" fill="#3b82f6" stackId="a" />
                  <Bar dataKey="当月消费" fill="#f97316" stackId="a" radius={[4,4,0,0]} />
                  <Bar dataKey="月供" fill="#a855f7" stackId="a" />
                  <Bar dataKey="月利息" fill="#ec4899" stackId="a" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* FAB */}
      <div className="fixed bottom-6 right-5">
        <button className="w-14 h-14 rounded-full bg-blue-600 text-white text-2xl shadow-xl hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center"
          onClick={() => setShowAddDebt(true)}>+</button>
      </div>

      {/* Modals */}
      {showAddDebt && <AddDebtModal onAdd={handleAddDebt} onClose={() => setShowAddDebt(false)} />}
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
