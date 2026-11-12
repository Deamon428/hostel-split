import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUpiLink,
  calculateEqualSplit,
  canRemoveMember,
  computeMemberBalances,
  createExpense,
  createMember,
  escapeHTML,
  filterExpenses,
  formatSettlementSummary,
  isValidUpiId,
  rehydrateState,
  simplifyDebts,
  toPaise,
} from '../js/core.js';

/**
 * Helper to create a standard 4-person Thapar hostel roster.
 */
function makeRoster() {
  return [
    createMember({ id: 'a', name: 'Aayush', upiId: 'aayush@okicici' }),
    createMember({ id: 'b', name: 'Rohan', upiId: 'rohan@oksbi' }),
    createMember({ id: 'c', name: 'Kabir', upiId: 'kabir.thapar@okhdfcbank' }),
    createMember({ id: 'd', name: 'Mehak', upiId: '' }),
  ];
}

test('1. calculateEqualSplit reconciles ₹100 split 3 ways without losing a single paisa', () => {
  const splits = calculateEqualSplit(100, ['a', 'b', 'c']);
  assert.equal(splits.length, 3);
  assert.deepEqual(
    splits.map((s) => s.amount),
    [33.34, 33.33, 33.33]
  );
  const totalPaise = splits.reduce((sum, s) => sum + s.amountPaise, 0);
  assert.equal(totalPaise, 10000);
});

