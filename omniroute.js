// ==============================================================================
// OMNIROUTE: WAR-READY MULTI-PROVIDER & MULTI-KEY RESILIENT DISPATCHER
// ==============================================================================
// Dynamically pools Groq, Gemini, and OpenRouter keys with auto-rotation,
// rate-limit (429) backoff, and active model fallback chains.

const fetch = require('node-fetch');

// Deduplicated Key Pools
function getKeyPools() {
  const rawGroq = [process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY].filter(Boolean);
  const rawGemini = [process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean);
  const rawOR = [process.env.OPENROUTER_API_KEY].filter(Boolean);

  return {
    groq: Array.from(new Set(rawGroq)),
    gemini: Array.from(new Set(rawGemini)),
    openrouter: Array.from(new Set(rawOR))
  };
}

const counters = { groq: 0, gemini: 0, openrouter: 0 };

function getNextKey(provider) {
  const pools = getKeyPools();
  const pool = pools[provider] || [];
  if (pool.length === 0) return null;
  const key = pool[counters[provider] % pool.length];
  counters[provider]++;
  return key;
}

// Standard Headers to prevent node-fetch stream closure bugs
const STANDARD_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Encoding": "identity"
};

// 1. Groq Dispatcher with Active Models
async function dispatchGroq(systemPrompt, userPrompt) {
  const pools = getKeyPools().groq;
  if (pools.length === 0) throw new Error("No Groq keys available");

  // Verified Active Groq Models (2026)
  const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"];

  for (const model of groqModels) {
    for (let i = 0; i < pools.length; i++) {
      const key = getNextKey('groq');
      try {
        console.log(`[OmniRoute -> Groq] Key (...${key.slice(-6)}) | Model: ${model}`);
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            ...STANDARD_HEADERS,
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.1
          })
        });

        if (res.status === 429) {
          console.warn(`[OmniRoute -> Groq ⚠️] Rate limit (429) on key (...${key.slice(-6)}). Rotating...`);
          continue;
        }

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Groq HTTP ${res.status}: ${err}`);
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          return {
            text: data.choices[0].message.content,
            provider: 'Groq API',
            model: model,
            keyUsed: `...${key.slice(-6)}`
          };
        }
      } catch (err) {
        console.warn(`[OmniRoute -> Groq] Attempt failed: ${err.message}`);
      }
    }
  }
  throw new Error("All Groq key and model attempts exhausted");
}

// 2. Gemini Dispatcher with Verified Active Models
async function dispatchGemini(systemPrompt, userPrompt) {
  const pools = getKeyPools().gemini;
  if (pools.length === 0) throw new Error("No Gemini keys available");

  // Verified Active Gemini 2.0 / 1.5 Models
  const geminiModels = ["gemini-2.0-flash", "gemini-1.5-flash-latest"];

  for (const model of geminiModels) {
    for (let i = 0; i < pools.length; i++) {
      const key = getNextKey('gemini');
      try {
        console.log(`[OmniRoute -> Gemini] Key (...${key.slice(-6)}) | Model: ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
          method: "POST",
          headers: STANDARD_HEADERS,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: `${systemPrompt}\n\nUser Request/Input:\n${userPrompt}` }]
              }
            ],
            generationConfig: { temperature: 0.15 }
          })
        });

        if (res.status === 429) {
          console.warn(`[OmniRoute -> Gemini ⚠️] Rate limit (429) on key (...${key.slice(-6)}). Rotating...`);
          continue;
        }

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Gemini HTTP ${res.status}: ${err}`);
        }

        const data = await res.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts.map(p => p.text).join('\n');
          return {
            text: text,
            provider: 'Google Gemini API',
            model: model,
            keyUsed: `...${key.slice(-6)}`
          };
        }
      } catch (err) {
        console.warn(`[OmniRoute -> Gemini] Attempt failed: ${err.message}`);
      }
    }
  }
  throw new Error("All Gemini key and model attempts exhausted");
}

// 3. OpenRouter Dispatcher
async function dispatchOpenRouter(systemPrompt, userPrompt, preferredModel) {
  const pools = getKeyPools().openrouter;
  if (pools.length === 0) throw new Error("No OpenRouter keys available");

  const models = [
    preferredModel || "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemini-2.0-flash-001"
  ];

  for (const model of models) {
    for (let i = 0; i < pools.length; i++) {
      const key = getNextKey('openrouter');
      try {
        console.log(`[OmniRoute -> OpenRouter] Key (...${key.slice(-6)}) | Model: ${model}`);
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            ...STANDARD_HEADERS,
            "Authorization": `Bearer ${key}`,
            "HTTP-Referer": "https://vigilqc.com",
            "X-Title": "Vigil QC"
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.1
          })
        });

        if (res.status === 429) {
          console.warn(`[OmniRoute -> OpenRouter ⚠️] Rate limit (429) on key. Rotating...`);
          continue;
        }

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`OpenRouter HTTP ${res.status}: ${err}`);
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          return {
            text: data.choices[0].message.content,
            provider: 'OpenRouter API',
            model: model,
            keyUsed: `...${key.slice(-6)}`
          };
        }
      } catch (err) {
        console.warn(`[OmniRoute -> OpenRouter] Attempt failed: ${err.message}`);
      }
    }
  }
  throw new Error("All OpenRouter attempts exhausted");
}

// Master Resilient Execution Dispatcher
async function omniDispatch(systemPrompt, userPrompt, preferredModel) {
  console.log("\n⚡ [OmniRoute Master Dispatcher] Executing war-ready multi-tier failover...");

  // Tier 1: Groq Ultra-Fast API Pool
  try {
    const res = await dispatchGroq(systemPrompt, userPrompt);
    console.log(`✅ [OmniRoute SUCCESS] Provider: ${res.provider} | Model: ${res.model} | Key: ${res.keyUsed}`);
    return res.text;
  } catch (groqErr) {
    console.warn(`⚠️ [OmniRoute] Tier 1 (Groq) failed: ${groqErr.message}. Cascading to Tier 2 (Gemini)...`);
  }

  // Tier 2: Google Gemini API Pool
  try {
    const res = await dispatchGemini(systemPrompt, userPrompt);
    console.log(`✅ [OmniRoute SUCCESS] Provider: ${res.provider} | Model: ${res.model} | Key: ${res.keyUsed}`);
    return res.text;
  } catch (geminiErr) {
    console.warn(`⚠️ [OmniRoute] Tier 2 (Gemini) failed: ${geminiErr.message}. Cascading to Tier 3 (OpenRouter)...`);
  }

  // Tier 3: OpenRouter API Pool
  try {
    const res = await dispatchOpenRouter(systemPrompt, userPrompt, preferredModel);
    console.log(`✅ [OmniRoute SUCCESS] Provider: ${res.provider} | Model: ${res.model} | Key: ${res.keyUsed}`);
    return res.text;
  } catch (orErr) {
    console.error(`🚨 [OmniRoute EXHAUSTED] Tier 3 (OpenRouter) failed: ${orErr.message}`);
    throw new Error(`OmniRoute War-Ready Failover exhausted across all Groq, Gemini, and OpenRouter keys.`);
  }
}

module.exports = {
  omniDispatch,
  dispatchGroq,
  dispatchGemini,
  dispatchOpenRouter,
  getKeyPools
};
