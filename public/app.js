// ==========================================
// VIGIL QC PORTAL: SIMPLIFIED LOCAL WORKSPACE
// ==========================================

const API_BASE = ''; // Routes relative to where the site is hosted

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
const createTaskLoading = document.getElementById('create-task-loading');
const btnSubmitProject = document.getElementById('btn-submit-project');

const emptyState = document.getElementById('empty-state');
const workspaceContainer = document.getElementById('workspace-container');

// Search & Delete Elements
const projectSearch = document.getElementById('project-search');
const btnDeleteProject = document.getElementById('btn-delete-project');

// Upload Form Elements
const auditForm = document.getElementById('audit-form');
const dragZone = document.getElementById('drag-zone');
const fileInput = document.getElementById('file-input');
const fileSelectedName = document.getElementById('file-selected-name');
const btnExecuteAudit = document.getElementById('btn-execute-audit');
const btnExecuteResubmit = document.getElementById('btn-execute-resubmit');
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
  
  // Connect search filter listener
  if (projectSearch) {
    projectSearch.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      populateDropdown(query);
    });
  }

  // Connect project delete click listener
  if (btnDeleteProject) {
    btnDeleteProject.addEventListener('click', async () => {
      if (!activeTaskCode) return;
      if (!confirm(`⚠️ ARE YOU SURE YOU WANT TO DELETE PROJECT: "${activeTaskCode}"?\n\nThis will permanently delete the project from Supabase, erase all audit reports, and clean up the associated Google NotebookLM space.`)) {
        return;
      }
      
      try {
        btnDeleteProject.disabled = true;
        btnDeleteProject.textContent = 'DELETING...';
        
        const res = await fetch(`${API_BASE}/api/tasks/${activeTaskCode}`, {
          method: 'DELETE',
          headers: { 'X-User-Email': currentUserEmail }
        });
        
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to delete project");
        }
        
        alert(`Project "${activeTaskCode}" deleted successfully.`);
        activeTaskCode = '';
        projectSearch.value = '';
        await loadTasksList();
        selectProject('');
      } catch (err) {
        alert(`DELETE ERR: ${err.message.toUpperCase()}`);
      } finally {
        btnDeleteProject.disabled = false;
        btnDeleteProject.textContent = '❌ DELETE PROJECT';
      }
    });
  }
});

// Load tasks list
async function loadTasksList(autoSelectCode = '') {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      headers: { 'X-User-Email': currentUserEmail }
    });
    if (!res.ok) throw new Error("Failed to load projects list");
    
    loadedTasks = await res.json();
    populateDropdown(projectSearch ? projectSearch.value.toLowerCase().trim() : '');

    if (autoSelectCode) {
      taskSelector.value = autoSelectCode;
      selectProject(autoSelectCode);
    }
  } catch (err) {
    console.error("Error loading tasks list:", err);
  }
}