test('2. calculateEqualSplit reconciles ₹0.05 split 3 ways and ₹10 split 7 ways accurately', () => {
  const small = calculateEqualSplit(0.05, ['a', 'b', 'c']);
  assert.deepEqual(
    small.map((s) => s.amountPaise),
    [2, 2, 1]
  );
  assert.equal(small.reduce((sum, s) => sum + s.amountPaise, 0), 5);

  const sevenWay = calculateEqualSplit(10, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  assert.equal(sevenWay.reduce((sum, s) => sum + s.amountPaise, 0), 1000);
});

test('3. simplifyDebts cancels circular 3-person debts (A->B, B->C, C->A) to 0 transfers', () => {
  const members = [
    createMember({ id: 'a', name: 'Aayush', upiId: 'aayush@okicici' }),
    createMember({ id: 'b', name: 'Rohan', upiId: 'rohan@oksbi' }),
    createMember({ id: 'c', name: 'Kabir', upiId: 'kabir@okaxis' }),
  ];

  // A pays ₹100 for B only -> B owes A ₹100
  // B pays ₹100 for C only -> C owes B ₹100
  // C pays ₹100 for A only -> A owes C ₹100
  const expenses = [
    createExpense(
      { title: 'Canteen 1', amount: 100, category: 'Food / Mess', payerId: 'a', participantIds: ['b'] },
      members
    ),
    createExpense(
      { title: 'Canteen 2', amount: 100, category: 'Food / Mess', payerId: 'b', participantIds: ['c'] },
      members
    ),
    createExpense(
      { title: 'Canteen 3', amount: 100, category: 'Food / Mess', payerId: 'c', participantIds: ['a'] },
      members
    ),
  ];

  const transfers = simplifyDebts(members, expenses);
  assert.deepEqual(transfers, []);
});

test('4. simplifyDebts minimizes 6 raw hostel expenses into minimal transfers and conserves balances', () => {
  const members = makeRoster();
  const all = members.map((m) => m.id);

  const expenses = [
    createExpense(
      { title: 'COS Night Canteen', amount: 400, category: 'Food / Mess', payerId: 'a', participantIds: all },
      members
    ),
    createExpense(
      { title: 'Swiggy Pizza', amount: 800, category: 'Food / Mess', payerId: 'b', participantIds: all },
      members
    ),
    createExpense(
      { title: 'Patiala Station Auto', amount: 300, category: 'Travel / Auto', payerId: 'a', participantIds: ['a', 'b', 'c'] },
      members
    ),
    createExpense(
      { title: 'Jaggi Groceries', amount: 600, category: 'Groceries', payerId: 'c', participantIds: ['b', 'c', 'd'] },
      members
    ),
    createExpense(
      { title: 'Sips & Bites Coffee', amount: 200, category: 'Food / Mess', payerId: 'a', participantIds: ['a', 'd'] },
      members
    ),
    createExpense(
      { title: 'Hostel Printouts', amount: 120, category: 'Utilities', payerId: 'b', participantIds: ['a', 'b', 'c', 'd'] },
      members
    ),
  ];

  const balances = computeMemberBalances(members, expenses);
  const netSumPaise = balances.reduce((sum, b) => sum + b.netPaise, 0);
  assert.equal(netSumPaise, 0);

  const transfers = simplifyDebts(members, expenses);
  // With 4 members, at most N - 1 = 3 transfers can settle the entire 6-expense graph.
  assert.ok(transfers.length <= 3, `Expected <= 3 transfers, got ${transfers.length}`);
  assert.ok(transfers.length > 0);

  // Verify applying transfers zeroes out every member's net balance.
  const simulated = new Map(balances.map((b) => [b.id, b.netPaise]));
  for (const t of transfers) {
    simulated.set(t.fromId, simulated.get(t.fromId) + t.amountPaise);
    simulated.set(t.toId, simulated.get(t.toId) - t.amountPaise);
  }
  for (const [, remaining] of simulated) {
    assert.equal(remaining, 0);
  }
});

test('5. simplifyDebts includes valid upiLink when creditor has UPI ID and null when omitted', () => {
  const members = [
    createMember({ id: 'a', name: 'Aayush', upiId: 'aayush@okicici' }),
    createMember({ id: 'd', name: 'Mehak', upiId: '' }),
  ];

  const exp1 = [
    createExpense(
      { title: 'COS Canteen', amount: 200, category: 'Food / Mess', payerId: 'a', participantIds: ['a', 'd'] },
      members
    ),
  ];
  const t1 = simplifyDebts(members, exp1);
  assert.equal(t1.length, 1);
  assert.equal(t1[0].from, 'Mehak');
  assert.equal(t1[0].to, 'Aayush');
  assert.equal(t1[0].amount, 100);
  assert.ok(t1[0].upiLink?.startsWith('upi://pay?'));

  const exp2 = [
    createExpense(
      { title: 'Auto', amount: 200, category: 'Travel / Auto', payerId: 'd', participantIds: ['a', 'd'] },
      members
    ),
  ];
  const t2 = simplifyDebts(members, exp2);
  assert.equal(t2.length, 1);
  assert.equal(t2[0].to, 'Mehak');
  assert.equal(t2[0].upiLink, null);
});

test('6. isValidUpiId accepts valid VPAs and rejects malformed UPI IDs', () => {
  assert.equal(isValidUpiId('aayush@okicici'), true);
  assert.equal(isValidUpiId('rohan.garg_99-thapar@okhdfcbank'), true);
  assert.equal(isValidUpiId('  mehak21@ybl  '), true);

  assert.equal(isValidUpiId(''), false);
  assert.equal(isValidUpiId('a@okicici'), false); // handle < 2 chars
  assert.equal(isValidUpiId('aayush@o'), false); // PSP < 2 chars
  assert.equal(isValidUpiId('aayush@ok123'), false); // digits in PSP
  assert.equal(isValidUpiId('aayush.okicici'), false); // missing @
  assert.equal(isValidUpiId('aayush@ok@icici'), false); // multiple @
  assert.equal(isValidUpiId('aayush g@okicici'), false); // whitespace in handle
  assert.equal(isValidUpiId(null), false);
});

test('7. buildUpiLink generates properly URI-encoded upi://pay deep link', () => {
  const link = buildUpiLink({
    upiId: 'aayush.garg@okicici',
    payeeName: 'Aayush Garg',
    amount: 150.5,
    note: 'COS Maggi & Chai',
  });

  assert.ok(link.startsWith('upi://pay?'));
  const parsed = new URL(link);
  assert.equal(parsed.protocol, 'upi:');
  assert.equal(parsed.searchParams.get('pa'), 'aayush.garg@okicici');
  assert.equal(parsed.searchParams.get('pn'), 'Aayush Garg');
  assert.equal(parsed.searchParams.get('am'), '150.50');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('tn'), 'COS Maggi & Chai');
});

