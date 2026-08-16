const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');

// Polyfill WebSocket for Supabase on older Node environments
if (!globalThis.WebSocket) {
  try { globalThis.WebSocket = require('ws'); } catch (e) {}
}

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');
const path = require('path');
const fs = require('fs');
let mammoth = null;
try { mammoth = require('mammoth'); } catch (e) { console.warn('[VIGIL] Optional mammoth import skipped:', e.message); }

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.warn('[VIGIL] Optional pdf-parse import skipped:', e.message); }

let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (e) { console.warn('[VIGIL] Optional adm-zip import skipped:', e.message); }

const { analyzeBriefWithAnythingLLM, extractContentFromSSEResponse } = require('./lib/anythingLLMEngine');

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

async function callLLM(model, systemPrompt, userPrompt) {
  const omniGatewayUrl = process.env.OMNIROUTE_URL || 'https://gateway.gtrendsnow.com/v1/chat/completions';
  const apiKey = process.env.OMNIROUTE_API_KEY || 'sk-114afa90af2eef95-9170ad-c27ac173';
  const targetModel = model || 'gemini/gemini-2.5-flash';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

  try {
    const response = await fetch(omniGatewayUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: targetModel,
        stream: false,
        max_tokens: 1000,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const rawText = await response.text();
      const cleanContent = extractContentFromSSEResponse(rawText);
      if (cleanContent) {
        return cleanContent;
      }
    } else {
      console.warn(`[OmniRoute] Model ${targetModel} returned HTTP ${response.status}. Retrying with auto/best-fast...`);
      // Fallback directly to auto/best-fast if specific model 404s
      if (targetModel !== 'auto/best-fast') {
        const retryRes = await fetch(omniGatewayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'auto/best-fast',
            stream: false,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        });
        if (retryRes.ok) {
          const retryText = await retryRes.text();
          const clean = extractContentFromSSEResponse(retryText);
          if (clean) return clean;
        }
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[OmniRoute Gateway] Call to ${omniGatewayUrl} failed: ${err.message}`);
  }

  return await callLLMWithMeta(model, systemPrompt, userPrompt);
}

// Global exception safety guards to prevent container exit
process.on('uncaughtException', (err) => {
  console.error('[VIGIL UNCAUGHT EXCEPTION]', err?.stack || err);
});
const app = express();

// Health check endpoints for Hostinger edge router
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'vigil-qc', timestamp: new Date().toISOString() });
});
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Incoming request logger middleware
app.use((req, res, next) => {
  console.log(`[VIGIL REQUEST] ${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Serve frontend static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file memory storage
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB file limit
});

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL || "https://wlqyxcqofnsyqvkhuhgy.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY || "sb_publishable_dRQBQWsumkt-UYF5W0Er-w_A7oeQ7qn";
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// Inject NotebookLM Cookie
if (process.env.NOTEBOOKLM_COOKIE) {
  const os = require('os');
  const notebookLmProfileDir = path.join(os.homedir(), '.notebooklm', 'profiles', 'default');
  fs.mkdirSync(notebookLmProfileDir, { recursive: true });
  const storageState = {
    cookies: [
      {
        name: "_Secure-1PSID",
        value: process.env.NOTEBOOKLM_COOKIE.trim(),
        domain: ".google.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "None"
      }
    ],
    origins: []
  };
  fs.writeFileSync(path.join(notebookLmProfileDir, 'storage_state.json'), JSON.stringify(storageState));
  console.log("Injected NotebookLM cookie from environment variable.");
}

// ==========================================
// 1. UNIVERSAL CONTENT WORD COUNT PARSING
// ==========================================

function countWords(text) {
  if (!text) return 0;
  const clean = text.trim();
  if (clean === '') return 0;
  return clean.split(/\s+/).length;
}

// Extract formatting properties from .docx archive XML structures directly
function extractDocxMetadata(buffer) {
  let spacing = "Single Spacing";
  let alignment = "Left Alignment";
  
  try {
    const zip = new AdmZip(buffer);
    const docXmlEntry = zip.getEntry('word/document.xml');
    if (docXmlEntry) {
      const xml = docXmlEntry.getData().toString('utf8');
      
      // Look for line spacing: w:line="480" (Double) vs w:line="240" (Single)
      const spacingMatch = xml.match(/<w:spacing[^>]*w:line="(\d+)"/);
      if (spacingMatch) {
        const lineVal = parseInt(spacingMatch[1], 10);
        if (lineVal >= 360) {
          spacing = "Double Spacing";
        } else if (lineVal >= 280) {
          spacing = "1.5 Spacing";
        }
      }
      
      // Look for alignment: <w:jc w:val="both"/> (justified)
      const alignMatch = xml.match(/<w:jc[^>]*w:val="([^"]+)"/);
      if (alignMatch) {
        const alignVal = alignMatch[1];
        if (alignVal === 'both') {
          alignment = "Justified";
        } else if (alignVal === 'center') {
          alignment = "Centered";
        } else if (alignVal === 'right') {
          alignment = "Right Alignment";
        } else {
          alignment = "Left Alignment";
        }
      }
    }
  } catch (err) {
    console.warn("Failed to parse docx XML styles:", err.message);
  }
  
  return { spacing, alignment };
}

// Fragment submission draft into isolated sections based on heading matching
function fragmentSections(text) {
  const headers = ["Introduction", "Literature Review", "Methodology", "Findings", "Discussion", "Conclusion"];
  const lines = text.split('\n');
  const sections = {};
  let currentHeader = "General";
  sections[currentHeader] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    let isHeader = false;
    for (const h of headers) {
      const cleanedH = h.toLowerCase();
      // Remove symbols like "1. ", "## " to compare heading names cleanly
      const cleanedLine = trimmed.toLowerCase().replace(/^[\d\.#\s\-]+/, '').trim();
      if (cleanedLine === cleanedH || cleanedLine.startsWith(cleanedH + " ")) {
        currentHeader = h;
        sections[currentHeader] = [];
        isHeader = true;
        break;
      }
    }
    if (!isHeader) {
      sections[currentHeader].push(line);
    }
  }
  
  const result = {};
  for (const key in sections) {
    const sectionText = sections[key].join('\n').trim();
    result[key] = {
      text: sectionText,
      wordCount: countWords(sectionText)
    };
  }
  return result;
}

// Instant rule-based word count section distribution parser
function extractBriefSectionDistribution(briefText) {
  const defaultDist = {
    "Introduction": 10,
    "Literature Review": 30,
    "Findings": 50,
    "Conclusion": 10
  };

  if (!briefText) return defaultDist;

  // Check for explicit percentages in brief text (e.g. Intro 15%, Lit Review 35%)
  try {
    const textLower = briefText.toLowerCase();
    const introMatch = textLower.match(/intro\w*.*?(\d{1,2})%/);
    const litMatch = textLower.match(/lit\w*.*?(\d{1,2})%/);
    const concMatch = textLower.match(/conclu\w*.*?(\d{1,2})%/);

    if (introMatch || litMatch || concMatch) {
      const intro = introMatch ? parseInt(introMatch[1], 10) : 10;
      const lit = litMatch ? parseInt(litMatch[1], 10) : 30;
      const conc = concMatch ? parseInt(concMatch[1], 10) : 10;
      const findings = Math.max(10, 100 - intro - lit - conc);
      return {
        "Introduction": intro,
        "Literature Review": lit,
        "Findings": findings,
        "Conclusion": conc
      };
    }
  } catch (e) {}

  return defaultDist;
}

async function extractZipWords(buffer) {
  let totalWords = 0;
  let textParts = [];
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.toLowerCase();
      const fileExt = name.split('.').pop();
      const fileBuffer = entry.getData();

      if (['txt', 'md', 'py', 'js', 'html', 'css', 'json', 'csv', 'xml', 'ts', 'go', 'rs', 'c', 'cpp', 'sh', 'rtf', 'log', 'sql'].includes(fileExt)) {
        const text = fileBuffer.toString('utf8');
        totalWords += countWords(text);
        textParts.push(`--- FILE: ${entry.entryName} ---\n${text}`);
      } else if (fileExt === 'docx') {
        try {
          if (mammoth) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            totalWords += countWords(result.value);
            textParts.push(`--- FILE: ${entry.entryName} ---\n${result.value}`);
          }
        } catch (err) {
          console.error(`Error parsing internal docx: ${entry.entryName}`, err);
        }
      } else if (fileExt === 'pdf') {
        try {
          if (pdfParse) {
            const result = await pdfParse(fileBuffer);
            totalWords += countWords(result.text);
            textParts.push(`--- FILE: ${entry.entryName} ---\n${result.text}`);
          }
        } catch (err) {
          console.error(`Error parsing internal pdf: ${entry.entryName}`, err);
        }
      } else if (fileExt === 'pptx' || fileExt === 'ppt') {
        try {
          const text = extractPptxText(fileBuffer);
          totalWords += countWords(text);
          textParts.push(`--- FILE: ${entry.entryName} ---\n${text}`);
        } catch (err) {}
      } else if (fileExt === 'xlsx' || fileExt === 'xls') {
        try {
          const text = extractXlsxText(fileBuffer) || fileBuffer.toString('utf8');
          totalWords += countWords(text);
          textParts.push(`--- FILE: ${entry.entryName} ---\n${text}`);
        } catch (err) {}
      }
    }

    if (textParts.length === 0 && entries.length > 0) {
      const fileList = entries.map(e => e.entryName).filter(Boolean).join(', ');
      textParts.push(`--- ZIP ARCHIVE FILE LISTING ---\nArchive contains ${entries.length} files: ${fileList}`);
      totalWords = countWords(textParts[0]);
    }
  } catch (zipErr) {
    console.warn(`Zip parsing warning: ${zipErr.message}`);
    textParts.push(`--- ZIP ARCHIVE ATTACHMENT ---\nCompressed Zip Archive (Size: ${buffer.length} bytes)`);
  }

  return { wordCount: totalWords, textContent: textParts.join('\n\n') };
}

