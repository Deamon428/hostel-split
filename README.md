# HostelSplit

**HostelSplit** is a zero-backend, 100% client-side expense splitter designed for **Thapar University** hostel roommates and campus friend groups. Split COS Night Canteen runs, late-night Swiggy orders, Patiala railway station autos, and shared groceries—then simplify group debts into the minimum number of transfers with one-tap **UPI deep links**.

---

## Campus Problem Solved

In hostel life, a single weekend generates dozens of small, overlapping IOUs across 4–8 roommates:
- One person pays for **COS Night Canteen**, another covers **Swiggy Pizza**, a third pays the **Patiala Station Auto**, and someone else grabs **Hostel Groceries**.
- Settling every expense pairwise creates $O(N^2)$ redundant UPI transfers, cluttered WhatsApp threads, and rounding headaches on odd bills (e.g., ₹100 split 3 ways).

HostelSplit eliminates the chaos by:
1. Reconciling every split down to the **exact paisa** (no floating-point drift).
2. Cancelling circular debts automatically ($A \to B \to C \to A = 0$ transfers).
3. Generating valid `upi://pay` deep links and a WhatsApp-ready summary.

---

## Greedy Min-Cash-Flow Algorithm — $O(N \log N)$

Inside [`js/core.js`](./js/core.js), `simplifyDebts(members, expenses)` reduces raw expenses to a minimal settlement graph:

1. **Exact Paise Net Balance Calculation**:
   Every INR amount is converted to integer paise (`Math.round(amount * 100)`). For each expense, `calculateEqualSplit` divides total paise across $k$ participants (`base = floor(total / k)`, distributing the remainder `total % k` as $+1$ paisa each to the earliest participants) so shares always sum to the exact total.
   For each roommate $i$:
   $$\text{net}_i = \text{paid}_i - \text{owed}_i$$
   Because every expense adds $+T$ to the payer and $-T$ across participants, $\sum_i \text{net}_i = 0$ is strictly conserved.

2. **Max-Heap Greedy Matching ($O(N \log N)$)**:
   - Roommates with $\text{net}_i < 0$ (net debtors) are inserted into a binary **MaxHeap** (`debtors`).
   - Roommates with $\text{net}_i > 0$ (net creditors) are inserted into a binary **MaxHeap** (`creditors`).
   - At each step, the algorithm pops the largest debtor and largest creditor, settles $\min(\text{debt}, \text{credit})$, emits one transfer `{ from, to, amount, upiLink }`, and pushes any non-zero remainder back into its heap.
   - Each of the at most $N$ steps performs $O(\log N)$ heap operations, yielding **$O(N \log N)$** time complexity and at most **$N - 1$** transfers (often far fewer when balances cancel).

---

## Zero-Backend Privacy Model

- **No servers, no telemetry, no accounts**: All calculations run locally in your browser's JavaScript engine.
- **Local persistence**: Roommates and expenses are stored solely in browser `localStorage` under the versioned key `hostel_split_v1`.
- **Resilient rehydration**: `rehydrateState()` validates and sanitizes loaded storage data on startup so corrupted or tampered entries never crash the application.

---

## Security Hardening

- **Strict Content Security Policy (CSP)**: `<meta http-equiv="Content-Security-Policy">` restricts `default-src 'self'`, forbids inline scripts (`script-src 'self' https://cdn.tailwindcss.com` with zero `'unsafe-inline'` or `'unsafe-eval'`), blocks plugins (`object-src 'none'`), and locks `base-uri 'self'` and `form-action 'self'`.
- **XSS Prevention**: `js/app.js` constructs DOM nodes with `document.createElement` and assigns all user-entered names, expense titles, and UPI IDs via `textContent` (never `innerHTML`). `js/core.js` also exports `escapeHTML(str)` to neutralize HTML meta-characters (`&`, `<`, `>`, `"`, `'`).
- **Strict Input Validation**:
  - UPI IDs are validated against `^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$`.
  - Amounts must be finite positive numbers ($\ge ₹0.01$).
  - Duplicate roommate names (case-insensitive) and empty participant lists are rejected with clear inline errors.
  - `buildUpiLink` strictly URI-encodes query parameters (`pa`, `pn`, `am`, `cu=INR`, `tn`).

---

## Accessibility (WCAG 2.1 AA)

- Semantic HTML5 landmarks: `<header>`, `<main>`, `<section>`, `<footer>`, plus a keyboard skip-link (`Skip to main content`).
- Explicit `<label for="...">` pairing for every `<input>` and `<select>`, plus `<fieldset>`/`<legend>` for split participant checkboxes.
- Descriptive `aria-label` attributes on all delete, copy, and UPI payment action controls.
- Polite live announcements (`aria-live="polite"`) on the group KPI summary strip, simplified settlements panel, and toast notifications.
- Accessible native `<dialog>` confirmation modal with `Escape` key dismissal and focus restoration.
- High-contrast light palette and visible `:focus-visible` outlines (`3px solid #4338ca`).

---

## Project Structure

```text
hostel-split/
├── .gitignore
├── package.json
├── README.md
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── core.js
│   └── app.js
└── tests/
    └── core.test.js
```

---

## Running Locally & Running Tests

### Run the Automated Unit Test Suite
Requires Node.js v18+ (uses native `node:test` and `node:assert/strict` with zero npm dependencies):

```bash
npm test
```

### Run the Web App Locally
Because the app uses ES modules (`<script type="module">`), serve the directory with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

