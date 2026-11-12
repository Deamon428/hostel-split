/**
 * @fileoverview Pure algorithmic, validation, UPI URI, and sanitization module for HostelSplit.
 * Zero DOM, browser, or storage dependencies — safe to run in both Node.js tests and browsers.
 */

/**
 * Supported campus expense categories.
 * @type {readonly string[]}
 */
export const EXPENSE_CATEGORIES = Object.freeze([
  'Food / Mess',
  'Travel / Auto',
  'Groceries',
  'Utilities',
  'Other',
]);

/**
 * Strict UPI Virtual Payment Address (VPA) regex pattern.
 * Matches `<handle>@<psp>` where handle is 2-256 chars and PSP is 2-64 letters.
 * @type {RegExp}
 */
export const UPI_ID_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

/**
 * Maximum single expense amount in INR (1 Crore) to guard against numeric overflow.
 * @type {number}
 */
const MAX_AMOUNT_INR = 10_000_000;

/**
 * HTML entity escape lookup table.
 * @type {Record<string, string>}
 */
const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Binary max-heap keyed by `amountPaise` with deterministic lexicographical tie-breaking on `name`.
 * Enables O(N log N) greedy min-cash-flow matching between largest debtor and largest creditor.
 */
class MaxHeap {
  /**
   * Create an empty MaxHeap.
   */
  constructor() {
    /** @type {Array<{id: string, name: string, upiId: string, amountPaise: number}>} */
    this.heap = [];
  }

  /**
   * Number of elements currently in the heap.
   * @returns {number}
   */
  get size() {
    return this.heap.length;
  }

  /**
   * Compare two heap entries; returns positive if `a` should sit higher than `b`.
   * @param {{amountPaise: number, name: string}} a
   * @param {{amountPaise: number, name: string}} b
   * @returns {number}
   */
  static compare(a, b) {
    if (a.amountPaise !== b.amountPaise) {
      return a.amountPaise - b.amountPaise;
    }
    return b.name.localeCompare(a.name);
  }

  /**
   * Insert an entry into the heap in O(log N) time.
   * @param {{id: string, name: string, upiId: string, amountPaise: number}} item
   * @returns {void}
   */
  push(item) {
    this.heap.push(item);
    this.#siftUp(this.heap.length - 1);
  }

  /**
   * Remove and return the maximum entry in O(log N) time.
   * @returns {{id: string, name: string, upiId: string, amountPaise: number} | undefined}
   */
  pop() {
    if (this.heap.length === 0) {
      return undefined;
    }
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  /**
   * Restore heap invariant upwards from index.
   * @param {number} idx
   * @returns {void}
   */
  #siftUp(idx) {
    let current = idx;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (MaxHeap.compare(this.heap[current], this.heap[parent]) <= 0) {
        break;
      }
      [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
      current = parent;
    }
  }

  /**
   * Restore heap invariant downwards from index.
   * @param {number} idx
   * @returns {void}
   */
  #siftDown(idx) {
    let current = idx;
    const length = this.heap.length;
    while (true) {
      const left = 2 * current + 1;
      const right = 2 * current + 2;
      let largest = current;

      if (left < length && MaxHeap.compare(this.heap[left], this.heap[largest]) > 0) {
        largest = left;
      }
      if (right < length && MaxHeap.compare(this.heap[right], this.heap[largest]) > 0) {
        largest = right;
      }
      if (largest === current) {
        break;
      }
      [this.heap[current], this.heap[largest]] = [this.heap[largest], this.heap[current]];
      current = largest;
    }
  }
}

/**
 * Escape untrusted characters in a string to prevent HTML/XSS injection.
 * @param {unknown} input - Raw value to sanitize.
 * @returns {string} HTML-escaped string.
 */
export function escapeHTML(input) {
  if (input === null || input === undefined) {
    return '';
  }
  return String(input).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Convert an INR rupee amount to exact integer paise to prevent floating-point drift.
 * @param {number|string} amount - Positive monetary value in INR.
 * @returns {number} Integer value in paise.
 * @throws {Error} When amount is not a finite positive number within bounds.
 */
export function toPaise(amount) {
  const numeric = typeof amount === 'string' ? Number(amount.trim()) : Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Amount must be a positive number greater than ₹0.');
  }
  if (numeric > MAX_AMOUNT_INR) {
    throw new Error(`Amount cannot exceed ₹${MAX_AMOUNT_INR.toLocaleString('en-IN')}.`);
  }
  const paise = Math.round(numeric * 100);
  if (paise <= 0) {
    throw new Error('Amount must be at least ₹0.01 (1 paisa).');
  }
  return paise;
}

