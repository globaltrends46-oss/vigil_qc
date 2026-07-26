// ==================== GLOBAL SECURITY INTERCEPTOR (DEVICE LOCK & CLOUD KILL-SWITCH) ====================
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const hwFromUrl = urlParams.get('hw_uuid');
  if (hwFromUrl) {
    localStorage.setItem('vigil_hardware_uuid', hwFromUrl);
  }
  
  const getHardwareUuid = () => {
    return localStorage.getItem('vigil_hardware_uuid') || 'MOCK-BROWSER-UUID-77777';
  };

  function handleLockout(message) {
    localStorage.clear();
    sessionStorage.clear();
    
    // Replace whole document with un-bypassable lock screen
    document.body.innerHTML = `
      <div style="background-color:#ffebee; color:#b71c1c; border: 5px solid #b71c1c; padding: 40px; margin: 100px auto; max-width: 600px; font-family: monospace; text-align: center; box-shadow: 10px 10px 0px #000;">
        <h1 style="font-size: 40px; margin-bottom: 20px; font-weight: bold;">🛑 ACCESS SECURITY EXCLUSION</h1>
        <p style="font-size: 18px; font-weight: bold; line-height: 1.6;">${message}</p>
        <div style="margin-top: 30px; border-top: 2px dashed #b71c1c; padding-top: 20px; font-size: 12px; color: #555;">
          VIGIL SECURITY PROTOCOL ACTIVATED. THIS WORKSTATION WORKSPACE IS SHIELDED.
        </div>
      </div>
    `;
    throw new Error("VIGIL LOCKOUT ACTIVE: " + message);
  }

  const getApiBaseUrl = () => {
    const customServer = localStorage.getItem('vigil_api_server');
    if (customServer) {
      return customServer.replace(/\/$/, '');
    }
    if (window.location.origin.includes('capacitor') || window.location.origin.includes('file://')) {
      return 'http://localhost:3000';
    }
    return '';
  };

  const originalFetch = window.fetch;
  window.fetch = async function(resource, config) {
    const configObj = config || {};
    configObj.headers = configObj.headers || {};

    configObj.headers['X-Hardware-UUID'] = getHardwareUuid();
    
    if (!configObj.headers['X-User-Email'] && typeof currentUserEmail !== 'undefined' && currentUserEmail) {
      configObj.headers['X-User-Email'] = currentUserEmail;
    }

    let finalUrl = resource;
    if (typeof resource === 'string' && resource.startsWith('/api')) {
      const base = getApiBaseUrl();
      if (base) {
        finalUrl = base + resource;
      }
    }

    try {
      const response = await originalFetch(finalUrl, configObj);
      
      if (response.status === 403) {
        const clone = response.clone();
        try {
          const data = await clone.json();
          if (data.device_lock || data.access_revoked) {
            handleLockout(data.message || data.error);
          }
        } catch (e) {}
      }
      return response;
    } catch (err) {
      if (err.message && (err.message.includes("Device Lockout") || err.message.includes("Access Revoked"))) {
        handleLockout(err.message);
      }
      throw err;
    }
  };
})();

// ==========================================
// VIGIL QC PLATFORM: FRONTEND APP CLIENT
// ==========================================

let currentUserEmail = '';
let currentUserRole = '';
let activeTaskCode = '';
let chatPollInterval = null;

// DOM Elements
const loginContainer = document.getElementById('login-container');
const btnLogin = document.getElementById('btn-login');
const loginEmailInput = document.getElementById('login-email');
const loginServerInput = document.getElementById('login-server');
const loginError = document.getElementById('login-error');

const appContainer = document.getElementById('app-container');
const opEmail = document.getElementById('op-email');
const opRole = document.getElementById('op-role');
const btnLogout = document.getElementById('btn-logout');

const taskSelector = document.getElementById('task-selector');
const btnRefresh = document.getElementById('btn-refresh');
const emptyState = document.getElementById('empty-state');
const workspaceContainer = document.getElementById('workspace-container');

