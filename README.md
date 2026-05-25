# 🌿 Buford Lawn Care AI Voice Assistant

An AI-powered phone assistant that answers missed calls, collects service intake info, records the call, transcribes it, saves everything to Google Drive + Supabase, and texts/emails you a summary.

---

## How It Works

```
You miss a call
     ↓
Your carrier forwards to Twilio number
     ↓
This server answers → Jordan (AI) greets the caller
     ↓
Conversation loop: caller speaks → Whisper transcribes → GPT-4o mini responds → TTS speaks
     ↓
Call ends → Recording + transcript → Google Drive
           → Call data → Supabase
           → Summary → Your email + SMS
```

---

## Step 1: Get Your Accounts & Keys

### Twilio (Phone number + SMS)
1. Sign up at [twilio.com](https://twilio.com)
2. Buy a phone number (~$1/mo) — this is what your real number forwards to
3. From the Twilio Console, copy:
   - **Account SID**
   - **Auth Token**
   - **Phone Number** (the one you bought)

### OpenAI (AI brain + voice)
1. Sign up at [platform.openai.com](https://platform.openai.com)
2. Go to API Keys → Create new key
3. Copy your **API Key**
4. Add billing (even $10 will last a very long time at these volumes)

### Supabase (Database)
1. Sign up at [supabase.com](https://supabase.com) — free tier is plenty
2. Create a new project
3. Go to **Settings → API** and copy:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **service_role** key (the secret one, NOT the anon key)
4. Go to **SQL Editor** and paste + run the contents of `supabase-schema.sql`

### Google Drive (Recording + transcript storage)
**Part A: Create a Service Account**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable the **Google Drive API**
4. Go to **IAM & Admin → Service Accounts → Create Service Account**
5. Name it (e.g. "lawn-care-ai"), click Create
6. Click the service account → **Keys → Add Key → JSON**
7. Download the JSON file — you'll need:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

**Part B: Share your Drive folder**
1. Create a folder in Google Drive (e.g. "Lawn Care Call Recordings")
2. Right-click → Share → paste the service account email → Editor
3. Copy the folder ID from the URL: `drive.google.com/drive/folders/`**`THIS_PART`**

### Gmail (Email notifications)
1. In the same Google Cloud project, enable the **Gmail API**
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Add `https://developers.google.com/oauthplayground` as an Authorized Redirect URI
5. Copy your **Client ID** and **Client Secret**
6. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
7. Click the gear icon → check "Use your own OAuth credentials" → paste Client ID + Secret
8. In Step 1, select **Gmail API v1** → `https://mail.google.com/`
9. Authorize → Exchange for tokens → Copy the **Refresh Token**

---

## Step 2: Deploy to Railway

1. Push this project to a GitHub repo
2. Sign up at [railway.app](https://railway.app) — free tier works
3. New Project → Deploy from GitHub → select your repo
4. Go to **Variables** and add all the values from `.env.example`
5. Railway gives you a public URL like `https://buford-lawn-ai-production.up.railway.app`
6. Set that as your `BASE_URL` variable

---

## Step 3: Configure SignalWire Webhook

1. Go to [bufordlcm.signalwire.com](https://bufordlcm.signalwire.com)
2. Click **Phone Numbers** → click your number (+1 727 428 3673)
3. Under **Voice & Fax → When a call comes in**, set:
   - Type: **LaML Webhook**
   - URL: `https://your-app.railway.app/voice/inbound`
   - Method: **HTTP POST**
4. Save

---

## Step 4: Set Up Call Forwarding on Your Phone

This tells your carrier: "if I don't answer in X rings, forward to the Twilio number."

**iPhone (most carriers):**
- Dial: `*61*+1XXXXXXXXXX*11*25#` (replace with your Twilio number, 25 = seconds)
- Press Call
- You'll get a confirmation message

**Android:**
- Phone app → Settings → Calls → Call Forwarding → Forward when unanswered

**Carrier-specific (if above doesn't work):**
- **AT&T**: Call 611 and ask them to set up conditional call forwarding
- **Verizon**: `*71` + Twilio number
- **T-Mobile**: Go to account settings online

> **Test it**: Call your real number from another phone, let it ring — Jordan should answer!

---

## Step 5: Test End-to-End

1. Call your number, don't answer
2. Jordan should greet you within 2-3 rings of forwarding
3. Say "I need a quote for mowing"
4. Let the full conversation play out
5. After you hang up, within ~30 seconds you should get:
   - SMS to your cell
   - Email to your inbox
   - Recording + transcript in Google Drive
   - Row in Supabase `calls` table

---

## Customizing Jordan

Edit `src/agent.js` — specifically the `SYSTEM_PROMPT` constant to:
- Change the business name or greeting
- Add/remove services
- Change what questions are asked
- Adjust how many times Jordan follows up

To change the voice:
- Edit `src/speak.js` → change `voice: "nova"` to any of: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

---

## Cost Estimates

| Per call (3 min avg) | Cost |
|---|---|
| Twilio inbound | ~$0.03 |
| OpenAI TTS (10 responses) | ~$0.04 |
| GPT-4o mini (10 turns) | ~$0.01 |
| **Total per call** | **~$0.08** |

Monthly estimate (50 calls/mo): ~$4 in AI costs + $1 Twilio number = **~$5/month**

---

## Project Structure

```
buford-lawn-ai/
├── src/
│   ├── server.js      # Express server + Twilio webhooks
│   ├── agent.js       # GPT-4o mini conversation logic
│   ├── speak.js       # OpenAI TTS
│   ├── storage.js     # Google Drive + Supabase
│   └── notify.js      # Gmail + SMS notifications
├── supabase-schema.sql
├── package.json
├── .env.example
└── README.md
```

---

## Future SaaS Additions (already designed for it)

- The `gathered_info` JSONB column in Supabase is ready for a dashboard
- Add Supabase Row Level Security when you add multi-tenant support
- Add a `/dashboard` route with a simple React frontend to view all leads
- Swap the system prompt per-tenant to white-label for other lawn care companies
