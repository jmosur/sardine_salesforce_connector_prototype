# Sardine → Salesforce Connector Prototype

A working demo of Sardine risk signals surfaced live on Salesforce Account records.
No real Sardine or Salesforce credentials needed — everything is mocked.

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3003** in your browser.

## What's Running

One command starts three services in a single Node process:

| Service | Port | Role |
|---------|------|------|
| Mock Sardine API | 3001 | Serves risk profiles, fires webhook events, runs auto-simulation |
| Connector | 3002 | Receives Sardine webhooks, transforms fields, upserts to Salesforce |
| Mock Salesforce + UI | 3003 | Salesforce-style Account record dashboard |

## What You'll See

Three accounts — Acme Corp (HIGH risk), Globex Financial (LOW), Initech Payments (MEDIUM) — each with a live Sardine Risk panel showing:

- Fraud Score (0–100) with visual bar
- Overall Risk Level (LOW / MEDIUM / HIGH)
- KYC Status and Level
- AML Risk Level
- Device Risk + specific signals (VPN, emulator, velocity abuse, etc.)
- Behavior Signals
- Case Status and Case ID
- Checkpoint pass/fail summary

The panel updates live every 3 seconds as the connector processes Sardine webhook events.
Auto-simulation fires every 30 seconds to keep the demo moving on its own.

## Demo Controls

Use the buttons in the Sardine Risk panel to trigger scenarios instantly:

| Button | What it does |
|--------|-------------|
| 🔴 Escalate Risk | Raises fraud score, opens a review case, adds device signals |
| 🟡 AML Flag | Sets AML risk HIGH, opens a case |
| ⚠️ KYC Fail | Marks KYC rejected, escalates overall risk |
| 🟢 Clear Risk | Drops score, clears case, resets all signals |

Watch the **Connector Event Stream** bar at the bottom to see the webhook → upsert pipeline in real time.

## Architecture

```
┌──────────────────┐   webhook POST    ┌─────────────────┐   PATCH    ┌──────────────────┐
│  Mock Sardine    │ ────────────────► │   Connector     │ ─────────► │ Mock Salesforce  │
│  API :3001       │                   │   :3002         │            │ API + UI :$PORT  │
│  GET /customers  │ ◄──────────────── │  /webhook       │            │  PATCH /Account  │
│  POST /simulate  │  register webhook │  /events        │            │  GET  /api/...   │
└──────────────────┘                   └─────────────────┘            └──────────────────┘
```

**Flow:**
1. Connector starts → registers webhook with Sardine → runs initial full sync
2. Sardine fires `customer.risk_updated` when risk signals change
3. Connector transforms payload → 13 Salesforce custom fields (`Sardine_*__c`)
4. Connector PATCHes the SF Account via REST API
5. Dashboard polls every 3s and re-renders the risk panel

## Salesforce Custom Fields

These map to custom fields on the Account object in a real Salesforce org:

| Field API Name | Type | Description |
|----------------|------|-------------|
| `Sardine_Risk_Level__c` | Text | Overall risk level |
| `Sardine_Fraud_Score__c` | Number | 0–100 fraud score |
| `Sardine_KYC_Status__c` | Picklist | Approved / Pending / Rejected |
| `Sardine_KYC_Level__c` | Text | Standard / Enhanced |
| `Sardine_AML_Risk__c` | Text | AML risk level |
| `Sardine_Device_Risk__c` | Text | Device fingerprint risk |
| `Sardine_Device_Signals__c` | Long Text | Comma-separated signal list |
| `Sardine_Behavior_Signals__c` | Long Text | Behavioral anomalies |
| `Sardine_Case_Status__c` | Text | Open / Under Review / Cleared |
| `Sardine_Case_ID__c` | Text | Sardine case reference |
| `Sardine_Checkpoints_Passed__c` | Long Text | Passed checkpoint names |
| `Sardine_Checkpoints_Failed__c` | Long Text | Failed checkpoint names |
| `Sardine_Last_Updated__c` | DateTime | Last sync timestamp |

## Deploying to Railway

This project is designed to work on Railway out of the box:

1. Push to GitHub
2. Connect repo to Railway — it will auto-detect Node.js
3. Railway injects `PORT` automatically; the app binds to it
4. The `railway.toml` sets the health check path to `/api/accounts`

No environment variables needed.

## Requirements

- Node.js 18+
- npm