// Left Column Elements
const valTaskCode = document.getElementById('val-task-code');
const valStatus = document.getElementById('val-status');
const valAssignedWriter = document.getElementById('val-assigned-writer');
const valDeadline = document.getElementById('val-deadline');
const valQcCount = document.getElementById('val-qc-count');
const valWords = document.getElementById('val-words');
const valBriefText = document.getElementById('val-brief-text');
const valBriefHash = document.getElementById('val-brief-hash');
const manualNotesBox = document.getElementById('manual-notes-box');
const valManualNotes = document.getElementById('val-manual-notes');

// Upload panel elements
const uploadPanel = document.getElementById('upload-panel');
const dragZone = document.getElementById('drag-zone');
const fileInput = document.getElementById('file-input');
const fileSelectedName = document.getElementById('file-selected-name');
const btnExecuteAudit = document.getElementById('btn-execute-audit');
const auditForm = document.getElementById('audit-form');
const auditLoading = document.getElementById('audit-loading');
const lockoutPanel = document.getElementById('lockout-panel');

// TL Override Elements
const tlOverridePanel = document.getElementById('tl-override-panel');
const tlGuidance = document.getElementById('tl-guidance');
const btnResetCounter = document.getElementById('btn-reset-counter');
const btnApproveTask = document.getElementById('btn-approve-task');

// Right Column Elements
const reportViewContent = document.getElementById('report-view-content');
const chatMessagesContainer = document.getElementById('chat-messages-container');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

// Ledger Sheets
const freelancerLedgerPanel = document.getElementById('freelancer-ledger-panel');
const freelancerLedgerBody = document.getElementById('freelancer-ledger-body');
const tlLedgerPanel = document.getElementById('tl-ledger-panel');
const tlLedgerBody = document.getElementById('tl-ledger-body');
const createFirstTaskText = document.getElementById('tl-create-first-task');

// Create Task elements
const createTaskForm = document.getElementById('create-task-form');
const formTaskCode = document.getElementById('form-task-code');
const formWriter = document.getElementById('form-writer');
const formDeadline = document.getElementById('form-deadline');
const formInvoicing = document.getElementById('form-invoicing');
const formEarnings = document.getElementById('form-earnings');
const formBrief = document.getElementById('form-brief');
const createTaskError = document.getElementById('create-task-error');
const createTaskSuccess = document.getElementById('create-task-success');

// Set current time fallback if needed
console.log("Client Initialized. Local session synchronized.");

// ==================== INITIALIZATION & AUTH ====================

