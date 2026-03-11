const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildTotals,
  categorizeStatementExpense,
  createApp,
  parseCsv,
  parseStatementCsv,
  parseStatementXlsxParts,
  parseSharedStringsXml,
  parseWorksheetXml,
  sanitizeState,
  storageKey,
} = require("./script.js");

class MockClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(className, force) {
    if (force) {
      this.values.add(className);
      return true;
    }

    this.values.delete(className);
    return false;
  }

  contains(className) {
    return this.values.has(className);
  }
}

class MockElement {
  constructor(id, initialValue = "") {
    this.id = id;
    this.value = initialValue;
    this.innerHTML = "";
    this.textContent = "";
    this.listeners = new Map();
    this.classList = new MockClassList();
    this.attributes = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  click() {
    const handler = this.listeners.get("click");
    if (handler) {
      handler({ preventDefault() {} });
    }
  }

  submit() {
    const handler = this.listeners.get("submit");
    if (handler) {
      handler({ preventDefault() {} });
    }
  }
}

class MockFormElement extends MockElement {
  constructor(id, fields) {
    super(id);
    this.fields = fields;
  }

  reset() {
    Object.values(this.fields).forEach((field) => {
      field.value = "";
    });
  }
}

function createStorage(seed = {}) {
  const data = new Map(Object.entries(seed));

  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

function createMockDom() {
  const authScreen = new MockElement("authScreen");
  const appScreen = new MockElement("appScreen");
  const loginEmail = new MockElement("loginEmail");
  const loginPassword = new MockElement("loginPassword");
  const loginForm = new MockFormElement("loginForm", {
    loginEmail,
    loginPassword,
  });
  const budgetInput = new MockElement("budgetInput");
  const applyBudgetButton = new MockElement("applyBudgetButton");
  const resetDataButton = new MockElement("resetDataButton");
  const statementFile = new MockElement("statementFile");
  statementFile.files = [];
  const statementStatus = new MockElement("statementStatus");
  const logoutButton = new MockElement("logoutButton");
  const userBadge = new MockElement("userBadge");
  const expenseName = new MockElement("expenseName");
  const expenseCategory = new MockElement("expenseCategory", "Housing");
  const expenseAmount = new MockElement("expenseAmount");
  const statsGrid = new MockElement("statsGrid");
  const categoryChart = new MockElement("categoryChart");
  const chartCaption = new MockElement("chartCaption");
  const insightsList = new MockElement("insightsList");
  const expenseList = new MockElement("expenseList");
  const ledgerCaption = new MockElement("ledgerCaption");
  const expenseForm = new MockFormElement("expenseForm", {
    expenseName,
    expenseCategory,
    expenseAmount,
  });
  const statementForm = new MockFormElement("statementForm", {
    statementFile,
  });

  const nodes = {
    authScreen,
    appScreen,
    loginForm,
    loginEmail,
    loginPassword,
    budgetInput,
    applyBudgetButton,
    resetDataButton,
    statementForm,
    statementFile,
    statementStatus,
    logoutButton,
    userBadge,
    expenseForm,
    expenseName,
    expenseCategory,
    expenseAmount,
    statsGrid,
    categoryChart,
    chartCaption,
    insightsList,
    expenseList,
    ledgerCaption,
  };

  return {
    document: {
      querySelector(selector) {
        return nodes[selector.slice(1)] ?? null;
      },
    },
    nodes,
  };
}

function createInitializedApp(seed = {}) {
  const { document, nodes } = createMockDom();
  const storage = createStorage(seed);
  const app = createApp({ document, storage });
  app.init();
  return { app, nodes, storage };
}

test("buildTotals aggregates spend, ratios, and category ordering", () => {
  const totals = buildTotals({
    budget: 200,
    expenses: [
      { name: "Rent", category: "Housing", amount: 100 },
      { name: "Lunch", category: "Food", amount: 25 },
      { name: "Fuel", category: "Transport", amount: 50 },
      { name: "Dinner", category: "Food", amount: 25 },
    ],
  });

  assert.equal(totals.totalSpent, 200);
  assert.equal(totals.remaining, 0);
  assert.equal(totals.spentRatio, 1);
  assert.equal(totals.averageExpense, 50);
  assert.deepEqual(totals.topCategory, ["Housing", 100]);
  assert.deepEqual(totals.sortedCategories, [
    ["Housing", 100],
    ["Food", 50],
    ["Transport", 50],
  ]);
});

test("sanitizeState removes malformed expenses and preserves session info", () => {
  const sanitized = sanitizeState({
    budget: 600,
    expenses: [
      { name: "Valid", category: "Food", amount: 50 },
      { name: "  ", category: "Food", amount: 20 },
      { name: "Bad amount", category: "Food", amount: 0 },
      { name: "Bad category", category: "", amount: 10 },
      { category: "Food", amount: 10 },
    ],
    session: {
      email: "alex@example.com",
      isAuthenticated: true,
    },
  });

  assert.equal(sanitized.budget, 600);
  assert.deepEqual(sanitized.expenses, [
    { name: "Valid", category: "Food", amount: 50, date: "", source: "manual" },
  ]);
  assert.deepEqual(sanitized.session, {
    email: "alex@example.com",
    isAuthenticated: true,
  });
  assert.equal(sanitized.expenses[0].source, "manual");
  assert.equal(sanitized.expenses[0].date, "");
});

test("parseCsv supports quoted values", () => {
  const rows = parseCsv('Date,Description,Amount\n2026-02-03,"TESCO, SUPERSTORE",-42.10');

  assert.deepEqual(rows, [
    ["Date", "Description", "Amount"],
    ["2026-02-03", "TESCO, SUPERSTORE", "-42.10"],
  ]);
});

test("parseStatementCsv extracts outgoing transactions from common amount-based statements", () => {
  const expenses = parseStatementCsv(
    "Date,Description,Amount\n2026-02-03,TESCO STORES,-42.10\n2026-02-04,SALARY,2500\n2026-02-05,UBER,-14.22"
  );

  assert.deepEqual(expenses, [
    {
      name: "TESCO STORES",
      category: "Food",
      amount: 42.1,
      date: "2026-02-03",
      source: "statement",
    },
    {
      name: "UBER",
      category: "Transport",
      amount: 14.22,
      date: "2026-02-05",
      source: "statement",
    },
  ]);
});

test("parseStatementCsv handles revolut-style exports with completed dates and state filtering", () => {
  const expenses = parseStatementCsv(
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCard Payment,Current,2026-01-31 19:48:40,2026-02-01 07:30:04,Sainsbury's,-39.90,0.00,GBP,COMPLETED,1057.82\nTopup,Current,2026-02-04 17:59:03,2026-02-04 17:59:03,Payment from BYELKO S,200.00,0.00,GBP,COMPLETED,775.46\nCard Payment,Current,2026-02-25 16:51:50,,Bolt,-2.18,0.00,GBP,REVERTED,\nTransfer,Current,2026-02-04 22:53:54,2026-02-04 22:53:55,To Liucija Balciute,-30.00,0.00,GBP,COMPLETED,745.46"
  );

  assert.deepEqual(expenses, [
    {
      name: "Sainsbury's",
      category: "Food",
      amount: 39.9,
      date: "2026-02-01 07:30:04",
      source: "statement",
    },
    {
      name: "To Liucija Balciute",
      category: "Other",
      amount: 30,
      date: "2026-02-04 22:53:55",
      source: "statement",
    },
  ]);
});

test("parseStatementCsv extracts debit-column statements", () => {
  const expenses = parseStatementCsv(
    "Posted Date,Details,Debit,Credit\n2026-02-03,Netflix,10.99,\n2026-02-04,Savings pot,,200"
  );

  assert.deepEqual(expenses, [
    {
      name: "Netflix",
      category: "Entertainment",
      amount: 10.99,
      date: "2026-02-03",
      source: "statement",
    },
  ]);
});

test("parseSharedStringsXml and parseWorksheetXml extract spreadsheet rows", () => {
  const sharedStrings = parseSharedStringsXml(
    '<sst><si><t>Date</t></si><si><t>Description</t></si><si><t>Amount</t></si><si><t>TESCO STORES</t></si></sst>'
  );
  const rows = parseWorksheetXml(
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2"><v>45321</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-12.34</v></c></row></sheetData></worksheet>',
    sharedStrings
  );

  assert.deepEqual(rows, [
    ["Date", "Description", "Amount"],
    ["45321", "TESCO STORES", "-12.34"],
  ]);
});

test("parseStatementXlsxParts extracts outgoing transactions from worksheet xml", () => {
  const parts = new Map([
    [
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/sharedStrings.xml",
      '<sst><si><t>Date</t></si><si><t>Description</t></si><si><t>Amount</t></si><si><t>TESCO STORES</t></si><si><t>SALARY</t></si></sst>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2"><v>45321</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-12.34</v></c></row><row r="3"><c r="A3"><v>45322</v></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>2500</v></c></row></sheetData></worksheet>',
    ],
  ]);

  assert.deepEqual(parseStatementXlsxParts(parts), [
    {
      name: "TESCO STORES",
      category: "Food",
      amount: 12.34,
      date: "2024-01-30",
      source: "statement",
    },
  ]);
});

test("categorizeStatementExpense maps merchants to useful categories", () => {
  assert.equal(categorizeStatementExpense("TESCO STORES 123"), "Food");
  assert.equal(categorizeStatementExpense("UBER TRIP"), "Transport");
  assert.equal(categorizeStatementExpense("Unknown Merchant"), "Other");
});

test("app boot starts logged out with no expenses when storage is empty", () => {
  const { app, nodes, storage } = createInitializedApp();

  assert.equal(app.state.budget, 2500);
  assert.deepEqual(app.state.expenses, []);
  assert.equal(app.state.session.isAuthenticated, false);
  assert.match(nodes.insightsList.innerHTML, /Your month starts clean/);
  assert.match(nodes.ledgerCaption.textContent, /0 expense entries totalling £0/);
  assert.equal(nodes.authScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), false);

  const persisted = JSON.parse(storage.getItem(storageKey));
  assert.deepEqual(persisted.expenses, []);
});

test("login moves the user to the app screen and persists session state", () => {
  const { app, nodes, storage } = createInitializedApp();

  nodes.loginEmail.value = "alex@example.com";
  nodes.loginPassword.value = "secret";
  nodes.loginForm.submit();

  assert.equal(app.state.session.isAuthenticated, true);
  assert.equal(app.state.session.email, "alex@example.com");
  assert.equal(nodes.authScreen.classList.contains("is-visible"), false);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.userBadge.textContent, "alex@example.com");

  const persisted = JSON.parse(storage.getItem(storageKey));
  assert.equal(persisted.session.isAuthenticated, true);
});