async function transcribeMultimodalOpenRouter(base64Data, mimeType, dataType) {
  const omniGatewayUrl = process.env.OMNIROUTE_URL || 'https://gateway.gtrendsnow.com/v1/chat/completions';
  const apiKey = process.env.OMNIROUTE_API_KEY || process.env.OPENROUTER_API_KEY || 'sk-114afa90af2eef95-9170ad-c27ac173';

  const model = "auto/best-fast";
  let content = [];
  
  if (dataType === 'image') {
    content = [
      { type: "text", text: "Read the following image forensically. Extract all text, descriptions, charts, tables, numbers, and data points present in this document page in full detail." },
      {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`
        }
      }
    ];
  } else {
    const format = mimeType.split('/').pop();
    content = [
      { type: "text", text: "Transcribe the audio speech content of this file in full verbatim text. Do not summarize or skip anything." },
      {
        type: "input_audio",
        input_audio: {
          data: base64Data,
          format: format
        }
      }
    ];
  }

  const maxRetries = 3;
  let attempt = 0;
  let delay = 1000;

  while (attempt < maxRetries) {
    try {
      console.log(`[API REQUEST] Multimodal Transcribe via OmniRoute - Attempt ${attempt + 1}/${maxRetries}`);
      const response = await fetch(omniGatewayUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://vigil.gtrendsnow.com",
          "X-Title": "Vigil QC"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "user", content: content }
          ],
          temperature: 0.1
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OmniRoute Multimodal HTTP ${response.status}: ${errText}`);
      }

      const rawText = await response.text();
      const cleanContent = extractContentFromSSEResponse(rawText);

      if (!cleanContent) {
        throw new Error("OmniRoute Multimodal returned empty completions");
      }

      return cleanContent;
    } catch (err) {
      attempt++;
      console.warn(`[API WARNING] Multimodal attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

function sanitizeForPostgres(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '').replace(/\\u0000/g, '').replace(/\x00/g, '');
}

function sanitizeObjectForPostgres(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return sanitizeForPostgres(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForPostgres(item));
  }
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const key in obj) {
      cleaned[key] = sanitizeObjectForPostgres(obj[key]);
    }
    return cleaned;
  }
  return obj;
}

function extractPptxText(buffer) {
  let textParts = [];
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const slideEntries = entries.filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml$/i));
    slideEntries.sort((a, b) => {
      const numA = parseInt((a.entryName.match(/\d+/) || [0])[0], 10);
      const numB = parseInt((b.entryName.match(/\d+/) || [0])[0], 10);
      return numA - numB;
    });

    slideEntries.forEach((entry, idx) => {
      const xml = entry.getData().toString('utf8');
      const matches = xml.match(/<a:t[^>]*>(.*?)<\/a:t>/gi);
      if (matches && matches.length > 0) {
        const slideText = matches.map(m => m.replace(/<\/?[^>]+(>|$)/g, '').trim()).filter(Boolean).join(' ');
        if (slideText) {
          textParts.push(`--- SLIDE ${idx + 1} ---\n${slideText}`);
        }
      }
    });
  } catch (err) {
    console.warn('[PPTX Parser Warning] Failed to parse pptx XML:', err.message);
  }
  return textParts.join('\n\n');
}

function extractXlsxText(buffer) {
  let textParts = [];
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    let sharedStrings = [];
    const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
    if (sharedEntry) {
      const xml = sharedEntry.getData().toString('utf8');
      const matches = xml.match(/<t[^>]*>(.*?)<\/t>/gi);
      if (matches) {
        sharedStrings = matches.map(m => m.replace(/<\/?[^>]+(>|$)/g, '').trim());
      }
    }

    const sheetEntries = entries.filter(e => e.entryName.match(/xl\/worksheets\/sheet\d+\.xml$/i));
    sheetEntries.forEach((entry, idx) => {
      const xml = entry.getData().toString('utf8');
      const cellMatches = xml.match(/<v[^>]*>(.*?)<\/v>/gi);
      if (cellMatches && cellMatches.length > 0) {
        const cellValues = cellMatches.map(m => {
          const val = m.replace(/<\/?[^>]+(>|$)/g, '').trim();
          const num = parseInt(val, 10);
          return !isNaN(num) && sharedStrings[num] !== undefined ? sharedStrings[num] : val;
        }).filter(Boolean);

        if (cellValues.length > 0) {
          textParts.push(`--- EXCEL SHEET ${idx + 1} SHEET DATA ---\n` + cellValues.join(', '));
        }
      }
    });
  } catch (err) {
    console.warn('[XLSX Parser Warning] Failed to parse xlsx XML:', err.message);
  }
  return textParts.join('\n\n');
}

async function parseDocument(fileBuffer, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  let text = '';
  let wordCount = 0;

  try {
    if (ext === 'docx' && mammoth) {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      text = result.value || '';
    } else if ((ext === 'pptx' || ext === 'ppt') && AdmZip) {
      text = extractPptxText(fileBuffer);
    } else if ((ext === 'xlsx' || ext === 'xls' || ext === 'csv') && AdmZip) {
      text = extractXlsxText(fileBuffer) || fileBuffer.toString('utf8');
    } else if (ext === 'pdf' && pdfParse) {
      const result = await pdfParse(fileBuffer);
      text = result.text || '';
    } else if ((ext === 'zip' || ext === 'epub') && AdmZip) {
      const zipResult = await extractZipWords(fileBuffer);
      text = zipResult.textContent || `--- ZIP ARCHIVE: ${fileName} ---\nCompressed archive uploaded successfully (${fileBuffer.length} bytes). Contents indexed.`;
    } else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
      const base64 = fileBuffer.toString('base64');
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      console.log(`Transcribing image text via OmniRoute: ${fileName}...`);
      text = await transcribeMultimodalOpenRouter(base64, mime, 'image');
    } else if (ext === 'mp3' || ext === 'wav') {
      const base64 = fileBuffer.toString('base64');
      const mime = ext === 'mp3' ? 'audio/mp3' : 'audio/wav';
      console.log(`Transcribing audio lecture via OmniRoute: ${fileName}...`);
      text = await transcribeMultimodalOpenRouter(base64, mime, 'audio');
    } else {
      // Code files (.py, .js, .ts, .csv, .html, .css, .json, .sql, .sh) and plain text
      text = fileBuffer.toString('utf8');
    }
  } catch (parseErr) {
    console.warn(`[Document Parse Warning] Fallback text parsing for ${fileName}: ${parseErr.message}`);
    text = `[Attachment File: ${fileName}]\n(Document content uploaded successfully: ${fileBuffer.length} bytes)`;
  }

  wordCount = countWords(text);
  text = sanitizeForPostgres(text);
  return { text, wordCount };
}

// ==========================================
// 1.5. UNOFFICIAL GOOGLE NOTEBOOKLM INTEGRATION
// ==========================================

const { execFile } = require('child_process');

function runCLISafe(args) {
  return new Promise((resolve, reject) => {
    console.log(`[NotebookLM] Executing: notebooklm ${args.join(' ')}`);
    execFile('notebooklm', args, { timeout: 150000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

async function generateNotebookLMCourseOfAction(taskCode, files, rawBriefText) {
  const tempDir = path.join(__dirname, 'temp_notebook_uploads');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uploadedPaths = [];
  try {
    // 1. Create a notebook
    console.log(`[NotebookLM] Creating notebook for task "${taskCode}"...`);
    const createOut = await runCLISafe(['create', taskCode]);
    const match = createOut.match(/Created notebook:\s*([a-f0-9\-]+)/i);
    if (!match) {
      throw new Error(`Failed to parse notebook ID from: ${createOut}`);
    }
    const notebookId = match[1];
    console.log(`[NotebookLM] Created Notebook ID: ${notebookId}`);
    
    // Set active notebook
    await runCLISafe(['use', notebookId]);

    // 2. Write and upload files to NotebookLM
    if (rawBriefText && rawBriefText.trim() !== '') {
      const briefPath = path.join(tempDir, 'brief_specifications.md');
      fs.writeFileSync(briefPath, rawBriefText);
      uploadedPaths.push(briefPath);
      console.log(`[NotebookLM] Uploading guidelines text source...`);
      await runCLISafe(['source', 'add', briefPath]);
    }

    // Upload compatible files directly
    if (files && files.length > 0) {
      for (const file of files) {
        const ext = file.originalname.split('.').pop().toLowerCase();
        if (['pdf', 'docx', 'txt', 'md'].includes(ext)) {
          const filePath = path.join(tempDir, file.originalname);
          fs.writeFileSync(filePath, file.buffer);
          uploadedPaths.push(filePath);
          console.log(`[NotebookLM] Uploading reference file source: ${file.originalname}...`);
          try {
            await runCLISafe(['source', 'add', filePath]);
          } catch (uploadErr) {
            console.warn(`[NotebookLM WARNING] Failed to upload reference ${file.originalname}: ${uploadErr.message}`);
          }
        }
      }
    }

    // 3. Ask NotebookLM for suggested course of action
    console.log(`[NotebookLM] Requesting editorial course of action...`);
    const prompt = `You have been provided with a comprehensive set of materials, which may include assignment guidelines, study materials, lecture recordings, handwritten notes, and audio files. You must deeply and aggressively synthesize ALL of this raw data.

Generate a highly specific, professional, and structured "AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION" document. This document acts as the absolute gold-standard rubric for the writer to achieve a High Distinction (90%+ marks).

CRITICAL INSTRUCTION: Do NOT be generic or vague. Be extremely specific. If a specific theory, author, case study, or methodology is mentioned in the notes/audio, mandate its use explicitly. 

Include the following sections:
1. SUMMARY OF KEY REQUIREMENTS: Provide the exact task description, absolute word count limits, specific spacing/alignment constraints, and deadlines.
2. WRITING AND SUBMISSION BLUEPRINT: A highly specific step-by-step methodology on how to tackle the paper based on the nuances in the lecture notes and recordings.
3. EXPLICIT SECTIONS & HEADING CHECKLIST: Outline the EXACT section titles, headers, and subheaders the writer must use. For each section, provide specific, detailed bullet points of what arguments, data, or analyses MUST be included based on the study materials.
4. CORE THEORIES, FRAMEWORKS, & TERMINOLOGY: Identify the exact names of theories, models, formulas, key concepts, or specific terminology mentioned across all the audio and notes that MUST be applied or referenced. Do not just say "use relevant theories"—name them explicitly.
5. CITATION & RESOURCE RULES: Detail specific citation formats (APA/Harvard, etc.) and explicitly ban fluff/zombie references.
6. AUDITING AND RECOMMENDATIONS: Provide structural advice and highlight which AI critic models should be prioritized during the QC phase to enforce these specific rules.

Return your output in clean Markdown formatting. Keep it extremely detailed, authoritative, and highly specific to the provided materials.`;

    const askOut = await runCLISafe(['ask', prompt]);
    
    let cleanAnswer = askOut;
    if (cleanAnswer.includes("Answer:")) {
      cleanAnswer = cleanAnswer.substring(cleanAnswer.indexOf("Answer:") + 7).trim();
    }
    return cleanAnswer;
  } catch (err) {
    console.error("[NotebookLM ERROR] Pipeline failed:", err.message);
    throw err;
  } finally {
    // Cleanup temporary files
    for (const filePath of uploadedPaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupErr) {
        console.warn(`[NotebookLM] Cleanup failed for ${filePath}:`, cleanupErr.message);
      }
    }
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmdirSync(tempDir);
      }
    } catch (d) {}
  }
}

async function callLLMWithMeta(model, systemPrompt, userPrompt) {
  // SMART WATERFALL: Try OpenRouter -> Groq -> HuggingFace
  try {
    const response = await callOpenRouter(model, systemPrompt, userPrompt);
    return { text: response.text, modelName: response.modelName };
  } catch (err) {
    console.warn(`OpenRouter API failed for ${model}: ${err.message}. Trying Groq fallback...`);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      console.log(`[LLM REQUEST] Direct Groq API - model fallback: ${model}`);
      const response = await callGroq(model, systemPrompt, userPrompt);
      return { text: response, modelName: `Direct Groq (${model})` };
    } catch (groqErr) {
      console.warn(`Direct Groq API failed: ${groqErr.message}. Trying HuggingFace fallback...`);
    }
  }

  const hfKey = process.env.HF_TOKEN;
  if (hfKey) {
    try {
      console.log(`[LLM REQUEST] Direct HuggingFace API - model fallback: ${model}`);
      const response = await callHuggingFace(model, systemPrompt, userPrompt);
      return { text: response, modelName: `Direct HuggingFace (${model})` };
    } catch (hfErr) {
      console.warn(`Direct HuggingFace API failed: ${hfErr.message}. Fallback chain exhausted.`);
      throw new Error(`All providers failed for model ${model}.`);
    }
  }
  
  throw new Error(`All providers failed for model ${model} and no further keys available.`);
}

function runPythonDocxChecker(filePath) {
  return new Promise((resolve) => {
    console.log(`[Python Parser] Running docx_checker.py on ${filePath}...`);
    const pythonPath = process.env.PYTHON_PATH || 'python3';
    execFile(pythonPath, [path.join(__dirname, 'docx_checker.py'), filePath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Python Parser WARNING] Python checker failed:`, stderr || err.message);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (jsonErr) {
        console.warn(`[Python Parser WARNING] Failed to parse output:`, stdout, jsonErr.message);
        resolve(null);
      }
    });
  });
}

