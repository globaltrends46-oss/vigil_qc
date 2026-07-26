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

async function test() {
  try {
    const askOut = await runCLISafe(['ask', 'Analyze "AI EDITORIAL GUIDANCE & SUGGESTED COURSE OF ACTION". What is the name of this project?']);
    console.log("Success Output:\n", askOut);
  } catch (err) {
    console.error("ExecFile Error:", err.message);
  }
}

test();
