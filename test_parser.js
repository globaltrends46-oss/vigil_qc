const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const AdmZip = require('adm-zip');

// Copy countWords from server.js
function countWords(text) {
  if (!text) return 0;
  const clean = text.trim();
  if (clean === '') return 0;
  return clean.split(/\s+/).length;
}

async function extractZipWords(buffer) {
  let totalWords = 0;
  let textParts = [];
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.toLowerCase();
    const fileExt = name.split('.').pop();
    const fileBuffer = entry.getData();

    if (['txt', 'md', 'py', 'js', 'html', 'css', 'json', 'csv', 'xml', 'ts', 'go', 'rs', 'c', 'cpp'].includes(fileExt)) {
      const text = fileBuffer.toString('utf8');
      totalWords += countWords(text);
      textParts.push(`--- FILE: ${entry.entryName} ---\n${text}`);
    } else if (fileExt === 'docx') {
      try {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        totalWords += countWords(result.value);
        textParts.push(`--- FILE: ${entry.entryName} ---\n${result.value}`);
      } catch (err) {
        console.error(`Error parsing internal docx: ${entry.entryName}`, err);
      }
    } else if (fileExt === 'pdf') {
      try {
        const result = await pdfParse(fileBuffer);
        totalWords += countWords(result.text);
        textParts.push(`--- FILE: ${entry.entryName} ---\n${result.text}`);
      } catch (err) {
        console.error(`Error parsing internal pdf: ${entry.entryName}`, err);
      }
    }
  }
  return { wordCount: totalWords, textContent: textParts.join('\n\n') };
}

async function parseDocument(fileBuffer, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  let text = '';
  let wordCount = 0;

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    text = result.value;
    wordCount = countWords(text);
  } else if (ext === 'pdf') {
    const result = await pdfParse(fileBuffer);
    text = result.text;
    wordCount = countWords(text);
  } else if (ext === 'zip' || ext === 'epub') {
    const zipResult = await extractZipWords(fileBuffer);
    text = zipResult.textContent;
    wordCount = zipResult.wordCount;
  } else {
    text = fileBuffer.toString('utf8');
    wordCount = countWords(text);
  }

  return { text, wordCount };
}

async function runTests() {
  console.log("=== RUNNING UNIVERSAL METRIC PARSER VERIFICATIONS ===");
  
  // Test 1: Plain Text
  const test1Text = "This is a simple plain text file designed to verify that the byte character word count tracker functions properly.";
  const test1Buffer = Buffer.from(test1Text);
  const result1 = await parseDocument(test1Buffer, "sample.txt");
  console.log(`Test 1 (txt): expected 19 words, parsed: ${result1.wordCount} words - ${result1.wordCount === 19 ? 'PASS' : 'FAIL'}`);

  // Test 2: Python Code Asset
  const test2Text = `def main():
    print("Vigil forensic pass is active")
    return True
`;
  const test2Buffer = Buffer.from(test2Text);
  const result2 = await parseDocument(test2Buffer, "audit.py");
  console.log(`Test 2 (py): expected 9 words, parsed: ${result2.wordCount} words - ${result2.wordCount === 9 ? 'PASS' : 'FAIL'}`);

  // Test 3: Creating a zip with txt/code inside
  const zip = new AdmZip();
  zip.addFile("doc1.txt", Buffer.from("Hello from zip text content verification checks."));
  zip.addFile("script.py", Buffer.from("x = 10\ny = 20\nprint(x + y)"));
  const zipBuffer = zip.toBuffer();
  
  const result3 = await parseDocument(zipBuffer, "archive.zip");
  console.log(`Test 3 (zip): expected 16 words, parsed: ${result3.wordCount} words - ${result3.wordCount === 16 ? 'PASS' : 'FAIL'}`);
  
  console.log("=== VERIFICATIONS CONCLUDED ===");
}

runTests();
