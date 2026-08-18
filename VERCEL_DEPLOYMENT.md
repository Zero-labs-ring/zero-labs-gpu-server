# Vercel Deployment Checklist & Instructions

## 1. Environment Variables to Set in Vercel Dashboard
In your Vercel Project Settings (**Settings → Environment Variables**), add the following:

| Key | Example / Description |
| :--- | :--- |
| `SUPABASE_URL` | `https://blooumzjgjqrerghqwwa.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your secret `service_role` key from Supabase API settings |
| `ENCRYPTION_KEY` | `16f9027b2be0026c400e041499a684c6bc6e2d8e4c4ffa528a90e5eb4cc8a65e` |
| `ZERO_API_KEY` | `zerotech13287` |
| `CRON_SECRET` | Secret token to authorize Vercel Cron jobs |
| `HF_TOKEN` | HuggingFace token for private models |
| `PRO_KERNEL_SLUG` | `zero-pro-server-v3` |
| `ULTRA_KERNEL_SLUG` | `zero-ultra-server-v3` |
| `KAGGLE_ACCELERATOR` | `gpuT4x2` |

---

## 2. Deploy via GitHub / Git (Recommended)
1. Initialize and push your repository to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Deploy Zero GPU Server"
   git branch -M main
   git remote add origin https://github.com/<your-user>/<repo-name>.git
   git push -u origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new).
3. Import your GitHub repository.
4. Add the Environment Variables listed above.
5. Click **Deploy**.

---

## 3. Deploy via Vercel CLI (Direct)
1. Install Vercel CLI globally:
   ```bash
   npm i -g vercel
   ```
2. Deploy:
   ```bash
   vercel --prod
   ```
3. Set your environment variables when prompted or via the dashboard.

---

## 4. Automatic Cron Jobs Configured
- **Keepalive Cron**: `/api/cron/keepalive` runs daily (`0 12 * * *`) to keep your Supabase instance active and prevent 7-day auto-pausing.
- **Orchestration Cron**: `/api/cron/orchestrate` runs every 5 minutes (`*/5 * * * *`) to maintain cluster session targets.