btnLogin.addEventListener('click', async () => {
  const email = loginEmailInput.value.trim();
  if (!email || !validateEmail(email)) {
    showError(loginError, "ERR: INVALID AUTHENTICATION EMAIL FORMAT.");
    return;
  }

  // Handle custom server address input
  const customServerVal = loginServerInput.value.trim();
  if (customServerVal) {
    localStorage.setItem('vigil_api_server', customServerVal);
  } else {
    localStorage.removeItem('vigil_api_server');
  }

  hideError(loginError);
  btnLogin.disabled = true;
  btnLogin.textContent = "VERIFYING CREDENTIALS...";

  try {
    const res = await fetch('/api/me', {
      headers: { 'X-User-Email': email }
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Authentication failed");
    }

    const user = await res.json();
    currentUserEmail = user.email;
    currentUserRole = user.system_role;

    // Show App
    loginContainer.classList.add('hidden');
    appContainer.classList.remove('hidden');

    opEmail.textContent = currentUserEmail;
    opRole.textContent = currentUserRole;

    // Sync task selection & ledgers
    await loadTasksList();
    setupRoleViews();
  } catch (err) {
    showError(loginError, `ACCESS DENIED: ${err.message.toUpperCase()}`);
    btnLogin.disabled = false;
    btnLogin.textContent = "ACCESS SECURITY TERMINAL";
  }
});

btnLogout.addEventListener('click', () => {
  // Clear local state
  currentUserEmail = '';
  currentUserRole = '';
  activeTaskCode = '';
  if (chatPollInterval) clearInterval(chatPollInterval);

  // Toggle view
  appContainer.classList.add('hidden');
  loginContainer.classList.remove('hidden');
  btnLogin.disabled = false;
  btnLogin.textContent = "ACCESS SECURITY TERMINAL";
  loginEmailInput.value = '';
  
  // Clear inputs
  taskSelector.innerHTML = '<option value="">-- NO ACTIVE TASK SYNCED --</option>';
  workspaceContainer.classList.add('hidden');
  emptyState.classList.remove('hidden');
  hideLedgerPanels();
});

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==================== ROLE SEGREGATION VIEWS ====================

function setupRoleViews() {
  hideLedgerPanels();
  
  if (currentUserRole === 'Freelancer') {
    freelancerLedgerPanel.classList.remove('hidden');
    loadFreelancerLedger();
  } else if (currentUserRole === 'TL') {
    tlLedgerPanel.classList.remove('hidden');
    createFirstTaskText.classList.remove('hidden');
    loadTlLedger();
  }
  // Standard Writer role has no ledger/payroll view
}

function hideLedgerPanels() {
  freelancerLedgerPanel.classList.add('hidden');
  tlLedgerPanel.classList.add('hidden');
  createFirstTaskText.classList.add('hidden');
}

// ==================== DATABASE OPERATION SYNCS ====================

async function loadTasksList() {
  try {
    const res = await fetch('/api/tasks', {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load tasks");
    const tasks = await res.json();

    // Populate dropdown
    taskSelector.innerHTML = '<option value="">-- SELECT ACTIVE TASK CODE --</option>';
    tasks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.task_code;
      opt.textContent = `${t.task_code} (Writer: ${t.assigned_writer_email})`;
      if (t.task_code === activeTaskCode) opt.selected = true;
      taskSelector.appendChild(opt);
    });

    if (tasks.length === 0) {
      taskSelector.innerHTML = '<option value="">-- NO TASKS ASSIGNED/AVAILABLE --</option>';
    }
  } catch (err) {
    console.error(err);
  }
}

taskSelector.addEventListener('change', (e) => {
  activeTaskCode = e.target.value;
  syncActiveTask();
});

btnRefresh.addEventListener('click', () => {
  syncActiveTask();
});

async function syncActiveTask() {
  if (!activeTaskCode) {
    workspaceContainer.classList.add('hidden');
    emptyState.classList.remove('hidden');
    if (chatPollInterval) clearInterval(chatPollInterval);
    return;
  }

  emptyState.classList.add('hidden');
  workspaceContainer.classList.remove('hidden');

  try {
    // 1. Fetch tasks
    const res = await fetch('/api/tasks', {
      headers: { 'X-User-Email': currentUserEmail }
    });
    const tasks = await res.json();
    const task = tasks.find(t => t.task_code === activeTaskCode);

    if (!task) {
      workspaceContainer.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    // 2. Populate profile details
    valTaskCode.textContent = task.task_code;
    valStatus.textContent = task.status;
    valStatus.className = 'status-indicator ' + task.status.toLowerCase();
    valAssignedWriter.textContent = task.assigned_writer_email;
    valDeadline.textContent = task.deadline || 'NO TARGET DEADLINE';
    valQcCount.textContent = `${task.qc_count}/2`;
    valWords.textContent = task.words_completed;
    valBriefText.textContent = task.brief_text;
    valBriefHash.textContent = task.brief_text_hash;

    // Manual editorial guidance notes
    if (task.manual_notes) {
      manualNotesBox.classList.remove('hidden');
      valManualNotes.textContent = task.manual_notes;
    } else {
      manualNotesBox.classList.add('hidden');
    }

    // Programmatic Layout & Structural Breakdown Analytics
    const cachedAnalytics = localStorage.getItem('analytics_' + activeTaskCode);
    if (cachedAnalytics) {
      try {
        renderLayoutAnalytics(JSON.parse(cachedAnalytics));
      } catch (e) {
        document.getElementById('layout-analytics-box').classList.add('hidden');
      }
    } else {
      document.getElementById('layout-analytics-box').classList.add('hidden');
    }

    // 3. Render VIGIL audit log ledger
    if (task.qc_log_payload) {
      reportViewContent.innerHTML = formatMarkdown(task.qc_log_payload);
    } else {
      reportViewContent.innerHTML = `<p class="text-muted">No VIGIL forensic audit runs executed yet. Upload an assignment document to run the checkers.</p>`;
    }

    // 4. Handle 2-QC Hard Enforcer Lockout Visibilities
    if (task.qc_count >= 2) {
      uploadPanel.classList.add('hidden');
      lockoutPanel.classList.remove('hidden');
    } else {
      uploadPanel.classList.remove('hidden');
      lockoutPanel.classList.add('hidden');
      // Reset upload form
      fileInput.value = '';
      fileSelectedName.textContent = 'NO FILE SELECTED';
    }

    // 5. Handle TL supervisory panels
    if (currentUserRole === 'TL') {
      tlOverridePanel.classList.remove('hidden');
      tlGuidance.value = task.manual_notes || '';
    } else {
      tlOverridePanel.classList.add('hidden');
    }

    // 6. Start chat polling
    loadTaskChats();
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(loadTaskChats, 3000);

  } catch (err) {
    console.error("Error syncing task screen:", err);
  }
}

// ==================== DOCUMENT AUDIT GATEWAY ====================

// Drag and drop events
dragZone.addEventListener('click', () => fileInput.click());

dragZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dragZone.classList.add('dragover');
});

