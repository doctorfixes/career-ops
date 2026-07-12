# Railway Ship Checklist

## Prerequisites

- [ ] Railway account connected to GitHub
- [ ] GitHub repo pushed: `~/career-ops`
- [ ] OpenRouter API key ready

## Setup Steps

### 1. Push to GitHub
```bash
cd ~/career-ops
git init
git add -A
git commit -m "Initial career-ops setup — Ryan Brown profile, Railway infra"
gh repo create doctorfixes/career-ops --private --push --source=.
```

### 2. Deploy to Railway
1. Go to https://railway.com
2. Click **New Project** → **Deploy from GitHub repo**
3. Select `doctorfixes/career-ops`
4. Railway auto-detects `railway.json` and uses the Dockerfile

### 3. Add Railway Volumes
After deploy, add persistent volumes in Railway dashboard:
```
/app/data
/app/reports
/app/output
```

### 4. Set Railway Secrets
Add these environment variables in Railway dashboard:
```
OPENROUTER_API_KEY=sk-or-...   # Required for evaluations
NODE_ENV=production
PORT=8080
```

### 5. Set Up Railway Cron Jobs
In Railway dashboard → **Cron Jobs** tab:

| Cron Name | Schedule | Command | Description |
|-----------|----------|---------|-------------|
| `daily-scan` | `0 6 * * 1-5` | `npm run start && curl -X POST http://localhost:8080/api/scan` → **Use Railway cron HTTP trigger to `POST /api/scan`** | Scan ATS portals weekdays at 6am |
| `daily-pipeline` | `0 8 * * 1-5` | → **POST /api/pipeline** | Process pending offers weekdays at 8am |
| `liveness-check` | `0 12 * * 6` | → **POST /api/scan?command=liveness** | Weekend liveness check |

Railway cron triggers are HTTP POST requests to your service. Set them up to hit:
```
https://[your-railway-url].up.railway.app/api/scan
https://[your-railway-url].up.railway.app/api/pipeline
```

### 6. Update Hermes Skill with Railway URL
After Railway deploy, get the `*.up.railway.app` URL and update:
- The Hermes cron jobs below
- The `RAILWAY_URL` references in the career-ops skill

## Hermes Cron Jobs (after Railway deploy)

These Hermes crons will monitor and interact with the Railway deployment.

```bash
# Create after Railway URL is known:
# Weekly status digest: hermes cron --daily monday-9am stats + report
# Weekly pipeline check: hermes cron --daily friday-5pm pipeline summary
```

## Local One-Shot Commands

Until Railway is set up, you can run everything locally:

```bash
# Scan for jobs
cd ~/career-ops && node openrouter-runner.mjs scan

# Evaluate pending offers
cd ~/career-ops && node openrouter-runner.mjs pipeline

# One-off evaluation
cd ~/career-ops && node openrouter-runner.mjs evaluate https://careers.company.com/job/123

# Check pipeline stats
cd ~/career-ops && node stats.mjs --summary

# Add a URL to pipeline
cd ~/career-ops && node add-entry.mjs "https://careers.example.com/job/456"

# Generate PDF CV for a company
cd ~/career-ops && node generate-pdf.mjs marriott-director-of-rooms
```