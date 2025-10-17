// server.js

// Load environment variables immediately
require('dotenv').config();

// --- Core Libraries ---
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// GitHub API client
const { Octokit } = require('octokit');

// For running command-line tools (like git)
const { spawn } = require('child_process');

// --- Configuration ---
const app = express();
const port = process.env.API_PORT || 3000;

// Initialize Octokit with your PAT
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

// Get secrets from .env
const STUDENT_SECRET = process.env.STUDENT_SECRET;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_PAT = process.env.GITHUB_PAT; // Used for CLI authentication

// Tell Express to parse incoming JSON bodies (with a large limit for attachments)
app.use(express.json({ limit: '50mb' }));

// --- Server Startup ---
app.listen(port, () => {
    console.log(`LLM Deployer API running on port ${port}`);
    console.log(`Ready to receive tasks...`);
});

// =====================================================================
// == 1. Main Deployment Endpoint ==
// =====================================================================

app.post('/api-endpoint', async (req, res) => {
    const taskData = req.body;

    // 1. Basic Verification Check
    if (taskData.secret !== STUDENT_SECRET) {
        console.error(`ERROR: Invalid secret provided for task ${taskData.task}`);
        return res.status(401).json({ error: 'Invalid student secret.' });
    }

    // 2. CRITICAL: Send HTTP 200 Response Immediately
    res.status(200).json({ message: `Request for task ${taskData.task}, round ${taskData.round} received. Processing in background.` });

    // 3. Process the task in the background
    processTask(taskData).catch(err => {
        console.error(`FATAL ERROR processing task ${taskData.task}:`, err.message);
    });
});

// =====================================================================
// == 2. Core Orchestration Logic ==
// =====================================================================

async function processTask(data) {
    const { email, task, round, nonce, brief, checks, evaluation_url } = data;
    
    // Repository details
    const repoName = `${task}-${round}`;
    const repoURL = `https://github.com/${GITHUB_USERNAME}/${repoName}`;
    const pagesURL = `https://${GITHUB_USERNAME}.github.io/${repoName}/`;
    
    console.log(`\n--- Starting execution for ${repoName} (Round ${round}) ---`);

    try {
        // A. Generate the Code
        const files = await generateAppCode(data);
        
        // B. Create/Update Repo and Push
        const commitSHA = await commitToGitHub(repoName, files, brief, round);
        
        // C. Enable GitHub Pages (Only required for Round 1 to initialize hosting)
        if (round === 1) {
            await enableGitHubPages(repoName);
        }
        
        // D. Notify the Evaluator
        await pingEvaluationAPI({ email, task, round, nonce, repo_url: repoURL, commit_sha: commitSHA, pages_url: pagesURL, evaluation_url });

        console.log(`SUCCESS: Task ${repoName} completed and evaluation ping sent.`);

    } catch (error) {
        console.error(`FAILURE: Deployment failed for ${repoName}. Details:`, error.message);
    }
}

// =====================================================================
// == 3. LLM and Code Generation Functions ==
// =====================================================================

// Helper to decode a data URI attachment
function decodeAttachment(attachment) {
    const base64Data = attachment.url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
}

/**
 * !!! IMPORTANT: REPLACE MOCK BLOCK WITH REAL LLM API CALL !!!
 */
async function generateAppCode(data) {
    const { brief, checks, attachments } = data;
    console.log("Generating code with LLM...");

    // 1. Prepare the detailed prompt for the LLM
    let prompt = `You are a specialized code generator for a GitHub Pages deployment. 
    Your task is to create a complete, minimal, single-page application that meets the following requirements. 
    The application must be self-contained in index.html, using only client-side JavaScript.
    
    REQUIREMENTS (BRIEF): ${brief}
    EVALUATION CHECKS: \n- ${checks.join('\n- ')}
    
    OUTPUT FORMAT: Return a single JSON object with the file names as keys and the file content as string values.
    
    REQUIRED FILES:
    - index.html (The main application file)
    - README.md (Must be professional: summary, setup, usage, code explanation, license)
    - LICENSE (Must contain the full MIT License text)
    
    ATTACHMENT DATA (Included for context and use in the app):
    `;
    
    attachments.forEach(att => {
        // Decode and truncate for the prompt (to save tokens)
        const contentSnippet = decodeAttachment(att).toString('utf-8').slice(0, 500) + '... (truncated)';
        prompt += `\n- File Name: ${att.name}, Type: ${att.url.split(';')[0]}, Content Snippet:\n${contentSnippet}\n`;
    });
    
    // ----------------------------------------------------------------
    // !!! START OF MOCK BLOCK - REPLACE THIS !!!
    // ----------------------------------------------------------------

    console.warn("WARNING: Using MOCK code generation. You MUST replace this with your real LLM call (e.g., Gemini API).");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate LLM latency

    return {
        'index.html': `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>LLM Task: ${data.task}</title>
            </head>
            <body>
                <h1>Application for Task: ${data.task}</h1>
                <p>Status: Code generated successfully for round ${data.round}.</p>
                <p>Brief: ${brief}</p>
                </body>
            </html>
        `,
        'README.md': `# ${data.task}\n\n## Summary\nThis application was generated by an LLM to fulfill the brief: "${brief}".\n\n## Setup\nNo setup required; deployable via GitHub Pages.\n\n## Code Explanation\nThe core logic is self-contained in index.html to handle the requested functionality.\n\n## License\nMIT License.\n`,
        'LICENSE': 'MIT License\n\nCopyright (c) 2024 Your Name\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n', 
    };
    
    // ----------------------------------------------------------------
    // !!! END OF MOCK BLOCK !!!
    // ----------------------------------------------------------------
}

