/**
 * @fileoverview Interactive browser controller for HostelSplit.
 * Manages state persistence in localStorage (`hostel_split_v1`), debounced filtering,
 * accessible modal/toast notifications, and XSS-safe DOM rendering using `core.js`.
 */

import {
  calculateEqualSplit,
  canRemoveMember,
  computeMemberBalances,
  createExpense,
  createMember,
  filterExpenses,
  formatINR,
  formatSettlementSummary,
  rehydrateState,
  simplifyDebts,
} from './core.js';

/**
 * Versioned localStorage key for HostelSplit persistence.
 * @type {string}
 */
const STORAGE_KEY = 'hostel_split_v1';

/**
 * Debounce delay in milliseconds for search and category filtering.
 * @type {number}
 */
const FILTER_DEBOUNCE_MS = 200;

/**
 * Category pill color classes mapped by category name.
 * @type {Record<string, string>}
 */
const CATEGORY_BADGE_CLASSES = Object.freeze({
  'Food / Mess': 'bg-amber-50 text-amber-800 border-amber-200',
  'Travel / Auto': 'bg-sky-50 text-sky-800 border-sky-200',
  Groceries: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  Utilities: 'bg-violet-50 text-violet-800 border-violet-200',
  Other: 'bg-slate-100 text-slate-700 border-slate-200',
});

/**
 * Application runtime state.
 * @type {{
 *   members: Array<{id: string, name: string, upiId: string}>,
 *   expenses: Array<object>,
 *   filters: {query: string, category: string}
 * }}
 */
const state = {
  members: [],
  expenses: [],
  filters: {
    query: '',
    category: 'ALL',
  },
};

/** @type {number | undefined} */
let toastTimerId;

/** @type {HTMLElement | null} */
let lastDialogTrigger = null;

/** @type {(() => void) | null} */
let pendingConfirmCallback = null;

/**
 * Cached DOM element references.
 */
const dom = {
  kpiTotalSpend: document.getElementById('kpi-total-spend'),
  kpiExpenseCount: document.getElementById('kpi-expense-count'),
  kpiMemberCount: document.getElementById('kpi-member-count'),
  kpiTransferCount: document.getElementById('kpi-transfer-count'),
  memberForm: document.getElementById('member-form'),
  memberNameInput: document.getElementById('member-name'),
  memberUpiInput: document.getElementById('member-upi'),
  memberFormError: document.getElementById('member-form-error'),
  memberList: document.getElementById('member-list'),
  memberEmptyState: document.getElementById('member-empty-state'),
  expenseForm: document.getElementById('expense-form'),
  expenseTitleInput: document.getElementById('expense-title'),
  expenseAmountInput: document.getElementById('expense-amount'),
  expenseCategorySelect: document.getElementById('expense-category'),
  expensePayerSelect: document.getElementById('expense-payer'),
  participantsCheckboxes: document.getElementById('participants-checkboxes'),
  participantsEmptyHint: document.getElementById('participants-empty-hint'),
  splitPreviewText: document.getElementById('split-preview-text'),
  selectAllParticipantsBtn: document.getElementById('select-all-participants-btn'),
  clearParticipantsBtn: document.getElementById('clear-participants-btn'),
  expenseFormError: document.getElementById('expense-form-error'),
  addExpenseBtn: document.getElementById('add-expense-btn'),
  settlementSubtitle: document.getElementById('settlement-subtitle'),
  settlementsList: document.getElementById('settlements-list'),
  settlementsEmptyState: document.getElementById('settlements-empty-state'),
  copySummaryBtn: document.getElementById('copy-summary-btn'),
  ledgerCountLabel: document.getElementById('ledger-count-label'),
  expenseSearchInput: document.getElementById('expense-search'),
  filterCategorySelect: document.getElementById('filter-category'),
  expenseList: document.getElementById('expense-list'),
  expenseEmptyState: document.getElementById('expense-empty-state'),
  loadDemoBtn: document.getElementById('load-demo-btn'),
  resetAllBtn: document.getElementById('reset-all-btn'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmDialogTitle: document.getElementById('confirm-dialog-title'),
  confirmDialogMessage: document.getElementById('confirm-dialog-message'),
  confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
  confirmAcceptBtn: document.getElementById('confirm-accept-btn'),
  toastBox: document.getElementById('toast-box'),
};

/**
 * Create a debounced wrapper around a callback function.
 * @param {(...args: any[]) => void} fn - Function to debounce.
 * @param {number} delayMs - Wait interval in milliseconds.
 * @returns {(...args: any[]) => void} Debounced function.
 */
function debounce(fn, delayMs) {
  /** @type {number | undefined} */
  let timerId;
  return (...args) => {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => fn(...args), delayMs);
  };
}