test("hydrate keeps valid saved data and session info", () => {
  const storedState = {
    budget: 900,
    expenses: [
      { name: "Bills", category: "Utilities", amount: 200 },
      { name: "Ghost", category: "Other", amount: 0 },
      { name: "Travel", category: "Transport", amount: 120 },
    ],
    session: {
      email: "saved@example.com",
      isAuthenticated: true,
    },
  };

  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify(storedState),
  });

  assert.equal(app.state.budget, 900);
  assert.deepEqual(app.state.expenses, [
    { name: "Bills", category: "Utilities", amount: 200, date: "", source: "manual" },
    { name: "Travel", category: "Transport", amount: 120, date: "", source: "manual" },
  ]);
  assert.equal(app.state.session.email, "saved@example.com");
  assert.match(nodes.ledgerCaption.textContent, /2 expense entries totalling £320/);
  assert.ok(nodes.expenseList.innerHTML.includes("Bills"));
  assert.equal(nodes.appScreen.classList.contains("is-visible"), true);
});

test("setting budget accepts valid numbers and clamps invalid input to zero", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 2500,
      expenses: [],
      session: { email: "alex@example.com", isAuthenticated: true },
    }),
  });

  nodes.budgetInput.value = "1800";
  nodes.applyBudgetButton.click();
  assert.equal(app.state.budget, 1800);

  nodes.budgetInput.value = "-20";
  nodes.applyBudgetButton.click();
  assert.equal(app.state.budget, 0);
});

