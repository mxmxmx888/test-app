const currency = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

const storageKey = "budget-lens-state";
const categoryMatchers = [
  { category: "Housing", patterns: ["rent", "mortgage", "landlord", "property", "lettings"] },
  { category: "Food", patterns: ["tesco", "aldi", "lidl", "sainsbury", "asda", "co-op", "coop", "grocery", "grocer", "restaurant", "cafe", "coffee", "uber eats", "deliveroo", "just eat"] },
  { category: "Entertainment", patterns: ["netflix", "spotify", "cinema", "steam", "playstation", "xbox", "apple.com/bill", "entertainment"] },
  { category: "Transport", patterns: ["train", "tfl", "uber", "bolt", "shell", "esso", "petrol", "fuel", "station", "bus"] },
  { category: "Utilities", patterns: ["electric", "water", "gas", "energy", "wifi", "internet", "broadband", "council tax", "utility"] },
  { category: "Health", patterns: ["pharmacy", "dent", "doctor", "hospital", "gym", "fitness", "health"] },
  { category: "Savings", patterns: ["savings", "isa", "investment", "vanguard", "fidelity", "monzo pot"] },
];

function createInitialState() {
  return {
    budget: 2500,
    expenses: [],
    session: {
      email: "",
      isAuthenticated: false,
    },
  };
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function detectDelimiter(line) {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;

  candidates.forEach((candidate) => {
    const count = line.split(candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  });

  return best;
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  cells.push(current.trim());
  return cells;
}

function parseCsv(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim());

  if (!lines.length) {
    return [];
  }

  const delimiter = detectDelimiter(lines[0]);
  return lines.map((line) => parseCsvLine(line, delimiter));
}

function findColumnIndex(headers, aliases) {
  return headers.findIndex((header) =>
    aliases.some((alias) => header === alias || header.includes(alias))
  );
}

function parseAmountValue(rawValue) {
  if (rawValue == null) {
    return NaN;
  }

  const value = String(rawValue).trim();
  if (!value) {
    return NaN;
  }

  const cleaned = value
    .replace(/[£$,]/g, "")
    .replace(/\s+/g, "")
    .replace(/^\((.*)\)$/, "-$1");

  return Number(cleaned);
}

function categorizeStatementExpense(description) {
  const haystack = String(description || "").toLowerCase();

  const match = categoryMatchers.find((entry) =>
    entry.patterns.some((pattern) => haystack.includes(pattern))
  );

  return match ? match.category : "Other";
}

function buildStatementExpense(row, indexes, headers) {
  const description =
    row[indexes.description] ||
    row[indexes.reference] ||
    row[indexes.name] ||
    "Imported transaction";
  const date = row[indexes.date] || "";
  const type = normalizeHeader(row[indexes.type] || "");

  let amount = NaN;

  if (indexes.debit !== -1) {
    amount = Math.abs(parseAmountValue(row[indexes.debit]));
  } else if (indexes.withdrawal !== -1) {
    amount = Math.abs(parseAmountValue(row[indexes.withdrawal]));
  } else if (indexes.amount !== -1) {
    const rawAmount = parseAmountValue(row[indexes.amount]);
    const amountHeader = headers[indexes.amount] || "";

    if (Number.isFinite(rawAmount)) {
      if (amountHeader.includes("debit") || amountHeader.includes("withdraw")) {
        amount = Math.abs(rawAmount);
      } else if (amountHeader.includes("credit") || amountHeader.includes("deposit")) {
        amount = NaN;
      } else if (type.includes("debit") || type.includes("card") || type.includes("purchase") || type.includes("out")) {
        amount = Math.abs(rawAmount);
      } else if (rawAmount < 0) {
        amount = Math.abs(rawAmount);
      }
    }
  }

  if (!description.trim() || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    name: description.trim(),
    category: categorizeStatementExpense(description),
    amount,
    date: date.trim(),
    source: "statement",
  };
}

function parseStatementCsv(text) {
  const rows = parseCsv(text);

  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map(normalizeHeader);
  const indexes = {
    date: findColumnIndex(headers, ["date", "transaction date", "posted date", "booking date"]),
    description: findColumnIndex(headers, ["description", "details", "payee", "transaction", "merchant", "narrative", "memo"]),
    reference: findColumnIndex(headers, ["reference"]),
    name: findColumnIndex(headers, ["name"]),
    type: findColumnIndex(headers, ["type", "transaction type", "dr cr"]),
    debit: findColumnIndex(headers, ["debit", "money out"]),
    withdrawal: findColumnIndex(headers, ["withdrawal", "outflow"]),
    amount: findColumnIndex(headers, ["amount", "value"]),
  };

  return rows
    .slice(1)
    .map((row) => buildStatementExpense(row, indexes, headers))
    .filter(Boolean);
}

function buildTotals(state) {
  const totalSpent = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const remaining = state.budget - totalSpent;
  const spentRatio = state.budget > 0 ? totalSpent / state.budget : 0;
  const dailyBudget = state.budget / 30;
  const dailySpend = totalSpent / 30;

  const byCategory = state.expenses.reduce((accumulator, expense) => {
    accumulator[expense.category] = (accumulator[expense.category] || 0) + expense.amount;
    return accumulator;
  }, {});

  const sortedCategories = Object.entries(byCategory).sort((left, right) => right[1] - left[1]);
  const topCategory = sortedCategories[0] || ["None", 0];
  const averageExpense = state.expenses.length ? totalSpent / state.expenses.length : 0;

  return {
    totalSpent,
    remaining,
    spentRatio,
    dailyBudget,
    dailySpend,
    byCategory,
    sortedCategories,
    topCategory,
    averageExpense,
  };
}

function sanitizeState(rawState) {
  return {
    budget: Number.isFinite(rawState?.budget) ? rawState.budget : 2500,
    expenses: Array.isArray(rawState?.expenses)
      ? rawState.expenses.filter(
          (expense) =>
            expense &&
            typeof expense.name === "string" &&
            expense.name.trim() &&
            typeof expense.category === "string" &&
            expense.category.trim() &&
            Number.isFinite(expense.amount) &&
            expense.amount > 0
        )
          .map((expense) => ({
            ...expense,
            date: typeof expense.date === "string" ? expense.date : "",
            source: typeof expense.source === "string" ? expense.source : "manual",
          }))
      : [],
    session: {
      email: typeof rawState?.session?.email === "string" ? rawState.session.email : "",
      isAuthenticated: rawState?.session?.isAuthenticated === true,
    },
  };
}

function renderStats(state, totals, elements) {
  const stats = [
    {
      label: "Total spent",
      value: currency.format(totals.totalSpent),
      detail: `${Math.round(totals.spentRatio * 100) || 0}% of monthly budget used`,
    },
    {
      label: "Remaining budget",
      value: currency.format(totals.remaining),
      detail: totals.remaining >= 0 ? "Still available this month" : "You are over budget",
    },
    {
      label: "Average expense",
      value: currency.format(totals.averageExpense),
      detail: `${state.expenses.length} entries tracked`,
    },
    {
      label: "Top category",
      value: totals.topCategory[0],
      detail:
        totals.topCategory[1] > 0
          ? `${currency.format(totals.topCategory[1])} allocated here`
          : "No expenses added yet",
    },
  ];

  elements.statsGrid.innerHTML = stats
    .map(
      (stat) => `
        <article class="stat-card">
          <p class="stat-label">${stat.label}</p>
          <h3 class="stat-value">${stat.value}</h3>
          <p class="stat-detail">${stat.detail}</p>
        </article>
      `
    )
    .join("");
}

function renderChart(totals, elements) {
  if (!totals.sortedCategories.length) {
    elements.categoryChart.innerHTML =
      '<div class="empty-state">Add expenses to see your category breakdown.</div>';
    elements.chartCaption.textContent = "No category data yet.";
    return;
  }

  elements.chartCaption.textContent = `${totals.sortedCategories.length} categories are currently contributing to your monthly spend.`;

  elements.categoryChart.innerHTML = totals.sortedCategories
    .map(([category, amount]) => {
      const ratio = totals.totalSpent > 0 ? (amount / totals.totalSpent) * 100 : 0;

      return `
        <div class="chart-row">
          <div class="chart-row-label">${category}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${ratio.toFixed(1)}%"></div>
          </div>
          <div class="chart-row-value">${currency.format(amount)} · ${ratio.toFixed(0)}%</div>
        </div>
      `;
    })
    .join("");
}

function renderInsights(state, totals, elements) {
  const insights = [];

  if (!state.expenses.length) {
    insights.push({
      title: "Your month starts clean",
      body: "No expenses are stored yet. Add fixed costs first, then layer in flexible spending to get sharper insights.",
      tone: "neutral",
      tag: "Setup",
    });
  } else {
    if (totals.spentRatio >= 1) {
      insights.push({
        title: "Your expenses exceed the budget",
        body: `You are ${currency.format(Math.abs(totals.remaining))} over budget. Review the largest category first, because that will move the result fastest.`,
        tone: "alert",
        tag: "Risk",
      });
    } else if (totals.spentRatio >= 0.85) {
      insights.push({
        title: "You are close to the monthly ceiling",
        body: `${Math.round(totals.spentRatio * 100)}% of the budget is already assigned. Keep discretionary spend below ${currency.format(Math.max(totals.remaining, 0))} for the rest of the month.`,
        tone: "alert",
        tag: "Watch",
      });
    } else {
      insights.push({
        title: "Budget usage is under control",
        body: `You have used ${Math.round(totals.spentRatio * 100)}% of the budget and still retain ${currency.format(Math.max(totals.remaining, 0))} of capacity.`,
        tone: "good",
        tag: "Healthy",
      });
    }

    const [topCategory, topAmount] = totals.topCategory;
    if (topAmount > 0) {
      const share = totals.totalSpent > 0 ? (topAmount / totals.totalSpent) * 100 : 0;
      insights.push({
        title: `${topCategory} is your main spending driver`,
        body: `${topCategory} represents ${share.toFixed(0)}% of current spend. If you need to reduce outgoings, changes here will have the strongest effect.`,
        tone: share > 40 ? "alert" : "neutral",
        tag: "Mix",
      });
    }

    const savings = totals.byCategory.Savings || 0;
    if (state.budget > 0) {
      const savingsRate = (savings / state.budget) * 100;
      insights.push({
        title: "Savings rate",
        body:
          savings > 0
            ? `${savingsRate.toFixed(0)}% of your budget is directed to savings. A double-digit rate generally gives you better resilience.`
            : "No savings allocation is recorded yet. Even a small recurring amount helps smooth future months.",
        tone: savingsRate >= 10 ? "good" : "neutral",
        tag: "Buffer",
      });
    }

    insights.push({
      title: "Daily pacing",
      body: `This budget implies roughly ${currency.format(totals.dailyBudget)} per day, while your current plan averages ${currency.format(totals.dailySpend)} per day.`,
      tone: totals.dailySpend <= totals.dailyBudget ? "good" : "alert",
      tag: "Pace",
    });
  }

  elements.insightsList.innerHTML = insights
    .map(
      (insight) => `
        <article class="insight-card">
          <div class="insight-header">
            <h3 class="insight-title">${insight.title}</h3>
            <span class="insight-tag ${insight.tone === "good" ? "good" : ""}">${insight.tag}</span>
          </div>
          <p class="insight-body">${insight.body}</p>
        </article>
      `
    )
    .join("");
}

function renderLedger(state, totals, elements) {
  elements.ledgerCaption.textContent = `${state.expenses.length} expense entries totalling ${currency.format(totals.totalSpent)}.`;

  if (!state.expenses.length) {
    elements.expenseList.innerHTML =
      '<div class="empty-state">No expenses added yet. Use the form above to start your monthly plan.</div>';
    return;
  }

  elements.expenseList.innerHTML = state.expenses
    .slice()
    .sort((left, right) => right.amount - left.amount)
    .map(
      (expense) => `
        <article class="expense-card">
          <div class="expense-header">
            <h3 class="expense-name">${expense.name}</h3>
            <strong class="expense-amount">${currency.format(expense.amount)}</strong>
          </div>
          <p class="expense-meta">${expense.category}${expense.date ? ` · ${expense.date}` : ""}</p>
        </article>
      `
    )
    .join("");
}

function persistState(storage, state) {
  storage.setItem(storageKey, JSON.stringify(state));
}

function setVisible(element, visible) {
  if (!element) {
    return;
  }

  if (element.classList?.toggle) {
    element.classList.toggle("is-visible", visible);
  }

  if (typeof element.setAttribute === "function") {
    element.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function queryElements(documentRef) {
  return {
    authScreen: documentRef.querySelector("#authScreen"),
    appScreen: documentRef.querySelector("#appScreen"),
    loginForm: documentRef.querySelector("#loginForm"),
    loginEmail: documentRef.querySelector("#loginEmail"),
    loginPassword: documentRef.querySelector("#loginPassword"),
    budgetInput: documentRef.querySelector("#budgetInput"),
    applyBudgetButton: documentRef.querySelector("#applyBudgetButton"),
    resetDataButton: documentRef.querySelector("#resetDataButton"),
    statementForm: documentRef.querySelector("#statementForm"),
    statementFile: documentRef.querySelector("#statementFile"),
    statementStatus: documentRef.querySelector("#statementStatus"),
    logoutButton: documentRef.querySelector("#logoutButton"),
    userBadge: documentRef.querySelector("#userBadge"),
    expenseForm: documentRef.querySelector("#expenseForm"),
    expenseName: documentRef.querySelector("#expenseName"),
    expenseCategory: documentRef.querySelector("#expenseCategory"),
    expenseAmount: documentRef.querySelector("#expenseAmount"),
    statsGrid: documentRef.querySelector("#statsGrid"),
    categoryChart: documentRef.querySelector("#categoryChart"),
    chartCaption: documentRef.querySelector("#chartCaption"),
    insightsList: documentRef.querySelector("#insightsList"),
    expenseList: documentRef.querySelector("#expenseList"),
    ledgerCaption: documentRef.querySelector("#ledgerCaption"),
  };
}

function createApp(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  const storage = options.storage ?? globalThis.localStorage ?? globalThis.window?.localStorage;

  if (!documentRef || !storage) {
    throw new Error("Budget Lens requires document and storage objects.");
  }

  const elements = queryElements(documentRef);
  const state = createInitialState();

  function renderScreens() {
    const isAuthenticated = state.session.isAuthenticated;
    setVisible(elements.authScreen, !isAuthenticated);
    setVisible(elements.appScreen, isAuthenticated);

    if (elements.userBadge) {
      elements.userBadge.textContent = isAuthenticated
        ? state.session.email || "Signed in"
        : "Signed out";
    }
  }

  function render() {
    if (elements.budgetInput) {
      elements.budgetInput.value = state.budget || "";
    }

    const totals = buildTotals(state);
    renderStats(state, totals, elements);
    renderChart(totals, elements);
    renderInsights(state, totals, elements);
    renderLedger(state, totals, elements);
    renderScreens();
    persistState(storage, state);
  }

  function setStatementStatus(message) {
    if (elements.statementStatus) {
      elements.statementStatus.textContent = message;
    }
  }

  function setBudget() {
    const nextBudget = Number(elements.budgetInput.value);
    state.budget = Number.isFinite(nextBudget) && nextBudget >= 0 ? nextBudget : 0;
    render();
  }

  function addExpense(event) {
    event.preventDefault();

    const name = elements.expenseName.value.trim();
    const amount = Number(elements.expenseAmount.value);

    if (!name || !Number.isFinite(amount) || amount <= 0) {
      return;
    }

    state.expenses.unshift({
      name,
      category: elements.expenseCategory.value,
      amount,
      date: "",
      source: "manual",
    });

    elements.expenseForm.reset();
    elements.expenseCategory.value = "Housing";
    render();
  }

  function login(event) {
    event.preventDefault();

    const email = elements.loginEmail.value.trim();
    const password = elements.loginPassword.value.trim();

    if (!email || !password) {
      return;
    }

    state.session.email = email;
    state.session.isAuthenticated = true;
    elements.loginForm.reset();
    render();
  }

  function logout() {
    state.session.isAuthenticated = false;
    render();
  }

  function resetData() {
    state.budget = 2500;
    state.expenses = [];
    setStatementStatus("Imported statement data cleared.");
    render();
  }

  async function readFileText(file) {
    if (typeof file.text === "function") {
      return file.text();
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsText(file);
    });
  }

  async function importStatement(event) {
    event.preventDefault();

    const file = elements.statementFile?.files?.[0];
    if (!file) {
      setStatementStatus("Choose a CSV statement file first.");
      return;
    }

    try {
      const text = await readFileText(file);
      const importedExpenses = parseStatementCsv(text);

      if (!importedExpenses.length) {
        setStatementStatus("No outgoing transactions were detected in that file.");
        return;
      }

      state.expenses = [...importedExpenses, ...state.expenses];
      elements.statementForm.reset();
      setStatementStatus(`Imported ${importedExpenses.length} expenses from ${file.name}.`);
      render();
    } catch {
      setStatementStatus("This statement could not be imported. Use a CSV export from your bank.");
    }
  }

  function hydrateState() {
    const rawState = storage.getItem(storageKey);

    if (!rawState) {
      render();
      return;
    }

    try {
      const parsedState = JSON.parse(rawState);
      const sanitizedState = sanitizeState(parsedState);
      state.budget = sanitizedState.budget;
      state.expenses = sanitizedState.expenses;
      state.session = sanitizedState.session;
      render();
    } catch {
      render();
    }
  }

  function bindEvents() {
    elements.loginForm.addEventListener("submit", login);
    elements.applyBudgetButton.addEventListener("click", setBudget);
    elements.resetDataButton.addEventListener("click", resetData);
    elements.logoutButton.addEventListener("click", logout);
    elements.expenseForm.addEventListener("submit", addExpense);
    elements.statementForm.addEventListener("submit", importStatement);
  }

  function init() {
    bindEvents();
    hydrateState();
  }

  return {
    state,
    elements,
    render,
    setBudget,
    addExpense,
    importStatement,
    login,
    logout,
    resetData,
    hydrateState,
    init,
  };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  createApp({ document, storage: window.localStorage }).init();
}

if (typeof module !== "undefined") {
  module.exports = {
    buildTotals,
    createApp,
    createInitialState,
    currency,
    parseCsv,
    parseStatementCsv,
    categorizeStatementExpense,
    sanitizeState,
    storageKey,
  };
}