/**
 * Load and validate state from `localStorage` under `hostel_split_v1`.
 * @returns {void}
 */
function loadStateFromStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    const rehydrated = rehydrateState(parsed);
    state.members = rehydrated.members;
    state.expenses = rehydrated.expenses;
  } catch {
    state.members = [];
    state.expenses = [];
  }
}

/**
 * Persist current members and expenses to `localStorage`.
 * @returns {void}
 */
function saveStateToStorage() {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        members: state.members,
        expenses: state.expenses,
      })
    );
  } catch {
    showToast('Unable to persist data to localStorage (storage quota or private mode).');
  }
}

/**
 * Display a polite screen-reader-announced toast message.
 * @param {string} message - Short status text to show.
 * @returns {void}
 */
function showToast(message) {
  if (!dom.toastBox) {
    return;
  }
  window.clearTimeout(toastTimerId);
  dom.toastBox.textContent = message;
  dom.toastBox.classList.remove('hidden');

  toastTimerId = window.setTimeout(() => {
    dom.toastBox.classList.add('hidden');
    dom.toastBox.textContent = '';
  }, 3200);
}

/**
 * Show or clear an inline form validation error banner.
 * @param {HTMLElement | null} element - Alert paragraph element.
 * @param {string} message - Error text (empty string hides the banner).
 * @returns {void}
 */
function setFormError(element, message) {
  if (!element) {
    return;
  }
  if (!message) {
    element.textContent = '';
    element.classList.add('hidden');
    return;
  }
  element.textContent = message;
  element.classList.remove('hidden');
}

/**
 * Open the accessible confirmation dialog and bind confirm callback.
 * @param {{title: string, message: string, confirmLabel?: string, triggerEl?: HTMLElement | null, onConfirm: () => void}} options
 * @returns {void}
 */
function openConfirmDialog({ title, message, confirmLabel = 'Confirm', triggerEl = null, onConfirm }) {
  if (!dom.confirmDialog) {
    onConfirm();
    return;
  }
  lastDialogTrigger = triggerEl;
  pendingConfirmCallback = onConfirm;
  dom.confirmDialogTitle.textContent = title;
  dom.confirmDialogMessage.textContent = message;
  dom.confirmAcceptBtn.textContent = confirmLabel;

  if (typeof dom.confirmDialog.showModal === 'function') {
    dom.confirmDialog.showModal();
  } else {
    dom.confirmDialog.setAttribute('open', 'true');
  }
  dom.confirmCancelBtn.focus();
}

/**
 * Close the confirmation dialog and restore keyboard focus to its trigger.
 * @returns {void}
 */
function closeConfirmDialog() {
  if (!dom.confirmDialog) {
    return;
  }
  pendingConfirmCallback = null;
  if (typeof dom.confirmDialog.close === 'function' && dom.confirmDialog.open) {
    dom.confirmDialog.close();
  } else {
    dom.confirmDialog.removeAttribute('open');
  }
  if (lastDialogTrigger && typeof lastDialogTrigger.focus === 'function') {
    lastDialogTrigger.focus();
  }
  lastDialogTrigger = null;
}

