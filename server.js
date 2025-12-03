const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002; // Render will set this to 10000
const cache = new NodeCache({ stdTTL: 300 }); // Cache for 5 minutes
const VERIFIED_USERS_FILE = path.join(__dirname, 'verified_users.json');

// In-memory store for verified users
let verifiedUsers = new Set();

// Load verified users from file
async function loadVerifiedUsers() {
    try {
        const data = await fs.readFile(VERIFIED_USERS_FILE, 'utf-8');
        verifiedUsers = new Set(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet, initialize with empty array
            await fs.writeFile(VERIFIED_USERS_FILE, JSON.stringify([], null, 2));
        } else {
            console.error('Error loading verified users:', error);
        }
    }
}

// Save verified users to file
async function saveVerifiedUsers() {
    try {
        await fs.writeFile(VERIFIED_USERS_FILE, JSON.stringify([...verifiedUsers], null, 2));
    } catch (error) {
        console.error('Error saving verified users:', error);
    }
}

// Initialize verified users
loadVerifiedUsers();

// Helper functions for generating fake data
function generateRandomPhoneNumber() {
    const areaCode = Math.floor(200 + Math.random() * 800); // 200-999 (valid US area codes)
    const first3 = Math.floor(100 + Math.random() * 900);   // 100-999
    const last4 = Math.floor(1000 + Math.random() * 9000);  // 1000-9999
    return `+1 (${areaCode}) ${first3}-${last4}`;
}