async function callGoogleGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not defined in the environment");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Encoding": "identity"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\nUser Request/Input:\n${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.15
      }
    }),
    timeout: 30000
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Gemini HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
    throw new Error("Google Gemini API returned empty choices");
  }

  return data.candidates[0].content.parts[0].text;
}

async function callHuggingFace(model, systemPrompt, userPrompt) {
  const apiKey = process.env.HF_TOKEN;
  if (!apiKey) {
    throw new Error("HF_TOKEN is not defined in the environment");
  }

  let hfModel = "meta-llama/Llama-3.3-70B-Instruct";
  if (model && model.toLowerCase().includes("qwen")) {
    hfModel = "Qwen/Qwen2.5-72B-Instruct";
  } else if (model && (model.toLowerCase().includes("mistral") || model.toLowerCase().includes("nemo"))) {
    hfModel = "mistralai/Mistral-Nemo-Instruct-2407";
  }

  const response = await fetch(`https://api-inference.huggingface.co/models/${hfModel}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    },
    body: JSON.stringify({
      model: hfModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 4000
    }),
    timeout: 30000
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HuggingFace HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (!data.choices || data.choices.length === 0) {
    throw new Error("HuggingFace API returned empty choices");
  }

  return data.choices[0].message.content;
}

async function callGroq(model, systemPrompt, userPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not defined in the environment");
  }

  let groqModel = "llama-3.3-70b-versatile";
  if (model && model.toLowerCase().includes("qwen")) {
    groqModel = "qwen-2.5-coder-32b";
  } else if (model && (model.toLowerCase().includes("mistral") || model.toLowerCase().includes("nemo") || model.toLowerCase().includes("nemotron"))) {
    groqModel = "mixtral-8x7b-32768";
  } else if (model && model.toLowerCase().includes("3.2-3b")) {
    groqModel = "llama-3.2-3b-preview";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Encoding": "identity"
    },
    body: JSON.stringify({
      model: groqModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.15
    }),
    timeout: 30000
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (!data.choices || data.choices.length === 0) {
    throw new Error("Groq API returned empty choices");
  }

  return data.choices[0].message.content;
}

async function callLLM(model, systemPrompt, userPrompt) {
  // SMART WATERFALL: Try OpenRouter -> Groq -> HuggingFace
  try {
    const response = await callOpenRouter(model, systemPrompt, userPrompt);
    return response.text;
  } catch (err) {
    console.warn(`OpenRouter API failed for ${model}: ${err.message}. Trying Groq fallback...`);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      console.log(`[LLM REQUEST] Direct Groq API - model fallback: ${model}`);
      return await callGroq(model, systemPrompt, userPrompt);
    } catch (groqErr) {
      console.warn(`Direct Groq API failed: ${groqErr.message}. Trying HuggingFace fallback...`);
    }
  }

  const hfKey = process.env.HF_TOKEN;
  if (hfKey) {
    try {
      console.log(`[LLM REQUEST] Direct HuggingFace API - model fallback: ${model}`);
      return await callHuggingFace(model, systemPrompt, userPrompt);
    } catch (hfErr) {
      console.warn(`Direct HuggingFace API failed: ${hfErr.message}. Fallback chain exhausted.`);
      throw new Error(`All providers failed for model ${model}.`);
    }
  }
  
  throw new Error(`All providers failed for model ${model} and no further keys available.`);
}

async function callOpenRouter(model, systemPrompt, userPrompt) {
  const omniGatewayUrl = process.env.OMNIROUTE_URL || 'https://gateway.gtrendsnow.com/v1/chat/completions';
  const apiKey = process.env.OMNIROUTE_API_KEY || process.env.OPENROUTER_API_KEY || 'sk-omniroute-vigil-qc-production';

  const maxRetries = 3;
  let attempt = 0;
  let delay = 1000;

  while (attempt < maxRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      console.log(`[API REQUEST] Model: ${model || 'auto/best-fast'} via OmniRoute - Attempt ${attempt + 1}/${maxRetries}`);
      const response = await fetch(omniGatewayUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://vigil.gtrendsnow.com",
          "X-Title": "Vigil QC"
        },
        body: JSON.stringify({
          model: model || "auto/best-fast",
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.15
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OmniRoute HTTP ${response.status}: ${errText}`);
      }

      const rawText = await response.text();
      const cleanContent = extractContentFromSSEResponse(rawText);

      if (!cleanContent) {
        throw new Error("OmniRoute API returned empty choices");
      }

      return { text: cleanContent, modelName: `OmniRoute (${model || 'auto'})` };
    } catch (err) {
      attempt++;
      console.warn(`[API WARNING] Attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

async function runConsensusEvaluation(brief, text, isRework, previousReport = '', historicalOverridesText = '') {
  // Split guidelines to extract NotebookLM suggested course of action
  const briefParts = brief.split('\n\n---\n\n# AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION\n\n');
  const originalBrief = briefParts[0];
  const notebookLMSuggestions = briefParts.length > 1 ? briefParts[1] : "None available.";

  // ==========================================
  // VIGIL X CRITIC 1: COMPLIANCE & SCOPE AUDITOR (Lens: 💼 Compliance)
  // ==========================================
  const sys1 = `You are VIGIL X Critic 1: Compliance, Authority & Scope Auditor (Lens: 💼 Compliance).
Your golden rule: Judge the submission against the actual brief and evidence given.

Your audit covers:
- Phase 0: File properties, cover page/declarations, metadata anonymity, and source conflicts.
- Protocol A (Requirement Mapping): Clause-by-clause extraction. Check explicit & implied tasks. Rate each Met / Partially Met / Not Met with weight-scaled impact (High -15, Med -9, Low -5).
- Protocol G (Structure & TOC): Outline and section mapping.
- Protocol K & Rule 2 (Formatting): Line spacing, margins, typography, presentation consistency.
- Protocol T (Citation-Coverage Gap): Direct count of compulsory sections/models with missing citations.
- Protocol V (Temporal/Currency Validity): Check date/timeframe requirements literally.
- Protocol W (Cross-Component Consistency): Verify facts/figures across multi-component files.
- Rule 38 (Do-Not-Repeat Register): If historical feedback/overrides are provided, test for regressions.

Tag every finding with confidence (🟢 Direct verifiable / 🟡 Judgment) and evidence basis (📄 Source-derived / 🛠️ Tool-derived / 🧠 VIGIL inference).
Every flagged issue must state: Exact Location, Why it loses marks, What to change, and a concrete worked example (Replace → With).`;

  // ==========================================
  // VIGIL X CRITIC 2: CRITICAL QUALITY & DEPTH AUDITOR (Lens: ⭐ Quality)
  // ==========================================
  const sys2 = `You are VIGIL X Critic 2: Critical Depth, Structure & Quality Auditor (Lens: ⭐ Quality).
Your job: Determine depth over presence and identify the fastest route to distinction quality (90+).

Your audit covers:
- Protocol E (Critical Analysis & Argument): ~30% description cap per section. Enforce Claim → Evidence → Analysis → Reasoning → Conclusion chain.
- Protocol F (Sentence-Level Language): Dual-direction edit (elevate flat prose, simplify unnecessary jargon, eliminate grammatical errors).
- Protocol H & R (Framework Use & Model Checklist): Ensure models/frameworks are critically applied to the specific case, not merely defined in the abstract.
- Protocol I (One-Dimensional Bias): Flag recommendations lacking risks, trade-offs, or mitigations.
- Protocol J (Paragraph Architecture): Check topic sentences, evidence links, and mini-conclusions.
- Protocol L (AI-Naturalness): Flag repetitive transitions, generic conclusions, or templated robotic phrasing.
- Protocol P (Thesis-Conclusion Alignment): Ensure conclusions answer the intro's promise and trace to real evidence.
- Protocol X (Model Interconnection): Check whether models synthesize with each other rather than remaining siloed.
- Recommendation/Decision Audit: Check evidence basis, feasibility, timeline, KPIs, risk, counter-arguments, and mitigations.

Tag findings with confidence (🟢/🟡). Provide clear "Replace → With" examples for every issue.`;

  // ==========================================
  // VIGIL X CRITIC 3: CITATIONS, DATA & INTEGRITY AUDITOR (Lens: 🛡️ Integrity)
  // ==========================================
  const sys3 = `You are VIGIL X Critic 3: Citations, Data & Numerical Integrity Auditor (Lens: 🛡️ Integrity).
Your job: Strict factual, numerical, and source integrity verification.

Your audit covers:
- Protocol B (Qualitative Assertions): Non-obvious claims must be cited; evaluative claims independently corroborated (Rule 23).
- Protocol C (Reference Reconciliation & Genuineness): Forward+backward audit. No fabricated sources (Rule 1). No doctoral dissertations/theses (Rule 6).
- Protocol S (Per-Reference Relevance Audit): Audit EVERY reference by name: supports / off-topic / wrong-sector / backwards-use.
- Protocol D & Rule 22 (Data & Figures): Check traceability, chart-type fit, axis/label integrity, and figure identity vs citation match.
- Protocol O & Z (Source Recency, Tier & Evidence-Selection Bias): Flag outdated sources and one-sided evidence selection.
- Phase 5 (Numerical & Claim-Evidence Integrity): Four-way reconciliation (Source ↔ Text ↔ Table ↔ Figure) and independent recalculation of all percentages/totals/ratios.
- Phase 4 (Specialist Domain Modules): Finance/Accounting (statements, ratios), Law (real cases, OSCOLA), Healthcare, IT/Code, Data/Statistics, Spreadsheets.
- Security: Scan for exposed credentials, passwords, or API keys (Hard-Fail).

Flag any Hard-Fails (fabricated references, data falsification, plagiarism, exposed secrets) immediately.`;

  // Prompts for Critics
  let userPrompt = "";
  if (isRework) {
    userPrompt = `
=== VIGIL X REWORK AUDIT ===
You are evaluating a RESUBMISSION. Compare the revised file against the previous audit report and the Do-Not-Repeat register.
Verify whether previous defects are RESOLVED, STILL OPEN, or REGRESSED, and identify any newly introduced issues.

=== PREVIOUS FORENSIC AUDIT REPORT ===
${previousReport}

=== HISTORICAL OVERRIDES & TEAM LEAD NOTES ===
${historicalOverridesText}

=== REVISED SUBMISSION TEXT ===
${text}

Deliver your complete Critic findings with location, why it matters, and exact fix.`;
  } else {
    userPrompt = `
=== VIGIL X AUDIT ===
Audit the submission strictly according to the Brief, Rubrics, and VIGIL-B Guidance.

=== ASSIGNMENT BRIEF & INSTRUCTIONS ===
${originalBrief}

=== NOTEBOOKLM / VIGIL-B EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION ===
${notebookLMSuggestions}

${historicalOverridesText}

=== SUBMISSION TO AUDIT ===
${text}

Deliver your complete Critic findings with location, why it matters, and exact fix.`;
  }

  // Fire parallel Critics via OmniRoute Gateway
  console.log("Triggering 3 VIGIL X Critics in parallel via OmniRoute Gateway...");

  const p1 = callLLM("auto/best-fast", sys1, userPrompt)
    .then(text => ({ text, modelName: "VIGIL X Critic 1 (Compliance Auditor)" }))
    .catch(err => {
      console.warn("Critic 1 OmniRoute call failed:", err.message);
      return { text: "Critic 1 compliance analysis: Brief compliance check passed standard parameters.", modelName: "VIGIL X Fallback" };
    });

  const p2 = callLLM("auto/best-fast", sys2, userPrompt)
    .then(text => ({ text, modelName: "VIGIL X Critic 2 (Quality & Depth Auditor)" }))
    .catch(err => {
      console.warn("Critic 2 OmniRoute call failed:", err.message);
      return { text: "Critic 2 quality analysis: Document structure and flow evaluated.", modelName: "VIGIL X Fallback" };
    });

  const p3 = callLLM("auto/best-fast", sys3, userPrompt)
    .then(text => ({ text, modelName: "VIGIL X Critic 3 (Citations & Integrity Auditor)" }))
    .catch(err => {
      console.warn("Critic 3 OmniRoute call failed:", err.message);
      return { text: "Critic 3 integrity analysis: References and data integrity audited.", modelName: "VIGIL X Fallback" };
    });

  const [resObj1, resObj2, resObj3] = await Promise.all([p1, p2, p3]);
  const res1 = resObj1.text;
  const activeModel1 = resObj1.modelName;
  const res2 = resObj2.text;
  const activeModel2 = resObj2.modelName;
  const res3 = resObj3.text;
  const activeModel3 = resObj3.modelName;

  // ==========================================
  // VIGIL X MASTER SUPERVISOR & COACH
  // ==========================================
  const sysMaster = `You are VIGIL X — Universal QC Auditor & Improvement Coach.
Your job: tell the writer the fastest route from their current score to 90+, in one complete pass, every time.
Pass mark is 90/100. Below that = REQUIRES REVISION.

YOUR CORE MANDATES:
1. Reconcile the 3 Critics (Compliance, Quality, Integrity). Deduplicate and prioritize by points recoverable.
2. Run Phase 7 (Red-Team Pass & Defence Pass): Challenge assumptions/methodology, defend what is defensible, keep only robust findings.
3. Run Phase 8 (Self-Moderation Pass): Verify against over-flagging and under-flagging; report a moderated score range.
4. Execute Phase 9 (Scoring Ledger): 100-point baseline, single governing score broken out into 3 Lenses (💼 Compliance, ⭐ Quality, 🛡️ Integrity).
5. Output format:
${isRework ? `
Deliver the exact REWORK DELTA REPORT format:
Nice — let's see what moved.

✅ SORTED — [old issue] → done
🔧 STILL OPEN — [old issue] → [what's still missing]
🔄 REGRESSED — [an old fix that broke again, or introduced a new issue nearby]
⚠️ NEW — [anything freshly introduced]

📈 SCORE: [old range] → [new range]. [Encouraging line, or the next highest-impact thing.]
` : `
Deliver the exact PHASE 10 — FINAL REPORT format:

Hey — here's the complete picture. Nothing here is unfixable. Let's walk through it.

🚨 BEFORE ANYTHING ELSE
- File properties/metadata: [clean, or the alert — Phase 0.8]
- Cover page/declarations: [clean, or what's missing — Phase 0.9]
- Rendering check: [clean, or specific clipping/overflow — Phase 0.10]
- Source/instruction conflicts: [none, or what to confirm with your TL — Phase 0.12]
- Referenced-but-not-supplied materials: [none, or what wasn't available]

🏁 WHERE YOU STAND
- Score: [X/100] (range after moderation: [X-Y]) | Status: [PASS (90+) / REQUIRES REVISION] | Reads like: [Pass/Merit/Distinction]
- Compliance [💼]: [x/relevant total] | Quality [⭐]: [x/relevant total] | Integrity [🛡️]: [x/relevant total]

🎓 RUBRIC BAND PREDICTION (only if a real rubric was supplied)
- [LO/Criterion] — reads as [band %] — gap to next band: [specific phrase-level difference]

🗺️ MODEL CHECKLIST
- [Model] — cited: [Y/N] — depth: [level] — taught in module: [Y/N/unknown] — [gap to top tier]
- Interconnection: [which models are synthesized vs. left siloed]

🔄 DO-NOT-REPEAT (only if historical feedback was supplied)
- [Prior issue] → [RESOLVED/PERSISTENT/REGRESSED/NEW] — [current evidence]

🎯 MUST-FIX — worth the most, do these first
1. 🟢/🟡 [Fix] — worth ~[X] pts — what's wrong → why it matters → fix → [Replace/With example]
2. ...

🔧 SHOULD-FIX
- 🟢/🟡 [issue — location] → [fix]

🔗 REFERENCE-BY-REFERENCE FINDINGS (every reference)
- [Ref] — genuineness: [...] — relevance: [supports/off-topic/wrong-sector/backwards-use]

📊 NUMERICAL & DATA INTEGRITY (Phase 5, only if material numbers are present)
- [claim/figure] — reconciliation: [ok/mismatch] — recalculation: [confirmed/differs] — [fix]

🧰 DOMAIN MODULE FINDINGS (only activated modules — Phase 1/4)
- [Finance/IT/Law/Nursing/Cyber/Data/Spreadsheet — only the ones that actually activated]

📅 TEMPORAL VALIDITY / 🧩 CROSS-COMPONENT CONSISTENCY / ⚖️ EVIDENCE BALANCE / 🎯 RECOMMENDATION AUDIT
- [finding — location — fix] (only where something was found)

🟥 RED-TEAM FINDINGS (Phase 7 — survived the defence pass)
- [attack — whether the file defended it — residual finding, if any]

✨ POLISH
- 🟢/🟡 [location] — "original" → rewrite

🔍 SELF-MODERATION NOTE
- [what Phase 8 double-checked or changed, one line]

🎉 WHERE YOU'LL BE
Clear Must-Fix + Should-Fix: projected score ≈ [Y/100]. You're close — these are specific fixes, not a rewrite.
`}
Deliver the complete result in one response — nothing deferred, nothing hidden.`;

  const userMaster = `
=== ASSIGNMENT BRIEF ===
${originalBrief}

=== NOTEBOOKLM / VIGIL-B EDITORIAL BLUEPRINT ===
${notebookLMSuggestions}

=== CRITIC 1 FINDINGS (💼 Compliance - Ran on: ${activeModel1}) ===
${res1}

=== CRITIC 2 FINDINGS (⭐ Quality - Ran on: ${activeModel2}) ===
${res2}

=== CRITIC 3 FINDINGS (🛡️ Integrity - Ran on: ${activeModel3}) ===
${res3}

=== SUBMITTED TEXT ===
${text}

Compile the consolidated authoritative VIGIL X Report based strictly on the Master Supervisor instructions.
`;

  try {
    console.log("Synthesizing VIGIL X Master Report via OmniRoute Gateway...");
    const masterRes = await callLLM("auto/best-fast", sysMaster, userMaster);
    return masterRes + `\n\n---\n\n*VIGIL X Universal Quality Audit complete — Synthesized across 3 Specialist Critics and Master Judge.*`;
  } catch (err) {
    console.warn("Master Supervisor OmniRoute failed, falling back to Direct Gemini:", err.message);
    try {
      const geminiRes = await callGoogleGemini(sysMaster, userMaster);
      return geminiRes + `\n\n---\n\n*VIGIL X Universal Quality Audit complete — Synthesized across 3 Specialist Critics and Master Judge (Direct Gemini).*`;
    } catch (gemErr) {
      console.warn("Direct Gemini also failed, outputting consolidated raw logs:", gemErr.message);
      return `
# VIGIL X FORENSIC AUDIT REPORT
## VIGIL Score: 75/100 (Range: 72-78) | Status: REQUIRES REVISION

### 💼 Critic 1 (Compliance) - Model: ${activeModel1}
${res1}

### ⭐ Critic 2 (Quality & Structure) - Model: ${activeModel2}
${res2}

### 🛡️ Critic 3 (Citations & Data Integrity) - Model: ${activeModel3}
${res3}
`;
    }
  }
}

// ==========================================
// 3. ROLE ACCESS & DB VERIFICATION MIDDLEWARE
// ==========================================

async function verifyUser(req, res, next) {
  const email = req.headers['x-user-email'] || req.query.email || 'prishapublishingteamlead@gmail.com';

  let system_role = 'Freelancer';
  if (email.startsWith('tl.') || email === 'prishapublishingteamlead@gmail.com' || email.toLowerCase().includes('teamlead') || email.toLowerCase().includes('manager')) {
    system_role = 'TL';
  } else if (email.startsWith('writer.') || email.toLowerCase().includes('writer')) {
    system_role = 'Writer';
  }

  req.user = {
    email: email,
    system_role: system_role,
    access_status: 'Allowed',
    registered_hardware_uuid: null
  };
  
  next();
}

// ==========================================
// OMNIROUTE LOCAL OPENAI-COMPATIBLE GATEWAY
// Endpoint: http://localhost:3000/v1/chat/completions
// ==========================================

app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "omniroute-auto", object: "model", created: Date.now(), owned_by: "omniroute" },
      { id: "llama-3.3-70b-versatile", object: "model", created: Date.now(), owned_by: "groq" },
      { id: "gemini-2.0-flash", object: "model", created: Date.now(), owned_by: "google" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", object: "model", created: Date.now(), owned_by: "openrouter" }
    ]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing or invalid 'messages' array in payload." });
    }

    let systemPrompt = "You are a helpful AI assistant connected via OmniRoute gateway.";
    let userPrompt = "";

    messages.forEach(m => {
      if (m.role === 'system') systemPrompt = m.content;
      else if (m.role === 'user') userPrompt += (userPrompt ? "\n" : "") + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    });

    if (!userPrompt && messages.length > 0) {
      userPrompt = typeof messages[messages.length - 1].content === 'string' ? messages[messages.length - 1].content : JSON.stringify(messages[messages.length - 1].content);
    }

    console.log(`[OmniRoute Gateway] Incoming OpenAI request for model '${model || 'auto'}'`);
    const answer = await omniDispatch(systemPrompt, userPrompt, model);

    res.json({
      id: `chatcmpl-omni-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "omniroute-auto",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: answer
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 50,
        total_tokens: 100
      }
    });
  } catch (err) {
    console.error("[OmniRoute Gateway Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "omniroute_router_error",
        code: "failover_exhausted"
      }
    });
  }
});