/**
 * Create a styled text element safely using `textContent` (never raw HTML).
 * @param {string} tag - HTML tag name.
 * @param {string} className - Tailwind utility class string.
 * @param {string} text - Text content to assign safely.
 * @returns {HTMLElement} Created element.
 */
function createTextElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  el.textContent = text;
  return el;
}

/**
 * Build a Map from member ID to member record for O(1) lookups during rendering.
 * @returns {Map<string, {id: string, name: string, upiId: string}>}
 */
function getMemberMap() {
  return new Map(state.members.map((m) => [m.id, m]));
}

/**
 * Collect the currently checked participant IDs from the expense form.
 * @returns {string[]} Selected member IDs.
 */
function getSelectedParticipantIds() {
  if (!dom.participantsCheckboxes) {
    return [];
  }
  const checked = dom.participantsCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
  return Array.from(checked).map((input) => input.value);
}

/**
 * Update the live equal-split preview line beneath the participant checkboxes.
 * @returns {void}
 */
function updateSplitPreview() {
  if (!dom.splitPreviewText) {
    return;
  }
  const selectedIds = getSelectedParticipantIds();
  const rawAmount = Number(dom.expenseAmountInput?.value);

  if (selectedIds.length === 0) {
    dom.splitPreviewText.textContent =
      state.members.length > 0 ? 'Select at least 1 participant to preview the split.' : '';
    return;
  }

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    dom.splitPreviewText.textContent = `Splitting among ${selectedIds.length} roommate(s).`;
    return;
  }

  try {
    const splits = calculateEqualSplit(rawAmount, selectedIds);
    const minShare = splits[splits.length - 1].amount;
    const maxShare = splits[0].amount;
    if (minShare === maxShare) {
      dom.splitPreviewText.textContent = `${formatINR(minShare)} per person (${selectedIds.length} ways)`;
    } else {
      dom.splitPreviewText.textContent = `~${formatINR(minShare)}–${formatINR(maxShare)} per person (exact paise reconciled across ${selectedIds.length} ways)`;
    }
  } catch {
    dom.splitPreviewText.textContent = '';
  }
}

/**
 * Render the summary KPI cards and return computed transfers and total spend.
 * @param {Array<object>} transfers - Simplified debt transfers.
 * @returns {number} Total group spend in INR.
 */
function renderSummaryKPIs(transfers) {
  const totalPaise = state.expenses.reduce((sum, exp) => sum + (exp.amountPaise || 0), 0);
  const totalINR = Number((totalPaise / 100).toFixed(2));

  dom.kpiTotalSpend.textContent = formatINR(totalINR);
  dom.kpiExpenseCount.textContent = String(state.expenses.length);
  dom.kpiMemberCount.textContent = String(state.members.length);
  dom.kpiTransferCount.textContent = String(transfers.length);

  return totalINR;
}

/**
 * Render the roommate roster list with live net balances and accessible delete buttons.
 * @param {Array<{id: string, name: string, upiId: string, netPaise: number, net: number}>} balances
 * @returns {void}
 */
