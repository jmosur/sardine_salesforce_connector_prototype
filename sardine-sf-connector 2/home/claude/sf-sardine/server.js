/**
 * Sardine → Salesforce Connector — single entry point
 *
 * Runs three services in one Node process:
 *   [Sardine]     Mock Sardine API       → port 3001 (internal)
 *   [Connector]   Webhook + transformer  → port 3002 (internal)
 *   [Salesforce]  Mock SF API + UI       → process.env.PORT (Railway public port)
 *
 * Railway runs: node server.js
 * Locally:      node server.js  → open http://localhost:3003
 */

"use strict";
const express = require("express");
const axios   = require("axios");
const { v4: uuidv4 } = require("uuid");

// ─── Ports ────────────────────────────────────────────────────────────────
const SARDINE_PORT = 3001;
const CONN_PORT    = 3002;
const SF_PORT      = parseInt(process.env.PORT || "3003", 10);

const SARDINE_URL = `http://localhost:${SARDINE_PORT}`;
const CONN_URL    = `http://localhost:${CONN_PORT}`;
const SF_URL      = `http://localhost:${SF_PORT}`;

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 1 — MOCK SARDINE API (port 3001)
// ══════════════════════════════════════════════════════════════════════════
const sardine = express();
sardine.use(express.json());

const customers = {
  "acct-001": {
    id: "acct-001",
    sfAccountId: "0015g00000XkYzAAA1",
    name: "Acme Corp",
    sardineCustomerId: "sardine-cust-abc123",
    riskProfile: {
      overallRiskLevel: "HIGH", fraudScore: 82,
      kycStatus: "APPROVED",   kycLevel: "ENHANCED", amlRiskLevel: "MEDIUM",
      deviceRisk:   { level: "HIGH",   signals: ["vpn_detected", "velocity_abuse", "emulator_suspected"] },
      behaviorRisk: { level: "MEDIUM", signals: ["unusual_login_time", "new_device"] },
      caseStatus: "UNDER_REVIEW", caseId: "case-7821",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified"],
      checkpointsFailed: ["device_trust"],
    },
  },
  "acct-002": {
    id: "acct-002",
    sfAccountId: "0015g00000XkYzAAA2",
    name: "Globex Financial",
    sardineCustomerId: "sardine-cust-def456",
    riskProfile: {
      overallRiskLevel: "LOW", fraudScore: 12,
      kycStatus: "APPROVED",  kycLevel: "STANDARD", amlRiskLevel: "LOW",
      deviceRisk:   { level: "LOW", signals: [] },
      behaviorRisk: { level: "LOW", signals: [] },
      caseStatus: "CLEARED", caseId: null,
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified", "device_trust", "aml_screening"],
      checkpointsFailed: [],
    },
  },
  "acct-003": {
    id: "acct-003",
    sfAccountId: "0015g00000XkYzAAA3",
    name: "Initech Payments",
    sardineCustomerId: "sardine-cust-ghi789",
    riskProfile: {
      overallRiskLevel: "MEDIUM", fraudScore: 47,
      kycStatus: "PENDING",       kycLevel: "STANDARD", amlRiskLevel: "LOW",
      deviceRisk:   { level: "LOW",    signals: ["tor_exit_node"] },
      behaviorRisk: { level: "MEDIUM", signals: ["high_transaction_velocity"] },
      caseStatus: "OPEN", caseId: "case-7955",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["email_verified"],
      checkpointsFailed: ["kyc_basic"],
    },
  },
};

let webhookEndpoints = [];

sardine.get("/v1/customers", (req, res) => {
  res.json({ customers: Object.values(customers), total: Object.keys(customers).length });
});
sardine.get("/v1/customers/:id", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  c.riskProfile.lastChecked = new Date().toISOString();
  res.json(c);
});
sardine.post("/v1/webhooks/register", (req, res) => {
  const { url, events } = req.body;
  webhookEndpoints.push({ id: uuidv4(), url, events });
  console.log(`[Sardine]  Webhook registered → ${url}`);
  res.json({ message: "Webhook registered" });
});
sardine.post("/v1/customers/:id/simulate", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  applyScenario(c, req.body.scenario || "escalate");
  fireWebhooks(c, "customer.risk_updated");
  res.json({ message: "Scenario applied", riskProfile: c.riskProfile });
});

