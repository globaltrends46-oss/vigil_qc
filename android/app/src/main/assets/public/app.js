// ==========================================
// VIGIL QC PORTAL: SIMPLIFIED LOCAL WORKSPACE
// ==========================================

const API_BASE = 'http://localhost:3000';

let currentUserEmail = 'prishapublishingteamlead@gmail.com';
let currentUserRole = 'TL';
let activeTaskCode = '';
let loadedTasks = [];

// DOM Elements
const taskSelector = document.getElementById('task-selector');
const btnRefresh = document.getElementById('btn-refresh');
const btnShowCreateProject = document.getElementById('btn-show-create-project');
const createProjectPanel = document.getElementById('create-project-panel');
const createProjectForm = document.getElementById('create-project-form');
const formTaskCode = document.getElementById('form-task-code');
const formBriefFiles = document.getElementById('form-brief-files');
const btnCancelCreate = document.getElementById('btn-cancel-create');
const createTaskError = document.getElementById('create-task-error');
const createTaskSuccess = document.getElementById('create-task-success');

const emptyState = document.getElementById('empty-state');
const workspaceContainer = document.getElementById('workspace-container');

// Upload Form Elements
const auditForm = document.getElementById('audit-form');
const dragZone = document.getElementById('drag-zone');
const fileInput = document.getElementById('file-input');
const fileSelectedName = document.getElementById('file-selected-name');
const btnExecuteAudit = document.getElementById('btn-execute-audit');
const auditLoading = document.getElementById('audit-loading');
const valBriefText = document.getElementById('val-brief-text');

// Report elements
const layoutAnalyticsBox = document.getElementById('layout-analytics-box');
const metaSpacing = document.getElementById('meta-spacing');
const metaAlignment = document.getElementById('meta-alignment');
const sectionAnalyticsList = document.getElementById('section-analytics-list');
const reportViewContent = document.getElementById('report-view-content');

// ==================== INITIALIZATION ====================

window.addEventListener('DOMContentLoaded', async () => {
  await loadTasksList();
});

// Load tasks list
async function loadTasksList(autoSelectCode = '') {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load projects list");
    
    loadedTasks = await res.json();

    // Populate dropdown
    taskSelector.innerHTML = '<option value="">-- SELECT ACTIVE PROJECT --</option>';
    loadedTasks.forEach(task => {
      const opt = document.createElement('option');
      opt.value = task.task_code;
      opt.textContent = task.task_code.toUpperCase();
      taskSelector.appendChild(opt);
    });

    if (autoSelectCode) {
      taskSelector.value = autoSelectCode;
      selectProject(autoSelectCode);
    }
  } catch (err) {
    console.error("Error loading tasks list:", err);
  }
}

// Refresh button handler
btnRefresh.addEventListener('click', async () => {
  const currentSelect = taskSelector.value;
  await loadTasksList(currentSelect);
});

// Selector handler
taskSelector.addEventListener('change', (e) => {
  selectProject(e.target.value);
});

function selectProject(code) {
  if (!code) {
    activeTaskCode = '';
    workspaceContainer.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  activeTaskCode = code;
  emptyState.classList.add('hidden');
  workspaceContainer.classList.remove('hidden');

  // Find task details
  const task = loadedTasks.find(t => t.task_code === code);
  if (task) {
    valBriefText.innerHTML = formatMarkdown(task.brief_text);
    
    // Check if report history exists
    if (task.qc_log_payload && task.qc_log_payload.trim() !== '') {
      reportViewContent.innerHTML = formatMarkdown(task.qc_log_payload);
      
      // Try to parse layout analytics from payload if available
      layoutAnalyticsBox.classList.remove('hidden');
      metaSpacing.textContent = "CHECK PAYLOAD REPORT BELOW";
      metaAlignment.textContent = "CHECK PAYLOAD REPORT BELOW";
      sectionAnalyticsList.innerHTML = '<div class="text-muted italic">Submit new solution files to run dynamic layout diagnostics.</div>';
    } else {
      reportViewContent.innerHTML = '<p class="text-muted italic">No QC audit ran yet. Upload a solution file on the left and submit to trigger the audit.</p>';
      layoutAnalyticsBox.classList.add('hidden');
    }
  }
}

// ==================== CREATE NEW PROJECT ====================

btnShowCreateProject.addEventListener('click', () => {
  createProjectPanel.classList.remove('hidden');
  createTaskError.classList.add('hidden');
  createTaskSuccess.classList.add('hidden');
  createProjectForm.reset();
});

btnCancelCreate.addEventListener('click', () => {
  createProjectPanel.classList.add('hidden');
});

createProjectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createTaskError.classList.add('hidden');
  createTaskSuccess.classList.add('hidden');

  const taskCode = formTaskCode.value.trim();
  if (!taskCode) return;

  const formData = new FormData();
  formData.append('task_code', taskCode);

  const files = formBriefFiles.files;
  for (let i = 0; i < files.length; i++) {
    formData.append('brief_files', files[i]);
  }

  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'X-User-Email': currentUserEmail },
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Failed to create project");
    }

    createTaskSuccess.classList.remove('hidden');
    
    // Reload task list and select the new task
    await loadTasksList(taskCode);

    setTimeout(() => {
      createProjectPanel.classList.add('hidden');
    }, 1500);

  } catch (err) {
    createTaskError.textContent = `ERR: ${err.message.toUpperCase()}`;
    createTaskError.classList.remove('hidden');
  }
});

