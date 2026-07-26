const fetch = require('node-fetch');

async function test() {
  const taskCode = 'test-guidance-1783442455577';
  console.log("Deleting project:", taskCode);
  
  try {
    const res = await fetch(`http://localhost:3000/api/tasks/${taskCode}`, {
      method: "DELETE",
      headers: {
        "X-User-Email": "prishapublishingteamlead@gmail.com"
      }
    });
    
    console.log("Response Status:", res.status);
    const data = await res.json();
    console.log("Response:", data);
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

test();
