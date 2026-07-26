require('dotenv').config();
const fetch = require('node-fetch');

async function testGroq() {
  const apiKey = process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY;
  console.log("Using Groq API Key:", apiKey ? apiKey.substring(0, 10) + "..." : "undefined");
  
  if (!apiKey) {
    console.error("No Groq API key loaded from env!");
    return;
  }

  try {
    console.log("Sending direct test request to Groq API...");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Encoding": "identity"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Respond in one word: YES" }]
      })
    });
    
    console.log("Response Status:", res.status);
    const body = await res.text();
    console.log("Response Body:", body);
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

testGroq();