dragZone.addEventListener('dragleave', () => {
  dragZone.classList.remove('dragover');
});

dragZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    fileInput.files = e.dataTransfer.files;
    updateSelectedFileName();
  }
});

fileInput.addEventListener('change', updateSelectedFileName);

function updateSelectedFileName() {
  if (fileInput.files.length > 0) {
    fileSelectedName.textContent = fileInput.files[0].name.toUpperCase();
  } else {
    fileSelectedName.textContent = 'NO FILE SELECTED';
  }
}

auditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files.length) {
    alert("Please select a file to audit.");
    return;
  }

  // Show loading
  auditLoading.classList.remove('hidden');
  btnExecuteAudit.disabled = true;

  const formData = new FormData();
  formData.append('document', fileInput.files[0]);

  try {
    const res = await fetch(`/api/tasks/${activeTaskCode}/audit`, {
      method: 'POST',
      headers: { 'X-User-Email': currentUserEmail },
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Audit request failed');
    }

    const result = await res.json();
    console.log("Audit complete.", result);
    
    // Cache the formatting and section metrics in localStorage
    localStorage.setItem('analytics_' + activeTaskCode, JSON.stringify(result));
    renderLayoutAnalytics(result);
    
    // Sync task state and ledger
    await syncActiveTask();
    if (currentUserRole === 'Freelancer') loadFreelancerLedger();
    if (currentUserRole === 'TL') loadTlLedger();

  } catch (err) {
    alert(`AUDIT ENGINE FAILURE: ${err.message}`);
  } finally {
    auditLoading.classList.add('hidden');
    btnExecuteAudit.disabled = false;
  }
});

// ==================== CHAT STREAM LOGS ====================