function renderMemberRoster(balances) {
  dom.memberList.replaceChildren();
  const hasMembers = state.members.length > 0;
  dom.memberEmptyState.classList.toggle('hidden', hasMembers);

  const balanceMap = new Map(balances.map((b) => [b.id, b]));

  for (const member of state.members) {
    const balance = balanceMap.get(member.id);
    const netPaise = balance ? balance.netPaise : 0;
    const netAmount = balance ? balance.net : 0;

    const li = document.createElement('li');
    li.className =
      'flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5';

    const leftDiv = document.createElement('div');
    leftDiv.className = 'min-w-0';

    const nameEl = createTextElement('p', 'text-sm font-semibold text-slate-900 truncate', member.name);
    const upiText = member.upiId ? `UPI: ${member.upiId}` : 'No UPI ID saved';
    const upiEl = createTextElement('p', 'text-xs text-slate-600 truncate', upiText);

    leftDiv.append(nameEl, upiEl);

    const rightDiv = document.createElement('div');
    rightDiv.className = 'flex items-center gap-2 shrink-0';

    let badgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
    let badgeText = 'Settled';
    if (netPaise > 0) {
      badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200';
      badgeText = `+${formatINR(netAmount)}`;
    } else if (netPaise < 0) {
      badgeClass = 'bg-rose-50 text-rose-800 border-rose-200';
      badgeText = `-${formatINR(Math.abs(netAmount))}`;
    }

    const balanceBadge = createTextElement(
      'span',
      `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${badgeClass}`,
      badgeText
    );

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.dataset.action = 'remove-member';
    deleteBtn.dataset.memberId = member.id;
    deleteBtn.setAttribute('aria-label', `Remove ${member.name} from roster`);
    deleteBtn.className =
      'inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-rose-700 hover:border-rose-300 hover:bg-rose-50 transition-colors text-xs font-bold';
    deleteBtn.textContent = '✕';

    rightDiv.append(balanceBadge, deleteBtn);
    li.append(leftDiv, rightDiv);
    dom.memberList.appendChild(li);
  }
}

/**
 * Synchronize the expense form's payer dropdown and participant checkboxes with the current roster.
 * Preserves existing checked selections when members are added or removed.
 * @returns {void}
 */
function renderExpenseFormControls() {
  const previousPayer = dom.expensePayerSelect.value;
  const previousChecked = new Set(getSelectedParticipantIds());
  const hadPriorMembers = dom.participantsCheckboxes.childElementCount > 0;

  dom.expensePayerSelect.replaceChildren();
  dom.participantsCheckboxes.replaceChildren();

  const hasMembers = state.members.length > 0;
  dom.participantsEmptyHint.classList.toggle('hidden', hasMembers);
  dom.addExpenseBtn.disabled = !hasMembers;
  dom.expensePayerSelect.disabled = !hasMembers;

  if (!hasMembers) {
    const opt = createTextElement('option', '', 'Add roommates first');
    opt.value = '';
    dom.expensePayerSelect.appendChild(opt);
    updateSplitPreview();
    return;
  }

  for (const member of state.members) {
    const option = document.createElement('option');
    option.value = member.id;
    option.textContent = member.name;
    dom.expensePayerSelect.appendChild(option);

    const wrapper = document.createElement('div');
    wrapper.className =
      'flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 hover:border-indigo-300';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `participant-${member.id}`;
    checkbox.name = 'participants';
    checkbox.value = member.id;
    checkbox.checked = hadPriorMembers ? previousChecked.has(member.id) : true;
    checkbox.className = 'h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-600';

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.className = 'text-sm text-slate-800 cursor-pointer select-none truncate flex-1';
    label.textContent = member.name;

    wrapper.append(checkbox, label);
    dom.participantsCheckboxes.appendChild(wrapper);
  }

  if (state.members.some((m) => m.id === previousPayer)) {
    dom.expensePayerSelect.value = previousPayer;
  } else {
    dom.expensePayerSelect.value = state.members[0].id;
  }

  updateSplitPreview();
}

/**
 * Render the simplified min-cash-flow settlements panel with UPI deep-link buttons.
 * @param {Array<{from: string, to: string, toUpiId: string, amount: number, upiLink: string|null}>} transfers
 * @returns {void}
 */