/**
 * Convert integer paise back to a 2-decimal INR rupee number.
 * @param {number} paise - Integer paise value.
 * @returns {number} INR amount rounded to 2 decimal places.
 */
export function fromPaise(paise) {
  return Number((paise / 100).toFixed(2));
}

/**
 * Format an INR number using Indian numbering conventions (e.g. ₹1,250.00).
 * @param {number} amount - Amount in INR.
 * @returns {string} Formatted currency string.
 */
export function formatINR(amount) {
  const safe = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}

/**
 * Validate whether a string conforms to a valid UPI ID (VPA) format.
 * @param {unknown} upiId - Candidate UPI ID string.
 * @returns {boolean} True if valid VPA format.
 */
export function isValidUpiId(upiId) {
  if (typeof upiId !== 'string') {
    return false;
  }
  return UPI_ID_REGEX.test(upiId.trim());
}

/**
 * Validate roommate roster input before creation.
 * @param {{name?: unknown, upiId?: unknown}} input - Member details.
 * @param {Array<{id: string, name: string, upiId?: string}>} [existingMembers=[]] - Current roster.
 * @returns {{name: string, upiId: string}} Normalized member fields.
 * @throws {Error} On missing name, invalid length, duplicate name, or invalid UPI ID.
 */
export function validateMemberInput(input, existingMembers = []) {
  if (!input || typeof input !== 'object') {
    throw new Error('Member input must be an object.');
  }

  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  if (rawName.length === 0) {
    throw new Error('Roommate name is required.');
  }
  if (rawName.length > 60) {
    throw new Error('Roommate name must be 60 characters or fewer.');
  }

  const normalizedLower = rawName.toLowerCase();
  const duplicate = existingMembers.some(
    (m) => typeof m.name === 'string' && m.name.trim().toLowerCase() === normalizedLower
  );
  if (duplicate) {
    throw new Error(`A roommate named "${rawName}" already exists.`);
  }

  const rawUpi = typeof input.upiId === 'string' ? input.upiId.trim() : '';
  if (rawUpi.length > 0 && !isValidUpiId(rawUpi)) {
    throw new Error('Invalid UPI ID format (expected e.g. aayush@okicici).');
  }

  return {
    name: rawName,
    upiId: rawUpi,
  };
}

/**
 * Create a validated roommate member object.
 * @param {{id?: string, name: string, upiId?: string}} input - Member details.
 * @param {Array<{id: string, name: string, upiId?: string}>} [existingMembers=[]] - Current roster.
 * @returns {{id: string, name: string, upiId: string}} Validated member record.
 */
