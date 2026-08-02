/**
 * anythingLLMEngine.js — Embedded AnythingLLM Document Analysis & RAG Engine for Vigil QC
 * 
 * Performs semantic document chunking, RAG context synthesis, and brief analysis 
 * via OmniRoute AI Gateway (https://gateway.gtrendsnow.com/v1/chat/completions).
 */

const fetch = globalThis.fetch || require('node-fetch');

// Robust SSE stream & JSON content extractor
function extractContentFromSSEResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let content = "";
  const lines = rawText.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
    
    try {
      const jsonStr = trimmed.substring(6).trim();
      const chunk = JSON.parse(jsonStr);
      
      if (chunk.choices && chunk.choices[0]) {
        const delta = chunk.choices[0].delta || chunk.choices[0].message;
        if (delta && delta.content) {
          content += delta.content;
        } else if (chunk.choices[0].text) {
          content += chunk.choices[0].text;
        }
      }
    } catch (e) {
      // Ignore individual chunk parse errors
    }
  }

  // Fallback for non-stream standard JSON response
  if (!content) {
    try {
      const data = JSON.parse(rawText);
      if (data.choices && data.choices[0]) {
        const msg = data.choices[0].message || data.choices[0].delta;
        if (msg && msg.content) return msg.content;
      }
    } catch (e) {}
  }

  return content || rawText;
}

// Recursive character text splitter for document chunking
function chunkText(text, chunkSize = 1500, overlap = 200) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  if (clean.length <= chunkSize) return [clean];

  const chunks = [];
  let startIndex = 0;

  while (startIndex < clean.length) {
    let endIndex = startIndex + chunkSize;
    if (endIndex < clean.length) {
      const lastNewline = clean.lastIndexOf('\n', endIndex);
      const lastPeriod = clean.lastIndexOf('. ', endIndex);
      const breakPoint = Math.max(lastNewline, lastPeriod);

      if (breakPoint > startIndex + chunkSize / 2) {
        endIndex = breakPoint + 1;
      }
    }

    chunks.push(clean.substring(startIndex, endIndex).trim());
    startIndex = endIndex - overlap;
    if (startIndex < 0) startIndex = 0;
  }

  return chunks.filter(c => c.length > 0);
}

// Compute semantic relevance score between prompt query and document chunk
function scoreChunkRelevance(chunk, queryTerms) {
  const lowerChunk = chunk.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (!term || term.length < 3) continue;
    const regex = new RegExp(`\\b${term.toLowerCase()}\\b`, 'g');
    const matches = lowerChunk.match(regex);
    if (matches) {
      score += matches.length * (term.length > 6 ? 2 : 1);
    }
  }
  return score;
}

// Select top RAG chunks matching key assignment query vectors
function retrieveRelevantRAGChunks(fullText, query, topK = 6) {
  const chunks = chunkText(fullText);
  if (chunks.length <= topK) return chunks;

  const queryTerms = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const scoredChunks = chunks.map(chunk => ({
    chunk,
    score: scoreChunkRelevance(chunk, queryTerms)
  }));

  scoredChunks.sort((a, b) => b.score - a.score);
  return scoredChunks.slice(0, topK).map(sc => sc.chunk);
}

/**
 * Perform full AnythingLLM RAG Analysis on uploaded Brief & Guidelines
 */
