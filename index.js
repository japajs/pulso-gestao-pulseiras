/*
  GesPul - index.js
  Rebuilt from scratch incorporating:
  - Robust schedule parsing and timestamp storage (scheduleTs)
  - Improved manager dashboard rendering (sorting, expired highlights)
  - Enhanced WhatsApp integration (using employee phone if available)
  - "Undo" functionality for schedule removal
  - Consolidated and cleaned-up core application logic
  - Improved login experience (error messages, button states)
*/

// --- CONFIGURAÇÃO E ESTADO ---
const SYSTEM_PASSWORD = "1234"; // SENHA DE ACESSO
const STORAGE_KEY = "pulso_app_v1"; // Chave para dados antigos em localStorage (para migração)

// --- INDEXEDDB (idb UMD - Biblioteca externa) ---
const DB_NAME = "pulso_db";
const DB_VERSION = 1;
const DB_STORE = "appState";
let db = null; // A instância do banco de dados IndexedDB

// Estado central da aplicação
let appState = {
  centralStock: 0, // Estoque de pulseiras de venda
  stockOwner: 0, // Estoque de pulseiras de proprietário
  stockDayUser: 0, // Estoque de pulseiras de day user
  totalCash: 0, // Dinheiro acumulado de acertos passados (caixa bruto)
  pricePerUnit: 15.0, // Preço de venda por unidade (dinâmico)
  currentSettleId: null, // ID do funcionário sendo acertado no momento
  pendingDistribute: null, // Dados temporários para o modal de distribuição/entrega
  currentScheduleId: null, // ID do funcionário sendo agendado no momento
  employees: [], // Lista de funcionários
  bandConfig: null, // Configuração de nomes e cores das pulseiras
  stockLogs: [], // Histórico de movimentação do estoque central
  history: [], // Logs de acertos financeiros
  cashWithdrawals: [], // Retiradas registradas do caixa
  stockAlertThreshold: 20, // Limite para alerta visual de estoque baixo
};

// Variáveis de Paginação (para o histórico)
let currentPage = 1;
const ITEMS_PER_PAGE = 5;

// Instâncias dos gráficos Chart.js (necessário para destruir antes de recriar)
let chartInstances = {};

// Mapa temporário para agendamentos removidos (para a função "Desfazer")
const pendingScheduleRemovals = new Map();

// --- CAMADA DE ACESSO AO INDEXEDDB (utiliza a biblioteca idb) ---

/**
 * Abre (ou cria) o banco IndexedDB.
 * Chamada uma única vez no init().
 */
async function initDB() {
  try {
    db = await idb.openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(DB_STORE)) {
          database.createObjectStore(DB_STORE);
        }
      },
    });
  } catch (err) {
    console.error("[IndexedDB] Falha ao abrir o banco:", err);
    db = null; // Garante que db é null se a abertura falhar
  }
}

/**
 * Carrega o appState salvo no IndexedDB.
 * Retorna o objeto ou null se não houver dados.
 */
async function loadFromDB() {
  if (!db) return null;
  try {
    return (await db.get(DB_STORE, "current")) ?? null;
  } catch (err) {
    console.error("[IndexedDB] Falha ao carregar dados:", err);
    return null;
  }
}

/**
 * Persiste o appState atual no IndexedDB.
 * É um método "fire-and-forget" — não bloqueia a UI.
 */
async function saveToDB() {
  if (!db) return;
  try {
    await db.put(DB_STORE, appState, "current");
  } catch (err) {
    console.error("[IndexedDB] Falha ao salvar dados:", err);
    // Fallback de emergência: grava em localStorage se IndexedDB falhar
    try {
      localStorage.setItem(
        STORAGE_KEY + "_emergency",
        JSON.stringify(appState),
      );
    } catch (e) {
      console.warn("[IndexedDB] Falha no fallback para localStorage:", e);
    }
  }
}

/**
 * Migração única: se existir dados no localStorage (versão antiga),
 * importa para o IndexedDB e apaga a entrada legada do localStorage.
 */
async function migrateFromLocalStorage() {
  const legacy = localStorage.getItem(STORAGE_KEY);
  if (!legacy) return null;
  try {
    const parsed = JSON.parse(legacy);
    await db.put(DB_STORE, parsed, "current");
    localStorage.removeItem(STORAGE_KEY);
    console.info("[Migração] Dados do localStorage migrados para IndexedDB.");
    return parsed;
  } catch (err) {
    console.error("[Migração] Falha ao migrar dados:", err);
    return null;
  }
}

// --- UTILITÁRIOS DE DATA ---

/**
 * Faz parsing robusto de uma string vinda de <input type="datetime-local"> ("YYYY-MM-DDTHH:MM").
 * Retorna um objeto { dateObj: Date, ts: number (timestamp) } ou null caso inválido.
 */
function parseDatetimeLocal(val) {
  if (!val || typeof val !== "string") return null;
  // Espera o formato "YYYY-MM-DDTHH:MM" ou "YYYY-MM-DDTHH:MM:ss"
  const parts = val.split("T");
  if (parts.length < 2) return null;

  const datePart = parts[0];
  const timePart = parts[1].split(".")[0]; // Remove possíveis segundos fracionados

  const d = datePart.split("-").map((n) => parseInt(n, 10));
  const t = timePart.split(":").map((n) => parseInt(n, 10));

  if (d.length !== 3 || t.length < 2) return null;

  const [year, month, day] = d;
  const [hour, minute] = t;

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  )
    return null;

  // month - 1 porque o mês em Date é 0-indexed
  const dateObj = new Date(year, month - 1, day, hour, minute);
  // Se o Date objeto for inválido (e.g. data inexistente), getTime() retorna NaN
  if (isNaN(dateObj.getTime())) return null;

  return { dateObj: dateObj, ts: dateObj.getTime() };
}

// --- INICIALIZAÇÃO DA APLICAÇÃO ---
async function init() {
  await initDB(); // 1. Abre o banco IndexedDB
  let savedData = await loadFromDB(); // 2. Tenta carregar dados do IndexedDB

  // 3. Se não há dados no IDB, verifica se existe legado no localStorage
  if (!savedData) {
    savedData = await migrateFromLocalStorage();
  }

  // 4. Aplica os dados carregados ao appState
  if (savedData) {
    appState = savedData;
  }

  // 5. Migração/inicialização de novos campos para garantir compatibilidade
  if (!Array.isArray(appState.employees)) appState.employees = [];
  if (!appState.history) appState.history = [];
  if (!appState.stockLogs) appState.stockLogs = [];
  if (!appState.cashWithdrawals) appState.cashWithdrawals = [];
  if (appState.pricePerUnit === undefined) appState.pricePerUnit = 15.0;
  if (appState.stockOwner === undefined) appState.stockOwner = 0;
  if (appState.stockDayUser === undefined) appState.stockDayUser = 0;
  if (appState.stockAlertThreshold === undefined)
    appState.stockAlertThreshold = 20;

  // Garante a configuração de bandas, caso não exista
  if (!appState.bandConfig) {
    appState.bandConfig = {
      sales: { name: "Venda", color: "blue", label: "Azul" },
      owner: { name: "Proprietário", color: "yellow", label: "Amarela" },
      dayUser: { name: "Day User", color: "purple", label: "Roxa" },
    };
  }

  // Migração: se existir scheduleDate mas não scheduleTs, preencha scheduleTs
  // E também inicializa o campo 'phone' para funcionários existentes, se não tiver
  appState.employees.forEach((emp) => {
    if (emp && emp.scheduleDate && !emp.scheduleTs) {
      const dtParsed = parseDatetimeLocal(emp.scheduleDate);
      if (dtParsed) emp.scheduleTs = dtParsed.ts;
    }
    if (emp && emp.phone === undefined) {
      emp.phone = ""; // Inicializa o campo de telefone como string vazia
    }
  });

  // Configurar event listeners
  const loginInput = document.getElementById("login-password");
  if (loginInput) {
    loginInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") attemptLogin();
    });
    loginInput.addEventListener("input", () => {
      const errorEl = document.getElementById("login-error");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
    });
  }

  const loginButton =
    document.getElementById("login-submit") || document.getElementById("login-btn");
  if (loginButton) {
    loginButton.addEventListener("click", attemptLogin);
  }

  const toggleBtn = document.getElementById("toggle-password-visibility");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const p = document.getElementById("login-password");
      if (!p) return;
      if (p.type === "password") {
        p.type = "text";
        toggleBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
        toggleBtn.setAttribute("aria-label", "Ocultar senha");
      } else {
        p.type = "password";
        toggleBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        toggleBtn.setAttribute("aria-label", "Mostrar senha");
      }
    });
  }

  const loginToggleBtn = document.getElementById("login-toggle-password");
  if (loginToggleBtn) {
    loginToggleBtn.addEventListener("click", () => {
      const p = document.getElementById("login-password");
      if (!p) return;
      const icon = loginToggleBtn.querySelector("i");
      if (p.type === "password") {
        p.type = "text";
        icon.className = "fa-solid fa-eye-slash";
      } else {
        p.type = "password";
        icon.className = "fa-solid fa-eye";
      }
    });
  }

  const empNameInput = document.getElementById("new-emp-name");
  if (empNameInput) {
    empNameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") addEmployee();
    });
  }

  const distAmountInput = document.getElementById("distribute-amount");
  if (distAmountInput) {
    distAmountInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") openDistributeModal();
    });
  }

  const stockInput = document.getElementById("add-stock-input");
  if (stockInput) {
    stockInput.addEventListener("keydown", (e) => {
      if (
        e.key.length === 1 &&
        /[a-zA-Z]/.test(e.key) &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
      }
    });
  }

  // Carregar Tema Salvo
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
    updateThemeIcon();
  }

  // Verificar se já está logado (Sessão)
  if (sessionStorage.getItem("isLoggedIn") === "true") {
    showManagerView();
  } else {
    showLoginView();
  }

  // Inicializar input de threshold de alerta de estoque
  const thresholdInput = document.getElementById("stock-alert-threshold");
  if (thresholdInput) thresholdInput.value = appState.stockAlertThreshold;

  // Atualizar ano do rodapé automaticamente
  const yearSpan = document.getElementById("current-year");
  if (yearSpan) yearSpan.innerText = new Date().getFullYear();

  renderAll(); // Renderiza a UI inicial
}

// --- TEMA (DARK MODE) ---
function toggleTheme() {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateThemeIcon();
}