export function createMember(input, existingMembers = []) {
  const { name, upiId } = validateMemberInput(input, existingMembers);
  const id =
    typeof input.id === 'string' && input.id.trim().length > 0
      ? input.id.trim()
      : `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return { id, name, upiId };
}

/**
 * Determine whether a member can be safely removed without orphaning ledger entries.
 * @param {string} memberId - Target member ID.
 * @param {Array<{payerId: string, participantIds: string[]}>} [expenses=[]] - Logged expenses.
 * @returns {{allowed: boolean, reason: string}} Removal eligibility and reason if blocked.
 */
export function canRemoveMember(memberId, expenses = []) {
  const referenced = expenses.some(
    (exp) =>
      exp.payerId === memberId ||
      (Array.isArray(exp.participantIds) && exp.participantIds.includes(memberId))
  );
  if (referenced) {
    return {
      allowed: false,
      reason: 'Cannot remove a roommate who is part of existing expenses. Delete those expenses first.',
    };
  }
  return { allowed: true, reason: '' };
}

/**
 * Split an INR amount equally across participants with exact integer-paise reconciliation.
 * Any remainder paise from division are distributed +1 paisa each to the earliest participants,
 * guaranteeing that the sum of shares equals the exact total to the paisa.
 * @param {number|string} amount - Total expense amount in INR.
 * @param {string[]} participantIds - Non-empty unique array of participant member IDs.
 * @returns {Array<{participantId: string, amountPaise: number, amount: number}>} Reconciled splits.
 * @throws {Error} If amount is invalid or participantIds is empty/contains duplicates.
 */
export function calculateEqualSplit(amount, participantIds) {
  const totalPaise = toPaise(amount);

  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new Error('Select at least one participant to split the expense.');
  }

  const cleanedIds = participantIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (cleanedIds.some((id) => id.length === 0)) {
    throw new Error('All participant IDs must be non-empty strings.');
  }

  const uniqueIds = new Set(cleanedIds);
  if (uniqueIds.size !== cleanedIds.length) {
    throw new Error('Participant list contains duplicate members.');
  }

  const count = cleanedIds.length;
  const basePaise = Math.floor(totalPaise / count);
  const remainder = totalPaise % count;

  return cleanedIds.map((participantId, index) => {
    const sharePaise = basePaise + (index < remainder ? 1 : 0);
    return {
      participantId,
      amountPaise: sharePaise,
      amount: fromPaise(sharePaise),
    };
  });
}

/**
 * Validate an expense entry against the current roommate roster.
 * @param {{title?: unknown, amount?: unknown, category?: unknown, payerId?: unknown, participantIds?: unknown}} input
 * @param {Array<{id: string, name: string}>} [members=[]] - Current roster.
 * @returns {{title: string, amountPaise: number, amount: number, category: string, payerId: string, participantIds: string[]}}
 * @throws {Error} On invalid title, amount, category, unknown payer, or invalid participants.
 */
export function validateExpenseInput(input, members = []) {
  if (!input || typeof input !== 'object') {
    throw new Error('Expense input must be an object.');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    throw new Error('Expense title is required.');
  }
  if (title.length > 120) {
    throw new Error('Expense title must be 120 characters or fewer.');
  }

  const amountPaise = toPaise(input.amount);
  const category =
    typeof input.category === 'string' && EXPENSE_CATEGORIES.includes(input.category)
      ? input.category
      : null;
  if (!category) {
    throw new Error(`Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}.`);
  }

  const memberIds = new Set(members.map((m) => m.id));
  const payerId = typeof input.payerId === 'string' ? input.payerId.trim() : '';
  if (!payerId || !memberIds.has(payerId)) {
    throw new Error('Please select a valid payer from the roommate roster.');
  }

  if (!Array.isArray(input.participantIds) || input.participantIds.length === 0) {
    throw new Error('Select at least one participant for the split.');
  }

  const participantIds = [...new Set(input.participantIds.map((id) => String(id).trim()))];
  if (participantIds.some((id) => !memberIds.has(id))) {
    throw new Error('All split participants must exist in the roommate roster.');
  }

  return {
    title,
    amountPaise,
    amount: fromPaise(amountPaise),
    category,
    payerId,
    participantIds,
  };
}

/**
 * Create a validated expense object with precomputed exact paise splits.
 * @param {{id?: string, title: string, amount: number|string, category: string, payerId: string, participantIds: string[], createdAt?: string}} input
 * @param {Array<{id: string, name: string}>} [members=[]] - Current roster.
 * @returns {{id: string, title: string, amount: number, amountPaise: number, category: string, payerId: string, participantIds: string[], splits: Array<{participantId: string, amountPaise: number, amount: number}>, createdAt: string}}
 */
export function createExpense(input, members = []) {
  const normalized = validateExpenseInput(input, members);
  const splits = calculateEqualSplit(normalized.amount, normalized.participantIds);
  const id =
    typeof input.id === 'string' && input.id.trim().length > 0
      ? input.id.trim()
      : `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt =
    typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt))
      ? input.createdAt
      : new Date().toISOString();

  return {
    id,
    title: normalized.title,
    amount: normalized.amount,
    amountPaise: normalized.amountPaise,
    category: normalized.category,
    payerId: normalized.payerId,
    participantIds: normalized.participantIds,
    splits,
    createdAt,
  };
}

/**
 * Generate a standard NPCI UPI deep-link URI for one-tap mobile payment apps.
 * Format: `upi://pay?pa=<upi>&pn=<name>&am=<amount>&cu=INR&tn=<note>`
 * @param {{upiId: string, payeeName: string, amount: number|string, note?: string}} params
 * @returns {string} Encoded `upi://pay` URI.
 * @throws {Error} When UPI ID, payee name, or amount is invalid.
 */