test("submitting expense trims name, rejects invalid rows, and resets form fields", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 400,
      expenses: [],
      session: { email: "alex@example.com", isAuthenticated: true },
    }),
  });

  nodes.expenseName.value = "   ";
  nodes.expenseAmount.value = "50";
  nodes.expenseForm.submit();
  assert.equal(app.state.expenses.length, 0);

  nodes.expenseName.value = " Coffee ";
  nodes.expenseCategory.value = "Food";
  nodes.expenseAmount.value = "4.5";
  nodes.expenseForm.submit();

  assert.deepEqual(app.state.expenses, [
    { name: "Coffee", category: "Food", amount: 4.5, date: "", source: "manual" },
  ]);
  assert.equal(nodes.expenseName.value, "");
  assert.equal(nodes.expenseAmount.value, "");
  assert.equal(nodes.expenseCategory.value, "Housing");
  assert.match(nodes.expenseList.innerHTML, /Coffee/);
});

test("ledger sorts expenses by amount and over-budget insight is shown", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 100,
      expenses: [
        { name: "Snacks", category: "Food", amount: 25 },
        { name: "Rent", category: "Housing", amount: 120 },
        { name: "Bus", category: "Transport", amount: 10 },
      ],
      session: { email: "alex@example.com", isAuthenticated: true },
    }),
  });

  assert.equal(app.state.expenses[0].name, "Snacks");
  assert.match(nodes.expenseList.innerHTML, /Housing/);
  assert.match(nodes.expenseList.innerHTML, /Food/);
  assert.ok(nodes.expenseList.innerHTML.includes("category-accordion"));
  assert.match(nodes.insightsList.innerHTML, /Your expenses exceed the budget/);
  assert.match(nodes.statsGrid.innerHTML, /You are over budget/);
});