function updateThemeIcon() {
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  if (document.body.classList.contains("dark-mode")) {
    icon.className = "fa-solid fa-sun text-xl text-yellow-300";
  } else {
    icon.className = "fa-solid fa-moon text-xl";
  }
}

// --- AUTENTICAÇÃO ---
/**
 * Tenta fazer login com a senha fornecida.
 * Exibe feedback visual e de texto para senha incorreta.
 * Impede envios múltiplos.
 */
function attemptLogin() {
  const input = document.getElementById("login-password");
  const btn =
    document.getElementById("login-submit") || // ID atual
    document.getElementById("login-btn"); // ID para compatibilidade antiga
  const errorEl = document.getElementById("login-error");
  if (!input || !btn) return;

  if (btn.disabled) return; // Impede envios múltiplos
  btn.disabled = true;
  btn.classList.add("opacity-50", "cursor-not-allowed");
  const prevText = btn.innerHTML; // Salva o texto original do botão
  btn.innerHTML = "Entrando...";

  // Pequeno delay para que o estado do botão seja renderizado antes da checagem
  setTimeout(() => {
    if (input.value === SYSTEM_PASSWORD) {
      sessionStorage.setItem("isLoggedIn", "true");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
      input.value = ""; // Limpa o campo de senha
      showManagerView();
    } else {
      if (errorEl) {
        errorEl.textContent = "Senha incorreta.";
        errorEl.classList.remove("hidden");
      }
      input.classList.add("shake"); // Animação de "tremida"
      setTimeout(() => input.classList.remove("shake"), 300);

      input.value = ""; // Limpa o campo de senha
      input.focus(); // Retorna o foco para o campo de senha

      // Limpa a mensagem de erro após alguns segundos
      setTimeout(() => {
        if (errorEl) {
          errorEl.textContent = "";
          errorEl.classList.add("hidden");
        }
      }, 3000);
    }

    // Restaura o botão ao estado original
    btn.disabled = false;
    btn.classList.remove("opacity-50", "cursor-not-allowed");
    btn.innerHTML = prevText;
  }, 220); // Pequeno atraso para a UX
}

function logout() {
  sessionStorage.removeItem("isLoggedIn");
  showLoginView();
}

function showManagerView() {
  const vLogin = document.getElementById("view-login");
  const vManager = document.getElementById("view-manager");
  const navLogout = document.getElementById("nav-logout-btn");
  if (vLogin) vLogin.classList.add("hidden");
  if (vManager) vManager.classList.remove("hidden");
  if (navLogout) navLogout.classList.remove("hidden");
}

function showLoginView() {
  const vLogin = document.getElementById("view-login");
  const vManager = document.getElementById("view-manager");
  const navLogout = document.getElementById("nav-logout-btn");
  if (vManager) vManager.classList.add("hidden");
  if (vLogin) vLogin.classList.remove("hidden");
  if (navLogout) navLogout.classList.add("hidden");
}

function saveData() {
  renderAll(); // Atualiza a UI imediatamente (síncrono)
  saveToDB(); // Persiste em background (assíncrono, fire-and-forget)
}

// --- LÓGICA DE NEGÓCIO ---

/**
 * Atualiza o preço unitário das pulseiras de venda.
 */
function updatePrice() {
  const input = document.getElementById("config-price-input");
  const newPrice = parseFloat(input.value);
  if (newPrice >= 0) {
    appState.pricePerUnit = newPrice;
    saveData();
    showToast(
      `Preço unitário atualizado para ${formatCurrency(newPrice)}`,
      "success",
    );
  } else {
    showToast("O preço deve ser um valor positivo.", "error");
  }
}

/**
 * Adiciona um registro de movimentação ao histórico de estoque.
 * @param {string} typeKey - Chave do tipo de pulseira (ex: 'sales', 'owner', 'dayUser').
 * @param {number} amount - Quantidade movimentada.
 * @param {string} action - Descrição da ação (ex: "Compra", "Distribuição").
 * @param {string} details - Detalhes adicionais.
 */
function addStockLog(typeKey, amount, action, details) {
  const config = appState.bandConfig[typeKey];
  appState.stockLogs.unshift({
    id: Date.now(), // Usado como timestamp para ordenação
    date: new Date().toLocaleString("pt-BR"),
    item: config.name,
    amount: amount,
    action: action,
    details: details,
  });
}

/**
 * Adiciona ou corrige o estoque central de pulseiras.
 */
function addToStock() {
  const input = document.getElementById("add-stock-input");
  const typeSelect = document.getElementById("add-stock-type");
  const amount = parseInt(input.value, 10);
  const type = typeSelect.value;

  if (isNaN(amount) || amount === 0) {
    showToast("Informe uma quantidade válida para adicionar/remover.", "warning");
    return;
  }

  let current = 0;
  if (type === "sales") current = appState.centralStock;
  else if (type === "owner") current = appState.stockOwner;
  else if (type === "dayUser") current = appState.stockDayUser;

  // Prevenção de estoque negativo
  if (current + amount < 0) {
    showToast("A correção não pode deixar o estoque negativo.", "error");
    return;
  }

  if (type === "sales") appState.centralStock += amount;
  else if (type === "owner") appState.stockOwner += amount;
  else if (type === "dayUser") appState.stockDayUser += amount;

  const config = appState.bandConfig[type];
  const action = amount > 0 ? "Entrada Manual" : "Ajuste Manual";
  addStockLog(type, amount, action, "Via Painel Principal");
  showToast(
    `${amount > 0 ? "Adicionado" : "Corrigido/Removido"} ${Math.abs(amount)} pulseiras de ${config.name} (${config.label}).`,
    "success",
  );

  input.value = ""; // Limpa o campo
  saveData();
}

/**
 * Adiciona um novo funcionário.
 */