export function buildUpiLink({ upiId, payeeName, amount, note = 'HostelSplit Settlement' }) {
  if (!isValidUpiId(upiId)) {
    throw new Error('Cannot build UPI link: invalid recipient UPI ID.');
  }

  const cleanName = typeof payeeName === 'string' ? payeeName.trim() : '';
  if (!cleanName) {
    throw new Error('Cannot build UPI link: payee name is required.');
  }

  const amountPaise = toPaise(amount);
  const formattedAmount = fromPaise(amountPaise).toFixed(2);
  const cleanNote =
    typeof note === 'string' && note.trim().length > 0
      ? note.trim().slice(0, 80)
      : 'HostelSplit Settlement';

  return (
    `upi://pay?pa=${encodeURIComponent(upiId.trim())}` +
    `&pn=${encodeURIComponent(cleanName)}` +
    `&am=${formattedAmount}` +
    `&cu=INR` +
    `&tn=${encodeURIComponent(cleanNote)}`
  );
}

/**
 * Compute per-member paid, owed, and net balance totals in integer paise and INR.
 * @param {Array<{id: string, name: string, upiId?: string}>} members - Group roster.
 * @param {Array<{payerId: string, amount: number, participantIds: string[]}>} expenses - Group expenses.
 * @returns {Array<{id: string, name: string, upiId: string, paidPaise: number, owedPaise: number, netPaise: number, paid: number, owed: number, net: number}>}
 */
export function computeMemberBalances(members, expenses) {
  if (!Array.isArray(members) || members.length === 0) {
    return [];
  }

  /** @type {Map<string, {id: string, name: string, upiId: string, paidPaise: number, owedPaise: number}>} */
  const ledger = new Map();
  for (const member of members) {
    ledger.set(member.id, {
      id: member.id,
      name: member.name,
      upiId: typeof member.upiId === 'string' ? member.upiId.trim() : '',
      paidPaise: 0,
      owedPaise: 0,
    });
  }

  for (const expense of expenses || []) {
    const payer = ledger.get(expense.payerId);
    if (!payer) {
      continue;
    }

    const splits = calculateEqualSplit(expense.amount, expense.participantIds);
    const totalPaise = splits.reduce((acc, s) => acc + s.amountPaise, 0);
    payer.paidPaise += totalPaise;

    for (const split of splits) {
      const participant = ledger.get(split.participantId);
      if (participant) {
        participant.owedPaise += split.amountPaise;
      }
    }
  }

  return Array.from(ledger.values()).map((entry) => {
    const netPaise = entry.paidPaise - entry.owedPaise;
    return {
      ...entry,
      netPaise,
      paid: fromPaise(entry.paidPaise),
      owed: fromPaise(entry.owedPaise),
      net: fromPaise(netPaise),
    };
  });
}

/**
 * Simplify group debts to the minimum number of settlement transfers using an O(N log N)
 * greedy min-cash-flow algorithm backed by binary max-heaps for debtors and creditors.
 * @param {Array<{id: string, name: string, upiId?: string}>} members - Group roster.
 * @param {Array<{payerId: string, amount: number, participantIds: string[]}>} expenses - Group expenses.
 * @returns {Array<{fromId: string, from: string, toId: string, to: string, toUpiId: string, amountPaise: number, amount: number, upiLink: string|null}>}
 */