function renderSettlements(transfers) {
  dom.settlementsList.replaceChildren();
  const hasTransfers = transfers.length > 0;
  dom.settlementsEmptyState.classList.toggle('hidden', hasTransfers);

  if (state.expenses.length > 0 && hasTransfers) {
    dom.settlementSubtitle.textContent = `Simplified ${state.expenses.length} expense(s) into ${transfers.length} transfer(s)`;
  } else {
    dom.settlementSubtitle.textContent =
      'Greedy min-cash-flow transfers — minimum payments to settle the whole group';
  }

  for (const transfer of transfers) {
    const li = document.createElement('li');
    li.className =
      'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'space-y-1';

    const flowRow = document.createElement('p');
    flowRow.className = 'text-sm sm:text-base font-medium text-slate-900 flex flex-wrap items-center gap-1.5';

    const fromSpan = createTextElement('span', 'font-semibold text-rose-700', transfer.from);
    const arrowSpan = createTextElement('span', 'text-slate-500 text-xs uppercase font-semibold', 'pays');
    const toSpan = createTextElement('span', 'font-semibold text-emerald-800', transfer.to);

    flowRow.append(fromSpan, arrowSpan, toSpan);

    const subText = transfer.toUpiId
      ? `Recipient UPI: ${transfer.toUpiId}`
      : 'Recipient has not added a UPI ID yet';
    const subEl = createTextElement('p', 'text-xs text-slate-600', subText);

    infoDiv.append(flowRow, subEl);

    const actionDiv = document.createElement('div');
    actionDiv.className = 'flex items-center justify-between sm:justify-end gap-3 shrink-0';

    const amountBadge = createTextElement(
      'span',
      'text-base sm:text-lg font-bold text-slate-900 tabular-nums',
      formatINR(transfer.amount)
    );
    actionDiv.appendChild(amountBadge);

    if (transfer.upiLink) {
      const payLink = document.createElement('a');
      payLink.href = transfer.upiLink;
      payLink.setAttribute(
        'aria-label',
        `Pay ${transfer.to} ${formatINR(transfer.amount)} via UPI`
      );
      payLink.className =
        'inline-flex items-center justify-center px-3.5 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-800 text-white text-xs sm:text-sm font-semibold shadow-sm transition-colors';
      payLink.textContent = 'Pay via UPI';
      actionDiv.appendChild(payLink);
    } else {
      const noUpiPill = createTextElement(
        'span',
        'inline-flex items-center px-2.5 py-1.5 rounded-lg bg-slate-200/70 text-slate-600 text-xs font-medium',
        'Add UPI ID to pay'
      );
      actionDiv.appendChild(noUpiPill);
    }

    li.append(infoDiv, actionDiv);
    dom.settlementsList.appendChild(li);
  }
}

/**
 * Render the filtered expense ledger list.
 * @returns {void}
 */
function renderExpenseLedger() {
  const memberMap = getMemberMap();
  const filtered = filterExpenses(state.expenses, state.filters, memberMap);

  dom.expenseList.replaceChildren();
  dom.expenseEmptyState.classList.toggle('hidden', filtered.length > 0);
  dom.ledgerCountLabel.textContent =
    filtered.length === state.expenses.length
      ? `Showing ${filtered.length} expense(s)`
      : `Showing ${filtered.length} of ${state.expenses.length} expense(s)`;

  // Render newest expenses first for convenient hostel review.
  const ordered = [...filtered].reverse();

  for (const expense of ordered) {
    const payerName = memberMap.get(expense.payerId)?.name || 'Unknown';
    const participantNames = (expense.participantIds || [])
      .map((id) => memberMap.get(id)?.name || 'Unknown')
      .join(', ');

    const li = document.createElement('li');
    li.className =
      'rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors';

    const topRow = document.createElement('div');
    topRow.className = 'flex items-start justify-between gap-3';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'min-w-0 space-y-1';

    const titleLine = document.createElement('div');
    titleLine.className = 'flex flex-wrap items-center gap-2';

    const titleEl = createTextElement('h3', 'text-sm sm:text-base font-semibold text-slate-900', expense.title);
    const badgeClasses = CATEGORY_BADGE_CLASSES[expense.category] || CATEGORY_BADGE_CLASSES.Other;
    const categoryBadge = createTextElement(
      'span',
      `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${badgeClasses}`,
      expense.category
    );
    titleLine.append(titleEl, categoryBadge);

    const metaEl = createTextElement(
      'p',
      'text-xs text-slate-600',
      `Paid by ${payerName} • Split ${expense.participantIds.length} ways (${participantNames})`
    );

    titleWrap.append(titleLine, metaEl);

    const rightControls = document.createElement('div');
    rightControls.className = 'flex items-center gap-2.5 shrink-0';

    const amountEl = createTextElement(
      'span',
      'text-sm sm:text-base font-bold text-slate-900 tabular-nums',
      formatINR(expense.amount)
    );

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.dataset.action = 'remove-expense';
    deleteBtn.dataset.expenseId = expense.id;
    deleteBtn.setAttribute('aria-label', `Delete expense ${expense.title}`);
    deleteBtn.className =
      'inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 hover:text-rose-700 hover:border-rose-300 hover:bg-rose-50 transition-colors text-xs font-bold';
    deleteBtn.textContent = '✕';

    rightControls.append(amountEl, deleteBtn);
    topRow.append(titleWrap, rightControls);
    li.appendChild(topRow);
    dom.expenseList.appendChild(li);
  }
}