async function loadTaskChats() {
  if (!activeTaskCode) return;
  try {
    const res = await fetch(`/api/tasks/${activeTaskCode}/chats`, {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load chats");
    const chats = await res.json();

    const isScrolledToBottom = chatMessagesContainer.scrollHeight - chatMessagesContainer.clientHeight <= chatMessagesContainer.scrollTop + 40;

    chatMessagesContainer.innerHTML = '';
    chats.forEach(c => {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'chat-msg';
      
      // Format timestamp
      const timeStr = new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Highlight system messages
      if (c.sender_email === 'vigil.system@vigil.com') {
        msgDiv.innerHTML = `<span class="chat-msg-time">[${timeStr}]</span> <span class="chat-msg-sender text-warning">SYSTEM CONTROL</span>: <span class="text-success">${c.message_text}</span>`;
      } else {
        msgDiv.innerHTML = `<span class="chat-msg-time">[${timeStr}]</span> <span class="chat-msg-sender">${c.sender_email}</span>: <span>${c.message_text}</span>`;
      }
      chatMessagesContainer.appendChild(msgDiv);
    });

    // Auto-scroll to bottom if user is already near bottom
    if (isScrolledToBottom) {
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    }
  } catch (err) {
    console.error("Chats syncing failure:", err);
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  try {
    const res = await fetch(`/api/tasks/${activeTaskCode}/chats`, {
      method: 'POST',
      headers: {
        'X-User-Email': currentUserEmail,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message_text: text })
    });
    if (!res.ok) throw new Error("Post chat failed");
    
    // Instantly load new messages
    await loadTaskChats();
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  } catch (err) {
    console.error(err);
  }
});

// ==================== TEAM LEAD PANEL ACTIONS ====================

btnResetCounter.addEventListener('click', async () => {
  const notes = tlGuidance.value.trim();
  if (!confirm("Are you sure you want to reset the automated check counter back to 0? This logs a manual override.")) return;

  showProactiveModal(
    'B',
    activeTaskCode,
    "What did the writer miss that the AI council failed to flag? Speak the correction here so the 3 AI Critics immediately learn this pattern and never miss it again.",
    async (trainedText) => {
      const combinedNotes = [notes, trainedText].filter(Boolean).join(" | ");
      try {
        const res = await fetch(`/api/tasks/${activeTaskCode}/reset`, {
          method: 'POST',
          headers: {
            'X-User-Email': currentUserEmail,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ manual_notes: combinedNotes })
        });

        if (!res.ok) throw new Error("Override failed");
        
        await syncActiveTask();
        loadTlLedger();
      } catch (err) {
        alert(`Reset counter failed: ${err.message}`);
      }
    }
  );
});

btnApproveTask.addEventListener('click', async () => {
  const notes = tlGuidance.value.trim();
  if (!confirm("Confirm delivery sign-off? This marks the task code as Approved and locks future checks.")) return;

  showProactiveModal(
    'C',
    activeTaskCode,
    "Did the client introduce any last-minute feedback or edits? Add them here to permanently lock this variable into this client's billing profile.",
    async (trainedText) => {
      const combinedFeedback = [notes, trainedText].filter(Boolean).join(" | ");
      try {
        const res = await fetch(`/api/tasks/${activeTaskCode}/approve`, {
          method: 'POST',
          headers: { 
            'X-User-Email': currentUserEmail,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ feedback: combinedFeedback })
        });

        if (!res.ok) throw new Error("Approval sign-off failed");
        
        await syncActiveTask();
        loadTlLedger();
      } catch (err) {
        alert(`Approve task failed: ${err.message}`);
      }
    }
  );
});

// Spawn task
createTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(createTaskError);
  createTaskSuccess.classList.add('hidden');

  const formBriefFile = document.getElementById('form-brief-file');
  const formClientId = document.getElementById('form-client-id');

  const formData = new FormData();
  formData.append('task_code', formTaskCode.value.trim());
  formData.append('client_id', formClientId.value.trim() || 'GLOBAL');
  formData.append('assigned_writer_email', formWriter.value.trim());
  formData.append('deadline', formDeadline.value);
  formData.append('invoicing_amount', formInvoicing.value);
  formData.append('earnings_amount', formEarnings.value);
  formData.append('brief_text', formBrief.value.trim());
  
  if (formBriefFile.files.length > 0) {
    formData.append('brief_file', formBriefFile.files[0]);
  }

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'X-User-Email': currentUserEmail
      },
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to create project workspace");
    }

    const taskData = await res.json();
    const spawnedCode = taskData.task_code;

    createTaskForm.reset();
    createTaskSuccess.classList.remove('hidden');
    
    // Reload task list
    await loadTasksList();
    loadTlLedger();

    // Trigger Proactive Prompt Event A
    showProactiveModal(
      'A',
      spawnedCode,
      "I have mapped the brief. Is there any unwritten client preference, hidden lecture style, or specific error pattern I should look out for on this run? Speak or type it here to train the Critics.",
      () => {}
    );
  } catch (err) {
    showError(createTaskError, `CREATION ERROR: ${err.message.toUpperCase()}`);
  }
});

