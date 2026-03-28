import http from 'http';
import fetch from 'node-fetch';

// ⚠️ PASTE YOUR CLIENT ID AND SECRET HERE ⚠️
const CLIENT_ID = '28d9e8606be649a093daeb212813c0b3';
const CLIENT_SECRET = '4a814434667e434c993b7db68feb10ec';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';

const PORT = 8888;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/login') {
        const scope = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
        const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
        res.writeHead(302, { Location: authUrl });
        res.end();
    } 
    else if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (!code) {
            res.end('Error: No code provided');
            return;
        }

        try {
            const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
                },
                body: new URLSearchParams({
                    code: code,
                    redirect_uri: REDIRECT_URI,
                    grant_type: 'authorization_code'
                })
            });

            const data = await tokenRes.json();
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <h1>Success!</h1>
                <p>Add this to your .env file:</p>
                <pre style="background:#eee; padding:15px; border-radius:5px;">SPOTIFY_REFRESH_TOKEN=${data.refresh_token}</pre>
                <p>You can close this window and stop the terminal script now.</p>
            `);
            
            console.log('\n✅ SUCCESS! Add this line to your .env file:\n');
            console.log(`SPOTIFY_REFRESH_TOKEN=${data.refresh_token}\n`);
            
            setTimeout(() => process.exit(0), 1000); // Auto-kill script
        } catch (err) {
            res.end('Error fetching token: ' + err.message);
        }
    } else {
        res.end('Go to http://127.0.0.1:8888/login to start');
    }
});

server.listen(PORT, () => {
    console.log(`\n🎧 Spotify Auth Server running!`);
    console.log(`➡️  Open this URL in your browser to authorize: http://127.0.0.1:${PORT}/login\n`);
});