// Populate dropdown based on filter query
function populateDropdown(filterQuery = '') {
  const currentSelect = taskSelector.value;
  taskSelector.innerHTML = '<option value="">-- SELECT ACTIVE PROJECT --</option>';
  
  loadedTasks.forEach(task => {
    const taskName = task.task_code.toLowerCase();
    if (!filterQuery || taskName.includes(filterQuery)) {
      const opt = document.createElement('option');
      opt.value = task.task_code;
      opt.textContent = task.task_code.toUpperCase();
      taskSelector.appendChild(opt);
    }
  });

  // Restore selection if still in filtered list
  if (currentSelect && loadedTasks.some(t => t.task_code === currentSelect && (!filterQuery || t.task_code.toLowerCase().includes(filterQuery)))) {
    taskSelector.value = currentSelect;
  } else {
    taskSelector.value = '';
    selectProject('');
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
    if (btnDeleteProject) btnDeleteProject.style.display = 'none';
    return;
  }

  activeTaskCode = code;
  emptyState.classList.add('hidden');
  workspaceContainer.classList.remove('hidden');
  if (btnDeleteProject) btnDeleteProject.style.display = 'inline-block';

  // Find task details
  const task = loadedTasks.find(t => t.task_code === code);
  if (task) {
    const parts = task.brief_text.split('\n\n---\n\n# AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION\n\n');
    valBriefText.innerHTML = formatMarkdown(parts[0]);
    const guidanceContainer = document.getElementById('val-course-of-action');
    const btnSaveGuidance = document.getElementById('btn-save-guidance');
    if (guidanceContainer) {
      if (parts.length > 1) {
        guidanceContainer.value = parts[1].trim();
        if (btnSaveGuidance) btnSaveGuidance.classList.remove('hidden');
      } else {
        guidanceContainer.value = 'No AI guidance generated for this project yet.';
        if (btnSaveGuidance) btnSaveGuidance.classList.add('hidden');
      }
    }
    
    // Check if report history exists
    if (task.qc_log_payload && task.qc_log_payload.trim() !== '') {
      reportViewContent.innerHTML = formatMarkdown(task.qc_log_payload);
      
      // Try to parse layout analytics from payload if available
      layoutAnalyticsBox.classList.remove('hidden');
      
      const payload = task.qc_log_payload;
      
      // Parse Word Counts
      const totalWordsMatch = payload.match(/\*\*Total Word Count:\*\* (\d+) words/);
      const validWordsMatch = payload.match(/\*\*Valid Word Count \(Excl\. Refs\/TOC\):\*\* (\d+) words/);
      const metaTotalWords = document.getElementById('meta-total-words');
      const metaValidWords = document.getElementById('meta-valid-words');
      if (metaTotalWords) metaTotalWords.textContent = totalWordsMatch ? totalWordsMatch[1] : "---";
      if (metaValidWords) metaValidWords.textContent = validWordsMatch ? validWordsMatch[1] : "---";
      
      // Parse Metadata Status
      const metadataStatusBanner = document.getElementById('metadata-status-banner');
      if (metadataStatusBanner) {
        metadataStatusBanner.classList.remove('hidden');
        if (payload.includes('⚠️ ALARM: Personal properties found')) {
          metadataStatusBanner.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
          metadataStatusBanner.style.color = '#FCA5A5';
          metadataStatusBanner.style.border = '2px dashed rgba(239, 68, 68, 0.5)';
          const nameMatch = payload.match(/Author: (.*?)\)/);
          metadataStatusBanner.innerHTML = `⚠️ METADATA ALARM: File contains personal properties (Author: ${nameMatch ? nameMatch[1] : 'Unknown'}). Remove properties before sending!`;
        } else if (payload.includes('✅ METADATA CLEAN')) {
          metadataStatusBanner.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
          metadataStatusBanner.style.color = '#A7F3D0';
          metadataStatusBanner.style.border = '2px dashed rgba(16, 185, 129, 0.5)';
          metadataStatusBanner.innerHTML = `✅ METADATA CLEAN: No personal properties or author names detected in file.`;
        } else {
          metadataStatusBanner.classList.add('hidden');
        }
      }

      metaSpacing.textContent = "CHECK PAYLOAD REPORT BELOW";
      metaAlignment.textContent = "CHECK PAYLOAD REPORT BELOW";
      sectionAnalyticsList.innerHTML = '<div class="text-muted italic">Check section breakdown in payload report below. Submit new files to run fresh diagnostics.</div>';
      
      // Show resubmit button
      if (btnExecuteResubmit) btnExecuteResubmit.classList.remove('hidden');
    } else {
      reportViewContent.innerHTML = '<p class="text-muted italic">No QC audit ran yet. Upload a solution file on the left and submit to trigger the audit.</p>';
      layoutAnalyticsBox.classList.add('hidden');
      if (btnExecuteResubmit) btnExecuteResubmit.classList.add('hidden');
    }
  }
}

// ==================== CREATE NEW PROJECT ====================

if (btnShowCreateProject) {
  btnShowCreateProject.addEventListener('click', () => {
    console.log('[UI] Opening Create Project panel...');
    if (createProjectPanel) {
      createProjectPanel.classList.remove('hidden');
      createProjectPanel.style.display = 'block';
    }
    if (createTaskError) createTaskError.classList.add('hidden');
    if (createTaskSuccess) createTaskSuccess.classList.add('hidden');
    if (createProjectForm) createProjectForm.reset();
  });
}