// ==================== LEDGER READS & POPULATORS ====================

async function loadFreelancerLedger() {
  try {
    const res = await fetch('/api/earnings', {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load earnings");
    const ledger = await res.json();

    freelancerLedgerBody.innerHTML = '';
    ledger.forEach(l => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td data-label="TASK CODE"><strong>${l.task_code}</strong></td>
        <td data-label="WORDS">${l.words_completed} words</td>
        <td data-label="EARNINGS"><strong class="text-success">$${parseFloat(l.earnings_amount).toFixed(2)}</strong></td>
        <td data-label="STATUS"><span class="status-indicator ${l.status.toLowerCase()}">${l.status}</span></td>
      `;
      freelancerLedgerBody.appendChild(row);
    });

    if (ledger.length === 0) {
      freelancerLedgerBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No transaction ledger entries recorded.</td></tr>';
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadTlLedger() {
  try {
    const res = await fetch('/api/tasks', {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load TL ledger");
    const tasks = await res.json();

    tlLedgerBody.innerHTML = '';
    tasks.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td data-label="TASK CODE"><strong>${t.task_code}</strong></td>
        <td data-label="WRITER">${t.assigned_writer_email}</td>
        <td data-label="WORDS COMPLETED">${t.words_completed} words</td>
        <td data-label="CLIENT INVOICING">$${parseFloat(t.invoicing_amount || 0).toFixed(2)}</td>
        <td data-label="WRITER PAYROLL"><strong class="text-success">$${parseFloat(t.earnings_amount || 0).toFixed(2)}</strong></td>
        <td data-label="QC RUNS"><span class="badge-count">${t.qc_count}/2</span></td>
        <td data-label="STATUS"><span class="status-indicator ${t.status.toLowerCase()}">${t.status}</span></td>
      `;
      tlLedgerBody.appendChild(row);
    });

    if (tasks.length === 0) {
      tlLedgerBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No pipelines active in ledger.</td></tr>';
    }
  } catch (err) {
    console.error(err);
  }
}

// ==================== GENERAL HELPERS ====================

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.textContent = '';
  el.classList.add('hidden');
}

// Simple client-side Markdown formatter for report display
function formatMarkdown(md) {
  if (!md) return '';
  let html = md;
  // Escapes HTML tag brackets
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Headers
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  // Lists
  html = html.replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>');
  html = html.replace(/<\/ul>\s*<ul>/gim, ''); // Combine consecutive ul elements
  
  return html;
}

// ==================== AUDIO RECORDING & AUTO-LEARNING MULTIMODAL WORKFLOWS ====================

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

async function toggleRecording(btnEl, statusEl, onStopCallback) {
  if (isRecording) {
    // Stop recording
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    btnEl.textContent = "🎤 CLICK TO SPEAK AUDIO INSTRUCTIONS";
    btnEl.classList.remove('btn-danger');
    btnEl.classList.add('btn-primary');
    statusEl.textContent = "TRANSCRIBING AUDIO...";
    statusEl.className = "status-indicator pending text-center";
  } else {
    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        onStopCallback(audioBlob);
        stream.getTracks().forEach(track => track.stop()); // release mic
      };
      mediaRecorder.start();
      isRecording = true;
      btnEl.textContent = "⏹️ CLICK TO STOP";
      btnEl.classList.remove('btn-primary');
      btnEl.classList.add('btn-danger');
      statusEl.textContent = "RECORDING...";
      statusEl.className = "status-indicator approved text-center";
    } catch (err) {
      alert("Microphone access error: " + err.message);
    }
  }
}

// ==================== PROACTIVE PROMPTING MODAL LOGIC ====================