export function simplifyDebts(members, expenses) {
  const balances = computeMemberBalances(members, expenses);
  if (balances.length === 0) {
    return [];
  }

  const debtors = new MaxHeap();
  const creditors = new MaxHeap();

  for (const member of balances) {
    if (member.netPaise < 0) {
      debtors.push({
        id: member.id,
        name: member.name,
        upiId: member.upiId,
        amountPaise: -member.netPaise,
      });
    } else if (member.netPaise > 0) {
      creditors.push({
        id: member.id,
        name: member.name,
        upiId: member.upiId,
        amountPaise: member.netPaise,
      });
    }
  }

  /** @type {Array<{fromId: string, from: string, toId: string, to: string, toUpiId: string, amountPaise: number, amount: number, upiLink: string|null}>} */
  const transfers = [];

  while (debtors.size > 0 && creditors.size > 0) {
    const debtor = debtors.pop();
    const creditor = creditors.pop();
    if (!debtor || !creditor) {
      break;
    }

    const settlePaise = Math.min(debtor.amountPaise, creditor.amountPaise);
    const amount = fromPaise(settlePaise);

    const hasValidUpi = isValidUpiId(creditor.upiId);
    const upiLink = hasValidUpi
      ? buildUpiLink({
          upiId: creditor.upiId,
          payeeName: creditor.name,
          amount,
          note: `HostelSplit: ${debtor.name} to ${creditor.name}`,
        })
      : null;

    transfers.push({
      fromId: debtor.id,
      from: debtor.name,
      toId: creditor.id,
      to: creditor.name,
      toUpiId: hasValidUpi ? creditor.upiId : '',
      amountPaise: settlePaise,
      amount,
      upiLink,
    });

    const debtorRemaining = debtor.amountPaise - settlePaise;
    if (debtorRemaining > 0) {
      debtors.push({ ...debtor, amountPaise: debtorRemaining });
    }

    const creditorRemaining = creditor.amountPaise - settlePaise;
    if (creditorRemaining > 0) {
      creditors.push({ ...creditor, amountPaise: creditorRemaining });
    }
  }

  return transfers;
}

/**
 * Filter expenses by search query (title, category, or payer name) and category.
 * @param {Array<{id: string, title: string, category: string, payerId: string}>} expenses
 * @param {{query?: string, category?: string}} filters
 * @param {Map<string, {name: string}>} [memberMap=new Map()]
 * @returns {Array<object>} Matching expenses.
 */
export function filterExpenses(expenses, { query = '', category = 'ALL' } = {}, memberMap = new Map()) {
  if (!Array.isArray(expenses)) {
    return [];
  }
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const selectedCategory = typeof category === 'string' ? category : 'ALL';

  return expenses.filter((expense) => {
    if (selectedCategory !== 'ALL' && expense.category !== selectedCategory) {
      return false;
    }
    if (!needle) {
      return true;
    }
    const payerName = memberMap.get(expense.payerId)?.name?.toLowerCase() || '';
    return (
      expense.title.toLowerCase().includes(needle) ||
      expense.category.toLowerCase().includes(needle) ||
      payerName.includes(needle)
    );
  });
}

/**
 * Format simplified transfers into a clean WhatsApp-ready settlement summary message.
 * @param {Array<{from: string, to: string, amount: number, toUpiId?: string}>} transfers
 * @param {number} totalSpendINR
 * @returns {string} Shareable plain-text summary.
 */
export function formatSettlementSummary(transfers, totalSpendINR) {
  const totalText = formatINR(totalSpendINR);
  if (!Array.isArray(transfers) || transfers.length === 0) {
    return `HostelSplit Summary\nTotal Group Spend: ${totalText}\nAll roommates are settled up!`;
  }

  const lines = [
    '*HostelSplit — Settlement Summary*',
    `Total Group Spend: ${totalText}`,
    `Minimum Transfers Needed: ${transfers.length}`,
    '',
    ...transfers.map((t, idx) => {
      const upiPart = t.toUpiId ? ` (UPI: ${t.toUpiId})` : '';
      return `${idx + 1}. ${t.from} -> ${t.to}: ${formatINR(t.amount)}${upiPart}`;
    }),
  ];

  return lines.join('\n');
}

/**
 * Validate and sanitize persisted application state loaded from localStorage.
 * Discards malformed entries gracefully so corrupted storage never crashes the app.
 * @param {unknown} rawState - Parsed JSON object from localStorage.
 * @returns {{members: Array<{id: string, name: string, upiId: string}>, expenses: Array<object>}}
 */
export function rehydrateState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return { members: [], expenses: [] };
  }

  const candidateMembers = Array.isArray(rawState.members) ? rawState.members : [];
  const members = [];
  const seenMemberIds = new Set();
  for (const item of candidateMembers) {
    try {
      const created = createMember(item, members);
      if (!seenMemberIds.has(created.id)) {
        seenMemberIds.add(created.id);
        members.push(created);
      }
    } catch {
      // Skip invalid or duplicate member entries from tampered storage.
    }
  }

  const candidateExpenses = Array.isArray(rawState.expenses) ? rawState.expenses : [];
  const expenses = [];
  for (const item of candidateExpenses) {
    try {
      const created = createExpense(item, members);
      expenses.push(created);
    } catch {
      // Skip invalid or orphaned expense entries.
    }
  }

  return { members, expenses };
}
