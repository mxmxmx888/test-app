const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildTotals, createApp, sanitizeState, storageKey } = require("./script.js");

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

  const nodes = {
    authScreen,
    appScreen,
    loginForm,
    loginEmail,
    loginPassword,
    budgetInput,
    applyBudgetButton,
    resetDataButton,
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
  assert.deepEqual(sanitized.expenses, [{ name: "Valid", category: "Food", amount: 50 }]);
  assert.deepEqual(sanitized.session, {
    email: "alex@example.com",
    isAuthenticated: true,
  });
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
    { name: "Bills", category: "Utilities", amount: 200 },
    { name: "Travel", category: "Transport", amount: 120 },
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

  assert.deepEqual(app.state.expenses, [{ name: "Coffee", category: "Food", amount: 4.5 }]);
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
  assert.ok(nodes.expenseList.innerHTML.indexOf("Rent") < nodes.expenseList.innerHTML.indexOf("Snacks"));
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
    "@keyframes rise-in",
    "@keyframes bar-grow",
  ].forEach((token) => {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  assert.match(css, /@media \(max-width: 920px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
});