test('8. buildUpiLink throws on invalid UPI ID, empty payee name, or non-positive amount', () => {
  assert.throws(
    () => buildUpiLink({ upiId: 'invalid', payeeName: 'Aayush', amount: 100 }),
    /invalid recipient UPI ID/i
  );
  assert.throws(
    () => buildUpiLink({ upiId: 'aayush@okicici', payeeName: '   ', amount: 100 }),
    /payee name is required/i
  );
  assert.throws(
    () => buildUpiLink({ upiId: 'aayush@okicici', payeeName: 'Aayush', amount: 0 }),
    /positive number/i
  );
});

test('9. toPaise and calculateEqualSplit reject zero, negative, NaN, and Infinity amounts', () => {
  for (const badAmount of [0, -50, -0.01, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '']) {
    assert.throws(() => toPaise(badAmount), /positive number/i);
    assert.throws(() => calculateEqualSplit(badAmount, ['a']), /positive number/i);
  }
});

test('10. calculateEqualSplit rejects empty or duplicate participant arrays', () => {
  assert.throws(() => calculateEqualSplit(100, []), /at least one participant/i);
  assert.throws(() => calculateEqualSplit(100, ['a', 'a']), /duplicate members/i);
  assert.throws(() => calculateEqualSplit(100, ['']), /non-empty strings/i);
});

test('11. createMember rejects duplicate names (case-insensitive) and invalid UPI IDs', () => {
  const existing = [createMember({ id: 'a', name: 'Aayush', upiId: 'aayush@okicici' })];

  assert.throws(
    () => createMember({ name: '  aayush  ', upiId: '' }, existing),
    /already exists/i
  );
  assert.throws(
    () => createMember({ name: 'Rohan', upiId: 'bad-upi' }, existing),
    /Invalid UPI ID/i
  );
  assert.throws(
    () => createMember({ name: '   ', upiId: '' }, existing),
    /name is required/i
  );
});

test('12. createExpense validates title, category, payer, and participants', () => {
  const members = makeRoster();

  assert.throws(
    () =>
      createExpense(
        { title: '   ', amount: 100, category: 'Food / Mess', payerId: 'a', participantIds: ['a'] },
        members
      ),
    /title is required/i
  );

  assert.throws(
    () =>
      createExpense(
        { title: 'Pizza', amount: 100, category: 'InvalidCat', payerId: 'a', participantIds: ['a'] },
        members
      ),
    /Category must be one of/i
  );

  assert.throws(
    () =>
      createExpense(
        { title: 'Pizza', amount: 100, category: 'Food / Mess', payerId: 'unknown', participantIds: ['a'] },
        members
      ),
    /valid payer/i
  );

  assert.throws(
    () =>
      createExpense(
        { title: 'Pizza', amount: 100, category: 'Food / Mess', payerId: 'a', participantIds: [] },
        members
      ),
    /at least one participant/i
  );
});

test('13. canRemoveMember blocks deleting roommates referenced in expenses and allows unreferenced ones', () => {
  const members = makeRoster();
  const expenses = [
    createExpense(
      { title: 'Auto', amount: 90, category: 'Travel / Auto', payerId: 'a', participantIds: ['a', 'b'] },
      members
    ),
  ];

  assert.equal(canRemoveMember('a', expenses).allowed, false);
  assert.equal(canRemoveMember('b', expenses).allowed, false);
  assert.equal(canRemoveMember('c', expenses).allowed, true);
});

test('14. escapeHTML neutralizes XSS payloads including img onerror, script tags, and quotes', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const escaped = escapeHTML(payload);
  assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escaped.includes('<'), false);
  assert.equal(escaped.includes('>'), false);

  const scriptPayload = `<script>alert("xss" & 'test')</script>`;
  assert.equal(
    escapeHTML(scriptPayload),
    '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;test&#39;)&lt;/script&gt;'
  );

  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
});