let currentModalContext = null; // { type: 'A'|'B'|'C', taskCode: '...', onDone: callback }

const proactiveModal = document.getElementById('proactive-modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalRecordBtn = document.getElementById('modal-record-btn');
const modalRecordStatus = document.getElementById('modal-record-status');
const modalTextInput = document.getElementById('modal-text-input');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSubmitBtn = document.getElementById('modal-submit-btn');

function showProactiveModal(type, taskCode, message, onDone) {
  currentModalContext = { type, taskCode, onDone };
  modalTitle.textContent = type === 'A' ? '[ 💡 VIGIL PROACTIVE PROMPT ]' : (type === 'B' ? '[ 🚨 SYSTEM FEEDBACK LOOP ]' : '[ 🏆 FINAL QUALITY LOG ]');
  modalMessage.textContent = message;
  modalTextInput.value = '';
  modalRecordStatus.textContent = 'STANDBY';
  modalRecordStatus.className = 'status-indicator pending text-center';
  proactiveModal.classList.remove('hidden');
}

function hideProactiveModal() {
  proactiveModal.classList.add('hidden');
  currentModalContext = null;
}

modalCancelBtn.addEventListener('click', () => {
  if (currentModalContext && currentModalContext.onDone) {
    currentModalContext.onDone(""); // Complete callback with no additional notes
  }
  hideProactiveModal();
});

modalSubmitBtn.addEventListener('click', async () => {
  const textVal = modalTextInput.value.trim();
  if (!textVal) {
    alert("Please enter text or record audio before transmitting.");
    return;
  }
  modalSubmitBtn.disabled = true;
  modalSubmitBtn.textContent = "TRANSMITTING...";
  try {
    const res = await fetch(`/api/tasks/${currentModalContext.taskCode}/teach`, {
      method: 'POST',
      headers: {
        'X-User-Email': currentUserEmail,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: textVal })
    });
    if (!res.ok) throw new Error("Teaching API failed");
    const data = await res.json();
    alert(`AI Council Trained! Extracted Rule: "${data.rule}"`);
    if (currentModalContext && currentModalContext.onDone) {
      currentModalContext.onDone(data.rule);
    }
  } catch (err) {
    alert(`Failed to teach: ${err.message}`);
  } finally {
    modalSubmitBtn.disabled = false;
    modalSubmitBtn.textContent = "TRANSMIT TRAINING TO ENGINE";
    hideProactiveModal();
  }
});

modalRecordBtn.addEventListener('click', () => {
  toggleRecording(modalRecordBtn, modalRecordStatus, async (audioBlob) => {
    modalRecordStatus.textContent = "TRANSMITTING AUDIO...";
    const formData = new FormData();
    formData.append('audio', audioBlob, 'instruction.wav');
    try {
      const res = await fetch(`/api/tasks/${currentModalContext.taskCode}/teach`, {
        method: 'POST',
        headers: { 'X-User-Email': currentUserEmail },
        body: formData
      });
      if (!res.ok) throw new Error("Audio teaching failed");
      const data = await res.json();
      alert(`Speech Transcribed & AI Trained!\nTranscript: "${data.transcript}"\nRule: "${data.rule}"`);
      if (currentModalContext && currentModalContext.onDone) {
        currentModalContext.onDone(data.rule);
      }
    } catch (err) {
      alert("Failed to process audio training: " + err.message);
    } finally {
      modalRecordStatus.textContent = "STANDBY";
      modalRecordStatus.className = "status-indicator pending text-center";
      hideProactiveModal();
    }
  });
});

// ==================== STANDALONE TEACHING TERMINAL ====================

const btnTeachRecord = document.getElementById('btn-teach-record');
const teachRecordStatus = document.getElementById('teach-record-status');
const teachText = document.getElementById('teach-text');
const btnTeachSubmit = document.getElementById('btn-teach-submit');

