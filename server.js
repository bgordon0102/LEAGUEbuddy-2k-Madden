import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import session from 'express-session';
import axios from 'axios';
// ...removed discord.js bot import...
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Serve /data directory as static files
app.use('/data', express.static(path.join(__dirname, 'data')));
// API: Get Discord user by role ID
// ...removed Discord bot user lookup endpoint...
const PORT = 3001;

// Session middleware
app.use(session({ secret: 'your_secret', resave: false, saveUninitialized: true }));

// Discord OAuth2 login route
app.get('/api/auth/discord', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=1427783020949274636&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;
    res.redirect(url);
});

// Discord OAuth2 callback route
app.get('/api/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI,
            scope: 'identify guilds guilds.members.read'
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const accessToken = tokenRes.data.access_token;

        // Get user info
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Get member info in your guild (to check roles)
        // You will need to set DISCORD_GUILD_ID in your .env file
        const memberRes = await axios.get(`https://discord.com/api/users/@me/guilds/${process.env.DISCORD_GUILD_ID}/member`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        console.log('Discord user info:', userRes.data);
        console.log('Discord member info:', memberRes.data);
        req.session.user = {
            id: userRes.data.id,
            username: userRes.data.username,
            avatar: userRes.data.avatar || null,
            roles: memberRes.data.roles // Array of role IDs
        };
        console.log('Session user set:', req.session.user);
        req.session.save(err => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).send('Session save failed');
            }
            res.redirect('/dashboard'); // Redirect to your dashboard
        });
    } catch (err) {
        console.error('Discord OAuth2 callback error:', err.response ? err.response.data : err);
        res.status(500).send('Discord login failed');
    }
});

// Serve static files FIRST so API routes are not blocked
app.use(express.static(path.join(__dirname, 'dashboard'), {
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-store');
    }
}));

// --- Pending Trades API ---
const pendingTradesFile = path.join(__dirname, 'data', 'pendingTrades.json');
const rosterDir = path.join(__dirname, 'data', 'teams_rosters');

function readPendingTrades() {
    try {
        const data = fs.readFileSync(pendingTradesFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

function writePendingTrades(trades) {
    fs.writeFileSync(pendingTradesFile, JSON.stringify(trades, null, 2));
}

// Get all pending trades
app.get('/api/pending-trades', (req, res) => {
    // Mark expired trades
    let archetypes = new Set();
    fs.readdirSync(rosterDir).forEach(file => {
        if (!file.endsWith('.json')) return;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(rosterDir, file)));
            console.log('Read file:', file);
        } catch (err) {
            console.error('Error reading file:', file, err.message);
            return;
        }
        if (Array.isArray(data)) {
            data.forEach(player => {
                if (player.archetype) archetypes.add(player.archetype);
            });
        } else if (Array.isArray(data.players)) {
            data.players.forEach(player => {
                if (player.archetype) archetypes.add(player.archetype);
            });
        }
    });
    console.log('Archetypes found:', Array.from(archetypes));
    res.json(Array.from(archetypes).sort());
});

// Endpoint to get logged-in user info
app.get('/api/me', (req, res) => {
    res.json(req.session.user || null);
});

// Middleware to require staff role
function requireStaff(req, res, next) {
    if (req.session.user && req.session.user.roles && req.session.user.roles.includes(process.env.STAFF_ROLE_ID)) {
        return next();
    }
    res.status(403).send('Staff only');
}

// Example: Protect approve/reject endpoints
app.post('/api/pending-trades/approve/:idx', requireStaff, (req, res) => {
    // ...existing approve logic...
});
app.post('/api/pending-trades/reject/:idx', requireStaff, (req, res) => {
    // ...existing reject logic...
});

// Catch-all 404 for any unknown API route
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});

// Serve dashboard index.html
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