test("reset data clears expenses and preserves access to the app", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 600,
      expenses: [{ name: "Bills", category: "Utilities", amount: 120 }],
      session: { email: "alex@example.com", isAuthenticated: true },
    }),
  });

  nodes.resetDataButton.click();

  assert.equal(app.state.budget, 2500);
  assert.deepEqual(app.state.expenses, []);
  assert.equal(app.state.session.isAuthenticated, true);
  assert.match(nodes.expenseList.innerHTML, /No expenses added yet/);
});

test("logout returns the user to the login screen", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 600,
      expenses: [],
      session: { email: "alex@example.com", isAuthenticated: true },
    }),
  });

  nodes.logoutButton.click();

  assert.equal(app.state.session.isAuthenticated, false);
  assert.equal(nodes.authScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), false);
});

test("index.html exposes login flow and app controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  const requiredIds = [
    "authScreen",
    "appScreen",
    "loginForm",
    "loginEmail",
    "loginPassword",
    "budgetInput",
    "applyBudgetButton",
    "resetDataButton",
    "statementForm",
    "statementFile",
    "statementStatus",
    "logoutButton",
    "userBadge",
    "expenseForm",
    "expenseName",
    "expenseCategory",
    "expenseAmount",
    "statsGrid",
    "categoryChart",
    "chartCaption",
    "insightsList",
    "expenseList",
    "ledgerCaption",
  ];

  requiredIds.forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`));
  });

  assert.match(html, /<title>Budget Lens<\/title>/);
  assert.match(html, /Access your dashboard/);
  assert.match(html, /Reset data/);
  assert.match(html, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(html, /<script src="\.\/script\.js"><\/script>/);
});

test("styles.css keeps animation and responsive layout rules", () => {
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

  [
    "--ease-smooth",
    ".view",
    ".auth-screen",
    ".hero",
    ".dashboard",
    ".stats-grid",
    ".import-panel",
    "@keyframes rise-in",
    "@keyframes bar-grow",
  ].forEach((token) => {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  assert.match(css, /@media \(max-width: 920px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});
