// server.js

// Load environment variables immediately
require('dotenv').config();

// --- Core Libraries ---
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Required for os.tmpdir()

// GitHub API client
const { Octokit } = require('octokit');

// For running command-line tools (like git)
const { spawn } = require('child_process');

// --- LLM Integration ---
const { OpenAI } = require('openai');

// --- Configuration ---
const app = express();
// Cloud platforms will often set the PORT environment variable automatically
const port = process.env.PORT || process.env.API_PORT || 3000;

// Initialize Octokit with your PAT
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

// Initialize the OpenAI Client
// The SDK automatically uses OPENAI_API_KEY from the environment
const openai = new OpenAI({});

// Get secrets from .env (will be loaded from the cloud environment for deployment)
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
    // This acknowledges receipt and prevents the sender from timing out.
    res.status(200).json({ message: `Request for task ${taskData.task}, round ${taskData.round} received. Processing in background.` });

    // 3. Process the task in the background (asynchronously)
    processTask(taskData).catch(err => {
        // Log any critical errors that occur after the 200 response has been sent
        console.error(`FATAL ERROR processing task ${taskData.task}:`, err.message, err.stack);
    });
});

// =====================================================================
// == 2. Core Orchestration Logic ==
// =====================================================================

async function processTask(data) {
    const { email, task, round, nonce, brief, checks, evaluation_url } = data;
    
    // Repository details generation
    const repoName = `${task}-${round}`;
    const repoURL = `https://github.com/${GITHUB_USERNAME}/${repoName}`;
    const pagesURL = `https://${GITHUB_USERNAME}.github.io/${repoName}/`;
    
    console.log(`\n--- Starting execution for ${repoName} (Round ${round}) ---`);

    try {
        // A. Generate the Code using the LLM
        const files = await generateAppCode(data);
        
        // B. Create/Update Repo and Push
        const commitSHA = await commitToGitHub(repoName, files, brief, round);
        
        // C. Enable GitHub Pages (Only required for Round 1 setup)
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

// Helper to decode a data URI attachment (used for text snippets)
function decodeAttachment(attachment) {
    const base64Data = attachment.url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
}

/**
 * Uses the OpenAI API (gpt-4o) to generate required files in JSON format.
 */
async function generateAppCode(data) {
    const { brief, checks, attachments } = data;
    console.log("Generating code with OpenAI LLM (gpt-4o)...");

    // 1. Prepare the detailed prompt for the LLM
    let prompt = `You are a specialized code generator for a GitHub Pages deployment. 
    Your task is to create a complete, minimal, single-page application that meets the following requirements. 
    The application must be self-contained in index.html, using only client-side JavaScript.
    
    REQUIREMENTS (BRIEF): ${brief}
    EVALUATION CHECKS: \n- ${checks.join('\n- ')}
    
    OUTPUT FORMAT: Return a single JSON object where keys are file names (e.g., 'index.html', 'README.md', 'LICENSE') and values are the file content as string values.
    
    REQUIRED FILES:
    - index.html (The main application file, including all HTML, CSS, and JS)
    - README.md (Must be professional: summary, setup, usage, code explanation, license)
    - LICENSE (Must contain the full MIT License text)
    `;

    // 2. Prepare content for the API call (handles text and vision inputs)
    const messages = [
        {
            role: "user",
            content: [
                { type: "text", text: prompt }
            ]
        }
    ];

    // Add attachments (especially images) to the message content
    attachments.forEach(att => {
        if (att.url.startsWith('data:image/')) {
            messages[0].content.push({
                type: "image_url",
                image_url: { url: att.url }
            });
        } else {
            // For non-image data URIs, include a text snippet for context
            const contentSnippet = decodeAttachment(att).toString('utf-8').slice(0, 500) + '... (truncated)';
            messages[0].content.push({
                type: "text",
                text: `Attachment ${att.name} snippet: ${contentSnippet}`
            });
        }
    });

    // 3. Make the API call
    const response = await openai.chat.completions.create({
        model: 'gpt-4o', 
        messages: messages,
        response_format: { type: "json_object" }, 
        temperature: 0.1, 
    });

    // 4. Process the response
    const jsonString = response.choices[0].message.content.trim();
    
    try {
        const files = JSON.parse(jsonString);
        
        // Basic validation of the required files
        if (!files['index.html'] || !files['README.md'] || !files['LICENSE']) {
            throw new Error("LLM did not return all required files: index.html, README.md, and LICENSE.");
        }
        
        console.log("OpenAI code generation complete.");
        return files;

    } catch (e) {
        console.error("Failed to parse LLM response into JSON or missing required files.");
        console.error("Raw LLM Response:", jsonString.substring(0, 500) + '...');
        throw new Error(`Code generation failed: ${e.message}`);
    }
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
    // Use a temporary directory based on the task name
    const tempDir = path.join(os.tmpdir(), 'llm_task_temp', repoName);
    // Use the PAT for HTTPS authentication in the git URL
    const repoURL = `https://${GITHUB_USERNAME}:${GITHUB_PAT}@github.com/${GITHUB_USERNAME}/${repoName}.git`;

    try {
        // A. Create Repository (Round 1 only)
        if (round === 1) {
            console.log(`- Creating new public repository: ${repoName}`);
            await octokit.repos.createForAuthenticatedUser({
                name: repoName,
                description: `LLM-generated app for task ${repoName}`,
                private: false, // Must be public for GitHub Pages
            });
        }
        
        // B. Prepare Local Directory
        fs.mkdirSync(tempDir, { recursive: true });
        
        // Write the generated files
        for (const [fileName, content] of Object.entries(files)) {
            // Write contents to the temp directory
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
        const commitMessage = `Round ${round} submission: ${brief.substring(0, 100).trim()}...`;
        await runCommand('git', ['commit', '-m', commitMessage], tempDir);
        await runCommand('git', ['branch', '-M', 'main'], tempDir);
        
        // Push the changes
        await runCommand('git', ['push', '-u', 'origin', 'main'], tempDir);

        // 4. Get the Commit SHA
        const commitSHA = (await runCommand('git', ['rev-parse', 'HEAD'], tempDir)).trim();
        
        console.log(`- New Commit SHA: ${commitSHA}`);
        return commitSHA;

    } finally {
        // D. Cleanup: Remove the temporary directory
        if (fs.existsSync(tempDir)) {
            console.log("- Cleaning up temporary directory.");
            fs.rmSync(tempDir, { recursive: true, force: true });
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
    console.log(`- GitHub Pages setup complete. URL: https://${GITHUB_USERNAME}.github.io/${repoName}/`);
}

// =====================================================================
// == 5. Evaluation Notification Function ==
// =====================================================================

async function pingEvaluationAPI({ email, task, round, nonce, repo_url, commit_sha, pages_url, evaluation_url }) {
    const payload = { email, task, round, nonce, repo_url, commit_sha, pages_url };
    // Exponential backoff delays: 1, 2, 4, 8, 16, 32 seconds
    const delayTimes = [1000, 2000, 4000, 8000, 16000, 32000]; 

    for (let i = 0; i < delayTimes.length; i++) {
        const delay = delayTimes[i];
        try {
            console.log(`- Attempting to ping evaluation URL: ${evaluation_url} (Attempt ${i + 1})`);
            
            const response = await axios.post(evaluation_url, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000 // 10 second timeout for the ping
            });

            if (response.status === 200) {
                console.log('--- Evaluation ping successful! ---');
                return; // Success, exit the retry loop
            }
            
            // Log non-200 responses and continue to retry
            console.warn(`- Ping received non-200 status: ${response.status}. Retrying...`);
            
        } catch (error) {
            // Check for timeout or connection errors
            console.warn(`- Ping failed (retrying in ${delay / 1000}s): ${error.message.substring(0, 80)}...`);
            // Wait for the specified delay before the next attempt
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    // If we exit the loop, all retries failed
    throw new Error('Final evaluation ping failed after all retries. The task may not be evaluated.');
}