/**
 * Recompute balances and simplified settlements and re-render all UI panels.
 * @returns {void}
 */
function renderAll() {
  const balances = computeMemberBalances(state.members, state.expenses);
  const transfers = simplifyDebts(state.members, state.expenses);

  renderSummaryKPIs(transfers);
  renderMemberRoster(balances);
  renderExpenseFormControls();
  renderSettlements(transfers);
  renderExpenseLedger();
}

/**
 * Handle adding a new roommate to the roster.
 * @param {SubmitEvent} event
 * @returns {void}
 */
function handleAddMember(event) {
  event.preventDefault();
  setFormError(dom.memberFormError, '');

  try {
    const newMember = createMember(
      {
        name: dom.memberNameInput.value,
        upiId: dom.memberUpiInput.value,
      },
      state.members
    );

    state.members.push(newMember);
    saveStateToStorage();
    dom.memberForm.reset();
    dom.memberNameInput.focus();
    renderAll();
    showToast(`Added ${newMember.name} to the roster.`);
  } catch (err) {
    setFormError(dom.memberFormError, err instanceof Error ? err.message : 'Unable to add roommate.');
  }
}

/**
 * Handle removing a roommate if they are not referenced in active expenses.
 * @param {string} memberId
 * @returns {void}
 */
function handleRemoveMember(memberId) {
  const check = canRemoveMember(memberId, state.expenses);
  if (!check.allowed) {
    setFormError(dom.memberFormError, check.reason);
    showToast(check.reason);
    return;
  }

  const target = state.members.find((m) => m.id === memberId);
  state.members = state.members.filter((m) => m.id !== memberId);
  saveStateToStorage();
  setFormError(dom.memberFormError, '');
  renderAll();
  if (target) {
    showToast(`Removed ${target.name} from roster.`);
  }
}

/**
 * Handle logging a new shared hostel expense.
 * @param {SubmitEvent} event
 * @returns {void}
 */
function handleAddExpense(event) {
  event.preventDefault();
  setFormError(dom.expenseFormError, '');

  const participantIds = getSelectedParticipantIds();

  try {
    const expense = createExpense(
      {
        title: dom.expenseTitleInput.value,
        amount: dom.expenseAmountInput.value,
        category: dom.expenseCategorySelect.value,
        payerId: dom.expensePayerSelect.value,
        participantIds,
      },
      state.members
    );

    state.expenses.push(expense);
    saveStateToStorage();
    dom.expenseTitleInput.value = '';
    dom.expenseAmountInput.value = '';
    dom.expenseTitleInput.focus();
    renderAll();
    showToast(`Logged "${expense.title}" (${formatINR(expense.amount)}).`);
  } catch (err) {
    setFormError(dom.expenseFormError, err instanceof Error ? err.message : 'Unable to log expense.');
  }
}

