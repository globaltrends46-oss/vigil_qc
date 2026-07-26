require('dotenv').config();
const { omniDispatch, getKeyPools } = require('./omniroute');

async function testOmniRoute() {
  console.log("=== OMNIROUTE KEY POOL SUMMARY ===");
  const pools = getKeyPools();
  console.log("Groq Keys:", pools.groq.length);
  console.log("Gemini Keys:", pools.gemini.length);
  console.log("OpenRouter Keys:", pools.openrouter.length);

  console.log("\n=== TESTING WAR-READY DISPATCHER ===");
  try {
    const output = await omniDispatch(
      "You are OmniRoute Test Agent.",
      "Respond in 5 words: OmniRoute War-Ready System Online!"
    );
    console.log("\nFinal Returned Output:\n", output);
  } catch (err) {
    console.error("OmniRoute test failed:", err.message);
  }
}

testOmniRoute();
