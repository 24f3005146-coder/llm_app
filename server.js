// server.js

// --- 1. SETUP & IMPORTS ---
require('dotenv').config(); // For local testing only
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // For HTTP requests (evaluation API)
const { GoogleGenAI } = require('@google/genai'); // Gemini API
const simpleGit = require('simple-git'); // For GitHub operations (requires git to be installed on the host)
const fs = require('fs/promises'); // Node's built-in file system promises
const path = require('path');
const crypto = require('crypto'); // For generating temp directory names

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '5mb' })); // Increase limit for attachments

// --- 2. CONFIGURATION & CLIENTS ---

// Required Environment Variables
const STUDENT_SECRET = process.env.STUDENT_SECRET;
const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

// Initialize Gemini Client
if (!process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY is missing!");
    process.exit(1);
}
const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";


// --- 3. HELPER FUNCTIONS ---

/**
 * Decodes a data URI into its base64 data and mime type.
 * @param {string} dataUri - The data URI string.
 * @returns {{data: string, mimeType: string}|null}
 */
function decodeDataUri(dataUri) {
    const match = dataUri.match(/^data:(.*?);base64,(.*)$/);
    if (match && match.length === 3) {
        return {
            mimeType: match[1],
            data: match[2]
        };
    }
    return null;
}

/**
 * Generates app files using the Gemini API.
 * @param {object} requestPayload - The incoming JSON request.
 * @param {string} existingCode - Optional existing code for revision (Round 2).
 * @returns {Promise<{html: string, js: string, readme: string}>}
 */
async function generateCode(requestPayload, existingCode = null) {
    const { brief, checks, attachments, round } = requestPayload;

    // Build the prompt for the LLM
    let prompt = `You are an expert developer building a single-page web app.
        Generate the complete, minimal, and functional code for three files: 'index.html', 'script.js', and 'README.md'.
        The README must be professional and complete.
        
        **TASK ROUND:** ${round}
        **BRIEF:** ${brief}
        **EVALUATION CHECKS (Must be met):** ${JSON.stringify(checks)}
        
        `;

    // Add existing code for revision
    if (existingCode) {
        prompt += `
            --- REVISION ---
            The existing code files are:
            ${existingCode}
            Your response must be the FULL updated content for all three files.
            --- END REVISION ---
        `;
    }

    // Add attachments
    if (attachments && attachments.length > 0) {
        prompt += "\n**ATTACHMENTS:**\n";
        attachments.forEach(attachment => {
            const decoded = decodeDataUri(attachment.url);
            if (decoded) {
                // For code generation, we just describe the attachment.
                prompt += `- File Name: ${attachment.name}, Type: ${decoded.mimeType}, Content: (Base64 data is available for integration if needed, but for now, generate code based on the filename/brief.)\n`;
            }
        });
    }

    prompt += "\n**Output Format:** Provide only the file contents in separate markdown code blocks, labelled 'html', 'javascript', and 'markdown'.";

    console.log(`Sending prompt to Gemini for Round ${round}...`);
    
    // Call the LLM
    const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
    });
    
    const text = response.text;
    
    // Simple regex to extract code blocks (this is fragile but common)
    const extract = (label) => {
        const regex = new RegExp(`\`\`\`${label}\\n([\\s\\S]*?)\\n\`\`\``, 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : `// Error: Could not extract ${label} code.`;
    };

    return {
        html: extract('html'),
        js: extract('javascript'),
        readme: extract('markdown'),
        license: "The MIT License\n\nCopyright (c) [Year] [Student Name]\n\nPermission is hereby granted...", // Predefined MIT license
    };
}


/**
 * Pings the evaluation URL with exponential backoff.
 * @param {object} payload - The JSON payload to send.
 * @param {string} url - The evaluation URL.
 */
async function postToEvaluation(payload, url) {
    let delay = 1000; // 1 second start
    const maxRetries = 5;

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`Reporting to Evaluation API (Attempt ${i + 1})...`);
            await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log('Successfully reported to Evaluation API.');
            return;
        } catch (error) {
            console.warn(`Evaluation API failed (Status: ${error.response ? error.response.status : 'N/A'}). Retrying in ${delay / 1000}s...`);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff (1s, 2s, 4s, 8s, 16s)
            } else {
                console.error("Failed to report to Evaluation API after all retries.");
                throw new Error("Evaluation API reporting failed.");
            }
        }
    }
}


// --- 4. MAIN API ENDPOINT ---

