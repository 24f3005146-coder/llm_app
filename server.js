// server.js

const express = require('express');
const axios = require('axios');
const { Octokit } = require("@octokit/rest");
const OpenAI = require('openai');
const { Buffer } = require('buffer'); // Required for Base64 encoding for GitHub API

// --- INITIALIZATION ---
// Initialize API Clients using environment variables
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); 

// Configuration from Environment Variables
const GITHUB_OWNER = process.env.GITHUB_USERNAME; 

const app = express();
app.use(express.json()); 


// --- HELPER FUNCTIONS ---

/**
 * 1. Generates the necessary files (HTML, README, LICENSE) using the OpenAI API.
 * Uses JSON mode for reliable structured output.
 */
async function generateFiles(brief, attachments) {
    const attachment_info = attachments.map(a => 
        `Attachment: ${a.name}, Type: ${a.url.substring(5, a.url.indexOf(';'))}`
    ).join('\n');

    const systemPrompt = `You are an expert web developer and documentation writer. Based on the brief, generate a complete, working, single-page web application (HTML/JS/CSS). The application must be fully contained in 'index.html'. Also generate a professional 'README.md' and the standard 'MIT LICENSE' text. Your response MUST be a single JSON object.`;

    const userPrompt = `
        APPLICATION BRIEF: "${brief}"
        ATTACHMENTS: ${attachment_info}
        
        If the brief is for Round 2, treat it as a modification request for the existing code.
    `;

    const responseSchema = {
        type: "object",
        properties: {
            html_content: { type: "string", description: "The complete HTML file content for the app." },
            readme_content: { type: "string", description: "A professional, complete README.md content." },
            license_content: { type: "string", description: "The full, standard MIT License text." }
        },
        required: ["html_content", "readme_content", "license_content"]
    };

    const response = await openai.chat.completions.create({
        model: "gpt-4o", 
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1 
    });

    const jsonText = response.choices[0].message.content;
    return JSON.parse(jsonText);
}

/**
 * 2. Creates the repository, pushes files, and enables GitHub Pages.
 * Handles both creation (Round 1) and file update (Round 2).
 */
async function createAndPushRepo(octokit, owner, repoName, files, round) {
    const defaultBranch = 'main';
    let commit_sha = '';
    
    // --- Round 1: Create Repo and Push Initial Files ---
    if (round === 1) {
        console.log(`Round 1: Creating new repository ${repoName}...`);
        
        await octokit.repos.createForAuthenticatedUser({
            name: repoName,
            private: false, // Must be public
        });
        
        // Push initial files sequentially (simplest Octokit method)
        const filesToCommit = [
            { path: 'LICENSE', content: files.license_content, message: 'feat: Add MIT License' },
            { path: 'README.md', content: files.readme_content, message: 'feat: Initial README' },
            { path: 'index.html', content: files.html_content, message: 'feat: Initial application code (Round 1)' },
        ];
        
        for (const file of filesToCommit) {
            const commitResponse = await octokit.repos.createOrUpdateFileContents({
                owner,
                repo: repoName,
                path: file.path,
                message: file.message,
                content: Buffer.from(file.content, 'utf8').toString('base64'),
                branch: defaultBranch
            });
            commit_sha = commitResponse.data.commit.sha;
        }

        // Enable GitHub Pages
        await octokit.repos.createPagesSite({
            owner,
            repo: repoName,
            source: { branch: defaultBranch, path: '/' },
        });

    } 
    // --- Round 2: Update Existing Files ---
    else if (round === 2) {
        console.log(`Round 2: Updating existing repository ${repoName}...`);
        
        const filesToUpdate = [
            { path: 'index.html', content: files.html_content, message: 'refactor: Round 2 application update' },
            { path: 'README.md', content: files.readme_content, message: 'docs: Update README for Round 2 features' },
        ];

        for (const file of filesToUpdate) {
             // Get the SHA of the current file to reference it in the update
            const { data: { sha: currentSha } } = await octokit.repos.getContent({
                owner,
                repo: repoName,
                path: file.path,
                ref: defaultBranch,
            });

            const commitResponse = await octokit.repos.createOrUpdateFileContents({
                owner,
                repo: repoName,
                path: file.path,
                message: file.message,
                content: Buffer.from(file.content, 'utf8').toString('base64'),
                sha: currentSha, // Required for updating existing files
                branch: defaultBranch
            });
            commit_sha = commitResponse.data.commit.sha;
        }
    }

    const repo_url = `https://github.com/${owner}/${repoName}`;
    const pages_url = `https://${owner}.github.io/${repoName}/`; 
    
    return { repo_url, commit_sha, pages_url };
}

/**
 * 3. Sends the final notification to the evaluation API with mandatory retry logic.
 */
async function sendNotification(axios, payload, evaluationUrl) {
    let delay = 1000; // 1 second
    const MAX_RETRIES = 5; 

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            console.log(`Submitting evaluation data (Attempt ${i + 1})...`);
            await axios.post(evaluationUrl, payload, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log("Notification successful! ✅");
            return; 
        } catch (error) {
            console.warn(`Notification failed. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; 
        }
    }
    throw new Error("Failed to send final notification after all retries.");
}


/**
 * 4. The Orchestrator: Main background function to process the request.
 */
async function processTask(requestBody) {
    const { email, task, round, nonce, brief, evaluation_url, attachments } = requestBody;
    // Create a unique repo name based on the task ID
    const repoName = `llm-deploy-${task.toLowerCase().replace(/[^a-z0-9]/g, '-')}`; 
    
    try {
	console.log(`Starting Round ${round} processing for: ${repoName}`);
        // Step 1: LLM Code Generation
        const files = await generateFiles(brief, attachments);
	console.log(`DEBUG: Files generated successfully. HTML length: ${files.html_content.length}`);
        
        // Step 2: GitHub Repository Operations (Create or Update)
        const { repo_url, commit_sha, pages_url } = await createAndPushRepo(
            octokit, GITHUB_OWNER, repoName, files, round
        );

        // Step 3: Final Notification
        const notificationPayload = { email, task, round, nonce, repo_url, commit_sha, pages_url };
        await sendNotification(axios, notificationPayload, evaluation_url);

        console.log(`Task ${task} (Round ${round}) complete. Pages URL: ${pages_url}`);

    } catch (error) {
        console.error(`--- CRITICAL FAILURE for Task ${task} (Round ${round}) ---`);
        console.error("Error details:", error.message || error);
        // Do not re-submit to evaluation_url on failure, as required by the spec.
    }
}


// --- EXPRESS ROUTE HANDLER ---

// Your main API endpoint
app.post('/', async (req, res) => {
    // 1. Authenticate
    const studentSecret = process.env.STUDENT_SECRET;
    if (req.body.secret !== studentSecret) {
        return res.status(401).json({ error: 'Invalid secret value.' });
    }

    // 2. Immediate Response
    res.status(200).json({ success: true, message: 'Request accepted. Processing in background.' });

    // 3. Start Asynchronous Background Processing
    processTask(req.body).catch(err => {
        console.error(`FATAL ERROR in processTask background thread:`, err);
    });
});


// --- SERVER START ---

// Use the PORT provided by Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Ready to receive requests at ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
});