btnTeachSubmit.addEventListener('click', async () => {
  const textVal = teachText.value.trim();
  if (!textVal) {
    alert("Please enter teaching directives before transmitting.");
    return;
  }
  btnTeachSubmit.disabled = true;
  btnTeachSubmit.textContent = "TRANSMITTING...";
  try {
    const res = await fetch(`/api/tasks/${activeTaskCode}/teach`, {
      method: 'POST',
      headers: {
        'X-User-Email': currentUserEmail,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: textVal })
    });
    if (!res.ok) throw new Error("Teaching API failed");
    const data = await res.json();
    alert(`AI Council Trained successfully!\nExtracted Rule: "${data.rule}"`);
    teachText.value = '';
    await syncActiveTask();
  } catch (err) {
    alert(`Failed to teach: ${err.message}`);
  } finally {
    btnTeachSubmit.disabled = false;
    btnTeachSubmit.textContent = "TRANSMIT TRAINING TO ENGINE";
  }
});

btnTeachRecord.addEventListener('click', () => {
  toggleRecording(btnTeachRecord, teachRecordStatus, async (audioBlob) => {
    teachRecordStatus.textContent = "TRANSMITTING AUDIO...";
    const formData = new FormData();
    formData.append('audio', audioBlob, 'instruction.wav');
    try {
      const res = await fetch(`/api/tasks/${activeTaskCode}/teach`, {
        method: 'POST',
        headers: { 'X-User-Email': currentUserEmail },
        body: formData
      });
      if (!res.ok) throw new Error("Audio teaching failed");
      const data = await res.json();
      alert(`Speech Transcribed & AI Trained!\nTranscript: "${data.transcript}"\nRule: "${data.rule}"`);
      await syncActiveTask();
    } catch (err) {
      alert("Failed to process audio training: " + err.message);
    } finally {
      teachRecordStatus.textContent = "STANDBY";
      teachRecordStatus.className = "status-indicator pending text-center";
    }
  });
});

// ==================== RENDERING METADATA & SECTION ANALYSIS ====================

function renderLayoutAnalytics(data) {
  const box = document.getElementById('layout-analytics-box');
  const spacingSpan = document.getElementById('meta-spacing');
  const alignmentSpan = document.getElementById('meta-alignment');
  const listContainer = document.getElementById('section-analytics-list');

  if (!data || !data.formatting) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  spacingSpan.textContent = data.formatting.spacing.toUpperCase();
  alignmentSpan.textContent = data.formatting.alignment.toUpperCase();

  listContainer.innerHTML = '';
  if (data.sectionAnalytics && data.sectionAnalytics.length > 0) {
    data.sectionAnalytics.forEach(sec => {
      const secDiv = document.createElement('div');
      secDiv.className = 'margin-top-xs';
      secDiv.style.padding = '6px 10px';
      secDiv.style.border = '2px dashed var(--color-border)';

      if (sec.violated) {
        secDiv.style.backgroundColor = '#ffebee';
        secDiv.style.color = '#b71c1c';
        secDiv.style.borderColor = '#b71c1c';
        secDiv.innerHTML = `
          <strong>❌ ${sec.section.toUpperCase()}:</strong> ${sec.actualWords} words 
          <span style="float: right;">Target: ${sec.targetPercent}% (${sec.targetWords}w +/- 20%)</span>
          <div style="font-size: 11px; margin-top: 3px; font-weight: bold;">⚠️ OUT OF ALLOWED VARIANCE LIMITS: ${sec.minAllowed} - ${sec.maxAllowed} words.</div>
        `;
      } else {
        secDiv.style.backgroundColor = '#e8f5e9';
        secDiv.style.color = '#2e7d32';
        secDiv.style.borderColor = '#2e7d32';
        secDiv.innerHTML = `
          <strong>✅ ${sec.section.toUpperCase()}:</strong> ${sec.actualWords} words 
          <span style="float: right;">Target: ${sec.targetPercent}% (${sec.targetWords}w +/- 20%)</span>
        `;
      }
      listContainer.appendChild(secDiv);
    });
  } else {
    listContainer.innerHTML = '<div class="text-muted italic">No section headers detected for sectional word tracking.</div>';
  }
}