test('15. filterExpenses filters accurately by search query (title/payer) and category', () => {
  const members = makeRoster();
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const expenses = [
    createExpense(
      { title: 'COS Night Canteen', amount: 250, category: 'Food / Mess', payerId: 'a', participantIds: ['a', 'b'] },
      members
    ),
    createExpense(
      { title: 'Patiala Station Auto', amount: 150, category: 'Travel / Auto', payerId: 'b', participantIds: ['a', 'b'] },
      members
    ),
    createExpense(
      { title: 'Milk & Bread', amount: 110, category: 'Groceries', payerId: 'c', participantIds: ['b', 'c'] },
      members
    ),
  ];

  assert.equal(filterExpenses(expenses, { query: 'swiggy', category: 'ALL' }, memberMap).length, 0);
  assert.equal(filterExpenses(expenses, { query: 'rohan', category: 'ALL' }, memberMap).length, 1);
  assert.equal(filterExpenses(expenses, { query: 'cos', category: 'Food / Mess' }, memberMap).length, 1);
  assert.equal(filterExpenses(expenses, { query: '', category: 'Groceries' }, memberMap).length, 1);
});

test('16. formatSettlementSummary produces clean WhatsApp-ready output for empty and active transfers', () => {
  const settledMsg = formatSettlementSummary([], 500);
  assert.match(settledMsg, /settled up/i);

  const activeMsg = formatSettlementSummary(
    [{ from: 'Rohan', to: 'Aayush', amount: 250, toUpiId: 'aayush@okicici' }],
    1000
  );
  assert.match(activeMsg, /Rohan -> Aayush/);
  assert.match(activeMsg, /aayush@okicici/);
  assert.match(activeMsg, /250\.00/);
});

test('17. rehydrateState sanitizes corrupted or tampered localStorage payloads safely', () => {
  assert.deepEqual(rehydrateState(null), { members: [], expenses: [] });
  assert.deepEqual(rehydrateState('corrupted'), { members: [], expenses: [] });

  const recovered = rehydrateState({
    members: [
      { id: 'a', name: 'Aayush', upiId: 'aayush@okicici' },
      { id: 'a', name: 'DuplicateId', upiId: '' }, // duplicate id skipped
      { id: 'bad', name: '', upiId: 'bad' }, // invalid member skipped
      { id: 'b', name: 'Rohan', upiId: '' },
    ],
    expenses: [
      { title: 'COS Chai', amount: 80, category: 'Food / Mess', payerId: 'a', participantIds: ['a', 'b'] },
      { title: 'Bad Amount', amount: -20, category: 'Food / Mess', payerId: 'a', participantIds: ['a'] },
      { title: 'Orphan Payer', amount: 50, category: 'Other', payerId: 'ghost', participantIds: ['a'] },
    ],
  });

  assert.equal(recovered.members.length, 2);
  assert.equal(recovered.expenses.length, 1);
  assert.equal(recovered.expenses[0].title, 'COS Chai');
});

test('18. simplifyDebts handles odd-paisa split + multi-expense settlement without rounding drift', () => {
  const members = [
    createMember({ id: 'a', name: 'Aayush', upiId: 'aayush@okicici' }),
    createMember({ id: 'b', name: 'Rohan', upiId: 'rohan@oksbi' }),
    createMember({ id: 'c', name: 'Kabir', upiId: 'kabir@okaxis' }),
  ];

  // Aayush pays ₹100 split 3 ways -> Aayush owes 33.34, Rohan 33.33, Kabir 33.33
  // Net: Aayush +66.66, Rohan -33.33, Kabir -33.33
  const expenses = [
    createExpense(
      { title: 'Odd Canteen Bill', amount: 100, category: 'Food / Mess', payerId: 'a', participantIds: ['a', 'b', 'c'] },
      members
    ),
  ];

  const transfers = simplifyDebts(members, expenses);
  assert.equal(transfers.length, 2);
  const totalSettledPaise = transfers.reduce((sum, t) => sum + t.amountPaise, 0);
  assert.equal(totalSettledPaise, 6666);
});