app.post('/api-endpoint', async (req, res) => {
    const requestPayload = req.body;
    const { email, secret, task, round, nonce, brief, evaluation_url } = requestPayload;

    console.log(`\n--- Received Request (Round ${round}) for Task ${task} ---`);

    // 4a. Verify Secret
    if (secret !== STUDENT_SECRET) {
        console.warn(`Secret mismatch for email: ${email}. Rejecting.`);
        return res.status(403).json({ success: false, error: 'Invalid secret.' });
    }

    // Immediately send 200 OK response to the client
    res.status(200).json({ success: true, message: `Received request for Round ${round}. Processing...` });

    try {
        // --- ASYNCHRONOUS WORKFLOW START ---
        
        const REPO_NAME = `llm-project-${task}`;
        const REPO_URL = `https://github.com/${GITHUB_USERNAME}/${REPO_NAME}`;
        const PAGES_URL = `https://${GITHUB_USERNAME.toLowerCase()}.github.io/${REPO_NAME}/`;
        const GIT_AUTH_URL = `https://${GITHUB_USERNAME}:${GITHUB_PAT}@github.com/${GITHUB_USERNAME}/${REPO_NAME}.git`;
        
        let commitSha;
        let generatedFiles;

        if (round === 1) {
            // --- ROUND 1: BUILD & DEPLOY NEW REPO ---
            
            // Generate Code
            generatedFiles = await generateCode(requestPayload);

            // Create a temporary local folder for git
            const tempDir = path.join('/tmp', `repo-${task}-${crypto.randomBytes(4).toString('hex')}`);
            await fs.mkdir(tempDir, { recursive: true });
            
            // Write files
            await fs.writeFile(path.join(tempDir, 'index.html'), generatedFiles.html);
            await fs.writeFile(path.join(tempDir, 'script.js'), generatedFiles.js);
            await fs.writeFile(path.join(tempDir, 'README.md'), generatedFiles.readme);
            await fs.writeFile(path.join(tempDir, 'LICENSE'), generatedFiles.license);
            
            // GitHub Workflow
            const git = simpleGit(tempDir);
            
            // Initialize and create the remote repo via GitHub API (alternative to git push --set-upstream)
            // Use simple-git to initialize and commit
            await git.init();
            await git.add('.');
            await git.commit('Initial LLM-generated app for Round 1');
            
            // Push to create the remote repo
            await git.addRemote('origin', GIT_AUTH_URL);
            await git.push('origin', 'main', { '--set-upstream': null });
            
            // NOTE: GitHub Pages must be enabled via the GitHub API/UI or a workflow, 
            // but for simplicity here we assume it's pre-configured or enabled via default settings.
            
            // Get the commit SHA
            commitSha = (await git.revparse(['HEAD'])).trim();
            console.log(`Round 1 Deployment complete. Commit SHA: ${commitSha}`);

            // Cleanup
            await fs.rm(tempDir, { recursive: true, force: true });

        } else if (round === 2) {
            // --- ROUND 2: REVISE EXISTING REPO ---

            // Fetch previous commit SHA from the 'repos' table if possible, or assume student keeps track.
            // For a complete solution, this server would need to query the Instructor's 'repos' table.
            // Since we can't do that, we assume the student's process uses a consistent repo structure.
            
            const tempDir = path.join('/tmp', `repo-${task}-${crypto.randomBytes(4).toString('hex')}`);
            
            // Clone existing repo
            const git = simpleGit();
            await git.clone(GIT_AUTH_URL, tempDir);
            
            // Read existing code for LLM context
            const existingCode = `
                index.html: \n${await fs.readFile(path.join(tempDir, 'index.html'), 'utf-8')}
                script.js: \n${await fs.readFile(path.join(tempDir, 'script.js'), 'utf-8')}
                README.md: \n${await fs.readFile(path.join(tempDir, 'README.md'), 'utf-8')}
            `;

            // Generate revised code
            generatedFiles = await generateCode(requestPayload, existingCode);

            // Overwrite files
            await fs.writeFile(path.join(tempDir, 'index.html'), generatedFiles.html);
            await fs.writeFile(path.join(tempDir, 'script.js'), generatedFiles.js);
            await fs.writeFile(path.join(tempDir, 'README.md'), generatedFiles.readme);

            // Commit and Push
            const repo = simpleGit(tempDir);
            await repo.add('.');
            await repo.commit(`Revision for Round 2: ${brief.substring(0, 40)}...`);
            await repo.push('origin', 'main');
            
            // Get the new commit SHA
            commitSha = (await repo.revparse(['HEAD'])).trim();
            console.log(`Round 2 Revision complete. New Commit SHA: ${commitSha}`);
            
            // Cleanup
            await fs.rm(tempDir, { recursive: true, force: true });
        }


        // --- REPORTING ---
        const evaluationPayload = {
            email,
            task,
            round,
            nonce,
            repo_url: REPO_URL,
            commit_sha: commitSha,
            pages_url: PAGES_URL,
        };

        // Post to the Instructor's evaluation URL
        await postToEvaluation(evaluationPayload, evaluation_url);
        
    } catch (error) {
        // Log critical errors during the processing phase (after sending 200 OK)
        console.error(`CRITICAL ERROR during Task ${task} Round ${round} processing:`, error.message);
        // Note: The original request already received a 200, so this error 
        // will only be visible in the Render logs.
    }
});


// --- 5. HEALTH CHECK ---

app.get('/', (req, res) => {
    res.send(`LLM Code Deployment Project API is running. Model: ${MODEL}.`);
});


// --- 6. START SERVER ---

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Student Secret Check: ${STUDENT_SECRET ? 'OK' : 'MISSING!'}`);
    console.log(`GitHub PAT Check: ${GITHUB_PAT ? 'OK' : 'MISSING!'}`);
});