if (btnCancelCreate) {
  btnCancelCreate.addEventListener('click', () => {
    console.log('[UI] Closing Create Project panel...');
    if (createProjectPanel) {
      createProjectPanel.classList.add('hidden');
      createProjectPanel.style.display = 'none';
    }
  });
}

createProjectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createTaskError.classList.add('hidden');
  createTaskSuccess.classList.add('hidden');
  createTaskLoading.classList.remove('hidden');
  btnSubmitProject.disabled = true;
  btnSubmitProject.textContent = "SYSTEM IS ANALYZING... KINDLY WAIT";

  const taskCode = formTaskCode.value.trim();
  if (!taskCode) return;

  const briefText = document.getElementById('form-brief-text').value.trim();
  const omniKeyInput = document.getElementById('form-omniroute-key');
  const omniKey = omniKeyInput ? omniKeyInput.value.trim() : '';
  const files = Array.from(formBriefFiles.files || []);

  try {
    // 1. Create project task with lightweight text guidelines (0 files in initial payload for 0.1s response)
    const initialFormData = new FormData();
    initialFormData.append('task_code', taskCode);
    if (briefText) {
      initialFormData.append('brief_text', briefText);
    }
    if (omniKey) {
      initialFormData.append('omniroute_api_key', omniKey);
    }

    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'X-User-Email': currentUserEmail },
      body: initialFormData
    });

    if (!res.ok) {
      let errMsg = `Server returned HTTP ${res.status}`;
      try {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const errData = await res.json();
          errMsg = errData.error || errMsg;
        } else {
          const text = await res.text();
          if (text.includes('413')) errMsg = "Brief text exceeds server limit. Please upload files directly.";
          else if (text.includes('504') || text.includes('503') || text.includes('Timeout')) errMsg = "Server timeout. Upload core assignment brief PDF/DOCX directly.";
          else errMsg = `Server Error (HTTP ${res.status})`;
        }
      } catch (e) {}
      throw new Error(errMsg);
    }

    // 2. Upload ALL attached brief files sequentially 1-by-1 (tiny 1MB individual requests)
    for (let i = 0; i < files.length; i++) {
      btnSubmitProject.textContent = `ANALYZING FILE ${i + 1}/${files.length}... KINDLY WAIT`;
      const fileFormData = new FormData();
      fileFormData.append('brief_file', files[i]);

      try {
        await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskCode)}/upload`, {
          method: 'POST',
          headers: { 'X-User-Email': currentUserEmail },
          body: fileFormData
        });
      } catch (uploadErr) {
        console.warn(`Sequential file upload warning for ${files[i].name}:`, uploadErr.message);
      }
    }

    createTaskSuccess.classList.remove('hidden');
    await loadTasksList(taskCode);

    setTimeout(() => {
      createProjectPanel.classList.add('hidden');
    }, 1500);

  } catch (err) {
    createTaskError.textContent = `ERR: ${err.message.toUpperCase()}`;
    createTaskError.classList.remove('hidden');
  } finally {
    createTaskLoading.classList.add('hidden');
    btnSubmitProject.disabled = false;
    btnSubmitProject.textContent = "SUBMIT PROJECT GUIDELINES";
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

async function executeQC(isRework) {
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
  if (btnExecuteResubmit) btnExecuteResubmit.disabled = true;
  
  if (isRework) {
    btnExecuteResubmit.textContent = "EVALUATING PREVIOUS FEEDBACK...";
  } else {
    btnExecuteAudit.textContent = "AUDITING SUBMISSION...";
  }
  
  auditLoading.classList.remove('hidden');

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('solution_files', files[i]);
  }

  try {
    const endpoint = isRework 
      ? `${API_BASE}/api/tasks/${activeTaskCode}/audit?rework=true`
      : `${API_BASE}/api/tasks/${activeTaskCode}/audit`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-User-Email': currentUserEmail },
      body: formData
    });

    if (!res.ok) {
      let err;
      try {
        err = await res.json();
      } catch (parseErr) {
        throw new Error(`Server returned status ${res.status} but response was not valid JSON.`);
      }
      throw new Error(err.error || err.message || JSON.stringify(err) || `HTTP Error ${res.status}`);
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
    
    if (btnExecuteResubmit) {
      btnExecuteResubmit.disabled = false;
      btnExecuteResubmit.textContent = "🔄 RESUBMIT FOR RE-EVALUATION (FEEDBACK CHECK ONLY)";
    }
    auditLoading.classList.add('hidden');
  }
}

auditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await executeQC(false);
});

if (btnExecuteResubmit) {
  btnExecuteResubmit.addEventListener('click', async (e) => {
    e.preventDefault();
    await executeQC(true);
  });
}

// ==================== RENDERING COMPLIANCE & SECTION METRICS ====================

function renderLayoutAnalytics(data) {
  if (!data || !data.formatting) {
    layoutAnalyticsBox.classList.add('hidden');
    return;
  }

  layoutAnalyticsBox.classList.remove('hidden');
  metaSpacing.textContent = data.formatting.spacing.toUpperCase();
  metaAlignment.textContent = data.formatting.alignment.toUpperCase();

  if (data.report) {
    const payload = data.report;
    const totalWordsMatch = payload.match(/\*\*Total Word Count:\*\* (\d+) words/);
    const validWordsMatch = payload.match(/\*\*Valid Word Count \(Excl\. Refs\/TOC\):\*\* (\d+) words/);
    const metaTotalWords = document.getElementById('meta-total-words');
    const metaValidWords = document.getElementById('meta-valid-words');
    if (metaTotalWords) metaTotalWords.textContent = totalWordsMatch ? totalWordsMatch[1] : "---";
    if (metaValidWords) metaValidWords.textContent = validWordsMatch ? validWordsMatch[1] : "---";
    
    const metadataStatusBanner = document.getElementById('metadata-status-banner');
    if (metadataStatusBanner) {
      metadataStatusBanner.classList.remove('hidden');
      if (payload.includes('⚠️ ALARM: Personal properties found')) {
        metadataStatusBanner.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        metadataStatusBanner.style.color = '#FCA5A5';
        metadataStatusBanner.style.border = '2px dashed rgba(239, 68, 68, 0.5)';
        const nameMatch = payload.match(/Author: (.*?)\)\./);
        metadataStatusBanner.innerHTML = `⚠️ METADATA ALARM: File contains personal properties (Author: ${nameMatch ? nameMatch[1] : 'Unknown'}). Remove properties before sending!`;
      } else if (payload.includes('✅ METADATA CLEAN')) {
        metadataStatusBanner.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
        metadataStatusBanner.style.color = '#A7F3D0';
        metadataStatusBanner.style.border = '2px dashed rgba(16, 185, 129, 0.5)';
        metadataStatusBanner.innerHTML = `✅ METADATA CLEAN: No personal properties or author names detected in file.`;
      } else {
        metadataStatusBanner.classList.add('hidden');
      }
    }
  }

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
  html = html.replace(/^### (.*$)/gim, '### $1');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  // Lists
  html = html.replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>');
  html = html.replace(/<\/ul>\s*<ul>/gim, ''); // Combine consecutive ul elements
  
  // Newlines to break lines
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

// TL Override Save Handler
const btnSaveGuidance = document.getElementById('btn-save-guidance');
if (btnSaveGuidance) {
  btnSaveGuidance.addEventListener('click', async () => {
    if (!activeTaskCode) return;
    const guidanceContainer = document.getElementById('val-course-of-action');
    if (!guidanceContainer) return;

    btnSaveGuidance.disabled = true;
    btnSaveGuidance.textContent = 'SAVING...';

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${activeTaskCode}/guidance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Email': currentUserEmail
        },
        body: JSON.stringify({ newGuidance: guidanceContainer.value })
      });

      if (!res.ok) {
        throw new Error('Failed to save override');
      }

      btnSaveGuidance.textContent = '✅ SAVED!';
      
      // Update local task state
      const taskIndex = loadedTasks.findIndex(t => t.task_code === activeTaskCode);
      if (taskIndex !== -1) {
        const { brief_text } = await res.json();
        loadedTasks[taskIndex].brief_text = brief_text;
      }
    } catch (err) {
      console.error(err);
      btnSaveGuidance.textContent = '❌ ERROR';
    } finally {
      setTimeout(() => {
        btnSaveGuidance.disabled = false;
        btnSaveGuidance.textContent = '💾 SAVE OVERRIDE';
      }, 2000);
    }
  });
}
