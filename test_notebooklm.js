const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${cmd}`);
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`CMD Error:`, stderr);
        return reject(err);
      }
      resolve(stdout.trim());
    });
  });
}

async function testNotebookLM() {
  const tempFile = path.join(__dirname, 'temp_guidelines.txt');
  fs.writeFileSync(tempFile, 'Guidelines: Write a 1000-word analysis on quantum cryptography. Double spacing, justified alignment. Include headings: Introduction, Background, Technical Analysis, Applications, Conclusion.');

  try {
    // 1. Create a notebook
    console.log("Creating notebook...");
    const createOut = await runCmd('notebooklm create "Test Project Guidance"');
    console.log("Create Output:", createOut);

    // 2. Add the source file
    console.log("Uploading guidelines file...");
    const uploadOut = await runCmd(`notebooklm source add "${tempFile}"`);
    console.log("Upload Output:", uploadOut);

    // 3. Query the notebook
    console.log("Asking NotebookLM...");
    const askOut = await runCmd('notebooklm ask "Suggest me a course of action to get a High Distinction (90%+ marks)."');
    console.log("NotebookLM Answer:\n", askOut);

  } catch (err) {
    console.error("Test failed:", err.message);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

testNotebookLM();