// ==================== DRAG AND DROP SOLUTION UPLOAD ====================

// Prevent default drag behaviors
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  dragZone.addEventListener(eventName, preventDefaults, false);
  document.body.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

// Highlight drop zone
['dragenter', 'dragover'].forEach(eventName => {
  dragZone.addEventListener(eventName, () => {
    dragZone.classList.add('highlight');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dragZone.addEventListener(eventName, () => {
    dragZone.classList.remove('highlight');
  }, false);
});

// Handle dropped files
dragZone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  fileInput.files = files;
  updateSelectedFileName();
});

// Click dropzone to open browser select
dragZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  updateSelectedFileName();
});

function updateSelectedFileName() {
  const files = fileInput.files;
  if (files && files.length > 0) {
    const names = [];
    for (let i = 0; i < files.length; i++) {
      names.push(files[i].name);
    }
    fileSelectedName.textContent = names.join(', ');
  } else {
    fileSelectedName.textContent = "NO FILE SELECTED";
  }
}

// ==================== RUN QC AUDIT SUBMIT ====================

auditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (!activeTaskCode) {
    alert("Please select a project first.");
    return;
  }

  const files = fileInput.files;
  if (!files || files.length === 0) {
    alert("Please select or drop at least one solution file.");
    return;
  }

  // Toggle state
  btnExecuteAudit.disabled = true;
  btnExecuteAudit.textContent = "AUDITING SUBMISSION...";
  auditLoading.classList.remove('hidden');

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('solution_files', files[i]);
  }

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${activeTaskCode}/audit`, {
      method: 'POST',
      headers: { 'X-User-Email': currentUserEmail },
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Audit request failed");
    }

    const data = await res.json();

    // Render consolidated markdown report
    reportViewContent.innerHTML = formatMarkdown(data.report);

    // Render programmatic metrics
    renderLayoutAnalytics(data);

    // Reload tasks list quietly in background to save state
    await loadTasksList(activeTaskCode);

  } catch (err) {
    alert(`QC Audit Failed: ${err.message}`);
  } finally {
    btnExecuteAudit.disabled = false;
    btnExecuteAudit.textContent = "⚡ RUN AUTOMATED FORENSIC QC";
    auditLoading.classList.add('hidden');
  }
});

// ==================== RENDERING COMPLIANCE & SECTION METRICS ====================

function renderLayoutAnalytics(data) {
  if (!data || !data.formatting) {
    layoutAnalyticsBox.classList.add('hidden');
    return;
  }

  layoutAnalyticsBox.classList.remove('hidden');
  metaSpacing.textContent = data.formatting.spacing.toUpperCase();
  metaAlignment.textContent = data.formatting.alignment.toUpperCase();

  sectionAnalyticsList.innerHTML = '';
  if (data.sectionAnalytics && data.sectionAnalytics.length > 0) {
    data.sectionAnalytics.forEach(sec => {
      const secDiv = document.createElement('div');
      secDiv.className = 'margin-top-xs';
      secDiv.style.padding = '6px 10px';
      secDiv.style.border = '2px dashed var(--color-border)';

      if (sec.violated) {
        secDiv.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        secDiv.style.color = '#FCA5A5';
        secDiv.style.borderColor = 'rgba(239, 68, 68, 0.2)';
        secDiv.innerHTML = `
          <strong>❌ ${sec.section.toUpperCase()}:</strong> ${sec.actualWords} words 
          <span style="float: right;">Target: ${sec.targetPercent}% (${sec.targetWords}w +/- 20%)</span>
          <div style="font-size: 11px; margin-top: 3px; font-weight: bold;">⚠️ OUT OF ALLOWED VARIANCE LIMITS: ${sec.minAllowed} - ${sec.maxAllowed} words.</div>
        `;
      } else {
        secDiv.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
        secDiv.style.color = '#A7F3D0';
        secDiv.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        secDiv.innerHTML = `
          <strong>✅ ${sec.section.toUpperCase()}:</strong> ${sec.actualWords} words 
          <span style="float: right;">Target: ${sec.targetPercent}% (${sec.targetWords}w +/- 20%)</span>
        `;
      }
      sectionAnalyticsList.appendChild(secDiv);
    });
  } else {
    sectionAnalyticsList.innerHTML = '<div class="text-muted italic">No section headers detected for sectional word tracking.</div>';
  }
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
  
  // Newlines to break lines
  html = html.replace(/\n/g, '<br>');
  
  return html;
}