function generateRandomIP() {
    // Generate valid IP ranges (excluding 0.x, 127.x, 169.254.x.x, 224.x.x.x, etc.)
    const part1 = Math.floor(1 + Math.random() * 223);
    let part2 = Math.floor(Math.random() * 256);
    // Skip 127.x.x.x (localhost) and 169.254.x.x (APIPA)
    if (part1 === 127) part1 = 126;
    if (part1 === 169 && part2 === 254) part2 = 253;
    
    return `${part1}.${part2}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function generateRandomEmail(username) {
    const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'proton.me', 'aol.com'];
    const randomDomain = domains[Math.floor(Math.random() * domains.length)];
    const prefixes = ['', '.', '_', Math.floor(Math.random() * 100)];
    const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    return `${username}${randomPrefix}${Math.floor(Math.random() * 1000)}@${randomDomain}`.toLowerCase();
}

// Token management
// Parse tokens and validate them
const tokens = process.env.TWITTER_BEARER_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
if (tokens.length === 0) {
    console.error('ERROR: No Twitter Bearer Tokens found in environment variables');
    process.exit(1);
}
console.log(`Initialized with ${tokens.length} Twitter API tokens`);

let currentTokenIndex = 0;
let rateLimitedTokens = new Map(); // token -> retryAfter timestamp

// Function to get the next available token
const getNextToken = () => {
    const now = Date.now();
    
    // Clean up expired rate limits
    for (const [token, retryAfter] of rateLimitedTokens.entries()) {
        if (retryAfter <= now) {
            console.log(`Token ${token.substring(0, 10)}... rate limit expired`);
            rateLimitedTokens.delete(token);
        }
    }
    
    // If all tokens are rate limited, throw an error
    if (rateLimitedTokens.size >= tokens.length) {
        const nextReset = Math.min(...Array.from(rateLimitedTokens.values()));
        const waitTime = Math.ceil((nextReset - now) / 1000);
        throw new Error(`All API tokens are rate limited. Next reset in ${waitTime} seconds`);
    }
    
    // Find the next token that's not rate limited
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[currentTokenIndex];
        currentTokenIndex = (currentTokenIndex + 1) % tokens.length;
        
        if (!rateLimitedTokens.has(token)) {
            console.log(`Using token: ${token.substring(0, 10)}...`);
            return token;
        }
    }
    
    // This should theoretically never be reached due to the check above
    throw new Error('Failed to find an available token');
};

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from the current directory
app.use(express.static('.'));

// Twitter API request with retry and token rotation
const makeTwitterRequest = async (url, params = {}, maxRetries = tokens.length) => {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const token = getNextToken();
        console.log(`Attempt ${attempt}/${maxRetries} with token ${token.substring(0, 10)}...`);
        
        try {
            const response = await axios.get(url, {
                params,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'TwitterAdminPanel/1.0'
                },
                timeout: 10000 // 10 second timeout
            });
            
            console.log(`Request successful with token ${token.substring(0, 10)}...`);
            return { response, token };
            
        } catch (error) {
            lastError = error;
            
            if (error.response) {
                console.error(`API Error (${error.response.status}):`, 
                    error.response.data || 'No error details');
                
                // Handle rate limiting
                if (error.response.status === 429) {
                    const retryAfter = parseInt(error.response.headers['x-rate-limit-reset'] || '60', 10);
                    const resetTime = Date.now() + (retryAfter * 1000);
                    
                    console.log(`Token ${token.substring(0, 10)}... rate limited. Will retry after ${new Date(resetTime).toISOString()}`);
                    rateLimitedTokens.set(token, resetTime);
                    
                    // If we have more tokens, continue with the next one
                    if (attempt < maxRetries) continue;
                }
                
                // For other errors, throw immediately
                throw error;
            } else if (error.request) {
                console.error('No response received:', error.request);
            } else {
                console.error('Request setup error:', error.message);
            }
            
            // For non-API errors, wait a bit before retrying
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    // If we get here, all retries failed
    console.error('All retry attempts failed');
    throw lastError || new Error('All retry attempts failed');
};

// Toggle verification status for a user
app.post('/api/user/:username/verify', express.json(), async (req, res) => {
    const { username } = req.params;
    const { verified } = req.body;
    
    try {
        if (verified) {
            verifiedUsers.add(username.toLowerCase());
        } else {
            verifiedUsers.delete(username.toLowerCase());
        }
        await saveVerifiedUsers();
        res.json({ success: true, verified });
    } catch (error) {
        console.error('Error updating verification status:', error);
        res.status(500).json({ error: 'Failed to update verification status' });
    }
});

// Check verification status for a user
app.get('/api/user/:username/verify', async (req, res) => {
    const { username } = req.params;
    const isVerified = verifiedUsers.has(username.toLowerCase());
    res.json({ verified: isVerified });
});

// Twitter API endpoint with caching and token rotation
app.get('/api/user/:username', async (req, res) => {
    const { username } = req.params;
    const cacheKey = `user_${username}`;
    
    // Check cache first
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log('Serving from cache:', username);
        // Add cache headers for client-side caching
        res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
        return res.json(cachedData);
    }

    try {
        const { response } = await makeTwitterRequest(
            `https://api.twitter.com/2/users/by/username/${username}`,
            { 'user.fields': 'profile_image_url,description,public_metrics,verified,created_at' }
        );

        // Add fake data to the response
        if (response.data && response.data.data) {
            const user = response.data.data;
            user.phone = generateRandomPhoneNumber();
            user.email = generateRandomEmail(username);
            user.ip = generateRandomIP();
            user.last_ip = generateRandomIP();
            user.location = ['New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ', 
                           'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'San Jose, CA']
                           [Math.floor(Math.random() * 10)];
            
            // Add verification status
            user.verified = verifiedUsers.has(username.toLowerCase());
            
            // Add some random account activity timestamps
            user.last_seen = new Date(Date.now() - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000)).toISOString();
            user.account_created = user.created_at || new Date(Date.now() - Math.floor(Math.random() * 365 * 3 * 24 * 60 * 60 * 1000)).toISOString();
            
            // Cache the enhanced response for 5 minutes
            cache.set(cacheKey, response.data, 300);
        }
        
        res.json(response.data);
    } catch (error) {
        console.error('Twitter API Error:', error.response?.data || error.message);
        
        // Handle rate limiting specifically
        if (error.response && error.response.status === 429) {
            const resetTime = error.response.headers['x-rate-limit-reset'] || Math.floor(Date.now() / 1000) + 60; // Default to 60 seconds from now
            const retryAfter = error.response.headers['retry-after'] || 60; // Default to 60 seconds
            const resetDate = new Date(resetTime * 1000);
            const now = new Date();
            const secondsUntilReset = Math.ceil((resetDate - now) / 1000);
            
            // Set appropriate headers for client-side handling
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Reset', resetTime);
            res.setHeader('X-RateLimit-Remaining', '0');
            
            res.status(429).json({
                error: 'Rate limit exceeded',
                message: `Too many requests. Please try again in ${secondsUntilReset} seconds.`,
                resetTime: resetDate.toISOString(),
                retryAfter: parseInt(retryAfter, 10),
                status: 429
            });
            return;
        }
        
        // Handle other errors
        const statusCode = error.response?.status || 500;
        const errorMessage = error.response?.data?.detail || 'Failed to fetch user data';
        
        res.status(statusCode).json({
            error: 'API Request Failed',
            message: errorMessage,
            status: statusCode
        });
    }
});

// Serve login page at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve admin lookup panel at /lookup
app.get('/lookup', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API endpoint: http://localhost:${PORT}/api/user/:username`);
});