function addEmployee() {
  const input = document.getElementById("new-emp-name");
  const name = input.value.trim();
  if (!name) {
    showToast("O nome do funcionário não pode ser vazio.", "warning");
    return;
  }

  // Validação de duplicidade (case-insensitive)
  const exists = appState.employees.some(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (exists) {
    showToast("Já existe um funcionário cadastrado com este nome.", "error");
    return;
  }

  const newId =
    appState.employees.length > 0
      ? Math.max(...appState.employees.map((e) => e.id)) + 1
      : 1;

  appState.employees.push({
    id: newId,
    name: name,
    phone: "", // Adicionado campo de telefone, vazio por padrão
    received: 0, // Pulseiras de Venda
    receivedOwner: 0, // Pulseiras de Proprietário
    receivedDayUser: 0, // Pulseiras de Day User
    scheduleDate: undefined, // String de data/hora (para input datetime-local)
    scheduleTs: undefined, // Timestamp numérico (para ordenação e comparação)
  });
  input.value = "";
  saveData();
  showToast(`Funcionário "${name}" adicionado com sucesso!`, "success");
}

/**
 * Abre o modal de distribuição, com validação prévia de inputs e estoque.
 */
function openDistributeModal() {
  const select = document.getElementById("distribute-select");
  const input = document.getElementById("distribute-amount");
  const typeSelect = document.getElementById("distribute-type");

  const empId = parseInt(select.value, 10);
  const amount = parseInt(input.value, 10);
  const type = typeSelect.value;

  if (isNaN(empId) || !empId || isNaN(amount) || amount <= 0) {
    showToast("Selecione um funcionário e uma quantidade válida para distribuir.", "warning");
    return;
  }

  let currentStock = 0;
  const config = appState.bandConfig[type];

  if (type === "sales") currentStock = appState.centralStock;
  else if (type === "owner") currentStock = appState.stockOwner;
  else if (type === "dayUser") currentStock = appState.stockDayUser;

  if (currentStock < amount) {
    showToast(
      `Erro: Estoque de ${config.name} insuficiente (Disponível: ${currentStock}).`,
      "error",
    );
    return;
  }

  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return; // Deve ser impossível se o select for bem preenchido

  appState.pendingDistribute = { empId, amount, type, empName: employee.name };

  document.getElementById("modal-dist-amount").innerText = amount;
  document.getElementById("modal-dist-name").innerText = employee.name;
  document.getElementById("modal-dist-type-label").innerText =
    `${config.name} (${config.label})`;

  document.getElementById("distribute-modal").classList.remove("hidden");
}

function closeDistributeModal() {
  document.getElementById("distribute-modal").classList.add("hidden");
  appState.pendingDistribute = null; // Limpa o estado temporário
}

/**
 * Confirma a distribuição de pulseiras, debitando do estoque central e creditando ao funcionário.
 */
function confirmDistribute() {
  if (!appState.pendingDistribute) return;

  const { empId, amount, type } = appState.pendingDistribute;
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  // Garante que os campos existem para evitar `undefined + number`
  if (employee.receivedOwner === undefined) employee.receivedOwner = 0;
  if (employee.receivedDayUser === undefined) employee.receivedDayUser = 0;

  if (type === "sales") {
    appState.centralStock -= amount;
    employee.received += amount;
  } else if (type === "owner") {
    appState.stockOwner -= amount;
    employee.receivedOwner += amount;
  } else if (type === "dayUser") {
    appState.stockDayUser -= amount;
    employee.receivedDayUser += amount;
  }

  addStockLog(type, -amount, "Distribuição", `Entregue para ${employee.name}`);
  document.getElementById("distribute-amount").value = ""; // Limpa o input da tela principal

  saveData();
  closeDistributeModal();
  showToast(`${amount} pulseiras distribuídas para ${employee.name}.`, "success");
}

// --- LÓGICA DO MODAL DE ACERTO ---

/**
 * Abre o modal de acerto para um funcionário específico, preenchendo seus dados atuais.
 */
function openSettleModal(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const recSales = employee.received || 0;
  const recOwner = employee.receivedOwner || 0;
  const recDay = employee.receivedDayUser || 0;

  if (recSales === 0 && recOwner === 0 && recDay === 0) {
    showToast("Este funcionário não tem pulseiras para acertar.", "warning");
    return;
  }

  appState.currentSettleId = empId; // Salva o ID atual

  document.getElementById("modal-emp-name").innerText = employee.name;
  document.getElementById("modal-got-sales").innerText = recSales;
  document.getElementById("modal-got-owner").innerText = recOwner;
  document.getElementById("modal-got-day").innerText = recDay;

  // Reseta os inputs de devolução e prévias
  document.getElementById("modal-ret-sales").value = "";
  document.getElementById("modal-ret-owner").value = "";
  document.getElementById("modal-ret-day").value = "";
  document.getElementById("modal-sold-preview").innerText = "0";
  document.getElementById("modal-pay-preview").innerText = "R$ 0,00";

  // Lógica de Agendamento no Acerto: mostra/oculta opção de "marcar como concluído"
  const scheduleOption = document.getElementById("modal-settle-schedule-option");
  const scheduleCheckbox = document.getElementById("modal-settle-schedule-check");

  if (employee.scheduleDate) {
    scheduleOption.classList.remove("hidden");
    if (scheduleCheckbox) scheduleCheckbox.checked = true; // Marcado por padrão para facilitar
  } else {
    scheduleOption.classList.add("hidden");
    if (scheduleCheckbox) scheduleCheckbox.checked = false;
  }

  document.getElementById("settle-modal").classList.remove("hidden");
}

function closeSettleModal() {
  document.getElementById("settle-modal").classList.add("hidden");
  appState.currentSettleId = null;
}

/**
 * Calcula e exibe os totais no modal de acerto com base nas devoluções.
 */
function calculateModalTotals() {
  const empId = appState.currentSettleId;
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const retSalesInput = document.getElementById("modal-ret-sales").value;
  const retOwnerInput = document.getElementById("modal-ret-owner").value;
  const retDayInput = document.getElementById("modal-ret-day").value;

  const returnedSales = retSalesInput === "" ? 0 : parseInt(retSalesInput, 10);
  const returnedOwner = retOwnerInput === "" ? 0 : parseInt(retOwnerInput, 10);
  const returnedDay = retDayInput === "" ? 0 : parseInt(retDayInput, 10);

  const recSales = employee.received || 0;
  const recOwner = employee.receivedOwner || 0;
  const recDay = employee.receivedDayUser || 0;

  // Validação visual para todos os tipos (não permite devolver mais do que pegou ou valores negativos)
  if (
    returnedSales < 0 ||
    returnedSales > recSales ||
    returnedOwner < 0 ||
    returnedOwner > recOwner ||
    returnedDay < 0 ||
    returnedDay > recDay
  ) {
    document.getElementById("modal-pay-preview").innerText = "Valor Inválido";
    document.getElementById("modal-sold-preview").innerText = "-";
    return;
  }

  const sold = recSales - returnedSales;
  const totalPay = sold * appState.pricePerUnit;

  document.getElementById("modal-sold-preview").innerText = sold;
  document.getElementById("modal-pay-preview").innerText =
    formatCurrency(totalPay);
}

/**
 * Confirma o acerto de contas com o funcionário, atualizando saldos e histórico.
 */
function confirmSettle() {
  const empId = appState.currentSettleId;
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const retSales =
    parseInt(document.getElementById("modal-ret-sales").value, 10) || 0;
  const retOwner =
    parseInt(document.getElementById("modal-ret-owner").value, 10) || 0;
  const retDay = parseInt(document.getElementById("modal-ret-day").value, 10) || 0;

  const recSales = employee.received || 0;
  const recOwner = employee.receivedOwner || 0;
  const recDay = employee.receivedDayUser || 0;

  // Validação final antes de processar
  if (
    retSales < 0 ||
    retSales > recSales ||
    retOwner < 0 ||
    retOwner > recOwner ||
    retDay < 0 ||
    retDay > recDay
  ) {
    showToast(
      "Verifique as quantidades de devolução. Não podem ser maiores que o recebido.",
      "error",
    );
    return;
  }

  const soldCount = recSales - retSales;
  const usedOwner = recOwner - retOwner;
  const usedDay = recDay - retDay;
  const moneyDue = soldCount * appState.pricePerUnit;

  // As sobras NÃO voltam para o Estoque Central.
  // Elas permanecem fisicamente com o funcionário para o próximo turno.
  // As linhas que somavam ao appState.centralStock/Owner/DayUser foram removidas.

  appState.totalCash = (appState.totalCash || 0) + moneyDue; // Atualiza Caixa Geral

  const details = `Venda: ${soldCount} | Prop: ${usedOwner} | Day: ${usedDay}`;

  appState.history.unshift({
    id: Date.now(), // ID/timestamp para o log
    date: new Date().toLocaleString("pt-BR"),
    empName: employee.name,
    sold: soldCount,
    details: details,
    total: moneyDue,
    // Dados completos para geração de recibo individual
    recSales,
    retSales,
    soldCount,
    recOwner,
    retOwner,
    usedOwner,
    recDay,
    retDay,
    usedDay,
    pricePerUnit: appState.pricePerUnit,
  });

  // Atualiza o saldo do funcionário com o que sobrou (ele continua com essas pulseiras)
  employee.received = retSales;
  employee.receivedOwner = retOwner;
  employee.receivedDayUser = retDay;

  // Concluir agendamento se selecionado (remove scheduleDate E scheduleTs)
  const scheduleCheckbox = document.getElementById("modal-settle-schedule-check");
  if (employee.scheduleDate && scheduleCheckbox && scheduleCheckbox.checked) {
    delete employee.scheduleDate;
    delete employee.scheduleTs;
  }

  saveData();
  closeSettleModal();
  showToast(`Acerto com ${employee.name} concluído!`, "success");
}

/**
 * Remove um funcionário, após validação e confirmação.
 */
async function removeEmployee(empId) {
  const emp = appState.employees.find((e) => e.id === empId);
  if (!emp) return;

  const totalPending =
    (emp.received || 0) + (emp.receivedOwner || 0) + (emp.receivedDayUser || 0);

  if (totalPending > 0) {
    showToast(
      `Não é possível remover ${emp.name} pois ele(a) ainda possui ${totalPending} pulseiras em mãos. Faça o acerto ou recolha as pulseiras antes de excluir.`,
      "error",
    );
    return;
  }

  if (
    await showConfirm("Tem certeza que deseja remover este funcionário?", {
      type: "danger",
      title: "Remover Funcionário",
      confirmText: "Sim, remover",
    })
  ) {
    appState.employees = appState.employees.filter((e) => e.id !== empId);
    saveData();
    showToast("Funcionário removido com sucesso.", "success");
  }
}

/**
 * Recolhe todas as pulseiras de um funcionário para o estoque central.
 * Esta ação não gera registro financeiro.
 */
async function collectAllFromEmployee(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const totalToCollect =
    (employee.received || 0) +
    (employee.receivedOwner || 0) +
    (employee.receivedDayUser || 0);

  if (totalToCollect === 0) {
    showToast(
      `${employee.name} não possui nenhuma pulseira para recolher.`,
      "warning",
    );
    return;
  }

  if (
    await showConfirm(
      `Tem certeza que deseja recolher TODAS as ${totalToCollect} pulseiras de ${employee.name} e devolvê-las ao Estoque Central? Esta ação não gera registro financeiro.`,
      { type: "warning", title: "Recolher Pulseiras" },
    )
  ) {
    const toLogSales = employee.received || 0;
    const toLogOwner = employee.receivedOwner || 0;
    const toLogDay = employee.receivedDayUser || 0;

    appState.centralStock += toLogSales;
    appState.stockOwner += toLogOwner;
    appState.stockDayUser += toLogDay;

    employee.received = 0;
    employee.receivedOwner = 0;
    employee.receivedDayUser = 0;

    if (toLogSales > 0)
      addStockLog(
        "sales",
        toLogSales,
        "Recolhimento",
        `Devolvido por ${employee.name}`,
      );
    if (toLogOwner > 0)
      addStockLog(
        "owner",
        toLogOwner,
        "Recolhimento",
        `Devolvido por ${employee.name}`,
      );
    if (toLogDay > 0)
      addStockLog(
        "dayUser",
        toLogDay,
        "Recolhimento",
        `Devolvido por ${employee.name}`,
      );

    showToast("Pulseiras recolhidas com sucesso!", "success");
    saveData();
  }
}

// --- AGENDAMENTO E NOTIFICAÇÃO ---

/**
 * Abre o modal de agendamento para um funcionário, preenchendo o input se já houver um agendamento.
 */
function openScheduleModal(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  appState.currentScheduleId = empId;
  document.getElementById("modal-sched-name").innerText = employee.name;

  const input = document.getElementById("schedule-datetime");
  if (employee.scheduleDate) {
    input.value = employee.scheduleDate;
  } else {
    input.value = ""; // Limpa o input se não houver agendamento
  }

  document.getElementById("schedule-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de agendamento.
 */
function closeScheduleModal() {
  document.getElementById("schedule-modal").classList.add("hidden");
  appState.currentScheduleId = null;
}

/**
 * Salva o agendamento para um funcionário. Armazena a string original e um timestamp.
 */
function saveSchedule() {
  const empId = appState.currentScheduleId;
  const employee = appState.employees.find((e) => e.id === empId);
  const dateVal = document.getElementById("schedule-datetime").value;

  if (employee) {
    if (dateVal) {
      const parsed = parseDatetimeLocal(dateVal);
      if (!parsed) {
        showToast("Formato de data/hora inválido. Verifique se está completo.", "error");
        return;
      }
      employee.scheduleDate = dateVal; // String original do input
      employee.scheduleTs = parsed.ts; // Timestamp para fácil ordenação/comparação
      showToast(`Agendamento salvo para ${employee.name}.`, "success");
    } else {
      // Se o campo for limpo, remove ambos os campos de agendamento
      delete employee.scheduleDate;
      delete employee.scheduleTs;
      showToast(`Agendamento para ${employee.name} removido.`, "success");
    }
    saveData();
  }
  closeScheduleModal();
}

/**
 * Envia uma mensagem de agendamento via WhatsApp.
 * Tenta usar o número de telefone do funcionário se disponível.
 */
function sendWhatsApp(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee || !employee.scheduleDate) {
    showToast("Agendamento ou funcionário não encontrado para enviar WhatsApp.", "warning");
    return;
  }

  const parsed = parseDatetimeLocal(employee.scheduleDate);
  let dateStr = "data não definida";
  let timeStr = "";

  if (parsed && parsed.dateObj) {
    dateStr = parsed.dateObj.toLocaleDateString("pt-BR");
    timeStr = parsed.dateObj.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const message = `Olá ${employee.name}, favor comparecer para acerto de pulseiras dia *${dateStr}* às *${timeStr}*.`;
  const encodedMsg = encodeURIComponent(message);

  if (employee.phone && typeof employee.phone === "string" && employee.phone.trim() !== "") {
    // Sanitiza o número de telefone (remove caracteres não-numéricos)
    const digits = employee.phone.replace(/\D/g, "");
    if (digits.length >= 8) { // Considera um número válido se tiver pelo menos 8 dígitos (excluindo DDI, incluindo DDD)
      window.open(`https://wa.me/${digits}?text=${encodedMsg}`, "_blank");
      return;
    }
  }
  // Fallback: abre o composer do WhatsApp sem um número específico
  window.open(`https://wa.me/?text=${encodedMsg}`, "_blank");
  showToast("Abriu o WhatsApp. Lembre-se de selecionar o contato do funcionário.", "info");
}

/**
 * Remove o agendamento de um funcionário com opção de "Desfazer".
 * Remove imediatamente da UI/estado e mostra um toast interativo.
 */
async function removeSchedule(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee || !employee.scheduleDate) return;

  const confirmed = await showConfirm(
    `Tem certeza que deseja remover o agendamento de ${employee.name}?`,
    {
      type: "warning",
      title: "Remover Agendamento",
      confirmText: "Sim, remover",
      cancelText: "Manter Agendamento",
    },
  );

  if (!confirmed) return;

  // Salva o estado anterior do agendamento para a função "Desfazer"
  const previous = {
    scheduleDate: employee.scheduleDate,
    scheduleTs: employee.scheduleTs,
  };

  // Remove imediatamente o agendamento do funcionário e salva o estado
  delete employee.scheduleDate;
  delete employee.scheduleTs;
  saveData(); // Isso re-renderizará o dashboard e o agendamento sumirá.

  // Gera uma chave única para este evento de remoção para o "Desfazer"
  const undoKey = Date.now() + "_" + empId;
  let undone = false; // Flag para controlar se o "Desfazer" já foi acionado

  // Callback para a ação de "Desfazer"
  const undoCallback = () => {
    // Verifica se o agendamento ainda está "pendente de remoção" (não foi desfeito ainda)
    const pending = pendingScheduleRemovals.get(undoKey);
    if (!pending) return; // Se já não está no mapa, ou já foi desfeito/finalizado

    const emp = appState.employees.find((e) => e.id === empId);
    if (!emp) return;

    // Restaura os dados do agendamento
    emp.scheduleDate = previous.scheduleDate;
    emp.scheduleTs = previous.scheduleTs;
    saveData(); // Salva o estado e re-renderiza (o agendamento reaparecerá)
    undone = true; // Marca como desfeito
    pendingScheduleRemovals.delete(undoKey); // Limpa do mapa
    showToast(`Agendamento restaurado para ${emp.name}.`, "success");
  };

  // Armazena o evento de remoção no mapa e define um timeout para limpar
  // O timeout chama uma função que apenas limpa o `pendingScheduleRemovals`
  // se a ação de "Desfazer" não tiver sido feita.
  const timeoutId = setTimeout(() => {
    if (!undone) {
      pendingScheduleRemovals.delete(undoKey);
    }
  }, 5000); // 5 segundos para o "Desfazer"

  pendingScheduleRemovals.set(undoKey, { empId, previous, timeoutId });

  // Exibe o toast com o botão "Desfazer"
  showToast(
    `Agendamento removido para ${employee.name}.`,
    "info",
    "Desfazer",
    undoCallback,
  );
}

// --- RENDERIZAÇÃO (UI) ---

/**
 * Renderiza todos os componentes da UI que precisam ser atualizados.
 */
function renderAll() {
  renderBandOptions(); // Atualiza selects e textos baseados na config
  renderManagerDashboard(); // Renderiza a tabela principal de funcionários
  renderEmployeeSelects(); // Atualiza os selects de funcionários (ex: distribuição)
  renderHistory(); // Renderiza o histórico de acertos
  renderCharts(); // Renderiza os gráficos
  const priceInput = document.getElementById("config-price-input");
  if (priceInput) priceInput.value = appState.pricePerUnit;
}

/**
 * Renderiza o painel principal do gerente, incluindo resumo financeiro e tabela de funcionários.
 */
function renderManagerDashboard() {
  renderStockInfo(); // Atualiza Card de Estoque (Dinâmico)

  // Resumo financeiro
  const totalGross = appState.totalCash || 0;
  const totalWithdrawn = (appState.cashWithdrawals || []).reduce(
    (acc, w) => acc + w.amount,
    0,
  );
  const balance = totalGross - totalWithdrawn;

  document.getElementById("total-money-display").innerText =
    formatCurrency(balance);
  document.getElementById("total-gross-display").innerText =
    formatCurrency(totalGross);
  document.getElementById("total-withdrawn-display").innerText =
    formatCurrency(totalWithdrawn);

  const tbody = document.getElementById("manager-table-body");
  tbody.innerHTML = "";

  const filterScheduledEl = document.getElementById("filter-scheduled");
  const filterScheduled = filterScheduledEl && filterScheduledEl.checked;
  let employeesToRender = [...appState.employees]; // Cria uma cópia para ordenar/filtrar

  // Se o filtro "Agendados" estiver ativo, filtra a lista
  if (filterScheduled) {
    employeesToRender = employeesToRender.filter(
      (e) => e.scheduleTs || e.scheduleDate, // Considera agendado se tiver qualquer um dos campos
    );
  }

  // Ordena os funcionários:
  // 1. Agendados primeiro, ordenados pelo timestamp do agendamento (mais próximo primeiro)
  // 2. Depois, não agendados, ordenados alfabeticamente pelo nome
  employeesToRender.sort((a, b) => {
    const aHasSchedule = a.scheduleTs || (a.scheduleDate ? parseDatetimeLocal(a.scheduleDate)?.ts : null);
    const bHasSchedule = b.scheduleTs || (b.scheduleDate ? parseDatetimeLocal(b.scheduleDate)?.ts : null);

    // Se ambos têm agendamento, ordena por data do agendamento
    if (aHasSchedule && bHasSchedule) return aHasSchedule - bHasSchedule;
    // Se 'a' tem agendamento e 'b' não, 'a' vem primeiro
    if (aHasSchedule && !bHasSchedule) return -1;
    // Se 'b' tem agendamento e 'a' não, 'b' vem primeiro
    if (!aHasSchedule && bHasSchedule) return 1;
    // Se nenhum tem agendamento, ordena por nome
    return a.name.localeCompare(b.name);
  });


  if (employeesToRender.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="text-center py-8 text-gray-400">Nenhum funcionário encontrado.</td></tr>';
    return;
  }

  employeesToRender.forEach((emp) => {
    const sales = emp.received || 0;
    const owner = emp.receivedOwner || 0;
    const day = emp.receivedDayUser || 0;

    const cSales = getColorClass(appState.bandConfig.sales.color);
    const cOwner = getColorClass(appState.bandConfig.owner.color);
    const cDay = getColorClass(appState.bandConfig.dayUser.color);

    let scheduleHtml = "";
    if (emp.scheduleDate || emp.scheduleTs) {
      // Prioriza o timestamp para garantir que a data seja sempre válida
      const ts = emp.scheduleTs || (emp.scheduleDate ? parseDatetimeLocal(emp.scheduleDate)?.ts : null);
      let d = null;
      if (ts) d = new Date(ts);
      else if (emp.scheduleDate) d = parseDatetimeLocal(emp.scheduleDate)?.dateObj;

      if (d) {
        const dateStr = d.toLocaleDateString("pt-BR");
        const timeStr = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const isExpired = d.getTime() < Date.now(); // Verifica se o agendamento já passou

        const badgeClass = isExpired
          ? "bg-red-50 text-red-700 border-red-200" // Estilo para agendamento vencido
          : "bg-orange-50 text-orange-700 border-orange-200"; // Estilo para agendamento futuro
        const icon = isExpired
          ? "fa-solid fa-clock-exclamation" // Ícone para agendamento vencido
          : "fa-regular fa-clock"; // Ícone para agendamento futuro

        scheduleHtml = `
          <div class="mt-1 flex items-center justify-center gap-2 text-xs ${badgeClass} py-1 px-2 rounded border">
            <i class="${icon}"></i> ${dateStr} às ${timeStr}
            <div class="flex items-center gap-2">
              <button onclick="sendWhatsApp(${emp.id})" class="bg-green-500 text-white px-2 py-0.5 rounded hover:bg-green-600 transition" title="Enviar no WhatsApp">
                <i class="fa-brands fa-whatsapp"></i>
              </button>
              <button onclick="removeSchedule(${emp.id})" class="bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600 transition" title="Remover Agendamento">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      }
    }

    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-50 transition";
    tr.innerHTML = `
      <td class="px-4 md:px-6 py-4 font-medium text-gray-900">${escapeHtml(emp.name)}</td>
      <td class="px-4 md:px-6 py-4 text-center text-gray-600 text-sm">
        <div>
          <span class="${cSales} font-bold" title="${appState.bandConfig.sales.name}">V: ${sales}</span> |
          <span class="${cOwner} font-bold" title="${appState.bandConfig.owner.name}">P: ${owner}</span> |
          <span class="${cDay} font-bold" title="${appState.bandConfig.dayUser.name}">D: ${day}</span>
        </div>
        ${scheduleHtml}
      </td>
      <td class="px-3 md:px-6 py-3 md:py-4">
        <div class="flex flex-wrap justify-center items-center gap-1">
          <button onclick="openSettleModal(${emp.id})" class="bg-green-600 text-white hover:bg-green-700 px-3 py-1.5 rounded shadow text-sm font-bold transition" title="Realizar Acerto">
            <i class="fa-solid fa-hand-holding-dollar"></i>
          </button>
          <button onclick="collectAllFromEmployee(${emp.id})" class="text-orange-500 hover:text-orange-700 p-1.5 rounded hover:bg-orange-50 transition" title="Recolher Todas as Pulseiras">
            <i class="fa-solid fa-box-archive"></i>
          </button>
          <button onclick="removeEmployee(${emp.id})" class="text-red-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 transition" title="Remover Funcionário">
            <i class="fa-solid fa-trash"></i>
          </button>
          <button onclick="openScheduleModal(${emp.id})" class="text-blue-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition" title="Agendar Acerto">
            <i class="fa-regular fa-calendar-check"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * Renderiza as informações de estoque nos cards de resumo.
 */
function renderStockInfo() {
  const container = document.getElementById("stock-info-container");
  if (!container) return;

  const threshold = appState.stockAlertThreshold || 0;

  const createRow = (key, count, icon) => {
    const conf = appState.bandConfig[key];
    const colorClass = getColorClass(conf.color);
    const isLow = threshold > 0 && count <= threshold;
    const alertBadge = isLow
      ? `<span class="pulse-warning ml-1" title="Estoque baixo!"><i class="fa-solid fa-triangle-exclamation text-sm"></i></span>`
      : "";
    return `
      <div class="flex justify-between items-center gap-4">
        <span class="text-sm font-bold ${colorClass}"><i class="fa-solid ${icon} mr-1"></i>${conf.name}:</span>
        <span class="text-lg font-bold ${isLow ? "text-red-500" : "text-gray-800"}">${count}${alertBadge}</span>
      </div>
    `;
  };

  container.innerHTML =
    createRow("sales", appState.centralStock, "fa-ticket") +
    createRow("owner", appState.stockOwner || 0, "fa-crown") +
    createRow("dayUser", appState.stockDayUser || 0, "fa-umbrella-beach");
}

/**
 * Renderiza as opções dos selects para tipos de pulseira (em distribuição/adição de estoque).
 */
function renderBandOptions() {
  const typeSelect = document.getElementById("distribute-type");
  const addStockSelect = document.getElementById("add-stock-type");

  const createOpts = () => `
    <option value="sales">${appState.bandConfig.sales.name} (${appState.bandConfig.sales.label})</option>
    <option value="owner">${appState.bandConfig.owner.name} (${appState.bandConfig.owner.label})</option>
    <option value="dayUser">${appState.bandConfig.dayUser.name} (${appState.bandConfig.dayUser.label})</option>
  `;

  const html = createOpts();
  if (typeSelect) typeSelect.innerHTML = html;
  if (addStockSelect) addStockSelect.innerHTML = html;
}

/**
 * Renderiza a lista de funcionários nos selects (ex: para distribuição).
 */
function renderEmployeeSelects() {
  const managerSelect = document.getElementById("distribute-select");
  if (!managerSelect) return;

  const currentManagerSel = managerSelect.value; // Salva a seleção atual para não perder

  const optionsHTML = appState.employees
    .map((emp) => `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`)
    .join("");

  managerSelect.innerHTML = '<option value="">Selecione...</option>' + optionsHTML;
  if (currentManagerSel) managerSelect.value = currentManagerSel; // Restaura a seleção
}


// --- HISTÓRICO DE ACERTOS (COM PAGINAÇÃO E BUSCA) ---

/**
 * Função wrapper para busca (reseta a página para 1).
 */
function searchHistory() {
  currentPage = 1;
  renderHistory();
}

/**
 * Navega entre as páginas do histórico.
 * @param {number} step - O passo da navegação (-1 para anterior, 1 para próxima).
 */
function changePage(step) {
  currentPage += step;
  renderHistory();
}

/**
 * Renderiza a tabela de histórico de acertos com paginação e filtro.
 */
function renderHistory() {
  const tbody = document.getElementById("history-table-body");
  const searchTermInput = document.getElementById("history-search");
  const searchTerm = searchTermInput ? searchTermInput.value.toLowerCase() : "";
  tbody.innerHTML = "";

  const filteredHistory = appState.history.filter((log) =>
    log.empName.toLowerCase().includes(searchTerm),
  );

  if (filteredHistory.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="text-center py-4 text-gray-400 text-sm">Nenhum registro encontrado.</td></tr>';
    document.getElementById("page-indicator").innerText = "Página 0 de 0";
    document.getElementById("btn-prev").disabled = true;
    document.getElementById("btn-next").disabled = true;
    return;
  }

  const totalPages = Math.ceil(filteredHistory.length / ITEMS_PER_PAGE);

  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedItems = filteredHistory.slice(startIndex, endIndex);

  paginatedItems.forEach((log) => {
    const tr = document.createElement("tr");
    tr.className = "text-sm text-gray-600 border-b";
    const detailsText = log.details
      ? `<div class="text-xs text-gray-400">${escapeHtml(log.details)}</div>`
      : "";
    tr.innerHTML = `
      <td class="px-4 py-3">${escapeHtml(log.date)}</td>
      <td class="px-4 py-3 font-medium">${escapeHtml(log.empName)}</td>
      <td class="px-4 py-3 text-center">${log.sold} ${detailsText}</td>
      <td class="px-4 py-3 text-right">
        <span class="text-green-600 font-bold">${formatCurrency(log.total)}</span>
        <button onclick="printReceipt(${log.id})" class="ml-2 text-gray-300 hover:text-gray-600 transition" title="Imprimir Recibo">
          <i class="fa-solid fa-print text-xs"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("page-indicator").innerText =
    `Página ${currentPage} de ${totalPages}`;
  document.getElementById("btn-prev").disabled = currentPage === 1;
  document.getElementById("btn-next").disabled = currentPage === totalPages;
}

// --- RELATÓRIOS E IMPRESSÃO ---

/**
 * Gera e imprime um relatório de fechamento geral.
 */
function printReport() {
  document.getElementById("print-title").innerText =
    "Relatório de Fechamento Geral";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  const totalGross = appState.totalCash || 0;
  const totalWithdrawn = (appState.cashWithdrawals || []).reduce(
    (acc, w) => acc + w.amount,
    0,
  );
  const balance = totalGross - totalWithdrawn;

  const pendingSales = appState.employees.reduce(
    (acc, emp) => acc + (emp.received || 0),
    0,
  );
  const pendingOwner = appState.employees.reduce(
    (acc, emp) => acc + (emp.receivedOwner || 0),
    0,
  );
  const pendingDay = appState.employees.reduce(
    (acc, emp) => acc + (emp.receivedDayUser || 0),
    0,
  );

  const nSales = appState.bandConfig.sales.name;
  const nOwner = appState.bandConfig.owner.name;
  const nDay = appState.bandConfig.dayUser.name;

  const withdrawalRows =
    (appState.cashWithdrawals || []).length === 0
      ? `<tr><td colspan="3" class="p-2 text-center text-gray-400 text-xs">Nenhuma retirada registrada.</td></tr>`
      : [...(appState.cashWithdrawals || [])]
          .reverse()
          .map(
            (w) => `
        <tr>
          <td class="p-2 border text-xs">${escapeHtml(w.date)}</td>
          <td class="p-2 border text-xs">${escapeHtml(w.description)}</td>
          <td class="p-2 border text-right font-bold text-xs">${formatCurrency(w.amount)}</td>
        </tr>`,
          )
          .join("");

  const employeeRows =
    appState.employees.length === 0
      ? `<tr><td colspan="5" class="p-2 text-center text-gray-400 text-xs">Nenhum funcionário cadastrado.</td></tr>`
      : appState.employees
          .map((emp) => {
            const s = emp.received || 0;
            const o = emp.receivedOwner || 0;
            const d = emp.receivedDayUser || 0;
            const total = s + o + d;
            const status =
              total === 0
                ? `<span style="color:#16a34a;font-weight:bold;">✔ Acertado</span>`
                : `<span style="color:#dc2626;font-weight:bold;">⚠ Pendente</span>`;
            return `
          <tr>
            <td class="p-2 border text-xs">${escapeHtml(emp.name)}</td>
            <td class="p-2 border text-center text-xs">${s}</td>
            <td class="p-2 border text-center text-xs">${o}</td>
            <td class="p-2 border text-center text-xs">${d}</td>
            <td class="p-2 border text-center text-xs">${status}</td>
          </tr>`;
          })
          .join("");

  const htmlContent = `
    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">1. Resumo Financeiro</h2>
      <table class="w-full text-sm text-left border border-gray-300 mb-3">
        <tbody>
          <tr class="bg-gray-50">
            <td class="p-2 border text-gray-500">Caixa Bruto (acertos realizados)</td>
            <td class="p-2 border text-right font-bold">${formatCurrency(totalGross)}</td>
          </tr>
          <tr>
            <td class="p-2 border text-gray-500">Total de Retiradas</td>
            <td class="p-2 border text-right font-bold text-red-600">- ${formatCurrency(totalWithdrawn)}</td>
          </tr>
          <tr style="background:#f0fdf4;">
            <td class="p-2 border font-bold">Saldo em Caixa</td>
            <td class="p-2 border text-right font-bold text-green-700" style="font-size:1.2rem;">${formatCurrency(balance)}</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="p-2 border text-gray-500">Preço Unitário (Venda)</td>
            <td class="p-2 border text-right">${formatCurrency(appState.pricePerUnit)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">2. Retiradas do Caixa</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Data</th>
            <th class="p-2 border">Descrição</th>
            <th class="p-2 border text-right">Valor</th>
          </tr>
        </thead>
        <tbody>${withdrawalRows}</tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">3. Posição de Estoque Central</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Local</th>
            <th class="p-2 border text-right">Quantidade</th>
          </tr>
        </thead>
        <tbody>
          <tr><td class="p-2 border">Estoque Central — ${nSales}</td><td class="p-2 border text-right font-bold">${appState.centralStock}</td></tr>
          <tr><td class="p-2 border">Estoque Central — ${nOwner}</td><td class="p-2 border text-right font-bold">${appState.stockOwner || 0}</td></tr>
          <tr><td class="p-2 border">Estoque Central — ${nDay}</td><td class="p-2 border text-right font-bold">${appState.stockDayUser || 0}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nSales}</td><td class="p-2 border text-right font-bold">${pendingSales}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nOwner}</td><td class="p-2 border text-right font-bold">${pendingOwner}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nDay}</td><td class="p-2 border text-right font-bold">${pendingDay}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">4. Situação dos Funcionários</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Funcionário</th>
            <th class="p-2 border text-center">${nSales}</th>
            <th class="p-2 border text-center">${nOwner}</th>
            <th class="p-2 border text-center">${nDay}</th>
            <th class="p-2 border text-center">Status</th>
          </tr>
        </thead>
        <tbody>${employeeRows}</tbody>
      </table>
    </div>
  `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/**
 * Abre o modal de histórico de estoque.
 */
function openStockHistoryModal() {
  document.getElementById("stock-history-start").value = "";
  document.getElementById("stock-history-end").value = "";
  renderStockHistoryTable();
  document.getElementById("stock-history-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de histórico de estoque.
 */
function closeStockHistoryModal() {
  document.getElementById("stock-history-modal").classList.add("hidden");
}

/**
 * Limpa os filtros de data no histórico de estoque e re-renderiza.
 */
function clearStockHistoryFilter() {
  document.getElementById("stock-history-start").value = "";
  document.getElementById("stock-history-end").value = "";
  renderStockHistoryTable();
}

/**
 * Renderiza a tabela do histórico de estoque com filtros de data.
 */
function renderStockHistoryTable() {
  const tbody = document.getElementById("stock-history-table-body");
  tbody.innerHTML = "";

  const startInput = document.getElementById("stock-history-start").value;
  const endInput = document.getElementById("stock-history-end").value;

  let filteredLogs = appState.stockLogs;

  if (startInput || endInput) {
    const startDate = startInput
      ? new Date(startInput + "T00:00:00").getTime()
      : 0;
    const endDate = endInput
      ? new Date(endInput + "T23:59:59").getTime()
      : Date.now();

    filteredLogs = appState.stockLogs.filter((log) => {
      // log.id é o timestamp em addStockLog
      return log.id >= startDate && log.id <= endDate;
    });
  }

  if (!filteredLogs || filteredLogs.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="text-center py-4 text-gray-400">Nenhum registro encontrado para o filtro aplicado.</td></tr>';
  } else {
    filteredLogs.forEach((log) => {
      const colorClass = log.amount > 0 ? "text-green-600" : "text-red-600";
      const icon = log.amount > 0 ? "+" : "";
      const tr = document.createElement("tr");
      tr.className = "hover:bg-gray-50 border-b last:border-0";
      tr.innerHTML = `
        <td class="px-4 py-3 text-gray-600 text-sm">${escapeHtml(log.date)}</td>
        <td class="px-4 py-3 font-bold text-gray-800 text-sm">${escapeHtml(log.item)}</td>
        <td class="px-4 py-3 text-gray-600 text-sm">${escapeHtml(log.action)}</td>
        <td class="px-4 py-3 text-gray-500 text-xs">${escapeHtml(log.details)}</td>
        <td class="px-4 py-3 text-right font-bold ${colorClass} text-sm">${icon}${log.amount}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

/**
 * Imprime o histórico de movimentação de estoque com filtros de data.
 */
function printStockHistory() {
  document.getElementById("print-title").innerText =
    "Extrato de Movimentação de Estoque";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  const startInput = document.getElementById("stock-history-start").value;
  const endInput = document.getElementById("stock-history-end").value;

  let filteredLogs = appState.stockLogs;
  let periodText = "Completo";

  if (startInput || endInput) {
    const startDate = startInput
      ? new Date(startInput + "T00:00:00").getTime()
      : 0;
    const endDate = endInput
      ? new Date(endInput + "T23:59:59").getTime()
      : Date.now();

    filteredLogs = appState.stockLogs.filter((log) => {
      return log.id >= startDate && log.id <= endDate;
    });

    const startFormatted = startInput
      ? startInput.split("-").reverse().join("/")
      : "Início";
    const endFormatted = endInput
      ? endInput.split("-").reverse().join("/")
      : "Hoje";
    periodText = `${startFormatted} a ${endFormatted}`;
  }

  if (!filteredLogs || filteredLogs.length === 0) {
    showToast(
      "Não há movimentações para imprimir no período selecionado.",
      "warning",
    );
    return;
  }

  let rowsHtml = filteredLogs
    .map((log) => {
      const colorClass = log.amount > 0 ? "text-green-600" : "text-red-600";
      const icon = log.amount > 0 ? "+" : "";
      return `
        <tr>
            <td class="p-2 border text-xs">${log.date}</td>
            <td class="p-2 border font-bold">${log.item}</td>
            <td class="p-2 border">${log.action}</td>
            <td class="p-2 border text-gray-500 text-xs">${log.details}</td>
            <td class="p-2 border text-right font-bold ${colorClass}">${icon}${log.amount}</td>
        </tr>
        `;
    })
    .join("");

  const htmlContent = `
        <div class="mb-4">
            <h3 class="font-bold mb-2 text-gray-700">Movimentações do Cofre</h3>
            <p class="text-sm"><strong>Período do Filtro:</strong> ${periodText}</p>
        </div>
        <table class="w-full text-sm text-left border border-gray-300">
            <thead class="bg-gray-200">
                <tr><th class="p-2 border">Data</th><th class="p-2 border">Item</th><th class="p-2 border">Ação</th><th class="p-2 border">Detalhes</th><th class="p-2 border text-right">Qtd.</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/**
 * Gera e imprime um relatório de acertos por período.
 */
function printPeriodReport() {
  const startInput = document.getElementById("report-start").value;
  const endInput = document.getElementById("report-end").value;

  if (!startInput || !endInput) {
    showToast("Selecione as datas de início e fim para o relatório.", "warning");
    return;
  }

  const startDate = new Date(startInput + "T00:00:00").getTime();
  const endDate = new Date(endInput + "T23:59:59").getTime();

  const filteredLogs = appState.history.filter(
    (log) => log.id >= startDate && log.id <= endDate,
  );

  const totalSoldPeriod = filteredLogs.reduce((acc, log) => acc + log.sold, 0);
  const totalCashPeriod = filteredLogs.reduce((acc, log) => acc + log.total, 0);

  document.getElementById("print-title").innerText = "Relatório por Período";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  let rowsHtml = filteredLogs
    .map(
      (log) => `
        <tr>
            <td class="p-2 border">${escapeHtml(log.date)}</td>
            <td class="p-2 border">${escapeHtml(log.empName)}</td>
            <td class="p-2 border text-center">${log.sold}</td>
            <td class="p-2 border text-right">${formatCurrency(log.total)}</td>
        </tr>
    `,
    )
    .join("");

  if (filteredLogs.length === 0)
    rowsHtml =
      '<tr><td colspan="4" class="p-4 text-center text-gray-500">Nenhum registro neste período.</td></tr>';

  const htmlContent = `
        <div class="mb-6 bg-gray-100 p-4 rounded border border-gray-300">
            <p class="text-sm"><strong>Período:</strong> ${startInput.split("-").reverse().join("/")} até ${endInput.split("-").reverse().join("/")}</p>
            <p class="text-sm mt-1"><strong>Total Vendido:</strong> ${totalSoldPeriod} pulseiras</p>
            <p class="text-xl font-bold mt-2 text-green-700">Total Arrecadado: ${formatCurrency(totalCashPeriod)}</p>
        </div>

        <h3 class="font-bold mb-2">Detalhamento das Transações</h3>
        <table class="w-full text-sm text-left border border-gray-300">
            <thead class="bg-gray-200">
                <tr><th class="p-2 border">Data/Hora</th><th class="p-2 border">Funcionário</th><th class="p-2 border text-center">Qtd.</th><th class="p-2 border text-right">Valor</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/**
 * Exporta o histórico de acertos para um arquivo CSV.
 */
function exportHistoryToCSV() {
  if (appState.history.length === 0) {
    showToast("Não há dados no histórico para exportar.", "warning");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; // Adiciona BOM para garantir UTF-8 no Excel
  csvContent += "Data/Hora;Funcionário;Qtd Vendida;Detalhes;Total (R$)\n";

  appState.history.forEach((log) => {
    // Remove pipes e quebras de linha para não quebrar a formatação do CSV
    const detailsClean = log.details ? log.details.replace(/\|/g, "-").replace(/\\n/g, " ") : "";
    const row = `${log.date};"${log.empName}";${log.sold};"${detailsClean}";${log.total.toFixed(2).replace(".", ",")}`;
    csvContent += row + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute(
    "download",
    `historico_vendas_${new Date().toISOString().slice(0, 10)}.csv`,
  );
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("Histórico exportado para CSV!", "success");
}

// --- BACKUP E DADOS ---

/**
 * Exporta todos os dados do aplicativo para um arquivo JSON de backup.
 */
function exportData() {
  const dataStr = JSON.stringify(appState, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `pulso_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Backup dos dados realizado com sucesso!", "success");
}

/**
 * Importa dados de um arquivo JSON de backup, substituindo o estado atual.
 */
function importData(input) {
  const file = input.files[0];
  if (!file) {
    showToast("Nenhum arquivo selecionado para importação.", "warning");
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = JSON.parse(e.target.result);
      // Validação básica para garantir que é um arquivo de backup válido
      if (data.centralStock !== undefined && Array.isArray(data.employees) && data.bandConfig) {
        appState = data; // Substitui o estado atual
        // Após carregar, aplicar migração de timestamps se necessário (para compatibilidade)
        appState.employees.forEach((emp) => {
            if (emp && emp.scheduleDate && emp.scheduleTs === undefined) {
                const dtParsed = parseDatetimeLocal(emp.scheduleDate);
                if (dtParsed) emp.scheduleTs = dtParsed.ts;
            }
            if (emp && emp.phone === undefined) {
                emp.phone = "";
            }
        });
        await saveToDB(); // Persiste os dados importados no IndexedDB
        showToast("Backup restaurado com sucesso! Recarregando a página...", "success");
        setTimeout(() => location.reload(), 1500); // Recarrega para aplicar o novo estado
      } else {
        showToast("Arquivo de backup inválido. Formato inesperado.", "error");
      }
    } catch (err) {
      console.error("Erro ao ler/parsear arquivo de backup:", err);
      showToast("Erro ao processar o arquivo de backup. Verifique o formato.", "error");
    }
  };
  reader.readAsText(file);
  input.value = ""; // Limpa o input para permitir selecionar o mesmo arquivo novamente
}

/**
 * Reseta o sistema, apagando todos os dados. Requer confirmação.
 */
async function resetSystem() {
  if (
    await showConfirm(
      "ATENÇÃO: Isso apagará TODOS os dados do sistema e o histórico! Esta ação é irreversível. Tem certeza?",
      {
        type: "danger",
        title: "Zerar Sistema",
        confirmText: "Sim, apagar tudo permanentemente",
        cancelText: "Cancelar",
      },
    )
  ) {
    if (db) {
      try {
        await db.clear(DB_STORE); // Limpa a object store
      } catch (err) {
        console.error("[IndexedDB] Falha ao apagar dados:", err);
      }
    }
    localStorage.removeItem(STORAGE_KEY); // Remove legados (se houver)
    localStorage.removeItem(STORAGE_KEY + "_emergency"); // Remove fallback (se houver)
    location.reload(); // Recarrega a página para iniciar com um estado limpo
  }
}

// --- UTILITÁRIOS & UI HELPERS ---

/**
 * Exibe uma notificação toast estilizada que desaparece automaticamente.
 * Pode incluir um botão de ação "Desfazer".
 * @param {string} message - Mensagem a exibir.
 * @param {'success'|'error'|'warning'|'info'} [type='info'] - Tipo do toast.
 * @param {string} [actionText=null] - Texto do botão de ação (ex: "Desfazer").
 * @param {Function} [actionCallback=null] - Função a ser chamada ao clicar no botão de ação.
 */
function showToast(
  message,
  type = "info",
  actionText = null,
  actionCallback = null,
) {
  const container = document.getElementById("toast-container");
  if (!container) {
    console.warn("Toast container not found. Message:", message);
    return;
  }

  const toast = document.createElement("div");
  toast.className =
    "toast-item pointer-events-auto bg-white rounded-lg shadow-lg p-3 border-l-4 flex items-center justify-between gap-3";

  const colors = {
    success: {
      border: "border-green-500",
      bg: "bg-green-100",
      icon: "fa-circle-check text-green-600",
    },
    error: {
      border: "border-red-500",
      bg: "bg-red-100",
      icon: "fa-circle-xmark text-red-600",
    },
    warning: {
      border: "border-yellow-500",
      bg: "bg-yellow-100",
      icon: "fa-triangle-exclamation text-yellow-600",
    },
    info: {
      border: "border-blue-500",
      bg: "bg-blue-100",
      icon: "fa-circle-info text-blue-600",
    },
  };

  const config = colors[type] || colors.info;
  toast.classList.add(config.border);

  let actionHtml = "";
  if (actionText && typeof actionCallback === "function") {
    actionHtml = `<button class="ml-2 text-sm px-2 py-1 bg-gray-100 rounded hover:bg-gray-200" id="toast-action-btn">${escapeHtml(actionText)}</button>`;
  }

  toast.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-full ${config.bg} flex items-center justify-center">
        <i class="fa-solid ${config.icon}"></i>
      </div>
      <p class="text-sm text-gray-700 flex-1 leading-relaxed">${escapeHtml(message)}</p>
    </div>
    ${actionHtml}
  `;

  container.appendChild(toast);

  if (actionText && typeof actionCallback === "function") {
    const btn = toast.querySelector("#toast-action-btn");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // Previne que o clique feche outros toasts
        try {
          actionCallback();
        } catch (err) {
          console.error("Erro ao executar ação do toast:", err);
        }
        toast.remove(); // Remove o toast imediatamente após a ação
      });
    }
  }

  // Animação de entrada
  setTimeout(() => toast.classList.add("toast-visible"), 10);

  // Auto-esconder após 5 segundos (se não houver um botão de ação clicado)
  const AUTO_HIDE_MS = 5000;
  setTimeout(() => {
    if (!toast.parentElement) return; // Garante que o toast ainda está no DOM
    toast.classList.add("toast-hiding");
    setTimeout(() => {
      try {
        toast.remove();
      } catch (e) {
        console.warn("Erro ao remover toast já desaparecido:", e);
      }
    }, 300); // Tempo da transição CSS
  }, AUTO_HIDE_MS);
}

/**
 * Exibe um modal de confirmação customizado.
 * @param {string} message - Mensagem principal.
 * @param {object} options - { title, type: 'danger'|'warning'|'info', confirmText, cancelText }.
 * @returns {Promise<boolean>} - true se confirmado, false se cancelado.
 */
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const title = document.getElementById("confirm-modal-title");
    const messageEl = document.getElementById("confirm-modal-message");
    const iconWrap = document.getElementById("confirm-icon-wrap");
    const iconI = document.getElementById("confirm-icon-i");
    const okBtn = document.getElementById("confirm-ok-btn");
    const cancelBtn = document.getElementById("confirm-cancel-btn");
    const closeBtn = modal.querySelector(".fa-xmark"); // Botão de fechar (X)

    if (!modal || !title || !messageEl || !iconWrap || !iconI || !okBtn || !cancelBtn) {
      console.error("Elementos do modal de confirmação não encontrados.");
      resolve(false);
      return;
    }

    const type = options.type || "warning";
    const configs = {
      danger: {
        wrapBg: "bg-red-100",
        icon: "fa-triangle-exclamation text-red-600",
        btnBg: "bg-red-600 hover:bg-red-700",
      },
      warning: {
        wrapBg: "bg-yellow-100",
        icon: "fa-exclamation-circle text-yellow-600",
        btnBg: "bg-yellow-600 hover:bg-yellow-700",
      },
      info: {
        wrapBg: "bg-blue-100",
        icon: "fa-circle-info text-blue-600",
        btnBg: "bg-blue-600 hover:bg-blue-700",
      },
    };

    const config = configs[type] || configs.warning;

    title.textContent = options.title || "Confirmação";
    messageEl.textContent = message;
    okBtn.textContent = options.confirmText || "Confirmar";
    cancelBtn.textContent = options.cancelText || "Cancelar";

    iconWrap.className = `mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3 ${config.wrapBg}`;
    iconI.className = `fa-solid text-xl ${config.icon}`;
    okBtn.className = `flex-1 px-4 py-2 text-white rounded-lg font-bold shadow transition ${config.btnBg}`;
    cancelBtn.className = `flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-bold transition`; // Garante classes padrão

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null; // Limpa o handler do botão de fechar
    };

    okBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    if (closeBtn) {
      closeBtn.onclick = () => {
        cleanup();
        resolve(false); // Fechar também resolve como false (cancelado)
      };
    }

    modal.classList.remove("hidden");
  });
}

/**
 * Escapa caracteres HTML para evitar XSS.
 * @param {string} str - A string a ser escapada.
 * @returns {string} - A string escapada.
 */
function escapeHtml(str) {
  if (typeof str !== "string") return String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Formata um valor numérico para a moeda brasileira (BRL).
 * @param {number} value - O valor a ser formatado.
 * @returns {string} - O valor formatado como moeda.
 */
function formatCurrency(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Retorna a classe CSS de cor para um nome de cor (compatível com Tailwind).
 * @param {string} colorName - O nome da cor (ex: 'blue', 'azul').
 * @returns {string} - A classe CSS correspondente.
 */
function getColorClass(colorName) {
  const map = {
    blue: "text-blue-600",
    red: "text-red-600",
    green: "text-green-600",
    yellow: "text-yellow-600",
    purple: "text-purple-600",
    orange: "text-orange-600",
    pink: "text-pink-600",
    gray: "text-gray-600",
    // Português e Novas Cores
    azul: "text-blue-600",
    vermelho: "text-red-600",
    verde: "text-green-600",
    amarelo: "text-yellow-600",
    roxo: "text-purple-600",
    laranja: "text-orange-600",
    rosa: "text-pink-600",
    cinza: "text-gray-600",
    preto: "text-gray-900",
  };
  return map[colorName] || map.azul; // Padrão 'azul' se a cor não for encontrada
}

// --- CONFIGURAÇÃO DE CORES DAS PULSEIRAS ---

/**
 * Abre o modal de configuração de nomes e cores das pulseiras.
 */
function openConfigModal() {
  const container = document.getElementById("config-rows");
  container.innerHTML = ""; // Limpa para reconstruir

  const colors = [
    "azul", "vermelho", "verde", "amarelo", "roxo",
    "laranja", "rosa", "cinza", "preto",
  ];

  const legacyMap = { // Para compatibilidade com cores salvas em inglês
    blue: "azul", red: "vermelho", green: "verde", yellow: "amarelo",
    purple: "roxo", orange: "laranja", pink: "rosa", gray: "cinza",
  };

  const types = [
    { key: "sales", title: "Tipo 1 (Padrão: Venda)" },
    { key: "owner", title: "Tipo 2 (Padrão: Proprietário)" },
    { key: "dayUser", title: "Tipo 3 (Padrão: Day User)" },
  ];

  types.forEach((t) => {
    const conf = appState.bandConfig[t.key];

    let currentColor = conf.color;
    if (legacyMap[currentColor]) currentColor = legacyMap[currentColor]; // Converte legado

    const colorOptions = colors
      .map(
        (c) =>
          `<option value="${c}" ${currentColor === c ? "selected" : ""}>${c.toUpperCase()}</option>`,
      )
      .join("");

    const row = document.createElement("div");
    row.className = "bg-gray-50 p-3 rounded border";
    row.innerHTML = `
            <p class="text-xs font-bold text-gray-500 uppercase mb-2">${t.title}</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <label for="cfg-name-${t.key}" class="block text-xs text-gray-400">Nome (Ex: Venda)</label>
                    <input type="text" id="cfg-name-${t.key}" value="${escapeHtml(conf.name)}" class="w-full border rounded px-2 py-1 text-sm">
                </div>
                <div>
                    <label for="cfg-label-${t.key}" class="block text-xs text-gray-400">Rótulo (Ex: Azul)</label>
                    <input type="text" id="cfg-label-${t.key}" value="${escapeHtml(conf.label)}" class="w-full border rounded px-2 py-1 text-sm">
                </div>
                <div>
                    <label for="cfg-color-${t.key}" class="block text-xs text-gray-400">Cor do Ícone</label>
                    <select id="cfg-color-${t.key}" class="w-full border rounded px-2 py-1 text-sm bg-white">
                        ${colorOptions}
                    </select>
                </div>
            </div>
        `;
    container.appendChild(row);
  });

  document.getElementById("config-modal").classList.remove("hidden");
}

function closeConfigModal() {
  document.getElementById("config-modal").classList.add("hidden");
}

function saveConfig() {
  const keys = ["sales", "owner", "dayUser"];
  keys.forEach((key) => {
    appState.bandConfig[key].name = document.getElementById(
      `cfg-name-${key}`,
    ).value;
    appState.bandConfig[key].label = document.getElementById(
      `cfg-label-${key}`,
    ).value;
    appState.bandConfig[key].color = document.getElementById(
      `cfg-color-${key}`,
    ).value;
  });
  saveData();
  closeConfigModal();
  showToast("Configurações de pulseira salvas com sucesso!", "success");
}

// --- FECHAR CAIXA (RETIRADAS) ---

/**
 * Abre o modal para registrar uma retirada do caixa.
 */
function openCashWithdrawalModal() {
  document.getElementById("withdrawal-amount").value = "";
  document.getElementById("withdrawal-desc").value = "";
  document.getElementById("cash-withdrawal-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de retirada do caixa.
 */
function closeCashWithdrawalModal() {
  document.getElementById("cash-withdrawal-modal").classList.add("hidden");
}

// --- HISTÓRICO DE RETIRADAS ---

/**
 * Abre o modal de histórico de retiradas do caixa.
 */
function openWithdrawalHistoryModal() {
  renderWithdrawalHistory();
  document.getElementById("withdrawal-history-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de histórico de retiradas.
 */
function closeWithdrawalHistoryModal() {
  document.getElementById("withdrawal-history-modal").classList.add("hidden");
}

/**
 * Renderiza a tabela do histórico de retiradas.
 */
function renderWithdrawalHistory() {
  const tbody = document.getElementById("withdrawal-history-tbody");
  const withdrawals = appState.cashWithdrawals || [];
  tbody.innerHTML = "";

  if (withdrawals.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="text-center py-8 text-gray-400 text-sm">' +
      '<i class="fa-solid fa-inbox text-2xl block mb-2 mx-auto"></i>' +
      "Nenhuma retirada registrada.</td></tr>";
    document.getElementById("withdrawal-total-display").innerText =
      formatCurrency(0);
    return;
  }

  // Exibe do mais recente para o mais antigo
  const sorted = [...withdrawals].reverse();

  tbody.innerHTML = sorted
    .map(
      (w) => `
      <tr class="hover:bg-gray-50 border-b text-sm transition">
        <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${escapeHtml(w.date)}</td>
        <td class="px-4 py-3 text-gray-700">${escapeHtml(w.description)}</td>
        <td class="px-4 py-3 text-right font-bold text-red-600 whitespace-nowrap">${formatCurrency(w.amount)}</td>
        <td class="px-3 py-3 text-center">
          <button
            onclick="deleteWithdrawal(${w.id})"
            class="text-gray-300 hover:text-red-500 transition"
            title="Remover esta retirada"
          >
            <i class="fa-solid fa-trash text-xs"></i>
          </button>
        </td>
      </tr>`,
    )
    .join("");

  const total = withdrawals.reduce((acc, w) => acc + w.amount, 0);
  document.getElementById("withdrawal-total-display").innerText =
    formatCurrency(total);
}

/**
 * Exclui uma retirada do caixa após confirmação.
 */
async function deleteWithdrawal(id) {
  const w = (appState.cashWithdrawals || []).find((w) => w.id === id);
  if (!w) return;

  if (
    !(await showConfirm(
      `Remover a retirada de ${formatCurrency(w.amount)} (${escapeHtml(w.description)})? O valor voltará ao saldo do caixa.`,
      { type: "warning", title: "Remover Retirada" },
    ))
  )
    return;

  appState.cashWithdrawals = appState.cashWithdrawals.filter(
    (withdrawal) => withdrawal.id !== id,
  );
  saveData();
  renderWithdrawalHistory();
  showToast("Retirada removida e saldo ajustado.", "success");
}

/**
 * Confirma e registra uma nova retirada do caixa.
 */
function confirmCashWithdrawal() {
  const amount = parseFloat(document.getElementById("withdrawal-amount").value);
  const desc = document.getElementById("withdrawal-desc").value.trim();

  if (isNaN(amount) || amount <= 0) {
    showToast("Informe um valor válido e positivo para a retirada.", "error");
    return;
  }

  const totalWithdrawn = (appState.cashWithdrawals || []).reduce(
    (acc, w) => acc + w.amount,
    0,
  );
  const balance = (appState.totalCash || 0) - totalWithdrawn;

  if (amount > balance) {
    showToast(
      `O valor da retirada (${formatCurrency(amount)}) não pode ser maior que o saldo disponível (${formatCurrency(balance)}).`,
      "error",
    );
    return;
  }

  if (!appState.cashWithdrawals) appState.cashWithdrawals = [];
  appState.cashWithdrawals.push({
    id: Date.now(),
    date: new Date().toLocaleString("pt-BR"),
    amount: amount,
    description: desc || "Retirada",
  });

  closeCashWithdrawalModal();
  saveData();
  showToast(
    `Retirada de ${formatCurrency(amount)} registrada com sucesso!`,
    "success",
  );
}

// --- RECIBO INDIVIDUAL POR ACERTO ---

/**
 * Prepara e imprime um recibo individual de acerto.
 */
function printReceipt(historyId) {
  const log = appState.history.find((h) => h.id === historyId);
  if (!log) {
    showToast("Detalhes do acerto não encontrados para o recibo.", "error");
    return;
  }

  document.getElementById("print-title").innerText = "Recibo de Acerto";
  document.getElementById("print-date").innerText = log.date;

  const nSales = appState.bandConfig.sales.name;
  const nOwner = appState.bandConfig.owner.name;
  const nDay = appState.bandConfig.dayUser.name;
  const price =
    log.pricePerUnit !== undefined ? log.pricePerUnit : appState.pricePerUnit;

  let tableRows = "";
  if (log.recSales !== undefined) {
    tableRows = `
      <tr>
        <td class="p-2 border">${escapeHtml(nSales)}</td>
        <td class="p-2 border text-center">${log.recSales}</td>
        <td class="p-2 border text-center">${log.retSales}</td>
        <td class="p-2 border text-center font-bold">${log.soldCount}</td>
        <td class="p-2 border text-right font-bold">${formatCurrency(log.soldCount * price)}</td>
      </tr>
      <tr>
        <td class="p-2 border">${escapeHtml(nOwner)}</td>
        <td class="p-2 border text-center">${log.recOwner}</td>
        <td class="p-2 border text-center">${log.retOwner}</td>
        <td class="p-2 border text-center">${log.usedOwner}</td>
        <td class="p-2 border text-right text-gray-400">—</td>
      </tr>
      <tr>
        <td class="p-2 border">${escapeHtml(nDay)}</td>
        <td class="p-2 border text-center">${log.recDay}</td>
        <td class="p-2 border text-center">${log.retDay}</td>
        <td class="p-2 border text-center">${log.usedDay}</td>
        <td class="p-2 border text-right text-gray-400">—</td>
      </tr>`;
  } else {
    tableRows = `<tr><td colspan="5" class="p-3 text-center text-gray-500 text-sm">Detalhes: ${escapeHtml(log.details || "N/A")}</td></tr>`;
  }

  const htmlContent = `
    <div class="border-2 border-gray-300 rounded p-6 mb-6">
      <div class="grid grid-cols-2 gap-3 text-sm mb-5 pb-4 border-b border-gray-200">
        <div><strong>Funcionário:</strong> ${escapeHtml(log.empName)}</div>
        <div><strong>Data / Hora:</strong> ${escapeHtml(log.date)}</div>
        <div><strong>Preço Unit. (Venda):</strong> ${formatCurrency(price)}</div>
      </div>
      <table class="w-full text-sm text-left border border-gray-300 mb-5">
        <thead class="bg-gray-200">
          <tr>
            <th class="p-2 border">Tipo</th>
            <th class="p-2 border text-center">Recebeu</th>
            <th class="p-2 border text-center">Devolveu</th>
            <th class="p-2 border text-center">Usado</th>
            <th class="p-2 border text-right">Valor</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div class="flex justify-between items-center border-t-2 border-gray-800 pt-4">
        <span class="text-xl font-bold">TOTAL A PAGAR:</span>
        <span class="text-4xl font-bold text-green-700">${formatCurrency(log.total)}</span>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-16 mt-16">
      <div class="border-t border-black pt-3 text-center text-sm text-gray-600">Assinatura do Funcionário</div>
      <div class="border-t border-black pt-3 text-center text-sm text-gray-600">Assinatura do Responsável</div>
    </div>`;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

// --- GRÁFICOS ---

/**
 * Renderiza os gráficos de ranking de vendas e evolução do caixa.
 */
function renderCharts() {
  // Destrói instâncias anteriores para evitar erro "canvas already in use"
  Object.values(chartInstances).forEach((c) => c.destroy());
  chartInstances = {};

  const chartSection = document.getElementById("charts-section");
  if (!chartSection) return;

  if (appState.history.length === 0) {
    chartSection.classList.add("hidden");
    return;
  }
  chartSection.classList.remove("hidden");

  // --- Gráfico 1: Ranking de vendas por funcionário ---
  const empSalesMap = {};
  appState.history.forEach((log) => {
    empSalesMap[log.empName] = (empSalesMap[log.empName] || 0) + log.sold;
  });
  const sortedEntries = Object.entries(empSalesMap).sort(
    ([, a], [, b]) => b - a,
  );
  const empLabels = sortedEntries.map(([name]) => name);
  const empData = sortedEntries.map(([, val]) => val);

  const ctxEmp = document.getElementById("chart-employees");
  if (ctxEmp) {
    chartInstances.employees = new Chart(ctxEmp, {
      type: "bar",
      data: {
        labels: empLabels,
        datasets: [
          {
            label: "Pulseiras Vendidas",
            data: empData,
            backgroundColor: "rgba(79, 70, 229, 0.7)",
            borderColor: "rgba(79, 70, 229, 1)",
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    });
  }

  // --- Gráfico 2: Evolução do caixa ao longo do tempo ---
  const cashHistory = [...appState.history].reverse(); // do mais antigo ao mais recente
  let running = 0;
  const cashPoints = cashHistory.map((log) => {
    running += log.total;
    return parseFloat(running.toFixed(2));
  });
  const cashLabels = cashHistory.map((log) => {
    const parts = log.date.split(",");
    return parts[0]; // apenas a data
  });

  const ctxCash = document.getElementById("chart-cash");
  if (ctxCash) {
    chartInstances.cash = new Chart(ctxCash, {
      type: "line",
      data: {
        labels: cashLabels,
        datasets: [
          {
            label: "Caixa Acumulado (R$)",
            data: cashPoints,
            borderColor: "rgba(22, 163, 74, 1)",
            backgroundColor: "rgba(22, 163, 74, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (val) =>
                `R$ ${val.toLocaleString("pt-BR", { minimumFractionDigits: 0 })}`,
            },
          },
        },
      },
    });
  }
}

// --- ALERTA DE ESTOQUE ---

/**
 * Atualiza o limite de alerta de estoque.
 */
function updateStockAlertThreshold() {
  const input = document.getElementById("stock-alert-threshold");
  const val = parseInt(input.value, 10);
  if (!isNaN(val) && val >= 0) {
    appState.stockAlertThreshold = val;
    saveData();
    showToast("Limite de alerta de estoque atualizado!", "success");
  } else {
    showToast("Informe um valor numérico positivo para o limite de alerta.", "error");
  }
}

// Iniciar App: Adicionamos um listener para garantir que o DOM carregou antes de rodar
document.addEventListener("DOMContentLoaded", init);