/**
 * Handle deleting an expense from the ledger.
 * @param {string} expenseId
 * @returns {void}
 */
function handleRemoveExpense(expenseId) {
  const target = state.expenses.find((e) => e.id === expenseId);
  state.expenses = state.expenses.filter((e) => e.id !== expenseId);
  saveStateToStorage();
  setFormError(dom.memberFormError, '');
  renderAll();
  if (target) {
    showToast(`Deleted "${target.title}".`);
  }
}

/**
 * Copy text to clipboard with fallback for non-secure contexts.
 * @param {string} text - Plain text to copy.
 * @returns {Promise<boolean>} True if copy succeeded.
 */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/**
 * Copy WhatsApp-ready simplified settlement summary to the clipboard.
 * @returns {Promise<void>}
 */
async function handleCopySummary() {
  const transfers = simplifyDebts(state.members, state.expenses);
  const totalPaise = state.expenses.reduce((sum, exp) => sum + (exp.amountPaise || 0), 0);
  const summary = formatSettlementSummary(transfers, Number((totalPaise / 100).toFixed(2)));
  const copied = await copyTextToClipboard(summary);

  if (copied) {
    showToast('Copied settlement summary for WhatsApp!');
  } else {
    showToast('Could not access clipboard automatically.');
  }
}

/**
 * Populate realistic Thapar University hostel sample data for quick evaluation.
 * @returns {void}
 */
function loadDemoScenario() {
  const members = [
    createMember({ id: 'mem_aayush', name: 'Aayush', upiId: 'aayush@okicici' }),
    createMember({ id: 'mem_rohan', name: 'Rohan', upiId: 'rohan.thapar@oksbi' }),
    createMember({ id: 'mem_kabir', name: 'Kabir', upiId: 'kabir22@okhdfcbank' }),
    createMember({ id: 'mem_mehak', name: 'Mehak', upiId: 'mehak@okaxis' }),
  ];

  const allIds = members.map((m) => m.id);
  const expenses = [
    createExpense(
      {
        title: 'COS Night Canteen Maggi & Chai',
        amount: 320,
        category: 'Food / Mess',
        payerId: 'mem_aayush',
        participantIds: allIds,
      },
      members
    ),
    createExpense(
      {
        title: 'Swiggy Late Night Pizza',
        amount: 760,
        category: 'Food / Mess',
        payerId: 'mem_rohan',
        participantIds: allIds,
      },
      members
    ),
    createExpense(
      {
        title: 'Patiala Station Auto',
        amount: 240,
        category: 'Travel / Auto',
        payerId: 'mem_kabir',
        participantIds: ['mem_aayush', 'mem_rohan', 'mem_kabir'],
      },
      members
    ),
    createExpense(
      {
        title: 'Hostel J Water & Snacks Groceries',
        amount: 450,
        category: 'Groceries',
        payerId: 'mem_aayush',
        participantIds: ['mem_aayush', 'mem_kabir', 'mem_mehak'],
      },
      members
    ),
    createExpense(
      {
        title: 'Sips & Bites Cold Coffee',
        amount: 100,
        category: 'Food / Mess',
        payerId: 'mem_mehak',
        participantIds: ['mem_aayush', 'mem_rohan', 'mem_mehak'],
      },
      members
    ),
  ];

  state.members = members;
  state.expenses = expenses;
  state.filters = { query: '', category: 'ALL' };
  dom.expenseSearchInput.value = '';
  dom.filterCategorySelect.value = 'ALL';

  saveStateToStorage();
  setFormError(dom.memberFormError, '');
  setFormError(dom.expenseFormError, '');
  renderAll();
  showToast('Loaded Thapar Hostel demo scenario.');
}

/**
 * Clear all roommates and expenses from state and localStorage.
 * @returns {void}
 */
