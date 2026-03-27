# Deploying TuneScope to Railway

Railway is the simplest way to get TuneScope online.
Estimated time: **15 minutes**.
Cost: **Free for 30 days**, then ~$5/month.

---

## Step 1 — Put your code on GitHub

Railway deploys from GitHub, so you need your project there first.

1. Go to https://github.com and sign up (free)
2. Click **New repository** → name it `tunescope` → set to **Private** → click **Create**
3. Open your terminal, go to your project folder:

```bash
cd ~/Downloads/tunescope
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tunescope.git
git push -u origin main
```
Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 2 — Deploy on Railway

1. Go to https://railway.app and click **Login with GitHub**
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `tunescope` repository
4. Railway detects it's a Node.js app and starts building automatically
5. Wait ~2 minutes for the build to finish

---

## Step 3 — Add a persistent volume (for the database)

This is the most important step — without it, your database resets every time the app restarts.

1. In your Railway project, click on your **tunescope service**
2. Click the **Volumes** tab → **Add Volume**
3. Set the mount path to: `/app/data`
4. Click **Add**

Then set the DB path environment variable:
1. Click the **Variables** tab
2. Click **New Variable**
3. Add: `DB_PATH` = `/app/data/tunescope.db`
4. Click **Save** — Railway will restart the app automatically

---

## Step 4 — Get your public URL

1. In your Railway project, click on your service
2. Click the **Settings** tab → **Networking** → **Generate Domain**
3. Railway gives you a URL like `tunescope-production.up.railway.app`
4. Click it — your site is live! 🎉

---

## Step 5 — Add a custom domain (when you're ready)

1. Buy a domain from Namecheap, Cloudflare, or Google Domains (~$10-15/year)
2. In Railway → Settings → Networking → **Custom Domain**
3. Enter your domain and follow the DNS instructions Railway shows you
4. Done — takes ~10 minutes to go live

---

## Environment variables reference

Set these in Railway → Variables tab:

| Variable | Value | Required |
|---|---|---|
| `DB_PATH` | `/app/data/tunescope.db` | **Yes** |
| `PORT` | (set automatically by Railway) | Auto |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Only if using AI pipeline |

---

## Updating the site

Whenever you make changes locally and want to deploy:

```bash
git add .
git commit -m "describe your change"
git push
```

Railway automatically detects the push and redeploys within ~2 minutes.

---

## Troubleshooting

**Build fails:**
- Check the build logs in Railway → Deployments tab
- Make sure `package.json` has the `start` script: `"start": "node server/index.js"`

**Site loads but no data:**
- Check that the `DB_PATH` variable is set correctly
- Check that the Volume is mounted at `/app/data`
- The backfill runs 10 seconds after startup — wait a moment and refresh

**Database resets on restart:**
- You haven't added the Volume yet — do Step 3 above

---

## Free alternatives (with limitations)

If you want to try something completely free first:

**Render (free tier)**
- Goes to sleep after 15 min of inactivity (takes ~30s to wake up)
- No persistent disk on free tier — database resets on restart
- Good for testing, not for real use
- Deploy at https://render.com → New Web Service → connect GitHub

**Fly.io (free tier)**
- More complex setup, requires installing their CLI
- Has persistent volumes on free tier
- Guide: https://fly.io/docs/languages-and-frameworks/node/