function applyScenario(customer, scenario) {
  const p = customer.riskProfile;
  switch (scenario) {
    case "escalate":
      p.overallRiskLevel = "HIGH";
      p.fraudScore       = Math.min(99, p.fraudScore + 30);
      p.caseStatus       = "UNDER_REVIEW";
      p.caseId           = p.caseId || `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      p.deviceRisk.signals = ["new_device_high_risk", "velocity_abuse"];
      p.deviceRisk.level   = "HIGH";
      break;
    case "clear":
      p.overallRiskLevel   = "LOW";
      p.fraudScore         = Math.max(1, p.fraudScore - 40);
      p.caseStatus         = "CLEARED";
      p.amlRiskLevel       = "LOW";
      p.kycStatus          = "APPROVED";
      p.deviceRisk.signals  = [];
      p.deviceRisk.level    = "LOW";
      p.behaviorRisk.signals = [];
      p.checkpointsFailed   = [];
      break;
    case "kyc_fail":
      p.kycStatus        = "REJECTED";
      p.overallRiskLevel = "HIGH";
      p.fraudScore       = Math.min(99, p.fraudScore + 20);
      p.checkpointsFailed = ["kyc_enhanced"];
      break;
    case "aml_flag":
      p.amlRiskLevel     = "HIGH";
      p.overallRiskLevel = "HIGH";
      p.caseStatus       = "OPEN";
      p.caseId           = `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      break;
  }
  p.lastChecked = new Date().toISOString();
}

async function fireWebhooks(customer, eventType) {
  const payload = {
    id: uuidv4(), type: eventType, created: new Date().toISOString(),
    data: {
      customerId:   customer.sardineCustomerId,
      sfAccountId:  customer.sfAccountId,
      internalId:   customer.id,
      riskProfile:  customer.riskProfile,
    },
  };
  for (const ep of webhookEndpoints) {
    if (ep.events.includes(eventType) || ep.events.includes("*")) {
      try {
        await axios.post(ep.url, payload, { timeout: 3000 });
        console.log(`[Sardine]  Webhook fired → ${ep.url}`);
      } catch (e) {
        console.log(`[Sardine]  Webhook failed: ${e.message}`);
      }
    }
  }
}

// Auto-simulation every 30s
let simIdx = 0;
const simScenarios   = ["escalate", "clear", "kyc_fail", "aml_flag", "clear"];
const simCustomerIds = Object.keys(customers);
setInterval(() => {
  const c = customers[simCustomerIds[simIdx % simCustomerIds.length]];
  const s = simScenarios[simIdx % simScenarios.length];
  console.log(`[Sardine]  Auto-sim: ${c.name} → ${s}`);
  applyScenario(c, s);
  fireWebhooks(c, "customer.risk_updated");
  simIdx++;
}, 30000);

sardine.listen(SARDINE_PORT, () =>
  console.log(`[Sardine]  Running on port ${SARDINE_PORT}`));

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 2 — CONNECTOR (port 3002)
// ══════════════════════════════════════════════════════════════════════════
const connector = express();
connector.use(express.json());

const eventLog = [];
function logEvent(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  eventLog.unshift(entry);
  if (eventLog.length > 50) eventLog.pop();
  console.log(`[Connector] ${type}: ${JSON.stringify(data).slice(0, 120)}`);
}

function transformFields({ riskProfile, sfAccountId }) {
  const risk = { LOW: "🟢 LOW", MEDIUM: "🟡 MEDIUM", HIGH: "🔴 HIGH", CRITICAL: "🚨 CRITICAL" };
  const kyc  = { APPROVED: "✅ Approved", PENDING: "⏳ Pending", REJECTED: "❌ Rejected" };
  return {
    sfAccountId,
    fields: {
      Sardine_Risk_Level__c:         risk[riskProfile.overallRiskLevel] || riskProfile.overallRiskLevel,
      Sardine_Fraud_Score__c:        riskProfile.fraudScore,
      Sardine_Last_Updated__c:       riskProfile.lastChecked,
      Sardine_KYC_Status__c:         kyc[riskProfile.kycStatus] || riskProfile.kycStatus,
      Sardine_KYC_Level__c:          riskProfile.kycLevel,
      Sardine_AML_Risk__c:           risk[riskProfile.amlRiskLevel] || riskProfile.amlRiskLevel,
      Sardine_Device_Risk__c:        risk[riskProfile.deviceRisk.level] || riskProfile.deviceRisk.level,
      Sardine_Device_Signals__c:     riskProfile.deviceRisk.signals.join(", ") || "None",
      Sardine_Behavior_Signals__c:   riskProfile.behaviorRisk.signals.join(", ") || "None",
      Sardine_Case_Status__c:        riskProfile.caseStatus,
      Sardine_Case_ID__c:            riskProfile.caseId || "",
      Sardine_Checkpoints_Passed__c: riskProfile.checkpointsPassed.join(", ") || "None",
      Sardine_Checkpoints_Failed__c: riskProfile.checkpointsFailed.join(", ") || "None",
    },
  };
}

async function upsertToSF(sfAccountId, fields) {
  try {
    await axios.patch(
      `${SF_URL}/services/data/v58.0/sobjects/Account/${sfAccountId}`,
      fields,
      { headers: { Authorization: "Bearer mock-token" } }
    );
    logEvent("sf_upsert_success", { sfAccountId, fieldCount: Object.keys(fields).length });
  } catch (e) {
    logEvent("sf_upsert_error", { sfAccountId, error: e.message });
  }
}