async function analyzeBriefWithAnythingLLM(rawBriefText, fileContents = []) {
  console.log('[AnythingLLM Engine] Beginning automated RAG brief analysis...');
  
  let combinedText = rawBriefText || '';
  if (Array.isArray(fileContents) && fileContents.length > 0) {
    combinedText += '\n\n' + fileContents.map(f => `--- FILE: ${f.name} ---\n${f.content}`).join('\n\n');
  }

  if (!combinedText || combinedText.trim() === '') {
    return 'No brief guidelines or reference files provided.';
  }

  const targetQuery = 'assignment brief requirements rubric word count citations methodology section breakdown guidelines constraints';
  const ragContextChunks = retrieveRelevantRAGChunks(combinedText, targetQuery, 4);
  const ragContextBlock = ragContextChunks.join('\n\n--- RAG CHUNK ---\n\n');

  const omniGatewayUrl = process.env.OMNIROUTE_URL || 'https://gateway.gtrendsnow.com/v1/chat/completions';
  const apiKey = process.env.OMNIROUTE_API_KEY || 'Kolkata@654321.';

  const systemPrompt = `You are the Embedded AnythingLLM Document Analysis Engine inside VIGIL QC.
Analyze the provided RAG document chunks, assignment brief guidelines, and study materials.

Generate a comprehensive, highly specific "ANYTHINGLLM BRIEF ANALYSIS & EDITORIAL BLUEPRINT" document.
This blueprint serves as the gold-standard reference for the writer to achieve a High Distinction (90%+ marks).

Structure your output into these 5 clear Markdown sections:
# ANYTHINGLLM AUTOMATED BRIEF ANALYSIS & BLUEPRINT

## 1. SUMMARY OF CORE REQUIREMENTS & CONSTRAINTS
- Exact assignment task description & core objective.
- Absolute word count limits & section allocation targets.
- Mandatory formatting rules (spacing, alignment, font, headers).

## 2. EXPLICIT SECTIONS & HEADING CHECKLIST
- Outline the EXACT required section headers (Introduction, Literature Review, Methodology/Findings, Discussion, Conclusion).
- For each section, list specific, non-negotiable points, author references, or datasets that MUST be included.

## 3. CORE THEORIES, FRAMEWORKS, & SPECIFIC TERMINOLOGY
- Explicitly name all theories, models, formulas, frameworks, or key terminology mentioned in the materials.
- Mandate where and how each theory must be applied in the text.

## 4. CITATION & AUTHENTICITY RULES
- Specific citation format (APA 7th, Harvard, IEEE, etc.).
- Ban on zombie/fluff references and mandatory scholarly source requirements.

## 5. RECOMMENDED QC CRITICS & STRATEGY
- Specific structural recommendations for passing VIGIL's 3-Critic quality audit with 90%+ distinction score.

Be extremely detailed, authoritative, and specific to the uploaded materials. Output clean Markdown only.`;

  try {
    console.log('[AnythingLLM Engine] Sending RAG prompt to OmniRoute Gateway...');
    const response = await fetch(omniGatewayUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vigil.gtrendsnow.com',
        'X-Title': 'Vigil QC AnythingLLM Engine'
      },
      body: JSON.stringify({
        model: 'auto/best-fast',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `RETRIEVED RAG BRIEF CONTEXT:\n${ragContextBlock}\n\nFULL RAW BRIEF MATERIAL:\n${combinedText.substring(0, 4000)}` }
        ],
        temperature: 0.15
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OmniRoute HTTP ${response.status}: ${errText}`);
    }

    const rawText = await response.text();
    const cleanContent = extractContentFromSSEResponse(rawText);

    if (!cleanContent) {
      throw new Error('OmniRoute returned empty choices for AnythingLLM analysis');
    }

    console.log('[AnythingLLM Engine] Automated brief analysis successfully generated!');
    return cleanContent;
  } catch (err) {
    console.warn(`[AnythingLLM Engine Warning] OmniRoute RAG request failed: ${err.message}. Generating local fallback blueprint...`);
    return `# ANYTHINGLLM AUTOMATED BRIEF ANALYSIS & BLUEPRINT (FALLBACK MODE)

## 1. SUMMARY OF CORE REQUIREMENTS & CONSTRAINTS
- **Raw Brief Length**: ${countWords(combinedText)} words extracted across brief files.
- **Goal**: Achieve a High Distinction (90%+ marks) by meeting all structural guidelines.

## 2. EXPLICIT SECTIONS & HEADING CHECKLIST
- **Introduction**: 10% target word count. Set up context, research questions, and scope.
- **Literature Review**: 30% target word count. Synthesize academic sources & core frameworks.
- **Methodology & Analysis**: 50% target word count. Primary investigation, data, and discussion.
- **Conclusion**: 10% target word count. Summary of findings, limitations, and recommendations.

## 3. CITATION & QUALITY RULES
- Enforce APA/Harvard citation standards throughout.
- All references must be authentic and verified against academic databases.`;
  }
}

function countWords(text) {
  if (!text) return 0;
  const clean = text.trim();
  return clean === '' ? 0 : clean.split(/\s+/).length;
}

module.exports = {
  chunkText,
  retrieveRelevantRAGChunks,
  extractContentFromSSEResponse,
  analyzeBriefWithAnythingLLM
};
