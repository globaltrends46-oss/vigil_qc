const fetch = require('node-fetch');

async function test() {
  const taskCode = 'test-guidance-' + Date.now();
  console.log("Spawning project:", taskCode);
  
  try {
    const res = await fetch("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Email": "prishapublishingteamlead@gmail.com"
      },
      body: JSON.stringify({
        task_code: taskCode,
        client_id: "ACADEMIC_CORP",
        brief_text: "Guidelines: Write a 1000-word analysis on quantum cryptography. Spacing: Double spacing. Alignment: Justified."
      })
    });
    
    console.log("Response Status:", res.status);
    const data = await res.json();
    console.log("Brief Text Output:");
    console.log(data.brief_text);
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

test();