connector.post("/webhook/sardine", async (req, res) => {
  const event = req.body;
  logEvent("webhook_received", {
    sfAccountId: event.data?.sfAccountId,
    riskLevel:   event.data?.riskProfile?.overallRiskLevel,
    fraudScore:  event.data?.riskProfile?.fraudScore,
  });
  if (event.type === "customer.risk_updated") {
    const { sfAccountId, fields } = transformFields(event.data);
    await upsertToSF(sfAccountId, fields);
  }
  res.status(200).json({ received: true });
});

connector.get("/events", (req, res) => res.json({ events: eventLog }));
connector.get("/status", (req, res) => res.json({ service: "connector", status: "running" }));

connector.listen(CONN_PORT, async () => {
  console.log(`[Connector] Running on port ${CONN_PORT}`);
  // Wait for Sardine to be ready, then register webhook + initial sync
  await new Promise(r => setTimeout(r, 1500));
  try {
    await axios.post(`${SARDINE_URL}/v1/webhooks/register`, {
      url:    `${CONN_URL}/webhook/sardine`,
      events: ["customer.risk_updated"],
    });
    logEvent("startup", { message: "Webhook registered with Sardine" });

    const { data } = await axios.get(`${SARDINE_URL}/v1/customers`);
    for (const c of data.customers) {
      const { sfAccountId, fields } = transformFields({
        sfAccountId: c.sfAccountId, riskProfile: c.riskProfile,
      });
      await upsertToSF(sfAccountId, fields);
    }
    logEvent("startup", { message: `Initial sync complete — ${data.total} customers` });
  } catch (e) {
    logEvent("startup_error", { message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 3 — MOCK SALESFORCE API + DASHBOARD UI (process.env.PORT)
// ══════════════════════════════════════════════════════════════════════════
const sf = express();
sf.use(express.json());

const accounts = {
  "0015g00000XkYzAAA1": { Id: "0015g00000XkYzAAA1", Name: "Acme Corp",       Industry: "Financial Services", AnnualRevenue: 4200000,  Phone: "+1 (555) 010-1234", BillingCity: "San Francisco", BillingState: "CA", AccountOwner: "Sarah Chen",      Type: "Customer", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA2": { Id: "0015g00000XkYzAAA2", Name: "Globex Financial", Industry: "Banking",            AnnualRevenue: 18500000, Phone: "+1 (555) 020-5678", BillingCity: "New York",      BillingState: "NY", AccountOwner: "Marcus Thompson", Type: "Customer", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA3": { Id: "0015g00000XkYzAAA3", Name: "Initech Payments", Industry: "Fintech",            AnnualRevenue: 2100000,  Phone: "+1 (555) 030-9012", BillingCity: "Austin",        BillingState: "TX", AccountOwner: "Priya Patel",    Type: "Prospect", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
};

// Salesforce REST API (simulated)
sf.patch("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const a = accounts[req.params.id];
  if (!a) return res.status(404).json({ errorCode: "NOT_FOUND" });
  const prev = a.Sardine_Risk_Level__c;
  Object.assign(a, req.body);
  a._updateHistory.unshift({ timestamp: new Date().toISOString(), prevRisk: prev, newRisk: a.Sardine_Risk_Level__c, fraudScore: a.Sardine_Fraud_Score__c });
  if (a._updateHistory.length > 10) a._updateHistory.pop();
  console.log(`[Salesforce] PATCH ${a.Name} → ${a.Sardine_Risk_Level__c} score:${a.Sardine_Fraud_Score__c}`);
  res.status(204).send();
});

sf.get("/api/accounts",     (req, res) => res.json(Object.values(accounts)));
sf.get("/api/accounts/:id", (req, res) => {
  const a = accounts[req.params.id];
  res.json(a || { error: "Not found" });
});

// Proxy routes — browser → SF server → internal services
// (browser can't reach localhost:3001/3002 from outside the container)
sf.get("/proxy/connector/events", async (req, res) => {
  try { res.json((await axios.get(`${CONN_URL}/events`, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
sf.post("/proxy/sardine/customers/:id/simulate", async (req, res) => {
  try { res.json((await axios.post(`${SARDINE_URL}/v1/customers/${req.params.id}/simulate`, req.body, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Dashboard UI — served inline, no static files needed
sf.get("/", (req, res) => res.send(getDashboardHTML()));

sf.listen(SF_PORT, () => {
  console.log(`[Salesforce] UI running on port ${SF_PORT}`);
  // Keep-alive ping every 4 minutes to prevent Railway idle shutdown
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const url = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/accounts`;
    setInterval(async () => {
      try { await axios.get(url, { timeout: 5000 }); console.log("[Salesforce] Keep-alive OK"); }
      catch (e) { console.log(`[Salesforce] Keep-alive failed: ${e.message}`); }
    }, 4 * 60 * 1000);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD HTML (inline — avoids static file path issues on Railway)
// ══════════════════════════════════════════════════════════════════════════
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sardine Risk Intelligence — Salesforce</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--sf-navy:#032d60;--sf-blue:#0176d3;--sf-bg:#f3f3f3;--sf-white:#fff;--sf-border:#dddbda;--sf-text:#181818;--sf-muted:#706e6b;--sf-label:#514f4d;--sardine-ink:#1a1033;--risk-low:#2e844a;--risk-low-bg:#eaf5ea;--risk-med:#dd7a01;--risk-med-bg:#fdf3e3;--risk-high:#ba0517;--risk-high-bg:#fde8e8;--font-ui:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono',monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-ui);background:var(--sf-bg);color:var(--sf-text);font-size:13px;min-height:100vh}
.sf-header{background:var(--sf-navy);height:48px;display:flex;align-items:center;padding:0 16px;gap:12px;position:sticky;top:0;z-index:100}
.sf-logo{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.5px}.sf-logo span{color:#88c3fb}
.sf-nav{display:flex;gap:2px;margin-left:12px}
.sf-nav-item{color:#d8edff;font-size:12px;font-weight:500;padding:4px 12px;border-radius:4px;cursor:pointer}
.sf-nav-item.active{background:rgba(255,255,255,.18);color:#fff}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.conn-status{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);padding:3px 10px;border-radius:100px;font-size:11px;color:#88c3fb}
.dot{width:7px;height:7px;border-radius:50%;background:#3dd68c;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.last-refresh{font-size:10px;color:#88c3fb}
.page{max-width:1200px;margin:0 auto;padding:20px 16px 40px}
.acct-tabs{display:flex;gap:1px;background:var(--sf-border);border-radius:6px 6px 0 0;overflow:hidden;border:1px solid var(--sf-border);border-bottom:none;width:fit-content}
.acct-tab{padding:8px 18px;background:#e8e8e8;cursor:pointer;font-size:12px;font-weight:500;color:var(--sf-muted);display:flex;align-items:center;gap:6px;transition:background .12s}
.acct-tab.active{background:var(--sf-white);color:var(--sf-blue);font-weight:600}
.tab-dot{width:8px;height:8px;border-radius:50%;background:#ccc}
.record{background:var(--sf-white);border:1px solid var(--sf-border);border-top:3px solid var(--sf-blue);border-radius:0 6px 6px 6px}
.rec-hdr{padding:14px 20px;border-bottom:1px solid var(--sf-border);display:flex;align-items:flex-start;gap:12px}
.rec-icon{width:36px;height:36px;background:var(--sf-blue);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.rec-name{font-size:18px;font-weight:700;color:var(--sf-navy)}
.rec-meta{display:flex;gap:16px;margin-top:3px}
.rec-meta-item{font-size:11px;color:var(--sf-muted)}.rec-meta-item strong{color:var(--sf-label);font-weight:500}
.hl-bar{display:flex;border-bottom:1px solid var(--sf-border);overflow-x:auto}
.hl-item{padding:10px 20px;border-right:1px solid var(--sf-border);min-width:110px;flex-shrink:0}
.hl-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-muted);margin-bottom:3px}
.hl-value{font-size:14px;font-weight:600}
.rec-body{display:grid;grid-template-columns:1fr 370px;min-height:500px}
.rec-left{padding:20px;border-right:1px solid var(--sf-border)}
.rec-right{background:#f8f8f8}
.sec-hdr{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--sf-muted);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--sf-border)}
.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-bottom:20px}
.field-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--sf-muted);margin-bottom:2px}
.field-value{font-size:13px;color:var(--sf-text)}
.field-value.link{color:var(--sf-blue);cursor:pointer}
.sardine-panel{height:100%}
.sp-hdr{padding:11px 14px;background:var(--sardine-ink);display:flex;align-items:center;gap:8px}
.sp-wordmark{font-size:13px;font-weight:700;color:#fff;letter-spacing:-.3px}.sp-wordmark span{color:#a78bfa}
.sp-sub{font-size:10px;color:#a0a0c0;margin-left:auto}
.sp-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.score-card{border:1px solid var(--sf-border);border-radius:6px;padding:12px 14px;background:var(--sf-white)}
.score-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.score-num{font-size:28px;font-weight:700;font-family:var(--font-mono);color:var(--sf-navy);line-height:1}
.score-lbl{font-size:10px;color:var(--sf-muted);margin-top:1px}
.risk-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px}
.risk-badge.LOW{background:var(--risk-low-bg);color:var(--risk-low)}
.risk-badge.MEDIUM{background:var(--risk-med-bg);color:var(--risk-med)}
.risk-badge.HIGH{background:var(--risk-high-bg);color:var(--risk-high)}
.bar-track{height:6px;background:#e8e8e8;border-radius:100px;overflow:hidden}
.bar-fill{height:100%;border-radius:100px;transition:width .7s ease,background .5s}
.bar-lbls{display:flex;justify-content:space-between;font-size:9px;color:var(--sf-muted);margin-top:3px}
.sig-group{border:1px solid var(--sf-border);border-radius:6px;background:var(--sf-white);overflow:hidden}
.sig-grp-hdr{padding:6px 12px;background:#f4f4f4;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-label);border-bottom:1px solid var(--sf-border)}
.sig-row{display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #f0f0f0;gap:8px}
.sig-row:last-child{border-bottom:none}
.sig-key{font-size:11px;color:var(--sf-label);font-weight:500;min-width:90px;flex-shrink:0}
.sig-val{font-size:11px;font-weight:600;flex:1}
.pills{display:flex;flex-wrap:wrap;gap:4px;padding:7px 12px}
.pill{font-size:10px;padding:2px 7px;border-radius:100px;background:var(--risk-high-bg);color:var(--risk-high);font-weight:600;font-family:var(--font-mono)}
.pill.none{background:#f0f0f0;color:var(--sf-muted);font-family:var(--font-ui)}
.evlog{border:1px solid var(--sf-border);border-radius:6px;background:var(--sf-white);overflow:hidden}
.evlog-hdr{padding:6px 12px;background:#f4f4f4;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-label);border-bottom:1px solid var(--sf-border)}
.evlog-list{max-height:130px;overflow-y:auto}
.ev-item{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid #f4f4f4;font-size:11px}
.ev-item:last-child{border-bottom:none}
.ev-time{font-family:var(--font-mono);font-size:10px;color:var(--sf-muted);white-space:nowrap;min-width:58px}
.ev-desc{color:var(--sf-text);line-height:1.4}
.ev-tag{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:#e8f0fe;color:#1a73e8;white-space:nowrap;margin-left:auto}
.demo-ctrl{border-top:2px dashed #d0d0d0;padding:12px 14px;background:#fffbf0}
.demo-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#999;margin-bottom:7px}
.demo-btns{display:flex;flex-wrap:wrap;gap:5px}
.demo-btn{font-size:11px;font-weight:600;font-family:var(--font-ui);padding:5px 10px;border-radius:4px;border:1px solid;cursor:pointer;transition:opacity .15s}
.demo-btn:hover{opacity:.85}
.demo-btn.danger{background:var(--risk-high-bg);color:var(--risk-high);border-color:#f5b8b8}
.demo-btn.warning{background:var(--risk-med-bg);color:var(--risk-med);border-color:#f5d8a0}
.demo-btn.success{background:var(--risk-low-bg);color:var(--risk-low);border-color:#b0e0b8}
.conn-log{margin-top:14px;border:1px solid var(--sf-border);border-radius:6px;background:var(--sardine-ink);overflow:hidden}
.conn-log-hdr{padding:5px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.08)}
.conn-log-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8888aa}
.conn-log-body{max-height:80px;overflow-y:auto;padding:4px 0}
.log-line{font-family:var(--font-mono);font-size:10px;padding:2px 12px;display:flex;gap:8px}
.log-t{color:#5060a0}.log-type{color:#88c3fb;font-weight:600}.log-msg{color:#c0c0e0}
.log-line.ok .log-msg{color:#3dd68c}.log-line.err .log-msg{color:#f87171}
@keyframes flash{0%{background:#fff9c4}100%{background:transparent}}
.flash{animation:flash 1s ease-out}
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-thumb{background:#ccc;border-radius:2px}
</style>
</head>
<body>
<header class="sf-header">
  <div class="sf-logo">☁ Sales<span>force</span></div>
  <nav class="sf-nav">
    <div class="sf-nav-item">Home</div>
    <div class="sf-nav-item active">Accounts</div>
    <div class="sf-nav-item">Cases</div>
  </nav>
  <div class="hdr-right">
    <div class="conn-status"><div class="dot"></div><span>Sardine connector active</span></div>
    <div class="last-refresh" id="lastRefresh">—</div>
  </div>
</header>

<div class="page">
  <div class="acct-tabs" id="tabs"></div>
  <div class="record">
    <div class="rec-hdr">
      <div class="rec-icon">🏢</div>
      <div>
        <div class="rec-name" id="recName">Loading…</div>
        <div class="rec-meta">
          <div class="rec-meta-item"><strong>Industry:</strong> <span id="metaIndustry">—</span></div>
          <div class="rec-meta-item"><strong>Owner:</strong> <span id="metaOwner">—</span></div>
          <div class="rec-meta-item"><strong>Type:</strong> <span id="metaType">—</span></div>
        </div>
      </div>
    </div>
    <div class="hl-bar">
      <div class="hl-item"><div class="hl-label">Sardine Risk</div><div class="hl-value" id="hlRisk">—</div></div>
      <div class="hl-item"><div class="hl-label">Fraud Score</div><div class="hl-value" id="hlScore">—</div></div>
      <div class="hl-item"><div class="hl-label">KYC Status</div><div class="hl-value" id="hlKyc">—</div></div>
      <div class="hl-item"><div class="hl-label">AML Risk</div><div class="hl-value" id="hlAml">—</div></div>
      <div class="hl-item"><div class="hl-label">Case Status</div><div class="hl-value" id="hlCase">—</div></div>
      <div class="hl-item"><div class="hl-label">Annual Revenue</div><div class="hl-value" id="hlRevenue">—</div></div>
    </div>
    <div class="rec-body">
      <div class="rec-left">
        <div class="sec-hdr">Account Information</div>
        <div class="field-grid">
          <div><div class="field-label">Account Name</div><div class="field-value link" id="fName">—</div></div>
          <div><div class="field-label">Industry</div><div class="field-value" id="fIndustry">—</div></div>
          <div><div class="field-label">Phone</div><div class="field-value link" id="fPhone">—</div></div>
          <div><div class="field-label">Annual Revenue</div><div class="field-value" id="fRevenue">—</div></div>
          <div><div class="field-label">Billing City</div><div class="field-value" id="fCity">—</div></div>
          <div><div class="field-label">Account Owner</div><div class="field-value link" id="fOwner">—</div></div>
        </div>
        <div class="sec-hdr">Sardine Checkpoints</div>
        <div class="field-grid">
          <div><div class="field-label">Passed</div><div class="field-value" id="fPassed">—</div></div>
          <div><div class="field-label">Failed</div><div class="field-value" id="fFailed">—</div></div>
        </div>
        <div class="sec-hdr">Activity Log</div>
        <div class="evlog"><div class="evlog-list" id="activityLog"><div class="ev-item"><div class="ev-desc" style="color:#aaa">Waiting for events…</div></div></div></div>
      </div>
      <div class="rec-right">
        <div class="sardine-panel">
          <div class="sp-hdr">
            <div style="font-size:15px">🐟</div>
            <div class="sp-wordmark">sardine<span> risk</span></div>
            <div class="sp-sub" id="spSub">Last sync: —</div>
          </div>
          <div class="sp-body">
            <div class="score-card" id="scoreCard">
              <div class="score-row">
                <div><div class="score-num" id="scoreNum">—</div><div class="score-lbl">Fraud Score / 100</div></div>
                <div class="risk-badge" id="riskBadge">—</div>
              </div>
              <div class="bar-track"><div class="bar-fill" id="barFill" style="width:0%"></div></div>
              <div class="bar-lbls"><span>Low Risk</span><span>High Risk</span></div>
            </div>
            <div class="sig-group">
              <div class="sig-grp-hdr">Identity & Compliance</div>
              <div class="sig-row"><span class="sig-key">KYC Status</span><span class="sig-val" id="sigKyc">—</span></div>
              <div class="sig-row"><span class="sig-key">KYC Level</span><span class="sig-val" id="sigKycLevel">—</span></div>
              <div class="sig-row"><span class="sig-key">AML Risk</span><span class="sig-val" id="sigAml">—</span></div>
              <div class="sig-row"><span class="sig-key">Case ID</span><span class="sig-val" id="sigCaseId">—</span></div>
            </div>
            <div class="sig-group">
              <div class="sig-grp-hdr">Device & Behavior Signals</div>
              <div class="sig-row"><span class="sig-key">Device Risk</span><span class="sig-val" id="sigDevRisk">—</span></div>
              <div class="pills" id="sigPills"></div>
              <div class="sig-row" style="border-top:1px solid #f0f0f0"><span class="sig-key">Behavior</span><span class="sig-val" id="sigBehavior">—</span></div>
            </div>
            <div class="evlog">
              <div class="evlog-hdr">Recent Sardine Events</div>
              <div class="evlog-list" id="sardineEvents"><div class="ev-item"><div class="ev-desc" style="color:#aaa">Awaiting events…</div></div></div>
            </div>
          </div>
          <div class="demo-ctrl">
            <div class="demo-lbl">🎮 Demo Controls</div>
            <div class="demo-btns" id="demoBtns"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="conn-log">
    <div class="conn-log-hdr"><div class="dot"></div><div class="conn-log-title">Connector Event Stream</div></div>
    <div class="conn-log-body" id="connLog"><div class="log-line"><span class="log-msg">Connecting…</span></div></div>
  </div>
</div>

<script>
let accounts = [], selectedId = null, connEvents = [], acctHistory = {};

const fmt = v => v || '—';
const fmtRev = n => !n ? '—' : '$' + (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : (n/1e3).toFixed(0)+'K');
const fmtTime = iso => { if (!iso) return '—'; return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); };
const scoreColor = s => s <= 30 ? '#2e844a' : s <= 60 ? '#dd7a01' : '#ba0517';
const riskKey = str => { const u = (str||'').toUpperCase(); return u.includes('HIGH') ? 'HIGH' : u.includes('MED') ? 'MEDIUM' : 'LOW'; };

function renderTabs() {
  const colors = { LOW: '#2e844a', MEDIUM: '#dd7a01', HIGH: '#ba0517' };
  document.getElementById('tabs').innerHTML = accounts.map(a => {
    const rk = riskKey(a.Sardine_Risk_Level__c);
    return \`<div class="acct-tab\${a.Id===selectedId?' active':''}" onclick="select('\${a.Id}')">
      <div class="tab-dot" style="background:\${colors[rk]||'#ccc'}"></div>\${a.Name}</div>\`;
  }).join('');
}

function select(id) { selectedId = id; renderTabs(); renderAccount(); }

function renderAccount() {
  const a = accounts.find(x => x.Id === selectedId); if (!a) return;
  document.getElementById('recName').textContent       = a.Name;
  document.getElementById('metaIndustry').textContent  = fmt(a.Industry);
  document.getElementById('metaOwner').textContent     = fmt(a.AccountOwner);
  document.getElementById('metaType').textContent      = fmt(a.Type);
  document.getElementById('hlRisk').textContent        = fmt(a.Sardine_Risk_Level__c);
  document.getElementById('hlScore').textContent       = a.Sardine_Fraud_Score__c != null ? a.Sardine_Fraud_Score__c+'/100' : '—';
  document.getElementById('hlKyc').textContent         = fmt(a.Sardine_KYC_Status__c);
  document.getElementById('hlAml').textContent         = fmt(a.Sardine_AML_Risk__c);
  document.getElementById('hlCase').textContent        = fmt(a.Sardine_Case_Status__c);
  document.getElementById('hlRevenue').textContent     = fmtRev(a.AnnualRevenue);
  document.getElementById('fName').textContent         = fmt(a.Name);
  document.getElementById('fIndustry').textContent     = fmt(a.Industry);
  document.getElementById('fPhone').textContent        = fmt(a.Phone);
  document.getElementById('fRevenue').textContent      = fmtRev(a.AnnualRevenue);
  document.getElementById('fCity').textContent         = [a.BillingCity,a.BillingState].filter(Boolean).join(', ')||'—';
  document.getElementById('fOwner').textContent        = fmt(a.AccountOwner);
  document.getElementById('fPassed').textContent       = fmt(a.Sardine_Checkpoints_Passed__c);
  document.getElementById('fFailed').textContent       = fmt(a.Sardine_Checkpoints_Failed__c);
  const sc = a.Sardine_Fraud_Score__c;
  document.getElementById('scoreNum').textContent = sc != null ? sc : '—';
  const bar = document.getElementById('barFill');
  bar.style.width = (sc||0)+'%'; bar.style.background = sc != null ? scoreColor(sc) : '#ccc';
  const badge = document.getElementById('riskBadge');
  badge.textContent = fmt(a.Sardine_Risk_Level__c); badge.className = 'risk-badge '+riskKey(a.Sardine_Risk_Level__c);
  document.getElementById('sigKyc').textContent     = fmt(a.Sardine_KYC_Status__c);
  document.getElementById('sigKycLevel').textContent = fmt(a.Sardine_KYC_Level__c);
  document.getElementById('sigAml').textContent      = fmt(a.Sardine_AML_Risk__c);
  document.getElementById('sigCaseId').textContent   = a.Sardine_Case_ID__c || 'None';
  document.getElementById('sigDevRisk').textContent  = fmt(a.Sardine_Device_Risk__c);
  document.getElementById('sigBehavior').textContent = a.Sardine_Behavior_Signals__c && a.Sardine_Behavior_Signals__c !== '—' ? a.Sardine_Behavior_Signals__c : 'None';
  const sigs = (a.Sardine_Device_Signals__c||'').split(',').map(s=>s.trim()).filter(s=>s&&s!=='—'&&s!=='None');
  document.getElementById('sigPills').innerHTML = sigs.length
    ? sigs.map(s=>\`<span class="pill">\${s}</span>\`).join('')
    : '<span class="pill none">No signals</span>';
  document.getElementById('spSub').textContent = a.Sardine_Last_Updated__c ? 'Synced '+fmtTime(a.Sardine_Last_Updated__c) : 'Not yet synced';
  renderActivityLog(a);
  const sardineIds = {'0015g00000XkYzAAA1':'acct-001','0015g00000XkYzAAA2':'acct-002','0015g00000XkYzAAA3':'acct-003'};
  renderDemoBtns(sardineIds[a.Id]);
}

function renderActivityLog(a) {
  const el = document.getElementById('activityLog');
  const h = acctHistory[a.Id]||[];
  el.innerHTML = h.length ? h.slice(0,8).map(x=>\`<div class="ev-item"><div class="ev-time">\${fmtTime(x.time)}</div><div class="ev-desc">Risk → <strong>\${x.risk}</strong> (score: \${x.score})</div><div class="ev-tag">Sardine</div></div>\`).join('')
    : '<div class="ev-item"><div class="ev-desc" style="color:#aaa">No events yet</div></div>';
}

function renderDemoBtns(sardineId) {
  document.getElementById('demoBtns').innerHTML = sardineId ? \`
    <button class="demo-btn danger"  onclick="trigger('\${sardineId}','escalate')">🔴 Escalate Risk</button>
    <button class="demo-btn warning" onclick="trigger('\${sardineId}','aml_flag')">🟡 AML Flag</button>
    <button class="demo-btn warning" onclick="trigger('\${sardineId}','kyc_fail')">⚠️ KYC Fail</button>
    <button class="demo-btn success" onclick="trigger('\${sardineId}','clear')">🟢 Clear Risk</button>\` : '';
}

async function trigger(sardineId, scenario) {
  try {
    await fetch(\`/proxy/sardine/customers/\${sardineId}/simulate\`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({scenario})
    });
    setTimeout(poll, 700); setTimeout(poll, 2000);
  } catch(e) { console.error(e); }
}

async function pollEvents() {
  try {
    const r = await fetch('/proxy/connector/events');
    const data = await r.json();
    const events = data.events||[];
    const newEvs = events.filter(e => !connEvents.find(x => x.timestamp===e.timestamp && x.type===e.type));
    if (newEvs.length) {
      connEvents = events;
      renderConnLog();
      newEvs.filter(e=>e.type==='webhook_received').forEach(e => {
        if (e.sfAccountId) {
          if (!acctHistory[e.sfAccountId]) acctHistory[e.sfAccountId]=[];
          acctHistory[e.sfAccountId].unshift({time:e.timestamp, risk:e.riskLevel||'?', score:e.fraudScore||'?'});
        }
      });
      renderSardineEvents();
    }
  } catch(e) {}
}

function renderConnLog() {
  document.getElementById('connLog').innerHTML = connEvents.slice(0,15).map(e => {
    const cls = e.type.includes('error')?'err':e.type.includes('success')?'ok':'';
    const msg = e.type==='webhook_received' ? \`webhook → \${e.sfAccountId} risk=\${e.riskLevel} score=\${e.fraudScore}\`
      : e.type==='sf_upsert_success' ? \`upsert OK → \${e.sfAccountId} (\${e.fieldCount} fields)\`
      : e.message||e.type;
    return \`<div class="log-line \${cls}"><span class="log-t">\${fmtTime(e.timestamp)}</span><span class="log-type">\${e.type}</span><span class="log-msg">\${msg}</span></div>\`;
  }).join('') || '<div class="log-line"><span class="log-msg" style="color:#555">No events yet</span></div>';
}

function renderSardineEvents() {
  const a = accounts.find(x=>x.Id===selectedId);
  const relevant = connEvents.filter(e=>e.type==='webhook_received'&&e.sfAccountId===(a&&a.Id)).slice(0,6);
  document.getElementById('sardineEvents').innerHTML = relevant.length
    ? relevant.map(e=>\`<div class="ev-item"><div class="ev-time">\${fmtTime(e.timestamp)}</div><div class="ev-desc">risk_updated → <strong>\${e.riskLevel}</strong> · score \${e.fraudScore}</div><div class="ev-tag">webhook</div></div>\`).join('')
    : '<div class="ev-item"><div class="ev-desc" style="color:#aaa">No events yet</div></div>';
}

async function poll() {
  try {
    const r = await fetch('/api/accounts');
    accounts = await r.json();
    document.getElementById('lastRefresh').textContent = 'Updated '+fmtTime(new Date().toISOString());
    if (!selectedId && accounts.length) selectedId = accounts[0].Id;
    renderTabs(); renderAccount();
    document.getElementById('scoreCard').classList.remove('flash');
    void document.getElementById('scoreCard').offsetWidth;
    document.getElementById('scoreCard').classList.add('flash');
  } catch(e) { document.getElementById('lastRefresh').textContent = 'Connection error'; }
}

(async()=>{ await poll(); await pollEvents(); setInterval(poll,3000); setInterval(pollEvents,2000); })();
</script>
</body>
</html>`;
}
