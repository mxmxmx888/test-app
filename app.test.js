const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildTotals,
  createApp,
  defaultCategory,
  demoExpenses,
  sanitizeState,
  sessionStorageKey,
  storageKey,
} = require("./script.js");

class MockClassList {
  constructor() {
    this.names = new Set();
  }

  toggle(name, force) {
    if (force) {
      this.names.add(name);
      return true;
    }

    this.names.delete(name);
    return false;
  }

  contains(name) {
    return this.names.has(name);
  }
}

class MockElement {
  constructor(id, initialValue = "") {
    this.id = id;
    this.value = initialValue;
    this.innerHTML = "";
    this.textContent = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new MockClassList();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
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
  const userBadge = new MockElement("userBadge");
  const logoutButton = new MockElement("logoutButton");
  const budgetInput = new MockElement("budgetInput");
  const applyBudgetButton = new MockElement("applyBudgetButton");
  const resetDataButton = new MockElement("resetDataButton");
  const expenseName = new MockElement("expenseName");
  const expenseCategory = new MockElement("expenseCategory", defaultCategory);
  const expenseAmount = new MockElement("expenseAmount");
  const statsGrid = new MockElement("statsGrid");
  const categoryChart = new MockElement("categoryChart");
  const chartCaption = new MockElement("chartCaption");
  const insightsList = new MockElement("insightsList");
  const expenseList = new MockElement("expenseList");
  const ledgerCaption = new MockElement("ledgerCaption");

  const loginForm = new MockFormElement("loginForm", {
    loginEmail,
    loginPassword,
  });

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
    userBadge,
    logoutButton,
    budgetInput,
    applyBudgetButton,
    resetDataButton,
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

test("sanitizeState removes malformed and non-positive expenses", () => {
  const sanitized = sanitizeState({
    budget: 600,
    expenses: [
      { name: " Valid ", category: " Food ", amount: 50 },
      { name: "  ", category: "Food", amount: 20 },
      { name: "Bad amount", category: "Food", amount: 0 },
      { name: "Bad category", category: "", amount: 10 },
      { category: "Food", amount: 10 },
    ],
  });

  assert.equal(sanitized.budget, 600);
  assert.deepEqual(sanitized.expenses, [{ name: "Valid", category: "Food", amount: 50 }]);
});

test("app boot loads demo data when storage is empty", () => {
  const { app, nodes, storage } = createInitializedApp();

  assert.equal(app.state.budget, 2500);
  assert.equal(app.state.expenses.length, demoExpenses.length);
  assert.match(nodes.chartCaption.textContent, /categories are currently contributing/);
  assert.match(nodes.ledgerCaption.textContent, /7 expense entries totalling/);
  assert.ok(nodes.statsGrid.innerHTML.includes("Total spent"));

  const persisted = JSON.parse(storage.getItem(storageKey));
  assert.equal(persisted.expenses.length, demoExpenses.length);
});

test("hydrate falls back to demo data when stored JSON is invalid", () => {
  const { app } = createInitializedApp({ [storageKey]: "{bad json" });

  assert.equal(app.state.budget, 2500);
  assert.equal(app.state.expenses.length, demoExpenses.length);
});

test("hydrate keeps valid saved data and filters invalid expense rows", () => {
  const storedState = {
    budget: 900,
    expenses: [
      { name: "Bills", category: "Utilities", amount: 200 },
      { name: "Ghost", category: "Other", amount: 0 },
      { name: "Travel", category: "Transport", amount: 120 },
    ],
  };

  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify(storedState),
  });

  assert.equal(app.state.budget, 900);
  assert.deepEqual(app.state.expenses, [
    { name: "Bills", category: "Utilities", amount: 200 },
    { name: "Travel", category: "Transport", amount: 120 },
  ]);
  assert.match(nodes.ledgerCaption.textContent, /2 expense entries totalling £320/);
  assert.ok(nodes.expenseList.innerHTML.includes("Bills"));
});

test("setting budget accepts valid numbers and clamps invalid input to zero", () => {
  const { app, nodes } = createInitializedApp();

  nodes.budgetInput.value = "1800";
  nodes.applyBudgetButton.click();
  assert.equal(app.state.budget, 1800);

  nodes.budgetInput.value = "-20";
  nodes.applyBudgetButton.click();
  assert.equal(app.state.budget, 0);
  assert.match(nodes.insightsList.innerHTML, /Daily pacing/);
});

test("submitting expense trims fields, rejects invalid rows, and resets form fields", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({ budget: 400, expenses: [] }),
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
  assert.equal(nodes.expenseCategory.value, defaultCategory);
  assert.match(nodes.expenseList.innerHTML, /Coffee/);
});

test("ledger sorts expenses by amount and over-budget insight is shown", () => {
  const { nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 100,
      expenses: [
        { name: "Snacks", category: "Food", amount: 25 },
        { name: "Rent", category: "Housing", amount: 120 },
        { name: "Bus", category: "Transport", amount: 10 },
      ],
    }),
  });

  assert.ok(nodes.expenseList.innerHTML.indexOf("Rent") < nodes.expenseList.innerHTML.indexOf("Snacks"));
  assert.match(nodes.insightsList.innerHTML, /Your expenses exceed the budget/);
  assert.match(nodes.statsGrid.innerHTML, /You are over budget/);
});

test("reset clears expenses while preserving the default budget baseline", () => {
  const { app, nodes } = createInitializedApp({
    [storageKey]: JSON.stringify({
      budget: 100,
      expenses: [{ name: "Rent", category: "Housing", amount: 70 }],
    }),
  });

  nodes.resetDataButton.click();

  assert.equal(app.state.budget, 2500);
  assert.deepEqual(app.state.expenses, []);
  assert.match(nodes.expenseList.innerHTML, /No expenses added yet/);
});

test("login and logout toggle the auth views and persist the session", () => {
  const { app, nodes, storage } = createInitializedApp();

  assert.equal(nodes.authScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), false);

  nodes.loginEmail.value = "alex@example.com";
  nodes.loginPassword.value = "password";
  nodes.loginForm.submit();

  assert.equal(app.session.user, "alex@example.com");
  assert.equal(nodes.authScreen.classList.contains("is-visible"), false);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.userBadge.textContent, "alex");
  assert.deepEqual(JSON.parse(storage.getItem(sessionStorageKey)), {
    user: "alex@example.com",
  });

  nodes.logoutButton.click();

  assert.equal(app.session.user, null);
  assert.equal(nodes.authScreen.classList.contains("is-visible"), true);
  assert.equal(nodes.appScreen.classList.contains("is-visible"), false);
});

test("index.html exposes the current auth and dashboard shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  [
    "authScreen",
    "loginForm",
    "loginEmail",
    "loginPassword",
    "appScreen",
    "userBadge",
    "logoutButton",
    "budgetInput",
    "applyBudgetButton",
    "resetDataButton",
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
  ].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`));
  });

  assert.match(html, /<title>Budget Lens<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css"/);
  assert.match(html, /<script src="\.\/script\.js"><\/script>/);
  assert.match(html, /<option>Savings<\/option>/);
});

test("styles.css keeps design tokens and responsive layout rules", () => {
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");

  [
    "--bg",
    "--panel",
    "--accent",
    ".auth-layout",
    ".hero",
    ".dashboard",
    ".stats-grid",
    ".chart-row",
    ".empty-state",
  ].forEach((token) => {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  assert.match(css, /@media \(max-width: 920px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
});