function resetAllData() {
  state.members = [];
  state.expenses = [];
  state.filters = { query: '', category: 'ALL' };
  dom.expenseSearchInput.value = '';
  dom.filterCategorySelect.value = 'ALL';
  saveStateToStorage();
  setFormError(dom.memberFormError, '');
  setFormError(dom.expenseFormError, '');
  renderAll();
  showToast('Cleared all hostel roster and expense data.');
}

/**
 * Toggle all participant checkboxes on or off.
 * @param {boolean} checked - Target checked state.
 * @returns {void}
 */
function setAllParticipantsChecked(checked) {
  const inputs = dom.participantsCheckboxes.querySelectorAll('input[type="checkbox"]');
  for (const input of inputs) {
    input.checked = checked;
  }
  updateSplitPreview();
}

/**
 * Register all DOM event listeners including debounced search and modal Escape handling.
 * @returns {void}
 */
function bindEvents() {
  dom.memberForm.addEventListener('submit', handleAddMember);
  dom.expenseForm.addEventListener('submit', handleAddExpense);

  dom.memberList.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action="remove-member"]');
    if (target && target.dataset.memberId) {
      handleRemoveMember(target.dataset.memberId);
    }
  });

  dom.expenseList.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action="remove-expense"]');
    if (target && target.dataset.expenseId) {
      handleRemoveExpense(target.dataset.expenseId);
    }
  });

  dom.expenseAmountInput.addEventListener('input', updateSplitPreview);
  dom.participantsCheckboxes.addEventListener('change', updateSplitPreview);
  dom.selectAllParticipantsBtn.addEventListener('click', () => setAllParticipantsChecked(true));
  dom.clearParticipantsBtn.addEventListener('click', () => setAllParticipantsChecked(false));

  const applyDebouncedFilters = debounce(() => {
    state.filters.query = dom.expenseSearchInput.value;
    state.filters.category = dom.filterCategorySelect.value;
    renderExpenseLedger();
  }, FILTER_DEBOUNCE_MS);

  dom.expenseSearchInput.addEventListener('input', applyDebouncedFilters);
  dom.filterCategorySelect.addEventListener('change', applyDebouncedFilters);

  dom.copySummaryBtn.addEventListener('click', () => {
    void handleCopySummary();
  });

  dom.loadDemoBtn.addEventListener('click', () => {
    if (state.members.length === 0 && state.expenses.length === 0) {
      loadDemoScenario();
      return;
    }
    openConfirmDialog({
      title: 'Load Demo Data?',
      message: 'This will replace your current roommates and expenses with the Thapar hostel sample scenario.',
      confirmLabel: 'Load Demo',
      triggerEl: dom.loadDemoBtn,
      onConfirm: loadDemoScenario,
    });
  });

  dom.resetAllBtn.addEventListener('click', () => {
    if (state.members.length === 0 && state.expenses.length === 0) {
      showToast('Nothing to reset — ledger is already empty.');
      return;
    }
    openConfirmDialog({
      title: 'Reset All Data?',
      message: 'This permanently deletes all roommates and logged expenses stored in this browser.',
      confirmLabel: 'Reset Everything',
      triggerEl: dom.resetAllBtn,
      onConfirm: resetAllData,
    });
  });

  dom.confirmCancelBtn.addEventListener('click', closeConfirmDialog);
  dom.confirmAcceptBtn.addEventListener('click', () => {
    const callback = pendingConfirmCallback;
    closeConfirmDialog();
    if (callback) {
      callback();
    }
  });

  dom.confirmDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeConfirmDialog();
  });

  dom.confirmDialog.addEventListener('click', (event) => {
    if (event.target === dom.confirmDialog) {
      closeConfirmDialog();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dom.confirmDialog.hasAttribute('open')) {
      event.preventDefault();
      closeConfirmDialog();
    }
  });
}

/**
 * Bootstrap HostelSplit on initial page load.
 * @returns {void}
 */
function init() {
  loadStateFromStorage();
  bindEvents();
  renderAll();
}

init();