// =====================================================================
// == 4. GitHub & Git CLI Functions ==
// =====================================================================

// Helper to run local shell commands (like 'git')
function runCommand(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { cwd });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`'${cmd} ${args.join(' ')}' failed with code ${code}. STDOUT: ${stdout}. STDERR: ${stderr}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function commitToGitHub(repoName, files, brief, round) {
    const tempDir = path.join(__dirname, 'temp_repo', repoName);
    const repoURL = `https://${GITHUB_USERNAME}:${GITHUB_PAT}@github.com/${GITHUB_USERNAME}/${repoName}.git`;

    try {
        // A. Create Repository (Round 1 only)
        if (round === 1) {
            console.log(`- Creating new public repository: ${repoName}`);
            await octokit.repos.createForAuthenticatedUser({
                name: repoName,
                description: `LLM-generated app for task ${repoName}`,
                private: false,
            });
        }
        
        // B. Prepare Local Directory
        fs.mkdirSync(tempDir, { recursive: true });
        
        // Write the generated files
        for (const [fileName, content] of Object.entries(files)) {
            // Write binary data for attachments if needed, but here we assume all are text files
            fs.writeFileSync(path.join(tempDir, fileName), content);
        }

        // C. Run Git Commands (CLI)
        console.log("- Running Git commands (init, commit, push)...");

        // 1. Initialize Git and link to remote
        await runCommand('git', ['init'], tempDir);
        await runCommand('git', ['remote', 'add', 'origin', repoURL], tempDir);
        
        // 2. Configure identity (required for commit)
        await runCommand('git', ['config', 'user.email', `${GITHUB_USERNAME}@users.noreply.github.com`], tempDir);
        await runCommand('git', ['config', 'user.name', GITHUB_USERNAME], tempDir);
        
        // 3. Add, Commit, and Push
        await runCommand('git', ['add', '.'], tempDir);
        const commitMessage = `Round ${round} update: ${brief.substring(0, 100).trim()}...`;
        await runCommand('git', ['commit', '-m', commitMessage], tempDir);
        await runCommand('git', ['branch', '-M', 'main'], tempDir);
        
        // Push the changes
        await runCommand('git', ['push', '-u', 'origin', 'main'], tempDir);

        // 4. Get the Commit SHA
        const commitSHA = (await runCommand('git', ['rev-parse', 'HEAD'], tempDir)).trim();
        
        console.log(`- New Commit SHA: ${commitSHA}`);
        return commitSHA;

    } finally {
        // D. Cleanup
        if (fs.existsSync(tempDir)) {
            console.log("- Cleaning up temporary directory.");
            fs.rmSync(path.join(__dirname, 'temp_repo'), { recursive: true, force: true });
        }
    }
}

async function enableGitHubPages(repoName) {
    console.log(`- Enabling GitHub Pages for ${repoName}...`);
    
    // This API call configures Pages to serve from the 'main' branch
    await octokit.repos.createPagesDeployment({
        owner: GITHUB_USERNAME,
        repo: repoName,
        source: {
            branch: 'main',
            path: '/', // root directory of the branch
        },
    });
    console.log(`- GitHub Pages setup complete.`);
}

// =====================================================================
// == 5. Evaluation Notification Function ==
// =====================================================================

async function pingEvaluationAPI({ email, task, round, nonce, repo_url, commit_sha, pages_url, evaluation_url }) {
    const payload = { email, task, round, nonce, repo_url, commit_sha, pages_url };
    // The required delays: 1, 2, 4, 8, 16, 32... seconds (in milliseconds)
    const delayTimes = [1000, 2000, 4000, 8000, 16000, 32000]; 

    for (let i = 0; i < delayTimes.length; i++) {
        const delay = delayTimes[i];
        try {
            console.log(`- Attempting to ping evaluation URL: ${evaluation_url} (Attempt ${i + 1})`);
            
            const response = await axios.post(evaluation_url, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000 // Set a reasonable timeout
            });

            if (response.status === 200) {
                console.log('--- Evaluation ping successful! ---');
                return; // Success, exit the retry loop
            }
            
            // Log non-200 responses and continue to retry
            console.warn(`- Ping received non-200 status: ${response.status}. Retrying...`);
            
        } catch (error) {
            console.warn(`- Ping failed (retrying in ${delay / 1000}s): ${error.message.substring(0, 80)}...`);
            // Wait for the specified delay before the next attempt
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    // If we exit the loop, all retries failed
    throw new Error('Final evaluation ping failed after all retries.');
}