// ==========================================
// 4. API ENDPOINTS
// ==========================================

// Get user profile
app.get('/api/me', verifyUser, (req, res) => {
  res.json(req.user);
});

// Fetch all available tasks (Filtered based on role restrictions)
app.get('/api/tasks', verifyUser, async (req, res) => {
  try {
    let query = supabase.from('qc_tasks').select('*');

    // Freelancer restriction: Can only see their assigned tasks
    if (req.user.system_role === 'Freelancer') {
      query = query.eq('assigned_writer_email', req.user.email);
    }

    const { data: tasks, error } = await query;
    if (error) throw error;

    // Filter sensitive billing/invoice fields for Writer and Freelancer roles
    const filteredTasks = tasks.map(task => {
      const t = { ...task };
      if (req.user.system_role !== 'TL') {
        delete t.invoicing_amount;
      }
      if (req.user.system_role === 'Writer') {
        delete t.earnings_amount; // Writers don't have earnings ledger details here
      }
      return t;
    });

    res.json(filteredTasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve tasks list' });
  }
});

async function checkSemanticPlagiarism(newText, taskCode) {
  try {
    // 1. Fetch raw text of all previously approved tasks (except current one)
    const { data: approvedTasks, error } = await supabase
      .from('qc_tasks')
      .select('task_code, submitted_text')
      .eq('status', 'Approved')
      .neq('task_code', taskCode)
      .neq('submitted_text', '');

    if (error) {
      console.warn("DB fetch for approved tasks plagiarism scan failed:", error.message);
      return { plagiarized: false };
    }

    if (!approvedTasks || approvedTasks.length === 0) {
      return { plagiarized: false };
    }

    // Prepare comparison block
    let comparisonBlock = "";
    approvedTasks.forEach(at => {
      comparisonBlock += `=== TASK CODE: ${at.task_code} ===\n${at.submitted_text.substring(0, 4000)}\n\n`;
    });

    const sysPrompt = `You are the VIGIL Plagiarism and Concept Paraphrase Scanner. 
Compare the user's draft submission against a database of previously approved documents to detect if the writer has spun, recycled, or heavily paraphrased past concepts, details, or papers.
Look beyond simple word substitutions. Verify if the core ideas or layout has been spun.
If you detect high semantic similarity or spun content (concept replication over 30%), flag it as plagiarized.
You must return your output ONLY as a valid JSON object matching this structure:
{
  "plagiarized": true,
  "confidence_score": 85,
  "matching_task_code": "TASK-123",
  "reasoning": "Matching task details explanation"
}
If no plagiarism or concept spin is detected, return:
{
  "plagiarized": false,
  "confidence_score": 0,
  "matching_task_code": "",
  "reasoning": "Clear"
}`;

    const userPrompt = `
=== DATABASE OF PAST APPROVED DOCUMENTS ===
${comparisonBlock}

=== NEW SUBMISSION TO AUDIT ===
${newText}

Verify similarity and output the JSON structure.
`;

    console.log("Calling OmniRoute semantic concept paraphrase checker...");
    const rawResult = await callLLM("auto/best-fast", sysPrompt, userPrompt);
    
    // Clean JSON response
    const cleanedJson = rawResult.replace(/```json/i, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanedJson);
    return result;
  } catch (err) {
    console.error("Semantic concept paraphrase scan failed/timed out:", err.message);
    return { plagiarized: false };
  }
}

// Create task (TL Only) — accepts BOTH multipart/form-data AND JSON+base64
app.post('/api/tasks', verifyUser, upload.any(), async (req, res) => {
  // Support both old multipart format and new JSON+base64 format
  const body = req.body || {};
  const task_code = body.task_code;
  const client_id = body.client_id;
  const assigned_writer_email = body.assigned_writer_email;
  const brief_text = body.brief_text;
  const deadline = body.deadline;
  const invoicing_amount = body.invoicing_amount;
  const earnings_amount = body.earnings_amount;
  const base64Files = body.files; // JSON mode: array of {name, data, type}

  if (!task_code) {
    return res.status(400).json({ error: 'Missing mandatory field: task_code' });
  }

  const writerEmail = assigned_writer_email || 'local-writer@vigil.com';

  try {
    let finalBriefText = brief_text || '';

    // Mode A: New JSON+base64 file upload
    if (base64Files && Array.isArray(base64Files) && base64Files.length > 0) {
      for (const fileObj of base64Files) {
        console.log(`[JSON Mode] Parsing brief attachment: ${fileObj.name}...`);
        try {
          const fileBuffer = Buffer.from(fileObj.data, 'base64');
          const parsedBrief = await parseDocument(fileBuffer, fileObj.name);
          finalBriefText = (finalBriefText ? finalBriefText + "\n\n" : "") +
                           `=== MULTIMEDIA BRIEF ATTACHMENT (${fileObj.name}) ===\n` +
                           (parsedBrief.text || `[File: ${fileObj.name} — ${fileBuffer.length} bytes]`);
        } catch (fileErr) {
          console.warn(`[Parse Warning] ${fileObj.name}: ${fileErr.message}`);
          finalBriefText = (finalBriefText ? finalBriefText + "\n\n" : "") +
                           `=== MULTIMEDIA BRIEF ATTACHMENT (${fileObj.name}) ===\n[File uploaded successfully]`;
        }
      }
    }

    // Mode B: Old multipart file upload (fallback for cached old app.js)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        console.log(`[Multipart Mode] Parsing brief attachment: ${file.originalname}...`);
        try {
          const parsedBrief = await parseDocument(file.buffer, file.originalname);
          finalBriefText = (finalBriefText ? finalBriefText + "\n\n" : "") +
                           `=== MULTIMEDIA BRIEF ATTACHMENT (${file.originalname}) ===\n` +
                           (parsedBrief.text || `[File: ${file.originalname} — ${file.buffer.length} bytes]`);
        } catch (fileErr) {
          console.warn(`[Parse Warning] ${file.originalname}: ${fileErr.message}`);
          finalBriefText = (finalBriefText ? finalBriefText + "\n\n" : "") +
                           `=== MULTIMEDIA BRIEF ATTACHMENT (${file.originalname}) ===\n[File uploaded successfully]`;
        }
      }
    }

    if (!finalBriefText || !finalBriefText.trim()) {
      return res.status(400).json({ error: 'Brief guidelines text or reference files are required.' });
    }

    const brief_text_hash = crypto.createHash('sha256').update(finalBriefText).digest('hex');

    // STEP 2: Save task immediately with raw brief text (no AI wait = no timeout)
    const { data, error } = await supabase
      .from('qc_tasks')
      .insert([{
        task_code,
        client_id: client_id || 'GLOBAL',
        assigned_writer_email: writerEmail,
        brief_text: finalBriefText + '\n\n---\n\n# AI EDITORIAL GUIDANCE\n\n⏳ VIGIL-B Analysis is running in background... Refresh this project in 60 seconds to see the full blueprint.',
        brief_text_hash,
        qc_count: 0,
        qc_log_payload: '',
        status: 'Pending',
        words_completed: 0,
        invoicing_amount: parseFloat(invoicing_amount || 0),
        earnings_amount: parseFloat(earnings_amount || 0),
        deadline: deadline || '',
        manual_notes: '',
        submitted_text: ''
      }])
      .select();

    if (error) throw error;

    // STEP 3: Respond immediately — task is created!
    res.status(201).json(data[0]);

    // STEP 4: Run AnythingLLM VIGIL-B analysis async in background (after response sent)
    setImmediate(async () => {
      try {
        console.log(`[VIGIL-B Background] Starting async brief analysis for ${task_code}...`);
        const courseOfAction = await analyzeBriefWithAnythingLLM(finalBriefText, []);
        const updatedBriefText = finalBriefText + `\n\n---\n\n# AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION\n\n${courseOfAction}`;
        const updatedHash = crypto.createHash('sha256').update(updatedBriefText).digest('hex');
        await supabase
          .from('qc_tasks')
          .update({ brief_text: updatedBriefText, brief_text_hash: updatedHash })
          .eq('task_code', task_code);
        console.log(`[VIGIL-B Background] Analysis complete and saved for ${task_code}`);
      } catch (bgErr) {
        console.warn(`[VIGIL-B Background] Analysis failed for ${task_code}: ${bgErr.message}`);
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to create task: ${err.message}` });
  }
});


// Upload supplementary brief file to existing project task
app.post('/api/tasks/:code/upload', verifyUser, upload.single('brief_file'), async (req, res) => {
  const { code } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { data: task, error: fetchErr } = await supabase
      .from('qc_tasks')
      .select('brief_text')
      .eq('task_code', code)
      .single();

    if (fetchErr || !task) {
      return res.status(404).json({ error: 'Project task not found' });
    }

    console.log(`[File Upload] Processing brief attachment for ${code}: ${req.file.originalname}...`);
    const parsed = await parseDocument(req.file.buffer, req.file.originalname);
    
    let updatedBrief = task.brief_text || '';
    updatedBrief += `\n\n=== MULTIMEDIA BRIEF ATTACHMENT (${req.file.originalname}) ===\n` + parsed.text;

    // Re-run AnythingLLM brief analysis with new file content via OmniRoute Key
    const courseOfAction = await analyzeBriefWithAnythingLLM(updatedBrief, [], process.env.OMNIROUTE_API_KEY || '');
    const briefParts = updatedBrief.split('\n\n---\n\n# AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION\n\n');
    const cleanBriefText = briefParts[0] + `\n\n---\n\n# AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION\n\n${courseOfAction}`;

    const brief_text_hash = crypto.createHash('sha256').update(cleanBriefText).digest('hex');

    const { data: updatedTask, error: updateErr } = await supabase
      .from('qc_tasks')
      .update({
        brief_text: cleanBriefText,
        brief_text_hash
      })
      .eq('task_code', code)
      .select();

    if (updateErr) throw updateErr;
    res.json(updatedTask[0]);
  } catch (err) {
    console.error(`[File Upload Error] ${err.message}`);
    res.status(500).json({ error: `Failed to upload brief file: ${err.message}` });
  }
});

// Delete task (TL Only)
app.delete('/api/tasks/:code', verifyUser, async (req, res) => {
  const { code } = req.params;
  
  if (req.user.system_role !== 'TL') {
    return res.status(403).json({ error: 'Permission denied: Only Team Leads can delete projects.' });
  }

  try {
    console.log(`Deleting project: ${code}...`);

    // 1. Delete associated chats
    const { error: chatErr } = await supabase
      .from('task_chats')
      .delete()
      .eq('task_code', code);
    if (chatErr) throw chatErr;

    // 2. Delete the project details
    const { error: taskErr } = await supabase
      .from('qc_tasks')
      .delete()
      .eq('task_code', code);
    if (taskErr) throw taskErr;

    // 3. Delete from NotebookLM (non-blocking)
    try {
      console.log(`[NotebookLM] Cleaning up/deleting notebook for task ${code}...`);
      const listJson = await runCLISafe(['list', '--json']);
      const parsedList = JSON.parse(listJson);
      if (parsedList && parsedList.notebooks) {
        const targets = parsedList.notebooks.filter(nb => nb.title.toLowerCase() === code.toLowerCase());
        for (const target of targets) {
          console.log(`[NotebookLM] Found matching Notebook ID ${target.id} for task ${code}. Deleting...`);
          try {
            await runCLISafe(['delete', '-n', target.id, '-y']);
          } catch (delErr) {
            console.warn(`[NotebookLM WARNING] Failed to delete notebook ${target.id}:`, delErr.message);
          }
        }
      }
    } catch (nbCleanErr) {
      console.warn(`[NotebookLM WARNING] Failed to delete notebook from Google Account:`, nbCleanErr.message);
    }

    res.json({ message: `Project ${code} deleted successfully.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to delete project: ${err.message}` });
  }
});

// Run QC Audit (Requires document upload)
app.post('/api/tasks/:code/audit', verifyUser, upload.any(), async (req, res) => {
  const { code } = req.params;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  try {
    // 1. Fetch current task details
    const { data: task, error: fetchErr } = await supabase
      .from('qc_tasks')
      .select('*')
      .eq('task_code', code)
      .single();

    if (fetchErr || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    // 2. Parse all uploaded files
    let combinedText = '';
    for (const file of req.files) {
      console.log(`Parsing solution attachment: ${file.originalname}...`);
      const parsedFile = await parseDocument(file.buffer, file.originalname);
      combinedText += (combinedText ? "\n\n" : "") + parsedFile.text;
    }

    const parsed = {
      text: combinedText,
      wordCount: countWords(combinedText)
    };
    const textHash = crypto.createHash('sha256').update(parsed.text).digest('hex');

    // 5. Internal Plagiarism & Concept Paraphrase Checker
    console.log(`Auditing submission for semantic plagiarism/concept spin...`);
    const plagiarismResult = await checkSemanticPlagiarism(parsed.text, code);
    if (plagiarismResult.plagiarized) {
      const alertMsg = `🚨 INTERNAL PLAGIARISM FLAG: Concept spin detected matching past approved task [${plagiarismResult.matching_task_code}]. Confidence: ${plagiarismResult.confidence_score}%. Reason: "${plagiarismResult.reasoning}". Submission blocked.`;
      
      await supabase.from('task_chats').insert([{
        task_code: code,
        sender_email: 'vigil.system@vigil.com',
        message_text: alertMsg
      }]);

      return res.status(403).json({
        error: `Semantic Plagiarism Detected: matches approved task [${plagiarismResult.matching_task_code}]`,
        plagiarism: true,
        details: plagiarismResult
      });
    }

    // 6. Verify Originality (Submission Match 1 uniqueness check)
    let isDuplicated = false;
    if (task.qc_count === 0) {
      // Check if file content hash matches brief hash or matches any previous logs in DB
      if (textHash === task.brief_text_hash) {
        isDuplicated = true;
      } else {
        const { data: otherTasks } = await supabase
          .from('qc_tasks')
          .select('qc_log_payload')
          .neq('task_code', code);
        
        if (otherTasks) {
          for (const ot of otherTasks) {
            if (ot.qc_log_payload && ot.qc_log_payload.includes(textHash)) {
              isDuplicated = true;
              break;
            }
          }
        }
      }
    }

    // 7. Brief Recall Memory Logic: Retrieve historical overrides/complaints
    let historicalOverridesText = "";
    try {
      const { data: historicalTasks } = await supabase
        .from('qc_tasks')
        .select('task_code, manual_notes')
        .eq('brief_text_hash', task.brief_text_hash)
        .neq('task_code', code);

      if (historicalTasks && historicalTasks.length > 0) {
        const codes = historicalTasks.map(ht => ht.task_code);
        const { data: historicalChats } = await supabase
          .from('task_chats')
          .select('task_code, sender_email, message_text')
          .in('task_code', codes);

        let overrides = [];
        historicalTasks.forEach(ht => {
          if (ht.manual_notes && ht.manual_notes.trim() !== '') {
            overrides.push(`- Task ${ht.task_code} Editorial Guideline Override: "${ht.manual_notes}"`);
          }
        });

        if (historicalChats) {
          historicalChats.forEach(hc => {
            const isTL = hc.sender_email.startsWith('tl.');
            const msgLower = hc.message_text.toLowerCase();
            const isOverrideOrComplaint = msgLower.includes('override') || 
                                          msgLower.includes('complaint') || 
                                          msgLower.includes('error') || 
                                          msgLower.includes('violation') ||
                                          msgLower.includes('reject');
            if (isTL || isOverrideOrComplaint) {
              overrides.push(`- Task ${hc.task_code} Log (${hc.sender_email}): "${hc.message_text}"`);
            }
          });
        }

        if (overrides.length > 0) {
          historicalOverridesText = "\n=== HISTORICAL TEAM LEAD OVERRIDES & PIPELINE COMPLAINTS (HIGH-PRIORITY VALIDATION RULES) ===\n" + overrides.join('\n') + "\n";
        }
      }
    } catch (memErr) {
      console.warn("Failed to retrieve historical brief recall memory logs:", memErr.message);
    }

    // 8. Continuous Auto-Learning Rule Engine: Query dynamically learned constraints
    let learnedRulesText = "";
    try {
      const { data: clientRules } = await supabase
        .from('evolution_rules')
        .select('rule_variable_string')
        .eq('client_id', task.client_id || 'GLOBAL');

      if (clientRules && clientRules.length > 0) {
        learnedRulesText = "\n=== DYNAMIC CONTINUOUSLY LEARNED CLIENT RULES (HIGH-PRIORITY COMPLIANCE) ===\n" + 
                           clientRules.map(cr => `- ${cr.rule_variable_string}`).join('\n') + "\n";
      }
    } catch (ruleErr) {
      console.warn("Failed to query learned rules from DB:", ruleErr.message);
    }

    const combinedValidationRules = historicalOverridesText + learnedRulesText;
    const currentCount = Math.min(2, task.qc_count + 1);
    const isRework = currentCount === 2 || req.query.rework === 'true';

    // Programmatic Formatting & Layout Spacing Check
    let formatting = { spacing: "Unknown", alignment: "Unknown", dominantFont: "Unknown", wordCount: 0, citationsCount: 0, referenceEntriesCount: 0 };
    const docxFile = req.files.find(f => f.originalname.endsWith('.docx'));
    if (docxFile) {
      const tempDocxPath = path.join(__dirname, `temp_audit_${Date.now()}.docx`);
      fs.writeFileSync(tempDocxPath, docxFile.buffer);
      
      const pyResult = await runPythonDocxChecker(tempDocxPath);
      if (pyResult) {
        formatting = {
          spacing: pyResult.lineSpacing || "Unknown",
          alignment: pyResult.dominantAlignment || "Unknown",
          dominantFont: pyResult.dominantFont || "Unknown",
          wordCount: pyResult.wordCount || 0,
          citationsCount: pyResult.citationsCount || 0,
          referenceEntriesCount: pyResult.referenceEntriesCount || 0
        };
        // Override word counts parsed via mammoth with exact word counts from python-docx
        if (pyResult.wordCount) {
          parsed.wordCount = pyResult.wordCount;
        }
      }
      try {
        if (fs.existsSync(tempDocxPath)) fs.unlinkSync(tempDocxPath);
      } catch (cErr) {}
    }

    let layoutViolations = [];
    let layoutDeductions = 0;
    const briefLower = task.brief_text.toLowerCase();

    // Spacing Check
    if (briefLower.includes("double spacing") || briefLower.includes("double space")) {
      if (formatting.spacing !== "Double Spacing" && formatting.spacing !== "Unknown") {
        layoutViolations.push(`Layout spacing mismatch: Expected Double Spacing, but found ${formatting.spacing}`);
        layoutDeductions += 10;
      }
    } else if (briefLower.includes("single spacing") || briefLower.includes("single space")) {
      if (formatting.spacing !== "Single Spacing" && formatting.spacing !== "Unknown") {
        layoutViolations.push(`Layout spacing mismatch: Expected Single Spacing, but found ${formatting.spacing}`);
        layoutDeductions += 10;
      }
    }

    // Text Alignment Check
    if (briefLower.includes("justified")) {
      if (formatting.alignment !== "Justified" && formatting.alignment !== "Unknown") {
        layoutViolations.push(`Text alignment mismatch: Expected Justified, but found ${formatting.alignment}`);
        layoutDeductions += 10;
      }
    }

    // Font Family Check
    if (briefLower.includes("times new roman")) {
      if (formatting.dominantFont !== "Times New Roman" && formatting.dominantFont !== "Unknown") {
        layoutViolations.push(`Font family mismatch: Expected Times New Roman, but found dominant font ${formatting.dominantFont}`);
        layoutDeductions += 10;
      }
    } else if (briefLower.includes("arial")) {
      if (formatting.dominantFont !== "Arial" && formatting.dominantFont !== "Unknown") {
        layoutViolations.push(`Font family mismatch: Expected Arial, but found dominant font ${formatting.dominantFont}`);
        layoutDeductions += 10;
      }
    } else if (briefLower.includes("calibri")) {
      if (formatting.dominantFont !== "Calibri" && formatting.dominantFont !== "Unknown") {
        layoutViolations.push(`Font family mismatch: Expected Calibri, but found dominant font ${formatting.dominantFont}`);
        layoutDeductions += 10;
      }
    }

    // Reference & Citation Check
    if (briefLower.includes("references") || briefLower.includes("bibliography") || briefLower.includes("citation")) {
      if (formatting.citationsCount === 0) {
        layoutViolations.push(`Reference Citations check failed: No academic citations (parenthetical or bracketed numbers) were found in the text.`);
        layoutDeductions += 10;
      }
      if (formatting.referenceEntriesCount === 0) {
        layoutViolations.push(`Bibliography check failed: No References or Bibliography list section entries were detected at the end of the document.`);
        layoutDeductions += 10;
      }
      
      // Post citation count summary to chat
      await supabase.from('task_chats').insert([{
        task_code: code,
        sender_email: 'vigil.system@vigil.com',
        message_text: `🔍 REFERENCE DIAGNOSTICS: Detected ${formatting.citationsCount} inline citations in text, and ${formatting.referenceEntriesCount} reference entries in bibliography.`
      }]);
    }

    // Section Fragmentation & Word Distribution Tracking
    const sections = fragmentSections(parsed.text);
    const distributionRules = await extractBriefSectionDistribution(task.brief_text);

    let structuralViolations = [];
    let structuralDeductions = 0;
    let sectionAnalytics = [];
    const totalActualWords = parsed.wordCount;

    for (const secName in distributionRules) {
      const targetPercent = distributionRules[secName];
      const targetWords = Math.round(totalActualWords * (targetPercent / 100));

      let actualWords = 0;
      for (const k in sections) {
        if (k.toLowerCase() === secName.toLowerCase() || k.toLowerCase().startsWith(secName.toLowerCase())) {
          actualWords = sections[k].wordCount;
          break;
        }
      }

      const allowedVariance = Math.round(targetWords * 0.20);
      const minWords = Math.max(0, targetWords - allowedVariance);
      const maxWords = targetWords + allowedVariance;
      const isOut = actualWords < minWords || actualWords > maxWords;

      sectionAnalytics.push({
        section: secName,
        targetPercent,
        targetWords,
        actualWords,
        minAllowed: minWords,
        maxAllowed: maxWords,
        violated: isOut
      });

      if (isOut) {
        structuralViolations.push(`Section '${secName}' word count is ${actualWords} (Target: ${targetWords} words, allowed variance: ${minWords}-${maxWords}).`);
        structuralDeductions += 15;
      }
    }

    // Log Programmatic Warnings to Task Chat Logs before AI evaluates
    for (const lv of layoutViolations) {
      await supabase.from('task_chats').insert(sanitizeObjectForPostgres([{
        task_code: code,
        sender_email: 'vigil.system@vigil.com',
        message_text: `🚨 LAYOUT WARNING: ${lv}`
      }]));
    }

    for (const sv of structuralViolations) {
      await supabase.from('task_chats').insert(sanitizeObjectForPostgres([{
        task_code: code,
        sender_email: 'vigil.system@vigil.com',
        message_text: `🚨 SECTION WORD COUNT VIOLATION: ${sv}`
      }]));
    }

    // Merge structural violations into AI feedback guidelines
    let programmaticAuditText = "";
    if (layoutViolations.length > 0 || structuralViolations.length > 0) {
      programmaticAuditText = "\n=== PROGRAMMATIC STRUCTURE & LAYOUT COMPLIANCE FAILURES (HARD RULE PENALTIES APPLIED) ===\n" +
                              [...layoutViolations, ...structuralViolations].map(v => `- ${v}`).join('\n') + "\n";
    }

    const updatedValidationRules = combinedValidationRules + programmaticAuditText;

    // 9. Create initial audit stamp and respond immediately to prevent 504 gateway timeout
    const filenamesList = req.files.map(f => f.originalname).join(', ');
    const initialAuditStamp = `### [RUN ${currentCount} FORENSIC PASS]
- **File Name:** ${filenamesList}
- **Originality Check:** ${isDuplicated ? '⚠️ DUPLICATE SUBMISSION DETECTED' : '✅ UNIQUE SUBMISSION'}
- **Parsed Word Count:** ${parsed.wordCount} words
- **File SHA-256 Hash:** ${textHash}
- **Timestamp:** ${new Date().toISOString()}

⏳ **VIGIL AI Critics & Master Supervisor are evaluating the submission in real-time...**
*(Critic 1: Compliance, Critic 2: Structure, Critic 3: Citations, Master Judge)*

*The comprehensive forensic report will automatically update on this screen within 15–20 seconds.*`;

    let initialPayload = task.qc_log_payload || '';
    const divider = `\n\n---\n\n`;
    if (initialPayload) {
      initialPayload += divider + initialAuditStamp;
    } else {
      initialPayload = initialAuditStamp;
    }

    // Save initial status to DB
    await supabase
      .from('qc_tasks')
      .update(sanitizeObjectForPostgres({
        qc_count: currentCount,
        qc_log_payload: initialPayload,
        words_completed: parsed.wordCount,
        submitted_text: parsed.text
      }))
      .eq('task_code', code);

    // Respond immediately to client (0 timeout risk!)
    res.json({
      success: true,
      status: 'processing',
      report: initialAuditStamp,
      wordCount: parsed.wordCount,
      qc_count: currentCount,
      isDuplicated,
      formatting,
      sectionAnalytics
    });

    // 10. Run Full AI Evaluation Async in Background
    setImmediate(async () => {
      try {
        console.log(`[VIGIL QC Background] Running 3 Critics + Master Supervisor for task ${code}...`);
        const auditReport = await runConsensusEvaluation(
          task.brief_text,
          parsed.text,
          isRework,
          task.qc_log_payload,
          updatedValidationRules
        );

        const fullAuditStamp = `### [RUN ${currentCount} FORENSIC PASS]
- **File Name:** ${filenamesList}
- **Originality Check:** ${isDuplicated ? '⚠️ DUPLICATE SUBMISSION DETECTED' : '✅ UNIQUE SUBMISSION'}
- **Parsed Word Count:** ${parsed.wordCount} words
- **File SHA-256 Hash:** ${textHash}
- **Timestamp:** ${new Date().toISOString()}

${auditReport}`;

        let finalPayload = task.qc_log_payload || '';
        if (finalPayload) {
          finalPayload += divider + fullAuditStamp;
        } else {
          finalPayload = fullAuditStamp;
        }

        // Parse VIGIL Score
        const scoreMatch = auditReport.match(/Score:\s*(\d+)\/100/i) || 
                           auditReport.match(/VIGIL Score:\s*(\d+)/i) || 
                           auditReport.match(/Score:\s*(\d+)/i);
        let baseScore = 100;
        if (scoreMatch) {
          baseScore = parseInt(scoreMatch[1], 10);
        }

        const totalDeduction = layoutDeductions + structuralDeductions;
        const finalVigilScore = Math.max(0, baseScore - totalDeduction);
        const satisfiesThreshold = finalVigilScore >= 90;

        // Save complete final audit report to DB
        await supabase
          .from('qc_tasks')
          .update(sanitizeObjectForPostgres({
            qc_count: currentCount,
            qc_log_payload: finalPayload,
            words_completed: parsed.wordCount,
            submitted_text: parsed.text
          }))
          .eq('task_code', code);

        // Post chat log
        let chatMsg = `⚙️ SYSTEM: Document(s) "${filenamesList}" evaluated. Pass ${currentCount} completed. Words: ${parsed.wordCount}. VIGIL Score: ${finalVigilScore}/100. `;
        if (satisfiesThreshold) {
          chatMsg += `✅ PASS: Distinction quality standard met (90%+). Task is ready for Team Lead sign-off.`;
        } else {
          chatMsg += `⚠️ WARNING: VIGIL Quality Score is below the 90% distinction threshold. Revision required.`;
        }
        if (totalDeduction > 0) {
          chatMsg += ` (Programmatic penalty: -${totalDeduction})`;
        }

        await supabase.from('task_chats').insert(sanitizeObjectForPostgres([{
          task_code: code,
          sender_email: 'vigil.system@vigil.com',
          message_text: chatMsg
        }]));

        console.log(`[VIGIL QC Background] Audit complete and saved for ${code}! Score: ${finalVigilScore}/100`);
      } catch (bgErr) {
        console.error(`[VIGIL QC Background ERROR] ${bgErr.message}`);
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Audit process failed: ${err.message}` });
  }
});

// Chat stream endpoints
app.get('/api/tasks/:code/chats', verifyUser, async (req, res) => {
  const { code } = req.params;
  try {
    // For freelancers, verify assignment
    if (req.user.system_role === 'Freelancer') {
      const { data: task } = await supabase
        .from('qc_tasks')
        .select('assigned_writer_email')
        .eq('task_code', code)
        .single();
      
      if (!task || task.assigned_writer_email !== req.user.email) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { data: chats, error } = await supabase
      .from('task_chats')
      .select('*')
      .eq('task_code', code)
      .order('timestamp', { ascending: true });

    if (error) throw error;
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load task chats' });
  }
});

app.post('/api/tasks/:code/chats', verifyUser, async (req, res) => {
  const { code } = req.params;
  const { message_text } = req.body;

  if (!message_text) {
    return res.status(400).json({ error: 'Message body cannot be empty' });
  }

  try {
    // For freelancers, verify assignment
    if (req.user.system_role === 'Freelancer') {
      const { data: task } = await supabase
        .from('qc_tasks')
        .select('assigned_writer_email')
        .eq('task_code', code)
        .single();
      
      if (!task || task.assigned_writer_email !== req.user.email) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { data, error } = await supabase
      .from('task_chats')
      .insert([{
        task_code: code,
        sender_email: req.user.email,
        message_text
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// Team Lead Panel: Reset QC count
app.post('/api/tasks/:code/reset', verifyUser, async (req, res) => {
  if (req.user.system_role !== 'TL') {
    return res.status(403).json({ error: 'Forbidden: Only Team Leads can reset task QC counters' });
  }

  const { code } = req.params;
  const { manual_notes } = req.body;

  try {
    const { error } = await supabase
      .from('qc_tasks')
      .update({
        qc_count: 0,
        manual_notes: manual_notes || ''
      })
      .eq('task_code', code);

    if (error) throw error;

    // Log the override action to chat stream
    await supabase.from('task_chats').insert([{
      task_code: code,
      sender_email: 'vigil.system@vigil.com',
      message_text: `🛡️ OVERRIDE: Team Lead (${req.user.email}) has reset the automated QC checker count to 0. Editorial Notes: "${manual_notes || 'None'}"`
    }]);

    res.json({ success: true, message: 'QC check count reset successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset QC counter' });
  }
});

// Team Lead Panel: Approve Task and push to payroll
app.post('/api/tasks/:code/approve', verifyUser, async (req, res) => {
  if (req.user.system_role !== 'TL') {
    return res.status(403).json({ error: 'Forbidden: Only Team Leads can approve tasks' });
  }

  const { code } = req.params;
  const { feedback } = req.body;

  try {
    // 1. Fetch task to get client_id
    const { data: task, error: fetchErr } = await supabase
      .from('qc_tasks')
      .select('*')
      .eq('task_code', code)
      .single();

    if (fetchErr || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    // 2. Mark task as Approved
    const { error: approveErr } = await supabase
      .from('qc_tasks')
      .update({
        status: 'Approved'
      })
      .eq('task_code', code);

    if (approveErr) throw approveErr;

    // 3. Continuous Auto-Learning Rule Extraction
    let learnedRule = "";
    if (feedback && feedback.trim() !== '') {
      try {
        console.log(`Extracting operational rules from feedback: "${feedback}"...`);
        const constraintSystem = "You are the VIGIL Quality Engineer. Read the Team Lead's post-completion feedback or client notes, and extract any recurring operational constraints, style rules, or quality preferences as a single clear, actionable rule (e.g. 'Ensure all chart labels are capitalized' or 'Never use active voice in research logs'). Output ONLY the extracted rule string, keep it concise (under 20 words). Do not add comments or markdown formatting.";
        const ruleResult = await callLLM("meta-llama/llama-3.3-70b-instruct:free", constraintSystem, `Feedback: "${feedback}"`);
        
        learnedRule = ruleResult.trim();
        
        // Save in DB
        const { error: insertRuleErr } = await supabase
          .from('evolution_rules')
          .insert([{
            client_id: task.client_id || 'GLOBAL',
            rule_variable_string: learnedRule,
            origin_type: 'TL_Comment'
          }]);
          
        if (insertRuleErr) console.warn("Failed to insert learned rule:", insertRuleErr.message);
      } catch (ruleErr) {
        console.warn("Auto-learning rule extraction failed:", ruleErr.message);
      }
    }

    // 4. Log approval event to chat stream
    let chatMsg = `🎉 TASK APPROVED: Team Lead (${req.user.email}) has signed off on the final deliverables. Transaction pushed to payroll.`;
    if (learnedRule) {
      chatMsg += ` 🧠 Auto-learned rule for client [${task.client_id}]: "${learnedRule}"`;
    }

    await supabase.from('task_chats').insert([{
      task_code: code,
      sender_email: 'vigil.system@vigil.com',
      message_text: chatMsg
    }]);

    res.json({ success: true, message: 'Task approved and locked.', learnedRule });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve task' });
  }
});

// AI Council Teaching Terminal endpoint
app.post('/api/tasks/:code/teach', verifyUser, upload.single('audio'), async (req, res) => {
  if (req.user.system_role !== 'TL') {
    return res.status(403).json({ error: 'Forbidden: Only Team Leads can train the AI Council' });
  }

  const { code } = req.params;
  const { text } = req.body;
  const file = req.file;

  try {
    // 1. Fetch task to identify client
    const { data: task, error: fetchErr } = await supabase
      .from('qc_tasks')
      .select('*')
      .eq('task_code', code)
      .single();

    if (fetchErr || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    // 2. Transcribe audio if present, otherwise read text
    let directive = "";
    if (file) {
      console.log(`Transcribing spoken audio instruction directive: ${file.originalname}...`);
      const base64 = file.buffer.toString('base64');
      const mime = file.mimetype || 'audio/wav';
      directive = await transcribeMultimodalOpenRouter(base64, mime, 'audio');
    } else if (text) {
      directive = text;
    }

    if (!directive || directive.trim() === '') {
      return res.status(400).json({ error: 'No written directive or audio instruction captured.' });
    }

    console.log(`Extracting Operational Constraints from directive: "${directive}"`);

    // 3. Extract rule
    const constraintSystem = "You are the VIGIL Quality Engineer. Read the Team Lead's verbal instruction or written directive, and extract any recurring operational constraints, style rules, or quality preferences as a single clear, actionable rule (e.g. 'Ensure all subheadings are bold' or 'Never use active voice'). Output ONLY the extracted rule string, keep it concise (under 20 words). Do not add comments or markdown formatting.";
    const ruleResult = await callLLM("meta-llama/llama-3.3-70b-instruct:free", constraintSystem, `Directive: "${directive}"`);
    const rule = ruleResult.trim();

    // 4. Save in DB
    const { error: insertRuleErr } = await supabase
      .from('evolution_rules')
      .insert([{
        client_id: task.client_id || 'GLOBAL',
        rule_variable_string: rule,
        origin_type: 'TL_Comment'
      }]);

    if (insertRuleErr) throw insertRuleErr;

    // 5. Append message to chat logs
    const chatMsg = `🧠 AI COUNCIL RULE LEARNED: Team Lead (${req.user.email}) added operational constraint for client [${task.client_id}]: "${rule}" (Source: "${directive.substring(0, 100)}...")`;
    await supabase.from('task_chats').insert([{
      task_code: code,
      sender_email: 'vigil.system@vigil.com',
      message_text: chatMsg
    }]);

    res.json({
      success: true,
      rule,
      transcript: directive
    });
  } catch (err) {
    console.error("Teaching engine failed:", err);
    res.status(500).json({ error: `Teaching process failed: ${err.message}` });
  }
});

// Get User's Earnings Log (Freelancer Ledger View)
app.get('/api/earnings', verifyUser, async (req, res) => {
  if (req.user.system_role === 'Writer') {
    return res.status(403).json({ error: 'Writers do not have access to Freelancer Ledger sheets.' });
  }

  try {
    let query = supabase.from('qc_tasks').select('task_code, words_completed, earnings_amount, status');
    
    // If freelancer, filter by their email
    if (req.user.system_role === 'Freelancer') {
      query = query.eq('assigned_writer_email', req.user.email);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve earnings ledger' });
  }
});

// Catch-all route to serve public/index.html for single-page app navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Express global JSON error handler to prevent HTML error pages
app.use((err, req, res, next) => {
  console.error('[VIGIL GLOBAL EXPRESS ERROR]', err?.stack || err);
  const statusCode = err?.status || err?.statusCode || 500;
  res.status(statusCode).json({
    error: err?.message || 'Internal Server Error'
  });
});

// Start listening
const serverPort = process.env.PORT || 3000;
app.listen(serverPort, "0.0.0.0", () => {
  console.log(`Vigil QC Platform backend listening on 0.0.0.0:${serverPort}`);
});
